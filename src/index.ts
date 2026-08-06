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

function resolveBindHost(): string {
  const host = (process.env.STDHUB_BIND_HOST || process.env.HOST || '127.0.0.1').trim();
  return host || '127.0.0.1';
}

function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host.toLowerCase() === 'localhost';
}

function checkOpenAdminBoundary(host: string): void {
  if (isLoopbackHost(host)) return;
  if (process.env.STDHUB_PROXY_TOKEN?.trim()) return;
  const message = `[stdhub] 高危部署提示：当前监听 ${host} 且未设置 STDHUB_PROXY_TOKEN，` +
    '同网段可直接访问管理员功能。建议仅经 Lucky/Nginx 反代访问，并注入 X-StdHub-Proxy-Token。';
  if (process.env.STDHUB_STRICT_SECURITY === '1') {
    throw new Error(`${message} 如确认要开放，请设置 STDHUB_PROXY_TOKEN，或关闭 STDHUB_STRICT_SECURITY。`);
  }
  console.warn(message);
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
  const cleanup = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[stdhub] received ${signal}, shutting down`);
    // 停止接受新连接，等待现有连接排空
    await new Promise<void>((resolve) => server.close(() => resolve()));
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
