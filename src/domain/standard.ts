import type { DownloadStageTimings } from '../shared/download-timing';

export const ADAPTER_SOURCES = ['bz', 'gbw', 'by', 'sby'] as const;
export type AdapterSourceName = typeof ADAPTER_SOURCES[number];
export type RemoteSourceName = AdapterSourceName | 'labr' | 'doc88';
export type LibrarySourceName = RemoteSourceName | 'bd';
/** @deprecated Prefer AdapterSourceName or LibrarySourceName at the boundary in question. */
export type SourceName = LibrarySourceName;

export interface StandardSummary {
  id: string;
  source: AdapterSourceName;
  sourceId: string;
  standardNumber: string;
  title: string;
  standardType?: string;
  status?: string;
  publishDate?: string | null;
  implementDate?: string | null;
  abolishedDate?: string | null;
  previewAvailable: boolean;
  textAvailability?: import('../shared/text-availability').TextAvailability;
  detailUrl: string;
  meta: Record<string, unknown>;
}

export interface StandardDetail extends StandardSummary {
  contentText?: string;
  moreInfo?: Record<string, unknown>;
}

export interface PreviewInfo {
  standardId: string;
  resourceKey?: string;
  totalPages?: number;
  pageWidth?: number;
  pageHeight?: number;
  fileType?: string;
  pageUrls: string[];
  previewUrl?: string;
  downloadUrl?: string;
  captchaRequired?: boolean;
  meta: Record<string, unknown>;
}

export interface ExportResult {
  standardId: string;
  filePath: string;
  fileName: string;
  fileSize?: number;
  totalPages?: number;
  /** Optional original page images retained by image-based sources (currently BZ).
   * Internal only: the library preview pipeline converts these directly to WebP instead of
   * rasterizing the just-created PDF again. The original PDF is still always preserved. */
  previewPages?: Uint8Array[];
}

export interface ExportTask {
  id: string;
  userId: number;             // 创建者（最早发起本次导出的人）
  subscribers: number[];      // 同源同标准可共享任务；BW 的会话仅限同一用户。
  source: AdapterSourceName;
  standardId: string;
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
  phase?: 'queued' | 'connecting' | 'downloading' | 'verifying' | 'saving' | 'complete' | 'failed' | 'cancelled';
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  /** 入库成功后的库文件 id；前端拿到这个就能写回 _libraryFileIds 点亮绿点 */
  fileId?: number;
  /** 已取得正文但入库失败；不能因此改试其他下载源。 */
  libraryError?: string;
  timingsMs?: DownloadStageTimings;
  currentPage?: number;
  totalPages?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SearchStandardsInput {
  query: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DownloadSessionInfo {
  id: string;
  standardId: string;
  source: AdapterSourceName;
  status: 'captcha_required' | 'verified' | 'downloaded' | 'failed' | 'expired';
  captchaImageBase64?: string;
  captchaContentType?: string;
  createdAt: string;
  updatedAt: string;
  meta: Record<string, unknown>;
}

export interface SourceAdapter {
  readonly source: AdapterSourceName;
  searchStandards(input: SearchStandardsInput): Promise<StandardSummary[]>;
  getStandardDetail(id: string): Promise<StandardDetail>;
  detectPreview(id: string): Promise<PreviewInfo>;
  exportStandard(id: string, opts?: { onProgress?: (current: number, total: number) => void; signal?: AbortSignal }): Promise<ExportResult>;
  // Download-session APIs accept the requesting user id so the underlying
  // store can enforce ownership — without it, any authenticated user could
  // poll or submit captchas against another user's in-flight session.
  createDownloadSession?(id: string, userId: number): Promise<DownloadSessionInfo>;
  submitDownloadCaptcha?(sessionId: string, code: string, userId: number): Promise<DownloadSessionInfo>;
  getDownloadSession?(sessionId: string, userId: number): Promise<DownloadSessionInfo>;
  autoDownload?(id: string, userId: number, maxRetries?: number, opts?: { signal?: AbortSignal }): Promise<DownloadSessionInfo>;
}
