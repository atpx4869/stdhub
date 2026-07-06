/**
 * labr.cc HTTP 客户端 —— 协议层（无 token 持久化、无编排）。
 *
 * 跟 BZ/GBW/BY adapter 不同：labr 不实现 SourceAdapter（kind=0/1 双路径、Cookie auth、
 * 5次/日 Bearer 限速、多文件类型，跟"单 stdCode → 单 PDF"契约对不上）。本文件只暴露
 * 原始 HTTP 操作，token 持久化和限速退避在 labr-service.ts (#54) 编排。
 *
 * 关键协议事实（来自 probe-labr-result.md）：
 * - 登录端点是 uc.labr.cc/v1/site/login，不是 www；query string 必须带 ut_module=v1
 * - 拿到 token (40 字符不透明字符串、约 1 年) 后必须再调 www.labr.cc/site/auto-login.html
 *   触发 Set-Cookie: ssoToken=<token>; Domain=.labr.cc; HttpOnly。两条子域共享一份 cookie
 * - 鉴权用 Cookie ssoToken=（无日额度）而非 Authorization: Bearer（触发 5 次/日 限免下载）
 * - 下载分支按 info.kind：
 *   - kind=0：detail.filepath 是 `filesystem/{frontend,backend}/...`，匿名直拉
 *   - kind=1：detail.filepath 是 `downloads/YYYYMMDD/...` 占位 404；必须登录调 preview2
 *     拿 `data.url` (= `temp/<md5>.pdf`)，那个 URL 本身匿名可拉
 * - rec-list pageSize 上游接受 100/500 无上限；首屏 list.html 内联 ≤4 条 dataList
 * - 错误处理：HTTP 200 但 body.code≠200 也是失败（labr 后端是 PHP，错误暴露原文）
 */

import { UpstreamError } from '../../shared/errors';
import { pooledFetch } from '../../shared/http';

const LABR_WWW = 'https://www.labr.cc';
const LABR_UC = 'https://uc.labr.cc';

/** 登录失败 / token 被拒。labr-service 拿到这个会清缓存并重新登录。 */
export class LabrAuthError extends UpstreamError {
  constructor(message: string, details?: unknown) {
    super(`labr auth: ${message}`, details);
    this.name = 'LabrAuthError';
  }
}

/** preview2 撞 "每日 5 次限免下载" 上限。labr-service 拿到这个会让整批 kind=1 短路。 */
export class LabrRateLimitError extends UpstreamError {
  constructor(message: string, details?: unknown) {
    super(`labr rate limit: ${message}`, details);
    this.name = 'LabrRateLimitError';
  }
}

// ─── 协议类型 ──────────────────────────────────────────────────────────────

export interface LabrLoginResponse {
  /** 40 字符不透明字符串（疑似 SHA-1，不是 JWT）。同时存在 access_token / token 两份，值一样 */
  token: string;
  /** refresh_token，刷新端点本次未探测，暂保留字段供 #54 用 */
  refreshToken: string;
  /** 秒数。实测 31536000 = 365 天 */
  expiresIn: number;
}

/** rec-list / dataList 共有字段；rec-list 额外字段（source/abstract/audit_*）暂未消费，留 meta */
export interface LabrListItem {
  did: number;
  uid: number;
  username: string;
  truename: string;
  title: string;
  pubdt: string;
  views: number;
  /** list 层简化扩展名：pdf / doc(含 docx) / pptx / xsxl(=xlsx). 不权威，看 detail.filetype */
  ext: string;
  is_free: 0 | 1;
  price: number;
  /** **关键判别字段**：0 = filesystem 真路径直拉；1 = downloads 假路径，必须走 preview2 */
  kind: 0 | 1;
  /** /document/detail/{did}.html */
  url: string;
  /** 含 <font color=red> / <mark> 高亮的标题 */
  hl_title?: string;
  /** rec-list 多出来的字段一并保留，labr-service 想用什么自己挑 */
  meta?: Record<string, unknown>;
}

export interface LabrInfo extends LabrListItem {
  source_type?: string;
  source_std_id?: number;
}

export interface LabrDetail {
  ddid: number;
  did: number;
  /** 注：所有资源 detail.kind === 10，无区分意义。info.kind 才是路由依据 */
  kind: 10;
  filename: string;
  /** kind=0 → `filesystem/frontend/...` 或 `filesystem/backend/...` 真路径
   *  kind=1 → `downloads/YYYYMMDD/...` 假路径（404，必须走 preview2） */
  filepath: string;
  /** 权威 mime 字段：pdf / docx / xlsx / pptx ... */
  filetype: string;
  /** 不可靠（实测多见 0），不要依赖来判长度 */
  filesize: number;
  downloads: number;
  ext: string;
}

export interface LabrPreview2Response {
  /** 完整 URL，形如 https://www.labr.cc/temp/<md5>.pdf */
  url: string;
  /** 相对路径，形如 temp/<md5>.pdf。# 52 的 labr_temp_urls 表存这个值的完整 URL */
  filepath2: string;
}

export interface LabrRecListResponse {
  total: number;
  pageSize: number;
  pageCount: number;
  list: LabrListItem[];
}

// ─── 内部解析工具 ─────────────────────────────────────────────────────────

/**
 * 从 SSR 内联脚本里抽 `state.<key> = JSON.parse(JSON.stringify(<JSON>))` 的 JSON 实参。
 *
 * labr 主站把首屏数据这样塞进 Vue reactive state，无独立 API 拿，必须 scrape。
 * 用正则锚定 `state.<key> = JSON.parse(JSON.stringify(` ... `))`，再用括号配平
 * 抽出参数 JSON。带括号配平因为 JSON 里方括号 / 引号会让朴素 `.+?\)` 误配。
 */
export function extractStateJson(html: string, key: string): unknown | null {
  const needle = `state.${key} = JSON.parse(JSON.stringify(`;
  const start = html.indexOf(needle);
  if (start < 0) return null;
  const jsonStart = start + needle.length;
  // 括号 + 字符串配平：从 jsonStart 开始扫，遇到 ' / " / `（labr 不太可能用反引号但兜底）跳过其内容
  let depth = 1;
  let i = jsonStart;
  let inStr: '"' | "'" | null = null;
  let escape = false;
  while (i < html.length) {
    const c = html[i];
    if (escape) { escape = false; i++; continue; }
    if (inStr) {
      if (c === '\\') { escape = true; }
      else if (c === inStr) { inStr = null; }
      i++;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c as '"' | "'"; i++; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) break;
    }
    i++;
  }
  if (depth !== 0) return null;
  const raw = html.slice(jsonStart, i);
  try { return JSON.parse(raw); } catch { return null; }
}

/** labr 自己拼错了 xlsx → xsxl，统一掉。其它已知 ext 暂不需要别名。 */
export function normalizeLabrExt(ext: string): string {
  if (!ext) return '';
  if (ext === 'xsxl') return 'xlsx';
  return ext.toLowerCase();
}

const STD_CODE_FROM_TITLE_RE =
  /^([A-Z][A-Z0-9]*(?:\/[A-Z][A-Z0-9]*)?\s+\d+(?:\.\d+)*(?:\s*-\s*\d{4}[A-Z]?)?)(?=[|｜:：\s]|[一-鿿]|$)/;

/**
 * labr title 形如 "GB/T 3324-2017|木家具通用技术条件" 或 "GB 46035-2025|橡胶塑料机械  通用安全要求"
 * 抽出 stdCode + 剩余 title。无独立 std_code 字段，必须从 title 抠。
 *
 * 与 library-index.ts 的 STD_CODE_HEAD_RE 复用同一形态正则（A-Z 前缀 / 可选 /T / 数字 / 可选年），
 * 区别在分隔符识别：labr 部分 title 形如 `GB/T 35607-2024绿色产品评价 家具`（标准号直接连中文，
 * 无 `|` / `:` / 空白），所以分隔符用 lookahead，允许 `|｜:：` / 空白 / 中文（U+4E00-U+9FFF）/ 末尾。
 * 不消费分隔符 → rest 从 m[1].length 切，再 trim 去掉前导空白（中文直接相邻则无空白可去）。
 */
export function extractStdCodeFromTitle(title: string): { stdCode: string; rest: string } {
  const m = title.match(STD_CODE_FROM_TITLE_RE);
  if (!m) return { stdCode: '', rest: title };
  let rest = title.slice(m[1].length);
  // 跳过紧随其后的分隔符（| ｜ : ：）和空白；中文字符不跳（属于内容起始）
  rest = rest.replace(/^[|｜:：\s]+/, '').trim();
  return { stdCode: m[1].trim(), rest };
}

// ─── 客户端 ────────────────────────────────────────────────────────────────

/**
 * 协议层。所有方法 stateless：调用方在 LabrSession 里维护 token，传给 *(_session)* 后缀的方法。
 * 持久化、缓存、限速退避在 labr-service (#54)。
 */
export class LabrClient {
  /**
   * POST uc.labr.cc/v1/site/login?ut_module=v1
   *
   * 字段：username 接手机号或用户名；password 明文；verificationCode 滑动码（账密登录留空）；
   * openid 微信走的；webflg 固定 1。返回 access_token == token == 40 字符不透明。
   */
  async login(username: string, password: string): Promise<LabrLoginResponse> {
    const resp = await pooledFetch(`${LABR_UC}/v1/site/login?ut_module=v1`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Origin': LABR_UC,
      },
      body: JSON.stringify({ username, password, verificationCode: '', openid: '', webflg: 1 }),
      timeoutMs: 15_000,
    });
    const body: any = await resp.json().catch(() => null);
    if (!body || body.code !== 200) {
      throw new LabrAuthError(body?.message || `login HTTP ${resp.status}`);
    }
    const token: string | undefined = body.data?.access_token || body.data?.token;
    if (!token) {
      throw new LabrAuthError('login response missing access_token');
    }
    return {
      token,
      refreshToken: body.data?.refresh_token || '',
      expiresIn: Number(body.data?.expires_in) || 0,
    };
  }

  /**
   * GET www.labr.cc/site/auto-login.html?token=<token>
   *
   * SSO 桥：触发 Set-Cookie: ssoToken=<token>; Domain=.labr.cc; HttpOnly。
   * 我们不靠浏览器 cookie jar，后续请求每次显式发 `Cookie: ssoToken=<token>` header；
   * 本调用主要是让 token 服务端"注册"成 sso 会话，确保 www 子域接受。
   *
   * 实测：即使不调 auto-login 直接 ssoToken cookie 也能用（token 自带 sso 能力）。
   * 但探测者建议接入时统一调一次，避免边缘情况站点检测 cookie 状态。
   */
  async bridgeSso(token: string): Promise<void> {
    const resp = await pooledFetch(
      `${LABR_WWW}/site/auto-login.html?token=${encodeURIComponent(token)}`,
      { method: 'GET', timeoutMs: 15_000, redirect: 'manual' },
    );
    // 接受 200 / 302 / 303 任何 < 400 状态；服务端可能 redirect 到首页
    if (resp.status >= 400) {
      throw new LabrAuthError(`auto-login HTTP ${resp.status}`);
    }
  }

  /**
   * GET www.labr.cc/document/list.html?keyword=...
   *
   * 抓首屏 SSR 内联 `state.dataList`（≤4 条）。labr 没把这部分暴露成 API，只能 scrape。
   * 该数据 anonymous 即可拿，无需登录。
   */
  async searchInline(keyword: string): Promise<LabrListItem[]> {
    const resp = await pooledFetch(
      `${LABR_WWW}/document/list.html?keyword=${encodeURIComponent(keyword)}`,
      { method: 'GET', timeoutMs: 15_000 },
    );
    if (!resp.ok) throw new UpstreamError(`labr list.html HTTP ${resp.status}`);
    const html = await resp.text();
    const dataList = extractStateJson(html, 'dataList');
    if (!Array.isArray(dataList)) return [];
    return dataList.map((it: any) => this.normalizeListItem(it));
  }

  /**
   * GET www.labr.cc/document/rec-list.html?pageNo=2&keyword=...&pageSize=100
   *
   * 翻页接口。注意 pageNo=1 在前端语义里是"首屏后第一页"，常返回空（首屏已展示）；
   * **实际从 pageNo=2 开始翻**。pageSize 上游接受 100 / 500 无上限，默认 20 太慢。
   * tagids 留空字符串即可（labr 前端固定传）。
   */
  async recList(
    keyword: string,
    pageNo: number,
    opts: { pageSize?: number; category?: number; session?: LabrSession } = {},
  ): Promise<LabrRecListResponse> {
    const { pageSize = 100, category = 0, session } = opts;
    const url =
      `${LABR_WWW}/document/rec-list.html?pageNo=${pageNo}` +
      `&category=${category}` +
      `&keyword=${encodeURIComponent(keyword)}` +
      `&tagids=&pageSize=${pageSize}`;
    const resp = await pooledFetch(url, {
      method: 'GET',
      headers: session ? { Cookie: `ssoToken=${session.token}` } : {},
      timeoutMs: 15_000,
    });
    const body: any = await resp.json().catch(() => null);
    if (!body || body.code !== 200) {
      throw new UpstreamError(`labr rec-list code=${body?.code}: ${body?.message || resp.status}`);
    }
    const list: LabrListItem[] = Array.isArray(body.data?.list)
      ? body.data.list.map((it: any) => this.normalizeListItem(it))
      : [];
    return {
      total: Number(body.data?.total) || 0,
      pageSize: Number(body.data?.pageSize) || pageSize,
      pageCount: Number(body.data?.pageCount) || 0,
      list,
    };
  }

  /**
   * GET www.labr.cc/document/detail/{did}.html
   *
   * 拿 state.info（资料元）+ state.detail（文件元）。匿名也能拉，但带 ssoToken 能拿到
   * 用户私有字段（isFav 等）。本方法不要求 session，UI 显示场景给登录态、批量爬取场景
   * 可以不带。
   */
  async getDetail(
    did: number,
    opts: { session?: LabrSession } = {},
  ): Promise<{ info: LabrInfo; detail: LabrDetail }> {
    const resp = await pooledFetch(
      `${LABR_WWW}/document/detail/${did}.html`,
      {
        method: 'GET',
        headers: opts.session ? { Cookie: `ssoToken=${opts.session.token}` } : {},
        timeoutMs: 15_000,
      },
    );
    if (!resp.ok) throw new UpstreamError(`labr detail HTTP ${resp.status}`);
    const html = await resp.text();
    const info = extractStateJson(html, 'info') as LabrInfo | null;
    const detail = extractStateJson(html, 'detail') as LabrDetail | null;
    if (!info || !detail) {
      throw new UpstreamError(`labr detail ${did}: missing state.info or state.detail`);
    }
    return { info, detail };
  }

  /**
   * GET www.labr.cc/document/preview2.html?did=...&pageNo=1&category=0
   *
   * **登录必需**（不登录 → code:400, "请先注册！"）。返回 `data.url` 是 `temp/<md5>.pdf`
   * 形态的临时 URL，但该 URL 本身完全匿名可拉。每次调用都生成新 md5（旧 hash 跨 token 仍可拉）。
   *
   * **限速**：撞 5 次/日 → body.code=400/500，message 含 "每日限定免费下载 5 次"；
   * 我们识别后抛 LabrRateLimitError，让 labr-service short-circuit 后续 kind=1 调用。
   */
  async preview2(did: number, session: LabrSession): Promise<LabrPreview2Response> {
    const resp = await pooledFetch(
      `${LABR_WWW}/document/preview2.html?did=${did}&pageNo=1&category=0`,
      {
        method: 'GET',
        headers: { Cookie: `ssoToken=${session.token}` },
        timeoutMs: 15_000,
      },
    );
    const body: any = await resp.json().catch(() => null);
    if (!body) throw new UpstreamError(`labr preview2 ${did}: non-JSON response`);
    if (body.code !== 200) {
      const msg = String(body.message || '');
      // labr "每日限定免费下载 5 次，已达上限，请明日再操作！" — 关键词命中即认作限速
      if (msg.includes('每日') || msg.includes('上限') || msg.includes('限定')) {
        throw new LabrRateLimitError(msg);
      }
      // 未登录 / token 失效 → code=400, "请先注册！"
      if (msg.includes('注册') || msg.includes('登录') || msg.includes('未登录')) {
        throw new LabrAuthError(msg);
      }
      throw new UpstreamError(`labr preview2 code=${body.code}: ${msg}`);
    }
    const url: string | undefined = body.data?.url;
    const filepath2: string | undefined = body.data?.filepath2;
    if (!url || !filepath2) {
      throw new UpstreamError(`labr preview2 ${did}: missing data.url / filepath2`);
    }
    return { url, filepath2 };
  }

  /**
   * 匿名拉 `https://www.labr.cc/{filepath}` —— kind=0 直拉路径（filesystem/frontend|backend/...）
   * 与 preview2 返回的 temp/<md5>.pdf 都走这个方法。filepath 字段直接拼即可，包含 `/` 字符
   * 不需要 encode（labr nginx 不挑剔）。
   */
  async downloadDirect(
    filepath: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<{ buffer: Buffer; contentType: string; size: number }> {
    const url = filepath.startsWith('http') ? filepath : `${LABR_WWW}/${filepath.replace(/^\/+/, '')}`;
    const resp = await pooledFetch(url, {
      method: 'GET',
      timeoutMs: 60_000,
      retries: 2,
      signal: opts.signal,
    });
    if (!resp.ok) throw new UpstreamError(`labr file HTTP ${resp.status} for ${url}`);
    const ab = await resp.arrayBuffer();
    return {
      buffer: Buffer.from(ab),
      contentType: resp.headers.get('content-type') || 'application/octet-stream',
      size: ab.byteLength,
    };
  }

  private normalizeListItem(raw: any): LabrListItem {
    // dataList 里 did 是 string，rec-list 里 did 是 number。统一成 number
    const did = typeof raw.did === 'string' ? Number(raw.did) : Number(raw.did) || 0;
    // kind 在 dataList 里可能缺（不强制），rec-list 里必有；缺时默认按 0 走（直拉），
    // labr-service 在调 preview2 前自己再保险检测
    const kind = (raw.kind === 1 ? 1 : 0) as 0 | 1;
    return {
      did,
      uid: Number(raw.uid) || 0,
      username: String(raw.username || ''),
      truename: String(raw.truename || ''),
      title: String(raw.title || ''),
      pubdt: String(raw.pubdt || ''),
      views: Number(raw.views) || 0,
      ext: normalizeLabrExt(String(raw.ext || '')),
      is_free: raw.is_free === 1 ? 1 : 0,
      price: Number(raw.price) || 0,
      kind,
      url: String(raw.url || `/document/detail/${did}.html`),
      hl_title: raw.hl_title ? String(raw.hl_title) : undefined,
      meta: {
        source: raw.source,
        abstract: raw.abstract,
        author: raw.author,
        source_type: raw.source_type,
        source_std_id: raw.source_std_id,
        send_integral: raw.send_integral,
        audit_truename: raw.audit_truename,
      },
    };
  }
}

/** 调用方持有，传给需要登录的方法。token 持久化在 labr-service。 */
export interface LabrSession {
  /** 40 字符不透明字符串，发请求时塞进 `Cookie: ssoToken=<token>` */
  token: string;
  /** epoch ms。labr-service 自己判过期，client 不查 */
  expiresAt: number;
}
