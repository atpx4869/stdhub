/**
 * 国家 CMA 一单一库（能力项目库）路由。
 *
 * 路径前缀 /api/cma-diff，挂载方式：app.use(createCapLibRoutes(...)) —— 路径自带前缀，
 * 与 cnas-routes / labr-routes 风格一致；router 挂在根上故必须用 per-route guard（不可
 * 用 router.use(requireXxx)，参考 cnas-routes.ts:18-19 那段教训）。
 *
 * 权限：
 * - 大多数读端点：requireTab('cma-diff')
 * - batch-status（搜索/资质查询页徽章用）：OR `cma-diff` / `qual` / `search` —— 三个 tab 任一即可
 * - 触发同步 / 批量订阅 / 清理：requireAdmin（在路由内部组合 requireAdmin）
 */
import express from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import {
  CapLibService, getSyncProgress, CAP_LIB_DOMAIN_NAMES, isValidCapLibDomain,
  type ExportFilter, type ExportRow,
} from '../services/cap-lib-service';
import { DIFF_STATUS_VALUES, type DiffStatus } from '../shared/cap-lib-status';
import { normalizeError } from '../shared/errors';
import { respond, respondError } from '../shared/response';
import { toCamelCase } from '../shared/case';
import type { RequireTab } from './auth-middleware';

export function createCapLibRoutes(
  db: Database.Database,
  requireAuth: express.RequestHandler,
  requireAdmin: express.RequestHandler,
  requireTab: RequireTab,
): express.Router {
  const router = express.Router();
  const svc = new CapLibService(db);

  const requireCmaDiff = requireTab('cma-diff');
  // batch-status：徽章注入到搜索结果 / 资质查询页 / 比对页，三方任一都该看到
  const requireBadgeAccess = requireTab('cma-diff', 'qual', 'search');

  // ── 元数据 ──────────────────────────────────────────────────────────

  router.get('/api/cma-diff/domains', requireCmaDiff, (_req, res, next) => {
    try {
      respond(res, toCamelCase({ items: svc.listDomains(), all: CAP_LIB_DOMAIN_NAMES }));
    } catch (e) { next(normalizeError(e)); }
  });

  router.put('/api/cma-diff/domains/subscriptions', requireCmaDiff, requireAdmin, (req, res, next) => {
    try {
      const schema = z.object({
        items: z.array(z.object({
          domain: z.string().trim().min(1),
          subscribed: z.boolean(),
        })).min(1).max(CAP_LIB_DOMAIN_NAMES.length),
      });
      const { items } = schema.parse(req.body);
      const invalid = items.find(it => !isValidCapLibDomain(it.domain));
      if (invalid) { respondError(res, 400, 'BAD_REQUEST', `非法领域名: ${invalid.domain}`); return; }
      const changed = svc.setSubscriptions(items);
      respond(res, { ok: true, changed });
    } catch (e) { next(normalizeError(e)); }
  });

  router.put('/api/cma-diff/domains/:name/subscribe', requireCmaDiff, requireAdmin, (req, res, next) => {
    try {
      const schema = z.object({ subscribed: z.boolean() });
      const { subscribed } = schema.parse(req.body);
      const name = decodeURIComponent(String(req.params.name));
      if (!isValidCapLibDomain(name)) { respondError(res, 400, 'BAD_REQUEST', '非法领域名'); return; }
      svc.setSubscribed(name, subscribed);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 同步 ────────────────────────────────────────────────────────────

  router.post('/api/cma-diff/sync/:name', requireCmaDiff, requireAdmin, (req, res, next) => {
    try {
      const name = decodeURIComponent(String(req.params.name));
      if (!isValidCapLibDomain(name)) { respondError(res, 400, 'BAD_REQUEST', '非法领域名'); return; }
      const jobId = svc.startSync(name);
      respond(res, { jobId, domain: name });
    } catch (e) { next(normalizeError(e)); }
  });

  router.post('/api/cma-diff/sync-selected', requireCmaDiff, requireAdmin, (req, res, next) => {
    try {
      const schema = z.object({
        domains: z.array(z.string().trim().min(1)).min(1).max(CAP_LIB_DOMAIN_NAMES.length),
      });
      const { domains } = schema.parse(req.body || {});
      const unique = [...new Set(domains)];
      const invalid = unique.find(name => !isValidCapLibDomain(name));
      if (invalid) { respondError(res, 400, 'BAD_REQUEST', `非法领域名: ${invalid}`); return; }
      const jobs = unique.map(domain => ({ domain, jobId: svc.startSync(domain) }));
      respond(res, { jobs });
    } catch (e) { next(normalizeError(e)); }
  });

  router.post('/api/cma-diff/sync-all', requireCmaDiff, requireAdmin, (_req, res, next) => {
    try {
      const subscribed = svc.listDomains().filter(d => d.subscribed);
      const jobs = subscribed.map(d => ({ domain: d.domain, jobId: svc.startSync(d.domain) }));
      respond(res, { jobs });
    } catch (e) { next(normalizeError(e)); }
  });

  router.get('/api/cma-diff/sync/progress/:jobId', requireCmaDiff, (req, res) => {
    const p = getSyncProgress(String(req.params.jobId));
    if (!p) { respondError(res, 404, 'NOT_FOUND', '任务不存在或已过期'); return; }
    respond(res, toCamelCase(p));
  });

  // ── 比对 ────────────────────────────────────────────────────────────

  router.get('/api/cma-diff/labs', requireCmaDiff, (_req, res, next) => {
    try { respond(res, toCamelCase({ items: svc.labsCounts() })); } catch (e) { next(normalizeError(e)); }
  });

  router.get('/api/cma-diff/labs/:certNumber', requireCmaDiff, (req, res, next) => {
    try {
      const certNumber = String(req.params.certNumber);
      const filterStatus = (typeof req.query.status === 'string' ? req.query.status : '').split(',').filter(Boolean);
      const q = (typeof req.query.q === 'string' ? req.query.q : '').trim().toLowerCase();
      let rows = svc.diffByLab(certNumber);
      if (filterStatus.length > 0) rows = rows.filter(r => filterStatus.includes(r.diffStatus));
      if (q) rows = rows.filter(r =>
        r.stdCode.toLowerCase().includes(q) ||
        r.stdName.toLowerCase().includes(q) ||
        r.testItem.toLowerCase().includes(q));
      respond(res, toCamelCase({ total: rows.length, rows }));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 导出（三级：单档 / 单机构 / 全部，流式 xlsx 不落临时文件） ──────────
  router.post('/api/cma-diff/export', requireCmaDiff, async (req, res, next) => {
    try {
      const schema = z.object({
        certNumbers: z.array(z.string().trim()).max(200).default([]), // 0 个 = 全部订阅机构
        statuses: z.array(z.enum(DIFF_STATUS_VALUES as unknown as [DiffStatus, ...DiffStatus[]])).optional(),
        keyword: z.string().trim().max(200).optional(),
      });
      const filter = schema.parse(req.body || {});
      const rows = svc.exportDiff(filter);
      if (!rows.length) { respondError(res, 400, 'EMPTY', '没有可导出的数据'); return; }

      const header = [
        '机构名称', '证书编号', '标准号', '标准名称', '类别', '检测项目',
        '比对状态', '库内备注', '库内领域', '建议替代年版', '替代年版领域',
      ];
      const aoa = [
        header,
        ...rows.map(r => [
          r.labName, r.certNumber, r.stdCode, r.stdName, r.category,
          (r.testItems && r.testItems.length ? r.testItems.join('、') : r.testItem),
          statusCellText(r.diffStatus), r.libRemark, r.libDomain, r.seriesNewCode, r.seriesDomain,
        ]),
      ];

      const XLSX = (await import('xlsx')).default;
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!autofilter'] = { ref: 'A1:K1' };
      ws['!cols'] = autoColWidths(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'CMA一单一库比对');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const filename = buildExportFilename(filter, rows);
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      res.send(buf);
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 徽章 batch-status（共用） ──────────────────────────────────────

  router.post('/api/cma-diff/batch-status', requireBadgeAccess, (req, res, next) => {
    try {
      const schema = z.object({ stdCodes: z.array(z.string().trim()).min(1).max(500) });
      const { stdCodes } = schema.parse(req.body);
      respond(res, toCamelCase(svc.batchStatus(stdCodes)));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 黑名单（屏蔽非标准号脏内容；读 tab / 写 admin） ────────────────
  router.get('/api/cma-diff/blacklist', requireCmaDiff, (_req, res, next) => {
    try { respond(res, { items: svc.listBlacklist() }); } catch (e) { next(normalizeError(e)); }
  });

  router.post('/api/cma-diff/blacklist', requireCmaDiff, requireAdmin, (req, res, next) => {
    try {
      const schema = z.object({
        items: z.array(z.object({
          stdCode: z.string().trim().min(1),
          reason: z.string().trim().max(200).optional(),
        })).min(1).max(500),
      });
      const { items } = schema.parse(req.body);
      const added = svc.addBlacklist(items);
      respond(res, { added });
    } catch (e) { next(normalizeError(e)); }
  });

  router.delete('/api/cma-diff/blacklist', requireCmaDiff, requireAdmin, (req, res, next) => {
    try {
      const schema = z.object({ ids: z.array(z.number().int()).min(1).max(500) });
      const { ids } = schema.parse(req.body);
      const removed = svc.removeBlacklist(ids);
      respond(res, { removed });
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 手动映射 + 重试（人工兜底；读 tab / 写 admin） ─────────────────
  router.get('/api/cma-diff/manual-map', requireCmaDiff, (req, res, next) => {
    try {
      const certNumber = typeof req.query.certNumber === 'string' ? req.query.certNumber : undefined;
      respond(res, { items: svc.listManualMap(certNumber) });
    } catch (e) { next(normalizeError(e)); }
  });

  router.post('/api/cma-diff/manual-map', requireCmaDiff, requireAdmin, (req, res, next) => {
    try {
      const schema = z.object({
        certNumber: z.string().trim().max(64).default(''),
        srcStdCode: z.string().trim().min(1),
        libStdCode: z.string().trim().min(1),
      });
      const { certNumber, srcStdCode, libStdCode } = schema.parse(req.body);
      svc.setManualMap(certNumber, srcStdCode, libStdCode);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  router.delete('/api/cma-diff/manual-map', requireCmaDiff, requireAdmin, (req, res, next) => {
    try {
      const schema = z.object({ id: z.number().int() });
      const { id } = schema.parse(req.body);
      respond(res, { removed: svc.removeManualMap(id) });
    } catch (e) { next(normalizeError(e)); }
  });

  // 单项重新匹配：返回该标准号最新 diff 行（前端就地替换，免整页重渲）
  router.post('/api/cma-diff/rematch', requireCmaDiff, (req, res, next) => {
    try {
      const schema = z.object({
        certNumber: z.string().trim().min(1),
        stdCode: z.string().trim().min(1),
      });
      const { certNumber, stdCode } = schema.parse(req.body);
      const row = svc.rematchOne(certNumber, stdCode);
      if (!row) { respondError(res, 404, 'NOT_FOUND', '未找到该标准号'); return; }
      respond(res, toCamelCase({ row }));
    } catch (e) { next(normalizeError(e)); }
  });

  // 诊断单个标准号（误判自查）：归一化值 + 本地库命中 + 黑名单/映射/各领域同步状态
  router.get('/api/cma-diff/diagnose', requireCmaDiff, (req, res, next) => {
    try {
      const stdCode = typeof req.query.stdCode === 'string' ? req.query.stdCode.trim() : '';
      if (!stdCode) { respondError(res, 400, 'BAD_REQUEST', '缺少 stdCode'); return; }
      respond(res, toCamelCase(svc.diagnose(stdCode)));
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 能力项目库搜索 ──────────────────────────────────────────────────

  router.get('/api/cma-diff/search', requireCmaDiff, (req, res, next) => {
    try {
      const schema = z.object({
        q: z.string().trim().max(200).optional(),
        domain: z.string().trim().max(100).optional(),
        status: z.enum(['active', 'cite_only', 'abolished']).optional(),
        limit: z.coerce.number().int().min(1).max(500).default(50),
        offset: z.coerce.number().int().min(0).default(0),
      });
      const params = schema.parse(req.query);
      const result = svc.searchCapLib(params);
      respond(res, result);
    } catch (e) { next(normalizeError(e)); }
  });

  // ── 清理（admin） ──────────────────────────────────────────────────

  router.post('/api/cma-diff/cleanup', requireCmaDiff, requireAdmin, (req, res, next) => {
    try {
      const schema = z.object({ days: z.number().int().min(7).max(365).default(30) });
      const { days } = schema.parse(req.body || {});
      const deleted = svc.cleanupStaleRows(days);
      respond(res, { deleted, days });
    } catch (e) { next(normalizeError(e)); }
  });

  // 为兼容老调用方避免 unused 警告
  void requireAuth;
  return router;
}

// ─── 导出辅助 ───────────────────────────────────────────────────────────────

/** 状态列 emoji 前缀（零依赖，不走 cellStyles）+ 中文档名。与前端 DIFF_STATUS_META 对齐。 */
const STATUS_CELL: Record<DiffStatus, string> = {
  in_lib:      '✅ 在库',
  cite_only:   '⚠ 废止·可引用',
  abolished:   '🟠 已废止',
  series_only: '🔴 年版过期',
  not_in_lib:  '⛔ 未入库',
};
function statusCellText(s: DiffStatus): string {
  return STATUS_CELL[s] || s;
}

/** 列宽自适应：按每列内容最大「视觉宽度」估算（中文算 2，其它 1），夹在 [8, 50]。 */
function autoColWidths(aoa: Array<Array<string | number>>): Array<{ wch: number }> {
  const cols = aoa[0]?.length || 0;
  const widths: number[] = new Array(cols).fill(8);
  for (const row of aoa) {
    for (let c = 0; c < cols; c++) {
      const v = row[c] == null ? '' : String(row[c]);
      let w = 0;
      for (const ch of v) w += ch.charCodeAt(0) > 255 ? 2 : 1;
      if (w + 2 > widths[c]) widths[c] = w + 2;
    }
  }
  return widths.map(w => ({ wch: Math.min(50, Math.max(8, w)) }));
}

/** 文件名：单机构 `CMA一单一库比对-{机构名}-{YYYYMMDDHHmm}.xlsx` / 全部 `…-全部-…`。机构名 sanitize。
 *  带时分（精确到分钟）避免同一天多次导出同机构文件名冲突（覆盖/加(1)失败）。 */
function buildExportFilename(filter: ExportFilter, rows: ExportRow[]): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}`;
  const certs = (filter.certNumbers || []).filter(Boolean);
  let scope: string;
  if (certs.length === 0) {
    scope = '全部';
  } else if (certs.length === 1) {
    scope = sanitizeFilePart(rows[0]?.labName || certs[0]);
  } else {
    scope = `${certs.length}家机构`;
  }
  return `CMA一单一库比对-${scope}-${ts}.xlsx`;
}

/** 去掉 Windows / 通用文件名非法字符 \ / : * ? " < > | 及控制符。 */
function sanitizeFilePart(s: string): string {
  return (s || '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .trim()
    .slice(0, 80) || '导出';
}
