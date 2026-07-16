/**
 * Simple counting semaphore — FIFO waiter queue.
 *
 * Why we need it: A 用户的批量下载 `downloadConcurrency` 默认 5、B 用户也 5，叠到
 * 后端就是 10 个并发请求打源站；用 server 端 semaphore 把每个 source 的真实出口
 * 并发钉住，跟前端并发数解耦。
 *
 * Use:
 *   const sem = new Semaphore(2);
 *   await sem.acquire();
 *   try { doWork() } finally { sem.release(); }
 *
 * 等价的简洁写法：
 *   await sem.run(() => doWork());
 *
 * acquire 返回 Promise — 容量没空位时排队，先来先得。release 出未持有的位会
 * 抛错（防止 try/finally 漏成对调用）。容量值可以在运行时 setLimit 动态调，
 * 调小不会立即取消已经持有的位、只影响新 acquire 排队等。
 */
export class Semaphore {
  private limit: number;
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(limit: number) {
    if (!Number.isFinite(limit) || limit < 1) throw new Error(`Semaphore limit must be ≥ 1, got ${limit}`);
    this.limit = Math.floor(limit);
  }

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active++;
  }

  release(): void {
    if (this.active <= 0) throw new Error('Semaphore.release() called without matching acquire()');
    this.active--;
    const next = this.waiters.shift();
    if (next) next();
  }

  /** 包装一个异步函数，自动 acquire/release —— 出错时也保证 release */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      this.release();
    }
  }

  /** 调整容量上限。调大会立即唤醒等待者；调小只影响新请求。 */
  setLimit(next: number): void {
    if (!Number.isFinite(next) || next < 1) throw new Error(`Semaphore limit must be ≥ 1, got ${next}`);
    const prev = this.limit;
    this.limit = Math.floor(next);
    if (this.limit > prev) {
      // 容量调大：唤醒尽可能多的等待者直到填满
      while (this.active < this.limit && this.waiters.length > 0) {
        const wake = this.waiters.shift()!;
        wake();
      }
    }
  }

  /** 调试 / 诊断用：当前持有数 + 等待队列长度 */
  stats(): { active: number; limit: number; waiting: number } {
    return { active: this.active, limit: this.limit, waiting: this.waiters.length };
  }
}
