import { afterEach, describe, expect, it, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { _resetLibraryPathCacheForTesting } from '../../shared/library-paths';
import { getDb, resetDbForTesting, setSetting } from '../../services/db';
import { Doc88Service } from './doc88-service';

const previousCookie = process.env.DOC88_COOKIE;
const previousFile = process.env.DOC88_COOKIE_FILE;
afterEach(() => {
  _resetLibraryPathCacheForTesting();
  resetDbForTesting();
  if (previousCookie === undefined) delete process.env.DOC88_COOKIE; else process.env.DOC88_COOKIE = previousCookie;
  if (previousFile === undefined) delete process.env.DOC88_COOKIE_FILE; else process.env.DOC88_COOKIE_FILE = previousFile;
});
const input = (pcode = '123456789012') => ({ pcode, title: 'GB/T 3325-2024 标准', standardNumber: 'GB/T 3325-2024', cleanTitle: '标准' });

function isolated() {
  const db = getDb(':memory:');
  setSetting(db, 'standards_library_dir', '/tmp/stdhub-doc88-test-unused');
  const user = db.prepare("SELECT id FROM users WHERE username='_guest'").get() as { id: number };
  return { db, userId: user.id };
}

describe('Doc88Service task persistence', () => {
  it('requires configuration', async () => {
    delete process.env.DOC88_COOKIE; delete process.env.DOC88_COOKIE_FILE;
    const { db, userId } = isolated();
    const service = new Doc88Service(db);
    expect(() => service.createTask(userId, input())).toThrow(/Cookie 未配置/);
    await service.close(); db.close();
  });

  it('recovers unfinished persisted tasks as interrupted', async () => {
    const { db, userId } = isolated();
    db.prepare("INSERT INTO doc88_tasks (id,user_id,pcode,status,phase) VALUES ('d88_old',?,'123456789012','running','rendering')").run(userId);
    const service = new Doc88Service(db);
    expect(service.getTask('d88_old', userId)).toMatchObject({ status: 'failed', error: { code: 'DOC88_TASK_INTERRUPTED' } });
    expect(() => service.getTask('d88_old', userId + 100)).toThrow(/不存在/);
    expect(service.listTasks(userId + 100)).toEqual([]);
    await service.close(); db.close();
  });

  it('deduplicates active pcodes and keeps cancelled tasks terminal despite late progress', async () => {
    process.env.DOC88_COOKIE = 'PHPSESSID=test-only; cdb_sys_sid=test-only';
    const { db, userId } = isolated();
    let started: () => void = () => {};
    const ready = new Promise<void>(resolve => { started = resolve; });
    const render = vi.fn(async (_pcode, outPath, options) => {
      started();
      await new Promise<void>(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      options.onProgress('rendering', 1, 1, '迟到进度');
      return { title: '标准', totalPages: 1, renderedPages: 1, outPath };
    });
    const ingest = vi.fn();
    const service = new Doc88Service(db, { render, ingest });
    const a = service.createTask(userId, input());
    const b = service.createTask(userId, input());
    expect(a.id).toBe(b.id);
    expect(() => service.createTask(userId + 100, input())).toThrow(/已有生成任务/);
    await ready;
    expect(service.cancel(a.id, userId).status).toBe('cancelled');
    await service.close();
    expect(service.getTask(a.id, userId).status).toBe('cancelled');
    expect(ingest).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(1);
    db.close();
  });

  it('never starts cancelled queued tasks, and shutdown waits for the running worker', async () => {
    process.env.DOC88_COOKIE = 'test-only=1';
    const { db, userId } = isolated();
    let started: () => void = () => {};
    const ready = new Promise<void>(resolve => { started = resolve; });
    const render = vi.fn(async (_pcode, outPath, options) => {
      started();
      await new Promise<void>(resolve => options.signal.addEventListener('abort', resolve, { once: true }));
      return { title: '', totalPages: 1, renderedPages: 1, outPath };
    });
    const service = new Doc88Service(db, { render });
    const a = service.createTask(userId, input());
    await ready;
    const b = service.createTask(userId, input('223456789012'));
    service.cancel(b.id, userId);
    await service.close();
    expect(render).toHaveBeenCalledTimes(1);
    expect(service.getTask(a.id, userId).status).toBe('cancelled');
    expect(service.getTask(b.id, userId).status).toBe('cancelled');
    db.close();
  });

  it('rejects incomplete PDFs before ingest', async () => {
    process.env.DOC88_COOKIE = 'test-only=1';
    const { db, userId } = isolated();
    const ingest = vi.fn();
    const service = new Doc88Service(db, {
      render: async (_pcode, outPath) => ({ title: '', totalPages: 27, renderedPages: 26, outPath }), ingest,
    });
    const task = service.createTask(userId, input());
    await vi.waitFor(() => expect(service.getTask(task.id, userId).status).toBe('failed'));
    expect(service.getTask(task.id, userId).error?.code).toBe('DOC88_INCOMPLETE');
    expect(ingest).not.toHaveBeenCalled();
    await service.close(); db.close();
  });

  it('indexes a verified PDF, follows renamed filename, and reuses the local copy', async () => {
    process.env.DOC88_COOKIE = 'test-only=1';
    const { db, userId } = isolated();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'doc88-success-test-'));
    _resetLibraryPathCacheForTesting();
    setSetting(db, 'standards_library_dir', root);
    const render = vi.fn(async (_pcode, outPath) => {
      const bytes = Buffer.alloc(30_000, 32); bytes.write('%PDF-1.7');
      await fs.writeFile(outPath, bytes);
      return { title: '标准', totalPages: 2, renderedPages: 2, outPath };
    });
    const service = new Doc88Service(db, { render, verify: async () => ({ pages: 2, size: 30_000 }) });
    try {
      const task = service.createTask(userId, input());
      await vi.waitFor(() => expect(service.getTask(task.id, userId).status).toBe('success'));
      const done = service.getTask(task.id, userId);
      expect(done.fileName).toContain('D88');
      expect((db.prepare('SELECT source FROM standard_files WHERE id=?').get(done.fileId!) as any).source).toBe('doc88');
      db.prepare('UPDATE standard_files SET file_name=? WHERE id=?').run('已重命名.pdf', done.fileId!);
      expect(service.getTask(task.id, userId).fileName).toBe('已重命名.pdf');
      const again = service.createTask(userId, input());
      await vi.waitFor(() => expect(service.getTask(again.id, userId).status).toBe('success'), { timeout: 4000 });
      expect(render).toHaveBeenCalledTimes(1);
      expect(service.getTask(again.id, userId).fileId).toBe(done.fileId);
    } finally { await service.close(); db.close(); await fs.rm(root, { recursive: true, force: true }); }
  });

  it('never stores raw browser errors or Cookie values in persisted tasks', async () => {
    process.env.DOC88_COOKIE = 'test-only=1';
    const { db, userId } = isolated();
    const service = new Doc88Service(db, { render: async () => { throw new Error('browser failed Cookie: PRIVATE_TEST_MARKER=secret'); } });
    const task = service.createTask(userId, input());
    await vi.waitFor(() => expect(service.getTask(task.id, userId).status).toBe('failed'));
    expect(JSON.stringify(service.getTask(task.id, userId))).not.toContain('PRIVATE_TEST_MARKER');
    await service.close(); db.close();
  });
});
