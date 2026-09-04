#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = path.join(root, 'public', 'index.html');
const corePath = path.join(root, 'public', 'js', 'app-core.js');
const index = fs.readFileSync(indexPath, 'utf8');
const core = fs.readFileSync(corePath, 'utf8');
const combined = `${index}\n${core}`;

const required = [
  '/css/theme-tokens.css',
  '/css/components-global.css',
  '/css/mobile.css',
  '/css/pages.css',
  '/css/themes.css',
  '/css/legacy-theme.css',
  '/css/workspace.css',
  '/css/preview-reader.css',
  '/css/components-pages.css',
];
const forbidden = ['/styles.css', '/css/components.css'];
const errors = [];

for (const href of required) {
  if (!combined.includes(href)) errors.push(`生产入口缺少样式: ${href}`);
}
for (const href of forbidden) {
  const escaped = href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reference = new RegExp(`["']${escaped}(?:[?"'])`);
  if (reference.test(combined)) errors.push(`生产入口仍引用历史样式: ${href}`);
}

if (errors.length) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}
console.log(`✓ CSS entrypoints are canonical (${required.length} active, ${forbidden.length} legacy blocked).`);
