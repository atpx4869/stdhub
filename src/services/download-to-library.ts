// 下载入库 hook（Phase 2）。adapter 把 PDF 写到 data/exports/ 里某个 filePath，
// 这里立刻 move 到 standards_library_dir 下，按 admin 模板重命名，UPSERT 索引。
//
// 失败容忍：addFileToLibrary 抛错只记日志，不动响应 —— 用户的下载体验不能因
// "入库逻辑出问题"而崩。失败的文件会留在 exports/，/api/downloads 仍可服务。
// 但失败原因会通过返回值的 `error` 字段冒到 API 响应，让前端区分「成功入库」
// vs「下下来但没进库」 —— 用户报告过"日志说成功 8 个、库里只有 5 个"的灵异，
// 不暴露 error 字段就只能让人去翻 /api/diagnostics/logs。
//
// 返回值带回新的 absPath / fileName / fileId，便于上层把 downloadUrl 改成
// /api/files/:id/pdf/download 而非旧的 /api/downloads/:filename，省一次磁盘 IO。
//
// 抽出到独立 service 是因为 preview-routes（自动下载预览流）也要复用。

import { promises as fs } from 'node:fs';
import type Database from 'better-sqlite3';
import type { SourceRegistry } from './source-registry';
import type { SourceName } from '../domain/standard';
import { addFileToLibrary } from './library-index';
import { MIN_PDF_BYTES } from '../shared/download-integrity';

export interface MoveDownloadResult {
  fileId?: number;
  absPath?: string;
  fileName?: string;
  libraryUrl?: string;
  /** 入库失败时填入的诊断信息（包含 err.code + path）。调用方据此决定是否把 API
   *  status 降级成 'library_failed' 并把原因冒给前端。 */
  error?: string;
}

export async function moveDownloadToLibrary(
  db: Database.Database,
  sourceRegistry: SourceRegistry,
  source: SourceName,
  standardId: string,
  result: { filePath?: string; fileName?: string; fileSize?: number; previewPages?: Uint8Array[] },
): Promise<MoveDownloadResult> {
  if (!result.filePath) return {};

  // Layer 3 早拦截：adapter 已给出 fileSize 且明显损坏 → 不走入库，省一次 stat IO。
  // Layer 1 应该已经在 adapter 抛错拦截了，这里是漏改 adapter 时的兜底。
  if (result.fileSize !== undefined && result.fileSize < MIN_PDF_BYTES) {
    await fs.unlink(result.filePath).catch(() => { /* 删不掉就算了 */ });
    const msg = `[download-integrity] 拒绝入库 source=${source} standardId=${standardId}: ` +
      `${result.fileSize}B < ${MIN_PDF_BYTES}B 阈值，疑似损坏`;
    console.error(msg);
    return { error: msg };
  }

  try {
    let stdCode = '';
    let title = '';
    try {
      const adapter = sourceRegistry.get(source);
      const detail = await adapter.getStandardDetail(standardId);
      stdCode = detail.standardNumber;
      title = detail.title;
    } catch { /* detail 拿不到 → 用文件名 stem 当 stdCode */ }
    if (!stdCode && result.fileName) {
      stdCode = result.fileName.replace(/\.pdf$/i, '');
    }
    if (!stdCode) return { error: '无法确定 stdCode（detail 拉不到 + 没有 fileName）' };

    const moved = await addFileToLibrary(db, {
      srcPath: result.filePath,
      stdCode,
      source,
      title,
      previewPages: result.previewPages,
    });
    return {
      fileId: moved.fileId,
      absPath: moved.absPath,
      fileName: moved.fileName,
      libraryUrl: `/api/files/${moved.fileId}/pdf/download`,
    };
  } catch (e) {
    // 同时打到 console.error（ring buffer 会拦截写到 /api/diagnostics/logs）和返回值
    // —— 用户排查时哪条路径都能看到。带上 source/standardId/srcPath 让日志能定位是哪一次。
    const msg = e instanceof Error ? e.message : String(e);
    console.error(
      `[library] moveDownloadToLibrary failed: source=${source} standardId=${standardId} srcPath=${result.filePath} err=${msg}`,
    );
    return { error: msg };
  }
}
