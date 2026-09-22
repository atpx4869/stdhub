import path from 'node:path';
import type Database from 'better-sqlite3';
import { pooledFetch } from '../shared/http';

import type {
  CompletionCollectedRow,
  CompletionLocalFile,
  CompletionOptionsV2,
  CompletionPlan,
  CompletionResolution,
} from '../domain/completion';
import { extractBaseCode, parseStandardReference, deriveStandardKind, deriveStandardNature } from '../shared/std-code';
import type { SourceRegistry } from './source-registry';
import { CompletionResolver } from './completion-resolver';

const MATCH_LABELS: Record<string, string> = {
  success: '成功', not_found: '未查到', multiple_candidates: '多个候选', invalid_input: '输入无效', upstream_error: '上游异常', system_error: '系统异常',
};
const LOCAL_LABELS: Record<string, string> = { present: '已有文件', absent: '本地无文件', error: '文件异常' };

interface LocalRow {
  std_code_norm: string;
  year: string;
  abs_path: string;
  file_name: string;
  size: number;
  mime: string;
  indexed_at: string;
}

export class CompletionCollector {
  private readonly resolver: CompletionResolver;

  constructor(
    private readonly db: Database.Database,
    private readonly registry: SourceRegistry,
    private readonly libraryRoot: string,
  ) {
    this.resolver = new CompletionResolver(registry);
  }

  async collect(
    inputs: Array<{ rowNumber: number; value: string; valid?: boolean; inputError?: string }>,
    plan: CompletionPlan,
    options: CompletionOptionsV2,
    signal: AbortSignal,
    onProgress: (phase: string, current: number, total: number, message: string) => void,
  ): Promise<Map<number, CompletionCollectedRow>> {
    onProgress('matching', 0, inputs.length, '正在按来源优先级查询标准');
    const validInputs = inputs.filter(input => input.valid !== false);
    const resolutions = await this.resolver.resolve(validInputs.map(item => item.value), options.sources, signal);
    const details = new Map<string, { enName?: string; ics?: string; ccs?: string }>();
    if (plan.requiresDetail) {
      onProgress('fetching_details', 0, inputs.length, '正在按需读取标准详情');
      const winners = [...new Map([...resolutions.values()].filter(item => item.winner).map(item => [item.winner!.standardId, item.winner!])).values()];
      for (let index = 0; index < winners.length; index++) {
        if (signal.aborted) throw signal.reason ?? new Error('任务已取消');
        const winner = winners[index];
        try {
          const adapter = this.registry.get(winner.source);
          const detail = await adapter.getStandardDetail(winner.standardId);
          const more = detail.moreInfo ?? {};
          details.set(winner.standardId, {
            enName: typeof more.enName === 'string' ? more.enName : winner.enName,
            ics: typeof more.icsClass === 'string' ? more.icsClass : winner.ics,
            ccs: typeof more.cnClass === 'string' ? more.cnClass : winner.ccs,
          });
          // Backfill lifecycle dates from detail when search results are missing them
          if (!winner.publishDate && detail.publishDate) winner.publishDate = detail.publishDate;
          if (!winner.implementDate && detail.implementDate) winner.implementDate = detail.implementDate;
          if (!winner.abolishedDate && detail.abolishedDate) winner.abolishedDate = detail.abolishedDate;
          if (winner.source === 'bz' && winner.sourceRecordId) {
            const response = await pooledFetch(`https://bz.gxzl.org.cn/api/gxist-standard/standardstd/detail-dm?id=${encodeURIComponent(winner.sourceRecordId)}&language=null`, { timeoutMs: 10_000, retries: 1 });
            if (response.ok) {
              const payload = await response.json() as { data?: { insteadStd?: string } };
              winner.replacedByNumbers = String(payload.data?.insteadStd || '').split(/[;,，；]/).map(value => value.trim()).filter(Boolean);
            }
          }
        } catch (error) {
          const resolution = [...resolutions.values()].find(item => item.winner?.standardId === winner.standardId);
          resolution?.qualityWarnings.push('详情读取失败');
          resolution!.errorSummary ||= error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300);
        }
        onProgress('fetching_details', index + 1, winners.length, `已读取 ${index + 1}/${winners.length} 项详情`);
      }
    }

    onProgress('linking_local_files', 0, inputs.length, '正在关联本地标准文件');
    const localFiles = plan.requiresLocalFile ? this.bulkLocalLookup([...resolutions.values()]) : new Map<string, CompletionLocalFile>();
    const output = new Map<number, CompletionCollectedRow>();
    for (let index = 0; index < inputs.length; index++) {
      const input = inputs[index];
      const resolution = input.valid === false
        ? this.invalidInput(input.value, input.inputError)
        : (resolutions.get(input.value) ?? this.systemFailure(input.value));
      const winner = resolution.winner;
      const localFile = winner ? (localFiles.get(winner.standardNumber) ?? { state: 'absent' as const }) : { state: 'absent' as const };
      const detail = winner ? details.get(winner.standardId) : undefined;
      const detectionState = localFile.state === 'present' ? 'not_run' : 'not_applicable';
      const textLayerState = localFile.state === 'present' ? 'not_checked' : 'not_applicable';
      const collected: CompletionCollectedRow = { input: input.value, resolution, localFile, detectionState, textLayerState, values: {} };
      for (const field of plan.fields) collected.values[field.fieldId] = this.valueFor(field.fieldId, collected, detail, input.rowNumber);
      output.set(input.rowNumber, collected);
      onProgress('linking_local_files', index + 1, inputs.length, `已整理 ${index + 1}/${inputs.length} 行`);
    }
    return output;
  }

  private bulkLocalLookup(resolutions: CompletionResolution[]): Map<string, CompletionLocalFile> {
    const winners = resolutions.map(item => item.winner).filter(Boolean);
    const norms = [...new Set(winners.map(item => extractBaseCode(item!.standardNumber)).filter(Boolean))];
    const result = new Map<string, CompletionLocalFile>();
    if (!norms.length) return result;
    const placeholders = norms.map(() => '?').join(',');
    const rows = this.db.prepare(`
      SELECT std_code_norm, year, abs_path, file_name, size, mime, indexed_at
      FROM standard_files WHERE std_code_norm IN (${placeholders}) ORDER BY indexed_at DESC
    `).all(...norms) as LocalRow[];
    for (const winner of winners) {
      const parsed = parseStandardReference(winner!.standardNumber);
      const norm = extractBaseCode(winner!.standardNumber);
      const row = rows.find(item => item.std_code_norm === norm && (!parsed?.year || item.year === parsed.year));
      if (!row) continue;
      const relative = path.relative(this.libraryRoot, row.abs_path);
      result.set(winner!.standardNumber, {
        state: 'present',
        fileName: row.file_name,
        fileFormat: path.extname(row.file_name).replace(/^\./, '').toUpperCase() || row.mime,
        fileSizeBytes: row.size,
        indexedAt: row.indexed_at,
        relativePath: relative.startsWith('..') || path.isAbsolute(relative) ? '' : relative.replace(/\\/g, '/'),
      });
    }
    return result;
  }

  private valueFor(
    fieldId: string,
    row: CompletionCollectedRow,
    detail: { enName?: string; ics?: string; ccs?: string } | undefined,
    originalRow: number,
  ): string | number {
    const winner = row.resolution.winner;
    const parsed = parseStandardReference(winner?.standardNumber ?? row.input);
    const values: Record<string, string | number> = {
      'standard.number.canonical': winner?.standardNumber ?? '',
      'standard.title.zh': winner?.title ?? '',
      'standard.title.en': detail?.enName ?? winner?.enName ?? '',
      'lifecycle.status': winner?.status ?? '',
      'lifecycle.publishDate': formatDate(winner?.publishDate),
      'lifecycle.implementDate': formatDate(winner?.implementDate),
      'lifecycle.abolishedDate': formatDate(winner?.abolishedDate),
      'classification.level': winner ? deriveStandardKind(winner.standardNumber) : '',
      'classification.type': winner?.standardType ?? '',
      'classification.nature': winner ? deriveStandardNature(winner.standardNumber) : '',
      'classification.ics': detail?.ics ?? winner?.ics ?? '',
      'classification.ccs': detail?.ccs ?? winner?.ccs ?? '',
      'relation.replacesNumbers': joinValues(winner?.replacesNumbers ?? []),
      'relation.replacedByNumbers': joinValues(winner?.replacedByNumbers ?? []),
      'local.fileState': LOCAL_LABELS[row.localFile.state],
      'local.fileName': row.localFile.fileName ?? '',
      'local.fileFormat': row.localFile.fileFormat ?? '',
      'local.fileSizeBytes': row.localFile.fileSizeBytes ?? '',
      'library.ingestedAt': row.localFile.indexedAt ?? '',
      'content.detectionState': row.detectionState === 'not_run' ? '未执行' : row.detectionState === 'not_applicable' ? '不适用' : row.detectionState === 'failed' ? '失败' : '成功',
      'content.hasTextLayer': row.textLayerState === 'not_checked' ? '未检测' : row.textLayerState === 'not_applicable' ? '不适用' : row.textLayerState === 'yes' ? '是' : '否',
      'trace.source': winner?.source ?? '',
      'match.method': row.resolution.matchMethod,
      'match.state': MATCH_LABELS[row.resolution.matchState] ?? row.resolution.matchState,
      'quality.warnings': joinValues(row.resolution.qualityWarnings),
      'error.summary': row.resolution.errorSummary ?? '',
      'standard.prefix': parsed?.prefix ?? '',
      'standard.sequence': parsed?.number.split('.')[0] ?? '',
      'standard.part': parsed?.number.includes('.') ? parsed.number.split('.').slice(1).join('.') : '',
      'standard.year': parsed?.year ?? '',
      'match.candidateNumbers': joinValues(row.resolution.candidates.map(item => item.standardNumber)),
      'trace.sourceRecordId': winner?.sourceRecordId ?? '',
      'trace.detailUrl': winner?.detailUrl ?? '',
      'audit.originalRow': originalRow,
      'local.relativePath': row.localFile.relativePath ?? '',
    };
    return values[fieldId] ?? '';
  }

  private invalidInput(input: string, inputError?: string): CompletionResolution {
    return {
      input,
      matchState: 'invalid_input',
      matchMethod: 'none',
      candidates: [],
      sourceErrors: [],
      qualityWarnings: [],
      errorSummary: inputError === 'formula_without_cached_result' ? '输入公式没有可用的缓存结果' : '输入格式无法识别',
    };
  }

  private systemFailure(input: string): CompletionResolution {
    return { input, matchState: 'system_error', matchMethod: 'none', candidates: [], sourceErrors: [], qualityWarnings: [], errorSummary: '内部结果缺失' };
  }
}

function formatDate(value: string | null | undefined): string {
  const raw = String(value ?? '').trim();
  if (!raw) return '';
  // Chinese: YYYY年MM月DD日 / YYYY年MM月
  const cn = raw.match(/(\d{4})年\s*(\d{1,2})月(?:\s*(\d{1,2})日)?/);
  if (cn) {
    const base = `${cn[1]}-${cn[2].padStart(2, '0')}`;
    return cn[3] ? `${base}-${cn[3].padStart(2, '0')}` : base;
  }
  // Compact YYYYMMDD (8 digits, optionally followed by time)
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  // Full date YYYY-M-D / YYYY/M/D / YYYY.M.D (with optional time)
  const full = raw.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (full) return `${full[1]}-${full[2].padStart(2, '0')}-${full[3].padStart(2, '0')}`;
  // Year-month YYYY-MM / YYYY/MM / YYYY.MM
  const ym = raw.match(/(\d{4})[-/.](\d{1,2})/);
  if (ym) return `${ym[1]}-${ym[2].padStart(2, '0')}`;
  // Year only
  const y = raw.match(/^(\d{4})/);
  return y ? y[1] : '';
}

function joinValues(values: string[]): string {
  return [...new Set(values.map(value => value.trim()).filter(Boolean))].join('；');
}
