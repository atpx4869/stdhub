import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const checkOnly = process.argv.includes('--check');
const apiBase = String(process.env.STDHUB_IOS_API_BASE || '').trim().replace(/\/+$/, '');
const runtimeConfigPath = path.resolve('public/js/runtime-config.js');

if (!apiBase) {
  console.error('缺少 STDHUB_IOS_API_BASE，例如：https://standards.example.com');
  process.exitCode = 1;
} else if (!/^https:\/\//i.test(apiBase)) {
  console.error('STDHUB_IOS_API_BASE 必须使用 HTTPS 地址。');
  process.exitCode = 1;
} else if (checkOnly) {
  console.log('iOS API 地址有效：' + apiBase);
} else {
  const original = await readFile(runtimeConfigPath, 'utf8');
  const packagedConfig = [
    '/* Generated temporarily by scripts/capacitor-sync.mjs. Do not commit this value. */',
    'window.STDHUB_RUNTIME_CONFIG = {',
    '  apiBase: ' + JSON.stringify(apiBase) + ',',
    '};',
    '',
  ].join('\n');

  try {
    await writeFile(runtimeConfigPath, packagedConfig, 'utf8');
    const command = process.platform === 'win32' ? 'npx.cmd' : 'npx';
    const result = spawnSync(command, ['cap', 'sync', 'ios'], { stdio: 'inherit' });
    if (result.status !== 0) process.exitCode = result.status || 1;
  } finally {
    await writeFile(runtimeConfigPath, original, 'utf8');
  }
}
