import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(path.resolve(__dirname, '../../public/js/app-qual-search.js'), 'utf8');
const functionSource = source.slice(source.indexOf('async function fetchQualBadges('), source.indexOf('(function bindQualificationResultActions'));
function setup() {
  let resolve!: (response: unknown) => void;
  const response = new Promise(done => { resolve = done; });
  const fetch = vi.fn(() => response);
  const context = vm.createContext({ qualData: {}, window: { StdHub: { api: { fetch } } }, readApiResponse: async (value: { data: unknown }) => value.data });
  vm.runInContext(functionSource, context);
  const run = (code: string) => vm.runInContext(code, context);
  return { run, fetch, resolve };
}

describe('qualification badges respect the current search cache', () => {
  it('does not request or redraw already-known qualification results', async () => {
    const ui = setup();
    ui.run("qualData['GB/T 1-2024'] = []");
    expect(await ui.run("fetchQualBadges(['GB/T 1-2024'])")).toBe(false);
    expect(ui.fetch).not.toHaveBeenCalled();
  });

  it('ignores a badge response after a newer search replaces its cache', async () => {
    const ui = setup();
    const pending = ui.run("fetchQualBadges(['GB/T 1-2024'])");
    ui.run('qualData = {}');
    ui.resolve({ ok: true, data: { 'GB/T 1-2024': [{ source: 'CNAS' }] } });
    expect(await pending).toBe(false);
    expect(ui.run('Object.keys(qualData)')).toEqual([]);
  });

  it('merges a current response and records confirmed misses without replacing other badges', async () => {
    const ui = setup();
    ui.run("qualData['GB/T 2-2024'] = [{source: 'CMA'}]");
    const pending = ui.run("fetchQualBadges(['GB/T 1-2024', 'GB/T 3-2024'])");
    ui.resolve({ ok: true, data: { 'GB/T 1-2024': [{ source: 'CNAS' }] } });
    expect(await pending).toBe(true);
    expect(ui.run('qualData')).toEqual({ 'GB/T 1-2024': [{ source: 'CNAS' }], 'GB/T 2-2024': [{ source: 'CMA' }], 'GB/T 3-2024': [] });
  });

  it('does not treat a failed request as changed qualification evidence', async () => {
    const ui = setup();
    const pending = ui.run("fetchQualBadges(['GB/T 1-2024'])");
    ui.resolve({ ok: false });
    expect(await pending).toBe(false);
    expect(ui.run('Object.keys(qualData)')).toEqual([]);
  });
});
