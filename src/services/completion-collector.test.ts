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

  it('fills lifecycle dates from detail and normalizes compact values', async () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE standard_files (std_code_norm TEXT, year TEXT, abs_path TEXT, file_name TEXT, size INTEGER, mime TEXT, indexed_at TEXT)');
    const summary: StandardSummary = {
      id: 'bz:1', source: 'bz', sourceId: '1', standardNumber: 'GB/T 1-2020', title: '测试标准',
      status: '已经废止', publishDate: null, implementDate: '2021-01-01', abolishedDate: null, previewAvailable: false,
    };
    const reg = registry(async () => [summary]);
    reg.get().getStandardDetail = async () => ({
      ...summary, publishDate: '20200102', abolishedDate: '2024年6月1日', contentText: '', moreInfo: {},
    });
    const collector = new CompletionCollector(db, reg, process.cwd());
    const plan = new CompletionFieldRegistry().compilePlan([
      'lifecycle.publishDate', 'lifecycle.implementDate', 'lifecycle.abolishedDate',
    ]);
    const rows = await collector.collect([{ rowNumber: 2, value: 'GB/T 1-2020', valid: true }], plan, {
      apiVersion: 2, registryVersion: 1, sheetName: 'Data', headerRow: 1, inputColumn: 'A', outputColumn: 'B', fieldIds: plan.fields.map(field => field.fieldId), sources: ['bz'], detectionPolicy: 'none', previewLimit: 8,
    }, new AbortController().signal, () => {});

    expect(rows.get(2)?.values).toMatchObject({
      'lifecycle.publishDate': '2020-01-02',
      'lifecycle.implementDate': '2021-01-01',
      'lifecycle.abolishedDate': '2024-06-01',
    });
    db.close();
  });
});
