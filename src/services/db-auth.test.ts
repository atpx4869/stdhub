import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ADMIN_PASSWORD,
  DEFAULT_ADMIN_USERNAME,
  ensureAdminUser,
} from './db';

const previousAdminPassword = process.env.STDHUB_ADMIN_PASSWORD;

function createUsersDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT 'user',
      is_active INTEGER NOT NULL DEFAULT 1,
      allowed_tabs TEXT DEFAULT NULL
    )
  `);
  return db;
}

afterEach(() => {
  if (previousAdminPassword === undefined) delete process.env.STDHUB_ADMIN_PASSWORD;
  else process.env.STDHUB_ADMIN_PASSWORD = previousAdminPassword;
});

describe('ensureAdminUser', () => {
  it('creates the documented default administrator when no override is configured', () => {
    delete process.env.STDHUB_ADMIN_PASSWORD;
    const db = createUsersDb();
    try {
      ensureAdminUser(db);
      const admin = db.prepare("SELECT username, password, role, is_active FROM users WHERE role = 'admin'").get() as any;
      expect(admin).toMatchObject({ username: DEFAULT_ADMIN_USERNAME, role: 'admin', is_active: 1 });
      expect(bcrypt.compareSync(DEFAULT_ADMIN_PASSWORD, admin.password)).toBe(true);
    } finally {
      db.close();
    }
  });

  it('uses STDHUB_ADMIN_PASSWORD for first-run override', () => {
    process.env.STDHUB_ADMIN_PASSWORD = 'configured-admin-password';
    const db = createUsersDb();
    try {
      ensureAdminUser(db);
      const admin = db.prepare("SELECT password FROM users WHERE role = 'admin'").get() as any;
      expect(bcrypt.compareSync('configured-admin-password', admin.password)).toBe(true);
      expect(bcrypt.compareSync(DEFAULT_ADMIN_PASSWORD, admin.password)).toBe(false);
    } finally {
      db.close();
    }
  });

  it('does not overwrite an existing administrator password', () => {
    delete process.env.STDHUB_ADMIN_PASSWORD;
    const db = createUsersDb();
    try {
      const existingHash = bcrypt.hashSync('existing-admin-password', 4);
      db.prepare(
        'INSERT INTO users (username, password, display_name, role, is_active) VALUES (?, ?, ?, ?, 1)'
      ).run(DEFAULT_ADMIN_USERNAME, existingHash, '管理员', 'admin');

      ensureAdminUser(db);

      const admin = db.prepare("SELECT password FROM users WHERE role = 'admin'").get() as any;
      expect(bcrypt.compareSync('existing-admin-password', admin.password)).toBe(true);
      expect(bcrypt.compareSync(DEFAULT_ADMIN_PASSWORD, admin.password)).toBe(false);
    } finally {
      db.close();
    }
  });
});
