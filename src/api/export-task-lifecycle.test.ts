import { EventEmitter, once } from 'node:events';
import { get, type IncomingMessage, type Server } from 'node:http';
import BetterSqlite3 from 'better-sqlite3';
import express, { type ErrorRequestHandler, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readConfig } from '../config';
import type { ExportTask } from '../domain/standard';
import { ExportTaskService } from '../services/export-task-service';
import { ExportTaskStore } from '../services/export-task-store';
import type { SourceRegistry } from '../services/source-registry';
import { StandardDownloadOrchestrator, type DownloadHandle, type OrchestratedDownloadResult } from '../services/standard-download-orchestrator';
import { AppError } from '../shared/errors';
import { highCostInFlightGuard } from '../shared/high-cost-guard';
import { respondError } from '../shared/response';
import { createAuthMiddleware } from './auth-middleware';
import { createStandardsRoutes } from './standards-routes';

type Download = StandardDownloadOrchestrator['download'];

function taskEvents(text: string): { data: ExportTask | null; error: { code: string } | null }[] {
  return text.split('\n\n').flatMap(frame => frame.startsWith('data: ') ? [JSON.parse(frame.slice(6))] : []);
}

function openStream(server: Server, taskId: string) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Expected a local TCP port');
  return new Promise<{
    response: IncomingMessage;
    text: () => string;
    ended: () => boolean;
    complete: Promise<void>;
  }>((resolve, reject) => {
    const client = get({ host: '127.0.0.1', port: address.port, path: '/api/tasks/' + taskId + '/stream' }, response => {
      let text = '';
      let ended = false;
      const complete = new Promise<void>(done => response.once('close', done));
      response.on('end', () => { ended = true; });
      // Closing deliberately in the disconnect test emits an aborted response.
      response.on('error', reject);
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
        if (text.includes('\n\n')) resolve({ response, text: () => text, ended: () => ended, complete });
      });
      response.on('end', () => reject(new Error('Stream ended without a task frame')));
    });
    client.on('error', reject);
  });
}

describe('export task lifecycle API', () => {
  let db: InstanceType<typeof BetterSqlite3>;
  let app: ReturnType<typeof express>;
  let server: Server;
  let store: ExportTaskStore;
  let finish: (result: OrchestratedDownloadResult) => void;
  let download: ReturnType<typeof vi.fn<Download>>;
  let unsubscribe: DownloadHandle['unsubscribe'];
  let enteredGuard: (() => void) | undefined;
  const guardPath = '/api/standards/bz:sse-gate/export';

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'performance'] });
    db = new BetterSqlite3(':memory:');
    db.exec(
      "CREATE TABLE users (id, username, display_name, role, allowed_tabs);" +
      "INSERT INTO users VALUES (1, '_guest', 'Guest', 'guest', NULL);" +
      'CREATE TABLE usage_events (user_id, event_type, source, standard_id, metadata, ip, hostname, client, result, error);',
    );
    unsubscribe = vi.fn(() => ({ aborted: true, remainingSubscribers: 0 }));
    const promise = new Promise<OrchestratedDownloadResult>(resolve => { finish = resolve; });
    download = vi.fn<Download>((_source, _id, _sub, _progress, phase) => {
      phase?.('queued');
      return { key: 'fixture', created: true, reused: false, promise, unsubscribe };
    });
    store = new ExportTaskStore();
    // The only downstream flight in this test is the injected stub above.
    const sourceRegistry = {} as SourceRegistry;
    const downloadOrchestrator = new StandardDownloadOrchestrator(db, sourceRegistry);
    vi.spyOn(downloadOrchestrator, 'download').mockImplementation(download);
    const exportTaskService = new ExportTaskService(store, downloadOrchestrator);
    const auth = createAuthMiddleware(db);
    app = express();
    app.use((req, _res, next) => {
      if (req.get('x-test-user') === '2') req.user = { id: 2, username: 'fixture', display_name: 'Fixture', role: 'admin', allowed_tabs: null };
      next();
      // The downstream middleware chain synchronously reaches the guard.
      if (req.path === guardPath) enteredGuard?.();
    });
    app.use(createStandardsRoutes({
      db, exportTaskStore: store, exportTaskService, sourceRegistry, downloadOrchestrator,
      ...auth, baseDir: process.cwd(),
    }));
    const errors: ErrorRequestHandler = (error, _req, res, next) => {
      if (error instanceof AppError) respondError(res, error.statusCode, error.code, error.message);
      else next(error);
    };
    app.use(errors);
    server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
  });

  afterEach(async () => {
    try {
      if (server) {
        const stopped = once(server, 'close');
        server.close();
        server.closeAllConnections();
        await stopped;
      }
      db?.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a queued stream open after 10 seconds and replays its settled outcome exactly once', async () => {
    const accepted = await request(server).post('/api/standards/bz:sse-queued/export').expect(202);
    const { id } = accepted.body.data;
    expect(accepted.body.data).toMatchObject({ status: 'queued', phase: 'queued', subscribers: [1], timingsMs: { queue: 0 } });
    const connected = await openStream(server, id);
    expect(connected.response.headers['content-type']).toContain('text/event-stream');
    expect(taskEvents(connected.text())).toMatchObject([{ data: { status: 'queued' }, error: null }]);
    await vi.advanceTimersByTimeAsync(16_000);
    expect(connected.response.destroyed).toBe(false);
    expect(connected.ended()).toBe(false);
    expect(taskEvents(connected.text())).toHaveLength(1);
    expect((await request(server).get('/api/tasks/' + id).expect(200)).body.data.status).toBe('queued');
    expect(connected.text()).toContain(': keep-alive');
    expect(db.prepare('SELECT result FROM usage_events').all()).toEqual([]);

    const [, standardId, , onProgress] = download.mock.calls[0];
    onProgress!(2, 3);
    await vi.advanceTimersByTimeAsync(500);
    expect((await request(server).get('/api/tasks/' + id).expect(200)).body.data).toMatchObject({ status: 'running', phase: 'downloading', currentPage: 2 });
    finish({ source: 'bz', standardId, status: 'downloaded', fileId: 42, timingsMs: { queue: 16_000, transfer: 350, library: 10 } });
    await vi.advanceTimersByTimeAsync(500);
    await connected.complete;
    const frames = taskEvents(connected.text());
    expect(connected.ended()).toBe(true);
    expect(frames).toMatchObject([
      { data: { status: 'queued' }, error: null },
      { data: { status: 'running', currentPage: 2 }, error: null },
      { data: { status: 'success', fileId: 42, timingsMs: { queue: 16_000, transfer: 350, library: 10 } }, error: null },
    ]);
    const snapshot = await request(server).get('/api/tasks/' + id).expect('Cache-Control', 'no-store').expect(200);
    const replay = await openStream(server, id);
    await replay.complete; // Does not require advancing the poll timer.
    expect(taskEvents(replay.text())).toEqual([snapshot.body]);
    expect(download).toHaveBeenCalledTimes(1);
    expect(db.prepare('SELECT result FROM usage_events').all()).toEqual([{ result: 'success' }]);
  });

  it('measures actual wait at the high-cost gate separately from the source queue', async () => {
    const { highCostActiveLimit, highCostQueueTimeoutMs } = readConfig();
    const holders = Array.from({ length: highCostActiveLimit }, () => new EventEmitter());
    for (const response of holders) highCostInFlightGuard({} as Request, response as unknown as Response, () => {});
    const entered = new Promise<void>(resolve => { enteredGuard = resolve; });
    try {
      const acceptance = request(server).post(guardPath).expect(202).then(result => result);
      await entered;
      expect(download).not.toHaveBeenCalled();
      const gateMs = highCostQueueTimeoutMs - 1;
      await vi.advanceTimersByTimeAsync(gateMs);
      holders[0].emit('finish');
      const accepted = await acceptance;
      expect(accepted.body.data.timingsMs).toEqual({ queue: gateMs });
      finish({ source: 'bz', standardId: 'bz:sse-gate', status: 'downloaded', fileId: 43, timingsMs: { queue: 20 } });
      await vi.advanceTimersByTimeAsync(0);
      expect((await request(server).get('/api/tasks/' + accepted.body.data.id).expect(200)).body.data.timingsMs)
        .toEqual({ queue: gateMs + 20 });
    } finally {
      enteredGuard = undefined;
      for (const response of holders) response.emit('finish');
    }
  });

  it('does not cancel on disconnect, and records local library failure without reporting success', async () => {
    const accepted = await request(server).post('/api/standards/sby:library-error/export').expect(202);
    const { id } = accepted.body.data;
    const connected = await openStream(server, id);
    connected.response.destroy();
    await connected.complete;
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(store.get(id)?.status).toBe('queued');
    finish({ source: 'sby', standardId: 'sby:library-error', status: 'library_failed', libraryError: 'disk full', timingsMs: { transfer: 90, library: 7 } });
    await vi.advanceTimersByTimeAsync(0);
    const replay = await openStream(server, id);
    await replay.complete;
    expect(taskEvents(replay.text())).toMatchObject([{
      data: { status: 'failed', libraryError: 'disk full', timingsMs: { transfer: 90, library: 7 } }, error: null,
    }]);
    expect(db.prepare('SELECT result FROM usage_events').all()).toEqual([{ result: 'fail' }]);
  });

  it('keeps a foreign task indistinguishable from a missing task on all task endpoints', async () => {
    const accepted = await request(server).post('/api/standards/gbw:owner-only/export').expect(202);
    const { id } = accepted.body.data;
    for (const taskId of [id, 'not-a-task']) {
      const url = '/api/tasks/' + taskId;
      const responses = await Promise.all([
        request(server).get(url).set('x-test-user', '2'),
        request(server).get(url + '/stream').set('x-test-user', '2'),
        request(server).post(url + '/cancel').set('x-test-user', '2'),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(404);
        expect(response.body).toMatchObject({ data: null, error: { code: 'NOT_FOUND' } });
      }
    }
    expect(unsubscribe).not.toHaveBeenCalled();
  });
});
