import type { AdapterSourceName, StandardSummary } from '../domain/standard';
import type { CompletionCandidate, CompletionResolution } from '../domain/completion';
import { extractFullCode, formatStandardSearchQuery, parseStandardReference } from '../shared/std-code';
import { StandardService } from './standard-service';
import type { SourceRegistry } from './source-registry';

const RESOLVE_CONCURRENCY = 6;

function shortError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/\S+/gi, '[上游地址]').slice(0, 300);
}

function toCandidate(item: StandardSummary, source: AdapterSourceName): CompletionCandidate {
  const meta = item.meta ?? {};
  const replaced = typeof meta.replacedStd === 'string'
    ? meta.replacedStd.split(/[;,，；]/).map(value => value.trim()).filter(Boolean)
    : [];
  return {
    standardId: item.id,
    standardNumber: item.standardNumber,
    title: item.title,
    source,
    status: item.status,
    publishDate: item.publishDate,
    implementDate: item.implementDate,
    abolishedDate: item.abolishedDate,
    replacesNumbers: [...new Set(replaced)],
    sourceRecordId: item.sourceId,
    detailUrl: item.detailUrl,
    standardType: item.standardType,
    enName: typeof meta.enName === 'string' ? meta.enName : undefined,
    ics: typeof meta.icsClass === 'string' ? meta.icsClass : undefined,
    ccs: typeof meta.cnClass === 'string' ? meta.cnClass : undefined,
  };
}

export class CompletionResolver {
  constructor(private readonly registry: SourceRegistry) {}

  async resolve(
    inputs: string[],
    sources: AdapterSourceName[],
    signal?: AbortSignal,
  ): Promise<Map<string, CompletionResolution>> {
    const unique = [...new Set(inputs.map(input => input.trim()))];
    const result = new Map<string, CompletionResolution>();
    await mapLimit(unique, RESOLVE_CONCURRENCY, async input => {
      result.set(input, await this.resolveOne(input, sources, signal));
    });
    return result;
  }

  private async resolveOne(input: string, sources: AdapterSourceName[], signal?: AbortSignal): Promise<CompletionResolution> {
    const parsed = parseStandardReference(input);
    if (!parsed) {
      return {
        input,
        matchState: 'invalid_input',
        matchMethod: 'none',
        candidates: [],
        sourceErrors: [],
        qualityWarnings: [],
        errorSummary: '输入格式无法识别',
      };
    }

    const query = formatStandardSearchQuery(input);
    const wanted = extractFullCode(input);
    const candidates: CompletionCandidate[] = [];
    const sourceErrors: Array<{ source: AdapterSourceName; message: string }> = [];
    for (const source of sources) {
      if (signal?.aborted) throw signal.reason ?? new Error('任务已取消');
      try {
        const service = new StandardService(this.registry.get(source));
        const items = await service.searchStandards({ query, signal });
        for (const item of items) {
          if (parsed.year && extractFullCode(item.standardNumber) !== wanted) continue;
          const itemParsed = parseStandardReference(item.standardNumber);
          if (!itemParsed || itemParsed.number !== parsed.number) continue;
          if (parsed.prefix && itemParsed.prefix !== parsed.prefix) continue;
          candidates.push(toCandidate(item, source));
        }
      } catch (error) {
        sourceErrors.push({ source, message: shortError(error) });
      }
    }

    const deduped = [...new Map(candidates.map(item => [`${extractFullCode(item.standardNumber)}|${item.source}`, item])).values()];
    if (deduped.length === 0) {
      const allFailed = sourceErrors.length === sources.length;
      return {
        input,
        matchState: allFailed ? 'upstream_error' : 'not_found',
        matchMethod: 'none',
        candidates: [],
        sourceErrors,
        qualityWarnings: sourceErrors.length ? ['部分数据源查询异常'] : [],
        errorSummary: allFailed ? sourceErrors.map(error => `${error.source}: ${error.message}`).join('；') : undefined,
      };
    }

    const versions = new Set(deduped.map(item => extractFullCode(item.standardNumber)));
    if (!parsed.year && versions.size > 1) {
      return {
        input,
        matchState: 'multiple_candidates',
        matchMethod: 'normalized_candidates',
        candidates: deduped,
        sourceErrors,
        qualityWarnings: ['输入未含年代号且存在多个版本'],
      };
    }

    const winner = sources.map(source => deduped.find(item => item.source === source)).find(Boolean) ?? deduped[0];
    const warnings: string[] = [];
    const lifecycleFields: Array<'publishDate' | 'implementDate' | 'abolishedDate'> = [
      'publishDate', 'implementDate', 'abolishedDate',
    ];
    let lifecycleFallbackUsed = false;
    for (const field of lifecycleFields) {
      if (winner[field]) continue;
      const fallback = sources
        .map(source => deduped.find(item => item.source === source && item[field]))
        .find(Boolean);
      if (fallback?.[field]) {
        winner[field] = fallback[field];
        lifecycleFallbackUsed ||= fallback.source !== winner.source;
      }
    }
    if (lifecycleFallbackUsed) warnings.push('生命周期缺失字段已由其他来源补齐');
    if (sourceErrors.length) warnings.push('部分数据源查询异常');
    if (new Set(deduped.map(item => `${item.standardNumber}|${item.title}`)).size > 1) warnings.push('多来源字段存在差异，已按来源优先级采用首项');
    return {
      input,
      matchState: 'success',
      matchMethod: parsed.year ? 'full_code_exact' : 'normalized_single_version',
      winner,
      candidates: deduped,
      sourceErrors,
      qualityWarnings: warnings,
    };
  }
}

async function mapLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const current = items[cursor++];
      await work(current);
    }
  });
  await Promise.all(workers);
}
