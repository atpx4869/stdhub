// 加载 .env.local 必须最先：让源 adapter import 时已能读到 LABR_* 等凭据
import { loadDotEnvLocal } from './shared/env-loader';
loadDotEnvLocal();

// Install console interceptor as early as possible so the diagnostics endpoint
// sees every warning produced at startup (OCR worker boot, source registry, …).
import './shared/log-buffer';

import { createServer } from 'node:http';

import { createApp } from './api/app';
import { ensureDataDirs } from './shared/fs';

// 全局错误处理：防止未捕获异常导致服务器崩溃
process.on('unhandledRejection', (reason) => {
  console.error('[stdhub] unhandledRejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('[stdhub] uncaughtException:', error);
  // 不退出进程，让服务器继续运行
});

async function listenWithFallback(server: ReturnType<typeof createServer>, preferred: number): Promise<number> {
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
        server.listen(0, '0.0.0.0');
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
    server.listen(preferred, '0.0.0.0');
  });
}

async function main() {
  await ensureDataDirs();

  const app = createApp();
  const preferred = Number(process.env.PORT ?? 3000);
  const server = createServer(app);
  const port = await listenWithFallback(server, preferred);
  console.log(`[stdhub] server listening on http://localhost:${port}`);

  let shuttingDown = false;
  const cleanup = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[stdhub] received ${signal}, shutting down`);
    try { server.close(); } catch { /* ignore */ }
    try { await app.shutdown(); } catch (e) {
      console.warn('[stdhub] app shutdown error:', e instanceof Error ? e.message : String(e));
    }
    process.exit(0);
  };
  process.once('SIGINT', () => { void cleanup('SIGINT'); });
  process.once('SIGTERM', () => { void cleanup('SIGTERM'); });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
