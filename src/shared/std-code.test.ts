import { describe, expect, it } from 'vitest';
import {
  deriveStandardKind,
  deriveStandardNature,
  extractStdHead,
  mapTemplateStatus,
} from './std-code';

describe('extractStdHead', () => {
  it('提取 GB/T 前缀字母', () => {
    expect(extractStdHead('GB/T 3324-2017')).toBe('GB');
  });
  it('提取行业前缀字母（不带 /T）', () => {
    expect(extractStdHead('YB/T 4264-2020')).toBe('YB');
    expect(extractStdHead('SN/T 5346-2021')).toBe('SN');
  });
  it('提取团体标准 T/ 前缀', () => {
    expect(extractStdHead('T/CECS 123-2020')).toBe('T');
  });
  it('提取地方标准 DB 前缀', () => {
    expect(extractStdHead('DB31/T 1001-2020')).toBe('DB');
  });
  it('空/非法输入返回空串', () => {
    expect(extractStdHead('')).toBe('');
    expect(extractStdHead('abc')).toBe('');
  });
});

describe('deriveStandardKind', () => {
  it('国家标准', () => {
    expect(deriveStandardKind('GB/T 3324-2017')).toBe('国家标准');
    expect(deriveStandardKind('GB 20950-2020')).toBe('国家标准');
    expect(deriveStandardKind('GB/Z 123-2018')).toBe('国家标准');
  });
  it('行业标准', () => {
    expect(deriveStandardKind('YB/T 4264-2020')).toBe('行业标准');
    expect(deriveStandardKind('JC/T 2663-2022')).toBe('行业标准');
    expect(deriveStandardKind('SY/T 6662.4-2024')).toBe('行业标准');
    expect(deriveStandardKind('HG/T 3951-2007')).toBe('行业标准');
  });
  it('团体标准 / 地方标准', () => {
    expect(deriveStandardKind('T/CECS 123-2020')).toBe('团体标准');
    expect(deriveStandardKind('DB11/T 100-2020')).toBe('地方标准');
  });
  it('无法推导（国际/企业/院内等）返回空串', () => {
    expect(deriveStandardKind('ISO 4287-1997')).toBe('');
    expect(deriveStandardKind('Q/ABC 1-2020')).toBe('');
    expect(deriveStandardKind('')).toBe('');
  });
});

describe('deriveStandardNature', () => {
  it('含 /T 为推荐标准', () => {
    expect(deriveStandardNature('GB/T 3324-2017')).toBe('推荐标准');
    expect(deriveStandardNature('YB/T 4264-2020')).toBe('推荐标准');
  });
  it('GB 无 /T 为强制标准', () => {
    expect(deriveStandardNature('GB 20950-2020')).toBe('强制标准');
  });
  it('行业无 /T 为强制标准', () => {
    expect(deriveStandardNature('YB 4264-2020')).toBe('强制标准');
  });
  it('其他（团体/国际/空）返回空串', () => {
    expect(deriveStandardNature('T/CECS 123-2020')).toBe('');
    expect(deriveStandardNature('ISO 4287-1997')).toBe('');
    expect(deriveStandardNature('')).toBe('');
  });
});

describe('mapTemplateStatus', () => {
  it('BZ 状态映射到模板下拉词', () => {
    expect(mapTemplateStatus('现行有效')).toBe('现行有效');
    expect(mapTemplateStatus('部分有效')).toBe('部分作废');
    expect(mapTemplateStatus('即将实施')).toBe('即将生效');
    expect(mapTemplateStatus('即将废止')).toBe('即将作废');
    expect(mapTemplateStatus('已经废止')).toBe('作废');
  });
  it('无法映射（调整转号/其它/空）返回空串', () => {
    expect(mapTemplateStatus('调整转号')).toBe('');
    expect(mapTemplateStatus('其它')).toBe('');
    expect(mapTemplateStatus(undefined)).toBe('');
    expect(mapTemplateStatus(null)).toBe('');
  });
});
