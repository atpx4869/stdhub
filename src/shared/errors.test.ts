import { describe, it, expect } from 'vitest';
import { summarizeSyncError } from './errors';

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
