/**
 * 标准号归一化：把脏数据（CNAS / CMA 抓取变体、用户手输、Excel 复制全角）统一成
 * 半角 ASCII 形态，让两条独立来源的同号同年记录得到完全相同的字符串，可以走索引
 * 等值匹配，不需要 LIKE + LIMIT 兜底。
 *
 * 拆出来的原因：db.ts 在 migrate() 里要回填 std_code_norm 列，但 db.ts 不能依赖
 * qualification-service.ts（后者依赖 db.ts，会循环 import）。这里是底层纯函数，
 * 不依赖任何状态。
 */

/**
 * 把脏标准号 prepass 成"半角 + 折叠空白 + 大写"的形态：CNAS / CMA / 用户手输的所有变体
 * 在 extractBaseCode / extractFullCode 之前先统一过这一道，让后续的字符串处理只用考虑
 * 半角 ASCII 形态。
 *
 * 已知脏数据来源：CNAS 抓取写 'GB/T 3325 -2024'、用户复制粘贴带全角空格、Excel 里
 * 标准号被 autocorrect 成全角破折号 '－'、ISO 标准号写 'ISO 4287:1997'。
 */
function preNormalize(code: string): string {
  return code
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))  // 全角数字 ０-９ → 0-9
    .replace(/[Ａ-ｚ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))  // 全角字母 Ａ-ｚ → A-z
    .replace(/　/g, ' ')              // 全角空格 → 半角
    .replace(/[‐-―－]/g, '-') // U+2010..2015 (figure/en/em/horizontal bar) + U+FF0D (全角连字符) → '-'
    .replace(/[／]/g, '/')            // 全角斜杠 → '/'
    .replace(/[：]/g, ':')            // 全角冒号 → ':'（ISO 标准用冒号当年份分隔）
    .replace(/[？?]/g, '')            // 全角/半角问号 → 删（抓取/OCR 噪声，非合法标准号字符，如 '？QB/T？4566-2025'）
    .replace(/[:](\d{4}\b)/, '-$1')       // ISO 'ISO 4287:1997' → 'ISO 4287-1997' 让后续年份剥离逻辑统一
    .replace(/\s+/g, ' ')                  // 折叠连续空白
    .trim()
    .toUpperCase();
}

/**
 * "GB/T 23440-2009" → "GB23440-2009" — 严谨归一化（保留年份）。
 *
 * 用途：精确匹配。两条来自不同源的同号同年记录（CNAS 'GB/T 3325 -2024' /
 * CMA 'GB/T 3325-2024'）经过此函数都得到相同字符串，可以在归一化列上做索引等值
 * 查询，O(log N)，不再需要 LIKE + LIMIT 兜底。
 *
 * 与 extractBaseCode 的关系：extractFullCode 是 extractBaseCode + 年份后缀。
 */
export function extractFullCode(code: string): string {
  const pre = preNormalize(code);
  // 抓年份后缀（含可选 'A'/'B'/'R' 修订标记，如 'GB/T 3836-2010A'）。
  // 关键：年份不要求在末尾 —— 年份是标准号的天然终止符，**年份之后挂的任何内容都是引用修饰**
  // （条款 '第8.3.1.3条' / '4.2条'、附录 '附录A'、章节、备注…）应整体丢弃。这样无需为每种
  // 脏后缀写专用正则。匹配第一个 '-YYYY'，截断其后全部。不要求一定有年份（老式号如 'JB 4730' 保留）。
  const yearMatch = pre.match(/-\s*(\d{4}[A-Z]?)/);
  const yearSuffix = yearMatch ? `-${yearMatch[1]}` : '';
  const withoutYear = yearMatch ? pre.slice(0, yearMatch.index!) : pre;
  // 剥 type designator：'GB/T 3325' / 'GB/T3325'（无空格）/ 'GBZ/T 188' 都归到 prefix + digits
  // 旧实现 /\/[A-Z]+/gi 在无空格变体上会把 '/T3325' 一起删空 → 这里只删 '/T' 不动后面
  const stripped = withoutYear.replace(/\/[A-Z]+(?=\d|\s|$|-)/gi, '');
  const compact = stripped.replace(/\s+/g, '');
  // 兜底：剥完空字符串说明输入异常，返回 preNormalize 形态防止下游 base="" 触发全表匹配
  if (!compact) return pre;
  return compact + yearSuffix;
}

/**
 * "GB/T 23440-2009" → "GB23440" — 跨年模糊归一化（剥年份）。
 *
 * 用途：**仅「资质查询」页关键词搜索 `searchQualifications` 在用**,作为同号跨年版本的
 * 兜底匹配 —— UI 列表展示完整带年 `std_code` 让用户明确看到命中的是哪个年版。
 *
 * **不要**在主搜索徽章批量路径 `queryByStdCodes` 用 —— 同号不同年视作不同资质,
 * 跨年命中徽章但 UI 又不标年版差异会让用户误以为"新版也被认证"(踩过 QB/T 4463-2025
 * 实际只有 2013 版的坑)。
 *
 * Handles variants: 'GB/T 3325 -2024'（脏空格）/ 'GB/T 3325-2024 ' / 'GB/T3325-2024'
 * （无空格）/ 'ＧＢ／Ｔ ３３２５－２０２４'（全角）/ 'ISO 4287:1997'（ISO 冒号）。
 */
export function extractBaseCode(code: string): string {
  const full = extractFullCode(code);
  return full.replace(/-\d{4}[A-Z]?$/, '');
}

/**
 * "GB/T 3325 -2024" / "GB/T 3325- 2024" → "GB/T 3325-2024" — 抓取入库前的轻量清洗。
 *
 * 与 extractBaseCode / extractFullCode 的区别：这函数**不去掉前缀**（GB/T 保留）、
 * **不大写**，只把"年份连字符附近的多余空格"和"多空格"折叠掉。目的是让 DB 里存的
 * std_code 字段自己就是干净的，让 `std_code LIKE '%3325-%'` 这种 SQL 子串查询能
 * 一致命中（CNAS 抓取写的脏空格变体会让子串 LIKE 漏命中）。
 *
 * 已知触发场景：cnas-scraper 抓出来的 `stdDescAndClause` 字段在 CNAS 网站 HTML 里
 * 渲染为 'GB/T 3325 -2024'（数字和连字符之间有空格），无法可视察觉但破坏字符串匹配。
 */
export function cleanStdCode(raw: string): string {
  return raw
    .replace(/\s+/g, ' ')                    // 多空格折叠
    .replace(/\s*-\s*(\d{4}[A-Za-z]?)/, '-$1')   // '3325 -2024' / '3325- 2024' / '3325 - 2024' → '3325-2024'
    .trim();
}
