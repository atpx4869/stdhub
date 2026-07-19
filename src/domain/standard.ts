// labr 不实现 SourceAdapter（kind=0/1 双路径 + 5次/日 Bearer 限速 + 多文件类型，
// 跟 BZ/GBW/BY 的"单标准号 → 单 PDF"契约对不上），但它产出的文件仍走 library_index
// 落到 standards_library_dir，所以 SourceName 要承认它，库扫描和 source 优先级才能识别。
export type SourceName = 'bz' | 'gbw' | 'by' | 'labr';

export interface StandardSummary {
  id: string;
  source: SourceName;
  sourceId: string;
  standardNumber: string;
  title: string;
  standardType?: string;
  status?: string;
  publishDate?: string | null;
  implementDate?: string | null;
  abolishedDate?: string | null;
  previewAvailable: boolean;
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
}

export interface ExportTask {
  id: string;
  userId: number;             // 创建者（最早发起本次导出的人）
  subscribers: number[];      // 共享该 task 的所有用户 id（含创建者）。跨用户下载去重：
                              //   两个用户同时点同标准 → 第二个把 userId 加进 subscribers 直接拿
                              //   现有 task 的进度/结果，不重复跑底层导出。
  standardId: string;
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
  phase?: 'queued' | 'connecting' | 'downloading' | 'verifying' | 'saving' | 'complete' | 'failed' | 'cancelled';
  filePath?: string;
  fileName?: string;
  fileSize?: number;
  /** 入库成功后的库文件 id；前端拿到这个就能写回 _libraryFileIds 点亮绿点 */
  fileId?: number;
  /** 文件下下来了但 move 进库失败时的诊断信息（同 multi-download 的 libraryError） */
  libraryError?: string;
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
  source: SourceName;
  status: 'captcha_required' | 'verified' | 'downloaded' | 'failed' | 'expired';
  captchaImageBase64?: string;
  captchaContentType?: string;
  createdAt: string;
  updatedAt: string;
  meta: Record<string, unknown>;
}

export interface SourceAdapter {
  readonly source: SourceName;
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
  autoDownload?(id: string, userId: number, maxRetries?: number): Promise<DownloadSessionInfo>;
}
