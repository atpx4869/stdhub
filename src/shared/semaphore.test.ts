import { describe, expect, it } from 'vitest';
import { Semaphore } from './semaphore';

describe('Semaphore', () => {
  it('respects the limit — only N concurrent acquire() in flight', async () => {
    const sem = new Semaphore(2);
    let inFlight = 0;
    let maxInFlight = 0;
    async function task(): Promise<void> {
      await sem.acquire();
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight--;
      sem.release();
    }
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(maxInFlight).toBe(2);
  });

  it('FIFO ordering: waiters resolve in the order they queued', async () => {
    const sem = new Semaphore(1);
    const order: number[] = [];
    await sem.acquire(); // sem 已满，下面三个都会排队
    const p1 = (async () => { await sem.acquire(); order.push(1); sem.release(); })();
    const p2 = (async () => { await sem.acquire(); order.push(2); sem.release(); })();
    const p3 = (async () => { await sem.acquire(); order.push(3); sem.release(); })();
    // 让 promise queue tick 一下，确保三个 acquire 都进了 waiters
    await Promise.resolve();
    sem.release();
    await Promise.all([p1, p2, p3]);
    expect(order).toEqual([1, 2, 3]);
  });

  it('run() releases on success', async () => {
    const sem = new Semaphore(1);
    const result = await sem.run(async () => 42);
    expect(result).toBe(42);
    expect(sem.stats().active).toBe(0);
  });

  it('run() releases on error (release in finally)', async () => {
    const sem = new Semaphore(1);
    await expect(sem.run(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(sem.stats().active).toBe(0);
    // sem 应当能立刻被下一个 acquire 拿走
    await sem.acquire();
    expect(sem.stats().active).toBe(1);
  });

  it('release without acquire throws (catches paired-call bugs)', () => {
    const sem = new Semaphore(1);
    expect(() => sem.release()).toThrow();
  });

  it('setLimit grows: pending waiters wake up', async () => {
    const sem = new Semaphore(1);
    await sem.acquire(); // 占满
    let resolved = 0;
    const p1 = (async () => { await sem.acquire(); resolved++; })();
    const p2 = (async () => { await sem.acquire(); resolved++; })();
    await Promise.resolve();
    expect(resolved).toBe(0);
    sem.setLimit(3);
    await Promise.all([p1, p2]);
    expect(resolved).toBe(2);
  });

  it('rejects invalid limit', () => {
    expect(() => new Semaphore(0)).toThrow();
    expect(() => new Semaphore(-1)).toThrow();
    expect(() => new Semaphore(Number.NaN)).toThrow();
    const sem = new Semaphore(1);
    expect(() => sem.setLimit(0)).toThrow();
  });
});
