import type Database from 'better-sqlite3';
import { addColumnIfMissing, runMigration } from './runner';

function createAbilityTable(db: Database.Database, name: string): void {
  db.exec(`CREATE TABLE ${name} (
    id INTEGER PRIMARY KEY AUTOINCREMENT, place_id TEXT NOT NULL, cert_code TEXT NOT NULL,
    source_id TEXT NOT NULL, category TEXT, sub_category TEXT, product_name TEXT,
    std_name TEXT, std_code TEXT, std_code_norm TEXT, limit_desc TEXT,
    synced_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(cert_code, source_id)
  )`);
}

export function ensureNatCmaSchema(db: Database.Database, normalize: (value: string) => string): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime(\'now\')));');
  runMigration(db, 2026090801, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS nat_cma_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT, cert_code TEXT NOT NULL, place_id TEXT NOT NULL,
      place_name TEXT NOT NULL, place_address TEXT NOT NULL, place_type TEXT NOT NULL DEFAULT '分场所',
      subscribed_at TEXT NOT NULL DEFAULT (datetime('now')), last_synced_at TEXT,
      ability_count INTEGER DEFAULT 0, sync_status TEXT DEFAULT 'pending', sync_error TEXT,
      cert_status TEXT, cert_issued_at TEXT, cert_valid_from TEXT, cert_valid_to TEXT,
      UNIQUE(cert_code, place_id)
    )`);
    for (const [column, definition] of [
      ['sync_status', "TEXT DEFAULT 'pending'"], ['sync_error', 'TEXT'], ['cert_status', 'TEXT'],
      ['cert_issued_at', 'TEXT'], ['cert_valid_from', 'TEXT'], ['cert_valid_to', 'TEXT'],
    ] as Array<[string, string]>) addColumnIfMissing(db, 'nat_cma_subscriptions', column, definition);
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'nat_cma_abilities'").get();
    if (!exists) createAbilityTable(db, 'nat_cma_abilities');
    else {
      const columns = new Set((db.prepare('PRAGMA table_info(nat_cma_abilities)').all() as Array<{ name: string }>).map(item => item.name));
      if (!columns.has('source_id')) {
        db.exec('DROP TABLE IF EXISTS nat_cma_abilities_v2');
        createAbilityTable(db, 'nat_cma_abilities_v2');
        db.exec(`INSERT INTO nat_cma_abilities_v2
          (place_id, cert_code, source_id, category, sub_category, product_name, std_name, std_code, std_code_norm, limit_desc, synced_at)
          SELECT place_id, cert_code, 'legacy-' || id, category, sub_category, product_name, std_name, std_code, '', limit_desc, synced_at FROM nat_cma_abilities;
          DROP TABLE nat_cma_abilities;
          ALTER TABLE nat_cma_abilities_v2 RENAME TO nat_cma_abilities;`);
      }
    }
    addColumnIfMissing(db, 'nat_cma_abilities', 'std_code_norm', 'TEXT');
    const rows = db.prepare("SELECT id, std_code FROM nat_cma_abilities WHERE COALESCE(std_code_norm, '') = ''").all() as Array<{ id: number; std_code: string }>;
    const update = db.prepare('UPDATE nat_cma_abilities SET std_code_norm = ? WHERE id = ?');
    for (const row of rows) update.run(normalize(row.std_code || ''), row.id);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nat_cma_sub_cert ON nat_cma_subscriptions(cert_code);
      CREATE INDEX IF NOT EXISTS idx_nat_cma_ab_cert ON nat_cma_abilities(cert_code);
      CREATE INDEX IF NOT EXISTS idx_nat_cma_ab_std ON nat_cma_abilities(std_code);
      CREATE INDEX IF NOT EXISTS idx_nat_cma_ab_std_norm ON nat_cma_abilities(std_code_norm);
    `);
  });
}
