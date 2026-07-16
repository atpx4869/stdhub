// PDF synthesis pool — host-side dispatcher for the worker_threads PDF merger.
//
// Why a pool: pdf-lib synthesis is ~0.5-3s of pure CPU per call. With many
// concurrent exports the main loop would stall. Pool size 2 keeps two threads
// hot (worker startup is ~50-100ms once loaded) while bounding CPU usage so
// the API can still serve search / detail requests during heavy export load.

import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';

export interface MergeOptions {
  /** Raw JPEG bytes for each preview page, in display order. */
  jpegBuffers: Uint8Array[];
  /** Absolute path to write the merged PDF to. */
  outputPath: string;
  /** Called after each page is drawn (1-based current). */
  onProgress?: (current: number, total: number) => void;
}

interface PendingJob {
  id: string;
  resolve: (totalPages: number) => void;
  reject: (err: Error) => void;
  onProgress?: (current: number, total: number) => void;
}

interface PoolWorker {
  worker: Worker;
  busy: boolean;
}

interface WorkerMessage {
  id: string;
  jpegBuffers: ArrayBuffer[];
  outputPath: string;
}

interface WorkerEvent {
  id: string;
  type: 'progress' | 'done' | 'error';
  current?: number;
  total?: number;
  totalPages?: number;
  message?: string;
}

const POOL_SIZE = 2;
const pool: PoolWorker[] = [];
const queue: Array<{ msg: WorkerMessage; pending: PendingJob }> = [];
const slotPending = new WeakMap<PoolWorker, PendingJob>();
const wired = new WeakSet<PoolWorker>();

let workerEntry: string | null = null;
function getWorkerEntry(): string {
  if (workerEntry) return workerEntry;
  const fs = require('node:fs');
  const jsPath = path.join(__dirname, 'pdf-merge-worker.js');
  const tsPath = path.join(__dirname, 'pdf-merge-worker.ts');
  workerEntry = fs.existsSync(jsPath) ? jsPath : tsPath;
  return workerEntry;
}

function rejectAllForSlot(slot: PoolWorker, err: Error): void {
  const p = slotPending.get(slot);
  if (p) {
    slotPending.delete(slot);
    p.reject(err);
  }
}

function removeSlot(slot: PoolWorker): void {
  const i = pool.indexOf(slot);
  if (i >= 0) pool.splice(i, 1);
}

function spawn(): PoolWorker {
  const w = new Worker(getWorkerEntry());
  const slot: PoolWorker = { worker: w, busy: false };
  w.on('error', (err: Error) => {
    console.warn('[pdf-merge-worker] error:', err.message);
    rejectAllForSlot(slot, err);
    removeSlot(slot);
  });
  w.on('exit', (code: number) => {
    if (code !== 0) {
      rejectAllForSlot(slot, new Error(`pdf-merge-worker exited with code ${code}`));
    }
    removeSlot(slot);
  });
  return slot;
}

function wire(slot: PoolWorker): void {
  if (wired.has(slot)) return;
  wired.add(slot);
  slot.worker.on('message', (ev: WorkerEvent) => {
    const pending = slotPending.get(slot);
    if (!pending || pending.id !== ev.id) return;
    if (ev.type === 'progress') {
      pending.onProgress?.(ev.current ?? 0, ev.total ?? 0);
      return;
    }
    slotPending.delete(slot);
    slot.busy = false;
    if (ev.type === 'done') {
      pending.resolve(ev.totalPages ?? 0);
    } else {
      pending.reject(new Error(ev.message ?? 'pdf-merge-worker reported error'));
    }
    drain();
  });
}

function ensurePool(): void {
  while (pool.length < POOL_SIZE) pool.push(spawn());
  for (const slot of pool) wire(slot);
}

function drain(): void {
  while (queue.length > 0) {
    const slot = pool.find((s) => !s.busy);
    if (!slot) return;
    const job = queue.shift()!;
    slot.busy = true;
    slotPending.set(slot, job.pending);
    slot.worker.postMessage(job.msg, job.msg.jpegBuffers); // transfer ArrayBuffers
  }
}

export async function mergeJpegsToPdf(opts: MergeOptions): Promise<number> {
  if (opts.jpegBuffers.length === 0) {
    throw new Error('mergeJpegsToPdf: jpegBuffers is empty');
  }
  ensurePool();

  // Detach the underlying ArrayBuffers so they can be transferred to the worker
  // (zero-copy). slice() forces a fresh ArrayBuffer-backed copy so callers can
  // keep using their Uint8Array views after this call.
  const transferable: ArrayBuffer[] = opts.jpegBuffers.map((u) => {
    const copy = u.slice();
    return copy.buffer;
  });

  const id = randomUUID();
  const msg: WorkerMessage = { id, jpegBuffers: transferable, outputPath: opts.outputPath };

  return new Promise<number>((resolve, reject) => {
    const pending: PendingJob = { id, resolve, reject, onProgress: opts.onProgress };
    queue.push({ msg, pending });
    drain();
  });
}

/** Shut down all pool workers — call during process exit. */
export async function closePdfMergePool(): Promise<void> {
  const closing = pool.splice(0).map((slot) => slot.worker.terminate());
  await Promise.allSettled(closing);
}
