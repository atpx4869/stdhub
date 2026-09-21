import type Database from 'better-sqlite3';
import { addColumnIfMissing, runMigration } from './runner';

const columns: Array<[string, string, string]> = [
  ['users', 'allowed_tabs', 'TEXT DEFAULT NULL'],
  ['cma_labs', 'public_detail_id', "TEXT DEFAULT ''"], ['cma_labs', 'address', "TEXT DEFAULT ''"],
  ['cma_labs', 'area_name', "TEXT DEFAULT ''"], ['cma_labs', 'industry', "TEXT DEFAULT ''"],
  ['cma_labs', 'issue_date', "TEXT DEFAULT ''"], ['cma_labs', 'valid_from', "TEXT DEFAULT ''"],
  ['cma_labs', 'valid_to', "TEXT DEFAULT ''"], ['cma_labs', 'cert_status', "TEXT DEFAULT ''"],
  ['cnas_labs', 'url_params', "TEXT DEFAULT '{}'"], ['cnas_labs', 'other_names', "TEXT DEFAULT ''"],
  ['cnas_labs', 'org_address', "TEXT DEFAULT ''"], ['cnas_labs', 'validity_period', "TEXT DEFAULT ''"],
  ['cnas_labs', 'cert_tasks', "TEXT DEFAULT '[]'"], ['check_items', 'new_version', 'TEXT DEFAULT NULL'],
  ['check_items', 'instead_std', 'TEXT DEFAULT NULL'], ['check_items', 'abolish_date', 'TEXT DEFAULT NULL'],
  ['check_watchlists', 'auto_enabled', 'INTEGER NOT NULL DEFAULT 0'],
  ['check_watchlists', 'auto_interval_days', 'INTEGER NOT NULL DEFAULT 15'],
  ['check_watchlists', 'next_run_at', 'TEXT DEFAULT NULL'], ['check_watchlists', 'is_saved', 'INTEGER NOT NULL DEFAULT 0'],
  ['standard_files', 'file_name', "TEXT NOT NULL DEFAULT ''"], ['standard_files', 'etag', "TEXT DEFAULT ''"],
  ['cnas_qualifications', 'std_code_norm', "TEXT DEFAULT ''"], ['cnas_qualifications', 'std_code_base', "TEXT DEFAULT ''"],
  ['cma_qualifications', 'std_code_norm', "TEXT DEFAULT ''"], ['cma_qualifications', 'std_code_base', "TEXT DEFAULT ''"],
  ['usage_events', 'ip', 'TEXT DEFAULT NULL'], ['usage_events', 'hostname', 'TEXT DEFAULT NULL'],
  ['usage_events', 'client', 'TEXT DEFAULT NULL'], ['usage_events', 'result', 'TEXT DEFAULT NULL'],
  ['usage_events', 'error', 'TEXT DEFAULT NULL'],
];

export function runCoreMigrations(db: Database.Database): void {
  for (const [table, column, definition] of columns) addColumnIfMissing(db, table, column, definition);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cnas_qual_norm ON cnas_qualifications(std_code_norm);
    CREATE INDEX IF NOT EXISTS idx_cnas_qual_base ON cnas_qualifications(std_code_base);
    CREATE INDEX IF NOT EXISTS idx_cma_qual_norm ON cma_qualifications(std_code_norm);
    CREATE INDEX IF NOT EXISTS idx_cma_qual_base ON cma_qualifications(std_code_base);
    CREATE INDEX IF NOT EXISTS idx_standard_files_file_name ON standard_files(file_name);
    CREATE INDEX IF NOT EXISTS idx_standard_files_indexed_at ON standard_files(indexed_at);
  `);
  runMigration(db, 2026071801, () => db.exec(`
    CREATE INDEX IF NOT EXISTS idx_usage_source_result_created ON usage_events(source, result, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_export_files_name_mtime ON export_files(file_name, mtime DESC);
    CREATE INDEX IF NOT EXISTS idx_standard_files_norm_indexed ON standard_files(std_code_norm, indexed_at DESC);
  `));
  runMigration(db, 2026091701, () => db.prepare(
    "DELETE FROM settings WHERE key IN ('qual_sync_enabled', 'qual_sync_cron')",
  ).run());
  runMigration(db, 2026091702, () => db.exec(`
    CREATE TABLE IF NOT EXISTS qualification_lab_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name TEXT NOT NULL,
      cnas_lab_no TEXT UNIQUE,
      cma_cert_number TEXT UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS legacy_cnas_labs_archive AS SELECT * FROM cnas_labs WHERE 0;
    CREATE TABLE IF NOT EXISTS legacy_cnas_qualifications_archive AS SELECT * FROM cnas_qualifications WHERE 0;
    CREATE TABLE IF NOT EXISTS legacy_cnas_sync_logs_archive AS SELECT * FROM cnas_sync_logs WHERE 0;
    CREATE TABLE IF NOT EXISTS legacy_cma_labs_archive AS SELECT * FROM cma_labs WHERE 0;
    CREATE TABLE IF NOT EXISTS legacy_cma_qualifications_archive AS SELECT * FROM cma_qualifications WHERE 0;
    CREATE TABLE IF NOT EXISTS legacy_cma_sync_logs_archive AS SELECT * FROM cma_sync_logs WHERE 0;
    CREATE TABLE IF NOT EXISTS legacy_qualification_lab_links_archive AS
      SELECT * FROM qualification_lab_links WHERE 0;

    INSERT INTO legacy_cnas_labs_archive SELECT * FROM cnas_labs WHERE lab_no <> 'L0290';
    INSERT INTO legacy_cnas_qualifications_archive SELECT * FROM cnas_qualifications WHERE lab_no <> 'L0290';
    INSERT INTO legacy_cnas_sync_logs_archive SELECT * FROM cnas_sync_logs WHERE lab_no <> 'L0290';
    INSERT INTO legacy_cma_labs_archive SELECT * FROM cma_labs WHERE cert_number <> '221700110366';
    INSERT INTO legacy_cma_qualifications_archive SELECT * FROM cma_qualifications WHERE cert_number <> '221700110366';
    INSERT INTO legacy_cma_sync_logs_archive SELECT * FROM cma_sync_logs WHERE cert_number <> '221700110366';
    INSERT INTO legacy_qualification_lab_links_archive SELECT * FROM qualification_lab_links;

    DELETE FROM cnas_qualifications WHERE lab_no <> 'L0290';
    DELETE FROM cnas_sync_logs WHERE lab_no <> 'L0290';
    DELETE FROM cnas_labs WHERE lab_no <> 'L0290';
    DELETE FROM cma_qualifications WHERE cert_number <> '221700110366';
    DELETE FROM cma_sync_logs WHERE cert_number <> '221700110366';
    DELETE FROM cma_labs WHERE cert_number <> '221700110366';
    DROP TABLE qualification_lab_links;
  `));
  runMigration(db, 2026081401, () => db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cnas_qual_norm_date ON cnas_qualifications(std_code_norm, effective_date DESC, id);
    CREATE INDEX IF NOT EXISTS idx_cma_qual_norm_date ON cma_qualifications(std_code_norm, effective_date DESC, id);
    CREATE INDEX IF NOT EXISTS idx_cnas_labs_name ON cnas_labs(lab_name);
    CREATE INDEX IF NOT EXISTS idx_cma_labs_name ON cma_labs(lab_name);
    CREATE VIRTUAL TABLE IF NOT EXISTS qualification_search_fts USING fts5(source UNINDEXED, qualification_id UNINDEXED, std_code, std_name, category, test_object, test_param, test_standard, tokenize='trigram');
    CREATE TRIGGER IF NOT EXISTS trg_cnas_qual_fts_insert AFTER INSERT ON cnas_qualifications BEGIN INSERT INTO qualification_search_fts(source, qualification_id, std_code, std_name, category, test_object, test_param, test_standard) VALUES ('CNAS', new.id, new.std_code, new.std_name, new.category, new.test_object, new.test_param, new.test_standard); END;
    CREATE TRIGGER IF NOT EXISTS trg_cnas_qual_fts_delete AFTER DELETE ON cnas_qualifications BEGIN DELETE FROM qualification_search_fts WHERE source = 'CNAS' AND qualification_id = old.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_cnas_qual_fts_update AFTER UPDATE ON cnas_qualifications BEGIN DELETE FROM qualification_search_fts WHERE source = 'CNAS' AND qualification_id = old.id; INSERT INTO qualification_search_fts(source, qualification_id, std_code, std_name, category, test_object, test_param, test_standard) VALUES ('CNAS', new.id, new.std_code, new.std_name, new.category, new.test_object, new.test_param, new.test_standard); END;
    CREATE TRIGGER IF NOT EXISTS trg_cma_qual_fts_insert AFTER INSERT ON cma_qualifications BEGIN INSERT INTO qualification_search_fts(source, qualification_id, std_code, std_name, category, test_object, test_param, test_standard) VALUES ('CMA', new.id, new.std_code, new.std_name, new.category, '', new.test_item, new.test_standard); END;
    CREATE TRIGGER IF NOT EXISTS trg_cma_qual_fts_delete AFTER DELETE ON cma_qualifications BEGIN DELETE FROM qualification_search_fts WHERE source = 'CMA' AND qualification_id = old.id; END;
    CREATE TRIGGER IF NOT EXISTS trg_cma_qual_fts_update AFTER UPDATE ON cma_qualifications BEGIN DELETE FROM qualification_search_fts WHERE source = 'CMA' AND qualification_id = old.id; INSERT INTO qualification_search_fts(source, qualification_id, std_code, std_name, category, test_object, test_param, test_standard) VALUES ('CMA', new.id, new.std_code, new.std_name, new.category, '', new.test_item, new.test_standard); END;
    DELETE FROM qualification_search_fts;
    INSERT INTO qualification_search_fts(source, qualification_id, std_code, std_name, category, test_object, test_param, test_standard) SELECT 'CNAS', id, std_code, std_name, category, test_object, test_param, test_standard FROM cnas_qualifications;
    INSERT INTO qualification_search_fts(source, qualification_id, std_code, std_name, category, test_object, test_param, test_standard) SELECT 'CMA', id, std_code, std_name, category, '', test_item, test_standard FROM cma_qualifications;
  `));
}
