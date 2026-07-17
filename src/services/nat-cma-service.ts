import type Database from 'better-sqlite3';
import { NotFoundError } from '../shared/errors';
import { extractFullCode } from '../shared/std-code';
import { PythonCmaProvider } from '../sources/nat-cma/python-cma-provider';

export interface NatCmaPlace {
  placeId: string;
  placeType: string;
  placeName: string;
  placeAddress: string;
}

export interface NatCmaOrg {
  certCode: string;
  orgName: string;
  address: string;
  publicDetailId: string;
  places: NatCmaPlace[];
}

export interface NatCmaCapability {
  jcnlId?: string;
  type?: string;
  cpName?: string;
  yjbzNameNumber?: string;
  yjbzNumber?: string;
  xzfw?: string;
  parentName?: string;
}

export interface NatCmaDetail {
  certStatus?: string;
  licDate?: string;
  licValidTimeBegin?: string;
  licValidTimeEnd?: string;
}

export interface NatCmaProvider {
  scrapeFull(
    publicDetailId: string,
    onProgress?: (stage: string, fetched: number, total: number) => void,
    certCode?: string,
    maxPages?: number,
  ): Promise<{ detail: NatCmaDetail; capabilities: NatCmaCapability[] }>;
}

export class NationalCmaProviderUnavailable implements NatCmaProvider {
  async scrapeFull(): Promise<{ detail: NatCmaDetail; capabilities: NatCmaCapability[] }> {
    throw new Error('国家 CMA（cma.cnca.cn）真实场所数据源尚未接入；不会使用 CMA 实验室公共查询源代替');
  }
}

export interface NatCmaProgress {
  status: 'syncing' | 'success' | 'error';
  fetched: number;
  total: number;
  error?: string;
}

export interface NatCmaMatch {
  scope: 'organization';
  abilityCount: number;
  organizations: Array<{ certCode: string; orgName: string }>;
}

export const BUILTIN_NAT_CMA_ORGS: NatCmaOrg[] = [
  {
    certCode: '230020349767',
    orgName: '湖北省产品质量监督检验研究院',
    address: '湖北省武汉市武昌区公平路6号',
    publicDetailId: 'LI201581410348LI5860',
    places: [
      { placeId: '460F377538393663E0639602A8C0EA21', placeType: '主场所', placeName: '国家饮料及粮油制品质量检验检测中心', placeAddress: '湖北省武汉市武昌区公平路6号' },
      { placeId: '460F37751EF83663E0639602A8C0EA21', placeType: '分场所', placeName: '国家节能建筑材料质量检验检测中心（湖北）', placeAddress: '湖北省鄂州市鄂州葛店经济技术开发区创业大道东侧节能中心' },
      { placeId: '460F377537D63663E0639602A8C0EA21', placeType: '分场所', placeName: '国家饮料及粮油制品质量监督检验中心', placeAddress: '湖北省鄂州市鄂州葛店经济技术开发区创业大道东侧' },
      { placeId: '460F3775444F3663E0639602A8C0EA21', placeType: '分场所', placeName: '国家太阳能热水器产品质量检验检测中心（武汉）', placeAddress: '湖北省鄂州市鄂州葛店经济技术开发区创业大道东侧研发中心' },
      { placeId: '460F377549C63663E0639602A8C0EA21', placeType: '分场所', placeName: '国家金刚石工具质量监督检验中心（湖北）', placeAddress: '湖北省鄂州市鄂城区滨湖南路103号' },
    ],
  },
];

type SubscriptionRow = {
  cert_code: string;
  place_id: string;
  place_name: string;
  place_address: string;
  place_type: string;
  subscribed_at: string;
  last_synced_at: string | null;
  ability_count: number;
  sync_status: string | null;
  sync_error: string | null;
  cert_status: string | null;
  cert_issued_at: string | null;
  cert_valid_from: string | null;
  cert_valid_to: string | null;
};

export class NatCmaService {
  private readonly progress = new Map<string, NatCmaProgress>();
  private readonly jobs = new Map<string, Promise<{ records: number }>>();

  constructor(
    private readonly db: Database.Database,
    private readonly provider: NatCmaProvider = new PythonCmaProvider(),
  ) {
    this.ensureTables();
    this.recoverInterruptedSyncs();
  }

  listOrgs() {
    const subscriptions = this.listSubscriptionRows();
    const byCert = new Map<string, SubscriptionRow[]>();
    for (const sub of subscriptions) {
      const items = byCert.get(sub.cert_code) || [];
      items.push(sub);
      byCert.set(sub.cert_code, items);
    }
    const counts = this.providerReady ? this.getAbilityCounts() : new Map<string, number>();

    return BUILTIN_NAT_CMA_ORGS.map(org => {
      const subs = byCert.get(org.certCode) || [];
      const subMap = new Map(subs.map(sub => [sub.place_id, sub]));
      const abilityCount = counts.get(org.certCode) || 0;
      return {
        certCode: org.certCode,
        orgName: org.orgName,
        address: org.address,
        subscribedCount: subs.length,
        totalCount: org.places.length,
        abilityCount,
        abilityScope: 'organization' as const,
        providerReady: this.providerReady,
        providerMessage: this.providerMessage,
        places: org.places.map(place => {
          const sub = subMap.get(place.placeId);
          const progress = this.progress.get(org.certCode);
          return {
            ...place,
            subscribed: !!sub,
            lastSyncedAt: sub?.last_synced_at || null,
            abilityCount: sub ? abilityCount : 0,
            syncStatus: progress?.status || sub?.sync_status || 'pending',
            syncError: progress?.error || sub?.sync_error || null,
            certStatus: sub?.cert_status || null,
            certIssuedAt: sub?.cert_issued_at || null,
            certValidFrom: sub?.cert_valid_from || null,
            certValidTo: sub?.cert_valid_to || null,
            syncProgress: progress || null,
          };
        }),
      };
    });
  }

  listSubscriptions() {
    const counts = this.providerReady ? this.getAbilityCounts() : new Map<string, number>();
    return this.listSubscriptionRows().map(sub => {
      const org = BUILTIN_NAT_CMA_ORGS.find(item => item.certCode === sub.cert_code);
      const place = org?.places.find(item => item.placeId === sub.place_id);
      const progress = this.progress.get(sub.cert_code);
      return {
        ...sub,
        orgName: org?.orgName || '',
        placeType: place?.placeType || sub.place_type,
        abilityCount: counts.get(sub.cert_code) || 0,
        syncStatus: progress?.status || sub.sync_status || 'pending',
        syncProgress: progress || null,
      };
    });
  }

  subscribe(certCode: string, placeId: string) {
    const org = BUILTIN_NAT_CMA_ORGS.find(item => item.certCode === certCode);
    if (!org) throw new NotFoundError('未找到该机构');
    const place = org.places.find(item => item.placeId === placeId);
    if (!place) throw new NotFoundError('未找到该场所');
    this.db.prepare(`
      INSERT OR IGNORE INTO nat_cma_subscriptions
      (cert_code, place_id, place_name, place_address, place_type, sync_status)
      VALUES (?, ?, ?, ?, ?, 'pending')
    `).run(certCode, placeId, place.placeName, place.placeAddress, place.placeType);
    return place;
  }

  unsubscribe(certCode: string, placeId: string): void {
    this.db.prepare('DELETE FROM nat_cma_subscriptions WHERE cert_code = ? AND place_id = ?').run(certCode, placeId);
    const remaining = (this.db.prepare('SELECT COUNT(*) AS count FROM nat_cma_subscriptions WHERE cert_code = ?').get(certCode) as { count: number }).count;
    if (remaining === 0) this.db.prepare('DELETE FROM nat_cma_abilities WHERE cert_code = ?').run(certCode);
  }

  startSyncForPlace(placeId: string, maxPages?: number): 'started' | 'already_syncing' {
    const sub = this.db.prepare('SELECT cert_code FROM nat_cma_subscriptions WHERE place_id = ?').get(placeId) as { cert_code: string } | undefined;
    if (!sub) throw new NotFoundError('未找到该订阅');
    return this.startSyncForCert(sub.cert_code, maxPages);
  }

  startSyncAll(maxPages?: number): { total: number; started: number; alreadySyncing: number } {
    const certCodes = this.getSubscribedCertCodes();
    let started = 0;
    let alreadySyncing = 0;
    for (const certCode of certCodes) {
      if (this.startSyncForCert(certCode, maxPages) === 'started') started += 1;
      else alreadySyncing += 1;
    }
    return { total: certCodes.length, started, alreadySyncing };
  }

  async syncAllScheduled(): Promise<Array<{ cert_code: string; records?: number; error?: string }>> {
    const results: Array<{ cert_code: string; records?: number; error?: string }> = [];
    for (const certCode of this.getSubscribedCertCodes()) {
      try {
        const records = await this.syncCert(certCode);
        results.push({ cert_code: certCode, records: records.records });
      } catch (error) {
        results.push({ cert_code: certCode, error: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  getProgressByPlace(): Record<string, NatCmaProgress> {
    const result: Record<string, NatCmaProgress> = {};
    for (const sub of this.listSubscriptionRows()) {
      const progress = this.progress.get(sub.cert_code);
      if (progress) result[sub.place_id] = progress;
    }
    return result;
  }

  batchMatch(stdCodes: string[]): Record<string, NatCmaMatch> {
    if (!this.providerReady) return {};
    const normalizedToInputs = new Map<string, string[]>();
    for (const stdCode of stdCodes) {
      const normalized = extractFullCode(stdCode);
      if (!normalized) continue;
      const inputs = normalizedToInputs.get(normalized) || [];
      inputs.push(stdCode);
      normalizedToInputs.set(normalized, inputs);
    }
    const normalizedCodes = [...normalizedToInputs.keys()];
    if (!normalizedCodes.length) return {};

    const placeholders = normalizedCodes.map(() => '?').join(',');
    const rows = this.db.prepare(
      'SELECT std_code_norm, cert_code, COUNT(*) AS ability_count ' +
      'FROM nat_cma_abilities WHERE std_code_norm IN (' + placeholders + ') ' +
      'GROUP BY std_code_norm, cert_code',
    ).all(...normalizedCodes) as Array<{ std_code_norm: string; cert_code: string; ability_count: number }> ;
    const byNormalized = new Map<string, Array<{ cert_code: string; ability_count: number }>>();
    for (const row of rows) {
      const items = byNormalized.get(row.std_code_norm) || [];
      items.push(row);
      byNormalized.set(row.std_code_norm, items);
    }

    const result: Record<string, NatCmaMatch> = {};
    for (const [normalized, inputs] of normalizedToInputs) {
      const matches = byNormalized.get(normalized) || [];
      if (!matches.length) continue;
      const organizations = matches.map(match => ({
        certCode: match.cert_code,
        orgName: BUILTIN_NAT_CMA_ORGS.find(org => org.certCode === match.cert_code)?.orgName || match.cert_code,
      }));
      const value: NatCmaMatch = {
        scope: 'organization',
        abilityCount: matches.reduce((sum, match) => sum + match.ability_count, 0),
        organizations,
      };
      for (const input of inputs) result[input] = value;
    }
    return result;
  }

  search(query: string, options: { limit?: number; offset?: number } = {}) {
    if (!this.providerReady) return { total: 0, items: [], message: this.providerMessage };
    const limit = Math.max(1, Math.min(options.limit || 50, 200));
    const offset = Math.max(0, options.offset || 0);
    const keyword = '%' + query.trim() + '%';
    const normalized = extractFullCode(query);
    const where = 'std_code_norm = ? OR std_code LIKE ? OR std_name LIKE ? OR product_name LIKE ? OR category LIKE ? OR sub_category LIKE ? OR limit_desc LIKE ?';
    const params = [normalized, keyword, keyword, keyword, keyword, keyword, keyword];
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM nat_cma_abilities WHERE ' + where).get(...params) as { count: number }).count;
    const rows = this.db.prepare(
      'SELECT cert_code, category, sub_category, product_name, std_name, std_code, limit_desc, synced_at ' +
      'FROM nat_cma_abilities WHERE ' + where +
      ' ORDER BY CASE WHEN std_code_norm = ? THEN 0 ELSE 1 END, synced_at DESC, id DESC LIMIT ? OFFSET ?',
    ).all(...params, normalized, limit, offset) as Array<Record<string, string>>;
    return {
      total,
      items: rows.map(row => ({
        certCode: row.cert_code,
        orgName: BUILTIN_NAT_CMA_ORGS.find(org => org.certCode === row.cert_code)?.orgName || row.cert_code,
        scope: 'organization' as const,
        category: row.category || '',
        subCategory: row.sub_category || '',
        productName: row.product_name || '',
        stdName: row.std_name || '',
        stdCode: row.std_code || '',
        limitDesc: row.limit_desc || '',
        syncedAt: row.synced_at || '',
      })),
    };
  }
  getStatus() {
    const total = (this.db.prepare('SELECT COUNT(*) AS count FROM nat_cma_subscriptions').get() as { count: number }).count;
    const totalAbilities = this.providerReady ? (this.db.prepare('SELECT COUNT(*) AS count FROM nat_cma_abilities').get() as { count: number }).count : 0;
    const lastSynced = (this.db.prepare('SELECT MAX(last_synced_at) AS value FROM nat_cma_subscriptions').get() as { value: string | null }).value;
    const lastError = (this.db.prepare("SELECT sync_error FROM nat_cma_subscriptions WHERE sync_error IS NOT NULL ORDER BY last_synced_at DESC LIMIT 1").get() as { sync_error: string | null } | undefined)?.sync_error || null;
    const errorCount = (this.db.prepare("SELECT COUNT(*) AS count FROM nat_cma_subscriptions WHERE sync_status = 'error'").get() as { count: number }).count;
    const successCount = (this.db.prepare("SELECT COUNT(*) AS count FROM nat_cma_subscriptions WHERE sync_status = 'success'").get() as { count: number }).count;
    return {
      total,
      totalAbilities,
      lastSynced,
      syncingCount: this.jobs.size,
      errorCount,
      successCount,
      lastError,
      source: this.providerReady ? '国家 CMA（cma.cnca.cn）机构级能力数据' : '国家 CMA（cma.cnca.cn）真实数据源待接入',
      abilityScope: 'organization',
      providerReady: this.providerReady,
      providerMessage: this.providerMessage,
    };
  }

  private get providerReady(): boolean {
    return !(this.provider instanceof NationalCmaProviderUnavailable);
  }

  private get providerMessage(): string | null {
    return this.providerReady ? null : '国家 CMA（cma.cnca.cn）真实场所数据源待接入；已停用 CMA 实验室来源代替国家 CMA 的旧实现';
  }

  private startSyncForCert(certCode: string, maxPages?: number): 'started' | 'already_syncing' {
    if (this.jobs.has(certCode)) return 'already_syncing';
    void this.syncCert(certCode, maxPages).catch(error => {
      console.error(`[nat-cma] sync failed for ${certCode}:`, error);
    });
    return 'started';
  }

  private async syncCert(certCode: string, maxPages?: number): Promise<{ records: number }> {
    const existing = this.jobs.get(certCode);
    if (existing) return existing;
    const job = this.performSync(certCode, maxPages);
    this.jobs.set(certCode, job);
    try {
      return await job;
    } finally {
      this.jobs.delete(certCode);
    }
  }

  private async performSync(certCode: string, maxPages?: number): Promise<{ records: number }> {
    const org = BUILTIN_NAT_CMA_ORGS.find(item => item.certCode === certCode);
    if (!org) throw new NotFoundError('未配置该机构的 CMA publicDetailId');
    const subscribed = this.getSubscriptionsForCert(certCode);
    if (!subscribed.length) return { records: 0 };

    this.setProgress(certCode, { status: 'syncing', fetched: 0, total: 0 });
    this.db.prepare("UPDATE nat_cma_subscriptions SET sync_status = 'syncing', sync_error = NULL WHERE cert_code = ?").run(certCode);

    try {
      const { detail, capabilities } = await this.provider.scrapeFull(org.publicDetailId, (_stage, fetched, total) => {
        this.setProgress(certCode, { status: 'syncing', fetched, total });
      }, certCode, maxPages);
      const records = this.replaceOrganizationAbilities(certCode, detail, capabilities);
      this.setTerminalProgress(certCode, { status: 'success', fetched: records, total: records });
      console.log(`[nat-cma] synced ${certCode}: ${records} organization abilities`);
      return { records };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.db.prepare("UPDATE nat_cma_subscriptions SET sync_status = 'error', sync_error = ? WHERE cert_code = ?").run(message, certCode);
      this.setTerminalProgress(certCode, { status: 'error', fetched: 0, total: 0, error: message });
      throw error;
    }
  }

  private replaceOrganizationAbilities(certCode: string, detail: NatCmaDetail, capabilities: NatCmaCapability[]): number {
    const subscribed = this.getSubscriptionsForCert(certCode);
    if (!subscribed.length) return 0;
    const insert = this.db.prepare(`
      INSERT INTO nat_cma_abilities
      (place_id, cert_code, source_id, category, sub_category, product_name, std_name, std_code, std_code_norm, limit_desc)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cert_code, source_id) DO UPDATE SET
        category = excluded.category,
        sub_category = excluded.sub_category,
        product_name = excluded.product_name,
        std_name = excluded.std_name,
        std_code = excluded.std_code,
        std_code_norm = excluded.std_code_norm,
        limit_desc = excluded.limit_desc,
        synced_at = datetime('now')
    `);
    const abilityScopeId = `@org:${certCode}`;
    const write = this.db.transaction(() => {
      this.db.prepare('DELETE FROM nat_cma_abilities WHERE cert_code = ?').run(certCode);
      capabilities.forEach((capability, index) => {
        const sourceId = `${capability.jcnlId || 'row'}-${index + 1}`;
        insert.run(
          abilityScopeId,
          certCode,
          sourceId,
          capability.parentName || '',
          capability.type || '',
          capability.cpName || '',
          capability.yjbzNameNumber || '',
          capability.yjbzNumber || '',
          extractFullCode(capability.yjbzNumber || capability.yjbzNameNumber || ''),
          capability.xzfw || '',
        );
      });
      this.db.prepare(`
        UPDATE nat_cma_subscriptions SET
          ability_count = ?, last_synced_at = datetime('now'), sync_status = 'success', sync_error = NULL,
          cert_status = ?, cert_issued_at = ?, cert_valid_from = ?, cert_valid_to = ?
        WHERE cert_code = ?
      `).run(
        capabilities.length,
        detail.certStatus || null,
        detail.licDate || null,
        detail.licValidTimeBegin || null,
        detail.licValidTimeEnd || null,
        certCode,
      );
    });
    write();
    return capabilities.length;
  }

  private listSubscriptionRows(): SubscriptionRow[] {
    return this.db.prepare('SELECT * FROM nat_cma_subscriptions ORDER BY subscribed_at DESC').all() as SubscriptionRow[];
  }

  private getSubscriptionsForCert(certCode: string): SubscriptionRow[] {
    return this.db.prepare('SELECT * FROM nat_cma_subscriptions WHERE cert_code = ? ORDER BY subscribed_at').all(certCode) as SubscriptionRow[];
  }

  private getSubscribedCertCodes(): string[] {
    return (this.db.prepare('SELECT DISTINCT cert_code FROM nat_cma_subscriptions').all() as Array<{ cert_code: string }>).map(row => row.cert_code);
  }

  private getAbilityCounts(): Map<string, number> {
    const rows = this.db.prepare('SELECT cert_code, COUNT(*) AS count FROM nat_cma_abilities GROUP BY cert_code').all() as Array<{ cert_code: string; count: number }>;
    return new Map(rows.map(row => [row.cert_code, row.count]));
  }

  private setProgress(certCode: string, progress: NatCmaProgress): void {
    this.progress.set(certCode, progress);
  }

  private setTerminalProgress(certCode: string, progress: NatCmaProgress): void {
    this.setProgress(certCode, progress);
    setTimeout(() => this.progress.delete(certCode), 30_000).unref?.();
  }

  private recoverInterruptedSyncs(): void {
    this.db.prepare("UPDATE nat_cma_subscriptions SET sync_status = 'error', sync_error = '服务重启导致上次同步中断' WHERE sync_status = 'syncing'").run();
  }

  private ensureTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS nat_cma_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cert_code TEXT NOT NULL,
        place_id TEXT NOT NULL,
        place_name TEXT NOT NULL,
        place_address TEXT NOT NULL,
        place_type TEXT NOT NULL DEFAULT '分场所',
        subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
        last_synced_at TEXT,
        ability_count INTEGER DEFAULT 0,
        sync_status TEXT DEFAULT 'pending',
        sync_error TEXT,
        cert_status TEXT,
        cert_issued_at TEXT,
        cert_valid_from TEXT,
        cert_valid_to TEXT,
        UNIQUE(cert_code, place_id)
      );
    `);
    // 迁移：为已有表添加 sync_status 列（如果不存在）
    const subsColumns = new Set((this.db.prepare('PRAGMA table_info(nat_cma_subscriptions)').all() as Array<{ name: string }>).map(col => col.name));
    if (!subsColumns.has('sync_status')) {
      this.db.exec("ALTER TABLE nat_cma_subscriptions ADD COLUMN sync_status TEXT DEFAULT 'pending'");
    }
    if (!subsColumns.has('sync_error')) {
      this.db.exec('ALTER TABLE nat_cma_subscriptions ADD COLUMN sync_error TEXT');
    }
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nat_cma_abilities'").get();
    if (!exists) {
      this.createAbilityTable('nat_cma_abilities');
    } else {
      const columns = new Set((this.db.prepare('PRAGMA table_info(nat_cma_abilities)').all() as Array<{ name: string }>).map(column => column.name));
      if (!columns.has('source_id')) this.migrateAbilityTable();
    }
    const abilityColumns = new Set((this.db.prepare('PRAGMA table_info(nat_cma_abilities)').all() as Array<{ name: string }>).map(column => column.name));
    if (!abilityColumns.has('std_code_norm')) {
      this.db.exec('ALTER TABLE nat_cma_abilities ADD COLUMN std_code_norm TEXT');
    }
    this.backfillStandardNorms();
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nat_cma_sub_cert ON nat_cma_subscriptions(cert_code);
      CREATE INDEX IF NOT EXISTS idx_nat_cma_ab_cert ON nat_cma_abilities(cert_code);
      CREATE INDEX IF NOT EXISTS idx_nat_cma_ab_std ON nat_cma_abilities(std_code);
      CREATE INDEX IF NOT EXISTS idx_nat_cma_ab_std_norm ON nat_cma_abilities(std_code_norm);
    `);
  }

  private createAbilityTable(name: string): void {
    this.db.exec(`
      CREATE TABLE ${name} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        place_id TEXT NOT NULL,
        cert_code TEXT NOT NULL,
        source_id TEXT NOT NULL,
        category TEXT,
        sub_category TEXT,
        product_name TEXT,
        std_name TEXT,
        std_code TEXT,
        std_code_norm TEXT,
        limit_desc TEXT,
        synced_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(cert_code, source_id)
      );
    `);
  }

  private backfillStandardNorms(): void {
    const rows = this.db.prepare("SELECT id, std_code FROM nat_cma_abilities WHERE COALESCE(std_code_norm, '') = ''").all() as Array<{ id: number; std_code: string }> ;
    const update = this.db.prepare('UPDATE nat_cma_abilities SET std_code_norm = ? WHERE id = ?');
    const write = this.db.transaction(() => {
      for (const row of rows) update.run(extractFullCode(row.std_code || ''), row.id);
    });
    write();
  }
  private migrateAbilityTable(): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.exec('DROP TABLE IF EXISTS nat_cma_abilities_v2');
      this.createAbilityTable('nat_cma_abilities_v2');
      this.db.exec(`
        INSERT INTO nat_cma_abilities_v2
        (place_id, cert_code, source_id, category, sub_category, product_name, std_name, std_code, std_code_norm, limit_desc, synced_at)
        SELECT place_id, cert_code, 'legacy-' || id, category, sub_category, product_name, std_name, std_code, '', limit_desc, synced_at
        FROM nat_cma_abilities;
        DROP TABLE nat_cma_abilities;
        ALTER TABLE nat_cma_abilities_v2 RENAME TO nat_cma_abilities;
      `);
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
