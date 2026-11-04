import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

// Exercise shipped functions, not copies of the merge/poll implementation.
function setup() {
  const node = { style: {}, addEventListener() {}, appendChild() {} };
  const frames: Array<() => void> = [];
  const context = vm.createContext({
    window: {}, document: { createElement: () => node, body: node,
      querySelectorAll: () => [], getElementById: () => node, addEventListener() {} },
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    cancelAnimationFrame() {},
  });
  const file = path.resolve(__dirname, '../../public/js/app-search-core.js');
  vm.runInContext(readFileSync(file, 'utf8'), context, { filename: file });
  const run = (code: string) => vm.runInContext(code, context);
  return { run, frames, context };
}

const item = (id: string, source: string, code = 'GB/T 3324-2024') => ({
  id, sourceId: id, _source: source, standardNumber: code, title: '木家具通用技术条件', status: '现行',
  previewAvailable: false, textAvailability: { state: 'unknown', reason: 'not_checked' },
});

describe('search stability: incremental source and evidence updates', () => {
  it('keeps default order stable when a later result gains text availability', () => {
    const ui = setup();
    ui.context.list = [
      { ...item('first', 'gbw'), _searchRank: 0 },
      { ...item('second', 'gbw'), _searchRank: 1, previewAvailable: true },
    ];
    expect(ui.run('list.sort(sortByStatus).map(r => r.id)')).toEqual(['first', 'second']);
    ui.run('list[0].previewAvailable = true; list[1].previewAvailable = false');
    expect(ui.run('list.sort(sortByStatus).map(r => r.id)')).toEqual(['first', 'second']);
  });

  it('coalesces concurrent background completions without dropping filter/toolbar refresh requests', () => {
    const ui = setup();
    const render = vi.fn(), filter = vi.fn(), toolbar = vi.fn();
    Object.assign(ui.context, { renderResults: render, renderFilterBar: filter, updateToolbar: toolbar });
    ui.run('scheduleResultsRender(); scheduleResultsRender({ filterBar: true }); scheduleResultsRender({ toolbar: true })');
    expect(ui.frames).toHaveLength(1);
    ui.frames.shift()!();
    expect(render).toHaveBeenCalledTimes(1);
    expect(filter).toHaveBeenCalledTimes(1);
    expect(toolbar).toHaveBeenCalledTimes(1);
    ui.run('scheduleResultsRender()'); ui.frames.shift()!();
    expect(render).toHaveBeenCalledTimes(2);
    expect(filter).toHaveBeenCalledTimes(1);
    expect(toolbar).toHaveBeenCalledTimes(1);
  });

  it('retains canonical identity and first-seen order when a second source arrives late', () => {
    const ui = setup();
    const early = [item('bw-1', 'gbw'), item('bw-2', 'gbw', 'GB/T 100-2024')];
    const late = [item('bz-1', 'bz', 'GB/T3324—2024'), item('bz-3', 'bz', 'GB/T 200-2024')];
    ui.context.early = early; ui.context.late = late;
    ui.run('var first = dedupeResults(early); var merged = dedupeResults([...early, ...late])');
    const merged = ui.run('merged');
    expect(merged.map((r: { id: string }) => r.id)).toEqual(['bw-1', 'bw-2', 'bz-3']);
    expect(merged[0].sources).toEqual(['gbw', 'bz']);
    expect(merged[0]._sourceIds).toEqual({ gbw: 'bw-1', bz: 'bz-1' });
    expect(ui.run('first[0]._searchRank === merged[0]._searchRank')).toBe(true);
  });

  it('does not regress a completed BW probe when raw unknown results are merged again', () => {
    const ui = setup(); ui.context.raw = [item('bw-1', 'gbw')];
    ui.run("var first = dedupeResults(raw); setResultSourceAvailability(first[0], 'gbw', { state: 'available', reason: 'probe' }); var merged = dedupeResults([...raw, " + JSON.stringify(item('bz-1', 'bz')) + '])');
    expect(ui.run('merged[0]._textAvailabilityBySource.gbw')).toEqual({ state: 'available', reason: 'probe' });
    expect(ui.run('merged[0].previewAvailable')).toBe(true);
    expect(ui.run('merged[0]._previewAvailableBySource.gbw')).toBe(true);
  });

  it('keeps evidence independent when a late unavailable source joins an available BW result', () => {
    const ui = setup(); ui.context.raw = [item('bw-1', 'gbw')];
    ui.run("var first = dedupeResults(raw); setResultSourceAvailability(first[0], 'gbw', { state: 'available', reason: 'probe' }); var merged = dedupeResults([...raw, " + JSON.stringify({ ...item('by-1', 'by'), textAvailability: { state: 'unavailable', reason: 'source_result' } }) + '])');
    expect(ui.run('merged[0]._previewAvailableBySource')).toEqual({ gbw: true, by: false });
    expect(ui.run('merged[0].previewAvailable')).toBe(true);
  });
});
