import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/api/app';

delete process.env.STDHUB_ADMIN_PASSWORD;
const root = mkdtempSync(path.join(tmpdir(), 'stdhub-e2e-'));
const app = createApp({ baseDir: process.cwd(), dbPath: path.join(root, 'stdhub.db'), startBackgroundJobs: false });
const server = createServer(app);
server.listen(4173, '127.0.0.1');

let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await new Promise<void>(resolve => server.close(() => resolve()));
  await app.shutdown();
  rmSync(root, { recursive: true, force: true });
}
process.once('SIGINT', () => void close().then(() => process.exit(0)));
process.once('SIGTERM', () => void close().then(() => process.exit(0)));
