import type { SourceName } from '../domain/standard';
import { BadRequestError } from './errors';

export const VALID_SOURCES: ReadonlySet<string> = new Set<SourceName>(['bz', 'gbw', 'by', 'labr']);

export interface ParsedStandardId {
  source: SourceName;
  sourceId: string;
}

export function createStandardId(source: SourceName, sourceId: string | number): string {
  const sid = String(sourceId ?? '');
  if (!sid || sid.includes(':')) {
    throw new BadRequestError(`Invalid sourceId: "${sid}"`);
  }
  return `${source}:${sid}`;
}

export function parseStandardId(id: string): ParsedStandardId {
  const colonIndex = id.indexOf(':');
  if (colonIndex === -1) {
    throw new BadRequestError(`Unsupported standard id: ${id}`);
  }
  const source = id.slice(0, colonIndex);
  const sourceId = id.slice(colonIndex + 1);

  if (!VALID_SOURCES.has(source) || !sourceId) {
    throw new BadRequestError(`Unsupported standard id: ${id}`);
  }

  return { source: source as SourceName, sourceId };
}
