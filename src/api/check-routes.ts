import { Router } from 'express';
import { z } from 'zod';
import * as path from 'path';
import { mkdir, writeFile } from 'fs/promises';
import type Database from 'better-sqlite3';
import type { Request, Response, NextFunction } from 'express';
import { respond, respondError } from '../shared/response';
import { toCamelCase } from '../shared/case';
import { normalizeError } from '../shared/errors';
import { CheckService, CheckDebounceError, CHANGE_FLAG_LABELS } from '../services/check-service';
import type { SourceRegistry } from '../services/source-registry';
import type { RequireTab } from './auth-middleware';

// 标准查新路由（见 docs/CHECK-UPDATE-AND-STATS.md）。挂载路径自带 /api/check 前缀。
export function createCheckRoutes(
  db: Database.Database,
  sourceRegistry: SourceRegistry,
  requireAuth: (req: Request, res: Response, next: NextFunction) => void,
  requireAdmin: (req: Request, res: Response, next: NextFunction) => void,
  baseDir: string,
  requireTab: RequireTab,
): Router {
  const router = Router();
  const svc = new CheckService(db, sourceRegistry);
  // 此 router 由 app.use(router) 挂在根上（无 mount path），所以不能用 router.use()
  // 做整 router 守卫——那会对全站每个请求生效。改用 per-route guard：每条路由的
  // requireAuth 已被替换成 requireTab('check')（内部含 requireAuth）。
  const requireCheck = requireTab('check');
  const requireCheckAdmin = requireAdmin;

  // 校验清单归属：非本人（且非管理员）一律 404，不泄漏存在性。
  function ensureOwner(req: Request, res: Response, id: number): boolean {
    const owner = svc.ownerOf(id);
    if (owner === null || (owner !== req.user!.id && req.user!.role !== 'admin')) {
      respondError(res, 404, 'NOT_FOUND', '清单不存在');
      return false;
    }
    return true;
  }

  // 收藏 toggle（点收藏 = 加入"我的收藏"查新清单并查一次；再点取消）
  router.post('/api/check/saved/toggle', requireCheckAdmin,async (req, res, next) => {
    try {
      const schema = z.object({ stdCode: z.string().trim().min(1).max(120) });
      const { stdCode } = schema.parse(req.body);
      const r = await svc.toggleSaved(req.user!.id, stdCode);
      if (!r.saved) db.prepare('DELETE FROM saved_standard_meta WHERE user_id = ? AND std_code = ?').run(req.user!.id, stdCode);
      respond(res, r);
    } catch (e) { next(normalizeError(e)); }
  });

  router.get('/api/check/saved/meta', requireCheckAdmin, (req, res, next) => {
    try {
      const items = db.prepare('SELECT std_code, group_name, note, downloaded, file_name, updated_at FROM saved_standard_meta WHERE user_id = ? ORDER BY updated_at DESC').all(req.user!.id);
      respond(res, { items: toCamelCase(items) });
    } catch (e) { next(normalizeError(e)); }
  });

  router.put('/api/check/saved/meta', requireCheckAdmin, (req, res, next) => {
    try {
      const schema = z.object({ items: z.array(z.object({ stdCode: z.string().trim().min(1).max(120), group: z.string().max(80).optional(), note: z.string().max(500).optional(), downloaded: z.boolean().optional(), fileName: z.string().max(255).optional() })).max(200) });
      const { items } = schema.parse(req.body);
      const saved = new Set(svc.getSavedCodes(req.user!.id));
      const upsert = db.prepare("INSERT INTO saved_standard_meta (user_id, std_code, group_name, note, downloaded, file_name, updated_at) VALUES (?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(user_id, std_code) DO UPDATE SET group_name=excluded.group_name, note=excluded.note, downloaded=excluded.downloaded, file_name=excluded.file_name, updated_at=excluded.updated_at");
      db.transaction(() => items.forEach(item => { if (saved.has(item.stdCode)) upsert.run(req.user!.id, item.stdCode, item.group || '', item.note || '', item.downloaded ? 1 : 0, item.fileName || ''); }))();
      respond(res, { updated: items.length });
    } catch (e) { next(normalizeError(e)); }
  });

  // 当前用户收藏的标准号集合（搜索结果点亮收藏态）
  router.get('/api/check/saved/codes', requireCheckAdmin,(req, res, next) => {
    try { respond(res, { codes: svc.getSavedCodes(req.user!.id) }); }
    catch (e) { next(normalizeError(e)); }
  });

  // 列出我的查新清单
  router.get('/api/check/watchlists', requireCheckAdmin,(req, res, next) => {
    try { respond(res, { items: toCamelCase(svc.getWatchlists(req.user!.id)) }); }
    catch (e) { next(normalizeError(e)); }
  });

  // 创建清单 + 导入标准号（首查存基线）
  router.post('/api/check/watchlists', requireCheckAdmin,async (req, res, next) => {
    try {
      const schema = z.object({
        name: z.string().trim().max(120).optional(),
        lines: z.array(z.string().trim()).min(1, '至少导入一个标准号').max(500),
      });
      const { name, lines } = schema.parse(req.body);
      const r = await svc.createWatchlist(req.user!.id, name ?? `查新清单 ${new Date().toLocaleDateString('zh-CN')}`, lines);
      respond(res, toCamelCase(r), 201);
    } catch (e) { next(normalizeError(e)); }
  });

  // 单清单明细
  router.get('/api/check/watchlists/:id', requireCheckAdmin,(req, res, next) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id) || !ensureOwner(req, res, id)) return;
      respond(res, { items: toCamelCase(svc.getItems(id)) });
    } catch (e) { next(normalizeError(e)); }
  });

  // 重新查新
  router.post('/api/check/watchlists/:id/recheck', requireCheckAdmin,async (req, res, next) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id) || !ensureOwner(req, res, id)) return;
      await svc.recheck(id);
      respond(res, { items: toCamelCase(svc.getItems(id)) });
    } catch (e) {
      if (e instanceof CheckDebounceError) { respondError(res, 429, 'TOO_FREQUENT', e.message); return; }
      next(normalizeError(e));
    }
  });

  // 设置自动查新（每清单：开关 + 周期天数，硬下限 15）
  router.put('/api/check/watchlists/:id/auto', requireCheckAdmin,(req, res, next) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id) || !ensureOwner(req, res, id)) return;
      const schema = z.object({ enabled: z.boolean(), intervalDays: z.number().int().min(15).max(365).optional() });
      const { enabled, intervalDays } = schema.parse(req.body);
      svc.setAuto(id, enabled, intervalDays ?? 15);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // 导出查新结果为 Excel。body.ids = 选中的 item id（空/缺省 = 全部）。
  router.post('/api/check/watchlists/:id/export', requireCheckAdmin,async (req, res, next) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id) || !ensureOwner(req, res, id)) return;
      const schema = z.object({ ids: z.array(z.number().int()).optional() });
      const { ids } = schema.parse(req.body ?? {});

      let items = svc.getItems(id);
      if (ids && ids.length) {
        const set = new Set(ids);
        items = items.filter((it) => set.has(it.id));
      }
      if (!items.length) { respondError(res, 400, 'EMPTY', '没有可导出的条目'); return; }

      const statusOf = (it: typeof items[number]) =>
        it.sourceUsed === 'not_found' ? '无法核验' : (it.sourceUsed === 'pending' ? '待查新' : (it.lastStatus || '—'));
      const flagsOf = (it: typeof items[number]) =>
        (it.changeFlags || []).map((f) => CHANGE_FLAG_LABELS[f] || f).join('、') || '无变动';

      const header = ['标准号', '名称', '当前状态', '变动类型', '新版本', '被代替', '实施日期', '废止日期'];
      const rows = items.map((it) => [
        it.stdCode, it.lastTitle || it.baseTitle || '', statusOf(it), flagsOf(it),
        it.newVersion || '', it.insteadStd || '', it.lastImplDate || '', it.abolishDate || '',
      ]);

      const [{ default: ExcelJS }, { addRowsWorksheet, workbookToBuffer }] = await Promise.all([
        import('exceljs'),
        import('../shared/excel.js'),
      ]);
      const wb = new ExcelJS.Workbook();
      addRowsWorksheet(wb, '标准查新', [header, ...rows], [20, 34, 12, 16, 18, 18, 13, 13]);

      const exportsDir = path.resolve(baseDir, 'data', 'exports');
      await mkdir(exportsDir, { recursive: true });
      const outFileName = `标准查新_${Date.now()}.xlsx`;
      const buf = await workbookToBuffer(wb);
      await writeFile(path.resolve(exportsDir, outFileName), buf);

      respond(res, { fileName: outFileName, downloadUrl: `/api/downloads/${encodeURIComponent(outFileName)}`, count: items.length });
    } catch (e) { next(normalizeError(e)); }
  });

  // 删除清单（不可逆）
  router.delete('/api/check/watchlists/:id', requireCheckAdmin,(req, res, next) => {
    try {
      const id = parseInt(req.params.id as string, 10);
      if (Number.isNaN(id) || !ensureOwner(req, res, id)) return;
      svc.deleteWatchlist(id);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  return router;
}
