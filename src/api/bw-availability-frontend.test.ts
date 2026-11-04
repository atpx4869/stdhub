import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { TextAvailabilityState } from '../shared/text-availability';

type Availability = { state: TextAvailabilityState; reason: string };
type Result = {
  previewAvailable?: boolean;
  source?: string;
  _source?: string;
  sourceId?: string;
  status?: string;
  sources?: string[];
  textAvailability?: Availability;
  _sourceIds?: Record<string, string>;
  _textAvailabilityBySource?: Record<string, Availability>;
  _previewAvailableBySource?: Record<string, boolean | null>;
  _gbwTextChecked?: boolean;
};
interface Helpers {
  sourceTextAvailability(item: Result, source: string): Availability;
  setResultSourceAvailability(result: Result, source: string, availability: Availability): boolean;
  resolveTextState(result: Result): string;
}

// Execute the actual frontend scripts, with inert DOM stubs; do not duplicate
// helper implementations or require jsdom, a server, network, or app database.
function loadHelpers(): Helpers {
  const node = { style: {}, addEventListener() {}, appendChild() {} };
  const context = vm.createContext({
    window: {},
    document: { createElement: () => node, body: node, querySelectorAll: () => [], getElementById: () => node, addEventListener() {} },
    localStorage: { getItem: () => null },
    safeJsonParse: (value: string | null, fallback: unknown) => value ? JSON.parse(value) : fallback,
  });
  for (const name of ['app-search-core.js', 'app-search-render.js']) {
    const filename = path.resolve(__dirname, '../../public/js', name);
    vm.runInContext(readFileSync(filename, 'utf8'), context, { filename });
  }
  return context as unknown as Helpers;
}
const state = (value: TextAvailabilityState, reason = 'fixture'): Availability => ({ state: value, reason });

describe('BW frontend per-source text evidence', () => {
  it('does not use a merged preview flag as positive BW evidence', () => {
    const api = loadHelpers();
    expect(api.sourceTextAvailability({ previewAvailable: true, _source: 'bz' }, 'gbw')).toEqual(state('unknown', 'not_checked'));
    expect(api.sourceTextAvailability({ previewAvailable: false, _source: 'gbw' }, 'gbw')).toEqual(state('unknown', 'not_checked'));
  });

  it('uses explicit per-source evidence ahead of top-level and legacy flags', () => {
    const api = loadHelpers();
    const explicit = state('unavailable');
    expect(api.sourceTextAvailability({ _source: 'gbw', textAvailability: state('available'), previewAvailable: true, _textAvailabilityBySource: { gbw: explicit } }, 'gbw')).toEqual(explicit);
  });

  it('accepts top-level evidence only for its matching source', () => {
    const api = loadHelpers();
    expect(api.sourceTextAvailability({ source: 'gbw', textAvailability: state('unavailable') }, 'gbw')).toEqual(state('unavailable'));
    expect(api.sourceTextAvailability({ _source: 'bz', textAvailability: state('available') }, 'gbw')).toEqual(state('unknown', 'not_checked'));
  });

  it('keeps legacy non-BW preview booleans source-local', () => {
    const api = loadHelpers();
    expect(api.sourceTextAvailability({ previewAvailable: true }, 'bz').state).toBe('available');
    expect(api.sourceTextAvailability({ previewAvailable: false }, 'by').state).toBe('unavailable');
  });

  it('represents unknown as null rather than treating an availability object as truthy', () => {
    const api = loadHelpers();
    const result: Result = { _sourceIds: { gbw: 'bw-1' } };
    api.setResultSourceAvailability(result, 'gbw', state('unknown', 'not_checked'));
    expect(result._previewAvailableBySource).toEqual({ gbw: null });
    expect(result.previewAvailable).toBe(false);
    expect(result._gbwTextChecked).toBe(false);
    api.setResultSourceAvailability(result, 'gbw', state('unknown', 'poll_timeout'));
    expect(result.previewAvailable).toBe(false);
    expect(result._gbwTextChecked).toBe(true);
  });

  it('reports no render-worthy change for repeated identical BW evidence', () => {
    const api = loadHelpers();
    const result: Result = { _sourceIds: { gbw: 'bw-1' } };
    expect(api.setResultSourceAvailability(result, 'gbw', state('unknown', 'not_checked'))).toBe(true);
    expect(api.setResultSourceAvailability(result, 'gbw', state('unknown', 'not_checked'))).toBe(false);
    expect(api.setResultSourceAvailability(result, 'gbw', state('available'))).toBe(true);
    expect(api.setResultSourceAvailability(result, 'gbw', state('available'))).toBe(false);
    expect(api.setResultSourceAvailability(result, 'gbw', state('unknown', 'poll_timeout'))).toBe(true);
  });

  it('does not erase other sources when BW reports unavailable or unknown', () => {
    const api = loadHelpers();
    const result: Result = {};
    api.setResultSourceAvailability(result, 'bz', state('available'));
    api.setResultSourceAvailability(result, 'gbw', state('unavailable'));
    expect(result.previewAvailable).toBe(true);
    expect(result._previewAvailableBySource).toEqual({ bz: true, gbw: false });
    api.setResultSourceAvailability(result, 'gbw', state('unknown', 'network_error'));
    expect(result.previewAvailable).toBe(true);
    expect(result._textAvailabilityBySource?.bz.state).toBe('available');
    expect(result._previewAvailableBySource?.gbw).toBeNull();
  });

  it('recomputes aggregate availability when the final positive source disappears', () => {
    const api = loadHelpers();
    const result: Result = {};
    api.setResultSourceAvailability(result, 'gbw', state('available'));
    expect(result.previewAvailable).toBe(true);
    api.setResultSourceAvailability(result, 'gbw', state('unavailable'));
    expect(result.previewAvailable).toBe(false);
  });

  it.each(['现行', '废止', '即将实施'])('renders confirmed text independently of lifecycle status: %s', status => {
    const api = loadHelpers();
    expect(api.resolveTextState({ status, sources: ['gbw'], _textAvailabilityBySource: { gbw: state('available') } })).toBe('text');
    expect(api.resolveTextState({ status, sources: ['gbw'], _textAvailabilityBySource: { gbw: state('unavailable') } })).toBe('no_text');
  });

  it('distinguishes unchecked, terminal unknown, confirmed absence and no source', () => {
    const api = loadHelpers();
    expect(api.resolveTextState({ _source: 'gbw' })).toBe('checking');
    expect(api.resolveTextState({ sources: ['gbw'], _textAvailabilityBySource: { gbw: state('unknown', 'poll_timeout') } })).toBe('unknown');
    expect(api.resolveTextState({ sources: ['gbw'], _textAvailabilityBySource: { gbw: state('unavailable') } })).toBe('no_text');
    expect(api.resolveTextState({})).toBe('unknown');
  });

  it('gives any confirmed positive source precedence over checking or negative BW state', () => {
    const api = loadHelpers();
    for (const bw of [state('unknown', 'not_checked'), state('unavailable')]) {
      expect(api.resolveTextState({ sources: ['gbw', 'bz'], _textAvailabilityBySource: { gbw: bw, bz: state('available') } })).toBe('text');
    }
    expect(api.resolveTextState({ previewAvailable: true, sources: ['gbw'] })).toBe('text');
  });
});
