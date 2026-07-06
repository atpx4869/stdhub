/**
 * DB 自动备份 + 缺失自愈
 *
 * - 备份位置：data/backups/
 * - 启动时若 db 不存在或 0 字节 → 从最新 backup 还原
 * - 启动正常完成后异步生成新备份，保留最近 N 份，更老的删掉
 *
 * 用 better-sqlite3 的 db.backup() API（online backup，对 WAL 安全）。
 */
import { existsSync, mkdirSync, statSync, readdirSync, copyFileSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';

const BACKUP_DIR_NAME = 'bzxz-db-backups';
const KEEP_BACKUPS = 7;

function getBackupDir(): string {
  return path.join(process.cwd(), 'data', 'backups');
}

/**
 * 检查 dbPath 处的文件状态。空 / 不存在 / 损坏 → 返回 true（表示需要尝试还原）。
 * SQLite 文件最小有效大小约 100 字节（header）；小于这个值视为坏。
 */
function dbFileNeedsRestore(dbPath: string): boolean {
  if (!existsSync(dbPath)) return true;
  try {
    const stat = statSync(dbPath);
    if (stat.size < 100) return true;
  } catch {
    return true;
  }
  return false;
}

/**
 * 列出 backup 目录下所有备份，按时间戳新→旧排序。
 * 文件名格式：bzxz-YYYYMMDD-HHmmss.db
 */
function listBackups(backupDir: string): string[] {
  if (!existsSync(backupDir)) return [];
  try {
    return readdirSync(backupDir)
      .filter(n => /^bzxz-\d{8}-\d{6}\.db$/.test(n))
      .sort()
      .reverse();
  } catch {
    return [];
  }
}

/**
 * 在 new Database(dbPath) **之前**调用。若 dbPath 缺失或 0 字节，从最新 backup
 * 复制过来；找不到 backup 则什么都不做，让上层走"全新 db"的初始化路径（首次
 * 注册用户即管理员）。
 *
 * 返回 true 表示发生了还原，调用方可以打 audit log。
 */
export function tryRestoreDbBeforeOpen(dbPath: string): boolean {
  try {
    if (!dbFileNeedsRestore(dbPath)) return false;
    const backupDir = getBackupDir();
    const backups = listBackups(backupDir);
    if (backups.length === 0) {
      // 无备份可还原；如果是装机版升级导致丢失，这是无法恢复的伤害（已发生）。
      // 不报错，让程序继续启动，用户至少能重新注册。
      return false;
    }
    const latest = path.join(backupDir, backups[0]);
    mkdirSync(path.dirname(dbPath), { recursive: true });
    copyFileSync(latest, dbPath);
    console.warn(`[db-backup] 检测到 db 缺失或损坏，已从备份还原: ${backups[0]}`);
    return true;
  } catch (err) {
    console.warn('[db-backup] 还原失败（不影响启动）:', err);
    return false;
  }
}

/**
 * 启动后异步生成新备份；保留最近 KEEP_BACKUPS 份，更老的删除。
 * 用 better-sqlite3 的 db.backup() —— 它是 SQLite Online Backup API 包装，
 * 对 WAL 模式 / 正在写入的 db 都安全。
 *
 * 失败静默，备份只是 nice-to-have，不能阻塞应用启动。
 */
export async function backupDbAsync(db: Database.Database): Promise<void> {
  try {
    const backupDir = getBackupDir();
    mkdirSync(backupDir, { recursive: true });

    const now = new Date();
    const yyyy = now.getFullYear();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const dd = String(now.getDate()).padStart(2, '0');
    const hh = String(now.getHours()).padStart(2, '0');
    const mi = String(now.getMinutes()).padStart(2, '0');
    const ss = String(now.getSeconds()).padStart(2, '0');
    const target = path.join(backupDir, `bzxz-${yyyy}${mm}${dd}-${hh}${mi}${ss}.db`);

    // 同名文件已存在（一分钟内连开两次）→ 跳过
    if (existsSync(target)) return;

    await db.backup(target);
    console.log(`[db-backup] 备份完成: ${path.basename(target)}`);

    // 清理过期备份
    const all = listBackups(backupDir);
    if (all.length > KEEP_BACKUPS) {
      for (const old of all.slice(KEEP_BACKUPS)) {
        try { unlinkSync(path.join(backupDir, old)); } catch { /* ignore */ }
      }
    }
  } catch (err) {
    console.warn('[db-backup] 备份失败（不影响应用运行）:', err);
  }
}

/**
 * 管理面板 / 诊断接口可用。返回当前所有备份的元数据。
 */
export function listBackupInfo(): Array<{ name: string; size: number; mtime: string; path: string }> {
  const backupDir = getBackupDir();
  const names = listBackups(backupDir);
  return names.map(n => {
    const p = path.join(backupDir, n);
    try {
      const st = statSync(p);
      return { name: n, size: st.size, mtime: st.mtime.toISOString(), path: p };
    } catch {
      return { name: n, size: 0, mtime: '', path: p };
    }
  });
}
