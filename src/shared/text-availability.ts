import { load } from 'cheerio';

export type TextAvailabilityState = 'available' | 'unavailable' | 'unknown';
export interface TextAvailability {
  state: TextAvailabilityState;
  reason: string;
  checkedAt: string;
}
export function textAvailability(state: TextAvailabilityState, reason: string): TextAvailability {
  return { state, reason, checkedAt: new Date().toISOString() };
}
export function availabilityIsFresh(value: TextAvailability): boolean {
  const ttl = value.state === 'available' ? 86400000 : value.state === 'unavailable' ? 21600000 : 30000;
  const age = Date.now() - Date.parse(value.checkedAt);
  return Number.isFinite(age) && age >= 0 && age < ttl;
}

/** Classify only a recognizable official standard page. Script/style text is not evidence. */
export function classifyGbwTextPage(html: string): TextAvailability {
  const $ = load(html);
  $('script, style, noscript').remove();
  const body = $('body').text().replace(/\s+/g, ' ');
  if (/访问验证|安全验证|请输入验证码|访问过于频繁|Access Denied|Just a moment/i.test(body)) {
    return textAvailability('unknown', 'verification_or_access_denied');
  }
  const standardNumber = /GB(?:\s*\/\s*[TZ])?\s*\d+[.\d]*\s*[-—]\s*\d{4}/i.test(body);
  const normalPage = standardNumber && /标准号|标准编号/.test(body) && /标准名称|中文标准名称/.test(body);
  if (!normalPage) return textAvailability('unknown', 'unrecognized_page');
  const controls = $('.ck_btn, .xz_btn').toArray();
  const usable = controls.some(el => {
    const node = $(el);
    return !node.is('[disabled], .disabled, [aria-disabled="true"]') &&
      !node.parents().addBack().toArray().some(parent => /display\s*:\s*none|visibility\s*:\s*hidden/i.test($(parent).attr('style') || '')) &&
      /在线预览|下载标准|全文下载/.test(node.text()) &&
      (/^[A-Fa-f0-9]{32}$/.test(node.attr('data-value') || '') ||
        /showGb|viewGb|download|showInfo|online/i.test((node.attr('onclick') || '') + ' ' + (node.attr('href') || '')));
  });
  if (usable) return textAvailability('available', 'fulltext_entry');
  // A disabled/unrecognized control might represent a changed upstream format.
  if (controls.length) return textAvailability('unknown', 'unrecognized_fulltext_control');
  return textAvailability('unavailable', 'no_fulltext_entry');
}
