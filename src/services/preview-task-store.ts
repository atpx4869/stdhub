// In-memory store for preview auto-download tasks (Phase 2).
//
// 用户点预览未命中本地库时，preview-routes 在后台触发 autoDownload，前端
// 用 taskId 轮询本端点直到 status === 'ready' 拿到 fileId 切预览。
//
// 进程内存即可：
// - 后端无 deadline；前端只在 ready/failed/用户关闭时停 poll
// - 没有跨进程消费者
//
// 简单 GC：超过 10 分钟无更新的任务（无论结果）从 map 里清掉，防止泄漏
//
// 去重（Phase 3 polish）：用 (stdCode, year) 作为 key 关联活跃任务。
// 同一标准的并发预览请求 → 复用同一 taskId，避免重复下载。
//   - 用户连点 5 次预览
//   - 先点下载后再点预览（如果下载任务也走这条路径）
// 只有 pending / downloading 状态算「活跃」，ready / failed 不再复用
// （ready 走 lookupFile 命中本地库直接返回；failed 让用户点重试起新任务）

import { randomUUID } from 'node:crypto';

export type PreviewTaskStatus =
  | { status: 'pending' | 'downloading'; source?: string }
  | { status: 'ready'; fileId: number; source: string }
  | { status: 'failed'; error: string };

interface Entry {
  status: PreviewTaskStatus;
  key: string;
  createdAt: number;
  updatedAt: number;
}

const TTL_MS = 10 * 60 * 1000;
const tasks = new Map<string, Entry>();

function gcExpired(): void {
  const now = Date.now();
  for (const [id, entry] of tasks) {
    if (now - entry.updatedAt > TTL_MS) tasks.delete(id);
  }
}

function makeKey(stdCode: string, year: string | undefined): string {
  return `${stdCode.replace(/[^A-Z0-9]/gi, '').toUpperCase()}::${year || ''}`;
}

export function createTask(stdCode: string, year: string | undefined): string {
  gcExpired();
  const id = randomUUID();
  const now = Date.now();
  tasks.set(id, {
    status: { status: 'pending' },
    key: makeKey(stdCode, year),
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

export function updateTask(id: string, status: PreviewTaskStatus): void {
  const entry = tasks.get(id);
  if (!entry) return;
  entry.status = status;
  entry.updatedAt = Date.now();
}

export function getTask(id: string): PreviewTaskStatus | null {
  const entry = tasks.get(id);
  return entry ? entry.status : null;
}

/**
 * 查找同一标准的活跃任务（pending / downloading）。
 * 返回 taskId 或 null；ready / failed 不算活跃。
 *
 * GC 在这里也跑一次，避免读到已超时但还没被清掉的条目。
 */
export function findActiveTaskByKey(stdCode: string, year: string | undefined): string | null {
  gcExpired();
  const wanted = makeKey(stdCode, year);
  for (const [id, entry] of tasks) {
    if (entry.key !== wanted) continue;
    if (entry.status.status === 'pending' || entry.status.status === 'downloading') return id;
  }
  return null;
}
