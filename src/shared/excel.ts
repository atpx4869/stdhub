import { TextDecoder } from 'node:util';
import ExcelJS from 'exceljs';

export type ExcelCellValue = string | number | boolean | Date | null | undefined;

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function countMatches(value: string, pattern: RegExp): number {
  return value.match(pattern)?.length ?? 0;
}

/**
 * Recover a UTF-8 filename that a multipart parser exposed as Latin-1.
 *
 * Conversion is deliberately conservative: the original must contain a valid
 * multi-byte UTF-8 byte sequence, round-trip exactly through Latin-1, and the
 * decoded text must remove C1/replacement characters or reveal meaningful
 * non-Latin text. Correct Chinese, ASCII, emoji and ordinary Latin names are
 * returned unchanged.
 */
export function recoverUtf8MojibakeFilename(value: string): string {
  let current = value;
  // Some multipart test clients and reverse proxies can apply the Latin-1
  // interpretation twice. Recover at most two proven round-trips so a normal
  // filename can never enter an unbounded or speculative decoding loop.
  for (let round = 0; round < 2; round++) {
    if (!current || [...current].some(character => character.codePointAt(0)! > 0xff)) break;
    const bytes = Buffer.from(current, 'latin1');
    if (!bytes.some(byte => byte >= 0xc2)) break;

    let decoded: string;
    try {
      decoded = UTF8_DECODER.decode(bytes);
    } catch {
      break;
    }
    if (Buffer.from(decoded, 'utf8').toString('latin1') !== current) break;

    const currentBad = countMatches(current, /[\u0080-\u009f\ufffd]/g);
    const decodedBad = countMatches(decoded, /[\u0080-\u009f\ufffd]/g);
    const revealsNonLatin = !/[\u3400-\u9fff\ud800-\udfff]/u.test(current)
      && /[\u3400-\u9fff\ud800-\udfff]/u.test(decoded);
    if (decodedBad >= currentBad && !revealsNonLatin) break;
    current = decoded;
  }
  return current;
}

/** Keep only a platform-independent basename at the multipart trust boundary. */
export function normalizeUploadedFileName(value: string): string {
  const recovered = recoverUtf8MojibakeFilename(value).replace(/[\u0000-\u001f\u007f]/g, '');
  const basename = recovered.split(/[\\/]/).at(-1)?.trim() ?? '';
  return basename && basename !== '.' && basename !== '..' ? basename.slice(0, 240) : 'upload.xlsx';
}

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
  const cleaned = value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .slice(0, 32_767);
  return /^[=+\-@]/.test(cleaned) ? `'${cleaned}` : cleaned;
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
