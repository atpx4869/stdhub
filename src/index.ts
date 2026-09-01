// 加载 .env.local 必须最先：让源 adapter import 时已能读到 LABR_* 等凭据
import { loadDotEnvLocal } from './shared/env-loader';
loadDotEnvLocal();

// Install console interceptor as early as possible so the diagnostics endpoint
// sees every warning produced at startup (OCR worker boot, source registry, …).
import './shared/log-buffer';

import { createServer } from 'node:http';

import { createApp } from './api/app';
import { ensureDataDirs } from './shared/fs';
import { checkOpenAdminBoundary } from './shared/open-admin';

// 未捕获异常后进程状态可能已不一致。记录错误后进入由 main() 安装的受控关闭流程，
// 最终交给 Docker/systemd 的 restart policy 拉起，而不是带病继续提供服务。
let fatalShutdown: ((reason: string) => void) | null = null;
let fatalExitScheduled = false;

function scheduleFatalExit(reason: string, error: unknown): void {
  console.error(`[stdhub] ${reason}:`, error);
  if (fatalExitScheduled) return;
  fatalExitScheduled = true;
  process.exitCode = 1;
  if (fatalShutdown) {
    fatalShutdown(reason);
    return;
  }
  setTimeout(() => process.exit(1), 100).unref?.();
}

process.on('unhandledRejection', (reason) => scheduleFatalExit('unhandledRejection', reason));
process.on('uncaughtException', (error) => scheduleFatalExit('uncaughtException', error));

function resolveBindHost(): string {
  const host = (process.env.STDHUB_BIND_HOST || process.env.HOST || '127.0.0.1').trim();
  return host || '127.0.0.1';
}

async function listenWithFallback(server: ReturnType<typeof createServer>, preferred: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onListening = () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : preferred;
      server.off('error', onError);
      resolve(port);
    };
    const onError = (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE' && preferred !== 0) {
        console.warn(`[stdhub] port ${preferred} in use, falling back to a random port`);
        server.off('listening', onListening);
        server.listen(0, host);
        server.once('listening', () => {
          const addr = server.address();
          resolve(typeof addr === 'object' && addr ? addr.port : 0);
        });
        server.once('error', reject);
        return;
      }
      reject(err);
    };
    server.once('listening', onListening);
    server.once('error', onError);
    server.listen(preferred, host);
  });
}

async function main() {
  await ensureDataDirs();

  const app = createApp();
  const preferred = Number(process.env.PORT ?? 3000);
  const host = resolveBindHost();
  checkOpenAdminBoundary(host);
  const server = createServer(app);
  const port = await listenWithFallback(server, preferred, host);
  console.log(`[stdhub] server listening on http://${host}:${port}`);

  let shuttingDown = false;
  const cleanup = async (signal: string, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[stdhub] received ${signal}, shutting down`);
    const forceExit = setTimeout(() => process.exit(exitCode || 1), 10_000);
    forceExit.unref?.();
    // 停止接受新连接，等待现有连接排空
    await new Promise<void>((resolve) => server.close(() => resolve()));
    try { await app.shutdown(); } catch (e) {
      console.warn('[stdhub] app shutdown error:', e instanceof Error ? e.message : String(e));
    }
    clearTimeout(forceExit);
    process.exit(exitCode);
  };
  fatalShutdown = (reason) => { void cleanup(reason, 1); };
  process.once('SIGINT', () => { void cleanup('SIGINT'); });
  process.once('SIGTERM', () => { void cleanup('SIGTERM'); });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
