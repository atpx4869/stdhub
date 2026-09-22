import { describe, expect, it } from 'vitest';

import type { SourceAdapter, StandardSummary } from '../domain/standard';
import { CompletionResolver } from './completion-resolver';

function item(source: 'bz' | 'gbw' | 'by', dates: Partial<Pick<StandardSummary, 'publishDate' | 'implementDate' | 'abolishedDate'>>): StandardSummary {
  return {
    id: `${source}:1`, source, sourceId: '1', standardNumber: 'GB/T 13401-2025',
    title: '钢制对焊管件 技术规范', status: '现行', previewAvailable: false,
    detailUrl: `https://example.test/${source}`, meta: {},
    ...dates,
  };
}

function adapter(source: 'bz' | 'gbw' | 'by', rows: StandardSummary[]): SourceAdapter {
  return {
    source,
    async searchStandards() { return rows; },
    async getStandardDetail() { throw new Error('not needed'); },
    async detectPreview(id) { return { standardId: id, pageUrls: [], meta: {} }; },
    async exportStandard(id) { return { standardId: id, filePath: '', fileName: '' }; },
  };
}

describe('CompletionResolver lifecycle fallback', () => {
  it('fills missing winner dates from lower-priority matching sources', async () => {
    const adapters = new Map<string, SourceAdapter>([
      ['bz', adapter('bz', [item('bz', { implementDate: '2026-05-01' })])],
      ['gbw', adapter('gbw', [item('gbw', { publishDate: '2025-10-31', implementDate: '2026-05-01' })])],
      ['by', adapter('by', [])],
    ]);
    const resolver = new CompletionResolver({ get: (source: string) => adapters.get(source)! } as any);
    const result = (await resolver.resolve(['GB/T 13401-2025'], ['bz', 'gbw', 'by'])).get('GB/T 13401-2025')!;

    expect(result.winner?.source).toBe('bz');
    expect(result.winner?.publishDate).toBe('2025-10-31');
    expect(result.winner?.implementDate).toBe('2026-05-01');
    expect(result.qualityWarnings).toContain('生命周期缺失字段已由其他来源补齐');
  });
});
