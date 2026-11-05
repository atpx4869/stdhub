import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const frontend = readFileSync('public/js/app-preview.js', 'utf8');
const backend = readFileSync('src/api/preview-routes.ts', 'utf8');
const providers = [ ['bz', 'BZ', '标准网'], ['gbw', 'BW', '国家标准全文公开系统'], ['by', 'BY', '标准院'] ];
function harness() {
  const body = { innerHTML: '' };
  const context = vm.createContext({
    document: { getElementById: (id: string) => id === 'previewBody' ? body : null },
    escapeHtml: (s: unknown) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
  });
  vm.runInContext(frontend, context);
  return { body, context };
}

describe('preview source aliases', () => {
  it.each(providers)('uses %s alias in backend progress labels', (source, alias) => {
    const map = backend.match(/const SOURCE_LABELS: Record<LibrarySourceName, string> = (\{[\s\S]*?\n\});/)?.[1];
    expect(map).toBeTruthy();
    expect(vm.runInNewContext('(' + map + ')')[source]).toBe(alias);
  });
  it.each(providers)('does not trust full provider labels in %s task payloads', (source, alias, fullName) => {
    const { body, context } = harness();
    context.payload = { source, sourceLabel: fullName, phase: 'downloading', message: '正在从 ' + fullName + ' 下载 PDF…' };
    vm.runInContext('renderPreviewTaskProgress(payload, 1, "GB/T 123-2024")', context);
    expect(body.innerHTML).toContain('正在从 ' + alias + ' 下载 PDF');
    expect(body.innerHTML).not.toContain(fullName);
  });
  it('sanitizes fallback and failure text while preserving escaping', () => {
    const { body, context } = harness();
    context.message = '标准网 下载失败 <img src=x onerror=alert(1)>';
    vm.runInContext('renderPreviewFailedUi(message, { retry: false })', context);
    expect(body.innerHTML).toContain('BZ 下载失败 &lt;img');
    expect(body.innerHTML).not.toContain('标准网');
    expect(body.innerHTML).not.toContain('<img');
  });
  it('does not render unrecognized provider labels', () => {
    const { body, context } = harness();
    context.payload = { source: 'unknown', sourceLabel: '隐藏的真实来源' };
    vm.runInContext('renderPreviewTaskProgress(payload, 1, "test")', context);
    expect(body.innerHTML).not.toContain('隐藏的真实来源');
  });
});
