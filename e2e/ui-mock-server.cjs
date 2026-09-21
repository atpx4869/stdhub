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
app.get('/api/cma-diff/labs', (_req, res) => res.json({
  data: {
    items: [{
      certNumber: '221700110366',
      labName: '湖北省产品质量监督检验研究院',
      total: 9570,
      byStatus: { in_lib: 9412, cite_only: 96, abolished: 21, series_only: 28, not_in_lib: 13 },
      changes: {
        windowDays: 90,
        totalEvents: 3,
        deltaByStatus: { in_lib: -1, cite_only: 0, abolished: 1, series_only: 1, not_in_lib: 1 },
        events: [
          { stdCode: 'GB/T 17657-2022', stdName: '人造板及饰面人造板理化性能试验方法', changeType: 'status_changed', fromStatus: 'in_lib', toStatus: 'series_only', changedAt: '2026-09-12 10:00' },
          { stdCode: 'GB 18580-2025', stdName: '室内装饰装修材料 人造板及其制品中甲醛释放限量', changeType: 'status_changed', fromStatus: 'in_lib', toStatus: 'abolished', changedAt: '2026-09-08 10:00' },
          { stdCode: 'GB/T 35601-2024', stdName: '绿色产品评价 人造板和木质地板', changeType: 'added', fromStatus: '', toStatus: 'in_lib', changedAt: '2026-09-02 10:00' },
        ],
      },
    }],
  },
  error: null,
}));
app.get('/api/cma-diff/domains', (_req, res) => res.json({ data: { items: [], all: [] }, error: null }));
app.get('/api/cma-diff/labs/:certNumber', (req, res) => res.json({
  data: { total: 0, rows: [] },
  error: null,
}));
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
