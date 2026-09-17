import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(path.resolve(__dirname, '../../public/js/selected-field-order.js'), 'utf8');
const sandbox: Record<string, any> = { globalThis: {}, module: { exports: {} } };
vm.runInNewContext(source, sandbox);
const { moveSelectedField } = sandbox.module.exports as { moveSelectedField: (selected: readonly string[], from: number, to: number) => string[] };

describe('moveSelectedField', () => {
  it('moves a field forward and backward without mutating input', () => {
    const selected = ['a', 'b', 'c', 'd'];
    expect(moveSelectedField(selected, 1, 3)).toEqual(['a', 'c', 'd', 'b']);
    expect(moveSelectedField(selected, 3, 1)).toEqual(['a', 'd', 'b', 'c']);
    expect(selected).toEqual(['a', 'b', 'c', 'd']);
  });

  it('returns an equal copy for invalid or unchanged moves', () => {
    const selected = ['a', 'b'];
    expect(moveSelectedField(selected, 0, 0)).toEqual(selected);
    expect(moveSelectedField(selected, -1, 1)).toEqual(selected);
    expect(moveSelectedField(selected, 0, 2)).toEqual(selected);
    expect(moveSelectedField(selected, 0.5, 1)).toEqual(selected);
  });
});
