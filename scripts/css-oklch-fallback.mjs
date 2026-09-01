#!/usr/bin/env node
// CSS oklch() → sRGB fallback 注入器
//
// 背景：oklch() 颜色函数要求 Chrome 111 / Firefox 113 / Safari 15.4 起才支持。
// Win7 Chrome 官方最高 109，整条 declaration 解析失败被丢弃 → 按钮没背景
// 看不见、边框消失、阴影飘走，整体退化成「黑白色调」。
//
// 这个脚本扫描当前生产入口加载的 public/css/*.css，对每条带 oklch(…)
// 的 declaration 插入一条等价 sRGB hex / rgba fallback declaration 在它前面：
//
//   原：  background: oklch(66% 0.20 250 / 0.18);
//   后：  background: rgba(0, 149, 254, 0.18); background: oklch(66% 0.20 250 / 0.18);
//
// 老浏览器解析 oklch 的那条丢弃、保留前面的 hex；新浏览器两条都解析、cascade
// 后者赢、像素级一致。
//
// 色彩准确度：oklch 色域比 sRGB 大，高 chroma 值落在 sRGB 外。直接对每个
// 通道独立钳到 [0,1] 会偏色。所以这里做 gamut mapping：保持 L 和 h 不变，
// 二分搜索在 sRGB 内能取到的最大 C，再做 gamma 编码。是 CSS Color Level 4
// 推荐的策略。
//
// 幂等：若紧邻前一条 declaration 同 property、value 不含 oklch，认为已经有
// fallback 了，跳过。可以反复跑。
//
// 模式：
//   node scripts/css-oklch-fallback.mjs            写入文件
//   node scripts/css-oklch-fallback.mjs --check    只检查、有未配对 oklch 退非零

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const CHECK_MODE = process.argv.includes('--check');

// ─── OKLCH → sRGB（CSS Color Module Level 4）────────────────────────────

function oklchToLinearSrgb(L, C, h) {
  const Lf = L / 100;
  const hRad = (h * Math.PI) / 180;
  const a = C * Math.cos(hRad);
  const b = C * Math.sin(hRad);
  const l_ = Lf + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = Lf - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = Lf - 0.0894841775 * a - 1.2914855480 * b;
  const lLMS = l_ * l_ * l_;
  const mLMS = m_ * m_ * m_;
  const sLMS = s_ * s_ * s_;
  const r =  4.0767416621 * lLMS - 3.3077115913 * mLMS + 0.2309699292 * sLMS;
  const g = -1.2684380046 * lLMS + 2.6097574011 * mLMS - 0.3413193965 * sLMS;
  const bl = -0.0041960863 * lLMS - 0.7034186147 * mLMS + 1.7076147010 * sLMS;
  return [r, g, bl];
}

function linearToSrgb(x) {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  if (ax <= 0.0031308) return sign * 12.92 * ax;
  return sign * (1.055 * Math.pow(ax, 1 / 2.4) - 0.055);
}

function isInGamut([r, g, b]) {
  const TOL = 1e-4;
  return r >= -TOL && r <= 1 + TOL && g >= -TOL && g <= 1 + TOL && b >= -TOL && b <= 1 + TOL;
}

function findInGamutChroma(L, C, h) {
  if (isInGamut(oklchToLinearSrgb(L, C, h))) return C;
  let lo = 0, hi = C;
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (isInGamut(oklchToLinearSrgb(L, mid, h))) lo = mid; else hi = mid;
  }
  return lo;
}

function oklchToFallback(L, C, h, alpha) {
  const mappedC = findInGamutChroma(L, C, h);
  let [r, g, b] = oklchToLinearSrgb(L, mappedC, h);
  r = linearToSrgb(r);
  g = linearToSrgb(g);
  b = linearToSrgb(b);
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const R = Math.round(clamp01(r) * 255);
  const G = Math.round(clamp01(g) * 255);
  const B = Math.round(clamp01(b) * 255);
  if (alpha == null || alpha >= 0.999) {
    return `#${[R, G, B].map(v => v.toString(16).padStart(2, '0')).join('')}`;
  }
  const a3 = Math.round(alpha * 1000) / 1000;
  return `rgba(${R}, ${G}, ${B}, ${a3})`;
}

function parseOklchArgs(args) {
  const trimmed = args.trim();
  let mainPart = trimmed;
  let alphaPart = null;
  const slashIdx = trimmed.indexOf('/');
  if (slashIdx >= 0) {
    mainPart = trimmed.slice(0, slashIdx).trim();
    alphaPart = trimmed.slice(slashIdx + 1).trim();
  }
  const parts = mainPart.split(/\s+/).filter(Boolean);
  if (parts.length < 3) return null;
  const L = parseFloat(parts[0].replace('%', ''));
  const C = parseFloat(parts[1]);
  const h = parseFloat(parts[2]);
  const alpha = alphaPart != null ? parseFloat(alphaPart) : null;
  if (!isFinite(L) || !isFinite(C) || !isFinite(h)) return null;
  if (alphaPart != null && !isFinite(alpha)) return null;
  return { L, C, h, alpha };
}

function replaceOklchInValue(value) {
  let out = '';
  let i = 0;
  while (i < value.length) {
    const idx = value.indexOf('oklch(', i);
    if (idx === -1) { out += value.slice(i); break; }
    out += value.slice(i, idx);
    let depth = 1;
    let j = idx + 6;
    while (j < value.length && depth > 0) {
      const ch = value[j];
      if (ch === '(') depth++;
      else if (ch === ')') depth--;
      if (depth === 0) break;
      j++;
    }
    if (depth !== 0) { out += value.slice(idx); break; }
    const args = value.slice(idx + 6, j);
    const parsed = parseOklchArgs(args);
    if (!parsed) {
      out += value.slice(idx, j + 1);
    } else {
      out += oklchToFallback(parsed.L, parsed.C, parsed.h, parsed.alpha);
    }
    i = j + 1;
  }
  return out;
}

// ─── CSS 处理 ───────────────────────────────────────────────────────────

function getPropName(declContent) {
  let s = declContent;
  while (true) {
    const trimmed = s.replace(/^\s+/, '');
    if (trimmed.startsWith('/*')) {
      const end = trimmed.indexOf('*/');
      if (end === -1) { s = trimmed; break; }
      s = trimmed.slice(end + 2);
      continue;
    }
    s = trimmed;
    break;
  }
  const colon = s.indexOf(':');
  if (colon === -1) return null;
  return s.slice(0, colon).trim();
}

function processSource(source) {
  let out = '';
  let i = 0;
  const n = source.length;
  while (i < n) {
    if (source[i] === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2);
      const endIdx = end === -1 ? n : end + 2;
      out += source.slice(i, endIdx);
      i = endIdx;
      continue;
    }
    if (source[i] === '"' || source[i] === "'") {
      const q = source[i];
      let j = i + 1;
      while (j < n && source[j] !== q) { if (source[j] === '\\') j++; j++; }
      out += source.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (source[i] === '{') {
      out += '{';
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (source[j] === '/' && source[j + 1] === '*') {
          const e = source.indexOf('*/', j + 2);
          j = e === -1 ? n : e + 2;
          continue;
        }
        if (source[j] === '"' || source[j] === "'") {
          const q = source[j];
          j++;
          while (j < n && source[j] !== q) { if (source[j] === '\\') j++; j++; }
          j++;
          continue;
        }
        if (source[j] === '{') depth++;
        else if (source[j] === '}') { depth--; if (depth === 0) break; }
        j++;
      }
      const body = source.slice(i + 1, j);
      out += processRuleBody(body);
      out += '}';
      i = j + 1;
      continue;
    }
    out += source[i];
    i++;
  }
  return out;
}

function processRuleBody(body) {
  const segments = [];
  let buf = '';
  let i = 0;
  const n = body.length;

  while (i < n) {
    const ch = body[i];
    if (ch === '/' && body[i + 1] === '*') {
      const e = body.indexOf('*/', i + 2);
      const endIdx = e === -1 ? n : e + 2;
      buf += body.slice(i, endIdx);
      i = endIdx;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && body[j] !== ch) { if (body[j] === '\\') j++; j++; }
      buf += body.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (ch === '{') {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (body[j] === '/' && body[j + 1] === '*') {
          const e = body.indexOf('*/', j + 2);
          j = e === -1 ? n : e + 2;
          continue;
        }
        if (body[j] === '"' || body[j] === "'") {
          const q = body[j];
          j++;
          while (j < n && body[j] !== q) { if (body[j] === '\\') j++; j++; }
          j++;
          continue;
        }
        if (body[j] === '{') depth++;
        else if (body[j] === '}') { depth--; if (depth === 0) break; }
        j++;
      }
      const selector = buf;
      buf = '';
      const nested = body.slice(i + 1, j);
      segments.push({ type: 'rule', selector, body: processRuleBody(nested) });
      i = j + 1;
      continue;
    }
    if (ch === '(') {
      let depth = 1;
      let j = i + 1;
      while (j < n && depth > 0) {
        if (body[j] === '(') depth++;
        else if (body[j] === ')') { depth--; if (depth === 0) break; }
        j++;
      }
      buf += body.slice(i, Math.min(j + 1, n));
      i = j + 1;
      continue;
    }
    if (ch === ';') {
      segments.push({ type: 'decl', content: buf });
      buf = '';
      i++;
      continue;
    }
    buf += ch;
    i++;
  }
  if (buf.trim()) {
    segments.push({ type: 'decl', content: buf, noSemi: true });
  } else if (buf) {
    segments.push({ type: 'trailing', content: buf });
  }

  const outSegs = [];
  for (const seg of segments) {
    if (seg.type !== 'decl') { outSegs.push(seg); continue; }

    const propName = getPropName(seg.content);
    if (!propName) { outSegs.push(seg); continue; }

    const idxOfProp = seg.content.indexOf(propName);
    const leadingChunk = seg.content.slice(0, idxOfProp);
    const bodyChunk = seg.content.slice(idxOfProp);
    const colon = bodyChunk.indexOf(':');
    if (colon === -1) { outSegs.push(seg); continue; }
    const propPart = bodyChunk.slice(0, colon);
    const valPart = bodyChunk.slice(colon + 1);

    // 关键：只看 value 里有没有 oklch，不要被 leadingChunk 里注释提到的
    // "oklch()" 误判（首条 decl 的 leadingChunk 常常吸附了整段顶部注释）。
    if (!valPart.includes('oklch(')) { outSegs.push(seg); continue; }

    // 幂等：往回找最近的 decl，若同 propName 且 value 不含 oklch → 已 fallback。
    let alreadyHasFallback = false;
    for (let k = outSegs.length - 1; k >= 0; k--) {
      const prev = outSegs[k];
      if (prev.type !== 'decl') continue;
      const prevName = getPropName(prev.content);
      if (prevName !== propName) break;
      const prevIdx = prev.content.indexOf(prevName);
      const prevVal = prev.content.slice(prevIdx + prevName.length + 1);
      if (!prevVal.includes('oklch(')) { alreadyHasFallback = true; }
      break;
    }
    if (alreadyHasFallback) { outSegs.push(seg); continue; }

    const fallbackVal = replaceOklchInValue(valPart);
    outSegs.push({ type: 'decl', content: leadingChunk + propPart + ':' + fallbackVal });
    outSegs.push({ type: 'decl', content: ' ' + propPart + ':' + valPart });
  }

  let result = '';
  for (const seg of outSegs) {
    if (seg.type === 'rule') {
      result += seg.selector + '{' + seg.body + '}';
    } else if (seg.type === 'trailing') {
      result += seg.content;
    } else if (seg.noSemi) {
      result += seg.content;
    } else {
      result += seg.content + ';';
    }
  }
  return result;
}

// ─── 文件 IO ────────────────────────────────────────────────────────────

// legacy-theme.css 是 Win7/Chrome ≤109 兜底主题，必须保持纯 hex 调色板、零
// oklch；若未来误写 oklch，应由专门检查直接报错，不能在这里自动掩盖。
const SKIP_FILES = new Set([
  path.join(ROOT, 'public', 'css', 'legacy-theme.css'),
]);

function findCssFiles() {
  const files = [];
  const publicCssDir = path.join(ROOT, 'public', 'css');
  if (fs.existsSync(publicCssDir)) walk(publicCssDir, files);
  return files.filter((f) => !SKIP_FILES.has(f));
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && full.endsWith('.css')) out.push(full);
  }
}

function relPath(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

function main() {
  const files = findCssFiles();
  let changed = 0;
  let totalOklch = 0;
  const diffs = [];

  for (const f of files) {
    const src = fs.readFileSync(f, 'utf8');
    const oklchCount = (src.match(/oklch\(/g) || []).length;
    totalOklch += oklchCount;
    const transformed = processSource(src);
    if (transformed !== src) {
      changed++;
      const linesDelta = transformed.split('\n').length - src.split('\n').length;
      diffs.push({ file: relPath(f), oklch: oklchCount, addedLines: linesDelta });
      if (!CHECK_MODE) fs.writeFileSync(f, transformed, 'utf8');
    }
  }

  if (CHECK_MODE) {
    if (changed > 0) {
      console.error(`✗ ${changed} file(s) have un-fallbacked oklch() declarations:`);
      for (const d of diffs) {
        console.error(`  ${d.file}: ${d.oklch} oklch() — needs ~${d.addedLines} fallback line(s)`);
      }
      console.error('\nRun: npm run oklch:fix');
      process.exit(1);
    }
    console.log(`✓ All ${totalOklch} oklch() declarations across ${files.length} files have fallback.`);
    return;
  }

  console.log(`Scanned ${files.length} CSS file(s), ${totalOklch} oklch() declaration(s).`);
  if (changed === 0) {
    console.log('✓ Nothing to do — all oklch already have fallback.');
    return;
  }
  console.log(`Modified ${changed} file(s):`);
  for (const d of diffs) {
    console.log(`  ${d.file}: +${d.addedLines} fallback line(s) for ${d.oklch} oklch()`);
  }
}

main();
