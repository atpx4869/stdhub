// 标准库扫描与索引服务（Phase 1 + Phase 2 of 预览功能）
//
// 职责：
// 1. 扫描 standards_library_dir，把目录里的 PDF 解析成 (stdCode, year, source) 入索引
// 2. 增量扫描比对 mtime，仅重读变化项
// 3. 提供 lookupFile() 给预览端点用
// 4. (P2) addFileToLibrary —— 下载流成功后把 exports/ 里的 PDF copy 进库
// 5. (P2) startLibraryWatcher —— chokidar 监听库目录，实时同步索引
//
// 设计变更（P2）：
// - watcher 默认开启（settings.library_watcher_enabled）。Windows + OneDrive
//   可能漏事件 —— 所以"启动扫描 + watcher + 手动重扫"三层兜底，互不替代。

import path from 'node:path';
import { promises as fs } from 'node:fs';
import type Database from 'better-sqlite3';
import { extractBaseCode } from './qualification-service';
import { resolveLibraryDir, isInsideLibrary, resolveSafeLibraryFile, resolveSafeLibraryTarget } from '../shared/library-paths';
import { renderLibraryFilenameWithExt } from './library-naming';
import { MIN_PDF_BYTES } from '../shared/download-integrity';
import { getSetting } from './db';
import type { SourceName } from '../domain/standard';

const SUPPORTED_SOURCES: ReadonlyArray<SourceName> = ['gbw', 'bz', 'by', 'labr'];

// 文件名后缀里写的源名（用户可见标签）↔ 内部 canonical source。
// 命名时用 LABEL（"BW 国标网"出现在 UI），索引和 API 用 canonical。
// LB = labr 库（独立 sidebar 入口，但产出落到统一 standards_library_dir）
const SOURCE_LABEL_TO_CANONICAL: Record<string, SourceName> = {
  BW: 'gbw', GBW: 'gbw',
  BZ: 'bz',
  BY: 'by',
  LB: 'labr', LABR: 'labr',
};
const CANONICAL_TO_LABEL: Record<SourceName, string> = {
  gbw: 'BW',
  bz: 'BZ',
  by: 'BY',
  labr: 'LB',
};

// labr 可能落非 PDF（docx/xlsx/pptx），需要按扩展名给 MIME；其它 ext 兜 octet-stream。
const EXT_MIME: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  txt: 'text/plain',
  zip: 'application/zip',
};
function extToMime(ext: string): string {
  return EXT_MIME[ext.toLowerCase()] || 'application/octet-stream';
}

/**
 * 弱 ETag（size + mtime 十六进制），与 preview-routes 的 304 校验口径一致。
 * 入库/扫描/监听时预计算存 standard_files.etag，file 端点的 304 快速路径
 * 直接查 DB 比对，避免每次缓存验证都做 fs.access + lstat + realpath + stat。
 */
export function computeFileEtag(size: number, mtimeMs: number): string {
  return `W/"${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}"`;
}

export function sourceLabel(source: SourceName): string {
  return CANONICAL_TO_LABEL[source];
}

export interface LibraryFileRow {
  id: number;
  stdCodeNorm: string;
  year: string;
  source: SourceName;
  absPath: string;
  size: number;
  mtime: number;
  mime: string;
  indexedAt: string;
}

interface ParsedFilename {
  stdCodeRaw: string;
  stdCodeNorm: string;
  year: string;
  source: SourceName;
  /** 标题（仅在新格式 `{stdCode} {title} - {source}.pdf` 时非空）。
   *  目前 scanLibrary 不消费，但 labr 接入后 title 是文件名第一公民，预留字段。 */
  title: string;
}

/**
 * 标准号"头部"匹配：从字符串开头吃掉 `<prefix> <数字>[.数字]*[-YYYY[修订字母]]?`。
 *
 * 覆盖的形态（保留正则在这里方便对照修改）：
 *   "GB 3324-2024"        — 最常见
 *   "GB/T 3324-2024"      — 含 / 分隔（labr 文件名里写作 _）
 *   "DB44/T 2107-2018"    — prefix 含数字（DB44 = letters+digits）
 *   "JB/T 4730.5-2005"    — 标准号本体有 `.5` 分部
 *   "GB/T 3836-2010A"     — 年份带修订字母
 *   "ISO 4287-1997"       — 国际标准号
 *   "JJG 196-2006"        — 检定规程
 *   "GB 3324"             — 无年份
 *
 * 不匹配：'/' 必须先被 `_ → /` 还原（文件名里写作 `_`）；中文 / 非 ASCII 字符开头一律
 * 不算 stdCode（视作 title 起点）。捕获组 1=整个 stdCode 头，2=4 位年份（可能 undefined）。
 */
const STD_CODE_HEAD_RE = /^([A-Z][A-Z0-9]*(?:\/[A-Z][A-Z0-9]*)?\s+\d+(?:\.\d+)*(?:\s*-\s*(\d{4})[A-Z]?)?)/;

/**
 * 解析库文件名。支持两种格式（V2 后向兼容）：
 *
 *   旧：`{stdCode} - {sourceLabel}.pdf`            — V1 / 三源（BW/BZ/BY）历史文件
 *     "GB_T 3324-2024 - BW.pdf"
 *     "JJG 196-2006 - BZ.pdf"
 *
 *   新：`{stdCode} {title} - {sourceLabel}.pdf`    — V2 默认 pattern，含 labr
 *     "GB_T 3324-2024 木家具通用技术条件 - LB.pdf"
 *     "GB_T 3324-2024 木家具通用技术条件 - BW.pdf" (用户改默认 pattern 后)
 *
 * 解析流程：
 *   1. 剥 `.pdf` 后缀
 *   2. 从右侧匹配 ` - {LABEL}` 提源（锚定结尾避免标题里含 " - XX" 误判）
 *   3. 把 `_` 还原成 `/` 让 std-code 模块认识
 *   4. 从开头用 STD_CODE_HEAD_RE 抠 stdCode 头部，剩余部分 trim 后即 title
 *   5. 年份从正则捕获组直接拿（不依赖字符串结尾，因为新格式末尾是 title 不是 year）
 *
 * 兼容：
 * - 文件名里的 `_` 视作 `/`（写入时 `/` 被替换成 `_`）
 * - sourceLabel 大小写不敏感
 *
 * 返回 null 表示文件名不符合库格式，扫描时忽略（用户可能手动塞了别的 PDF）。
 */
export function parseLibraryFilename(name: string): ParsedFilename | null {
  if (!name.toLowerCase().endsWith('.pdf')) return null;
  const stem = name.slice(0, -4);

  // 从右侧匹配 ` - {SOURCE}` 或 ` {SOURCE}`；锚定结尾避免标题里有 " - XX" 误匹配。
  // 分隔符允许 `-` / `—` 或纯空格 —— 后者用于救回 #73 早期 bug 砸坏的文件：
  // V1 老文件 `GB_T 24456-2009 - BW.pdf` 曾被错误渲染成 `GB_T 24456-2009 BW.pdf`，
  // 严格要求 `-` 会让它"无法解析"卡死（既不入索引也用不上 rename / normalize）。
  // 放宽后 scanLibrary 重新捡起，「统一命名」按 V2 pattern 渲染时会自动补回 ` - `。
  // 副作用：source label 只有 4 个（BW/BZ/BY/LB），手塞文件名结尾恰好命中的概率极低。
  const sourceMatch = stem.match(/^(.+?)(?:\s*[-—]\s*|\s+)([A-Za-z]+)\s*$/);
  if (!sourceMatch) return null;
  const sourceRaw = sourceMatch[2].toUpperCase();
  const source = SOURCE_LABEL_TO_CANONICAL[sourceRaw];
  if (!source) return null;

  // body = 剥源后的全部内容。可能是单纯 stdCode（旧格式）或 "stdCode title"（新格式）。
  const body = sourceMatch[1].trim();
  if (!body) return null;

  // 把 _ 换回 / 让 STD_CODE_HEAD_RE 和 extractBaseCode 能识别 /T、/Z 等
  const bodyWithSlash = body.replace(/_/g, '/');

  // 从开头匹配 stdCode head；匹不到说明不是规范标准号，整个文件忽略
  const headMatch = bodyWithSlash.match(STD_CODE_HEAD_RE);
  if (!headMatch) return null;

  const stdCodeRaw = headMatch[1].trim();
  const year = headMatch[2] || '';
  const title = bodyWithSlash.slice(headMatch[0].length).trim();

  const stdCodeNorm = extractBaseCode(stdCodeRaw);
  if (!stdCodeNorm) return null;

  return { stdCodeRaw, stdCodeNorm, year, source, title };
}

/**
 * 构造库文件名（写入时用）：把 `/` 替换为 `_`，过滤非法字符，加 source 后缀。
 * 文件名里始终带源后缀（决策见 CHANGELOG 与 docs/PREVIEW.md）。
 */
export function buildLibraryFilename(stdCode: string, source: SourceName): string {
  // 与 shared/fs.ts buildFileName 一致：去 Windows 非法字符 + 折叠空白
  // 但保留 -、空格、中文。`/` 替换成 `_` 而非删掉，便于人工辨识。
  const safe = stdCode
    .replace(/\//g, '_')
    .replace(/[\\:*?"<>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return `${safe || 'standard'} - ${CANONICAL_TO_LABEL[source]}.pdf`;
}

interface ScanResult {
  scanned: number;
  added: number;
  updated: number;
  removed: number;
  skipped: number;
}

let activeScan: Promise<ScanResult> | null = null;

/**
 * 扫描库目录。
 *
 * 模式：
 * - 默认增量：对每个文件 stat，mtime 与 size 都没变就跳过；变了就 UPSERT
 * - full=true：先清表再全量扫；用于设置改路径 / 管理员手动触发
 *
 * 不递归子目录（保持库结构扁平，便于用户在文件管理器里直接看）。
 * Phase 2 可能加分类子目录（按发布机构 GB/JJG/HG…），届时再开递归。
 */
export async function scanLibrary(
  db: Database.Database,
  options: { full?: boolean } = {},
): Promise<ScanResult> {
  if (activeScan) return activeScan;
  activeScan = scanLibraryInternal(db, options).finally(() => {
    activeScan = null;
  });
  return activeScan;
}

export async function scanLibraryAfterCurrent(
  db: Database.Database,
  options: { full?: boolean } = {},
): Promise<ScanResult> {
  if (activeScan) await activeScan.catch(() => { /* caller starts a fresh scan below */ });
  return scanLibrary(db, options);
}

async function scanLibraryInternal(
  db: Database.Database,
  options: { full?: boolean } = {},
): Promise<ScanResult> {
  const status = await resolveLibraryDir(db);
  const result: ScanResult = { scanned: 0, added: 0, updated: 0, removed: 0, skipped: 0 };
  if (!status.writable) return result;

  const libDir = status.dir;
  await fs.mkdir(libDir, { recursive: true }).catch(() => { /* probe 已经 mkdir 过；忽略 */ });

  if (options.full) {
    db.prepare('DELETE FROM standard_files').run();
  }

  // 现有索引快照：abs_path → { mtime, size, id }
  const existingRows = db.prepare(
    'SELECT id, abs_path, mtime, size FROM standard_files'
  ).all() as Array<{ id: number; abs_path: string; mtime: number; size: number }>;
  const existingByPath = new Map(existingRows.map(r => [r.abs_path, r]));
  const seenPaths = new Set<string>();

  let entries: string[];
  try {
    entries = await fs.readdir(libDir);
  } catch {
    return result;
  }

  const changes: Array<{
    parsed: ReturnType<typeof parseLibraryFilename>;
    absPath: string;
    name: string;
    size: number;
    mtimeMs: number;
    existing: boolean;
  }> = [];
  const removedIds: number[] = [];

  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.pdf')) { result.skipped++; continue; }
    const absPath = path.join(libDir, name);
    let safeFile;
    try { safeFile = await resolveSafeLibraryFile(absPath, libDir); } catch { continue; }
    if (!safeFile) { result.skipped++; continue; }
    const stat = safeFile.stat;
    seenPaths.add(absPath);
    seenPaths.add(safeFile.realPath);
    result.scanned++;

    const existing = existingByPath.get(safeFile.realPath) || existingByPath.get(absPath);
    const mtimeMs = Math.floor(stat.mtimeMs);
    if (existing && existing.mtime === mtimeMs && existing.size === stat.size && !options.full) {
      result.skipped++;
      continue;
    }

    const parsed = parseLibraryFilename(name);
    if (!parsed) { result.skipped++; continue; }
    changes.push({ parsed, absPath: safeFile.realPath, name, size: stat.size, mtimeMs, existing: !!existing });
  }

  const upsert = db.prepare(`
    INSERT INTO standard_files (std_code_norm, year, source, abs_path, file_name, size, mtime, mime, etag)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'application/pdf', ?)
    ON CONFLICT(std_code_norm, year, source) DO UPDATE SET
      abs_path = excluded.abs_path,
      file_name = excluded.file_name,
      size = excluded.size,
      mtime = excluded.mtime,
      etag = excluded.etag,
      indexed_at = datetime('now')
  `);
  const writeChunk = db.transaction((chunk: typeof changes) => {
    for (const change of chunk) {
      if (!change.parsed) continue;
      try {
        upsert.run(
          change.parsed.stdCodeNorm,
          change.parsed.year,
          change.parsed.source,
          change.absPath,
          change.name,
          change.size,
          change.mtimeMs,
          computeFileEtag(change.size, change.mtimeMs),
        );
        change.existing ? result.updated++ : result.added++;
      } catch {
        result.skipped++;
      }
    }
  });
  const CHUNK_SIZE = 1000;
  for (let i = 0; i < changes.length; i += CHUNK_SIZE) {
    writeChunk(changes.slice(i, i + CHUNK_SIZE));
  }

  // 清理：表里有但磁盘上没了的行（用户手动删了文件）
  if (!options.full) {
    for (const row of existingRows) {
      if (!seenPaths.has(row.abs_path)) {
        removedIds.push(row.id);
      }
    }
  }
  if (removedIds.length) {
    const remove = db.prepare('DELETE FROM standard_files WHERE id = ?');
    const removeChunk = db.transaction((ids: number[]) => {
      for (const id of ids) remove.run(id);
    });
    for (let i = 0; i < removedIds.length; i += CHUNK_SIZE) {
      const chunk = removedIds.slice(i, i + CHUNK_SIZE);
      removeChunk(chunk);
      result.removed += chunk.length;
    }
  }

  return result;
}

/**
 * 预览查询：按源优先级返回首个命中行。
 * sources 数组 = 全局优先级（来自 setting）或请求级 override，从左往右匹配。
 * year 可选 —— 不传则任意年份命中（用户搜不带年份的关键词时）。
 *
 * 二次校验 fs.access：用户手动删了文件后，扫描清表前可能有 race，
 * 这里再校验一次防止返回 404 文件 ID。校验失败的行就地清掉，下次查询走正常路径。
 */
export async function lookupFile(
  db: Database.Database,
  params: { stdCode: string; year?: string; sources?: SourceName[] },
): Promise<LibraryFileRow | null> {
  const norm = extractBaseCode(params.stdCode);
  if (!norm) return null;

  const sources = params.sources && params.sources.length > 0
    ? params.sources.filter((s): s is SourceName => SUPPORTED_SOURCES.includes(s as SourceName))
    : SUPPORTED_SOURCES;
  if (sources.length === 0) return null;

  const yearClause = params.year ? 'AND year = ?' : '';
  const args: any[] = [norm];
  if (params.year) args.push(params.year);

  // 一次查出所有匹配再按 sources 顺序挑，避免循环里 N 次 SQL
  const rows = db.prepare(`
    SELECT id, std_code_norm, year, source, abs_path, size, mtime, mime, indexed_at
    FROM standard_files
    WHERE std_code_norm = ? ${yearClause}
  `).all(...args) as Array<{
    id: number; std_code_norm: string; year: string; source: string;
    abs_path: string; size: number; mtime: number; mime: string; indexed_at: string;
  }>;
  if (rows.length === 0) return null;

  for (const src of sources) {
    const row = rows.find(r => r.source === src);
    if (!row) continue;
    try {
      await fs.access(row.abs_path);
    } catch {
      db.prepare('DELETE FROM standard_files WHERE id = ?').run(row.id);
      continue;
    }
    return {
      id: row.id,
      stdCodeNorm: row.std_code_norm,
      year: row.year,
      source: row.source as SourceName,
      absPath: row.abs_path,
      size: row.size,
      mtime: row.mtime,
      mime: row.mime,
      indexedAt: row.indexed_at,
    };
  }

  return null;
}

/**
 * 批量本地命中检查（搜索结果绿点指示用）。
 *
 * 给一组 (stdCode, year?) 一次性查 standard_files，返回 key → 首个匹配 fileId 的 map。
 * Key 格式：`<extractBaseCode(stdCode)>|<year>`，year 缺失时用空串。
 *
 * Why: 搜索结果 20-50 条逐个 lookupFile 太费（每条 1 SQL + 1 fs.access）。这里：
 * - 用 `WHERE std_code_norm IN (?, ?, ...)` 一条 SQL 拿全部候选
 * - **不做 fs.access**：watcher 已经维护表的真实存在性，绿点容忍极少数 stale
 *   误指；用户真点了发现文件没了 → 自动 fallback 走老下载路径
 * - 在 JS 端按 sources 优先级挑首个，跟 lookupFile 单条版本口径一致
 *
 * 入参 items 不限长但调用方应该自己分批（200 是经验上限，再大 SQL 变量数会撑爆）。
 */
export function bulkLookup(
  db: Database.Database,
  items: Array<{ stdCode: string; year?: string }>,
  sources?: SourceName[],
): Map<string, number> {
  const result = new Map<string, number>();
  if (!items.length) return result;

  const effectiveSources = sources && sources.length > 0
    ? sources.filter((s): s is SourceName => SUPPORTED_SOURCES.includes(s as SourceName))
    : [...SUPPORTED_SOURCES];
  if (effectiveSources.length === 0) return result;

  // 归一化 + 去重，记下 norm → 原始请求项的反向映射（一个 norm 可能对应多个 year 查询）
  const normSet = new Set<string>();
  const requestKeys: Array<{ norm: string; year: string; key: string }> = [];
  for (const it of items) {
    const norm = extractBaseCode(it.stdCode);
    if (!norm) continue;
    normSet.add(norm);
    const year = it.year || '';
    requestKeys.push({ norm, year, key: `${norm}|${year}` });
  }
  if (normSet.size === 0) return result;

  const placeholders = Array.from(normSet, () => '?').join(',');
  const rows = db.prepare(`
    SELECT id, std_code_norm, year, source
    FROM standard_files
    WHERE std_code_norm IN (${placeholders})
  `).all(...normSet) as Array<{ id: number; std_code_norm: string; year: string; source: string }>;
  if (rows.length === 0) return result;

  // 按 (norm, year) 分桶。每桶里再按 sources 优先级挑首条命中。
  const buckets = new Map<string, typeof rows>();
  for (const row of rows) {
    const k = `${row.std_code_norm}|${row.year || ''}`;
    let bucket = buckets.get(k);
    if (!bucket) { bucket = []; buckets.set(k, bucket); }
    bucket.push(row);
  }

  for (const { norm, year, key } of requestKeys) {
    if (result.has(key)) continue;
    // 精确匹配优先：(norm, year)；若用户没传 year，退化成"该 norm 任意 year"——
    // 与 lookupFile(year=undefined) 行为一致，返回任意源命中里 sources 优先级最高的
    const candidates: typeof rows = [];
    if (year) {
      const exact = buckets.get(`${norm}|${year}`);
      if (exact) candidates.push(...exact);
    } else {
      for (const [k, bucket] of buckets) {
        if (k.startsWith(`${norm}|`)) candidates.push(...bucket);
      }
    }
    if (candidates.length === 0) continue;
    for (const src of effectiveSources) {
      const hit = candidates.find(r => r.source === src);
      if (hit) {
        result.set(key, hit.id);
        break;
      }
    }
  }

  return result;
}

/** 按 id 查行（预览 file 端点用）。同样做 fs.access 校验。 */
export async function getFileById(db: Database.Database, id: number): Promise<LibraryFileRow | null> {
  const row = db.prepare(`
    SELECT id, std_code_norm, year, source, abs_path, size, mtime, mime, indexed_at
    FROM standard_files WHERE id = ?
  `).get(id) as any;
  if (!row) return null;
  try {
    await fs.access(row.abs_path);
  } catch {
    db.prepare('DELETE FROM standard_files WHERE id = ?').run(id);
    return null;
  }
  return {
    id: row.id,
    stdCodeNorm: row.std_code_norm,
    year: row.year,
    source: row.source as SourceName,
    absPath: row.abs_path,
    size: row.size,
    mtime: row.mtime,
    mime: row.mime,
    indexedAt: row.indexed_at,
  };
}

export function getIndexStats(db: Database.Database): { count: number; lastIndexedAt: string | null } {
  const row = db.prepare(`
    SELECT COUNT(*) AS count, MAX(indexed_at) AS last_indexed_at FROM standard_files
  `).get() as { count: number; last_indexed_at: string | null };
  return { count: row.count, lastIndexedAt: row.last_indexed_at };
}

// ──────────────────────────────────────────────────────────────
// Phase 2: 下载入库 + 文件系统监听
// ──────────────────────────────────────────────────────────────

/** sleep helper —— retry backoff 用。不引共享工具是因为这里只需要单点用一次。 */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * 把 srcPath move 到 dst。撞名 → 加 (1)/(2)... 后缀（access 预检）；Windows 锁竞争
 * （EBUSY/EPERM/EACCES）retry 4 次带指数 backoff；跨卷（EXDEV）走 copy + .part 中转。
 *
 * 返回最终落地的绝对路径。失败时抛错且库目录里不留半成品（.part 文件失败时会被清理）。
 *
 * 为什么仍用 access 预检：fs.rename 在 Windows + POSIX 上撞 dst 都是**默默覆盖**而非抛
 * EEXIST，没有预检的话用户手动放进库的同名 PDF 会被静默覆盖。access 预检在 8 并发场景
 * 有 TOCTOU 但伤害有限 —— 不同 stdCode 走到这里 dst 也不同；同 (norm, year, source)
 * 早被上层 reused 分支拦截了。真正高频出错的 EBUSY 由下面 renameWithRetry 兜底。
 */
async function moveIntoLibrary(srcPath: string, dst: string): Promise<string> {
  let target = dst;
  const parsed = path.parse(dst);
  for (let counter = 1; counter <= 50; counter++) {
    try {
      await fs.access(target);
      // 撞名（同 stdCode 不同源 sanitize 后撞 / 用户手动放进来的同名）→ 加后缀重试
      target = path.join(parsed.dir, `${parsed.name} (${counter})${parsed.ext}`);
    } catch {
      break; // ENOENT —— target 可用
    }
    if (counter === 50) throw new Error(`文件名去重次数超过 50，疑似配置错误：${dst}`);
  }

  try {
    await renameWithRetry(srcPath, target);
    return target;
  } catch (e: any) {
    if (e?.code !== 'EXDEV') {
      throw new Error(`rename 失败 (${e?.code || 'UNKNOWN'}): ${e?.message || e} → ${target}`);
    }
  }

  // 跨卷：copy 到 .part → rename .part → 最终名（保留原子可见性，避免半写文件被
  // chokidar add 事件抓到。chokidar 已配 awaitWriteFinish 但 .part 后缀是双保险，
  // 上面 watcher 的 ignored() 也明确忽略 .part）
  const partPath = `${target}.part`;
  try {
    await fs.copyFile(srcPath, partPath);
    await renameWithRetry(partPath, target);
    await fs.unlink(srcPath).catch(() => { /* 源已不可达就算了 */ });
    return target;
  } catch (xe: any) {
    await fs.unlink(partPath).catch(() => { /* 清理半成品，忽略二次错 */ });
    throw new Error(`copy+rename 失败 (${xe?.code || 'UNKNOWN'}): ${xe?.message || xe} → ${target}`);
  }
}

/**
 * fs.rename 带 EBUSY/EPERM/EACCES 重试。Windows 上杀毒实时扫描 + chokidar polling
 * + 跨用户并发 batch 都会偶发 EBUSY；不重试会让 1 / N 个文件直接失败，体感差。
 *
 * EXDEV 不在这里 retry（跨卷不可能因为时间过去就变同卷），直接抛给上层走 copy 分支。
 * EEXIST 也直接抛，上层会改 target 文件名再调一次。
 */
async function renameWithRetry(src: string, dst: string): Promise<void> {
  const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);
  const delays = [50, 150, 400, 800]; // 4 次重试，累计 ~1.4s。Windows AV 锁通常 < 500ms。
  let lastErr: any;
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      await fs.rename(src, dst);
      return;
    } catch (e: any) {
      lastErr = e;
      if (!RETRY_CODES.has(e?.code)) throw e;
      if (attempt === delays.length) break;
      await sleep(delays[attempt]);
    }
  }
  throw lastErr;
}

interface AddFileParams {
  srcPath: string;
  stdCode: string;          // 原始号（含 `/T`/`/Z` 等）
  source: SourceName;
  year?: string;            // 4 位年份；缺失则尝试从 stdCode 尾部正则
  title?: string;           // 标准标题（用于 {title} 模板）
  /** 文件扩展名（不含点）。默认 'pdf' — BZ/GBW/BY 都是 PDF；labr 可能 docx/xlsx/pptx */
  ext?: string;
  /** MIME。默认 'application/pdf'；labr 非 PDF 时由 service 传 */
  mime?: string;
}

interface AddFileResult {
  fileId: number;
  absPath: string;
  fileName: string;
  reused: boolean;          // 同 (stdCode, year, source) 已存在 → 跳过 copy，直接复用
}

/**
 * 把 srcPath（通常是 adapter 刚写完的临时文件路径）move 进库目录，按 admin 配置的
 * library_filename_pattern 命名，然后 UPSERT 索引。**rename 而非 copy** —— 单份文件、
 * 永久保留在库；用户决定了不再走 exports 中转 + 14 天清理。
 *
 * 决策：
 * - 同 (norm, year, source) 已有 → reused = true，不覆盖（避免重复下载浪费 IO）。
 *   srcPath 也会被 unlink 掉避免残留。若用户想强制刷新，应该走 admin 重扫 + 手动删旧文件。
 * - 库不可写 → 抛 Error。调用方应该 catch + 仅记日志，并把 srcPath 留在原地不删，
 *   /api/downloads/:filename 还能从那里兜底下载。
 * - 跨卷 (EXDEV) → 自动 fallback 到 copy + 临时 .part + rename，保留原子可见性。
 * - Windows EBUSY/EPERM/EACCES：杀毒实时扫描、chokidar awaitWriteFinish polling、跨用户
 *   并发 batch download 都会偶发占文件，加 retry-with-backoff 兜底。
 *
 * 出错原则：抛错时把 err.code + 上下文路径塞进 message，调用方（download-to-library）
 * 会把 message 冒到 API 响应里给前端看 —— 不要再让用户面对"日志说成功但库里没有"的灵异。
 */
export async function addFileToLibrary(
  db: Database.Database,
  params: AddFileParams,
): Promise<AddFileResult> {
  // Layer 2 完整性兜底：srcPath 0KB / 几十字节错误页直接拒绝入库 + 删残文。
  // 抛错被 moveDownloadToLibrary 的 try/catch 吃掉 → API 响应 library_failed +
  // libraryError 冒到前端。详见 src/shared/download-integrity.ts
  try {
    const preStat = await fs.stat(params.srcPath);
    if (preStat.size < MIN_PDF_BYTES) {
      await fs.unlink(params.srcPath).catch(() => { /* 删不掉就算了，反正不入库 */ });
      throw new Error(
        `[download-integrity] 拒绝入库 source=${params.source} stdCode=${params.stdCode}: ` +
        `${preStat.size}B < ${MIN_PDF_BYTES}B 阈值，疑似损坏 (${params.srcPath})`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('[download-integrity]')) throw e;
    // ENOENT 等：srcPath 不存在直接交给 moveIntoLibrary 报更明确的错
  }

  const status = await resolveLibraryDir(db);
  if (!status.writable) {
    throw new Error('标准库目录不可写，跳过入库');
  }

  const norm = extractBaseCode(params.stdCode);
  if (!norm) throw new Error(`无法解析 stdCode: ${params.stdCode}`);

  // year 优先用入参；缺失时从 stdCode 尾部 `-YYYY` 提取
  const year = params.year || (params.stdCode.match(/-\s*(\d{4})\s*$/)?.[1] ?? '');

  // 已存在则直接返回，不重复 copy
  const existing = db.prepare(`
    SELECT id, abs_path FROM standard_files
    WHERE std_code_norm = ? AND year = ? AND source = ?
  `).get(norm, year, params.source) as { id: number; abs_path: string } | undefined;
  if (existing) {
    try {
      const existingSafe = await resolveSafeLibraryFile(existing.abs_path, status.dir);
      if (!existingSafe) throw new Error('existing library file is outside safe boundary');
      // 已有库内副本 → 把刚下载的 srcPath 删掉，避免占两份磁盘
      await fs.unlink(params.srcPath).catch(() => { /* srcPath 不存在/不可达就算了 */ });
      return { fileId: existing.id, absPath: existingSafe.realPath, fileName: path.basename(existing.abs_path), reused: true };
    } catch {
      // 行残留指向已删除的文件 → 删行继续走 move 流程
      db.prepare('DELETE FROM standard_files WHERE id = ?').run(existing.id);
    }
  }

  const pattern = getSetting(db, 'library_filename_pattern', '{stdCode} {title} - {source}');
  const ext = (params.ext || path.extname(params.srcPath).replace(/^\./, '') || 'pdf').toLowerCase();
  const fileName = renderLibraryFilenameWithExt(pattern, {
    stdCode: params.stdCode,
    source: params.source,
    year,
    title: params.title,
  }, ext);

  // 强行 basename 一次防注入；目标必须在库内
  const safeBasename = path.basename(fileName);
  const targetPath = path.resolve(status.dir, safeBasename);
  const safeTarget = await resolveSafeLibraryTarget(targetPath, status.dir);
  if (!safeTarget) {
    throw new Error('渲染后的文件名越出库目录');
  }

  // 走 moveIntoLibrary：内部做 access 预检 + EBUSY/EPERM/EACCES retry + 跨卷 .part 中转。
  // 旧实现里 rename 失败直接抛错被上层吞掉，是「下载日志成功 8 但库里只有 5」的根因。
  const finalPath = await moveIntoLibrary(params.srcPath, targetPath);
  const safeFinal = await resolveSafeLibraryFile(finalPath, status.dir);
  if (!safeFinal) {
    await fs.unlink(finalPath).catch(() => { /* 防御性清理，失败不覆盖安全错误 */ });
    throw new Error('入库后的文件真实路径越出库目录');
  }
  const stat = safeFinal.stat;
  const mtimeMs = Math.floor(stat.mtimeMs);

  const mime = params.mime || (ext === 'pdf' ? 'application/pdf' : extToMime(ext));
  const result = db.prepare(`
    INSERT INTO standard_files (std_code_norm, year, source, abs_path, file_name, size, mtime, mime, etag)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(std_code_norm, year, source) DO UPDATE SET
      abs_path = excluded.abs_path,
      file_name = excluded.file_name,
      size = excluded.size,
      mtime = excluded.mtime,
      mime = excluded.mime,
      etag = excluded.etag,
      indexed_at = datetime('now')
    RETURNING id
  `).get(norm, year, params.source, safeFinal.realPath, path.basename(finalPath), stat.size, mtimeMs, mime, computeFileEtag(stat.size, mtimeMs)) as { id: number };

  return { fileId: result.id, absPath: safeFinal.realPath, fileName: path.basename(finalPath), reused: false };
}

// ──────── chokidar watcher ────────
//
// 用 chokidar 而非原生 fs.watch：跨平台、Windows + OneDrive 行为更稳、有 add/change/unlink
// 三类事件 + debounce + ignoreInitial 等开箱即用配置。
//
// 设计：
// - 单实例（模块级 _watcher）。多次 start 会先 close 旧的。
// - 启动时 ignoreInitial: true —— 启动扫描负责"已有文件"的初始 indexing，
//   watcher 只接管"启动后变化"，避免重复 INSERT。
// - debounce 1s：用户在文件管理器里拖一堆文件进来时，事件可能间隔几十毫秒触发，
//   逐个 UPSERT 不会出错（SQL 是 idempotent），但日志会刷屏。debounce 后批量处理。

import type { FSWatcher } from 'chokidar';

let _watcher: FSWatcher | null = null;
let _watcherDb: Database.Database | null = null;
let _watcherLibDir: string = '';

/**
 * 启动 watcher。如果已运行，先 close 旧的（用户切换库目录时调用）。
 * library_watcher_enabled = '0' → 直接返回，不启动。
 */
export async function startLibraryWatcher(db: Database.Database): Promise<void> {
  if (getSetting(db, 'library_watcher_enabled', '1') !== '1') {
    await stopLibraryWatcher();
    return;
  }
  const status = await resolveLibraryDir(db);
  if (!status.writable) {
    // 库不可写时启动 watcher 也没意义（用户改不了文件），且 chokidar 在不可读目录上会报错
    return;
  }

  await stopLibraryWatcher();

  // 动态 require 避免未安装时的启动崩溃
  const chokidar: typeof import('chokidar') = require('chokidar');
  _watcherDb = db;
  _watcherLibDir = status.dir;

  _watcher = chokidar.watch(status.dir, {
    ignoreInitial: true,
    depth: 0,                // 与 scanLibrary 保持一致：不递归子目录
    awaitWriteFinish: {
      stabilityThreshold: 1500,
      pollInterval: 200,
    },
    ignored: (p: string) => {
      // 只关心 .pdf；忽略 .tmp / .crdownload / 隐藏文件
      const base = path.basename(p);
      if (base.startsWith('.')) return true;
      if (base.endsWith('.tmp') || base.endsWith('.crdownload') || base.endsWith('.part')) return true;
      return false;
    },
  });

  _watcher.on('add', (p: string) => onWatcherFile(p, 'add'));
  _watcher.on('change', (p: string) => onWatcherFile(p, 'change'));
  _watcher.on('unlink', (p: string) => onWatcherUnlink(p));
  _watcher.on('error', (err: unknown) => {
    console.error('[library-watcher] error:', err);
  });
}

export async function stopLibraryWatcher(): Promise<void> {
  if (_watcher) {
    try { await _watcher.close(); } catch { /* ignore */ }
    _watcher = null;
    _watcherDb = null;
    _watcherLibDir = '';
  }
}

async function onWatcherFile(absPath: string, _kind: 'add' | 'change'): Promise<void> {
  if (!_watcherDb || !_watcherLibDir) return;
  if (!absPath.toLowerCase().endsWith('.pdf')) return;

  try {
    const safeFile = await resolveSafeLibraryFile(absPath, _watcherLibDir);
    if (!safeFile) return;
    const stat = safeFile.stat;

    const parsed = parseLibraryFilename(path.basename(absPath));
    if (!parsed) return;       // 不符合命名规范的 PDF 用户手动放进来的，忽略

    const mtimeMs = Math.floor(stat.mtimeMs);
    _watcherDb.prepare(`
      INSERT INTO standard_files (std_code_norm, year, source, abs_path, file_name, size, mtime, mime, etag)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'application/pdf', ?)
      ON CONFLICT(std_code_norm, year, source) DO UPDATE SET
        abs_path = excluded.abs_path,
        file_name = excluded.file_name,
        size = excluded.size,
        mtime = excluded.mtime,
        etag = excluded.etag,
        indexed_at = datetime('now')
    `).run(parsed.stdCodeNorm, parsed.year, parsed.source, safeFile.realPath, path.basename(absPath), stat.size, mtimeMs, computeFileEtag(stat.size, mtimeMs));
  } catch (e) {
    console.error('[library-watcher] add/change handler failed:', e);
  }
}

function onWatcherUnlink(absPath: string): void {
  if (!_watcherDb) return;
  try {
    _watcherDb.prepare('DELETE FROM standard_files WHERE abs_path = ?').run(absPath);
  } catch (e) {
    console.error('[library-watcher] unlink handler failed:', e);
  }
}
