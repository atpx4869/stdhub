import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import type { CompletionOptionsV2 } from '../domain/completion';
import { CompletionExcelService } from './completion-excel';
import { CompletionFieldRegistry } from './completion-field-registry';

const service = new CompletionExcelService({ maxSheets: 20, maxUsedCells: 300_000, maxRows: 2_000, maxUnique: 1_000, maxFields: 30, maxPreviewRows: 10 });
const registry = new CompletionFieldRegistry();
const plan = registry.compilePlan(['standard.title.zh', 'match.state']);

async function workbookBuffer(configure: (workbook: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  configure(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer() as unknown as Uint8Array);
}

function options(overrides: Partial<CompletionOptionsV2> = {}): CompletionOptionsV2 {
  return {
    apiVersion: 2, registryVersion: 1, sheetName: 'Data', headerRow: 2, inputColumn: 'C', outputColumn: 'F',
    fieldIds: ['standard.title.zh', 'match.state'], sources: ['bz'], detectionPolicy: 'none', previewLimit: 8,
    ...overrides,
  };
}

describe('CompletionExcelService', () => {
  it('reads an explicit non-first worksheet, header row and input column', async () => {
    const buffer = await workbookBuffer(workbook => {
      workbook.addWorksheet('Cover').getCell('A1').value = '封面';
      const sheet = workbook.addWorksheet('Data');
      sheet.getCell('C2').value = '标准号';
      sheet.getCell('C3').value = 'GB31658.17-2026';
    });
    const analysis = await service.analyze(buffer, 'input.xlsx', options(), plan);
    expect(analysis.sheetName).toBe('Data');
    expect(analysis.inputs).toEqual([{ rowNumber: 3, value: 'GB31658.17-2026', valid: true }]);
    expect(analysis.outputRange).toBe('F:G');
  });

  it('uses cached formula results and marks formulas without results invalid', async () => {
    const buffer = await workbookBuffer(workbook => {
      const sheet = workbook.addWorksheet('Data');
      sheet.getCell('C2').value = '标准号';
      sheet.getCell('C3').value = { formula: '"GB 1-2020"', result: 'GB 1-2020' };
      sheet.getCell('C4').value = { formula: 'A1' };
    });
    const analysis = await service.analyze(buffer, 'formulas.xlsx', options(), plan);
    expect(analysis.inputs[0]).toMatchObject({ rowNumber: 3, value: 'GB 1-2020', valid: true });
    expect(analysis.inputs[1]).toMatchObject({ rowNumber: 4, value: 'A1', valid: false, inputError: 'formula_without_cached_result' });
    expect(analysis.inputs[1].value).not.toBe('[object Object]');
  });

  it('enforces the total non-empty row limit even for invalid input', async () => {
    const limited = new CompletionExcelService({ maxSheets: 20, maxUsedCells: 300_000, maxRows: 2, maxUnique: 1_000, maxFields: 30, maxPreviewRows: 10 });
    const buffer = await workbookBuffer(workbook => {
      const sheet = workbook.addWorksheet('Data');
      sheet.getCell('C2').value = '标准号';
      sheet.getCell('C3').value = 'invalid-a';
      sheet.getCell('C4').value = 'invalid-b';
      sheet.getCell('C5').value = 'invalid-c';
    });
    await expect(limited.analyze(buffer, 'invalid.xlsx', options(), plan)).rejects.toThrow(/非空待处理行不能超过 2/);
  });

  it('blocks formulas, merged targets and XFD overflow', async () => {
    const formula = await workbookBuffer(workbook => {
      const sheet = workbook.addWorksheet('Data');
      sheet.getCell('C2').value = '标准号';
      sheet.getCell('C3').value = 'GB 1-2020';
      sheet.getCell('F3').value = { formula: '1+1', result: 2 };
    });
    expect((await service.analyze(formula, 'formula.xlsx', options(), plan)).conflicts).toContain('F3');

    const merged = await workbookBuffer(workbook => {
      const sheet = workbook.addWorksheet('Data');
      sheet.getCell('C2').value = '标准号';
      sheet.getCell('C3').value = 'GB 1-2020';
      sheet.mergeCells('F2:G2');
    });
    expect((await service.analyze(merged, 'merge.xlsx', options(), plan)).conflicts).toContain('目标范围与合并区域冲突');

    await expect(service.analyze(merged, 'overflow.xlsx', options({ outputColumn: 'XFD' }), plan)).rejects.toThrow(/XFD/);
  });

  it('blocks an input column inside a merge', async () => {
    const buffer = await workbookBuffer(workbook => {
      const sheet = workbook.addWorksheet('Data');
      sheet.getCell('C2').value = '标准号';
      sheet.mergeCells('C3:D3');
      sheet.getCell('C3').value = 'GB 1-2020';
    });
    await expect(service.analyze(buffer, 'merged-input.xlsx', options(), plan)).rejects.toThrow(/输入列位于合并区域/);
  });
});
