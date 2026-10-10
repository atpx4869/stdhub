import type Database from 'better-sqlite3';

export const DOC88_TASK_STATUSES = ['queued', 'running', 'success', 'failed', 'cancelled'] as const;
export type Doc88TaskStatus = typeof DOC88_TASK_STATUSES[number];
export type Doc88TaskPhase = 'queued' | 'opening' | 'rendering' | 'assembling' | 'indexing' | 'complete' | 'failed' | 'cancelled';

export interface Doc88SearchItem {
  pcode: string;
  title: string;
  pages: number | null;
  date: string;
  standardNumber: string;
  cleanTitle: string;
  localFileId?: number;
}

export interface Doc88Task {
  id: string;
  userId: number;
  pcode: string;
  title: string;
  standardNumber: string;
  cleanTitle: string;
  status: Doc88TaskStatus;
  phase: Doc88TaskPhase;
  current: number;
  total: number;
  message: string;
  fileId?: number;
  fileName?: string;
  error?: { code: string; message: string };
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

interface Doc88TaskRow {
  id: string;
  user_id: number;
  pcode: string;
  title: string;
  standard_number: string;
  clean_title: string;
  status: Doc88TaskStatus;
  phase: Doc88TaskPhase;
  current_page: number;
  total_pages: number;
  message: string;
  file_id: number | null;
  file_name: string | null;
  error_code: string | null;
  error_message: string | null;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
}

export function rowToDoc88Task(row: Doc88TaskRow): Doc88Task {
  return {
    id: row.id,
    userId: row.user_id,
    pcode: row.pcode,
    title: row.title,
    standardNumber: row.standard_number,
    cleanTitle: row.clean_title,
    status: row.status,
    phase: row.phase,
    current: row.current_page,
    total: row.total_pages,
    message: row.message,
    ...(row.file_id ? { fileId: row.file_id } : {}),
    ...(row.file_name ? { fileName: row.file_name } : {}),
    ...(row.error_code || row.error_message ? { error: { code: row.error_code || 'DOC88_FAILED', message: row.error_message || 'Doc88 任务失败' } } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}

export function getDoc88Task(db: Database.Database, taskId: string): Doc88Task | null {
  const row = db.prepare('SELECT * FROM doc88_tasks WHERE id = ?').get(taskId) as Doc88TaskRow | undefined;
  return row ? rowToDoc88Task(row) : null;
}
