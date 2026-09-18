import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(__dirname, '../../public/js/history-locate.js'), 'utf8');
const sandbox: Record<string, any> = { globalThis: {}, module: { exports: {} } };
vm.runInNewContext(source, sandbox);
const { chooseLegacyHistoryCandidate } = sandbox.module.exports as {
  chooseLegacyHistoryCandidate: (candidates: any[], fileName: string, standardNumber: string) => { candidate: any; ambiguous: boolean };
};

describe('chooseLegacyHistoryCandidate', () => {
  const candidates = [
    { id: 1, fileName: '中文 空格.pdf', standardNumber: 'GB 1-2020' },
    { id: 2, fileName: '中文 空格.pdf', standardNumber: 'GB 2-2020' },
    { id: 3, fileName: '唯一.pdf', standardNumber: 'GB 3-2020' },
  ];

  it('returns the only exact filename match', () => {
    expect(chooseLegacyHistoryCandidate(candidates, '唯一.pdf', '')).toEqual({ candidate: candidates[2], ambiguous: false });
  });

  it('uses the standard number to disambiguate duplicate filenames', () => {
    expect(chooseLegacyHistoryCandidate(candidates, '中文 空格.pdf', 'GB 2-2020')).toEqual({ candidate: candidates[1], ambiguous: false });
  });

  it('reports ambiguous duplicate filenames instead of choosing the first', () => {
    expect(chooseLegacyHistoryCandidate(candidates, '中文 空格.pdf', '')).toEqual({ candidate: null, ambiguous: true });
  });
});
