import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import ExcelJS from 'exceljs';

import type {
  CompletionCollectedRow,
  CompletionFieldDefinition,
  CompletionOptionsV2,
  CompletionPlan,
} from '../domain/completion';
import { BadRequestError } from '../shared/errors';
import { cellText, safeExcelValue, workbookToBuffer } from '../shared/excel';
import { extractFullCode, parseStandardReference } from '../shared/std-code';

export const MAX_XLSX_COLUMN = 16_384;

export interface CompletionLimits {
  maxSheets: number;
  maxUsedCells: number;
  maxRows: number;
  maxUnique: number;
  maxFields: number;
  maxPreviewRows: number;
}

export interface CompletionInputRow {
  rowNumber: number;
  value: string;
  valid: boolean;
  inputError?: 'formula_without_cached_result';
}

export interface CompletionExcelAnalysis {
  fileFingerprint: string;
  optionsFingerprint: string;
  previewToken: string;
  fileName: string;
  sheets: Array<{ name: string; rowCount: number; columnCount: number; state: string }>;
  sheetName: string;
  headerRow: number;
  inputColumn: string;
  outputColumn: string;
  outputEndColumn: string;
  outputRange: string;
  recommendedOutputColumn: string;
  counts: { valid: number; unique: number; duplicates: number; invalid: number; total: number };
  inputs: CompletionInputRow[];
  previewRows: CompletionInputRow[];
  conflicts: string[];
  warnings: string[];
  estimates: { queries: number; details: number; localLinks: number; detections: number };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function columnToNumber(value: string): number {
  const raw = value.trim().toUpperCase();
  if (/^\d+$/.test(raw)) {
    const number = Number(raw);
    if (!Number.isInteger(number) || number < 1 || number > MAX_XLSX_COLUMN) throw new BadRequestError(`列号超出范围: ${value}`);
    return number;
  }
  if (!/^[A-Z]{1,3}$/.test(raw)) throw new BadRequestError(`无效列名: ${value}`);
  let number = 0;
  for (const character of raw) number = number * 26 + character.charCodeAt(0) - 64;
  if (number > MAX_XLSX_COLUMN) throw new BadRequestError(`列号超出范围: ${value}`);
  return number;
}

export function numberToColumn(number: number): string {
  if (!Number.isInteger(number) || number < 1 || number > MAX_XLSX_COLUMN) throw new BadRequestError(`列号超出范围: ${number}`);
  let current = number;
  let result = '';
  while (current > 0) {
    const remainder = (current - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    current = Math.floor((current - 1) / 26);
  }
  return result;
}

function cellOccupied(cell: ExcelJS.Cell): boolean {
  if (cell.value !== null && cell.value !== undefined && cellText(cell.value).trim() !== '') return true;
  if (cell.formula) return true;
  if (cell.hyperlink) return true;
  if (cell.note) return true;
  if (cell.dataValidation && Object.keys(cell.dataValidation).length > 0) return true;
  return false;
}

function worksheetMerges(worksheet: ExcelJS.Worksheet): string[] {
  const model = worksheet.model as unknown as { merges?: string[] };
  return model.merges ?? [];
}

function usedColumnCount(worksheet: ExcelJS.Worksheet): number {
  let last = 0;
  worksheet.eachRow({ includeEmpty: true }, row => {
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      if (cellOccupied(cell)) last = Math.max(last, columnNumber);
    });
  });
  for (const range of worksheetMerges(worksheet)) {
    const end = String(range).split(':').at(-1)?.match(/^([A-Z]+)/)?.[1];
    if (end) last = Math.max(last, columnToNumber(end));
  }
  return last;
}

function rangeIntersects(range: string, startRow: number, endRow: number, startColumn: number, endColumn: number): boolean {
  const [from, to = from] = range.split(':');
  const parse = (address: string) => {
    const match = address.match(/^([A-Z]+)(\d+)$/i);
    return match ? { column: columnToNumber(match[1]), row: Number(match[2]) } : null;
  };
  const first = parse(from);
  const last = parse(to);
  if (!first || !last) return false;
  return first.row <= endRow && last.row >= startRow && first.column <= endColumn && last.column >= startColumn;
}

export class CompletionExcelService {
  constructor(private readonly limits: CompletionLimits) {}

  async analyze(buffer: Buffer, fileName: string, options: CompletionOptionsV2, plan: CompletionPlan): Promise<CompletionExcelAnalysis> {
    if (path.extname(fileName).toLowerCase() !== '.xlsx') throw new BadRequestError('仅支持 .xlsx 格式');
    if (options.fieldIds.length > this.limits.maxFields) throw new BadRequestError(`最多选择 ${this.limits.maxFields} 个字段`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    if (workbook.worksheets.length === 0) throw new BadRequestError('工作簿没有工作表');
    if (workbook.worksheets.length > this.limits.maxSheets) throw new BadRequestError(`工作表数量不能超过 ${this.limits.maxSheets}`);

    const usedCells = workbook.worksheets.reduce((sum, worksheet) => sum + worksheet.rowCount * Math.max(worksheet.columnCount, 1), 0);
    if (usedCells > this.limits.maxUsedCells) throw new BadRequestError(`工作簿已用单元格超过 ${this.limits.maxUsedCells}`);
    const worksheet = workbook.getWorksheet(options.sheetName);
    if (!worksheet) throw new BadRequestError(`工作表不存在: ${options.sheetName}`);
    if (options.headerRow < 1 || options.headerRow > Math.max(worksheet.rowCount, 1)) throw new BadRequestError('表头行超出工作表范围');

    const inputColumnNumber = columnToNumber(options.inputColumn);
    const outputColumnNumber = columnToNumber(options.outputColumn);
    const outputEndColumnNumber = outputColumnNumber + plan.fields.length - 1;
    if (outputEndColumnNumber > MAX_XLSX_COLUMN) throw new BadRequestError('输出列超过 Excel 最大列 XFD');
    const firstDataRow = options.headerRow + 1;
    const lastRow = Math.max(worksheet.rowCount, firstDataRow);

    const merges = worksheetMerges(worksheet);
    if (merges.some(range => rangeIntersects(range, firstDataRow, lastRow, inputColumnNumber, inputColumnNumber))) {
      throw new BadRequestError('输入列位于合并区域，无法安全读取');
    }
    const conflicts: string[] = [];
    if (merges.some(range => rangeIntersects(range, options.headerRow, lastRow, outputColumnNumber, outputEndColumnNumber))) conflicts.push('目标范围与合并区域冲突');
    for (let row = options.headerRow; row <= lastRow; row++) {
      for (let column = outputColumnNumber; column <= outputEndColumnNumber; column++) {
        if (cellOccupied(worksheet.getCell(row, column))) {
          conflicts.push(worksheet.getCell(row, column).address);
          if (conflicts.length >= 50) break;
        }
      }
      if (conflicts.length >= 50) break;
    }

    const inputs: CompletionInputRow[] = [];
    for (let row = firstDataRow; row <= worksheet.rowCount; row++) {
      const raw = worksheet.getCell(row, inputColumnNumber).value;
      const formulaWithoutResult = Boolean(raw && typeof raw === 'object' && 'formula' in raw && (raw.result === undefined || raw.result === null));
      const value = formulaWithoutResult ? String(raw && typeof raw === 'object' && 'formula' in raw ? raw.formula : '').trim() : cellText(raw).trim();
      if (!value && !formulaWithoutResult) continue;
      inputs.push({ rowNumber: row, value, valid: !formulaWithoutResult && Boolean(parseStandardReference(value)), ...(formulaWithoutResult ? { inputError: 'formula_without_cached_result' as const } : {}) });
    }
    if (inputs.length > this.limits.maxRows) throw new BadRequestError(`非空待处理行不能超过 ${this.limits.maxRows}`);
    const valid = inputs.filter(item => item.valid);
    const uniqueKeys = new Set(valid.map(item => {
      const parsed = parseStandardReference(item.value)!;
      return `${parsed.canonicalKey}|${extractFullCode(item.value)}`;
    }));
    if (uniqueKeys.size > this.limits.maxUnique) throw new BadRequestError(`唯一标准号不能超过 ${this.limits.maxUnique}`);

    const recommendedNumber = usedColumnCount(worksheet) + 1;
    const warnings: string[] = [];
    for (let column = outputColumnNumber; column <= outputEndColumnNumber; column++) {
      if (worksheet.getColumn(column).hidden) warnings.push(`输出列 ${numberToColumn(column)} 为隐藏列`);
    }
    const fileFingerprint = fingerprint(buffer);
    const optionsFingerprint = fingerprint(stableJson({ ...options, previewToken: undefined }));
    return {
      fileFingerprint,
      optionsFingerprint,
      previewToken: fingerprint(`${fileFingerprint}:${optionsFingerprint}`),
      fileName,
      sheets: workbook.worksheets.map(sheet => ({ name: sheet.name, rowCount: sheet.rowCount, columnCount: sheet.columnCount, state: sheet.state })),
      sheetName: worksheet.name,
      headerRow: options.headerRow,
      inputColumn: numberToColumn(inputColumnNumber),
      outputColumn: numberToColumn(outputColumnNumber),
      outputEndColumn: numberToColumn(outputEndColumnNumber),
      outputRange: `${numberToColumn(outputColumnNumber)}:${numberToColumn(outputEndColumnNumber)}`,
      recommendedOutputColumn: numberToColumn(Math.min(recommendedNumber, MAX_XLSX_COLUMN)),
      counts: {
        valid: valid.length,
        unique: uniqueKeys.size,
        duplicates: valid.length - uniqueKeys.size,
        invalid: inputs.length - valid.length,
        total: inputs.length,
      },
      inputs,
      previewRows: inputs.slice(0, Math.min(options.previewLimit, this.limits.maxPreviewRows)),
      conflicts: [...new Set(conflicts)],
      warnings: [...new Set(warnings)],
      estimates: {
        queries: uniqueKeys.size,
        details: plan.requiresDetail ? uniqueKeys.size : 0,
        localLinks: plan.requiresLocalFile ? uniqueKeys.size : 0,
        detections: options.detectionPolicy === 'text_layer' ? uniqueKeys.size : 0,
      },
    };
  }

  async writeNewFile(
    buffer: Buffer,
    options: CompletionOptionsV2,
    plan: CompletionPlan,
    analysis: CompletionExcelAnalysis,
    rows: Map<number, CompletionCollectedRow>,
    outputDir: string,
  ): Promise<{ fileName: string; filePath: string }> {
    const recheck = await this.analyze(buffer, analysis.fileName, options, plan);
    if (recheck.previewToken !== options.previewToken) throw new BadRequestError('预览令牌已失效，请重新预览');
    if (recheck.conflicts.length) throw new BadRequestError('输出范围存在冲突', { conflicts: recheck.conflicts });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const worksheet = workbook.getWorksheet(options.sheetName);
    if (!worksheet) throw new BadRequestError(`工作表不存在: ${options.sheetName}`);
    const outputColumn = columnToNumber(options.outputColumn);
    plan.fields.forEach((definition, offset) => {
      const cell = worksheet.getCell(options.headerRow, outputColumn + offset);
      cell.value = safeExcelValue(definition.label) as string;
      worksheet.getColumn(outputColumn + offset).width = Math.max(16, Math.min(42, definition.label.length * 2 + 4));
    });
    for (const [rowNumber, collected] of rows) {
      plan.fields.forEach((definition, offset) => {
        const raw = collected.values[definition.fieldId] ?? '';
        worksheet.getCell(rowNumber, outputColumn + offset).value = safeExcelValue(raw) as ExcelJS.CellValue;
      });
    }
    if (options.includeExplanationSheet) this.addExplanationSheet(workbook, plan.fields);

    await mkdir(outputDir, { recursive: true });
    const base = path.basename(analysis.fileName, '.xlsx').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100) || '标准补全';
    const fileName = `${base}_StdHub补全_${Date.now()}.xlsx`;
    const finalPath = path.join(outputDir, fileName);
    const tempPath = path.join(outputDir, `.${fileName}.${randomUUID()}.tmp`);
    try {
      await writeFile(tempPath, await workbookToBuffer(workbook));
      const verify = new ExcelJS.Workbook();
      await verify.xlsx.readFile(tempPath);
      const verifiedSheet = verify.getWorksheet(options.sheetName);
      if (!verifiedSheet) throw new Error('写入后校验失败：目标工作表丢失');
      for (let offset = 0; offset < plan.fields.length; offset++) {
        if (cellText(verifiedSheet.getCell(options.headerRow, outputColumn + offset).value) !== plan.fields[offset].label) {
          throw new Error('写入后校验失败：表头不一致');
        }
      }
      await rename(tempPath, finalPath);
      return { fileName, filePath: finalPath };
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  }

  private addExplanationSheet(workbook: ExcelJS.Workbook, fields: CompletionFieldDefinition[]): void {
    let name = '_StdHub补全说明';
    let counter = 2;
    while (workbook.getWorksheet(name)) name = `_StdHub补全说明${counter++}`;
    const sheet = workbook.addWorksheet(name);
    sheet.addRow(['字段', '说明', '来源', '覆盖度', '成本']);
    for (const field of fields) sheet.addRow([field.label, field.description, field.source, field.coverage, field.cost]);
    sheet.columns = [{ width: 24 }, { width: 48 }, { width: 24 }, { width: 12 }, { width: 10 }];
  }
}
