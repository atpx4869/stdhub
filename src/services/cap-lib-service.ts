/**
 * 国家 CMA 一单一库（能力项目库）镜像与比对服务。
 *
 * 三个核心能力：
 * 1) **syncDomain**：抓取一个领域的全量行，hash diff 后 upsert + 标记 last_seen_at（soft delete）
 * 2) **diffByLab**：把订阅机构的 cma_qualifications 行与 cma_capability_lib 对比，输出 5 档状态
 * 3) **batchStatus**：给前端徽章用的轻量批量查询（搜索/资质查询页注入）
 *
 * 远端接口（实测无鉴权，详见 README 数据源章节）：
 *   GET https://cma.caqit.org.cn/cma-admin/system/standardData/list?pageNum=N&pageSize=2000&domain=<name>
 * 返回 RuoYi 标准 `{total, rows[], code, msg}`。**分页 + 限流并发拉取**：远端按行数
 * 线性变慢，产品质量检验 41k 行一次拉全要 5-7 分钟会超时；改为 pageSize=2000，
 * 首页拿 total 后同领域最多 4 页并发、全进程最多 4 个远端请求，边拉边报进度。
 *
 * 与 cma_qualifications 的关系：两表正交。本表是"政策范围内的合法标准号清单"，
 * cma_qualifications 是"机构持有的资质行"。diffByLab 按 std_code_norm 等值 JOIN，
 * 复用现有索引，O(M log N)。
 */
import crypto from 'crypto';
import type Database from 'better-sqlite3';
import { cleanStdCode, extractFullCode, extractBaseCode } from '../shared/std-code';
import { parseLibStatus, type LibStatus, type DiffStatus } from '../shared/cap-lib-status';
import { CAP_LIB_DOMAIN_NAMES, isValidCapLibDomain } from '../shared/cap-lib-domains';
import { Semaphore } from '../shared/semaphore';
import { setSetting } from './db';

const REMOTE_BASE = 'https://cma.caqit.org.cn/cma-admin/system/standardData/list';
/**
 * 分页拉取的每页行数。远端按行数线性变慢：单页 2000 行远低于单页超时，且能边拉
 * 边报进度。不再一次拉 60000（产品质量检验 41k 行单请求要 5-7 分钟、超过任何合理
 * 超时 → 整批失败 / 卡 0%）。
 */
const REMOTE_PAGE_SIZE = 2000;
/** 单页响应超时。单页 2000 行实测 ~36s，留余量到 90s（覆盖远端抖动）。 */
const REMOTE_TIMEOUT_MS = 90_000;
/** 安全上限：最多拉多少页，防远端 total 异常导致死循环。41285/2000≈21 页，留到 100 页。 */
const REMOTE_MAX_PAGES = 100;
/** 同一领域首页之后最多并发几页；产品质量检验 21 页时由 21 次串行降为约 6 轮。 */
const REMOTE_DOMAIN_PAGE_CONCURRENCY = 4;
/** 全进程远端出口并发上限，避免「全部更新」一次性把 11 个领域页请求打满上游。 */
const REMOTE_FETCH_CONCURRENCY = 4;

const remoteFetchSemaphore = new Semaphore(REMOTE_FETCH_CONCURRENCY);

// ─── 类型定义 ─────────────────────────────────────────────────────────────

interface RemoteRow {
  id: number;
  domain: string | null;
  standardMethod: string | null;
  standardCode: string | null;
  remark: string | null;
  status: string | null;
  updateTime: string | null;
}

interface RemoteListResp {
  total: number;
  rows: RemoteRow[];
  code: number;
  msg: string;
}

export interface SyncProgress {
  phase: 'pending' | 'fetching' | 'queued' | 'upserting' | 'done' | 'error';
  domain: string;
  current: number;
  total: number;
  error?: string;
  stats?: SyncStats;
}

export interface SyncStats {
  added: number;
  changed: number;
  unchanged: number;
  removedSoft: number;   // 远端不再出现、本地仍保留（标记 last_seen_at 不更新）
  durationMs: number;
}

export interface DomainMeta {
  domain: string;
  subscribed: boolean;
  lastSyncedAt: string;
  remoteTotal: number;
  localTotal: number;
  lastSyncStats: SyncStats | null;
}

export interface CapLibBadgeStatus {
  /** 4 档徽章状态（搜索/资质查询页用） */
  status: DiffStatus;
  inLib: boolean;
  libDomain: string;       // 在库时给出领域
  libStatus: LibStatus | '';   // 库内 active/cite_only/abolished
  libRemark: string;
  seriesNewCode: string;   // series_only 时给出推荐替代年版
  /** 数据失效标记：该领域未同步 / 同步超过 30 天 / 该领域没数据 */
  stale: boolean;
}

export interface DiffRow {
  qualId: number;
  stdCode: string;
  stdName: string;
  category: string;
  testItem: string;
  /** 同一标准号(std_code_norm)下聚合的全部检测项目（去重后展示用；单项时与 testItem 同） */
  testItems: string[];
  diffStatus: DiffStatus;
  libStatus: LibStatus | '';
  libRemark: string;
  libDomain: string;
  seriesNewCode: string;
  seriesDomain: string;
  /** 该行是否被手动映射覆盖（UI 标记，便于用户识别人工兜底项） */
  manualMapped?: boolean;
}

export interface ExportFilter {
  /** 空数组 = 所有订阅机构 */
  certNumbers: string[];
  /** 空/未传 = 所有状态 */
  statuses?: DiffStatus[];
  /** 可选关键词，与详情页筛选同款（stdCode/stdName/testItem 子串） */
  keyword?: string;
}

/** exportDiff 返回的扁平行（每行带机构标识，供 Excel 单 sheet 渲染） */
export type ExportRow = DiffRow & { certNumber: string; labName: string };

interface DiffContext {
  blackNorm: Set<string>;
  blackRaw: Set<string>;
  globalManualMap: Map<string, string>;
  manualMapByCert: Map<string, Map<string, string>>;
}

/**
 * worst→best 严重度顺序，与前端 GROUP_ORDER 对应。导出排序用：最差状态在前，
 * 同状态按 labName + stdCode。抽成模块常量避免散落多份。
 */
const EXPORT_STATUS_ORDER: Record<DiffStatus, number> = {
  not_in_lib: 0, series_only: 1, abolished: 2, cite_only: 3, in_lib: 4,
};

// ─── 同步进度内存 store ───────────────────────────────────────────────────

const progressStore = new Map<string, SyncProgress>();

export function getSyncProgress(jobId: string): SyncProgress | null {
  return progressStore.get(jobId) || null;
}

function setProgress(jobId: string, p: SyncProgress): void {
  progressStore.set(jobId, p);
}

/** 防止 progressStore 无限增长：保留最近 50 个 job。 */
function pruneProgressStore(): void {
  if (progressStore.size <= 50) return;
  const keys = [...progressStore.keys()];
  for (const k of keys.slice(0, keys.length - 50)) progressStore.delete(k);
}

/**
 * SQLite 写入串行队列（并发 1）。远端 fetch 是 IO 等待，可以限流并发；better-sqlite3
 * 事务同步执行，仍必须让所有领域的入库阶段串到这条 chain 上。
 *
 * Why 只串行写、不串行整条 runSync：产品质量检验 4w+ 行的慢点在远端页响应；把 fetch
 * 也排成全局单线程会让大领域和「更新勾选」叠加变慢。拆开后能并发拉取、串行入库，
 * 保留防假死，同时缩短等待时间。
 */
let dbWriteChain: Promise<void> = Promise.resolve();

// ─── Service ─────────────────────────────────────────────────────────────

export class CapLibService {
  constructor(private db: Database.Database) {}

  // ── 元数据 ──

  listDomains(): DomainMeta[] {
    const rows = this.db.prepare(`
      SELECT domain, subscribed, last_synced_at, remote_total, local_total, last_sync_stats
      FROM cma_capability_lib_meta
      ORDER BY local_total DESC, domain
    `).all() as Array<{
      domain: string; subscribed: number; last_synced_at: string;
      remote_total: number; local_total: number; last_sync_stats: string;
    }>;
    return rows.map(r => ({
      domain: r.domain,
      subscribed: !!r.subscribed,
      lastSyncedAt: r.last_synced_at || '',
      remoteTotal: r.remote_total || 0,
      localTotal: r.local_total || 0,
      lastSyncStats: this.parseStats(r.last_sync_stats),
    }));
  }

  private parseStats(raw: string | null): SyncStats | null {
    if (!raw) return null;
    try { return JSON.parse(raw) as SyncStats; } catch { return null; }
  }

  setSubscribed(domain: string, subscribed: boolean): void {
    if (!isValidCapLibDomain(domain)) throw new Error(`非法领域名: ${domain}`);
    this.db.prepare(`
      UPDATE cma_capability_lib_meta SET subscribed = ? WHERE domain = ?
    `).run(subscribed ? 1 : 0, domain);
  }

  setSubscriptions(items: Array<{ domain: string; subscribed: boolean }>): number {
    const deduped = new Map<string, boolean>();
    for (const it of items) {
      if (!isValidCapLibDomain(it.domain)) throw new Error(`非法领域名: ${it.domain}`);
      deduped.set(it.domain, !!it.subscribed);
    }
    if (deduped.size === 0) return 0;
    const stmt = this.db.prepare(`
      UPDATE cma_capability_lib_meta SET subscribed = ? WHERE domain = ?
    `);
    const tx = this.db.transaction(() => {
      let changed = 0;
      for (const [domain, subscribed] of deduped) {
        changed += stmt.run(subscribed ? 1 : 0, domain).changes ?? 0;
      }
      return changed;
    });
    return tx();
  }

  // ── 抓取 ──

  /**
   * 同步单一领域。fire-and-forget — 调用方拿到 jobId 后通过 getSyncProgress 轮询。
   * 同一领域并发触发会被丢弃（progressStore 检测 phase != done/error）。
   */
  startSync(domain: string): string {
    if (!isValidCapLibDomain(domain)) throw new Error(`非法领域名: ${domain}`);
    // 防并发：本领域已有 running job 直接复用其 jobId
    for (const [jid, p] of progressStore) {
      if (p.domain === domain && p.phase !== 'done' && p.phase !== 'error') return jid;
    }
    const jobId = `cap-lib-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setProgress(jobId, { phase: 'pending', domain, current: 0, total: 0 });
    pruneProgressStore();

    // 远端拉取可并发启动；runSync 内部只把 DB 写入阶段串到 dbWriteChain。
    // 内部错误存到 progressStore 而非抛出，避免 fire-and-forget 产生 unhandled rejection。
    void this.runSync(jobId, domain).catch(err => {
      setProgress(jobId, {
        phase: 'error', domain, current: 0, total: 0,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return jobId;
  }

  private async runSync(jobId: string, domain: string): Promise<void> {
    const startedAt = Date.now();
    setProgress(jobId, { phase: 'fetching', domain, current: 0, total: 0 });

    const rows = await this.fetchRemoteRows(jobId, domain);
    const total = rows.length;
    setProgress(jobId, { phase: 'queued', domain, current: total, total });

    const writeTask = dbWriteChain.then(() => this.upsertRows(jobId, domain, rows, startedAt));
    dbWriteChain = writeTask.catch(() => undefined);
    await writeTask;
  }

  private async fetchRemoteRows(jobId: string, domain: string): Promise<RemoteRow[]> {
    const first = await this.fetchRemotePage(domain, 1);
    const firstRows = Array.isArray(first.rows) ? first.rows : [];
    const remoteTotal = Number(first.total) || firstRows.length;
    const totalPages = remoteTotal > 0 ? Math.ceil(remoteTotal / REMOTE_PAGE_SIZE) : 1;
    if (totalPages > REMOTE_MAX_PAGES) {
      throw new Error(`远端 total=${remoteTotal} 超过安全页数上限 ${REMOTE_MAX_PAGES}，请检查分页参数`);
    }

    const pages = new Map<number, RemoteRow[]>();
    pages.set(1, firstRows);
    let fetchedRows = firstRows.length;
    setProgress(jobId, { phase: 'fetching', domain, current: fetchedRows, total: remoteTotal });

    if (totalPages <= 1 || firstRows.length < REMOTE_PAGE_SIZE) {
      return firstRows;
    }

    const pageNums = Array.from({ length: totalPages - 1 }, (_v, i) => i + 2);
    let next = 0;
    let failed = false;
    const workerCount = Math.min(REMOTE_DOMAIN_PAGE_CONCURRENCY, pageNums.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (!failed) {
        const pageNum = pageNums[next++];
        if (!pageNum) return;
        try {
          const data = await this.fetchRemotePage(domain, pageNum);
          if (failed) return;
          const pageRows = Array.isArray(data.rows) ? data.rows : [];
          pages.set(pageNum, pageRows);
          fetchedRows += pageRows.length;
          setProgress(jobId, {
            phase: 'fetching',
            domain,
            current: Math.min(fetchedRows, remoteTotal || fetchedRows),
            total: remoteTotal,
          });
          await new Promise<void>(resolve => setImmediate(resolve));
        } catch (e) {
          failed = true;
          throw e;
        }
      }
    });
    await Promise.all(workers);

    const rows: RemoteRow[] = [];
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      rows.push(...(pages.get(pageNum) || []));
    }
    return remoteTotal > 0 && rows.length > remoteTotal ? rows.slice(0, remoteTotal) : rows;
  }

  private async fetchRemotePage(domain: string, pageNum: number): Promise<RemoteListResp> {
    return remoteFetchSemaphore.run(async () => {
      const url = `${REMOTE_BASE}?pageNum=${pageNum}&pageSize=${REMOTE_PAGE_SIZE}&domain=${encodeURIComponent(domain)}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REMOTE_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(url, { headers: { Accept: 'application/json' }, signal: controller.signal });
      } catch (e) {
        throw new Error(`远端第 ${pageNum} 页请求失败：${e instanceof Error ? e.message : String(e)}`);
      } finally {
        clearTimeout(timer);
      }
      if (!resp.ok) throw new Error(`远端第 ${pageNum} 页 HTTP ${resp.status}`);
      const data = await resp.json() as RemoteListResp;
      if (data.code !== 200) throw new Error(`远端第 ${pageNum} 页返回 code=${data.code} msg=${data.msg}`);
      return data;
    });
  }

  private async upsertRows(jobId: string, domain: string, rows: RemoteRow[], startedAt: number): Promise<void> {
    const total = rows.length;
    setProgress(jobId, { phase: 'upserting', domain, current: 0, total });
    const now = new Date().toISOString();
    const stats: SyncStats = { added: 0, changed: 0, unchanged: 0, removedSoft: 0, durationMs: 0 };

    // 入库前先记录该领域之前的 source_id 集合，本次未出现的算 removedSoft
    const prevIds = new Set<number>(
      (this.db.prepare('SELECT source_id FROM cma_capability_lib WHERE domain = ?')
        .all(domain) as Array<{ source_id: number }>).map(r => r.source_id),
    );
    const seenIds = new Set<number>();

    const selStmt = this.db.prepare('SELECT row_hash FROM cma_capability_lib WHERE source_id = ?');
    const insStmt = this.db.prepare(`
      INSERT INTO cma_capability_lib
        (source_id, domain, standard_method, std_code, std_code_norm, std_code_base,
         remark, lib_status, raw_status, row_hash, last_seen_at, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_id) DO UPDATE SET
        domain          = excluded.domain,
        standard_method = excluded.standard_method,
        std_code        = excluded.std_code,
        std_code_norm   = excluded.std_code_norm,
        std_code_base   = excluded.std_code_base,
        remark          = excluded.remark,
        lib_status      = excluded.lib_status,
        raw_status      = excluded.raw_status,
        row_hash        = excluded.row_hash,
        last_seen_at    = excluded.last_seen_at
    `);
    const touchStmt = this.db.prepare(
      'UPDATE cma_capability_lib SET last_seen_at = ? WHERE source_id = ?',
    );

    // 分块事务：每批 CHUNK 行一个 transaction，批次之间 setImmediate 让出事件循环，
    // 避免 41k 行单事务长时间锁死主线程（better-sqlite3 事务同步执行 → 期间所有 HTTP
    // 请求含进度轮询全部排队 = 假死根因）。stats / seenIds 在批外累计。
    const CHUNK = 2000;
    const runChunk = this.db.transaction((batch: RemoteRow[]) => {
      for (const r of batch) {
        if (typeof r.id !== 'number') continue;
        const sourceId = r.id;
        seenIds.add(sourceId);

        const rawCode = r.standardCode || '';
        const stdCode = cleanStdCode(rawCode);
        const stdCodeNorm = extractFullCode(stdCode);
        const stdCodeBase = extractBaseCode(stdCode);
        const remark = r.remark || '';
        const libStatus = parseLibStatus(remark);
        const rawStatus = r.status || '';
        const standardMethod = r.standardMethod || '';
        const rowHash = hashRow(domain, standardMethod, stdCode, remark, libStatus, rawStatus);

        const existing = selStmt.get(sourceId) as { row_hash: string } | undefined;
        if (existing && existing.row_hash === rowHash) {
          touchStmt.run(now, sourceId);
          stats.unchanged++;
        } else {
          insStmt.run(
            sourceId, domain, standardMethod, stdCode, stdCodeNorm, stdCodeBase,
            remark, libStatus, rawStatus, rowHash, now, now,
          );
          if (existing) stats.changed++; else stats.added++;
        }
      }
    });

    for (let i = 0; i < rows.length; i += CHUNK) {
      runChunk(rows.slice(i, i + CHUNK));
      const done = Math.min(i + CHUNK, rows.length);
      setProgress(jobId, { phase: 'upserting', domain, current: done, total });
      // 让出事件循环：进度轮询 / 其它请求能在批次间插进来
      if (done < rows.length) await new Promise<void>(resolve => setImmediate(resolve));
    }

    // soft delete 统计：之前有、本次没出现 = removedSoft
    for (const id of prevIds) if (!seenIds.has(id)) stats.removedSoft++;

    stats.durationMs = Date.now() - startedAt;

    // 写回 meta + 全局 last sync
    const localTotal = (this.db.prepare(
      'SELECT COUNT(*) AS c FROM cma_capability_lib WHERE domain = ?',
    ).get(domain) as { c: number }).c;
    this.db.prepare(`
      UPDATE cma_capability_lib_meta
      SET subscribed = 1, last_synced_at = ?, remote_total = ?, local_total = ?, last_sync_stats = ?
      WHERE domain = ?
    `).run(now, total, localTotal, JSON.stringify(stats), domain);
    setSetting(this.db, 'cma_lib_last_synced_at', now);

    setProgress(jobId, { phase: 'done', domain, current: total, total, stats });
  }

  /** 清理 30 天未见的孤儿行（admin 触发）。返回删除条数。 */
  cleanupStaleRows(daysThreshold = 30): number {
    const cutoff = new Date(Date.now() - daysThreshold * 86400_000).toISOString();
    const result = this.db.prepare(
      "DELETE FROM cma_capability_lib WHERE last_seen_at != '' AND last_seen_at < ?",
    ).run(cutoff);
    // 同步重算各领域 local_total
    this.db.prepare(`
      UPDATE cma_capability_lib_meta
      SET local_total = (
        SELECT COUNT(*) FROM cma_capability_lib WHERE domain = cma_capability_lib_meta.domain
      )
    `).run();
    return result.changes ?? 0;
  }

  /**
   * 诊断单个标准号（误判自查）。本地查询，回答：这个号在本地库里到底有没有、
   * 归一化成什么、命中哪些领域/状态、黑名单/手动映射是否生效。
   *
   * 用于排查「显示未入库但网页有」（多半是该领域没同步全）/「显示在库但网页查不到」
   * （多半是网页搜法不同 / soft delete 残留）这类困惑。不打远端，秒回。
   */
  diagnose(rawCode: string): {
    input: string; cleaned: string; full: string; base: string;
    exactMatches: Array<{ stdCode: string; domain: string; libStatus: string; remark: string; lastSeenAt: string }>;
    seriesMatches: Array<{ stdCode: string; domain: string; libStatus: string; lastSeenAt: string }>;
    blacklisted: boolean;
    manualMap: { libNorm: string; certNumber: string } | null;
    anySynced: boolean;
    domainSyncState: Array<{ domain: string; lastSyncedAt: string; localTotal: number; remoteTotal: number }>;
    verdict: string;
  } {
    const cleaned = cleanStdCode((rawCode || '').trim());
    const full = extractFullCode(cleaned);
    const base = extractBaseCode(cleaned);

    const exactMatches = (full
      ? this.db.prepare(`
          SELECT std_code, domain, lib_status, remark, last_seen_at
          FROM cma_capability_lib WHERE std_code_norm = ? ORDER BY domain
        `).all(full)
      : []) as Array<{ std_code: string; domain: string; lib_status: string; remark: string; last_seen_at: string }>;

    const seriesMatches = (base
      ? this.db.prepare(`
          SELECT std_code, domain, lib_status, std_code_norm, last_seen_at
          FROM cma_capability_lib
          WHERE std_code_base = ? AND lib_status = 'active' AND std_code_norm <> ?
          ORDER BY std_code_norm DESC LIMIT 10
        `).all(base, full)
      : []) as Array<{ std_code: string; domain: string; lib_status: string; last_seen_at: string }>;

    const blacklisted = !!(full
      ? this.db.prepare('SELECT 1 FROM cma_diff_blacklist WHERE std_code_norm = ?').get(full)
      : this.db.prepare("SELECT 1 FROM cma_diff_blacklist WHERE std_code_norm = '' AND std_code = ?").get(cleaned));

    const mm = full
      ? this.db.prepare("SELECT lib_norm, cert_number FROM cma_diff_manual_map WHERE src_norm = ? ORDER BY cert_number DESC LIMIT 1").get(full) as { lib_norm: string; cert_number: string } | undefined
      : undefined;

    const anySynced = (this.db.prepare(
      "SELECT COUNT(*) AS c FROM cma_capability_lib_meta WHERE last_synced_at != ''",
    ).get() as { c: number }).c > 0;

    const domainSyncState = (this.db.prepare(`
      SELECT domain, last_synced_at, local_total, remote_total
      FROM cma_capability_lib_meta WHERE subscribed = 1 ORDER BY domain
    `).all() as Array<{ domain: string; last_synced_at: string; local_total: number; remote_total: number }>)
      .map(r => ({ domain: r.domain, lastSyncedAt: r.last_synced_at || '', localTotal: r.local_total || 0, remoteTotal: r.remote_total || 0 }));

    // 判定文案
    let verdict: string;
    if (blacklisted) {
      verdict = '该标准号在黑名单中，已被排除（不显示、不参与匹配）。如需恢复请到黑名单管理移除。';
    } else if (exactMatches.length) {
      const active = exactMatches.some(m => m.lib_status === 'active');
      verdict = active
        ? '本地库命中（active）→ 应判「在库」。若网页查不到，多半是网页按精确写法搜、或该号已被远端调整。'
        : '本地库命中但状态为废止/仅限引用 → 按 remark 判档。';
    } else if (seriesMatches.length) {
      verdict = '保年未命中、剥年命中 active 新版 → 判「年版过期」，建议改用新年版。';
    } else if (!anySynced) {
      verdict = '本地库为空（尚未同步任何领域）→ 一切都会判「未入库」。请先同步相关领域。';
    } else {
      verdict = '本地库无此号 → 判「未入库」。若网页确有此号，多半是它所属领域没同步全（如产品质量检验 4w+ 行曾超时未拉全）→ 请重新同步该领域后再看。';
    }

    return {
      input: rawCode, cleaned, full, base,
      exactMatches: exactMatches.map(m => ({ stdCode: m.std_code, domain: m.domain, libStatus: m.lib_status, remark: m.remark || '', lastSeenAt: m.last_seen_at || '' })),
      seriesMatches: seriesMatches.map(m => ({ stdCode: m.std_code, domain: m.domain, libStatus: m.lib_status, lastSeenAt: m.last_seen_at || '' })),
      blacklisted,
      manualMap: mm ? { libNorm: mm.lib_norm, certNumber: mm.cert_number } : null,
      anySynced,
      domainSyncState,
      verdict,
    };
  }

  // ── 比对 ──

  /**
   * 给前端搜索结果 / 资质查询页徽章用的轻量批量查询。
   *
   * 算法：把每个输入 stdCode 算成 fullCode + baseCode，分别在 cma_capability_lib 走
   * std_code_norm 等值（保年命中）和 std_code_base 等值（剥年兜底）两路索引。
   *
   * 返回 4 档（合并 cite_only / abolished 为前端简化 ⚠ 状态，详见 cap-lib-status.ts）。
   */
  batchStatus(stdCodes: string[]): Record<string, CapLibBadgeStatus> {
    const result: Record<string, CapLibBadgeStatus> = {};
    if (stdCodes.length === 0) return result;

    // 任何领域是否已同步过 —— 全空则徽章全标 stale
    const anySynced = (this.db.prepare(
      "SELECT COUNT(*) AS c FROM cma_capability_lib_meta WHERE last_synced_at != ''",
    ).get() as { c: number }).c > 0;

    // 输入归一化
    type Key = { input: string; full: string; base: string };
    const keys: Key[] = [];
    const fullSet = new Set<string>();
    const baseSet = new Set<string>();
    for (const c of stdCodes) {
      const full = extractFullCode(c);
      const base = extractBaseCode(c);
      keys.push({ input: c, full, base });
      if (full) fullSet.add(full);
      if (base) baseSet.add(base);
    }
    const fulls = [...fullSet];
    const bases = [...baseSet];

    // 保年命中：std_code_norm IN (...)
    const exactMap = new Map<string, { libStatus: LibStatus; remark: string; domain: string }>();
    if (fulls.length > 0) {
      const ph = fulls.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT std_code_norm, lib_status, remark, domain
        FROM cma_capability_lib
        WHERE std_code_norm IN (${ph})
      `).all(...fulls) as Array<{
        std_code_norm: string; lib_status: LibStatus; remark: string; domain: string;
      }>;
      for (const r of rows) {
        // 同一 std_code_norm 可能在多个领域出现：active > cite_only > abolished 优先级
        const prev = exactMap.get(r.std_code_norm);
        if (!prev || priority(r.lib_status) > priority(prev.libStatus)) {
          exactMap.set(r.std_code_norm, { libStatus: r.lib_status, remark: r.remark || '', domain: r.domain });
        }
      }
    }

    // 剥年命中（只看 active 的最新年版）
    const seriesMap = new Map<string, { stdCode: string; domain: string }>();
    if (bases.length > 0) {
      const ph = bases.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT std_code_base, std_code, std_code_norm, domain
        FROM cma_capability_lib
        WHERE std_code_base IN (${ph}) AND lib_status = 'active'
        ORDER BY std_code_norm DESC
      `).all(...bases) as Array<{
        std_code_base: string; std_code: string; std_code_norm: string; domain: string;
      }>;
      for (const r of rows) {
        if (!seriesMap.has(r.std_code_base)) {
          seriesMap.set(r.std_code_base, { stdCode: r.std_code, domain: r.domain });
        }
      }
    }

    for (const k of keys) {
      const exact = k.full ? exactMap.get(k.full) : undefined;
      const series = k.base ? seriesMap.get(k.base) : undefined;
      let status: DiffStatus;
      if (exact) {
        status = exact.libStatus === 'active'    ? 'in_lib'
              : exact.libStatus === 'cite_only'  ? 'cite_only'
              : 'abolished';
      } else if (series && series.stdCode && extractFullCode(series.stdCode) !== k.full) {
        status = 'series_only';
      } else {
        status = 'not_in_lib';
      }
      result[k.input] = {
        status,
        inLib: status === 'in_lib' || status === 'cite_only' || status === 'abolished',
        libDomain: exact?.domain || '',
        libStatus: exact?.libStatus || '',
        libRemark: exact?.remark || '',
        seriesNewCode: status === 'series_only' ? (series?.stdCode || '') : '',
        stale: !anySynced || (status === 'not_in_lib' && !this.isDomainKnownToBeFull(exact?.domain)),
      };
    }
    return result;
  }

  /** 是否至少同步过一个领域（用于 stale 判定的兜底） */
  private isDomainKnownToBeFull(_domain?: string): boolean {
    // 简化版：只要任何领域同步过，未命中即视作真实 not_in_lib（false → stale）；
    // 否则 batchStatus 顶部 anySynced 判定已覆盖全空场景，此处保持快速返回 true。
    return true;
  }

  /**
   * 单订阅机构的 diff 行表（cma-diff 详情页用）。
   *
   * 性能：先按 std_code_norm **去重**取机构的不同标准号（同号多检测项目聚合到一行），
   * 再对去重集合用 std_code_norm IN / std_code_base IN 两句**批量查库**（复用 batchStatus
   * 的 exactMap/seriesMap 聚合写法）。避免旧实现「每条资质行 6 个相关子查询」的 O(N×6) 放大。
   *
   * 黑名单：命中 std_code_norm（或原始 std_code）的标准号直接剔除、不显示不计数。
   * 手动映射：src_norm 命中 manual_map 时，用 lib_norm 查库覆盖自动判定。
   */
  diffByLab(certNumber: string, context?: DiffContext): DiffRow[] {
    const quals = this.db.prepare(`
      SELECT id, std_code, std_code_norm, std_code_base, std_name, category, test_item
      FROM cma_qualifications
      WHERE cert_number = ?
      ORDER BY std_code
    `).all(certNumber) as Array<{
      id: number; std_code: string; std_code_norm: string; std_code_base: string;
      std_name: string; category: string; test_item: string;
    }>;
    if (!quals.length) return [];

    const ctx = context || this.createDiffContext([certNumber]);
    const blackNorm = ctx.blackNorm;
    const blackRaw = ctx.blackRaw;
    const manualMap = this.manualMapFor(certNumber, ctx);

    // 按 std_code_norm 去重（norm 为空回退 std_code 作 key），聚合同号检测项目
    type Group = {
      qualId: number; stdCode: string; stdCodeNorm: string; stdCodeBase: string;
      stdName: string; category: string; testItems: Set<string>;
    };
    const groups = new Map<string, Group>();
    for (const q of quals) {
      // 黑名单过滤：norm 命中 或（norm 空时）原始 std_code 命中
      if (q.std_code_norm && blackNorm.has(q.std_code_norm)) continue;
      if (!q.std_code_norm && blackRaw.has(q.std_code)) continue;
      const key = q.std_code_norm || q.std_code;
      let g = groups.get(key);
      if (!g) {
        g = {
          qualId: q.id, stdCode: q.std_code, stdCodeNorm: q.std_code_norm,
          stdCodeBase: q.std_code_base, stdName: q.std_name, category: q.category,
          testItems: new Set<string>(),
        };
        groups.set(key, g);
      }
      if (q.test_item) g.testItems.add(q.test_item);
    }
    if (!groups.size) return [];

    // 手动映射会把 src_norm 指向 lib_norm，查库要用 lib_norm。收集所有待查 norm。
    const list = [...groups.values()];
    const effNorm = (g: Group) => manualMap.get(g.stdCodeNorm) || g.stdCodeNorm;
    const fullSet = new Set<string>();
    const baseSet = new Set<string>();
    for (const g of list) {
      const n = effNorm(g);
      if (n) fullSet.add(n);
      if (g.stdCodeBase) baseSet.add(g.stdCodeBase);
    }
    const fulls = [...fullSet];
    const bases = [...baseSet];

    // 保年命中：std_code_norm IN (...)（同 norm 多领域取 active>cite_only>abolished 优先）
    const exactMap = new Map<string, { libStatus: LibStatus; remark: string; domain: string }>();
    if (fulls.length > 0) {
      const ph = fulls.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT std_code_norm, lib_status, remark, domain
        FROM cma_capability_lib WHERE std_code_norm IN (${ph})
      `).all(...fulls) as Array<{ std_code_norm: string; lib_status: LibStatus; remark: string; domain: string }>;
      for (const r of rows) {
        const prev = exactMap.get(r.std_code_norm);
        if (!prev || priority(r.lib_status) > priority(prev.libStatus)) {
          exactMap.set(r.std_code_norm, { libStatus: r.lib_status, remark: r.remark || '', domain: r.domain });
        }
      }
    }
    // 剥年兜底：std_code_base IN (...) 只看 active 最新年版
    const seriesMap = new Map<string, { stdCode: string; stdCodeNorm: string; domain: string }>();
    if (bases.length > 0) {
      const ph = bases.map(() => '?').join(',');
      const rows = this.db.prepare(`
        SELECT std_code_base, std_code, std_code_norm, domain
        FROM cma_capability_lib WHERE std_code_base IN (${ph}) AND lib_status = 'active'
        ORDER BY std_code_norm DESC
      `).all(...bases) as Array<{ std_code_base: string; std_code: string; std_code_norm: string; domain: string }>;
      for (const r of rows) {
        if (!seriesMap.has(r.std_code_base)) {
          seriesMap.set(r.std_code_base, { stdCode: r.std_code, stdCodeNorm: r.std_code_norm, domain: r.domain });
        }
      }
    }

    const result: DiffRow[] = [];
    for (const g of list) {
      const lookup = effNorm(g);
      const mapped = manualMap.has(g.stdCodeNorm);
      const exact = lookup ? exactMap.get(lookup) : undefined;
      const series = g.stdCodeBase ? seriesMap.get(g.stdCodeBase) : undefined;

      let diffStatus: DiffStatus;
      if (exact?.libStatus === 'active')         diffStatus = 'in_lib';
      else if (exact?.libStatus === 'cite_only') diffStatus = 'cite_only';
      else if (exact?.libStatus === 'abolished') diffStatus = 'abolished';
      else if (series && series.stdCodeNorm && series.stdCodeNorm !== lookup) diffStatus = 'series_only';
      else                                       diffStatus = 'not_in_lib';

      result.push({
        qualId: g.qualId,
        stdCode: g.stdCode,
        stdName: g.stdName,
        category: g.category,
        testItem: [...g.testItems][0] || '',
        testItems: [...g.testItems],
        diffStatus,
        libStatus: exact?.libStatus || '',
        libRemark: exact?.remark || '',
        libDomain: exact?.domain || '',
        seriesNewCode: diffStatus === 'series_only' ? (series?.stdCode || '') : '',
        seriesDomain: diffStatus === 'series_only' ? (series?.domain || '') : '',
        manualMapped: mapped,
      });
    }
    return result;
  }

  // ── 黑名单 / 手动映射（diffByLab 依赖） ──

  private createDiffContext(certNumbers?: string[]): DiffContext {
    const blackNorm = this.blacklistNormSet();
    const blackRaw = this.blacklistRawSet();
    const globalManualMap = new Map<string, string>();
    const manualMapByCert = new Map<string, Map<string, string>>();
    const certs = [...new Set((certNumbers || []).filter(Boolean))];
    const rows = certs.length
      ? this.db.prepare(`
          SELECT cert_number, src_norm, lib_norm FROM cma_diff_manual_map
          WHERE cert_number = '' OR cert_number IN (${certs.map(() => '?').join(',')})
          ORDER BY cert_number ASC
        `).all(...certs) as Array<{ cert_number: string; src_norm: string; lib_norm: string }>
      : this.db.prepare(`
          SELECT cert_number, src_norm, lib_norm FROM cma_diff_manual_map
          ORDER BY cert_number ASC
        `).all() as Array<{ cert_number: string; src_norm: string; lib_norm: string }>;

    for (const row of rows) {
      if (!row.cert_number) {
        globalManualMap.set(row.src_norm, row.lib_norm);
        continue;
      }
      let scoped = manualMapByCert.get(row.cert_number);
      if (!scoped) { scoped = new Map<string, string>(); manualMapByCert.set(row.cert_number, scoped); }
      scoped.set(row.src_norm, row.lib_norm);
    }
    return { blackNorm, blackRaw, globalManualMap, manualMapByCert };
  }

  private blacklistNormSet(): Set<string> {
    const rows = this.db.prepare(
      "SELECT std_code_norm FROM cma_diff_blacklist WHERE std_code_norm <> ''",
    ).all() as Array<{ std_code_norm: string }>;
    return new Set(rows.map(r => r.std_code_norm));
  }

  private blacklistRawSet(): Set<string> {
    const rows = this.db.prepare(
      "SELECT std_code FROM cma_diff_blacklist WHERE std_code_norm = ''",
    ).all() as Array<{ std_code: string }>;
    return new Set(rows.map(r => r.std_code));
  }

  /** 取该机构生效的 src_norm → lib_norm 映射（机构级优先于全局） */
  private manualMapFor(certNumber: string, context?: DiffContext): Map<string, string> {
    if (context) {
      const m = new Map(context.globalManualMap);
      const scoped = context.manualMapByCert.get(certNumber);
      if (scoped) {
        for (const [src, lib] of scoped) m.set(src, lib);
      }
      return m;
    }
    const rows = this.db.prepare(`
      SELECT cert_number, src_norm, lib_norm FROM cma_diff_manual_map
      WHERE cert_number = ? OR cert_number = ''
      ORDER BY cert_number ASC
    `).all(certNumber) as Array<{ cert_number: string; src_norm: string; lib_norm: string }>;
    // cert_number='' 在前，机构级在后 → 机构级覆盖全局
    const m = new Map<string, string>();
    for (const r of rows) m.set(r.src_norm, r.lib_norm);
    return m;
  }

  // ── 黑名单 CRUD（admin） ──

  listBlacklist(): Array<{ id: number; stdCode: string; stdCodeNorm: string; reason: string; createdAt: string }> {
    const rows = this.db.prepare(
      'SELECT id, std_code, std_code_norm, reason, created_at FROM cma_diff_blacklist ORDER BY created_at DESC, id DESC',
    ).all() as Array<{ id: number; std_code: string; std_code_norm: string; reason: string; created_at: string }>;
    return rows.map(r => ({
      id: r.id, stdCode: r.std_code, stdCodeNorm: r.std_code_norm, reason: r.reason || '', createdAt: r.created_at,
    }));
  }

  /** 批量加入黑名单（多选）。沿用三层归一化：cleanStdCode → extractFullCode 落 norm。 */
  addBlacklist(items: Array<{ stdCode: string; reason?: string }>): number {
    if (!items.length) return 0;
    const ins = this.db.prepare(
      'INSERT INTO cma_diff_blacklist (std_code, std_code_norm, reason) VALUES (?, ?, ?)',
    );
    const tx = this.db.transaction(() => {
      let n = 0;
      for (const it of items) {
        const raw = (it.stdCode || '').trim();
        if (!raw) continue;
        const cleaned = cleanStdCode(raw);
        const norm = extractFullCode(cleaned);
        // 去重：同 norm（或 norm 空时同原始）已存在则跳过
        const exists = norm
          ? this.db.prepare('SELECT 1 FROM cma_diff_blacklist WHERE std_code_norm = ?').get(norm)
          : this.db.prepare("SELECT 1 FROM cma_diff_blacklist WHERE std_code_norm = '' AND std_code = ?").get(cleaned);
        if (exists) continue;
        ins.run(cleaned, norm, (it.reason || '').trim());
        n++;
      }
      return n;
    });
    return tx();
  }

  removeBlacklist(ids: number[]): number {
    if (!ids.length) return 0;
    const ph = ids.map(() => '?').join(',');
    return this.db.prepare(`DELETE FROM cma_diff_blacklist WHERE id IN (${ph})`).run(...ids).changes ?? 0;
  }

  // ── 手动映射 CRUD（admin） ──

  listManualMap(certNumber?: string): Array<{ id: number; certNumber: string; srcNorm: string; libNorm: string; createdAt: string }> {
    const rows = certNumber
      ? this.db.prepare("SELECT id, cert_number, src_norm, lib_norm, created_at FROM cma_diff_manual_map WHERE cert_number = ? OR cert_number = '' ORDER BY id DESC").all(certNumber)
      : this.db.prepare('SELECT id, cert_number, src_norm, lib_norm, created_at FROM cma_diff_manual_map ORDER BY id DESC').all();
    return (rows as Array<{ id: number; cert_number: string; src_norm: string; lib_norm: string; created_at: string }>).map(r => ({
      id: r.id, certNumber: r.cert_number, srcNorm: r.src_norm, libNorm: r.lib_norm, createdAt: r.created_at,
    }));
  }

  /** 设手动映射：把机构资质标准号 srcStdCode 指向库内 libStdCode（均归一化为 norm 存）。 */
  setManualMap(certNumber: string, srcStdCode: string, libStdCode: string): void {
    const srcNorm = extractFullCode(cleanStdCode((srcStdCode || '').trim()));
    const libNorm = extractFullCode(cleanStdCode((libStdCode || '').trim()));
    if (!srcNorm || !libNorm) throw new Error('标准号不能为空');
    this.db.prepare(`
      INSERT INTO cma_diff_manual_map (cert_number, src_norm, lib_norm) VALUES (?, ?, ?)
      ON CONFLICT(cert_number, src_norm) DO UPDATE SET lib_norm = excluded.lib_norm
    `).run(certNumber || '', srcNorm, libNorm);
  }

  removeManualMap(id: number): number {
    return this.db.prepare('DELETE FROM cma_diff_manual_map WHERE id = ?').run(id).changes ?? 0;
  }

  /**
   * 重新匹配单个标准号（单项重试用）。复用 diffByLab 全量算后挑出该 stdCode 对应行。
   * 量级小（单机构去重后几百行），直接复用避免重写匹配逻辑、保证与列表一致。
   */
  rematchOne(certNumber: string, stdCode: string): DiffRow | null {
    const targetNorm = extractFullCode(cleanStdCode((stdCode || '').trim()));
    const rows = this.diffByLab(certNumber);
    return rows.find(r => extractFullCode(cleanStdCode(r.stdCode)) === targetNorm || r.stdCode === stdCode) || null;
  }

  /** 订阅机构维度计数（cma-diff 机构列表） */
  labsCounts(): Array<{ certNumber: string; labName: string; total: number; byStatus: Record<DiffStatus, number> }> {
    const labs = this.db.prepare(`
      SELECT cert_number, lab_name FROM cma_labs WHERE subscribed_at IS NOT NULL ORDER BY lab_name
    `).all() as Array<{ cert_number: string; lab_name: string }>;
    const context = this.createDiffContext(labs.map(lab => lab.cert_number));
    return labs.map(lab => {
      const rows = this.diffByLab(lab.cert_number, context);
      const byStatus: Record<DiffStatus, number> = {
        in_lib: 0, cite_only: 0, abolished: 0, series_only: 0, not_in_lib: 0,
      };
      for (const r of rows) byStatus[r.diffStatus]++;
      return {
        certNumber: lab.cert_number,
        labName: lab.lab_name || lab.cert_number,
        total: rows.length,
        byStatus,
      };
    });
  }

  /**
   * 导出比对结果（cma-diff 三级导出端点用）。返回扁平数组，每行带 certNumber/labName。
   *
   * - certNumbers 空 → 取所有订阅机构（cma_labs.subscribed_at IS NOT NULL）
   * - statuses 过滤 → 只留指定档
   * - keyword 过滤 → stdCode/stdName/testItem 子串（与详情页一致）
   * - 排序：最差状态在前（EXPORT_STATUS_ORDER），同状态按 labName + stdCode
   */
  exportDiff(filter: ExportFilter): ExportRow[] {
    // 1) 解析机构清单
    let certNumbers = (filter.certNumbers || []).filter(Boolean);
    if (certNumbers.length === 0) {
      certNumbers = (this.db.prepare(
        'SELECT cert_number FROM cma_labs WHERE subscribed_at IS NOT NULL ORDER BY lab_name',
      ).all() as Array<{ cert_number: string }>).map(r => r.cert_number);
    }
    // 机构名映射
    const nameMap = new Map<string, string>();
    if (certNumbers.length > 0) {
      const ph = certNumbers.map(() => '?').join(',');
      const labs = this.db.prepare(
        `SELECT cert_number, lab_name FROM cma_labs WHERE cert_number IN (${ph})`,
      ).all(...certNumbers) as Array<{ cert_number: string; lab_name: string }>;
      for (const l of labs) nameMap.set(l.cert_number, l.lab_name || l.cert_number);
    }

    const statusSet = filter.statuses && filter.statuses.length ? new Set(filter.statuses) : null;
    const kw = (filter.keyword || '').trim().toLowerCase();
    const context = this.createDiffContext(certNumbers);

    // 2) 逐机构 diff + 过滤 + 摊平
    const out: ExportRow[] = [];
    for (const cert of certNumbers) {
      const labName = nameMap.get(cert) || cert;
      let rows = this.diffByLab(cert, context);
      if (statusSet) rows = rows.filter(r => statusSet.has(r.diffStatus));
      if (kw) rows = rows.filter(r =>
        r.stdCode.toLowerCase().includes(kw) ||
        r.stdName.toLowerCase().includes(kw) ||
        r.testItem.toLowerCase().includes(kw));
      for (const r of rows) out.push({ ...r, certNumber: cert, labName });
    }

    // 3) 排序：最差状态在前，同状态按 labName + stdCode
    out.sort((a, b) => {
      const d = EXPORT_STATUS_ORDER[a.diffStatus] - EXPORT_STATUS_ORDER[b.diffStatus];
      if (d !== 0) return d;
      const n = a.labName.localeCompare(b.labName, 'zh');
      if (n !== 0) return n;
      return a.stdCode.localeCompare(b.stdCode);
    });
    return out;
  }

  /**
   * 搜索能力项目库（总库搜索）。
   * 支持按标准号、检测方法、领域、状态筛选，关键词模糊匹配。
   */
  searchCapLib(params: { q?: string; domain?: string; status?: string; limit?: number; offset?: number }) {
    const { q, domain, status, limit = 50, offset = 0 } = params;
    const conditions: string[] = [];
    const values: any[] = [];

    if (q) {
      const like = `%${q}%`;
      conditions.push('(std_code LIKE ? OR std_code_norm LIKE ? OR standard_method LIKE ? OR remark LIKE ?)');
      values.push(like, like, like, like);
    }
    if (domain) {
      conditions.push('domain = ?');
      values.push(domain);
    }
    if (status) {
      conditions.push('lib_status = ?');
      values.push(status);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // 总数
    const countRow = this.db.prepare(`SELECT COUNT(*) as cnt FROM cma_capability_lib ${where}`).get(...values) as { cnt: number };

    // 数据
    const rows = this.db.prepare(`
      SELECT source_id, domain, standard_method, std_code, lib_status, remark, last_seen_at
      FROM cma_capability_lib ${where}
      ORDER BY domain, std_code
      LIMIT ? OFFSET ?
    `).all(...values, limit, offset) as Array<{
      source_id: number; domain: string; standard_method: string; std_code: string;
      lib_status: string; remark: string; last_seen_at: string;
    }>;

    return {
      total: countRow.cnt,
      items: rows.map(r => ({
        id: r.source_id,
        domain: r.domain,
        method: r.standard_method,
        stdCode: r.std_code,
        status: r.lib_status,
        remark: r.remark || '',
        lastSeenAt: r.last_seen_at || '',
      })),
    };
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────

function hashRow(domain: string, method: string, stdCode: string, remark: string, status: LibStatus, raw: string): string {
  const h = crypto.createHash('sha1');
  h.update(domain); h.update('|');
  h.update(method); h.update('|');
  h.update(stdCode); h.update('|');
  h.update(remark); h.update('|');
  h.update(status); h.update('|');
  h.update(raw);
  return h.digest('hex');
}

function priority(s: LibStatus): number {
  return s === 'active' ? 3 : s === 'cite_only' ? 2 : 1;
}

// re-export 给路由用
export { CAP_LIB_DOMAIN_NAMES, isValidCapLibDomain };
