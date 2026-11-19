import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UpstreamGate, getUpstreamGate, resetUpstreamGates } from './upstream-gate';

describe('UpstreamGate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-19T00:00:00Z'));
    resetUpstreamGates();
  });
  afterEach(() => vi.useRealTimers());

  it('lets the first wait through immediately', async () => {
    const gate = new UpstreamGate('openstd', { initialMs: 10_000 });
    await expect(gate.wait()).resolves.toBe(0);
  });

  it('waits out the cooldown after a reward and shrinks it', async () => {
    const gate = new UpstreamGate('openstd', { initialMs: 10_000, minMs: 4_000, maxMs: 60_000 });
    gate.reward();
    expect(gate.cooldown).toBe(8_000);
    const pending = gate.wait();
    await vi.advanceTimersByTimeAsync(7_999);
    await Promise.resolve();
    expect(gate.successes).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(pending).resolves.toBe(8_000);
  });

  it('lengthens the cooldown after a penalty', () => {
    const gate = new UpstreamGate('openstd', { initialMs: 10_000, maxMs: 60_000 });
    gate.penalize();
    expect(gate.hits).toBe(1);
    expect(gate.cooldown).toBe(15_000);
  });

  it('reuses a named singleton until reset', () => {
    const first = getUpstreamGate('openstd', { initialMs: 10_000 });
    first.penalize();
    expect(getUpstreamGate('openstd')).toBe(first);
    resetUpstreamGates();
    expect(getUpstreamGate('openstd')).not.toBe(first);
  });
});
