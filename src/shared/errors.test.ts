import { describe, it, expect } from 'vitest';
import { classifyQualificationSyncError, summarizeSyncError } from './errors';

describe('classifyQualificationSyncError', () => {
  it('does not retry configuration or suspicious snapshot failures', () => {
    expect(classifyQualificationSyncError(new Error('No base_info_id for lab: L0290'))).toEqual({
      code: 'CONFIGURATION', retryable: false, delaysMs: [],
    });
    expect(classifyQualificationSyncError(new Error('CNAS snapshot rejected: fetched 10 records'))).toEqual({
      code: 'SNAPSHOT_REJECTED', retryable: false, delaysMs: [],
    });
  });

  it('uses longer backoff for rate limits and anti-bot challenges', () => {
    expect(classifyQualificationSyncError(new Error('HTTP 429 Too Many Requests'))).toMatchObject({ code: 'RATE_LIMITED', retryable: true });
    expect(classifyQualificationSyncError(new Error('Non-JSON response (521) __jsl'))).toEqual({
      code: 'ANTI_BOT', retryable: true, delaysMs: [60_000],
    });
  });

  it('retries browser resets immediately and network timeouts with exponential delays', () => {
    expect(classifyQualificationSyncError(new Error('Target page, context or browser has been closed'))).toEqual({
      code: 'BROWSER_RESET', retryable: true, delaysMs: [0],
    });
    expect(classifyQualificationSyncError(new Error('request timed out'))).toEqual({
      code: 'TIMEOUT', retryable: true, delaysMs: [30_000, 120_000],
    });
  });
});

describe('summarizeSyncError', () => {
  it('compresses multi-KB browser launch errors to first line + signal', () => {
    const raw = `browserType.launch: Target page, context or browser has been closed Browser logs: <launching> /opt/google/chrome/chrome --disable-field-trial-config ... (几 KB 参数)`;
    const out = summarizeSyncError(new Error(raw));
    expect(out.length).toBeLessThan(250);
    expect(out).toContain('target_closed');
    expect(out).not.toContain('--disable-field-trial-config');
  });

  it('detects crashpad / SIGTRAP signals', () => {
    const raw = `chrome_crashpad_handler: --database is required\nrecvmsg: Connection reset by peer (104)`;
    const out = summarizeSyncError(new Error(raw));
    expect(out).toContain('chrome_crashpad_handler');
    expect(out).toContain('crashpad_database_missing');
    expect(out).toContain('connection_reset');
  });

  it('handles plain errors and non-Error values', () => {
    expect(summarizeSyncError(new Error('CNAS anti-bot challenge not resolved'))).toContain('anti_bot');
    expect(summarizeSyncError('just a string')).toBe('just a string');
  });

  it('truncates long first lines', () => {
    const long = 'x'.repeat(5000);
    const out = summarizeSyncError(new Error(long));
    expect(out.length).toBeLessThanOrEqual(200);
  });
});
