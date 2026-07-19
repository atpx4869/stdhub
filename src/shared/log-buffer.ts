/**
 * In-memory ring buffer of recent server logs.
 *
 * We intercept console.warn / console.error / console.log on import. The
 * originals are still called so anyone with a real console still sees output.
 *
 * 按天追加落地到 data/logs/app-YYYYMMDD.log，进程重启后仍能在磁盘查历史。
 * 落地全程 best-effort：任何 I/O 失败都静默吞掉。
 */

import * as fs from 'fs';
import * as path from 'path';

const MAX_ENTRIES = 500;
const LOG_RETENTION_DAYS = 14; // 按天文件保留天数（超期清理）

// 前端「运行日志」页用的模块分类（与前端 LOG_MODULES 对齐）。
export type LogModule = 'search' | 'download' | 'complete' | 'qual' | 'ocr' | 'local' | 'system';

export interface LogEntry {
  ts: string;
  level: 'log' | 'warn' | 'error';
  message: string;
  module: LogModule;
}

const buffer: LogEntry[] = [];

// 按消息里的 [前缀] / 关键词把后端日志归到前端同一套模块分类。
// 前缀来自现有 console 日志：[ocr-worker] [by-adapter] [gbw] [labr-service]
// [resolver] [cnas] [library] [library-watcher] [db] [db-backup] [env] [bzxz] 等。
function inferModule(message: string): LogModule {
  const m = message.toLowerCase();
  if (/\bocr-worker\b|验证码|\bocr\b/.test(m)) return 'ocr';
  if (/\bresolver\b|search|搜索|anti-bot/.test(m)) return 'search';
  if (/\bgbw\b|\bby-adapter\b|\bpreview-task\b|download|下载|pdf-merge/.test(m)) return 'download';
  if (/补全|complete/.test(m)) return 'complete';
  if (/\bcnas\b|\bcma\b|\blabr|资质|qualif|同步|sync/.test(m)) return 'qual';
  if (/\blibrary\b|library-watcher|扫描|文件库/.test(m)) return 'local';
  return 'system';
}

// ── 按天文件落地（best-effort，失败静默）──────────────────────────────
function logDir(): string {
  return path.join(process.cwd(), 'data', 'logs');
}
let cleanedOnce = false;
function cleanupOldLogs(dir: string): void {
  if (cleanedOnce) return;
  cleanedOnce = true;
  fs.readdir(dir, (err, files) => {
    if (err) return;
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 864e5;
    for (const f of files) {
      const m = /^app-(\d{4})(\d{2})(\d{2})\.log$/.exec(f);
      if (!m) continue;
      const t = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`).getTime();
      if (t < cutoff) fs.unlink(path.join(dir, f), () => { /* 忽略 */ });
    }
  });
}
function appendToFile(entry: LogEntry): void {
  // 测试必须与项目真实 data/ 完全隔离；Vitest 会设置 NODE_ENV=test / VITEST。
  // 也允许嵌入环境通过显式开关禁用磁盘日志，但内存 ring buffer 和原始 console 保持可用。
  if (process.env.NODE_ENV === 'test' || process.env.VITEST || process.env.STDHUB_DISABLE_DISK_LOGS === '1') return;
  const dir = logDir();
  try {
    const d = new Date(entry.ts);
    const p = (n: number) => String(n).padStart(2, '0');
    const file = path.join(dir, `app-${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}.log`);
    const line = `${entry.ts}\t${entry.level}\t${entry.module}\t${entry.message.replace(/\r?\n/g, '\\n')}\n`;
    fs.mkdir(dir, { recursive: true }, (mkErr) => {
      if (mkErr) return; // 建目录失败：静默放弃本条落地
      fs.appendFile(file, line, () => { /* 写失败静默 */ });
      cleanupOldLogs(dir);
    });
  } catch { /* 任何异常都不影响 console / 业务 */ }
}

function push(level: LogEntry['level'], args: unknown[]): void {
  const message = args
    .map((a) => {
      if (typeof a === 'string') return a;
      if (a instanceof Error) return a.stack || a.message;
      try { return JSON.stringify(a); } catch { return String(a); }
    })
    .join(' ');
  const entry: LogEntry = { ts: new Date().toISOString(), level, message, module: inferModule(message) };
  buffer.push(entry);
  if (buffer.length > MAX_ENTRIES) buffer.shift();
  appendToFile(entry);
}

const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

console.log = (...args: unknown[]) => { push('log', args); originalLog(...args as []); };
console.warn = (...args: unknown[]) => { push('warn', args); originalWarn(...args as []); };
console.error = (...args: unknown[]) => { push('error', args); originalError(...args as []); };

export function getRecentLogs(limit = 200): LogEntry[] {
  if (limit >= buffer.length) return buffer.slice();
  return buffer.slice(buffer.length - limit);
}
