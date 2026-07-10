#!/usr/bin/env node
/**
 * 自动创建 GitHub Release 脚本
 * 用法: node scripts/release.mjs
 *
 * 功能:
 * 1. 从 package.json 读取版本号
 * 2. 创建 git tag (如果不存在)
 * 3. 推送 tag 到远程
 * 4. 创建 GitHub Release
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

function run(cmd) {
  return execSync(cmd, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

// 读取版本号
const pkg = JSON.parse(readFileSync('./package.json', 'utf-8'));
const version = pkg.version;
if (!version) {
  console.error('错误: 无法从 package.json 读取版本号');
  process.exit(1);
}

const tag = `v${version}`;
console.log(`=== 创建 Release ${tag} ===`);

// 检查 tag 是否已存在
try {
  run(`git rev-parse ${tag}`);
  console.log(`Tag ${tag} 已存在，跳过创建`);
} catch {
  console.log(`创建 tag ${tag}...`);
  run(`git tag -a ${tag} -m "Release ${tag}"`);
}

// 推送 tag
console.log('推送 tag 到远程...');
run(`git push origin ${tag}`);

// 检查 release 是否已存在
try {
  run(`gh release view ${tag}`);
  console.log(`Release ${tag} 已存在，跳过创建`);
  process.exit(0);
} catch {
  // release 不存在，继续创建
}

// 获取上一个版本 tag
let prevTag = '';
try {
  const tags = run('git tag -l "v*" --sort=-v:refname');
  const tagList = tags.split('\n').filter(t => t !== tag);
  if (tagList.length > 0) prevTag = tagList[0];
} catch {
  // ignore
}

// 生成更新日志
console.log('生成更新日志...');
let notes = '';
if (prevTag) {
  try {
    notes = run(`git log ${prevTag}..HEAD --pretty=format:"- %s" --no-merges`);
  } catch {
    notes = run('git log --pretty=format:"- %s" --no-merges -20');
  }
} else {
  notes = run('git log --pretty=format:"- %s" --no-merges -20');
}

const releaseNotes = `## StdHub ${tag}

### 更新内容
${notes}

### 安装
- 下载对应平台的安装包
- 或使用 Docker 部署: docker compose up -d

### 文档
- GitHub 仓库: https://github.com/atpx4869/stdhub
- 更新日志: https://github.com/atpx4869/stdhub/releases`;

// 写入临时文件避免 shell 转义问题
import { writeFileSync, unlinkSync } from 'node:fs';
const tmpFile = '.release-notes.tmp.md';
writeFileSync(tmpFile, releaseNotes, 'utf-8');

try {
  console.log('创建 GitHub Release...');
  run(`gh release create ${tag} --title "StdHub ${tag}" --notes-file ${tmpFile}`);
  console.log('');
  console.log(`=== Release ${tag} 创建成功 ===`);
  console.log(`查看: https://github.com/atpx4869/stdhub/releases/tag/${tag}`);
} finally {
  try { unlinkSync(tmpFile); } catch {}
}
