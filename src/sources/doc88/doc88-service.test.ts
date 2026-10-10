import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { getDb, resetDbForTesting } from '../../services/db';
import { Doc88Service } from './doc88-service';

const previousCookie = process.env.DOC88_COOKIE;
afterEach(() => {
  resetDbForTesting();
  if (previousCookie === undefined) delete process.env.DOC88_COOKIE;
  else process.env.DOC88_COOKIE = previousCookie;
});

describe('Doc88Service task persistence', () => {
  it('requires configuration and preserves owner isolation', () => {
    delete process.env.DOC88_COOKIE;
    const db = getDb(':memory:');
    const user = db.prepare("SELECT id FROM users WHERE username = '_guest'").get() as { id: number };
    const service = new Doc88Service(db);
    expect(() => service.createTask(user.id, { pcode: '123456789012', title: 'GB/T 3325-2024 标准', standardNumber: 'GB/T 3325-2024', cleanTitle: '标准' })).toThrow(/Cookie 未配置/);
    db.close();
  });

  it('recovers unfinished persisted tasks as interrupted', () => {
    const db = getDb(':memory:');
    const user = db.prepare("SELECT id FROM users WHERE username = '_guest'").get() as { id: number };
    db.prepare("INSERT INTO doc88_tasks (id,user_id,pcode,status,phase) VALUES ('d88_old',?,'123456789012','running','rendering')").run(user.id);
    const service = new Doc88Service(db);
    const row = db.prepare("SELECT status,error_code FROM doc88_tasks WHERE id='d88_old'").get() as any;
    expect(row).toEqual({ status: 'failed', error_code: 'DOC88_TASK_INTERRUPTED' });
    db.close();
  });
});
