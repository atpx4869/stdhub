import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { NatCmaService, type NatCmaProvider } from './nat-cma-service';

const CERT_CODE = '230020349767';
const MAIN_PLACE = '460F377538393663E0639602A8C0EA21';
const BRANCH_PLACE = '460F37751EF83663E0639602A8C0EA21';

function createProvider() {
  let calls = 0;
  const provider: NatCmaProvider = {
    async scrapeFull(_publicDetailId, onProgress) {
      calls += 1;
      onProgress?.('capabilities', 0, 2);
      await new Promise(resolve => setTimeout(resolve, 5));
      onProgress?.('capabilities', 2, 2);
      return {
        detail: {
          certStatus: '有效', licDate: '2026-01-01',
          licValidTimeBegin: '2026-01-01', licValidTimeEnd: '2032-01-01',
        } as any,
        capabilities: [
          { jcnlId: 'same-standard-1', cpName: '木家具', yjbzNameNumber: 'GB/T 3324-2017', yjbzNumber: 'GB/T 3324-2017' },
          { jcnlId: 'same-standard-2', cpName: '木家具', yjbzNameNumber: 'GB/T 3324-2017', yjbzNumber: 'GB/T 3324-2017' },
        ] as any,
      };
    },
  };
  return { provider, getCalls: () => calls };
}

function createService() {
  const db = new BetterSqlite3(':memory:');
  const fake = createProvider();
  const service = new NatCmaService(db as any, fake.provider);
  service.subscribe(CERT_CODE, MAIN_PLACE);
  service.subscribe(CERT_CODE, BRANCH_PLACE);
  return { db, service, ...fake };
}

describe('NatCmaService', () => {
  it('syncs a certificate only once when multiple places subscribe', async () => {
    const { db, service, getCalls } = createService();
    const result = await service.syncAllScheduled();

    expect(result).toEqual([{ cert_code: CERT_CODE, records: 2 }]);
    expect(getCalls()).toBe(1);
    expect(service.getStatus().totalAbilities).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS count FROM nat_cma_abilities').get() as any).count).toBe(2);
    expect((db.prepare('SELECT COUNT(DISTINCT place_id) AS count FROM nat_cma_abilities').get() as any).count).toBe(1);
  });

  it('shares an in-flight sync across subscribed places', async () => {
    const { service, getCalls } = createService();

    expect(service.startSyncForPlace(MAIN_PLACE)).toBe('started');
    expect(service.startSyncForPlace(BRANCH_PLACE)).toBe('already_syncing');
    await new Promise(resolve => setTimeout(resolve, 20));

    expect(getCalls()).toBe(1);
    expect(Object.values(service.getProgressByPlace()).every(item => item.status === 'success')).toBe(true);
  });

  it('clears the organization cache only after its last place is unsubscribed', async () => {
    const { db, service } = createService();
    await service.syncAllScheduled();

    service.unsubscribe(CERT_CODE, MAIN_PLACE);
    expect((db.prepare('SELECT COUNT(*) AS count FROM nat_cma_abilities').get() as any).count).toBe(2);
    service.unsubscribe(CERT_CODE, BRANCH_PLACE);
    expect((db.prepare('SELECT COUNT(*) AS count FROM nat_cma_abilities').get() as any).count).toBe(0);
  });

  it('marks every subscribed place as failed when its shared provider fails', async () => {
    const db = new BetterSqlite3(':memory:');
    const provider: NatCmaProvider = {
      async scrapeFull() { throw new Error('上游服务暂不可用'); },
    };
    const service = new NatCmaService(db as any, provider);
    service.subscribe(CERT_CODE, MAIN_PLACE);
    service.subscribe(CERT_CODE, BRANCH_PLACE);

    await expect(service.syncAllScheduled()).resolves.toEqual([{ cert_code: CERT_CODE, error: '上游服务暂不可用' }]);
    const progress = service.getProgressByPlace();
    expect(progress[MAIN_PLACE]).toMatchObject({ status: 'error', error: '上游服务暂不可用' });
    expect(progress[BRANCH_PLACE]).toMatchObject({ status: 'error', error: '上游服务暂不可用' });
  });

  it('matches strict standard versions and searches cached organization abilities', async () => {
    const { service } = createService();
    await service.syncAllScheduled();

    expect(service.batchMatch(['GB/T 3324-2017', 'GB/T 3324-2024'])).toEqual({
      'GB/T 3324-2017': expect.objectContaining({
        scope: 'organization',
        abilityCount: 2,
        organizations: [expect.objectContaining({ certCode: CERT_CODE })],
      }),
    });
    expect(service.search('GB/T 3324-2017').items).toHaveLength(2);
    expect(service.search('木家具').total).toBe(2);
  });
});
