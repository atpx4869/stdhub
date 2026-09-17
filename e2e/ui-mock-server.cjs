'use strict';
const express = require('express');
const path = require('node:path');
const projectRoot = process.env.STDHUB_PROJECT_ROOT || process.cwd();
const app = express();
app.use(express.json());
const adminUser = { id: 1, username: 'admin', displayName: '隔离测试管理员', role: 'admin', allowedTabs: null };
app.get('/api/auth/status', (_req, res) => res.json({ data: { user: adminUser, loginRequired: true, needsSetup: false }, error: null }));
app.post('/api/auth/login', (_req, res) => res.json({ data: { user: adminUser }, error: null }));
app.get('/api/health', (_req, res) => res.json({ data: { ok: true, features: { natCma: { state: 'suspended', readOnly: true } } }, error: null }));
app.get('/api/standards/complete/fields', (_req, res) => res.json({ data: { groups: [], fields: [], presets: [] }, error: null }));
app.get('/api/downloads', (_req, res) => res.json({ data: { items: [], total: 0, libraryTotal: 0, limit: 30, offset: 0 }, error: null }));
app.get('/api/check/saved/codes', (_req, res) => res.json({ data: { codes: [] }, error: null }));
app.get('/api/check/saved/meta', (_req, res) => res.json({ data: { items: [] }, error: null }));
app.get('/api/announcements/unread', (_req, res) => res.json({ data: { announcements: [] }, error: null }));
app.get('/api/diagnostics/environment', (_req, res) => {
  const now = new Date().toISOString();
  const checks = Object.fromEntries([
    ['ocr', 'OCR 引擎 (ddddocr)'], ['gbw', 'BW 国标网'],
    ['bz', 'BZ 标准在线'], ['by', 'BY 内网'],
  ].map(([name, label]) => [name, { name, label, status: 'skip', detail: '隔离前端 mock，不访问上游', checkedAt: now }]));
  res.json({ data: { startedAt: now, finishedAt: now, checks }, error: null });
});
app.use(express.static(path.join(projectRoot, 'public')));
const server = app.listen(4174, '127.0.0.1', () => console.log('UI_MOCK_READY=4174'));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => process.exit(0)));
