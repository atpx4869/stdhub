/**
 * Environment self-check. Runs once at server startup, fire-and-forget. Results
 * are cached in memory and exposed via /api/diagnostics/environment so the user
 * can see at a glance which dependencies are healthy.
 *
 * Checks:
 *   - OCR worker boot (python + ddddocr import succeed and worker reaches READY)
 *   - GBW upstream reachable (openstd.samr.gov.cn)
 *   - BZ upstream reachable (bz.gxzl.org.cn)
 *   - BY internal network reachable (172.16.100.72:8080) — expected to fail outside LAN
 */
import { warmupOcr, getOcrStatus } from '../sources/shared/captcha-ocr';
import { pooledFetch } from '../shared/http';

export interface CheckResult {
  name: string;
  label: string;
  /** 'ok' / 'fail' / 'pending' (still running) / 'skip' (not applicable in this env) */
  status: 'ok' | 'fail' | 'pending' | 'skip';
  /** Latency in ms when status === 'ok'. */
  ms?: number;
  /** Short human-readable detail. For failures: the error reason. */
  detail?: string;
  /** When the check last ran (ISO). */
  checkedAt?: string;
}

export interface EnvironmentReport {
  startedAt: string;
  finishedAt: string | null;
  checks: Record<string, CheckResult>;
}

const report: EnvironmentReport = {
  startedAt: new Date().toISOString(),
  finishedAt: null,
  checks: {
    ocr:  { name: 'ocr',  label: 'OCR 引擎 (ddddocr)',         status: 'pending' },
    gbw:  { name: 'gbw',  label: 'BW 国标网 (openstd.samr.gov.cn)', status: 'pending' },
    bz:   { name: 'bz',   label: 'BZ 标准在线 (bz.gxzl.org.cn)',     status: 'pending' },
    by:   { name: 'by',   label: 'BY 内网 (172.16.100.72)',          status: 'pending' },
  },
};

function setCheck(name: string, patch: Omit<CheckResult, 'name' | 'label'>): void {
  const prev = report.checks[name];
  if (!prev) return;
  report.checks[name] = {
    ...prev,
    ...patch,
    checkedAt: new Date().toISOString(),
  };
}

async function timed<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = Date.now();
  const result = await fn();
  return { result, ms: Date.now() - t0 };
}

async function checkHttp(url: string, timeoutMs = 5000): Promise<{ ok: boolean; ms: number; detail: string }> {
  try {
    const { result: resp, ms } = await timed(() =>
      pooledFetch(url, {
        method: 'GET',
        timeoutMs,
        retries: 1,
        redirect: 'manual',
      }),
    );
    // Anything that didn't time out counts as "reachable". 3xx/4xx still means
    // the server answered — only 5xx or network errors are real failures.
    if (resp.status >= 500) {
      return { ok: false, ms, detail: `HTTP ${resp.status}` };
    }
    return { ok: true, ms, detail: `HTTP ${resp.status}` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, ms: 0, detail: msg };
  }
}

async function runOcrCheck(): Promise<void> {
  try {
    const t0 = Date.now();
    await warmupOcr();
    const status = getOcrStatus();
    const ms = Date.now() - t0;
    if (status.engine === 'ddddocr') {
      setCheck('ocr', { status: 'ok', ms, detail: `worker ready (pid=${status.workerPid ?? '?'}, python=${status.pythonCommand ?? '?'})` });
    } else {
      setCheck('ocr', {
        status: 'fail',
        detail: status.lastError ?? `engine=${status.engine}`,
      });
    }
  } catch (err) {
    setCheck('ocr', {
      status: 'fail',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function runGbwCheck(): Promise<void> {
  const { ok, ms, detail } = await checkHttp('https://openstd.samr.gov.cn/bzgk/std/');
  setCheck('gbw', { status: ok ? 'ok' : 'fail', ms, detail });
}

async function runBzCheck(): Promise<void> {
  const { ok, ms, detail } = await checkHttp('https://bz.gxzl.org.cn/');
  setCheck('bz', { status: ok ? 'ok' : 'fail', ms, detail });
}

async function runByCheck(): Promise<void> {
  const { ok, ms, detail } = await checkHttp('http://172.16.100.72:8080/', 3000);
  // BY only works on the internal corporate network. Report as 'skip' on
  // failure so the UI doesn't scare external users.
  if (!ok) {
    setCheck('by', { status: 'skip', detail: `LAN only — ${detail}` });
    return;
  }
  setCheck('by', { status: 'ok', ms, detail });
}

let running: Promise<void> | null = null;

/**
 * Kick off the self-check. Idempotent: callers can invoke this at startup and
 * the page-load endpoint without re-running the heavy probes. Returns the same
 * Promise while a run is in flight.
 */
export function runEnvironmentCheck(): Promise<void> {
  if (running) return running;
  running = (async () => {
    await Promise.all([runOcrCheck(), runGbwCheck(), runBzCheck(), runByCheck()]);
    report.finishedAt = new Date().toISOString();
  })().finally(() => { running = null; });
  return running;
}

export function getEnvironmentReport(): EnvironmentReport {
  return {
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    checks: { ...report.checks },
  };
}
