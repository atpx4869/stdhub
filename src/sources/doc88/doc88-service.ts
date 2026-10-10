import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type Database from 'better-sqlite3';

import type { Doc88SearchItem, Doc88Task, Doc88TaskPhase } from '../../domain/doc88';
import { getDoc88Task } from '../../domain/doc88';
import { readConfig } from '../../config';
import { AppError } from '../../shared/errors';
import { cleanStdCode, extractBaseCode, parseStandardReference } from '../../shared/std-code';
import { addFileToLibrary, bulkLookup, getFileById, lookupFile } from '../../services/library-index';
import { getSourceSemaphore } from '../../shared/source-semaphore';
import { setTimeout as wait } from 'node:timers/promises';
import { searchDoc88 } from './doc88-search';
import { trackEvent } from '../../services/usage-tracker';
import { Doc88Renderer } from './doc88-renderer';
import { verifyDoc88Pdf } from './doc88-verify';

export interface CreateDoc88TaskInput {
  pcode: string;
  title: string;
  standardNumber: string;
  cleanTitle: string;
}

export class Doc88Error extends AppError {
  constructor(status: number, code: string, message: string) {
    super(status, code, message);
    this.name = 'Doc88Error';
  }
}

export class Doc88Service {
  private readonly renderer = new Doc88Renderer();
  private readonly queue: string[] = [];
  private readonly controllers = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<(task: Doc88Task) => void>>();
  private runningTaskId = '';
  private closed = false;
  private nextAllowedAt = 0;
  private workerPromise: Promise<void> | null = null;

  constructor(
    private readonly db: Database.Database,
    private readonly hooks: {
      render?: Doc88Renderer['render'];
      verify?: typeof verifyDoc88Pdf;
      ingest?: typeof addFileToLibrary;
    } = {},
  ) {
    this.db.prepare(`
      UPDATE doc88_tasks SET status='failed', phase='failed', error_code='DOC88_TASK_INTERRUPTED',
        error_message='服务重启导致任务中断，请重新生成', message='任务已中断',
        finished_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'), updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE status IN ('queued','running')
    `).run();
  }

  async search(keyword: string, page: number, pageSize: number, signal?: AbortSignal) {
    const result = await searchDoc88(keyword, page, pageSize, signal);
    const lookupItems = result.items.filter(item => item.standardNumber).map(item => ({
      stdCode: item.standardNumber,
      year: parseStandardReference(item.standardNumber)?.year || undefined,
    }));
    const lookup = bulkLookup(this.db, lookupItems, ['doc88']);
    const items = await Promise.all(result.items.map(async item => {
      const year = item.standardNumber ? (parseStandardReference(item.standardNumber)?.year || '') : '';
      const fileId = item.standardNumber ? lookup.get(`${extractBaseCode(item.standardNumber)}|${year}`) : undefined;
      const file = fileId ? await getFileById(this.db, fileId) : null;
      return {
        ...item,
        ...(file ? { localFileId: file.id, localFileName: path.basename(file.absPath) } : {}),
      };
    }));
    return { ...result, items };
  }

  getHealth() {
    const config = readConfig();
    return {
      configured: Boolean(this.loadCookie(config.doc88.cookie, config.doc88.cookieFile)),
      busy: Boolean(this.runningTaskId),
      queueLength: this.queue.length,
      lastSuccessAt: (this.db.prepare("SELECT MAX(finished_at) AS at FROM doc88_tasks WHERE status='success'").get() as { at?: string | null })?.at || null,
    };
  }

  createTask(userId: number, input: CreateDoc88TaskInput): Doc88Task {
    if (this.closed) throw new Doc88Error(503, 'DOC88_SERVICE_CLOSED', 'Doc88 服务正在关闭');
    const config = readConfig();
    if (!this.loadCookie(config.doc88.cookie, config.doc88.cookieFile)) {
      throw new Doc88Error(409, 'DOC88_COOKIE_MISSING', 'Doc88 Cookie 未配置，请设置 DOC88_COOKIE 或 DOC88_COOKIE_FILE');
    }
    const pcode = input.pcode.trim();
    if (!/^\d{6,20}$/.test(pcode)) throw new Doc88Error(400, 'DOC88_BAD_PCODE', '无效的 Doc88 文档编号');
    const standardNumber = cleanStdCode(input.standardNumber);
    if (!parseStandardReference(standardNumber)?.prefix) {
      throw new Doc88Error(400, 'DOC88_STANDARD_NUMBER_REQUIRED', '无法可靠识别标准号，请先填写完整标准号');
    }
    const existing = this.db.prepare("SELECT id FROM doc88_tasks WHERE pcode=? AND status IN ('queued','running') LIMIT 1").get(pcode) as { id: string } | undefined;
    if (existing) {
      const activeTask = getDoc88Task(this.db, existing.id)!;
      if (activeTask.userId !== userId) {
        throw new Doc88Error(409, 'DOC88_ALREADY_RUNNING', '该文档已有生成任务正在执行，请稍后在本地文件库查看');
      }
      return activeTask;
    }
    const active = this.runningTaskId ? 1 : 0;
    if (active + this.queue.length >= config.doc88.queueLimit + 1) throw new Doc88Error(429, 'DOC88_QUEUE_FULL', 'Doc88 任务队列已满，请稍后再试');
    const taskId = `d88_${randomUUID()}`;
    this.db.prepare(`
      INSERT INTO doc88_tasks (id,user_id,pcode,title,standard_number,clean_title,status,phase,message)
      VALUES (?,?,?,?,?,?,'queued','queued','等待执行')
    `).run(taskId, userId, pcode, input.title.trim(), standardNumber, input.cleanTitle.trim());
    this.controllers.set(taskId, new AbortController());
    this.queue.push(taskId);
    this.startWorker();
    return getDoc88Task(this.db, taskId)!;
  }

  listTasks(userId: number): Doc88Task[] {
    const rows = this.db.prepare('SELECT id FROM doc88_tasks WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(userId) as Array<{ id: string }>;
    return rows.map(row => this.getTask(row.id, userId));
  }

  getTask(taskId: string, userId: number): Doc88Task {
    const task = getDoc88Task(this.db, taskId);
    if (!task || task.userId !== userId) throw new Doc88Error(404, 'DOC88_TASK_NOT_FOUND', 'Doc88 任务不存在');
    if (task.fileId) {
      const file = this.db.prepare('SELECT file_name FROM standard_files WHERE id=?').get(task.fileId) as { file_name: string } | undefined;
      if (file) task.fileName = file.file_name;
    }
    return task;
  }

  cancel(taskId: string, userId: number): Doc88Task {
    const task = this.getTask(taskId, userId);
    if (['success', 'failed', 'cancelled'].includes(task.status)) return task;
    if (task.phase === 'indexing') throw new Doc88Error(409, 'DOC88_COMMITTING', '文件正在入库，请等待完成后在文件库管理');
    this.controllers.get(taskId)?.abort(new Error('任务已取消'));
    const index = this.queue.indexOf(taskId);
    if (index >= 0) this.queue.splice(index, 1);
    this.update(taskId, { status: 'cancelled', phase: 'cancelled', message: '任务已取消', finishedAt: new Date().toISOString() });
    if (taskId !== this.runningTaskId) this.controllers.delete(taskId);
    return this.getTask(taskId, userId);
  }

  subscribe(taskId: string, userId: number, listener: (task: Doc88Task) => void) {
    const task = this.getTask(taskId, userId);
    listener(task);
    if (['success', 'failed', 'cancelled'].includes(task.status)) return () => {};
    let listeners = this.listeners.get(taskId);
    if (!listeners) { listeners = new Set(); this.listeners.set(taskId, listeners); }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (!listeners?.size) this.listeners.delete(taskId);
    };
  }

  async close() {
    this.closed = true;
    for (const [taskId, controller] of this.controllers) {
      controller.abort(new Error('应用正在关闭'));
      if (taskId !== this.runningTaskId) {
        this.update(taskId, { status: 'cancelled', phase: 'cancelled', message: '应用关闭，任务已取消', finishedAt: new Date().toISOString() });
        this.controllers.delete(taskId);
      }
    }
    this.queue.length = 0;
    await this.renderer.close();
    await this.workerPromise;
    this.listeners.clear();
  }

  private startWorker() {
    if (this.closed || this.workerPromise || !this.queue.length) return;
    this.workerPromise = this.drain().finally(() => {
      this.workerPromise = null;
      this.startWorker();
    });
  }

  private async drain() {
    if (this.closed || this.runningTaskId || !this.queue.length) return;
    const taskId = this.queue.shift()!;
    this.runningTaskId = taskId;
    try {
      const waitMs = Math.max(0, this.nextAllowedAt - Date.now());
      const signal = this.controllers.get(taskId)!.signal;
      if (waitMs) await wait(waitMs, undefined, { signal });
      signal.throwIfAborted();
      if (this.closed) throw new Error('应用正在关闭');
      await getSourceSemaphore('doc88').run(() => this.runTask(taskId), signal);
    } catch (error) {
      const controller = this.controllers.get(taskId);
      if (controller?.signal.aborted) {
        const current = getDoc88Task(this.db, taskId);
        if (current && current.status !== 'cancelled') this.update(taskId, { status: 'cancelled', phase: 'cancelled', message: '任务已取消', finishedAt: new Date().toISOString() });
      } else {
        const classified = this.classifyError(error);
        this.update(taskId, { status: 'failed', phase: 'failed', message: '生成失败', error: classified, finishedAt: new Date().toISOString() });
      }
    } finally {
      this.controllers.delete(taskId);
      this.runningTaskId = '';
      this.nextAllowedAt = Date.now() + 2_000;
      this.startWorker();
    }
  }

  private async runTask(taskId: string) {
    const task = getDoc88Task(this.db, taskId)!;
    const controller = this.controllers.get(taskId)!;
    controller.signal.throwIfAborted();
    const parsed = parseStandardReference(task.standardNumber);
    const stored = await lookupFile(this.db, { stdCode: task.standardNumber, year: parsed?.year || undefined, sources: ['doc88'] });
    controller.signal.throwIfAborted();
    if (stored) {
      this.update(taskId, { status: 'success', phase: 'complete', message: '本地文件已存在', fileId: stored.id, fileName: path.basename(stored.absPath), finishedAt: new Date().toISOString() });
      return;
    }
    const config = readConfig();
    const cookie = this.loadCookie(config.doc88.cookie, config.doc88.cookieFile);
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'stdhub-doc88-task-'));
    const outPath = path.join(tempDir, `${task.pcode}.pdf`);
    try {
      this.progress(taskId, 'opening', 0, 0, '正在打开 Doc88 阅读器');
      const render = this.hooks.render || this.renderer.render.bind(this.renderer);
      const rendered = await render(task.pcode, outPath, {
        cookie,
        pageTimeoutMs: config.doc88.pageTimeoutMs,
        scale: config.doc88.scale,
        signal: controller.signal,
        onProgress: (phase, current, total, message) => this.progress(taskId, phase, current, total, message),
      });
      if (rendered.renderedPages !== rendered.totalPages) throw new Doc88Error(502, 'DOC88_INCOMPLETE', `生成内容不完整：预期 ${rendered.totalPages} 页，实际 ${rendered.renderedPages} 页`);
      controller.signal.throwIfAborted();
      await (this.hooks.verify || verifyDoc88Pdf)(outPath, rendered.totalPages);
      controller.signal.throwIfAborted();
      this.progress(taskId, 'indexing', rendered.totalPages, rendered.totalPages, '正在写入本地文件库');
      const finalTitle = task.cleanTitle || rendered.title || task.title;
      const result = await (this.hooks.ingest || addFileToLibrary)(this.db, {
        srcPath: outPath,
        stdCode: task.standardNumber,
        title: finalTitle,
        source: 'doc88',
        ext: 'pdf',
        mime: 'application/pdf',
      });
      this.update(taskId, {
        status: 'success', phase: 'complete', current: rendered.totalPages, total: rendered.totalPages,
        message: result.reused ? '本地文件已存在' : '生成并入库完成', fileId: result.fileId,
        fileName: result.fileName, finishedAt: new Date().toISOString(),
      });
      trackEvent(this.db, task.userId, 'download', 'doc88', task.standardNumber, {
        pcode: task.pcode, pages: rendered.totalPages, fileId: result.fileId, reused: result.reused,
      }, { result: 'success' });
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private progress(taskId: string, phase: Doc88TaskPhase, current: number, total: number, message: string) {
    this.update(taskId, { status: 'running', phase, current, total, message });
  }

  private update(taskId: string, patch: Partial<Doc88Task>) {
    const current = getDoc88Task(this.db, taskId);
    if (!current || ['success', 'failed', 'cancelled'].includes(current.status)) return;
    const next = { ...current, ...patch, id: current.id, userId: current.userId, updatedAt: new Date().toISOString() };
    this.db.prepare(`
      UPDATE doc88_tasks SET status=?,phase=?,current_page=?,total_pages=?,message=?,file_id=?,file_name=?,
        error_code=?,error_message=?,updated_at=?,finished_at=? WHERE id=?
    `).run(next.status, next.phase, next.current, next.total, next.message, next.fileId ?? null, next.fileName ?? null,
      next.error?.code ?? null, next.error?.message ?? null, next.updatedAt, next.finishedAt ?? null, taskId);
    const snapshot = getDoc88Task(this.db, taskId)!;
    for (const listener of this.listeners.get(taskId) || []) {
      try { listener(snapshot); } catch { this.listeners.get(taskId)?.delete(listener); }
    }
    if (['success', 'failed', 'cancelled'].includes(snapshot.status)) this.listeners.delete(taskId);
  }

  private loadCookie(inline: string, filePath: string): string {
    if (inline.trim()) return inline.trim();
    if (!filePath.trim()) return '';
    try { return readFileSync(filePath, 'utf8').trim(); } catch { return ''; }
  }

  private classifyError(error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/Cookie 未配置/i.test(message)) return { code: 'DOC88_COOKIE_MISSING', message: 'Doc88 Cookie 未配置' };
    if (/频率限制|安全验证|频繁操作/i.test(message)) return { code: 'DOC88_RATE_LIMITED', message: 'Doc88 触发了访问频率限制，请稍后再试' };
    if (/不完整|预期.*实际/i.test(message)) return { code: 'DOC88_INCOMPLETE', message: 'PDF 页数校验失败，未将缺页文档写入文件库' };
    if (/任务已取消/i.test(message)) return { code: 'DOC88_CANCELLED', message: '任务已取消' };
    if (/timeout|超时/i.test(message)) return { code: 'DOC88_PAGE_TIMEOUT', message: '页面渲染或处理超时，请稍后重试' };
    if (/browser|Chromium|Target.*closed/i.test(message)) return { code: 'DOC88_BROWSER_FAILED', message: '浏览器启动或渲染失败，请检查 Chromium 环境' };
    if (/未初始化|文档页数/.test(message)) return { code: 'DOC88_READER_UNAVAILABLE', message: '阅读器不可用，请检查 Cookie 或文档访问权限' };
    return { code: 'DOC88_FAILED', message: 'Doc88 生成失败，请检查文档访问权限和运行环境' };
  }
}
