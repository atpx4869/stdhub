/**
 * labr.cc 编排层 —— 把协议层（labr-client）封成可被 API 路由直接调用的高阶操作。
 *
 * 这一层承担的职责（labr-client 故意不做）：
 *  1. **Session 持久化**：token 写 settings 表（key=`labr.token` / `labr.token_expires_at`），
 *     进程重启后复用，避免每次冷启都 login。labr token 实测寿命 365 天，浪费可惜。
 *  2. **登录凭据来源**：从 env 读 `LABR_USERNAME` / `LABR_PASSWORD`，跟 BY adapter 的
 *     `BY_USERNAME` / `BY_PASSWORD` 风格保持一致。**不允许把账号密码写进任何文件**
 *     （probe-labr-result.md 是例外，作为协议探测证据保留，不进 commit 流）。
 *  3. **kind 双路径下载**：
 *     - kind=0 → 匿名直拉 detail.filepath（filesystem 真路径）
 *     - kind=1 → 先查 `labr_temp_urls` 缓存（temp/<md5>.pdf 跨 token 仍可拉），命中即省
 *       一次 preview2 配额；miss / 失效才调 preview2 拿新 url 并入表
 *  4. **批量退避**：preview2 撞 5次/日上限抛 `LabrRateLimitError` 后，整个批次内后续的
 *     kind=1 任务直接 short-circuit；kind=0 任务不受影响继续跑。**单次任务**层面不退避，
 *     是 batchDownload 才有意义。
 *  5. **Auth 自愈**：preview2 抛 `LabrAuthError`（token 失效）→ 清缓存、重新 login + bridgeSso、
 *     重试一次；第二次还失败就抛出去给 API 层（前端弹"凭据失效，请检查环境变量"）。
 *  6. **入库统一**：所有成功下载经 `addFileToLibrary` 走统一 library_filename_pattern 命名
 *     + standards_library_dir 落地。labr 不实现 SourceAdapter，但产物跟其他源平起平坐。
 *
 * 设计取舍：
 * - 单例模式（模块级 `_instance`），跟 by-adapter 风格一致。多实例没意义 —— session 是
 *   全局共享资源，并发只通过 `getSourceSemaphore('labr')` 节流。
 * - 不写 retry-with-backoff 通用机制：preview2 配额是硬上限，无论怎么 backoff 当天都没救；
 *   `pooledFetch` 已经在传输层处理网络抖动。
 * - 不缓存 `getDetail` 结果。detail 主要是给前端预览用的，每次重新拉拿到 isFav 等用户态。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type Database from 'better-sqlite3';

import { getDb, getSetting, setSetting } from '../../services/db';
import { addFileToLibrary } from '../../services/library-index';
import { getSourceSemaphore } from '../../shared/source-semaphore';
import { BadRequestError, UpstreamError } from '../../shared/errors';
import { assertNonEmptyDownload } from '../../shared/download-integrity';
import { searchCache } from '../../shared/cache';
import { cleanStdCode } from '../../shared/std-code';
import {
  LabrAuthError,
  LabrClient,
  LabrRateLimitError,
  extractStdCodeFromTitle,
  normalizeLabrExt,
  type LabrDetail,
  type LabrInfo,
  type LabrListItem,
  type LabrRecListResponse,
  type LabrSession,
} from './labr-client';

// settings 表里的 key
const KEY_TOKEN = 'labr.token';
const KEY_TOKEN_EXP = 'labr.token_expires_at';     // epoch ms
const KEY_LAST_LOGIN = 'labr.last_login_at';        // ISO string，诊断用

// token 过期前 1 天主动刷新（labr 365 天寿命，留宽裕余量）
const REFRESH_LEAD_MS = 24 * 60 * 60 * 1000;

export interface LabrDownloadResult {
  /** library 内的绝对路径（成功） */
  absPath: string;
  /** library 内的纯文件名 */
  fileName: string;
  /** 该资源在 standard_files 表的行 id */
  fileId: number;
  /** true = 库内已有同 (stdCode, year, source) 记录，没重新下载 */
  reused: boolean;
  /** 文件扩展名（不带点），方便前端按类型显示徽章 */
  ext: string;
  /** 字节数 */
  size: number;
  /** 从 title 抽出的 stdCode；空表示 title 不匹配标准号正则（仍可下载，按 title 入库） */
  stdCode: string;
  /** title 去掉 stdCode 前缀后的纯名 */
  cleanTitle: string;
}

export interface LabrBatchItemResult {
  did: number;
  ok: boolean;
  result?: LabrDownloadResult;
  error?: { code: string; message: string };
}

export class LabrService {
  private readonly client: LabrClient;
  /** 进程内 session 缓存；进程间通过 settings 表持久化 */
  private session: LabrSession | null = null;
  /** 并发登录守门：多个请求并发 getSession 时只 login 一次 */
  private loginPromise: Promise<LabrSession> | null = null;

  constructor(
    private readonly db: Database.Database,
    client = new LabrClient(),
  ) {
    this.client = client;
  }

  // ─── Session 管理 ──────────────────────────────────────────────────────

  /**
   * 拿一个可用的 session。流程：
   *   1. 内存里有且未到 REFRESH_LEAD_MS 前 → 直接用
   *   2. 内存里没 → 读 settings；settings 里有未过期 → 装填内存
   *   3. settings 也没 / 已过期 → env 读凭据 + login + bridgeSso + 写回 settings
   *
   * 并发请求会复用同一个 loginPromise，避免 5 个 batch 各自打一次 login（labr login
   * 应该不限速，但礼貌）。
   */
  private async getSession(db: Database.Database): Promise<LabrSession> {
    const now = Date.now();
    if (this.session && this.session.expiresAt - REFRESH_LEAD_MS > now) {
      return this.session;
    }

    // 从 settings 装填
    const token = getSetting(db, KEY_TOKEN, '');
    const expRaw = getSetting(db, KEY_TOKEN_EXP, '0');
    const expiresAt = Number(expRaw) || 0;
    if (token && expiresAt - REFRESH_LEAD_MS > now) {
      this.session = { token, expiresAt };
      return this.session;
    }

    if (this.loginPromise) return this.loginPromise;
    this.loginPromise = this.doLogin(db).finally(() => { this.loginPromise = null; });
    return this.loginPromise;
  }

  private async doLogin(db: Database.Database): Promise<LabrSession> {
    const username = process.env.LABR_USERNAME?.trim();
    const password = process.env.LABR_PASSWORD?.trim();
    if (!username || !password) {
      throw new BadRequestError(
        'labr 凭据未配置：请设置环境变量 LABR_USERNAME 与 LABR_PASSWORD（参考 BY_USERNAME / BY_PASSWORD 风格）',
      );
    }
    const resp = await this.client.login(username, password);
    // bridgeSso 失败不致命：实测无 bridge 也能用，但我们尽量调一次
    try { await this.client.bridgeSso(resp.token); } catch (e) {
      console.warn('[labr-service] bridgeSso failed (non-fatal):', e instanceof Error ? e.message : String(e));
    }
    const expiresAt = Date.now() + (resp.expiresIn > 0 ? resp.expiresIn * 1000 : 30 * 24 * 60 * 60 * 1000);
    const session: LabrSession = { token: resp.token, expiresAt };
    this.session = session;
    setSetting(db, KEY_TOKEN, session.token);
    setSetting(db, KEY_TOKEN_EXP, String(expiresAt));
    setSetting(db, KEY_LAST_LOGIN, new Date().toISOString());
    return session;
  }

  /** 强制让缓存的 session 失效。preview2 撞 LabrAuthError 时调一次然后重试。 */
  private invalidateSession(db: Database.Database): void {
    this.session = null;
    setSetting(db, KEY_TOKEN, '');
    setSetting(db, KEY_TOKEN_EXP, '0');
  }

  // ─── 查询（不需要登录的 anonymous 流） ────────────────────────────────

  /** 首屏内联 ≤4 条，匿名。5min TTL 缓存（公共数据，跨用户安全） */
  async searchInline(keyword: string): Promise<LabrListItem[]> {
    const key = `labr:inline:${keyword}`;
    const cached = searchCache.get<LabrListItem[]>(key);
    if (cached) return cached;
    const result = await this.client.searchInline(keyword);
    searchCache.set(key, result);
    return result;
  }

  /**
   * 翻页接口。带 session 拿用户态，没 session 也能拉公共字段。
   * 我们默认带 session（如果已有），避免 401-类边缘；session 缺失时跑匿名。
   * 5min TTL 缓存：搜索结果是公共数据（user-token 仅给 isFav 等私字段，列表本身一致），跨用户共享安全
   */
  async recList(keyword: string, pageNo: number, opts: { pageSize?: number } = {}): Promise<LabrRecListResponse> {
    const pageSize = opts.pageSize ?? 100;
    const key = `labr:rec:${keyword}:${pageNo}:${pageSize}`;
    const cached = searchCache.get<LabrRecListResponse>(key);
    if (cached) return cached;
    const session = await this.tryGetSession(this.db);
    const result = await this.client.recList(keyword, pageNo, { pageSize, session: session ?? undefined });
    searchCache.set(key, result);
    return result;
  }

  /**
   * page=1 优化路径：并行调 searchInline + recList(pageNo=2)，merge 并按 did 去重。
   *
   * 背景：labr 上游契约把首屏 SSR ≤4 条（dataList）和翻页 API（rec-list pageNo=2 起）拆开。
   * 旧 page=1 只走 searchInline → 用户首屏只能看 ≤4 条,体验差。
   *
   * 新策略：page=1 并行拉两路,总耗时 ≈ max(inline 800ms, rec-list 800ms) = 800ms,
   * 而结果集是 4 + 100 = 最多 104 条(dedup 后),首屏一次到位。
   *
   * 缓存：两个内部方法各自走 searchCache,所以本方法不再单独 cache（避免双层 TTL）。
   */
  async searchPage1(keyword: string, opts: { pageSize?: number } = {}): Promise<LabrRecListResponse> {
    const pageSize = opts.pageSize ?? 100;
    // 并行,允许 inline 失败不致命（最差也有 rec-list 100 条；rec-list 失败抛错）
    const [inlineResult, recResult] = await Promise.all([
      this.searchInline(keyword).catch((e) => {
        console.warn('[labr-service] searchInline soft fail:', e instanceof Error ? e.message : String(e));
        return [] as LabrListItem[];
      }),
      this.recList(keyword, 2, { pageSize }),
    ]);

    // dedup by did,inline 在前（SSR 通常是最相关的几条,优先展示）
    const seen = new Set<number>();
    const merged: LabrListItem[] = [];
    for (const it of inlineResult) {
      if (it.did && !seen.has(it.did)) {
        seen.add(it.did);
        merged.push(it);
      }
    }
    for (const it of recResult.list) {
      if (it.did && !seen.has(it.did)) {
        seen.add(it.did);
        merged.push(it);
      }
    }

    return {
      total: recResult.total,        // 用 rec-list 返的 total（全集）
      pageSize: recResult.pageSize,
      pageCount: recResult.pageCount,
      list: merged,
    };
  }

  async getDetail(did: number): Promise<{ info: LabrInfo; detail: LabrDetail }> {
    const session = await this.tryGetSession(this.db);
    return this.client.getDetail(did, { session: session ?? undefined });
  }

  /** 不请求上游，只返回配置和最近登录状态，供设置页安全展示。 */
  getHealth(): { configured: boolean; lastLoginAt: string | null; sessionExpiresAt: number | null; sessionActive: boolean } {
    const expiresAt = Number(getSetting(this.db, KEY_TOKEN_EXP) || 0) || null;
    return {
      configured: Boolean(process.env.LABR_USERNAME?.trim() && process.env.LABR_PASSWORD?.trim()),
      lastLoginAt: getSetting(this.db, KEY_LAST_LOGIN) || null,
      sessionExpiresAt: expiresAt,
      sessionActive: Boolean(expiresAt && expiresAt - REFRESH_LEAD_MS > Date.now()),
    };
  }

  /** 软 session 取：拿不到也不抛错（用于匿名优先的查询路径） */
  private async tryGetSession(db: Database.Database): Promise<LabrSession | null> {
    try { return await this.getSession(db); }
    catch (e) {
      console.warn('[labr-service] getSession soft fail:', e instanceof Error ? e.message : String(e));
      return null;
    }
  }

  // ─── 下载 ────────────────────────────────────────────────────────────

  /**
   * 单条下载。会做 kind 分支 + temp-url 缓存 + auth retry，但不做"批量限速 short-circuit"，
   * 那是 batchDownload 的事。
   */
  async download(did: number): Promise<LabrDownloadResult> {
    const sem = getSourceSemaphore('labr');
    return sem.run(() => this.downloadInner(did, { batchState: null }));
  }

  /**
   * 批量下载。
   *
   * - 顺序按 items 顺序，单条并发由 labr semaphore（默认 2）控制
   * - 撞 LabrRateLimitError → batchState.rateLimited=true，后续 kind=1 直接短路返回失败
   *   （但成功项仍保留 result）；kind=0 不受影响
   * - 任何条目失败都记入 results，不中断整体
   */
  async batchDownload(items: Array<{ did: number }>): Promise<LabrBatchItemResult[]> {
    const sem = getSourceSemaphore('labr');
    const batchState: BatchState = { rateLimited: false };
    const results: LabrBatchItemResult[] = new Array(items.length);
    await Promise.all(items.map(async (it, idx) => {
      try {
        const result = await sem.run(() => this.downloadInner(it.did, { batchState }));
        results[idx] = { did: it.did, ok: true, result };
      } catch (e) {
        results[idx] = {
          did: it.did,
          ok: false,
          error: {
            code: e instanceof LabrRateLimitError ? 'LABR_RATE_LIMIT'
              : e instanceof LabrAuthError ? 'LABR_AUTH'
                : (e as any)?.code || 'LABR_DOWNLOAD_FAILED',
            message: e instanceof Error ? e.message : String(e),
          },
        };
      }
    }));
    return results;
  }

  /**
   * 核心下载流。kind=0 直拉；kind=1 缓存 → preview2 → 缓存写回；都用 addFileToLibrary 入库。
   */
  private async downloadInner(
    did: number,
    ctx: { batchState: BatchState | null },
  ): Promise<LabrDownloadResult> {
    const session = await this.tryGetSession(this.db);
    const { info, detail } = await this.client.getDetail(did, { session: session ?? undefined });

    const kind = info.kind === 1 ? 1 : 0;
    const ext = (normalizeLabrExt(detail.filetype || detail.ext || info.ext) || 'bin').toLowerCase();

    // batch 已撞限速 → kind=1 直接报错；kind=0 仍可下
    if (ctx.batchState?.rateLimited && kind === 1) {
      throw new LabrRateLimitError('batch 已触发 labr 每日 5 次限速，剩余 kind=1 资源短路');
    }

    let buf: Buffer;
    if (kind === 0) {
      buf = (await this.client.downloadDirect(detail.filepath)).buffer;
    } else {
      buf = await this.fetchKind1(this.db, did, ctx);
    }

    // 防 0KB / 错误页：labr ext 可能是 pdf/doc/docx，只查 size 不查 PDF magic。
    // 抛 UpstreamError 让上层 batch flow 标该 did 为失败，其他 did 继续。
    assertNonEmptyDownload(buf, `labr did=${did} kind=${kind} ext=${ext}`);

    // 临时落盘，再 addFileToLibrary 走统一入库流（rename 而非 copy）
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'labr-'));
    const tmpFile = path.join(tmpDir, `labr-${did}.${ext}`);
    await fs.writeFile(tmpFile, buf);

    // stdCode / cleanTitle / year
    const { stdCode: extractedCode, rest } = extractStdCodeFromTitle(info.title || '');
    const stdCodeRaw = cleanStdCode(extractedCode || '');
    const fallbackCode = stdCodeRaw || `LABR-${did}`;   // title 不像标准号也得允许入库（按 did 兜底）
    const yearMatch = (stdCodeRaw || info.title).match(/-\s*(\d{4})\s*$/);
    const year = yearMatch?.[1] || '';
    const cleanTitle = rest || info.title || '';

    try {
      const r = await addFileToLibrary(this.db, {
        srcPath: tmpFile,
        stdCode: fallbackCode,
        source: 'labr',
        year,
        title: cleanTitle,
        ext,
      });
      return {
        absPath: r.absPath,
        fileName: r.fileName,
        fileId: r.fileId,
        reused: r.reused,
        ext,
        size: buf.length,
        stdCode: stdCodeRaw,
        cleanTitle,
      };
    } finally {
      // tmpFile 可能被 addFileToLibrary rename 走了，rmdir 失败忽略
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => { /* ignore */ });
    }
  }

  /**
   * kind=1 取实文件 buffer：
   *  1. 查 `labr_temp_urls` 缓存（temp/<md5>.pdf 跨 token 仍可拉）
   *  2. 缓存命中 → 试拉；404/403/网络失败 → 落到 step 3
   *  3. preview2 拿新 url（**这里才消耗 labr 5 次/日 配额**）
   *  4. 新 url 写回缓存
   *  5. 拉新 url
   *
   * auth 失效（LabrAuthError）会触发"清 session + 重 login + 重试一次"。
   */
  private async fetchKind1(
    db: Database.Database,
    did: number,
    ctx: { batchState: BatchState | null },
  ): Promise<Buffer> {
    const cached = db.prepare('SELECT url FROM labr_temp_urls WHERE did = ?').get(did) as { url: string } | undefined;
    if (cached?.url) {
      try {
        const r = await this.client.downloadDirect(cached.url);
        if (r.size > 0) return r.buffer;
      } catch (e) {
        // 缓存失效 / 网络错误，落到 preview2 路径
        console.warn(`[labr-service] cached temp url miss did=${did}:`, e instanceof Error ? e.message : String(e));
      }
    }

    // preview2 必须登录
    const url = await this.preview2WithAuthRetry(db, did, ctx);
    db.prepare(`
      INSERT INTO labr_temp_urls (did, url, fetched_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(did) DO UPDATE SET url = excluded.url, fetched_at = excluded.fetched_at
    `).run(did, url);

    const r = await this.client.downloadDirect(url);
    if (r.size === 0) throw new UpstreamError(`labr preview2 url 返回空响应 did=${did}`);
    return r.buffer;
  }

  private async preview2WithAuthRetry(
    db: Database.Database,
    did: number,
    ctx: { batchState: BatchState | null },
  ): Promise<string> {
    let session = await this.getSession(db);
    try {
      const r = await this.client.preview2(did, session);
      return r.url;
    } catch (e) {
      if (e instanceof LabrRateLimitError) {
        if (ctx.batchState) ctx.batchState.rateLimited = true;
        throw e;
      }
      if (e instanceof LabrAuthError) {
        this.invalidateSession(db);
        session = await this.getSession(db);
        const r = await this.client.preview2(did, session);  // 第二次仍抛错就让它冒出去
        return r.url;
      }
      throw e;
    }
  }
}

interface BatchState {
  rateLimited: boolean;
}

// ─── 单例（与 by-adapter 风格一致） ────────────────────────────────────

let _instance: LabrService | null = null;
export function getLabrService(): LabrService {
  if (!_instance) _instance = new LabrService(getDb());
  return _instance;
}

/** 测试用：注入 mock client；prod 不调 */
export function _resetLabrService(svc: LabrService | null): void {
  _instance = svc;
}
