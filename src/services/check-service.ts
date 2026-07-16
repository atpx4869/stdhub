import type Database from 'better-sqlite3';
import type { SourceName, StandardSummary } from '../domain/standard';
import type { SourceRegistry } from './source-registry';
import { StandardService } from './standard-service';
import { pooledFetch } from '../shared/http';
import { cleanStdCode, extractFullCode, extractBaseCode } from '../shared/std-code';

/**
 * 标准查新（见 docs/CHECK-UPDATE-AND-STATS.md）。
 *
 * 流程：导入标准号（必须带年代号）→ 逐个直接查 BZ search（原文查询，不走 StandardResolver
 * 的严格格式门槛，纯数字号如 "3324-2017" 也能查）→ 取最佳匹配 → 存"基线快照"；
 * 查新（recheck）= 再查一遍 + 与基线 diff，产出 change_flags。
 *
 * 为什么不复用 StandardResolver：它要求 [A-Z]{2,4} 字母前缀，把 "3324-2017" 这类
 * 纯数字号全卡成"无法识别"。查新改为像标准检索那样原文直查 BZ。
 */

// 查新单条匹配结果（BZ 直查，替代原 ResolvedItem）
interface CheckMatch {
  input: string;
  standardNumber: string;
  title: string;
  status?: string;
  implementDate?: string | null;
  replacedStd?: string | null;   // 本标准代替的旧标准（前身）= "我取代了谁"
  insteadStd?: string | null;    // 代替本标准的新标准 = "我被谁取代"（仅 detail-dm 有）
  abolishDate?: string | null;   // 废止日期（endData）
}

const BZ_BASE = 'https://bz.gxzl.org.cn';
// 需要补 detail-dm 拿替换信息的状态（非"现行有效"）。现行有效不补、省请求。
function needsReplaceInfo(status: string | undefined | null): boolean {
  return !!status && !/^现行有效$/.test(status.trim());
}

// 标准号必须带 4 位年代号（导入校验用）。如 "3324-2017"、"GB/T 3325-2020"。
export function hasYearCode(code: string): boolean {
  return /(?:^|[\s\-–—/])\d{4}\s*$/.test(code.trim());
}

// ── 限流硬上限（用户改不了，见 docs/CHECK-UPDATE-AND-STATS.md）──
const MAX_ITEMS = 200;            // 单清单最多标准数（导入超出截断）
const BATCH_SIZE = 50;            // 每批查询量
const BATCH_GAP_MS = 2000;        // 批间隔，给 BZ 喘息
const MANUAL_DEBOUNCE_MS = 20 * 60 * 1000; // 手动「重新查新」同清单防抖 20 分钟
const MIN_AUTO_INTERVAL_DAYS = 15;         // 自动查新周期硬下限（也是默认值）
// 注：实际出站并发由 BZ source-semaphore(=2) 收口；这里分批 + 批间隔再加一层保险。

export class CheckDebounceError extends Error {
  constructor(public retryAfterMin: number) {
    super(`距上次查新不足 20 分钟，请 ${retryAfterMin} 分钟后再试`);
    this.name = 'CheckDebounceError';
  }
}

export type ChangeFlag = 'status' | 'newVersion' | 'implDate' | 'replacedBy';

// 变动类型中文标签（导出表格 / 后端复用）
export const CHANGE_FLAG_LABELS: Record<ChangeFlag, string> = {
  status: '状态变化', newVersion: '有新版本', implDate: '实施日期变化', replacedBy: '被代替',
};

export interface CheckItemRow {
  id: number;
  watchlistId: number;
  stdCode: string;
  baseStatus: string | null;
  baseTitle: string | null;
  baseImplDate: string | null;
  baseReplacedBy: string | null;
  lastStatus: string | null;
  lastTitle: string | null;
  lastImplDate: string | null;
  lastReplacedBy: string | null;
  lastCheckedAt: string | null;
  changeFlags: ChangeFlag[];
  sourceUsed: string | null;
  newVersion: string | null;
  insteadStd: string | null;   // 被谁代替
  abolishDate: string | null;  // 废止日期
}

export class CheckService {
  private bzService: StandardService | null = null;
  // 全局串行锁：同一时刻只允许一个清单在查（防多清单/多用户并发打爆 BZ）。
  private static querying = false;

  // 不在构造里 registry.get('bz')：那会在 createApp() 时急切加载 BZ adapter
  // （破坏懒加载约定、且测试环境 require 路径解析会失败）。改为查询时懒解析。
  constructor(private readonly db: Database.Database, private readonly registry: SourceRegistry) {}

  private bz(): StandardService {
    if (!this.bzService) this.bzService = new StandardService(this.registry.get('bz'));
    return this.bzService;
  }

  private static sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

  // 直查 BZ：原文 search → 取最佳匹配（同基础号 + 年版一致优先；带年号要求精确年版）。
  private async queryOne(input: string): Promise<CheckMatch | null> {
    const q = input.trim();
    let results: StandardSummary[];
    try {
      results = await this.bz().searchStandards({ query: q });
    } catch {
      return null; // BZ 查询失败 → 当作未命中（标 not_found）
    }
    if (!results.length) return null;
    const best = pickBzMatch(q, results);
    if (!best) return null;
    const m: CheckMatch = {
      input,
      standardNumber: best.standardNumber,
      title: best.title,
      status: best.status,
      implementDate: best.implementDate,
      replacedStd: typeof best.meta?.replacedStd === 'string' ? (best.meta.replacedStd as string) : null,
      insteadStd: null,
      abolishDate: best.abolishedDate ?? null,
    };
    // 非现行状态：补 detail-dm 拿 insteadStd（被谁代替）+ 更准的 status/废止日期。
    // 现行有效不补，省请求。失败静默（保留 list 已有信息）。
    if (needsReplaceInfo(best.status) && best.sourceId) {
      const dm = await this.fetchDetailDm(best.sourceId);
      if (dm) {
        m.insteadStd = dm.insteadStd || null;
        if (dm.replacedStd) m.replacedStd = dm.replacedStd;
        if (dm.stdStatus) m.status = dm.stdStatus;       // detail-dm 状态是中文、更准
        if (dm.endData) m.abolishDate = dm.endData;
      }
    }
    return m;
  }

  // 取 detail-dm 的替换/废止字段。独立 fetch（不经 adapter，查新专用）。失败返回 null。
  private async fetchDetailDm(sourceId: string): Promise<{ insteadStd?: string; replacedStd?: string; stdStatus?: string; endData?: string } | null> {
    try {
      const url = `${BZ_BASE}/api/gxist-standard/standardstd/detail-dm?id=${encodeURIComponent(sourceId)}&language=null`;
      const res = await pooledFetch(url, { timeoutMs: 10_000, retries: 1 });
      if (!res.ok) return null;
      const json = await res.json() as { data?: { insteadStd?: string; replacedStd?: string; stdStatus?: string; endData?: string } };
      return json.data ?? null;
    } catch {
      return null;
    }
  }

  // 分批查询：每批 BATCH_SIZE 个、批内串行（BZ semaphore=2 再收口出站并发）、批间 sleep。
  private async queryBatched(lines: string[]): Promise<CheckMatch[]> {
    const out: CheckMatch[] = [];
    const CONCURRENCY = 2; // 与 BZ source-semaphore 一致
    for (let i = 0; i < lines.length; i += BATCH_SIZE) {
      const chunk = lines.slice(i, i + BATCH_SIZE);
      // 批内并发：每批最多 CONCURRENCY 个请求同时发出
      const results = await Promise.all(
        chunk.map(line => this.queryOne(line).catch(() => null)),
      );
      for (const m of results) {
        if (m) out.push(m);
      }
      if (i + BATCH_SIZE < lines.length) await CheckService.sleep(BATCH_GAP_MS);
    }
    return out;
  }

  // 创建清单并导入标准号（首查存基线）。只查 BZ；超 MAX_ITEMS 截断；
  // **导入必须带年代号**，无年号的行被丢弃并通过 skippedNoYear 计数回报。
  async createWatchlist(
    userId: number,
    name: string,
    lines: string[],
  ): Promise<{ id: number; itemCount: number; truncated: boolean; skippedNoYear: number }> {
    const dedupAll = [...new Set(lines.map((l) => l.trim()).filter(Boolean))];
    // 年代号校验：无年号的剔除
    const withYear = dedupAll.filter((l) => hasYearCode(l));
    const skippedNoYear = dedupAll.length - withYear.length;
    const truncated = withYear.length > MAX_ITEMS;
    const dedup = withYear.slice(0, MAX_ITEMS);

    const info = this.db
      .prepare('INSERT INTO check_watchlists (user_id, name) VALUES (?, ?)')
      .run(userId, name || '未命名清单');
    const watchlistId = Number(info.lastInsertRowid);

    if (CheckService.querying) {
      // 已有清单在查：本次只建清单 + 存号、不立即查（基线留空，用户稍后手动查新）
      this.insertItemsNoBaseline(watchlistId, dedup);
      return { id: watchlistId, itemCount: dedup.length, truncated, skippedNoYear };
    }
    CheckService.querying = true;
    let matches: CheckMatch[];
    try {
      matches = await this.queryBatched(dedup);
    } finally {
      CheckService.querying = false;
    }
    const byInput = new Map(matches.map((r) => [r.input, r]));

    const now = new Date().toISOString();
    const insert = this.db.prepare(`
      INSERT INTO check_items
        (watchlist_id, std_code, std_code_norm, base_status, base_title, base_impl_date,
         base_replaced_by, base_snapshot_at, last_status, last_title, last_impl_date,
         last_replaced_by, last_checked_at, change_flags, source_used, instead_std, abolish_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)
    `);
    const txn = this.db.transaction((rawLines: string[]) => {
      for (const raw of rawLines) {
        const code = cleanStdCode(raw);
        if (!code) continue;
        const m = byInput.get(raw) ?? byInput.get(code);
        const sourceUsed = m ? 'bz' : 'not_found';
        insert.run(
          watchlistId, code, extractFullCode(code),
          m?.status ?? null, m?.title ?? null, m?.implementDate ?? null, m?.replacedStd ?? null, now,
          m?.status ?? null, m?.title ?? null, m?.implementDate ?? null, m?.replacedStd ?? null, now,
          sourceUsed, m?.insteadStd ?? null, m?.abolishDate ?? null,
        );
      }
    });
    txn(dedup);
    this.db.prepare('UPDATE check_watchlists SET last_checked_at = ? WHERE id = ?').run(now, watchlistId);

    const itemCount = (this.db.prepare('SELECT COUNT(*) c FROM check_items WHERE watchlist_id = ?').get(watchlistId) as { c: number }).c;
    return { id: watchlistId, itemCount, truncated, skippedNoYear };
  }

  // 已有清单在查时的兜底：只存标准号、不查基线（base_* 留空，change_flags='[]'，source_used='pending'）。
  private insertItemsNoBaseline(watchlistId: number, dedup: string[]): void {
    const insert = this.db.prepare(`
      INSERT INTO check_items
        (watchlist_id, std_code, std_code_norm, base_snapshot_at, change_flags, source_used)
      VALUES (?, ?, ?, NULL, '[]', 'pending')
    `);
    const txn = this.db.transaction((rawLines: string[]) => {
      for (const raw of rawLines) {
        const code = cleanStdCode(raw);
        if (code) insert.run(watchlistId, code, extractFullCode(code));
      }
    });
    txn(dedup);
  }

  // 重新查新：逐项再查 + 与基线 diff，更新 last_* 与 change_flags。
  // manual=true（用户点按钮）走 20 分钟防抖；自动查新传 manual=false 跳过防抖。
  // sources 参数已废弃（固定查 BZ），保留签名兼容自动查新调用。
  async recheck(watchlistId: number, _sources: SourceName[] = ['bz'], manual = true): Promise<void> {
    // 手动防抖：同清单 20 分钟内拒绝重复
    if (manual) {
      const row = this.db.prepare('SELECT last_checked_at FROM check_watchlists WHERE id = ?').get(watchlistId) as { last_checked_at: string | null } | undefined;
      if (row?.last_checked_at) {
        const elapsed = Date.now() - new Date(row.last_checked_at).getTime();
        if (elapsed < MANUAL_DEBOUNCE_MS) {
          throw new CheckDebounceError(Math.ceil((MANUAL_DEBOUNCE_MS - elapsed) / 60000));
        }
      }
    }
    // 全局串行：已有清单在查则拒绝（避免叠加打 BZ）
    if (CheckService.querying) throw new Error('已有查新任务进行中，请稍后再试');

    const items = this.db
      .prepare('SELECT id, std_code FROM check_items WHERE watchlist_id = ?')
      .all(watchlistId) as Array<{ id: number; std_code: string }>;
    if (!items.length) return;

    CheckService.querying = true;
    let matches: CheckMatch[];
    try {
      matches = await this.queryBatched(items.map((i) => i.std_code));
    } finally {
      CheckService.querying = false;
    }
    const allFresh = matches;
    const byInput = new Map(matches.map((r) => [r.input, r]));

    const now = new Date().toISOString();
    const update = this.db.prepare(`
      UPDATE check_items
      SET last_status = ?, last_title = ?, last_impl_date = ?, last_replaced_by = ?,
          last_checked_at = ?, change_flags = ?, source_used = ?, new_version = ?,
          instead_std = ?, abolish_date = ?
      WHERE id = ?
    `);
    const txn = this.db.transaction(() => {
      for (const it of items) {
        const base = this.db.prepare(
          'SELECT base_status, base_title, base_impl_date, base_replaced_by, instead_std FROM check_items WHERE id = ?',
        ).get(it.id) as { base_status: string | null; base_title: string | null; base_impl_date: string | null; base_replaced_by: string | null; instead_std: string | null };
        const fresh = byInput.get(it.std_code) ?? byInput.get(cleanStdCode(it.std_code));
        const sourceUsed = fresh ? 'bz' : 'not_found';
        const d = fresh ? this.diff(base, fresh, allFresh) : { flags: [] as ChangeFlag[], newVersion: null };
        update.run(
          fresh?.status ?? null, fresh?.title ?? null, fresh?.implementDate ?? null, fresh?.replacedStd ?? null,
          now, JSON.stringify(d.flags), sourceUsed, d.newVersion,
          fresh?.insteadStd ?? null, fresh?.abolishDate ?? null, it.id,
        );
      }
    });
    txn();
    this.db.prepare('UPDATE check_watchlists SET last_checked_at = ? WHERE id = ?').run(now, watchlistId);
  }

  // 逐字段 diff，产出变动标记 + 检出的具体新版本号（供 UI 展示 "GB/T 1.1-2020"）。
  private diff(
    base: { base_status: string | null; base_impl_date: string | null; base_replaced_by: string | null; instead_std: string | null },
    fresh: CheckMatch,
    allFresh: CheckMatch[],
  ): { flags: ChangeFlag[]; newVersion: string | null } {
    const flags: ChangeFlag[] = [];
    // 状态：精确文案比对（现行有效→即将废止 逐级预警）
    if ((base.base_status ?? '') !== (fresh.status ?? '')) flags.push('status');
    // 实施日期
    if ((base.base_impl_date ?? '') !== (fresh.implementDate ?? '')) flags.push('implDate');
    // 被代替关系：比 insteadStd（被谁取代）——这才是用户关心的"被代替"变动。
    // replacedStd（代替的前身）是历史事实、不变，不参与 diff。为空不算变化。
    if ((base.instead_std ?? '') !== (fresh.insteadStd ?? '') && (fresh.insteadStd ?? '')) flags.push('replacedBy');
    // 新版本：同基础号（剥年份）出现更高年版 → 记下具体版本号
    const baseCode = extractBaseCode(fresh.standardNumber);
    const freshYear = yearOf(fresh.standardNumber);
    let newVersion: string | null = null;
    for (const r of allFresh) {
      if (extractBaseCode(r.standardNumber) === baseCode && yearOf(r.standardNumber) > freshYear) {
        if (!newVersion || yearOf(r.standardNumber) > yearOf(newVersion)) newVersion = r.standardNumber;
      }
    }
    if (newVersion) flags.push('newVersion');
    return { flags, newVersion };
  }

  getWatchlists(userId: number) {
    return this.db.prepare(`
      SELECT w.id, w.name, w.created_at, w.last_checked_at,
             w.auto_enabled, w.auto_interval_days, w.next_run_at, w.is_saved,
             (SELECT COUNT(*) FROM check_items i WHERE i.watchlist_id = w.id) AS item_count,
             (SELECT COUNT(*) FROM check_items i WHERE i.watchlist_id = w.id AND i.change_flags != '[]') AS changed_count
      FROM check_watchlists w
      WHERE w.user_id = ?
      ORDER BY w.is_saved DESC, w.created_at DESC
    `).all(userId);
  }

  // 取（必要时创建）用户的内置"我的收藏"查新清单。每用户一条、is_saved=1、不可删。
  getOrCreateSavedWatchlist(userId: number): number {
    const row = this.db.prepare('SELECT id FROM check_watchlists WHERE user_id = ? AND is_saved = 1').get(userId) as { id: number } | undefined;
    if (row) return row.id;
    const info = this.db.prepare(
      "INSERT INTO check_watchlists (user_id, name, is_saved) VALUES (?, '我的收藏', 1)",
    ).run(userId);
    return Number(info.lastInsertRowid);
  }

  // 收藏 toggle：标准号已在收藏清单 → 移除并返回 {saved:false}；否则加入 + 查一次基线 → {saved:true}。
  // 标准号须带年代号（与导入一致）。
  async toggleSaved(userId: number, rawCode: string): Promise<{ saved: boolean }> {
    const code = cleanStdCode(rawCode);
    if (!code) throw new Error('标准号无效');
    const wlId = this.getOrCreateSavedWatchlist(userId);
    const existing = this.db.prepare(
      'SELECT id FROM check_items WHERE watchlist_id = ? AND std_code = ?',
    ).get(wlId, code) as { id: number } | undefined;
    if (existing) {
      this.db.prepare('DELETE FROM check_items WHERE id = ?').run(existing.id);
      return { saved: false };
    }
    // 新增：查一次 BZ 存基线（不抢全局串行锁——单条、轻量）
    const m = await this.queryOne(code);
    const now = new Date().toISOString();
    const sourceUsed = m ? 'bz' : 'not_found';
    this.db.prepare(`
      INSERT INTO check_items
        (watchlist_id, std_code, std_code_norm, base_status, base_title, base_impl_date,
         base_replaced_by, base_snapshot_at, last_status, last_title, last_impl_date,
         last_replaced_by, last_checked_at, change_flags, source_used, instead_std, abolish_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?, ?)
    `).run(
      wlId, code, extractFullCode(code),
      m?.status ?? null, m?.title ?? null, m?.implementDate ?? null, m?.replacedStd ?? null, now,
      m?.status ?? null, m?.title ?? null, m?.implementDate ?? null, m?.replacedStd ?? null, now,
      sourceUsed, m?.insteadStd ?? null, m?.abolishDate ?? null,
    );
    return { saved: true };
  }

  // 返回该用户收藏清单里的标准号集合（前端搜索结果点亮收藏态用）。
  getSavedCodes(userId: number): string[] {
    const row = this.db.prepare('SELECT id FROM check_watchlists WHERE user_id = ? AND is_saved = 1').get(userId) as { id: number } | undefined;
    if (!row) return [];
    const rows = this.db.prepare('SELECT std_code FROM check_items WHERE watchlist_id = ?').all(row.id) as Array<{ std_code: string }>;
    return rows.map((r) => r.std_code);
  }

  // 设置自动查新：enabled + 周期天数（硬下限 15）。开启时算出 next_run_at。
  setAuto(watchlistId: number, enabled: boolean, intervalDays: number): void {
    const days = Math.max(MIN_AUTO_INTERVAL_DAYS, Math.floor(intervalDays) || MIN_AUTO_INTERVAL_DAYS);
    const next = enabled ? new Date(Date.now() + days * 864e5).toISOString() : null;
    this.db.prepare(
      'UPDATE check_watchlists SET auto_enabled = ?, auto_interval_days = ?, next_run_at = ? WHERE id = ?',
    ).run(enabled ? 1 : 0, days, next, watchlistId);
  }

  // 跑所有到期的自动查新（启动时 + 定时器调用）。串行执行，每个查完重排下次时间。
  // 返回有变动的清单摘要，供调用方写运行日志 / 通知。
  async runDueAutoChecks(): Promise<Array<{ id: number; name: string; changedCount: number }>> {
    const due = this.db.prepare(`
      SELECT id, name, auto_interval_days FROM check_watchlists
      WHERE auto_enabled = 1 AND (next_run_at IS NULL OR next_run_at <= ?)
      ORDER BY next_run_at
    `).all(new Date().toISOString()) as Array<{ id: number; name: string; auto_interval_days: number }>;
    const out: Array<{ id: number; name: string; changedCount: number }> = [];
    for (const w of due) {
      try {
        await this.recheck(w.id, ['bz'], false); // 自动：跳过手动防抖
        const changed = (this.db.prepare(
          "SELECT COUNT(*) c FROM check_items WHERE watchlist_id = ? AND change_flags != '[]'",
        ).get(w.id) as { c: number }).c;
        if (changed > 0) out.push({ id: w.id, name: w.name, changedCount: changed });
      } catch (e) {
        // 单个清单失败不阻断其它（如串行锁占用）；下一轮再补
        console.warn(`[check-auto] watchlist ${w.id} 自动查新失败:`, e instanceof Error ? e.message : String(e));
      } finally {
        const days = Math.max(MIN_AUTO_INTERVAL_DAYS, w.auto_interval_days || MIN_AUTO_INTERVAL_DAYS);
        this.db.prepare('UPDATE check_watchlists SET next_run_at = ? WHERE id = ?')
          .run(new Date(Date.now() + days * 864e5).toISOString(), w.id);
      }
    }
    return out;
  }

  // 单清单明细（含每项的基线/最新/变动标记），按"有变动优先"排序留给前端分组。
  getItems(watchlistId: number): CheckItemRow[] {
    const rows = this.db.prepare(`
      SELECT id, watchlist_id, std_code, base_status, base_title, base_impl_date, base_replaced_by,
             last_status, last_title, last_impl_date, last_replaced_by, last_checked_at,
             change_flags, source_used, new_version, instead_std, abolish_date
      FROM check_items WHERE watchlist_id = ? ORDER BY id
    `).all(watchlistId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id as number,
      watchlistId: r.watchlist_id as number,
      stdCode: r.std_code as string,
      baseStatus: (r.base_status as string) ?? null,
      baseTitle: (r.base_title as string) ?? null,
      baseImplDate: (r.base_impl_date as string) ?? null,
      baseReplacedBy: (r.base_replaced_by as string) ?? null,
      lastStatus: (r.last_status as string) ?? null,
      lastTitle: (r.last_title as string) ?? null,
      lastImplDate: (r.last_impl_date as string) ?? null,
      lastReplacedBy: (r.last_replaced_by as string) ?? null,
      lastCheckedAt: (r.last_checked_at as string) ?? null,
      changeFlags: safeFlags(r.change_flags as string),
      sourceUsed: (r.source_used as string) ?? null,
      newVersion: (r.new_version as string) ?? null,
      insteadStd: (r.instead_std as string) ?? null,
      abolishDate: (r.abolish_date as string) ?? null,
    }));
  }

  // 删除清单（含明细）。调用方需校验 user_id 归属。
  deleteWatchlist(watchlistId: number): void {
    const txn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM check_items WHERE watchlist_id = ?').run(watchlistId);
      this.db.prepare('DELETE FROM check_watchlists WHERE id = ?').run(watchlistId);
    });
    txn();
  }

  ownerOf(watchlistId: number): number | null {
    const row = this.db.prepare('SELECT user_id FROM check_watchlists WHERE id = ?').get(watchlistId) as { user_id: number } | undefined;
    return row ? row.user_id : null;
  }
}

function yearOf(stdNumber: string): number {
  const m = stdNumber.match(/(\d{4})\s*$/);
  return m ? parseInt(m[1], 10) : 0;
}

// 从 BZ search 结果里挑最匹配查询号的一条。查询带年号 → 优先精确年版命中；
// 否则取同号最新年版。号比对用归一化后的基础号（剥年）+ 数字子串，宽松匹配纯数字号。
function pickBzMatch(query: string, results: StandardSummary[]): StandardSummary | null {
  if (!results.length) return null;
  const qBase = extractBaseCode(query);                 // 剥年的基础号
  const qNum = (query.match(/\d+(?:\.\d+)*/) || [''])[0]; // 主号数字
  const qYear = yearOf(query);

  // 同基础号的候选（基础号相等，或标准号里含主号数字子串兜底）
  const sameBase = results.filter((r) => {
    const rb = extractBaseCode(r.standardNumber);
    return (qBase && rb === qBase) || (qNum && r.standardNumber.includes(qNum));
  });
  const pool = sameBase.length ? sameBase : results;

  if (qYear) {
    const exact = pool.find((r) => yearOf(r.standardNumber) === qYear);
    if (exact) return exact;
    // 带年号但没查到该年版：返回同号最新年版（让 diff 能标"有新版本"），没有就第一条
  }
  // 取最新年版
  return pool.slice().sort((a, b) => yearOf(b.standardNumber) - yearOf(a.standardNumber))[0] ?? null;
}
function safeFlags(s: string | null): ChangeFlag[] {
  if (!s) return [];
  try { const a = JSON.parse(s); return Array.isArray(a) ? a : []; } catch { return []; }
}
