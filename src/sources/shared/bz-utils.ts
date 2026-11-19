// Shared types and mapping for bz.gxzl.org.cn API adapters
import type { StandardDetail, StandardSummary } from '../../domain/standard';
import { createStandardId } from '../../shared/id';

const BZ_STATUS_MAP: Record<string, string> = {
  '1': '现行有效', '2': '部分有效', '3': '即将实施',
  '4': '即将废止', '5': '已经废止', '6': '调整转号', '9': '其它',
};

export const BZ_NEW_BASE = 'https://bz.gxzl.org.cn';

export interface BzSearchRow {
  id: number | string;
  stdNo: string;
  cnName: string;
  enName?: string;
  pubDate: string;
  actDate: string;
  stdStatus: string;
  stdNature?: string;
  replacedStd?: string;
  insteadStd?: string;
  pdf?: string;
  isPdf?: string | boolean;
  icsClass?: string;
  cnClass?: string;
  endData?: string;
  endDate?: string;
  drafterName?: string;
  drafter2nd?: string;
  [key: string]: unknown;
}

export function bzRowHasPdf(row: BzSearchRow): boolean {
  return row.isPdf === true || row.isPdf === '1' || row.isPdf === 'true' || Boolean(row.pdf);
}

export function bzHasYear(stdNo: string): boolean {
  return /[-—]\s*\d{4}\b/.test(stdNo);
}

/** National-standard-like queries can use source=3. Name searches stay unfiltered. */
export function bzShouldFilterNational(query: string): boolean {
  const q = query.trim();
  return /^GB(\s*\/\s*[TZ])?\b/i.test(q) || /^\d{3,5}\s*[-—]\s*\d{4}\b/.test(q);
}

export function squashStdNo(value: string): string {
  return value.replace(/[\s／∕\/\-—–．.]/g, '').toUpperCase();
}

export function rankBzSearchRows(rows: BzSearchRow[], query: string): BzSearchRow[] {
  const needle = squashStdNo(query);
  if (!needle) return rows;
  return [...rows].sort((left, right) => {
    const leftExact = squashStdNo(left.stdNo ?? '') === needle ? 0 : 1;
    const rightExact = squashStdNo(right.stdNo ?? '') === needle ? 0 : 1;
    return leftExact - rightExact;
  });
}

export function mapBzSearchRow(row: BzSearchRow, source: 'bz'): StandardSummary {
  return {
    id: createStandardId(source, String(row.id)),
    source,
    sourceId: String(row.id),
    standardNumber: row.stdNo ?? '',
    title: row.cnName ?? '',
    standardType: row.stdNature ?? undefined,
    status: BZ_STATUS_MAP[row.stdStatus] ?? row.stdStatus,
    publishDate: row.pubDate ?? null,
    implementDate: row.actDate ?? null,
    abolishedDate: row.endData ?? row.endDate ?? null,
    previewAvailable: bzRowHasPdf(row),
    detailUrl: `${BZ_NEW_BASE}/api/gxist-standard/standardstd/detail?id=${row.id}`,
    meta: row as Record<string, unknown>,
  };
}

export function mapBzDetail(row: BzSearchRow, source: 'bz'): StandardDetail {
  return {
    id: createStandardId(source, String(row.id)),
    source,
    sourceId: String(row.id),
    standardNumber: row.stdNo ?? '',
    title: row.cnName ?? '',
    standardType: row.stdNature ?? undefined,
    status: BZ_STATUS_MAP[row.stdStatus] ?? row.stdStatus,
    publishDate: row.pubDate ?? null,
    implementDate: row.actDate ?? null,
    abolishedDate: row.endData ?? row.endDate ?? null,
    previewAvailable: bzRowHasPdf(row),
    detailUrl: `${BZ_NEW_BASE}/api/gxist-standard/standardstd/detail?id=${row.id}`,
    contentText: row.enName ?? '',
    moreInfo: {
      enName: row.enName,
      cnClass: row.cnClass,
      icsClass: row.icsClass,
      replacedStd: row.replacedStd,
      insteadStd: row.insteadStd,
      hasPdf: bzRowHasPdf(row),
      isPdf: row.isPdf,
      pdfPath: row.pdf,
      drafterName: row.drafterName,
      drafter2nd: row.drafter2nd,
    },
    meta: row as Record<string, unknown>,
  };
}
