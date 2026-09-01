import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { addRowsWorksheet, safeExcelValue, workbookToBuffer, worksheetToRows } from './excel';

describe('excel helpers', () => {
  it('round-trips worksheet rows through ExcelJS', async () => {
    const workbook = new ExcelJS.Workbook();
    addRowsWorksheet(workbook, 'Sheet1', [
      ['标准号', '名称'],
      ['GB/T 3324-2024', '木家具'],
    ]);

    const data = await workbookToBuffer(workbook);
    const loaded = new ExcelJS.Workbook();
    await loaded.xlsx.load(data as unknown as ArrayBuffer);

    expect(worksheetToRows(loaded.worksheets[0])).toEqual([
      ['标准号', '名称'],
      ['GB/T 3324-2024', '木家具'],
    ]);
  });

  it('neutralizes formula-like untrusted strings', () => {
    expect(safeExcelValue('=1+1')).toBe("'=1+1");
    expect(safeExcelValue('+SUM(A1:A2)')).toBe("'+SUM(A1:A2)");
    expect(safeExcelValue('GB/T 3324')).toBe('GB/T 3324');
  });
});
