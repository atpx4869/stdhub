import express from 'express';
import Database from 'better-sqlite3';
import supertestRequest from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createCapLibRoutes } from './cap-lib-routes';
import type { CapLibService } from '../services/cap-lib-service';

/**
 * 序列化契约回归：cma-diff 的三个响应里，`byStatus` / `deltaByStatus` / `batchStatus`
 * 的键是「数据」而不是「字段名」——
 * - byStatus / deltaByStatus 以 DiffStatus 枚举值（in_lib / cite_only / …）为键
 * - batchStatus 以用户输入的标准号为键
 * 这些键不能被 toCamelCase 递归改写（in_lib → inLib、GB_T_999-2020 → GB_T999-2020），
 * 否则前端按蛇形枚举键 / 原始标准号读取时全部丢失。
 */

function stubService(): CapLibService {
  return {
    labsCounts() {
      return [{
        certNumber: '221700110366',
        labName: '湖北省质检院',
        total: 15,
        byStatus: { in_lib: 3, cite_only: 2, abolished: 1, series_only: 4, not_in_lib: 5 },
        changes: null,
      }];
    },
    changesForLab() {
      return {
        windowDays: 90,
        totalEvents: 2,
        deltaByStatus: { in_lib: -1, cite_only: 0, abolished: 0, series_only: 2, not_in_lib: 0 },
        events: [],
      };
    },
    batchStatus() {
      const base = { inLib: true, libDomain: 'x', libStatus: 'active', libRemark: '', seriesNewCode: '', stale: false };
      return {
        'GB/T 1234-2020': { status: 'in_lib', ...base },
        'GB_T_999-2020': { status: 'not_in_lib', ...base },
      };
    },
  } as unknown as CapLibService;
}

describe('cma-diff serialization contract', () => {
  let db: Database.Database;
  let request: ReturnType<typeof supertestRequest>;

  beforeAll(() => {
    db = new Database(':memory:');
    const pass = (_req: unknown, _res: unknown, next: () => void) => next();
    const router = createCapLibRoutes(
      db,
      pass as express.RequestHandler,
      pass as express.RequestHandler,
      () => pass as express.RequestHandler,
      stubService(),
    );
    const app = express();
    app.use(express.json());
    app.use(router);
    request = supertestRequest(app);
  });

  afterAll(() => {
    db.close();
  });

  it('keeps byStatus enum keys for labs counts', async () => {
    const response = await request.get('/api/cma-diff/labs');
    expect(response.status).toBe(200);
    const item = response.body.data.items[0];
    expect(item.byStatus.in_lib).toBe(3);
    expect(item.byStatus.series_only).toBe(4);
    expect(item.byStatus.inLib).toBeUndefined();
    expect(item.byStatus.seriesOnly).toBeUndefined();
  });

  it('keeps deltaByStatus enum keys for lab changes', async () => {
    const response = await request.get('/api/cma-diff/labs/x/changes?days=90');
    expect(response.status).toBe(200);
    const delta = response.body.data.changes.deltaByStatus;
    expect(delta.series_only).toBe(2);
    expect(delta.in_lib).toBe(-1);
    expect(delta.seriesOnly).toBeUndefined();
    expect(delta.inLib).toBeUndefined();
  });

  it('keeps user-input stdCode keys for batch-status', async () => {
    const response = await request
      .post('/api/cma-diff/batch-status')
      .send({ stdCodes: ['GB/T 1234-2020', 'GB_T_999-2020'] });
    expect(response.status).toBe(200);
    expect(response.body.data['GB/T 1234-2020'].status).toBe('in_lib');
    expect(response.body.data['GB_T_999-2020']).toBeDefined();
    expect(response.body.data['GB_T_999-2020'].status).toBe('not_in_lib');
    expect(response.body.data['GBT999-2020']).toBeUndefined();
  });
});
