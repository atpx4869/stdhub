import { describe, expect, it } from 'vitest';

import { createStandardId, parseStandardId } from './id';

describe('standard id helpers', () => {
  it('creates and parses a bz standard id', () => {
    const id = createStandardId('bz', '443847');

    expect(id).toBe('bz:443847');
    expect(parseStandardId(id)).toEqual({ source: 'bz', sourceId: '443847' });
  });

  it('creates and parses a gbw standard id', () => {
    const id = createStandardId('gbw', '25940C3CEF158A9AE06397BE0A0A525A');

    expect(id).toBe('gbw:25940C3CEF158A9AE06397BE0A0A525A');
    expect(parseStandardId(id)).toEqual({ source: 'gbw', sourceId: '25940C3CEF158A9AE06397BE0A0A525A' });
  });

  it('rejects unsupported ids', () => {
    expect(() => parseStandardId('foo:123')).toThrowError('Unsupported standard id: foo:123');
  });
});
