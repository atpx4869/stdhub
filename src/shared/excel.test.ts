import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import {
  addRowsWorksheet,
  normalizeUploadedFileName,
  recoverUtf8MojibakeFilename,
  safeExcelValue,
  workbookToBuffer,
  worksheetToRows,
} from './excel';

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

  it('recovers only demonstrable UTF-8 multipart mojibake', () => {
    const expected = '标准查新_2026.xlsx';
    const mojibake = Buffer.from(expected, 'utf8').toString('latin1');
    const doubleMojibake = Buffer.from(mojibake, 'utf8').toString('latin1');
    expect(recoverUtf8MojibakeFilename(mojibake)).toBe(expected);
    expect(recoverUtf8MojibakeFilename(doubleMojibake)).toBe(expected);
    expect(recoverUtf8MojibakeFilename(expected)).toBe(expected);
    expect(recoverUtf8MojibakeFilename('report_2026.xlsx')).toBe('report_2026.xlsx');
    expect(recoverUtf8MojibakeFilename('📘标准.xlsx')).toBe('📘标准.xlsx');
  });

  it('normalizes uploaded names to a safe basename', () => {
    const mojibake = Buffer.from('标准查新_2026.xlsx', 'utf8').toString('latin1');
    expect(normalizeUploadedFileName(`../unsafe/${mojibake}`)).toBe('标准查新_2026.xlsx');
    expect(normalizeUploadedFileName('..\\folder\\report.xlsx')).toBe('report.xlsx');
  });

  it('neutralizes formula-like, control-character and overlong strings', () => {
    expect(safeExcelValue('=1+1')).toBe("'=1+1");
    expect(safeExcelValue('+SUM(A1:A2)')).toBe("'+SUM(A1:A2)");
    expect(safeExcelValue('GB/T\u0001 3324')).toBe('GB/T 3324');
    expect(String(safeExcelValue('测'.repeat(40_000)))).toHaveLength(32_767);
  });
});
