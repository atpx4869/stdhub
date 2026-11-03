import ExcelJS from 'exceljs';
import { createRequire } from 'node:module';
import { inflateRawSync } from 'node:zlib';

export const NAT_CMA_TABLE_ORG_NAME = '湖北省产品质量监督检验研究院';
export const MAX_TABLE_UPLOAD_BYTES = 10 * 1024 * 1024;
const MAX_INFLATED_BYTES = 100 * 1024 * 1024;
const MAX_ROWS = 30000;
const requireArchive = createRequire(__filename);
// ExcelJS already depends on JSZip; no runtime Python or additional package required.
interface Archive { files: Record<string, { dir: boolean }>; remove(path: string): void; generateAsync(options: {type: 'nodebuffer'; compression: 'DEFLATE'}): Promise<Buffer> }
const JSZip = requireArchive('jszip') as { loadAsync(data: Buffer): Promise<Archive> };
export interface TableWarning { row: number; message: string; sheetName?: string }
export interface ParsedTableRow {
  majorNo: string; majorCategory: string; categoryNo: string; category: string;
  parameterNo: string; parameterName: string; stdName: string; stdCode: string;
  limitDesc: string; note: string; rowNumber: number; sheetName: string;
  standards: { code: string; key: string }[];
  standardParseWarning: boolean;
}
export interface ParsedTable {
  rows: ParsedTableRow[]; warnings: TableWarning[]; duplicateCount: number;
  standardCount: number; categoryCount: number; productCount: number;
}
export function canonicalTableStandard(value: string): string {
  return value.normalize('NFKC').toUpperCase().replace(/[∕⁄／]/g, '/').replace(/[‐‑‒–—−]/g, '-')
    .replace(/：/g, ':').replace(/\s+/g, '').replace(/:(\d{4})$/, '-$1');
}
export function parseTableStandards(value: string): { standards: {code: string; key: string}[]; unsupported: boolean } {
  const text = value.normalize('NFKC').toUpperCase().replace(/[∕⁄／]/g, '/').replace(/[‐‑‒–—−]/g, '-');
  // Keep the entire identifier and its year; never fall back to a series/base number.
  const re = /(?:[A-Z]{1,10}(?:\/[A-Z]{1,10})?)\s*(?:[A-Z]{1,3}\s*)?\d+(?:[.\/-]\d+)*\s*[-:]\s*\d{4}(?!\d)/g;
  const standards: { code: string; key: string }[] = [];
  let residue = '', end = 0;
  for (const match of text.matchAll(re)) {
    residue += text.slice(end, match.index); end = match.index! + match[0].length;
    const code = match[0].trim().replace(/\s+/g, ' ');
    const key = canonicalTableStandard(code);
    if (!standards.some(s => s.key === key)) standards.push({ code, key });
  }
  residue += text.slice(end);
  return { standards, unsupported: !standards.length || residue.replace(/[\s,，、;；/()（）]+/g, '').length > 0 };
}
/** Validate central-directory sizes before allowing an archive library to inflate anything. */
export function validateTableArchive(buffer: Buffer): void {
  if (!buffer.length || buffer.length > MAX_TABLE_UPLOAD_BYTES) throw new Error('XLSX 文件大小必须为 1 字节至 10MB');
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 XLSX ZIP 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  const size = buffer.readUInt32LE(eocd + 12);
  let pos = buffer.readUInt32LE(eocd + 16), inflated = 0;
  if (buffer.readUInt16LE(eocd + 4) || buffer.readUInt16LE(eocd + 6) || count > 2000 || count === 65535 || pos + size > eocd) throw new Error('不支持此 XLSX ZIP 结构');
  const centralEnd = pos + size;
  for (let i = 0; i < count; i++) {
    if (pos + 46 > centralEnd || buffer.readUInt32LE(pos) !== 0x02014b50) throw new Error('XLSX ZIP 目录损坏');
    const packed = buffer.readUInt32LE(pos + 20), unpacked = buffer.readUInt32LE(pos + 24);
    const flags = buffer.readUInt16LE(pos + 8), method = buffer.readUInt16LE(pos + 10);
    const nameLen = buffer.readUInt16LE(pos + 28), extraLen = buffer.readUInt16LE(pos + 30), commentLen = buffer.readUInt16LE(pos + 32);
    const local = buffer.readUInt32LE(pos + 42);
    inflated += unpacked;
    if ((flags & 1) || ![0, 8].includes(method) || unpacked > 50 * 1024 * 1024 || inflated > MAX_INFLATED_BYTES || (unpacked > 1024 * 1024 && unpacked > Math.max(packed, 1) * 1000)) throw new Error('XLSX 解压大小或压缩比超限');
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('XLSX ZIP 条目损坏');
    const data = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    if (data + packed > buffer.length || buffer.readUInt16LE(local + 8) !== method) throw new Error('XLSX ZIP 条目损坏');
    const payload = buffer.subarray(data, data + packed);
    const actual = method === 8 ? inflateRawSync(payload, { maxOutputLength: Math.max(1, unpacked) }) : payload;
    if (actual.length !== unpacked) throw new Error('XLSX ZIP 解压大小不符');
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);
    if (name.startsWith('/') || name.split('/').includes('..')) throw new Error('XLSX ZIP 路径非法');
    pos += 46 + nameLen + extraLen + commentLen;
  }
  if (pos !== centralEnd) throw new Error('XLSX ZIP 目录损坏');
}
export async function parseNatCmaTable(buffer: Buffer): Promise<ParsedTable> {
  validateTableArchive(buffer);
  const archive = await JSZip.loadAsync(buffer);
  if (!archive.files['xl/workbook.xml']) throw new Error('文件不是 XLSX 工作簿');
  // The approved source contains malformed core metadata; metadata is irrelevant to abilities.
  archive.remove('docProps/core.xml');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(await archive.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }) as unknown as ArrayBuffer);
  const rows: ParsedTableRow[] = [], warnings: TableWarning[] = [];
  const seen = new Set<string>(), standards = new Set<string>(), majors = new Set<string>(), products = new Set<string>();
  let duplicateCount = 0;
  for (const sheet of workbook.worksheets) {
    if (sheet.rowCount > MAX_ROWS + 3) throw new Error('工作表行数超限');
    const heading = (row: number, col: number) => sheet.getRow(row).getCell(col).text;
    if (!/大类/.test(heading(2, 1)) || !/编号|年号/.test(heading(3, 8))) {
      warnings.push({ row: 0, sheetName: sheet.name, message: '跳过未识别表头的工作表' }); continue;
    }
    for (let n = 4; n <= sheet.rowCount; n++) {
      const source = sheet.getRow(n);
      // Deliberately read A:J only. K/L signer names and identity numbers never enter memory records.
      const v = Array.from({length: 10}, (_, i) => source.getCell(i + 1).text);
      if (v.every(s => !s.trim())) continue;
      if (v.some(s => s.length > 20000) || rows.length >= MAX_ROWS) throw new Error('能力数据大小超限');
      const parsed = parseTableStandards(v[7]);
      const row: ParsedTableRow = {majorNo:v[0],majorCategory:v[1],categoryNo:v[2],category:v[3],parameterNo:v[4],parameterName:v[5],stdName:v[6],stdCode:v[7],limitDesc:v[8],note:v[9],rowNumber:n,sheetName:sheet.name,standards:parsed.standards,standardParseWarning:parsed.unsupported};
      const signature = JSON.stringify(v);
      if (seen.has(signature)) { duplicateCount++; warnings.push({row:n,sheetName:sheet.name,message:'完全重复能力行，已保留原行'}); }
      seen.add(signature);
      if (parsed.unsupported) warnings.push({row:n,sheetName:sheet.name,message:'标准编号含不支持或无法完整识别的内容；原文已保留，请核对'});
      if (!row.majorCategory || !row.category || !row.parameterName) warnings.push({row:n,sheetName:sheet.name,message:'能力分类或参数为空，请核对'});
      for (const s of row.standards) standards.add(s.key);
      majors.add(row.majorCategory); products.add(JSON.stringify([row.majorCategory,row.categoryNo,row.category])); rows.push(row);
    }
  }
  if (!rows.length) throw new Error('未找到符合批准能力表格式的数据行（表头第2/3行，数据从第4行开始）');
  return {rows,warnings,duplicateCount,standardCount:standards.size,categoryCount:majors.size,productCount:products.size};
}
