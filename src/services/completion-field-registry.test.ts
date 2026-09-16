import { describe, expect, it } from 'vitest';

import { CompletionFieldRegistry } from './completion-field-registry';

const registry = new CompletionFieldRegistry();

describe('CompletionFieldRegistry', () => {
  it('exposes stable versioned groups and presets', () => {
    expect(registry.registryVersion).toBe(1);
    expect(registry.listGroups().map(group => group.groupId)).toContain('relation');
    expect(registry.listPresets().map(preset => preset.presetId)).toEqual(['common', 'lifecycle', 'classification', 'files', 'audit']);
  });

  it('rejects unknown, duplicate and disabled fields', () => {
    expect(() => registry.validate(['unknown'])).toThrow(/未知字段/);
    expect(() => registry.validate(['match.state', 'match.state'])).toThrow(/不得重复/);
    expect(() => registry.validate(['relation.replacedByNumbers'])).toThrow(/不可用/);
  });

  it('keeps BZ replacement direction explicit', () => {
    const replaces = registry.listFields().find(field => field.fieldId === 'relation.replacesNumbers');
    const replacedBy = registry.listFields().find(field => field.fieldId === 'relation.replacedByNumbers');
    expect(replaces).toMatchObject({ label: '代替标准号', source: 'BZ replacedStd', enabled: true });
    expect(replacedBy).toMatchObject({ label: '被替代标准号', source: 'BZ detail-dm.insteadStd', enabled: true });
  });
});
