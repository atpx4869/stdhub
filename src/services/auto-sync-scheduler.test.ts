import { describe, expect, it } from 'vitest';
import { computeNextFireMs, validateCronExpression } from './auto-sync-scheduler';

describe('auto-sync cron scheduling', () => {
  it('finds a monthly trigger more than seven days away', () => {
    const now = new Date(2026, 0, 2, 0, 0, 0, 0);
    const delay = computeNextFireMs('0 3 1 * *', now);

    expect(delay).not.toBeNull();
    const next = new Date(now.getTime() + delay!);
    expect([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()])
      .toEqual([2026, 1, 1, 3, 0]);
  });

  it('finds an annual trigger across the year boundary', () => {
    const now = new Date(2026, 0, 2, 0, 0, 0, 0);
    const delay = computeNextFireMs('0 0 1 1 *', now);

    expect(delay).not.toBeNull();
    const next = new Date(now.getTime() + delay!);
    expect([next.getFullYear(), next.getMonth(), next.getDate(), next.getHours(), next.getMinutes()])
      .toEqual([2027, 0, 1, 0, 0]);
  });

  it('still rejects malformed expressions', () => {
    expect(() => validateCronExpression('0 25 * * *')).toThrow();
    expect(() => validateCronExpression('invalid cron')).toThrow();
  });
});
