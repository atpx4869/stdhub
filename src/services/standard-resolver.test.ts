import { describe, expect, it } from 'vitest';

import type { SourceAdapter, SourceName, StandardSummary } from '../domain/standard';
import { StandardResolver } from './standard-resolver';

function summary(source: SourceName, id: string, standardNumber: string, title = 'Test standard'): StandardSummary {
  return {
    id,
    source,
    sourceId: id.split(':')[1] || id,
    standardNumber,
    title,
    status: '现行有效',
    publishDate: null,
    implementDate: null,
    abolishedDate: null,
    previewAvailable: true,
    detailUrl: '',
    meta: {},
  };
}

function adapter(source: SourceName, search: (query: string) => StandardSummary[]): SourceAdapter {
  return {
    source,
    async searchStandards(input) {
      return search(input.query);
    },
    async getStandardDetail(id) {
      return summary(source, id, id);
    },
    async detectPreview(id) {
      return { standardId: id, pageUrls: [], meta: {} };
    },
    async exportStandard(id) {
      return { standardId: id, filePath: '', fileName: '' };
    },
  };
}

function registry(adapters: Partial<Record<SourceName, SourceAdapter>>) {
  return {
    get(source: SourceName) {
      const found = adapters[source];
      if (!found) throw new Error(`missing adapter: ${source}`);
      return found;
    },
    list() {
      return Object.keys(adapters) as SourceName[];
    },
  };
}

describe('StandardResolver', () => {
  it('accepts bare number with year and collects real source ids', async () => {
    const resolver = new StandardResolver(registry({
      gbw: adapter('gbw', query => query === '3324-2024' ? [summary('gbw', 'gbw:3324', 'GB/T 3324-2024')] : []),
      bz: adapter('bz', query => query === '3324-2024' ? [summary('bz', 'bz:3324', 'GB/T 3324-2024')] : []),
    }) as any);

    const result = await resolver.resolve(['3324-2024'], ['gbw', 'bz'], { collectSourceIds: true });

    expect(result.unmatched).toEqual([]);
    expect(result.resolved[0]).toMatchObject({
      input: '3324-2024',
      standardNumber: 'GB/T 3324-2024',
      source: 'gbw',
      sourceIds: { gbw: 'gbw:3324', bz: 'bz:3324' },
      sources: ['gbw', 'bz'],
    });
  });

  it('accepts bare number without year and prefers active latest match', async () => {
    const old = {
      ...summary('gbw', 'gbw:3325-old', 'GB/T 3325-2017'),
      status: '废止',
      implementDate: '2017-07-01',
    };
    const current = {
      ...summary('gbw', 'gbw:3325-new', 'GB/T 3325-2024'),
      implementDate: '2025-07-01',
    };
    const resolver = new StandardResolver(registry({
      gbw: adapter('gbw', query => query === '3325' ? [old, current] : []),
    }) as any);

    const result = await resolver.resolve(['3325'], ['gbw']);

    expect(result.unmatched).toEqual([]);
    expect(result.resolved[0]).toMatchObject({
      input: '3325',
      standardId: 'gbw:3325-new',
      standardNumber: 'GB/T 3325-2024',
    });
  });

  it('keeps prefixed standard numbers working', async () => {
    const resolver = new StandardResolver(registry({
      by: adapter('by', query => query === 'GB/T 17657' ? [summary('by', 'by:17657', 'GB/T 17657-2022')] : []),
    }) as any);

    const result = await resolver.resolve(['GB/T 17657'], ['by']);

    expect(result.unmatched).toEqual([]);
    expect(result.resolved[0]?.standardNumber).toBe('GB/T 17657-2022');
  });
});
