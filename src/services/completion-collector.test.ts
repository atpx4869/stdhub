import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';

import type { SourceAdapter, StandardSummary } from '../domain/standard';
import { CompletionCollector } from './completion-collector';
import { CompletionFieldRegistry } from './completion-field-registry';

function registry(search: (query: string) => StandardSummary[] | Promise<StandardSummary[]>) {
  const adapter: SourceAdapter = {
    source: 'bz',
    async searchStandards(input) { return search(input.query); },
    async getStandardDetail() { throw new Error('not needed'); },
    async detectPreview(id) { return { standardId: id, pageUrls: [], meta: {} }; },
    async exportStandard(id) { return { standardId: id, filePath: '', fileName: '' }; },
  };
  return { get: () => adapter, list: () => ['bz'] } as any;
}

describe('CompletionCollector invalid input attribution', () => {
  it('queries only valid rows and writes invalid_input diagnostics per row', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE standard_files (std_code_norm TEXT, year TEXT, abs_path TEXT, file_name TEXT, size INTEGER, mime TEXT, indexed_at TEXT)');
    const search = vi.fn(async () => []);
    const collector = new CompletionCollector(db, registry(search), process.cwd());
    const plan = new CompletionFieldRegistry().compilePlan(['standard.title.zh', 'match.state', 'error.summary']);
    const rows = await collector.collect([
      { rowNumber: 2, value: 'GB 1-2020', valid: true },
      { rowNumber: 3, value: 'not-a-standard', valid: false },
      { rowNumber: 4, value: 'A1', valid: false, inputError: 'formula_without_cached_result' },
    ], plan, {
      apiVersion: 2, registryVersion: 1, sheetName: 'Data', headerRow: 1, inputColumn: 'A', outputColumn: 'B', fieldIds: plan.fields.map(field => field.fieldId), sources: ['bz'], detectionPolicy: 'none', previewLimit: 8,
    }, new AbortController().signal, () => {});

    expect(search).toHaveBeenCalledTimes(1);
    expect(rows.get(3)?.values).toMatchObject({ 'standard.title.zh': '', 'match.state': '输入无效', 'error.summary': '输入格式无法识别' });
    expect(rows.get(4)?.values).toMatchObject({ 'match.state': '输入无效', 'error.summary': '输入公式没有可用的缓存结果' });
    db.close();
  });
});
