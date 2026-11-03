import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { availabilityIsFresh, classifyGbwTextPage, textAvailability } from './text-availability';

const page = (content = '') => '<html><body><h1>中文标准名称：测试标准</h1><p>标准号：GB/T 1234-2024</p>' + content + '</body></html>';
const preview = '<a class="ck_btn" onclick="showGb()">在线预览</a>';

describe('classifyGbwTextPage', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  it.each([
    preview,
    '<a class="xz_btn" href="/download/example">下载标准</a>',
    '<button class="xz_btn" onclick="downloadText()">全文下载</button>',
    '<a class="ck_btn" data-value="0123456789abcdef0123456789abcdef">在线预览</a>',
  ])('recognizes an actionable full-text entry: %s', control => {
    expect(classifyGbwTextPage(page(control))).toEqual({ state: 'available', reason: 'fulltext_entry', checkedAt: '2026-11-03T00:00:00.000Z' });
  });

  it('confirms absence only on a recognizable standard detail page', () => {
    expect(classifyGbwTextPage(page())).toMatchObject({ state: 'unavailable', reason: 'no_fulltext_entry' });
  });

  it.each(['', '<html><body>403 Forbidden</body></html>', '<h1>Access Denied</h1>', '<p>Just a moment...</p>', '<p>请输入验证码</p>', '<p>安全验证</p>', '<p>访问过于频繁</p>', '<p>标准号：GB/T 1234-2024</p>', '<p>中文标准名称：测试标准</p>'])('keeps empty, blocked, captcha or incomplete pages unknown: %s', html => {
    expect(classifyGbwTextPage(html).state).toBe('unknown');
  });

  it('does not trust a full-text control on an unrecognizable page', () => {
    expect(classifyGbwTextPage(preview)).toMatchObject({ state: 'unknown', reason: 'unrecognized_page' });
  });

  it('verification takes precedence even when standard metadata and a control remain', () => {
    expect(classifyGbwTextPage(page('<p>访问验证</p>' + preview))).toMatchObject({ state: 'unknown', reason: 'verification_or_access_denied' });
  });

  it('ignores script, style and noscript content as full-text or denial evidence', () => {
    const inert = '<script>const html = ' + JSON.stringify(preview + 'Access Denied') + ';</script><style>.foo::before { content: "安全验证"; }</style><noscript>' + preview + '</noscript>';
    expect(classifyGbwTextPage(page(inert))).toMatchObject({ state: 'unavailable', reason: 'no_fulltext_entry' });
  });

  it('ignores standard metadata embedded only in scripts', () => {
    expect(classifyGbwTextPage('<script>' + page() + '</script>' + preview).state).toBe('unknown');
  });

  it.each([
    '<div style="display: none">' + preview + '</div>',
    '<section style="visibility: hidden"><div>' + preview + '</div></section>',
    '<a class="ck_btn" style="display:none" onclick="showGb()">在线预览</a>',
    '<button class="ck_btn" disabled onclick="showGb()">在线预览</button>',
    '<a class="ck_btn disabled" onclick="showGb()">在线预览</a>',
    '<a class="ck_btn" aria-disabled="true" onclick="showGb()">在线预览</a>',
    '<a class="ck_btn">在线预览</a>',
  ])('does not mistake hidden, disabled or unrecognized controls for available text: %s', control => {
    expect(classifyGbwTextPage(page(control))).toMatchObject({ state: 'unknown', reason: 'unrecognized_fulltext_control' });
  });

  it('allows a usable control alongside a hidden control', () => {
    expect(classifyGbwTextPage(page('<div style="display:none">' + preview + '</div>' + preview)).state).toBe('available');
  });
});

describe('availabilityIsFresh', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-03T00:00:00Z')); });
  afterEach(() => vi.useRealTimers());

  it.each([['available', 86_400_000], ['unavailable', 21_600_000], ['unknown', 30_000]] as const)('expires %s evidence exactly at its TTL', (state, ttl) => {
    const value = textAvailability(state, 'fixture');
    expect(availabilityIsFresh(value)).toBe(true);
    vi.advanceTimersByTime(ttl - 1);
    expect(availabilityIsFresh(value)).toBe(true);
    vi.advanceTimersByTime(1);
    expect(availabilityIsFresh(value)).toBe(false);
  });

  it.each(['not-a-date', '2026-11-03T00:00:01Z'])('rejects invalid or future check timestamps: %s', checkedAt => {
    expect(availabilityIsFresh({ state: 'available', reason: 'fixture', checkedAt })).toBe(false);
  });
});
