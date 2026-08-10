// Shared HTTP agent with connection pooling
import { Agent, setGlobalDispatcher } from 'undici';

// Reuse TCP/TLS connections across all fetch calls
// No proxy — direct connection only (bypass Clash / system proxy)
// connections / pipelining 都是 *每个 origin* 的额度（undici Agent 内部按 origin
// 维护独立 Pool），bump 到 32 是为多用户场景兜底：BZ 单次导出能并发 12 路下载页面，
// 4-6 个用户同时导出就吃满 16 路，新请求排队明显。32 仍远低于上游服务器的限流。
export const httpAgent = new Agent({
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000,
  connections: 32,
  // Allow up to 4 in-flight requests per connection. GBW IIS handles this fine
  // and it lets us absorb burst of captcha+verify+view requests without
  // opening 4 new TCP sockets.
  pipelining: 4,
});

// Force global undici dispatcher to use direct Agent (no proxy)
setGlobalDispatcher(httpAgent);

const headers = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
};

export interface FetchWithTimeoutOptions extends RequestInit {
  timeoutMs?: number;
  retries?: number;
  retryDelayMs?: number;
  /** 覆盖全局 httpAgent 的 undici Dispatcher（如 frp 隧道用无 keep-alive Agent） */
  dispatcher?: unknown;
}

// ─── Per-host latency profiler ───────────────────────────────────────────────
// Records min / max / mean latency per origin so the diagnostics endpoint can
// surface "GBW is the bottleneck" without users having to read raw logs.
export interface HostStats {
  count: number;
  totalMs: number;
  maxMs: number;
  minMs: number;
  lastMs: number;
  errors: number;
}
const hostStats = new Map<string, HostStats>();

function recordHost(url: string, ms: number, error: boolean): void {
  let host = '';
  try { host = new URL(url).host; } catch { host = '?'; }
  let s = hostStats.get(host);
  if (!s) {
    s = { count: 0, totalMs: 0, maxMs: 0, minMs: Number.POSITIVE_INFINITY, lastMs: 0, errors: 0 };
    hostStats.set(host, s);
  }
  s.count += 1;
  s.totalMs += ms;
  s.maxMs = Math.max(s.maxMs, ms);
  s.minMs = Math.min(s.minMs, ms);
  s.lastMs = ms;
  if (error) s.errors += 1;
}

export function getHostStats(): Record<string, HostStats & { avgMs: number }> {
  const out: Record<string, HostStats & { avgMs: number }> = {};
  for (const [host, s] of hostStats) {
    out[host] = {
      ...s,
      minMs: s.minMs === Number.POSITIVE_INFINITY ? 0 : s.minMs,
      avgMs: s.count === 0 ? 0 : Math.round(s.totalMs / s.count),
    };
  }
  return out;
}

export async function fetchWithTimeoutAndRetry(url: string, init: FetchWithTimeoutOptions = {}): Promise<Response> {
  const { timeoutMs = 15_000, retries = 3, retryDelayMs = 1_000, signal, ...requestInit } = init;  const maxRetries = Math.max(1, retries);
  let lastError: Error | undefined;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs);
    const abortFromParent = () => ctrl.abort(signal?.reason);
    if (signal) {
      if (signal.aborted) ctrl.abort(signal.reason);
      else signal.addEventListener('abort', abortFromParent, { once: true });
    }

    const t0 = Date.now();
    try {
      const resp = await fetch(url, {
        ...requestInit,
        headers: { ...headers, ...requestInit.headers },
        signal: ctrl.signal,
        // @ts-ignore
        dispatcher: requestInit.dispatcher ?? httpAgent,
      });
      recordHost(url, Date.now() - t0, false);
      if (resp.ok || resp.status < 500) return resp;
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, retryDelayMs * (attempt + 1)));
        continue;
      }
      return resp;
    } catch (e) {
      recordHost(url, Date.now() - t0, true);
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, retryDelayMs * (attempt + 1)));
      }
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortFromParent);
    }
  }
  throw lastError ?? new Error('fetchWithTimeoutAndRetry: all retries failed');
}

export async function pooledFetch(url: string, init?: FetchWithTimeoutOptions): Promise<Response> {
  return fetchWithTimeoutAndRetry(url, init);
}

/**
 * 独立的近无 keep-alive Agent（连接空闲 ~1ms 即关闭，下次请求必新建 TCP 连接）。
 * 用于 frp/SSH 隧道这类"上游连接随时可能被远端静默关闭"的场景：
 * undici 默认 keep-alive 会复用已被隧道端关闭的连接 → 抛 fetch failed
 * （Undici 不知情，连接看似健康实则已断）。极短保活让连接用完即关，
 * 隧道下稳定。注意 undici 不接受 keepAliveTimeout: 0（抛 UND_ERR_INVALID_ARG），
 * 用 1ms 替代。代价是少一次 RTT 复用。
 * 通过 pooledFetch(url, { dispatcher: createFreshAgent() }) 传入。
 */
export function createFreshAgent(options: { connections?: number } = {}): Agent {
  return new Agent({
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
    connections: options.connections ?? 8,
    pipelining: 1,
  });
}
