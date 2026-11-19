import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamGate, getUpstreamGate, resetUpstreamGates } from './upstream-gate';

describe('UpstreamGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
    resetUpstreamGates();
  });
  afterEach(() => vi.useRealTimers());

  it('never paces healthy requests, including repeated rewards', async () => {
    const gate = new UpstreamGate('openstd');
    for (let i = 0; i < 100; i++) {
      await expect(gate.wait()).resolves.toBe(0);
      gate.reward();
    }
    expect(gate.cooldown).toBe(0);
    expect(gate.successes).toBe(100);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('backs off from initial to maximum and recovers without a minimum wait', async () => {
    const gate = new UpstreamGate('openstd');
    for (const delay of [10_000, 15_000, 22_500, 33_750, 50_625, 60_000, 60_000]) {
      gate.penalize();
      expect(gate.cooldown).toBe(delay);
      let done = false;
      const pending = gate.wait().then(value => { done = true; return value; });
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe(delay);
    }
    gate.reward();
    expect(gate.cooldown).toBe(0);
    await expect(gate.wait()).resolves.toBe(0);
    gate.penalize();
    expect(gate.cooldown).toBe(10_000);
  });

  it('rechecks extensions and does not let an in-flight success erase a penalty', async () => {
    const gate = new UpstreamGate('openstd');
    gate.penalize();
    let done = false;
    const pending = gate.wait().then(value => { done = true; return value; });
    await vi.advanceTimersByTimeAsync(5_000);
    gate.penalize();
    gate.reward();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(20_000);
  });

  it('reuses a named singleton until reset', () => {
    const first = getUpstreamGate('openstd');
    first.penalize();
    expect(getUpstreamGate('openstd')).toBe(first);
    resetUpstreamGates();
    expect(getUpstreamGate('openstd')).not.toBe(first);
  });
});
