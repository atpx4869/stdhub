import type Database from 'better-sqlite3';

export function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some(item => item.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

export function runMigration(db: Database.Database, version: number, migrate: () => void): void {
  if (db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version)) return;
  db.transaction(() => {
    migrate();
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
  })();
}
