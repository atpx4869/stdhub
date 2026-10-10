import { promises as fs } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export async function assertPdfMagic(filePath: string): Promise<void> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buffer = Buffer.alloc(5);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead !== 5 || buffer.toString('ascii') !== '%PDF-') throw new Error('输出文件不是有效 PDF');
  } finally {
    await handle.close();
  }
}

export async function countPdfPages(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync('pdfinfo', [filePath], { timeout: 30_000, maxBuffer: 1024 * 1024 });
  const pages = stdout.match(/^Pages:\s*(\d+)\s*$/mi)?.[1];
  return pages ? Number.parseInt(pages, 10) : 0;
}

export async function verifyDoc88Pdf(filePath: string, expectedPages: number): Promise<{ size: number; pages: number }> {
  await assertPdfMagic(filePath);
  const stat = await fs.stat(filePath);
  if (stat.size < 10_000) throw new Error(`生成的 PDF 过小（${stat.size}B），疑似损坏`);
  const pages = await countPdfPages(filePath);
  if (pages <= 0) throw new Error('无法确认生成 PDF 的页数');
  if (expectedPages > 0 && pages !== expectedPages) {
    throw new Error(`生成内容不完整：预期 ${expectedPages} 页，实际 ${pages} 页`);
  }
  return { size: stat.size, pages };
}
