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
  pdf?: string;
  isPdf?: string;
  icsClass?: string;
  cnClass?: string;
  endData?: string;
  drafterName?: string;
  drafter2nd?: string;
  [key: string]: unknown;
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
    abolishedDate: row.endData ?? null,
    previewAvailable: row.isPdf === '1' || Boolean(row.pdf),
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
    abolishedDate: row.endData ?? null,
    previewAvailable: row.isPdf === '1' || Boolean(row.pdf),
    detailUrl: `${BZ_NEW_BASE}/api/gxist-standard/standardstd/detail?id=${row.id}`,
    contentText: row.enName ?? '',
    moreInfo: {
      enName: row.enName,
      cnClass: row.cnClass,
      icsClass: row.icsClass,
      replacedStd: row.replacedStd,
      hasPdf: row.isPdf === '1',
      isPdf: row.isPdf,
      pdfPath: row.pdf,
      drafterName: row.drafterName,
      drafter2nd: row.drafter2nd,
    },
    meta: row as Record<string, unknown>,
  };
}
