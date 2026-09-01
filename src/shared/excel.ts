import ExcelJS from 'exceljs';

export type ExcelCellValue = string | number | boolean | Date | null | undefined;

/**
 * 把 ExcelJS worksheet 转为 0-based 二维数组。
 * 公式单元格优先读取计算结果；富文本拼接为纯文本，便于标准号补全流程统一处理。
 */
export function worksheetToRows(worksheet: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = [];
  const maxColumns = Math.max(worksheet.columnCount, 1);
  for (let rowNumber = 1; rowNumber <= worksheet.rowCount; rowNumber++) {
    const row = worksheet.getRow(rowNumber);
    const values: string[] = [];
    for (let columnNumber = 1; columnNumber <= maxColumns; columnNumber++) {
      values.push(cellText(row.getCell(columnNumber).value));
    }
    while (values.length && values[values.length - 1] === '') values.pop();
    rows.push(values);
  }
  return rows;
}

export function cellText(value: ExcelJS.CellValue): string {
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    if ('result' in value && value.result != null) return cellText(value.result as ExcelJS.CellValue);
    if ('richText' in value && Array.isArray(value.richText)) return value.richText.map(part => part.text).join('');
    if ('text' in value && typeof value.text === 'string') return value.text;
    if ('hyperlink' in value && typeof value.hyperlink === 'string') return value.text || value.hyperlink;
  }
  return String(value);
}

/** 防止 Excel 把不可信文本解释成公式。 */
export function safeExcelValue(value: ExcelCellValue): ExcelCellValue {
  if (typeof value !== 'string') return value;
  return /^[=+\-@]/.test(value) ? `'${value}` : value;
}

export function addRowsWorksheet(
  workbook: ExcelJS.Workbook,
  name: string,
  rows: ExcelCellValue[][],
  widths?: number[],
): ExcelJS.Worksheet {
  const worksheet = workbook.addWorksheet(name);
  for (const row of rows) worksheet.addRow(row.map(safeExcelValue));
  if (widths) worksheet.columns = widths.map(width => ({ width }));
  return worksheet;
}

export async function workbookToBuffer(workbook: ExcelJS.Workbook): Promise<Buffer> {
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data as unknown as Uint8Array);
}
