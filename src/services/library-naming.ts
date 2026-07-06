// 库文件名模板引擎（Phase 2 of 预览功能）
//
// 把 admin 配置的 library_filename_pattern 渲染成实际文件名。
//
// 支持的占位符：
//   {stdCode}  必填，由 PUT /settings 的 z.refine 校验保证
//   {source}   源标签（BW/BZ/BY），不是 canonical（gbw/bz/by）
//   {year}     4 位年份；缺失时整段连同前后空格 / 分隔符一起删（避免出现 "GB - .pdf"）
//   {title}    标准标题；缺失时同 {year} 处理
//
// 设计要点：
// - 不带 `.pdf` 扩展名（永远是 PDF，调用方加）
// - 非法字符 \ : * ? " < > | 全部剔除（Windows 文件名约束最严，全平台兼容）
//   注意：空格、连字符、中文标点都是合法字符，必须保留 —— 不然 "GB 3324-2024"
//   会被削成 "GB33242024" 反向语义损失
// - `/` 单独替换成 `_` 而非删除，保留 GB/T、GB_T 这种结构信息
// - 占位符内部空白折叠 + trim
// - 总长度限 200 字符（NTFS 255 - 留 buffer 给 ".pdf" 与去重后缀）
// - 缺失字段的占位符的"周围"分隔符也要清理：例如 pattern
//   `{stdCode} - {year} - {source}` 在 year 缺失时变成 `GB 3324 - BW`，
//   而不是 `GB 3324 -  - BW`。
//
// 安全：渲染产物在写入前由调用方再过一遍 path.basename，杜绝任何路径分隔符。

import type { SourceName } from '../domain/standard';

interface Context {
  stdCode: string;
  source: SourceName;
  year?: string;
  title?: string;
}

const SOURCE_LABELS: Record<SourceName, string> = {
  gbw: 'BW',
  bz: 'BZ',
  by: 'BY',
  labr: 'LB',
};

const MAX_BASENAME_LEN = 200;
const ILLEGAL_CHARS = /[\\:*?"<>|]/g;

function sanitizeSegment(s: string): string {
  return s
    .replace(/\//g, '_')
    .replace(ILLEGAL_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 渲染模板。pattern 不带扩展名，调用方拼 .pdf。
 *
 * 行为：
 * - {stdCode} 必填且不为空，否则抛 Error
 * - 其它占位符为空时，会把"占位符 + 与相邻字符之间的分隔符（空格/连字符/下划线）"一起删
 * - 模板里出现的未知占位符（如 {foo}）按字面量保留，方便用户后期写自定义元数据
 */
export function renderLibraryFilename(pattern: string, ctx: Context): string {
  const stdCode = sanitizeSegment(ctx.stdCode || '');
  if (!stdCode) throw new Error('renderLibraryFilename: stdCode 不能为空');

  const values: Record<string, string> = {
    stdCode,
    source: SOURCE_LABELS[ctx.source] || ctx.source.toUpperCase(),
    year: sanitizeSegment(ctx.year || ''),
    title: sanitizeSegment(ctx.title || ''),
  };

  // 处理空占位符及其相邻分隔符。例如：
  //   pattern  = "{a} - {b} - {c}"   b 为空 → "{a} - {c}"
  //   pattern  = "{a}_{b}_{c}"       b 为空 → "{a}_{c}"
  //
  // 实现：对每个空字段，匹配 (前导分隔符)?{key}(后随分隔符)? 一并删除。
  // 分隔符集合：空格、`-`、`_`、`·`、`—`
  //
  // 两侧 sep 都非空时，优先保留"含强分隔字符（- _ · —）"的那一侧 —— 否则
  // V1 文件按默认 V2 pattern `{stdCode} {title} - {source}` 渲染时，title 空
  // 会被吃成 `{stdCode} {source}`（丢了关键的 ` - `），反而 willChange=true 并
  // 把规范 V1 名字劣化掉。
  let result = pattern;
  const SEP = String.raw`[\s\-_·—]*`;
  const STRONG_SEP_RE = /[\-_·—]/;
  for (const [key, val] of Object.entries(values)) {
    const tokenRe = new RegExp(`${SEP}\\{${key}\\}${SEP}`, 'g');
    if (!val) {
      result = result.replace(tokenRe, (match, offset, str) => {
        const atStart = offset === 0;
        const atEnd = offset + match.length === str.length;
        if (atStart || atEnd) return '';
        const left = match.match(new RegExp(`^${SEP}`))?.[0] || '';
        const right = match.match(new RegExp(`${SEP}$`))?.[0] || '';
        const leftStrong = STRONG_SEP_RE.test(left);
        const rightStrong = STRONG_SEP_RE.test(right);
        if (leftStrong && !rightStrong) return left;
        if (rightStrong && !leftStrong) return right;
        // 两侧都强 / 都弱 / 都空 → 沿用左优先（保持原有行为，避免改动其它 pattern 输出）
        return left || right || ' ';
      });
    } else {
      result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), val);
    }
  }

  // 收尾：去重空白、剔除非法字符（防 pattern 字面量里写了 `:`）
  let final = result.replace(ILLEGAL_CHARS, '').replace(/\s+/g, ' ').trim();
  // 防止 pattern 写成 "{stdCode}." 留下尾点（Windows 末尾点会被吞）
  final = final.replace(/[.\s]+$/, '');

  if (final.length === 0) {
    // 极端情况：所有字段都空 + pattern 全是占位符 → fallback 到 stdCode + source
    final = `${stdCode} - ${values.source}`;
  }

  if (final.length > MAX_BASENAME_LEN) {
    final = final.slice(0, MAX_BASENAME_LEN).trim();
  }

  return final;
}

/**
 * 渲染并加扩展名。默认 `.pdf`（BZ/GBW/BY 永远是 PDF），labr 可传 docx/xlsx/pptx 等。
 *
 * ext 入参可带不带前导 `.`，统一去掉非法字符 + 小写化避免 Windows 大小写敏感问题。
 */
export function renderLibraryFilenameWithExt(pattern: string, ctx: Context, ext = 'pdf'): string {
  const cleanExt = ext.replace(/^\.+/, '').replace(ILLEGAL_CHARS, '').trim().toLowerCase() || 'pdf';
  return `${renderLibraryFilename(pattern, ctx)}.${cleanExt}`;
}

// #73 「格式化名称」用：把一个已索引文件按当前 admin pattern 重渲染。
//
// 行为：
// - parse 失败的物理文件名（用户手塞但符合 V1/V2 规范但模板引擎不认）→ error 字段返回
//   注：scanLibrary 跳过 parse 失败的文件 → 它们根本不会进 standard_files 表，理论上拿不到 row
//   防御性保留 error 路径，方便端点把异常透回前端
// - V1 老格式（无 title）按 pattern `{stdCode} {title} - {source}` 渲染时模板引擎自动剥
//   `{title}` 占位符 + 相邻空格 → 结果可能与原名相同 → willChange=false
// - 扩展名 case-insensitive；模板引擎只接受小写 ext，renderLibraryFilenameWithExt 内部统一
//
// 入参 fileRow 取自 standard_files 表（abs_path + source canonical）
export interface NormalizeInput {
  /** standard_files.abs_path basename */
  currentName: string;
  /** canonical SourceName（"gbw" 不是 "BW"） */
  source: SourceName;
  /** parsed stdCode（带 /T、大小写正确，来自 parseLibraryFilename(stdCodeRaw)） */
  stdCode: string;
  /** parsed year，可能为空 */
  year?: string;
  /** parsed title，V1 文件这里为空字符串 */
  title?: string;
}

export interface NormalizeResult {
  currentName: string;
  normalizedName: string;
  willChange: boolean;
  error?: string;
}

export function computeNormalizedName(input: NormalizeInput, pattern: string): NormalizeResult {
  const { currentName, source, stdCode, year, title } = input;
  try {
    if (!stdCode) {
      return { currentName, normalizedName: currentName, willChange: false, error: 'stdCode 缺失（文件名不符合规范，无法解析）' };
    }
    // 提取原扩展名（labr 可能有 docx/xlsx/pptx）
    const lastDot = currentName.lastIndexOf('.');
    const ext = lastDot > 0 ? currentName.slice(lastDot + 1) : 'pdf';

    const normalizedName = renderLibraryFilenameWithExt(pattern, {
      stdCode,
      source,
      year: year || undefined,
      title: title || undefined,
    }, ext);

    return {
      currentName,
      normalizedName,
      willChange: normalizedName !== currentName,
    };
  } catch (e: any) {
    return {
      currentName,
      normalizedName: currentName,
      willChange: false,
      error: e?.message || '格式化失败',
    };
  }
}
