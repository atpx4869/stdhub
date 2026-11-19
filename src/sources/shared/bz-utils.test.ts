import { describe, expect, it } from 'vitest';
import {
  bzHasYear,
  bzRowHasPdf,
  bzShouldFilterNational,
  mapBzDetail,
  rankBzSearchRows,
  squashStdNo,
  type BzSearchRow,
} from './bz-utils';

const row = (stdNo: string, extra: Partial<BzSearchRow> = {}): BzSearchRow => ({
  id: extra.id ?? stdNo,
  stdNo,
  cnName: extra.cnName ?? stdNo,
  pubDate: '2024-01-01',
  actDate: '2024-07-01',
  stdStatus: extra.stdStatus ?? '1',
  ...extra,
});

describe('bz lookup helpers', () => {
  it('filters national-like queries but not names', () => {
    expect(bzShouldFilterNational('3325-2024')).toBe(true);
    expect(bzShouldFilterNational('GB/T 3325-2024')).toBe(true);
    expect(bzShouldFilterNational('家具中有害物质限量')).toBe(false);
  });

  it('ranks an exact standard number first without dropping others', () => {
    const ranked = rankBzSearchRows([
      row('GB/T 3325-2017'),
      row('GB/T 3325-2024'),
    ], 'GB／T3325-2024');
    expect(ranked.map(item => item.stdNo)).toEqual(['GB/T 3325-2024', 'GB/T 3325-2017']);
  });

  it('treats boolean isPdf as preview evidence and keeps Chinese status text', () => {
    const detail = mapBzDetail(row('GB/T 3324-2017', {
      isPdf: true,
      stdStatus: '已经废止',
      insteadStd: 'GB/T 3324-2024',
    }), 'bz');
    expect(bzRowHasPdf({ ...row('x'), isPdf: true })).toBe(true);
    expect(detail.previewAvailable).toBe(true);
    expect(detail.moreInfo?.hasPdf).toBe(true);
    expect(detail.status).toBe('已经废止');
    expect(detail.moreInfo?.insteadStd).toBe('GB/T 3324-2024');
  });

  it('requires a year before preview/export page probes', () => {
    expect(bzHasYear('GB/T 3325-2024')).toBe(true);
    expect(bzHasYear('GB/T 3325')).toBe(false);
    expect(squashStdNo('GB／T 3325—2024')).toBe('GBT33252024');
  });
});
