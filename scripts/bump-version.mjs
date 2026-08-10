#!/usr/bin/env node
/**
 * 自动递增 patch 版本号（1.4.3 → 1.4.4），同步更新 package.json 与 package-lock.json。
 * 由 .github/workflows/auto-release.yml 在每次 push main 时调用。
 *
 * 用法: node scripts/bump-version.mjs
 * 输出: 新版本号（如 1.4.4）到 stdout，供 workflow 捕获
 */

import { readFileSync, writeFileSync } from 'node:fs';

const pkgPath = './package.json';
const lockPath = './package-lock.json';

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const [major, minor, patch] = String(pkg.version)
  .split('.')
  .map((n) => Number.parseInt(n, 10));
if (!Number.isFinite(major) || !Number.isFinite(minor) || !Number.isFinite(patch)) {
  console.error(`错误: 无法解析版本号 ${pkg.version}`);
  process.exit(1);
}

const next = `${major}.${minor}.${patch + 1}`;
pkg.version = next;
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');

// package-lock.json 顶层也带 version，必须同步，否则 npm ci 报版本不一致
try {
  const lock = JSON.parse(readFileSync(lockPath, 'utf-8'));
  if (lock.version) {
    lock.version = next;
    writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
  }
} catch (e) {
  console.warn(`警告: 无法同步 package-lock.json: ${e instanceof Error ? e.message : String(e)}`);
}

console.log(next);
