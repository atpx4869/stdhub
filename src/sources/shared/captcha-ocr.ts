import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import path from 'node:path';

import readline from 'node:readline';

import { randomUUID } from 'node:crypto';

import { getRootDir } from '../../shared/fs';



interface OcrResult {

  text: string;

  confidence: number;

  rawText: string;

}



const CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

const READY_SENTINEL = '__BZXZ_OCR_READY__';

const REQUEST_TIMEOUT_MS = 8000;

// Aggressive startup timeout: ddddocr import in a working environment takes

// 1-3s. If we don't hear READY within 5s we treat the worker as broken and

// fall back to tesseract immediately — much better than blocking the first

// captcha for the full 20s pessimistic timeout.

const STARTUP_TIMEOUT_MS = 5_000;

const PYTHON_CANDIDATES = process.platform === 'win32'
  ? [
      { command: 'py', args: ['-3.11', '-u'] },
      { command: 'python3.11', args: ['-u'] },
      { command: 'python', args: ['-u'] },
      { command: 'python3', args: ['-u'] },
      { command: 'py', args: ['-u'] },
    ]
  : [
      { command: 'python3.11', args: ['-u'] },
      { command: 'python3', args: ['-u'] },
      { command: 'python', args: ['-u'] },
    ];


function getPythonBridge(): string {

  return path.join(getRootDir(), 'scripts', 'ocr_ddddocr.py');

}



export async function ocrCaptcha(base64Image: string): Promise<OcrResult> {

  // Skip ddddocr entirely if a previous attempt proved it's unavailable —

  // otherwise each captcha eats the 8s startup timeout for nothing.

  if (ocrStatus.engine !== 'unavailable') {

    const t0 = Date.now();

    const ddddResult = await tryDdddocr(base64Image);

    if (ddddResult.text.length >= 4) {

      recordSolve('ddddocr', Date.now() - t0);

      return ddddResult;

    }

  }



  const t0 = Date.now();

  const tess = await tryTesseract(base64Image);

  recordSolve('tesseract', Date.now() - t0);

  return tess;

}



// ─── Diagnostics ─────────────────────────────────────────────────────────────

// Exposed via /api/diagnostics/ocr so the user can see what's actually running

// without opening the Electron dev console.



export interface OcrStatus {

  engine: 'ddddocr' | 'tesseract' | 'unavailable' | 'unknown';

  workerPid: number | null;

  startupAttempts: number;

  lastError: string | null;

  pythonCommand: string | null;

  bridgePath: string;

  /** PATH the OCR worker would inherit when spawning python. Surfaced in diagnostics

   *  so the user can confirm their Python install directory is on PATH (a frequent

   *  cause of "ddddocr unavailable" when launched from a desktop shortcut). */

  envPath: string;

  solves: {

    ddddocr: { count: number; totalMs: number };

    tesseract: { count: number; totalMs: number };

  };

}



const ocrStatus: OcrStatus = {

  engine: 'unknown',

  workerPid: null,

  startupAttempts: 0,

  lastError: null,

  pythonCommand: null,

  bridgePath: getPythonBridge(),

  envPath: process.env.PATH || process.env.Path || '',

  solves: {

    ddddocr: { count: 0, totalMs: 0 },

    tesseract: { count: 0, totalMs: 0 },

  },

};



function recordSolve(engine: 'ddddocr' | 'tesseract', ms: number): void {

  ocrStatus.solves[engine].count += 1;

  ocrStatus.solves[engine].totalMs += ms;

}



export function getOcrStatus(): OcrStatus {

  return {

    ...ocrStatus,

    solves: {

      ddddocr: { ...ocrStatus.solves.ddddocr },

      tesseract: { ...ocrStatus.solves.tesseract },

    },

  };

}



/**

 * Eagerly start the OCR worker so the first real captcha doesn't pay the

 * 1-3s import-ddddocr penalty. Resolves once the worker is ready or has

 * permanently failed. Safe to call multiple times; subsequent calls reuse the

 * existing worker.

 */

export async function warmupOcr(): Promise<void> {

  try {

    await startWorker();

  } catch {

    // startWorker already records the failure into ocrStatus; we resolve so

    // callers can decide based on getOcrStatus().engine.

  }

}



// ─── Long-lived Python OCR worker ────────────────────────────────────────────



interface PendingRequest {

  resolve: (text: string) => void;

  reject: (err: Error) => void;

  timer: ReturnType<typeof setTimeout>;

}



let worker: ChildProcessWithoutNullStreams | null = null;

let workerReady: Promise<void> | null = null;

const pending = new Map<string, PendingRequest>();



function failAllPending(reason: string) {

  for (const [id, req] of pending) {

    clearTimeout(req.timer);

    req.reject(new Error(reason));

    pending.delete(id);

  }

}



/**

 * Try each python candidate in turn. spawn() itself never throws for

 * ENOENT — it returns a proc that emits an 'error' event asynchronously.

 * To probe whether the binary actually exists, we wait for *either*

 * 'spawn' (success) or 'error' (failure) on next tick before committing.

 */

async function trySpawnPython(): Promise<{ proc: ChildProcessWithoutNullStreams; command: string } | null> {

  let lastErr: string | null = null;

  for (const candidate of PYTHON_CANDIDATES) {

    const { command, args } = candidate;

    try {

      const proc = spawn(command, [...args, getPythonBridge()], {

        windowsHide: true,

        stdio: ['pipe', 'pipe', 'pipe'],

      });
      const probe = await new Promise<{ ok: boolean; err?: string }>((resolve) => {
        let settled = false;
        const cleanup = () => {
          proc.removeListener('spawn', onSpawn);
          proc.removeListener('error', onError);
          proc.removeListener('exit', onExit);
        };
        // py -3.11 spawns successfully on Windows but exits code 112 immediately
        // when Python 3.11 is not installed. After spawn, wait 500ms — if the
        // process dies with non-zero code before the timer, treat it as failure.
        const onSpawn = () => {
          const timer = setTimeout(() => {
            if (!settled) { settled = true; cleanup(); resolve({ ok: true }); }
          }, 500);
          if (timer.unref) timer.unref();
        };
        const onError = (err: Error) => {
          if (!settled) { settled = true; cleanup(); resolve({ ok: false, err: err.message }); }
        };
        const onExit = (code: number | null) => {
          if (!settled) { settled = true; cleanup(); resolve({ ok: false, err: `exited with code ${code}` }); }
        };
        proc.once('spawn', onSpawn);
        proc.once('error', onError);
        proc.once('exit', onExit);
      });

      if (!probe.ok) {

        lastErr = probe.err ?? 'unknown spawn error';

        try { proc.kill(); } catch { /* ignore */ }

        continue;

      }

      ocrStatus.pythonCommand = command;

      return { proc, command };

    } catch (err) {

      lastErr = err instanceof Error ? err.message : String(err);

    }

  }

  ocrStatus.lastError = `Could not spawn python (tried ${PYTHON_CANDIDATES.join(', ')}): ${lastErr ?? 'unknown'}`;

  return null;

}



function startWorker(): Promise<void> {

  if (workerReady) return workerReady;

  if (ocrStatus.engine === 'unavailable') {

    return Promise.reject(new Error(ocrStatus.lastError ?? 'ddddocr worker permanently unavailable'));

  }



  ocrStatus.startupAttempts += 1;

  workerReady = (async () => {

    const spawned = await trySpawnPython();

    if (!spawned) {

      ocrStatus.engine = 'unavailable';

      throw new Error(ocrStatus.lastError ?? 'no python interpreter found');

    }

    const proc = spawned.proc;

    worker = proc;



    const stderrBuffer: string[] = [];

    const stderrLines = readline.createInterface({ input: proc.stderr });

    stderrLines.on('line', (line) => {

      if (line) {

        stderrBuffer.push(line);

        if (stderrBuffer.length > 20) stderrBuffer.shift();

        console.warn('[ocr-worker stderr]', line);

      }

    });



    await new Promise<void>((resolve, reject) => {

      const startupTimer = setTimeout(() => {

        reject(new Error(`OCR worker did not become ready within ${STARTUP_TIMEOUT_MS}ms`));

      }, STARTUP_TIMEOUT_MS);



      const stdoutLines = readline.createInterface({ input: proc.stdout });

      let ready = false;

      stdoutLines.on('line', (line) => {

        if (!ready) {

          if (line.includes(READY_SENTINEL)) {

            ready = true;

            clearTimeout(startupTimer);

            ocrStatus.engine = 'ddddocr';

            ocrStatus.workerPid = proc.pid ?? null;

            ocrStatus.lastError = null;

            resolve();

          } else if (line.trim()) {

            console.warn('[ocr-worker stdout]', line);

          }

          return;

        }

        handleLine(line);

      });



      proc.on('error', (err) => {

        clearTimeout(startupTimer);

        reject(err);

      });



      proc.on('exit', (code, signal) => {

        const reason = `OCR worker exited (code=${code}, signal=${signal})${stderrBuffer.length ? '; stderr: ' + stderrBuffer.slice(-3).join(' | ') : ''}`;

        console.warn(`[ocr-worker] ${reason}`);

        worker = null;

        workerReady = null;

        ocrStatus.workerPid = null;

        if (!ready) {

          ocrStatus.engine = 'unavailable';

          ocrStatus.lastError = reason;

        }

        failAllPending(reason);

      });

    });

  })();



  workerReady.catch((err) => {

    const msg = err instanceof Error ? err.message : String(err);

    console.warn('[ocr-worker] startup failed:', msg);

    ocrStatus.lastError = msg;

    ocrStatus.engine = 'unavailable';

    if (worker) {

      try { worker.kill(); } catch { /* ignore */ }

    }

    worker = null;

    workerReady = null;

  });



  return workerReady;

}



function handleLine(line: string): void {

  if (!line.trim()) return;

  let parsed: { id?: string; text?: string; error?: string };

  try {

    parsed = JSON.parse(line);

  } catch {

    console.warn('[ocr-worker] invalid json from worker:', line);

    return;

  }

  const id = parsed.id || '';

  const req = pending.get(id);

  if (!req) return;

  pending.delete(id);

  clearTimeout(req.timer);

  if (parsed.error) {

    req.reject(new Error(parsed.error));

  } else {

    req.resolve(parsed.text ?? '');

  }

}



async function tryDdddocr(base64Image: string): Promise<OcrResult> {

  try {

    await startWorker();

  } catch (err) {

    // Don't log here — startWorker already logged once, and we'd be noisy

    // per-captcha during fallback periods.

    return { text: '', confidence: 0, rawText: '' };

  }

  if (!worker || !worker.stdin.writable) {

    return { text: '', confidence: 0, rawText: '' };

  }



  const id = randomUUID();

  try {

    const text = await new Promise<string>((resolve, reject) => {

      const timer = setTimeout(() => {

        pending.delete(id);

        reject(new Error(`OCR request timed out after ${REQUEST_TIMEOUT_MS}ms`));

      }, REQUEST_TIMEOUT_MS);

      pending.set(id, { resolve, reject, timer });

      try {

        worker!.stdin.write(JSON.stringify({ id, img: base64Image }) + '\n');

      } catch (err) {

        pending.delete(id);

        clearTimeout(timer);

        reject(err instanceof Error ? err : new Error(String(err)));

      }

    });

    const normalized = text.trim().replace(/[^a-zA-Z0-9]/g, '').toUpperCase();

    return {

      text: normalized,

      confidence: normalized.length >= 4 ? 100 : 0,

      rawText: text.trim(),

    };

  } catch (err) {

    return { text: '', confidence: 0, rawText: '' };

  }

}



function shutdown() {

  if (worker) {

    try { worker.kill(); } catch { /* ignore */ }

    worker = null;

    workerReady = null;

  }

  failAllPending('host process exiting');

}

process.once('exit', shutdown);

process.once('SIGINT', shutdown);

process.once('SIGTERM', shutdown);



// ─── Tesseract worker pool (fallback path) ─────────────────────────────────
// tesseract.js's createWorker is ~500ms-1s due to traineddata loading. A worker
// can only `recognize` one image at a time, so we keep a small pool alive and
// borrow one per OCR job. ddddocr is the primary engine and handles concurrency
// natively (UUID-keyed pending map), so this pool only kicks in when Python /
// ddddocr is unavailable — but under load that path is the one that bottlenecks.

type TesseractWorker = Awaited<ReturnType<typeof import('tesseract.js').createWorker>>;
const TESSERACT_POOL_SIZE = 2;
const tesseractPool: TesseractWorker[] = [];
const tesseractFree: TesseractWorker[] = [];
const tesseractWaiters: Array<(w: TesseractWorker) => void> = [];
let tesseractPoolInit: Promise<void> | null = null;

async function initTesseractPool(): Promise<void> {
  if (tesseractPoolInit) return tesseractPoolInit;
  tesseractPoolInit = (async () => {
    const { createWorker } = await import('tesseract.js');
    // Spawn workers in parallel; failures bubble up but we still expose any that started.
    const created = await Promise.all(
      Array.from({ length: TESSERACT_POOL_SIZE }, async () => {
        const w = await createWorker('eng', 1, { logger: () => {}, errorHandler: () => {} });
        await w.setParameters({
          tessedit_char_whitelist: CHARSET,
          tessedit_pageseg_mode: '7' as unknown as undefined,
        });
        return w;
      }),
    );
    for (const w of created) {
      tesseractPool.push(w);
      tesseractFree.push(w);
    }
  })().catch((err) => {
    tesseractPoolInit = null; // allow retry on next call
    throw err;
  });
  return tesseractPoolInit;
}

async function acquireTesseract(): Promise<TesseractWorker> {
  await initTesseractPool();
  const free = tesseractFree.shift();
  if (free) return free;
  return new Promise<TesseractWorker>((resolve) => tesseractWaiters.push(resolve));
}

function releaseTesseract(w: TesseractWorker): void {
  const next = tesseractWaiters.shift();
  if (next) { next(w); return; }
  tesseractFree.push(w);
}

async function tryTesseract(base64Image: string): Promise<OcrResult> {
  if (ocrStatus.engine === 'unknown') ocrStatus.engine = 'tesseract';
  const buffer = Buffer.from(base64Image, 'base64');

  const { default: sharp } = await import('sharp');
  const preprocessed = await sharp(buffer)
    .resize({ width: 200, fit: 'inside' })
    .grayscale()
    .normalize()
    .toFormat('png')
    .toBuffer();

  const w = await acquireTesseract();
  try {
    const { data } = await w.recognize(preprocessed);
    const text = data.text.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().trim();
    return { text, confidence: data.confidence, rawText: data.text };
  } finally {
    releaseTesseract(w);
  }
}
