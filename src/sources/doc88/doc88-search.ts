import { pooledFetch } from '../../shared/http';
import { UpstreamError } from '../../shared/errors';
import { extractStdCodeFromTitle } from '../labr/labr-client';
import { cleanStdCode } from '../../shared/std-code';
import type { Doc88SearchItem } from '../../domain/doc88';

export const DOC88_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/71.0.3578.98 Safari/537.36';
const DOC88_SEARCH = 'https://www.doc88.com/search/post.do';

export function hasDoc88NextPage(html: string, page: number): boolean {
  const targets = [...html.matchAll(/Search\.searchPage\(['"]p=(\d+)['"]\)/g)];
  return targets.some(match => Number(match[1]) > page);
}

function decodeHtml(value: string): string {
  return value
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)));
}

export function parseDoc88SearchHtml(html: string, limit = 20): Doc88SearchItem[] {
  const itemRe = /<a href=["']https:\/\/www\.doc88\.com\/p-(\d+)\.html\?format=([^"']+)["'][^>]*class=["'][^"']*sd-title[^"']*["'][^>]*title=["']([^"']*)["']/gi;
  const items: Doc88SearchItem[] = [];
  const seen = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = itemRe.exec(html)) && items.length < limit) {
    const pcode = match[1];
    if (String(match[2]).toUpperCase() !== 'PDF' || seen.has(pcode)) continue;
    seen.add(pcode);
    const title = decodeHtml(match[3]).replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    // A list row may omit metadata; never borrow dates/pages from the next row.
    const nextRow = html.indexOf('class="sd-list-con"', itemRe.lastIndex);
    const nextAnchor = html.indexOf('<a href="https://www.doc88.com/p-', itemRe.lastIndex);
    const boundaries = [nextRow, nextAnchor, html.length].filter(index => index > match!.index);
    const block = html.slice(match.index, Math.min(...boundaries));
    const pagesRaw = block.match(/页数[：:]\s*(\d+)/)?.[1];
    const date = block.match(/上传时间[：:]\s*([\d-]+)/)?.[1] || '';
    const parsed = extractStdCodeFromTitle(title);
    const standardNumber = parsed.stdCode ? cleanStdCode(parsed.stdCode) : '';
    items.push({
      pcode,
      title,
      pages: pagesRaw ? Number.parseInt(pagesRaw, 10) : null,
      date,
      standardNumber,
      cleanTitle: parsed.rest || title,
    });
  }
  return items;
}

export async function searchDoc88(
  keyword: string,
  page: number,
  pageSize: number,
  signal?: AbortSignal,
): Promise<{ items: Doc88SearchItem[]; hasMore: boolean }> {
  const url = new URL(DOC88_SEARCH);
  url.searchParams.set('f', '0');
  url.searchParams.set('h', '1');
  url.searchParams.set('pageRange', '0');
  url.searchParams.set('pageNum', '');
  url.searchParams.set('format', 'PDF');
  url.searchParams.set('p', String(page));
  url.searchParams.set('ct', '2');
  url.searchParams.set('sDate', '');
  url.searchParams.set('eDate', '');
  url.searchParams.set('q', keyword);
  const response = await pooledFetch(url.toString(), {
    headers: { 'User-Agent': DOC88_UA, Referer: 'https://www.doc88.com/' },
    timeoutMs: 30_000,
    retries: 2,
    signal,
  });
  if (!response.ok) throw new UpstreamError(`Doc88 搜索 HTTP ${response.status}`);
  const html = await response.text();
  if (/安全验证|频繁操作/.test(html)) throw new UpstreamError('Doc88 当前触发了访问频率限制');
  if (html.includes('暂无搜索结果')) return { items: [], hasMore: false };
  const items = parseDoc88SearchHtml(html, pageSize);
  return { items, hasMore: hasDoc88NextPage(html, page) };
}
