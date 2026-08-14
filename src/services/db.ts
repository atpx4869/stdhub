import Database from 'better-sqlite3';
import path from 'node:path';
import { getRootDir } from '../shared/fs';
import { extractBaseCode, extractFullCode, cleanStdCode } from '../shared/std-code';
import { tryRestoreDbBeforeOpen, backupDbAsync } from './db-backup';

let _db: Database.Database | null = null;

export const GUEST_USERNAME = '_guest';
const GUEST_PASSWORD_SENTINEL = 'guest-login-disabled';
const GUEST_DISPLAY_NAME = '访客';

export function getDb(dbPath?: string): Database.Database {
  if (_db && !dbPath) return _db;

  const resolved = dbPath || path.join(getRootDir(), 'data', 'bzxz.db');
  // 升级 / 重装可能让 $INSTDIR\data\bzxz.db 被旧卸载器抹掉（commit 0bd54c4
  // 之前的 NSIS 没保留 data/）。打开前先看一眼能不能从 userData 还原最新备份。
  // 注入路径只在生产构造路径（无显式 dbPath）时才走 —— 测试用例不应被副作用打断。
  if (!dbPath) tryRestoreDbBeforeOpen(resolved);
  const db = new Database(resolved);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  migrate(db);

  if (!dbPath) {
    _db = db;
    // Clean up expired sessions on startup
    db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
    // 异步备份当前 db 到 userData，保留最近 7 份。失败静默不阻塞启动。
    void backupDbAsync(db);
  }
  return db;
}

export function resetDbForTesting(): void {
  if (_db) { _db.close(); _db = null; }
}

function migrate(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password      TEXT NOT NULL,
      display_name  TEXT NOT NULL DEFAULT '',
      role          TEXT NOT NULL DEFAULT 'user',
      is_active     INTEGER NOT NULL DEFAULT 1,
      allowed_tabs  TEXT DEFAULT NULL,
      created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at  TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS usage_events (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      event_type  TEXT NOT NULL,
      source      TEXT,
      standard_id TEXT,
      metadata    TEXT,
      created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE INDEX IF NOT EXISTS idx_events_user_date ON usage_events(user_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_events_type_date ON usage_events(event_type, created_at);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );

    -- CNAS qualification tables
    CREATE TABLE IF NOT EXISTS cnas_labs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_no              TEXT NOT NULL UNIQUE,
      lab_name            TEXT DEFAULT '',
      base_info_id        TEXT DEFAULT '',
      cert_update_ts      TEXT DEFAULT '',
      validate            TEXT DEFAULT '',
      cached_cert_date    TEXT DEFAULT '',
      last_check_at       TEXT,
      last_sync_at        TEXT,
      next_sync_at        TEXT,
      sync_status         TEXT DEFAULT 'pending',
      sync_error          TEXT,
      record_count        INTEGER DEFAULT 0,
      subscribed_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cnas_qualifications (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_no          TEXT NOT NULL,
      std_code        TEXT NOT NULL,
      std_name        TEXT DEFAULT '',
      qual_type       TEXT DEFAULT 'CNAS',
      effective_date  TEXT DEFAULT '',
      expiry_date     TEXT DEFAULT '',
      category        TEXT DEFAULT '',
      sub_category    TEXT DEFAULT '',
      test_object     TEXT DEFAULT '',
      test_param      TEXT DEFAULT '',
      test_param_en   TEXT DEFAULT '',
      test_standard   TEXT DEFAULT '',
      std_code_en     TEXT DEFAULT '',
      limit_desc      TEXT DEFAULT '',
      branch_address  TEXT DEFAULT '',
      synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cnas_qual_std_code ON cnas_qualifications(std_code);
    CREATE INDEX IF NOT EXISTS idx_cnas_qual_lab_no ON cnas_qualifications(lab_no);
    CREATE INDEX IF NOT EXISTS idx_cnas_qual_std_lab ON cnas_qualifications(std_code, lab_no);

    CREATE TABLE IF NOT EXISTS cnas_sync_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_no          TEXT NOT NULL,
      action          TEXT NOT NULL,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at     TEXT,
      status          TEXT DEFAULT 'success',
      records_fetched INTEGER DEFAULT 0,
      error_message   TEXT
    );

    -- CMA qualification tables
    CREATE TABLE IF NOT EXISTS cma_labs (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      cert_number         TEXT NOT NULL UNIQUE,
      lab_name            TEXT DEFAULT '',
      credit_code         TEXT DEFAULT '',
      lic_sys_id          TEXT DEFAULT '',
      public_detail_id    TEXT DEFAULT '',
      address             TEXT DEFAULT '',
      area_name           TEXT DEFAULT '',
      industry            TEXT DEFAULT '',
      issue_date          TEXT DEFAULT '',
      valid_from          TEXT DEFAULT '',
      valid_to            TEXT DEFAULT '',
      cert_status         TEXT DEFAULT '',
      cached_lic_date     TEXT DEFAULT '',
      cached_update_time  INTEGER DEFAULT 0,
      last_check_at       TEXT,
      last_sync_at        TEXT,
      next_sync_at        TEXT,
      sync_status         TEXT DEFAULT 'pending',
      sync_error          TEXT,
      record_count        INTEGER DEFAULT 0,
      subscribed_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS cma_qualifications (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      cert_number     TEXT NOT NULL,
      std_code        TEXT NOT NULL,
      std_name        TEXT DEFAULT '',
      qual_type       TEXT DEFAULT 'CMA',
      effective_date  TEXT DEFAULT '',
      expiry_date     TEXT DEFAULT '',
      category        TEXT DEFAULT '',
      sub_category    TEXT DEFAULT '',
      test_item       TEXT DEFAULT '',
      test_standard   TEXT DEFAULT '',
      limit_desc      TEXT DEFAULT '',
      note            TEXT DEFAULT '',
      place_name      TEXT DEFAULT '',
      synced_at       TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cma_qual_std_code ON cma_qualifications(std_code);
    CREATE INDEX IF NOT EXISTS idx_cma_qual_cert ON cma_qualifications(cert_number);
    CREATE INDEX IF NOT EXISTS idx_cma_qual_std_cert ON cma_qualifications(std_code, cert_number);

    CREATE TABLE IF NOT EXISTS cma_sync_logs (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      cert_number     TEXT NOT NULL,
      action          TEXT NOT NULL,
      started_at      TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at     TEXT,
      status          TEXT DEFAULT 'success',
      records_fetched INTEGER DEFAULT 0,
      error_message   TEXT
    );

    CREATE TABLE IF NOT EXISTS qualification_lab_links (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      display_name    TEXT NOT NULL,
      cnas_lab_no     TEXT UNIQUE,
      cma_cert_number TEXT UNIQUE,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- Admin-authored announcements shown once per user on next entry.
    CREATE TABLE IF NOT EXISTS announcements (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      title       TEXT NOT NULL,
      content_md  TEXT NOT NULL DEFAULT '',
      created_by  INTEGER REFERENCES users(id),
      is_active   INTEGER NOT NULL DEFAULT 1,
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS announcement_reads (
      announcement_id INTEGER NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      read_at         TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (announcement_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_announcement_reads_user ON announcement_reads(user_id);

    -- 持久标准库索引（Phase 1 of 预览功能）
    -- 每行 = 一份本地 PDF。文件名永远带源后缀 "{stdCode} - {source}.pdf"，
    -- 由 library-index.ts 扫描时解析。唯一约束让同源同标准只存一份；
    -- 用户手动删文件后下次扫描会清行，预览时也会 fs.access 再校验。
    CREATE TABLE IF NOT EXISTS standard_files (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      std_code_norm  TEXT NOT NULL,           -- extractBaseCode 归一化后的标准号
      year           TEXT NOT NULL DEFAULT '',-- 单独存便于版本区分；空串表示文件名未带年份
      source         TEXT NOT NULL,           -- gbw / by / bz
      abs_path       TEXT NOT NULL,           -- 绝对路径（库根目录之内）
      file_name      TEXT NOT NULL DEFAULT '',-- path.basename(abs_path)，供下载/列表按文件名走索引
      size           INTEGER NOT NULL DEFAULT 0,
      mtime          INTEGER NOT NULL DEFAULT 0, -- 增量扫描比对依据
      mime           TEXT NOT NULL DEFAULT 'application/pdf',
      indexed_at     TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE (std_code_norm, year, source)
    );
    CREATE INDEX IF NOT EXISTS idx_standard_files_lookup ON standard_files(std_code_norm, year);
    CREATE INDEX IF NOT EXISTS idx_standard_files_source ON standard_files(source);
    CREATE INDEX IF NOT EXISTS idx_standard_files_indexed_at ON standard_files(indexed_at);

    -- exports/ 报表与旧下载残留索引。列表页读取本表分页，不再每次 readdir + 全量 stat。
    CREATE TABLE IF NOT EXISTS export_files (
      file_name       TEXT PRIMARY KEY,
      size            INTEGER NOT NULL DEFAULT 0,
      mtime           INTEGER NOT NULL DEFAULT 0,
      standard_number TEXT NOT NULL DEFAULT '',
      source          TEXT NOT NULL DEFAULT '',
      abs_path        TEXT NOT NULL DEFAULT '',
      indexed_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_export_files_mtime ON export_files(mtime DESC);
    CREATE INDEX IF NOT EXISTS idx_export_files_source ON export_files(source);

    -- labr 临时 URL 缓存：preview2 API 返回的 PDF/图片 URL 自带短期签名（~分钟级），但
    -- temp/<md5>.pdf 哈希跨 token 轮换稳定。把 (did, url, fetched_at) 落库后，下次同 did
    -- 的"已知 kind=1 资源"先用旧 url 试一发 HTTP，404/403 再去 preview2 续。这把 5/日
    -- Bearer 配额从"每次预览都消耗"摊薄到"实际过期才消耗"。
    -- did = labr 资源 dataId（probe 里看到的 i.dataId / list[0].dataId），唯一键。
    CREATE TABLE IF NOT EXISTS labr_temp_urls (
      did         INTEGER PRIMARY KEY,
      url         TEXT NOT NULL,
      fetched_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );

    -- 标准查新（见 docs/CHECK-UPDATE-AND-STATS.md）
    CREATE TABLE IF NOT EXISTS check_watchlists (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id            INTEGER NOT NULL REFERENCES users(id),
      name               TEXT NOT NULL,
      created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      last_checked_at    TEXT,
      auto_enabled       INTEGER NOT NULL DEFAULT 0,   -- 自动查新开关（0/1）
      auto_interval_days INTEGER NOT NULL DEFAULT 15,  -- 周期天数，硬下限 15
      next_run_at        TEXT,                         -- 下次自动查新时间（ISO）
      is_saved           INTEGER NOT NULL DEFAULT 0    -- 是否"我的收藏"内置清单（每用户一条、不可删）
    );
    CREATE TABLE IF NOT EXISTS check_items (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      watchlist_id     INTEGER NOT NULL REFERENCES check_watchlists(id),
      std_code         TEXT NOT NULL,
      std_code_norm    TEXT,
      base_status      TEXT,
      base_title       TEXT,
      base_impl_date   TEXT,
      base_replaced_by TEXT,
      base_snapshot_at TEXT,
      last_status      TEXT,
      last_title       TEXT,
      last_impl_date   TEXT,
      last_replaced_by TEXT,
      last_checked_at  TEXT,
      change_flags     TEXT,
      source_used      TEXT,
      new_version      TEXT,
      instead_std      TEXT,   -- 代替本标准的新标准（detail-dm insteadStd）= 被谁取代
      abolish_date     TEXT    -- 废止日期（detail-dm endData）
    );
    CREATE INDEX IF NOT EXISTS idx_check_items_wl ON check_items(watchlist_id);

    CREATE TABLE IF NOT EXISTS saved_standard_meta (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      std_code TEXT NOT NULL,
      group_name TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      downloaded INTEGER NOT NULL DEFAULT 0,
      file_name TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      PRIMARY KEY (user_id, std_code)
    );
    CREATE INDEX IF NOT EXISTS idx_saved_standard_meta_user ON saved_standard_meta(user_id);

    -- 国家 CMA 一单一库（能力项目库）镜像。
    -- 与 cma_qualifications 的区别：那张是"机构持有哪些标准的资质行"，这张是"哪些标准属于
    -- CMA 能力项目库（即能合法申请资质的政策范围）"。两者正交，diffByLab 按 std_code_norm
    -- JOIN 出 5 档比对状态（详见 src/shared/cap-lib-status.ts）。
    --
    -- source_id 当 PRIMARY KEY：远端 id 在 [1, 远端 total] 连续，直接 INSERT … ON CONFLICT 做 upsert。
    -- last_seen_at + row_hash：soft delete + hash diff，远端临时抽风不会立刻把本地数据删光，
    -- admin 手动触发"清理 30 天未见的孤儿行"才真删。
    CREATE TABLE IF NOT EXISTS cma_capability_lib (
      source_id       INTEGER PRIMARY KEY,
      domain          TEXT NOT NULL DEFAULT '',
      standard_method TEXT NOT NULL DEFAULT '',
      std_code        TEXT NOT NULL,
      std_code_norm   TEXT NOT NULL DEFAULT '',
      std_code_base   TEXT NOT NULL DEFAULT '',
      remark          TEXT DEFAULT '',
      lib_status      TEXT NOT NULL DEFAULT 'active',   -- active / cite_only / abolished
      raw_status      TEXT DEFAULT '',
      row_hash        TEXT NOT NULL DEFAULT '',
      last_seen_at    TEXT NOT NULL DEFAULT '',
      fetched_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cap_lib_norm   ON cma_capability_lib(std_code_norm);
    CREATE INDEX IF NOT EXISTS idx_cap_lib_base   ON cma_capability_lib(std_code_base);
    CREATE INDEX IF NOT EXISTS idx_cap_lib_domain ON cma_capability_lib(domain);
    CREATE INDEX IF NOT EXISTS idx_cap_lib_status ON cma_capability_lib(lib_status);

    -- 每领域同步元数据：用户勾选订阅 + 上次同步时间 + 上次远端 total + 上次同步统计（JSON）。
    -- 取消订阅不删主表数据（重订阅时复用），只是 UI 不再让用户主动刷该领域。
    CREATE TABLE IF NOT EXISTS cma_capability_lib_meta (
      domain          TEXT PRIMARY KEY,
      subscribed      INTEGER NOT NULL DEFAULT 0,
      last_synced_at  TEXT DEFAULT '',
      remote_total    INTEGER DEFAULT 0,
      local_total     INTEGER DEFAULT 0,
      last_sync_stats TEXT DEFAULT ''
    );

    -- cma-diff 标准号黑名单：表格合并显示导致的非标准号脏内容，加入后既不显示也不参与匹配。
    -- 按 std_code_norm 命中（跨年变体都中）；norm 为空时回退原始 std_code 精确匹配。
    CREATE TABLE IF NOT EXISTS cma_diff_blacklist (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      std_code      TEXT NOT NULL,
      std_code_norm TEXT NOT NULL DEFAULT '',
      reason        TEXT DEFAULT '',
      created_at    TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_cma_blacklist_norm ON cma_diff_blacklist(std_code_norm);

    -- cma-diff 手动映射：用户把机构资质标准号(src_norm)人工指向库内标准号(lib_norm)，
    -- 覆盖自动判定（解决未入库实为同号不同写法/库里换号的人工兜底）。
    -- cert_number 空=全局映射；非空=仅该机构。UNIQUE(cert_number, src_norm) 一个号一条。
    CREATE TABLE IF NOT EXISTS cma_diff_manual_map (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      cert_number   TEXT NOT NULL DEFAULT '',
      src_norm      TEXT NOT NULL,
      lib_norm      TEXT NOT NULL,
      created_at    TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(cert_number, src_norm)
    );
    CREATE INDEX IF NOT EXISTS idx_cma_manualmap_src ON cma_diff_manual_map(src_norm);
  `);

  // Schema migrations: add columns that may be missing on older DBs.
  // We check column existence first so genuine SQL errors (file perms, disk, etc.) surface
  // instead of being swallowed by a blanket try/catch.
  addColumnIfMissing(db, 'users',    'allowed_tabs',    "TEXT DEFAULT NULL");
  addColumnIfMissing(db, 'cma_labs', 'public_detail_id', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cma_labs', 'address',          "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cma_labs', 'area_name',        "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cma_labs', 'industry',         "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cma_labs', 'issue_date',       "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cma_labs', 'valid_from',       "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cma_labs', 'valid_to',         "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cma_labs', 'cert_status',      "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cnas_labs', 'url_params',      "TEXT DEFAULT '{}'");
  addColumnIfMissing(db, 'cnas_labs', 'other_names',     "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cnas_labs', 'org_address',     "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cnas_labs', 'validity_period', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cnas_labs', 'cert_tasks',      "TEXT DEFAULT '[]'");
  // 标准查新：new_version 列在中途版本可能缺（建表版先于本列），幂等补一下。
  addColumnIfMissing(db, 'check_items', 'new_version',   'TEXT DEFAULT NULL');
  addColumnIfMissing(db, 'check_items', 'instead_std',   'TEXT DEFAULT NULL'); // 被谁代替（detail-dm）
  addColumnIfMissing(db, 'check_items', 'abolish_date',  'TEXT DEFAULT NULL'); // 废止日期
  // 自动查新（Step 2）：旧库补列。
  addColumnIfMissing(db, 'check_watchlists', 'auto_enabled',       'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'check_watchlists', 'auto_interval_days', 'INTEGER NOT NULL DEFAULT 15');
  addColumnIfMissing(db, 'check_watchlists', 'next_run_at',        'TEXT DEFAULT NULL');
  addColumnIfMissing(db, 'check_watchlists', 'is_saved',           'INTEGER NOT NULL DEFAULT 0'); // 我的收藏内置清单
  addColumnIfMissing(db, 'standard_files', 'file_name', "TEXT NOT NULL DEFAULT ''");
  addColumnIfMissing(db, 'standard_files', 'etag',      "TEXT DEFAULT ''"); // 弱 ETag，304 快速缓存验证

  // 资质标准号归一化列（Step 2-3）：把脏空格/全角/无空格/ISO 冒号变体在写入时落成统一形态，
  // 让 queryByStdCodes / searchQualifications 用索引等值查询，不再需要 LIKE + LIMIT 兜底。
  // - std_code_norm = extractFullCode(std_code) 保留年份，用于"同号同年"精确匹配
  // - std_code_base = extractBaseCode(std_code) 剥年份，用于"同号跨年"模糊兜底
  addColumnIfMissing(db, 'cnas_qualifications', 'std_code_norm', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cnas_qualifications', 'std_code_base', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cma_qualifications',  'std_code_norm', "TEXT DEFAULT ''");
  addColumnIfMissing(db, 'cma_qualifications',  'std_code_base', "TEXT DEFAULT ''");

  // 使用统计增强（见 docs/CHECK-UPDATE-AND-STATS.md）：补 5 列。旧行新列为 NULL，安全。
  //   ip/hostname/client = 客户端上下文（hostname 仅桌面端有值）
  //   result = 'success' | 'fail'（NULL=旧数据/未标）；error = 失败原因+日志摘要
  addColumnIfMissing(db, 'usage_events', 'ip',       'TEXT DEFAULT NULL');
  addColumnIfMissing(db, 'usage_events', 'hostname', 'TEXT DEFAULT NULL');
  addColumnIfMissing(db, 'usage_events', 'client',   'TEXT DEFAULT NULL');
  addColumnIfMissing(db, 'usage_events', 'result',   'TEXT DEFAULT NULL');
  addColumnIfMissing(db, 'usage_events', 'error',    'TEXT DEFAULT NULL');
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_cnas_qual_norm ON cnas_qualifications(std_code_norm);
    CREATE INDEX IF NOT EXISTS idx_cnas_qual_base ON cnas_qualifications(std_code_base);
    CREATE INDEX IF NOT EXISTS idx_cma_qual_norm  ON cma_qualifications(std_code_norm);
    CREATE INDEX IF NOT EXISTS idx_cma_qual_base  ON cma_qualifications(std_code_base);
    CREATE INDEX IF NOT EXISTS idx_standard_files_file_name ON standard_files(file_name);
    CREATE INDEX IF NOT EXISTS idx_standard_files_indexed_at ON standard_files(indexed_at);
  `);
  runMigration(db, 2026071801, () => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_usage_source_result_created
        ON usage_events(source, result, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_export_files_name_mtime
        ON export_files(file_name, mtime DESC);
      CREATE INDEX IF NOT EXISTS idx_standard_files_norm_indexed
        ON standard_files(std_code_norm, indexed_at DESC);
    `);
  });
  runMigration(db, 2026081401, () => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_cnas_qual_norm_date
        ON cnas_qualifications(std_code_norm, effective_date DESC, id);
      CREATE INDEX IF NOT EXISTS idx_cma_qual_norm_date
        ON cma_qualifications(std_code_norm, effective_date DESC, id);
      CREATE INDEX IF NOT EXISTS idx_cnas_labs_name ON cnas_labs(lab_name);
      CREATE INDEX IF NOT EXISTS idx_cma_labs_name ON cma_labs(lab_name);

      CREATE VIRTUAL TABLE IF NOT EXISTS qualification_search_fts USING fts5(
        source UNINDEXED,
        qualification_id UNINDEXED,
        std_code,
        std_name,
        category,
        test_object,
        test_param,
        test_standard,
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS trg_cnas_qual_fts_insert AFTER INSERT ON cnas_qualifications BEGIN
        INSERT INTO qualification_search_fts(source, qualification_id, std_code, std_name, category, test_object, test_param, test_standard)
        VALUES ('CNAS', new.id, new.std_code, new.std_name, new.category, new.test_object, new.test_param, new.test_standard);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_cnas_qual_fts_delete AFTER DELETE ON cnas_qualifications BEGIN
        DELETE FROM qualification_search_fts WHERE source = 'CNAS' AND qualification_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_cnas_qual_fts_update AFTER UPDATE ON cnas_qualifications BEGIN
        DELETE FROM qualification_search_fts WHERE source = 'CNAS' AND qualification_id = old.id;
        INSERT INTO qualification_search_fts(source, qualification_id, std_code, std_name, category, test_object, test_param, test_standard)
        VALUES ('CNAS', new.id, new.std_code, new.std_name, new.category, new.test_object, new.test_param, new.test_standard);
      END;

      CREATE TRIGGER IF NOT EXISTS trg_cma_qual_fts_insert AFTER INSERT ON cma_qualifications BEGIN
        INSERT INTO qualification_search_fts(source, qualification_id, std_code, std_name, category, test_object, test_param, test_standard)
        VALUES ('CMA', new.id, new.std_code, new.std_name, new.category, '', new.test_item, new.test_standard);
      END;
      CREATE TRIGGER IF NOT EXISTS trg_cma_qual_fts_delete AFTER DELETE ON cma_qualifications BEGIN
        DELETE FROM qualification_search_fts WHERE source = 'CMA' AND qualification_id = old.id;
      END;
      CREATE TRIGGER IF NOT EXISTS trg_cma_qual_fts_update AFTER UPDATE ON cma_qualifications BEGIN
        DELETE FROM qualification_search_fts WHERE source = 'CMA' AND qualification_id = old.id;
        INSERT INTO qualification_search_fts(source, qualification_id, std_code, std_name, category, test_object, test_param, test_standard)
        VALUES ('CMA', new.id, new.std_code, new.std_name, new.category, '', new.test_item, new.test_standard);
      END;

      DELETE FROM qualification_search_fts;
      INSERT INTO qualification_search_fts(source, qualification_id, std_code, std_name, category, test_object, test_param, test_standard)
        SELECT 'CNAS', id, std_code, std_name, category, test_object, test_param, test_standard FROM cnas_qualifications;
      INSERT INTO qualification_search_fts(source, qualification_id, std_code, std_name, category, test_object, test_param, test_standard)
        SELECT 'CMA', id, std_code, std_name, category, '', test_item, test_standard FROM cma_qualifications;
    `);
  });
  backfillStandardFileNames(db);
  backfillNormalizedStdCodes(db);
  fixupDirtyStdCodes(db);
  renormalizeOnAlgoBump(db);

  cleanupLegacyCmaData(db);

  ensureGuestUser(db);

  // Seed defaults
  const regEnabled = db.prepare("SELECT value FROM settings WHERE key = 'registration_enabled'").get();
  if (!regEnabled) {
    db.prepare("INSERT INTO settings (key, value) VALUES ('registration_enabled', '1')").run();
  }
  const qualDefaults: [string, string][] = [
    ['qual_sync_enabled', '1'],
    ['qual_sync_cron', '0 3 * * 0'],
    ['qual_sync_concurrency', '1'],
    // 标准库 / 预览功能（Phase 1）：
    // - standards_library_dir 空字符串代表"使用默认值"，由 library-paths.ts 启动时
    //   填入 exe 同级 /standards。用户在设置里改成绝对路径会覆盖默认。
    // - library_filename_pattern 文件名模板，支持 {stdCode}/{source}/{year}/{title}。
    //   默认 "{stdCode} {title} - {source}" 带源后缀（决策见 CHANGELOG），不写扩展名（永远 .pdf）。
    //   labr 接入后改默认含 {title}：labr 资源标题是检索结果唯一区分项（同一 stdCode 可能有
    //   多份不同 title 的 PDF / 图片），文件名不带 title 会用 UNIQUE(std_code_norm, year, source)
    //   把后下载的覆盖掉。BW/BZ/BY 由 renderLibraryFilename 对空 title 容错（连分隔符一起删），
    //   旧文件名形态向后兼容。
    ['standards_library_dir', ''],
    ['library_filename_pattern', '{stdCode} {title} - {source}'],
    // library_source_priority：JSON 数组形式存储，源按优先级排列；preview-routes/admin-routes
    // 用 parseSourcePriority 解析。默认顺序与 DEFAULT_SOURCE_PRIORITY 对齐（gbw > bz > by）。
    ['library_source_priority', '["gbw","bz","by"]'],
    // Phase 2：chokidar 监听库目录，新增/改/删自动同步索引。默认开启；
    // Windows + OneDrive 出问题时可在 admin 设置里临时关。
    ['library_watcher_enabled', '1'],
    // 自动同步调度器：
    ['autosync_enabled', '0'],
    ['autosync_qual_cron', '0 3 * * 0'],
    ['autosync_caplib_cron', '0 3 * * *'],
    ['autosync_qual_enabled', '1'],
    ['autosync_caplib_enabled', '1'],
  ];
  for (const [k, v] of qualDefaults) {
    const existing = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
    if (!existing) db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run(k, v);
  }

  // 一次性默认值升级：原默认 '{stdCode} - {source}' → '{stdCode} {title} - {source}'。
  // 只在 DB 里"现存值刚好是旧默认"时升（说明用户没动过设置）；用户在 admin 改过的
  // pattern 不动 —— 即便他们改成空 title 形态也保留意愿。labr 资源依然能下，因为
  // renderLibraryFilename 对空 title 容错。
  db.prepare(`
    UPDATE settings SET value = ? WHERE key = 'library_filename_pattern' AND value = ?
  `).run('{stdCode} {title} - {source}', '{stdCode} - {source}');

  // 国家 CMA 一单一库：把 11 个顶层领域种到 meta 表，subscribed 默认 0 让用户进入页面后再勾。
  // INSERT OR IGNORE 幂等，旧库升级不会覆盖用户已订阅的状态。领域名是固定常量
  // （详见 src/shared/cap-lib-domains.ts），多年未变；远端新增领域时手动加常量 + 跑迁移即可。
  {
    // 注：这里硬写 11 个名，而不是 import CAP_LIB_DOMAINS —— db.ts 处于底层，
    // shared/ 也底层，但避免循环依赖风险（cap-lib-domains 极轻，未来如要 import 也无害）。
    // 与 cap-lib-domains.ts 必须同步。如增删领域，两处一起改。
    const CAP_LIB_DOMAIN_INIT = [
      '产品质量检验', '食品检验', '农产品质量检验', '医疗器械检验', '生态环境监测',
      '司法鉴定检测', '进出口商品检验', '林业产品质量检验', '化妆品检验',
      '机动车排放、安全技术检验', '林木种子、草种质量检验',
    ];
    const ins = db.prepare('INSERT OR IGNORE INTO cma_capability_lib_meta (domain) VALUES (?)');
    for (const name of CAP_LIB_DOMAIN_INIT) ins.run(name);
  }
}

function addColumnIfMissing(db: Database.Database, table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}

function runMigration(db: Database.Database, version: number, fn: () => void): void {
  const applied = db.prepare('SELECT 1 FROM schema_migrations WHERE version = ?').get(version);
  if (applied) return;
  const txn = db.transaction(() => {
    fn();
    db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(version);
  });
  txn();
}

/**
 * standard_files.file_name 是从 abs_path 派生出来的索引列。旧库升级或早期版本
 * rename 只改 abs_path 时，都用这个轻量回填修正，避免 /api/downloads/:filename
 * 退回全表 LIKE。
 */
function backfillStandardFileNames(db: Database.Database): void {
  const rows = db.prepare(`
    SELECT id, abs_path, file_name
    FROM standard_files
  `).all() as Array<{ id: number; abs_path: string; file_name: string }>;
  const dirty = rows
    .map((row) => ({ id: row.id, fileName: path.basename(row.abs_path || '') }))
    .filter((row, idx) => row.fileName && row.fileName !== rows[idx].file_name);
  if (dirty.length === 0) return;

  const update = db.prepare('UPDATE standard_files SET file_name = ? WHERE id = ?');
  const txn = db.transaction((chunk: typeof dirty) => {
    for (const row of chunk) update.run(row.fileName, row.id);
  });
  const CHUNK = 1000;
  for (let i = 0; i < dirty.length; i += CHUNK) {
    txn(dirty.slice(i, i + CHUNK));
  }
}

/**
 * 把 cnas_qualifications / cma_qualifications 里 std_code_norm 还为空的旧行回填一次。
 *
 * 触发场景：列刚被 addColumnIfMissing 加上、或者上一版没回填完跑到一半挂掉。
 * 已经回填过的行（std_code_norm != ''）不会被重跑，所以幂等。回填本身只算
 * 字符串、不查网络、不发请求，几万行也只几百毫秒。
 *
 * 不做的事：跨进程并发保护 —— migrate() 在启动期单进程跑，且后续 INSERT 自带
 * std_code_norm，二者不会撞车。
 */
function backfillNormalizedStdCodes(db: Database.Database): void {
  for (const table of ['cnas_qualifications', 'cma_qualifications'] as const) {
    const rows = db.prepare(`
      SELECT id, std_code FROM ${table}
      WHERE COALESCE(std_code_norm, '') = ''
    `).all() as Array<{ id: number; std_code: string }>;
    if (rows.length === 0) continue;

    const update = db.prepare(`UPDATE ${table} SET std_code_norm = ?, std_code_base = ? WHERE id = ?`);
    const txn = db.transaction((chunk: typeof rows) => {
      for (const r of chunk) {
        update.run(extractFullCode(r.std_code), extractBaseCode(r.std_code), r.id);
      }
    });
    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      txn(rows.slice(i, i + CHUNK));
    }
    console.log(`[db] backfilled ${rows.length} ${table} rows with std_code_norm / std_code_base`);
  }
}

/**
 * 一次性把历史脏 std_code 清洗成干净形态：'GB/T 3325 -2024' → 'GB/T 3325-2024'。
 *
 * 触发场景：升级到 Step 6 前 CNAS 抓取写入的 std_code 含年份连字符附近多空格，
 * 让 `std_code LIKE '%3325-%'` 这种子串搜索漏命中。新版抓取已经在 INSERT 前调
 * cleanStdCode，但**老数据还停在脏形态**，这里把它们一次性 update 干净，同步
 * 重算 std_code_norm / std_code_base（虽然两个归一化列对脏数据本来就有正确值，
 * 重算只是确保一致）。幂等：清洗后 cleanStdCode(x) === x 的行下次启动会被
 * `WHERE std_code != cleanStdCode(std_code)` 过滤掉。
 */
function fixupDirtyStdCodes(db: Database.Database): void {
  for (const table of ['cnas_qualifications', 'cma_qualifications'] as const) {
    // SQL 侧粗筛：含 ' -' 或 '- ' 的行才需要清洗。把全表扫范围压到几百行级别。
    const candidates = db.prepare(`
      SELECT id, std_code FROM ${table}
      WHERE std_code LIKE '% -%' OR std_code LIKE '%- %'
    `).all() as Array<{ id: number; std_code: string }>;
    if (candidates.length === 0) continue;

    // JS 侧精筛：cleanStdCode 后真有改变的行才 update（SQL LIKE 会误匹标题里的 "GB - 2024" 之类）
    const dirty = candidates
      .map(r => ({ id: r.id, std_code: r.std_code, cleaned: cleanStdCode(r.std_code) }))
      .filter(r => r.cleaned !== r.std_code);
    if (dirty.length === 0) continue;

    const update = db.prepare(
      `UPDATE ${table} SET std_code = ?, std_code_norm = ?, std_code_base = ? WHERE id = ?`,
    );
    const txn = db.transaction((chunk: typeof dirty) => {
      for (const r of chunk) {
        update.run(r.cleaned, extractFullCode(r.cleaned), extractBaseCode(r.cleaned), r.id);
      }
    });
    const CHUNK = 1000;
    for (let i = 0; i < dirty.length; i += CHUNK) {
      txn(dirty.slice(i, i + CHUNK));
    }
    console.log(`[db] cleaned ${dirty.length} ${table} rows with whitespace around year suffix (e.g. 'GB/T 3325 -2024' → 'GB/T 3325-2024')`);
  }
}

/**
 * 归一化算法升级后，对已有行强制重算 std_code_norm / std_code_base（版本号 gate，幂等）。
 *
 * Why：backfillNormalizedStdCodes 只填空行，已落库的旧 norm（用旧算法算的）不会被刷新。
 * 改 extractFullCode / preNormalize（如剥年份后条款/附录后缀、剥全角问号）后，旧行的 norm
 * 仍是脏值 → 徽章/diff 漏命中。这里按 STD_CODE_ALGO_VERSION 触发一次性全量重算：版本不变不跑，
 * 版本 bump 后跑一次并写回新版本号。覆盖 cnas/cma 资质 + cma_capability_lib（一单一库）三张表。
 *
 * 改 std-code 归一化逻辑后必须 +1 此版本号（CLAUDE.md 归一化契约：改算法须触发回填）。
 */
const STD_CODE_ALGO_VERSION = '2';
function renormalizeOnAlgoBump(db: Database.Database): void {
  if (getSetting(db, 'std_code_algo_version', '1') === STD_CODE_ALGO_VERSION) return;

  const tables: Array<{ name: string; idCol: string; hasTable: boolean }> = [
    { name: 'cnas_qualifications', idCol: 'id', hasTable: true },
    { name: 'cma_qualifications', idCol: 'id', hasTable: true },
    { name: 'cma_capability_lib', idCol: 'source_id', hasTable: !!db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='cma_capability_lib'").get() },
  ];
  for (const t of tables) {
    if (!t.hasTable) continue;
    const rows = db.prepare(`SELECT ${t.idCol} AS id, std_code FROM ${t.name} WHERE COALESCE(std_code, '') <> ''`)
      .all() as Array<{ id: number; std_code: string }>;
    if (!rows.length) continue;
    const update = db.prepare(`UPDATE ${t.name} SET std_code_norm = ?, std_code_base = ? WHERE ${t.idCol} = ?`);
    const txn = db.transaction((chunk: typeof rows) => {
      for (const r of chunk) update.run(extractFullCode(r.std_code), extractBaseCode(r.std_code), r.id);
    });
    const CHUNK = 2000;
    for (let i = 0; i < rows.length; i += CHUNK) txn(rows.slice(i, i + CHUNK));
    console.log(`[db] re-normalized ${rows.length} ${t.name} rows (algo v${STD_CODE_ALGO_VERSION})`);
  }
  setSetting(db, 'std_code_algo_version', STD_CODE_ALGO_VERSION);
}

function cleanupLegacyCmaData(db: Database.Database): void {
  db.exec(`
    DELETE FROM cma_qualifications
    WHERE cert_number IN (
      SELECT cert_number FROM cma_labs
      WHERE COALESCE(public_detail_id, '') = ''
        AND (length(cert_number) >= 18 OR cert_number GLOB '*[A-Za-z]*')
    );

    DELETE FROM cma_labs
    WHERE COALESCE(public_detail_id, '') = ''
      AND (length(cert_number) >= 18 OR cert_number GLOB '*[A-Za-z]*');

    DELETE FROM cma_qualifications
    WHERE (length(cert_number) >= 18 OR cert_number GLOB '*[A-Za-z]*')
      AND cert_number NOT IN (SELECT cert_number FROM cma_labs);
  `);
}

function ensureGuestUser(db: Database.Database): void {
  // 所有可用 tab 的完整列表
  const ALL_TABS = ['search', 'qual', 'cap-lib', 'labr', 'library', 'check', 'stats', 'settings', 'batch', 'complete'];
  const DEFAULT_GUEST_TABS = JSON.stringify(ALL_TABS);
  const existing = db.prepare('SELECT id, allowed_tabs FROM users WHERE username = ?').get(GUEST_USERNAME) as { id: number; allowed_tabs: string | null } | undefined;
  if (!existing) {
    db.prepare(
      'INSERT INTO users (username, password, display_name, role, is_active, allowed_tabs) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(GUEST_USERNAME, GUEST_PASSWORD_SENTINEL, GUEST_DISPLAY_NAME, 'user', 1, DEFAULT_GUEST_TABS);
    return;
  }
  // Refresh metadata, always sync guest tabs to full list
  db.prepare(
    'UPDATE users SET display_name = ?, role = ?, is_active = 1, allowed_tabs = ? WHERE username = ?'
  ).run(GUEST_DISPLAY_NAME, 'user', DEFAULT_GUEST_TABS, GUEST_USERNAME);
}

export function getRealUserCount(db: Database.Database): number {
  return (db.prepare('SELECT COUNT(*) as cnt FROM users WHERE username <> ?').get(GUEST_USERNAME) as { cnt: number }).cnt;
}

export function getSetting(db: Database.Database, key: string, defaultValue = ''): string {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? defaultValue;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?").run(key, value, value);
}

export function setSettings(db: Database.Database, entries: Iterable<readonly [string, string]>): void {
  const values = Array.from(entries);
  if (values.length === 0) return;
  const upsert = db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  db.transaction(() => {
    for (const [key, value] of values) upsert.run(key, value);
  })();
}
