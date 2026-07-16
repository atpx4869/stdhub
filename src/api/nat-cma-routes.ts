/**
 * 国家 CMA 资质订阅路由。
 *
 * 内置湖北省产品质量监督检验研究院（证书编号 230020349767）作为首个订阅源。
 * 支持：
 * - 获取内置机构的场所列表
 * - 订阅/取消订阅场所
 * - 获取已订阅场所的资质状态
 */
import express from 'express';
import { z } from 'zod';
import type Database from 'better-sqlite3';
import { respond, respondError } from '../shared/response';
import { normalizeError } from '../shared/errors';
import type { RequireTab } from './auth-middleware';

// ─── 内置机构数据 ──────────────────────────────────────────────────────

const BUILTIN_NAT_CMA_ORGS = [
  {
    certCode: '230020349767',
    orgName: '湖北省产品质量监督检验研究院',
    address: '湖北省武汉市武昌区公平路6号',
    places: [
      {
        placeId: '460F377538393663E0639602A8C0EA21',
        placeType: '主场所',
        placeName: '国家饮料及粮油制品质量检验检测中心',
        placeAddress: '湖北省武汉市武昌区公平路6号',
      },
      {
        placeId: '460F37751EF83663E0639602A8C0EA21',
        placeType: '分场所',
        placeName: '国家节能建筑材料质量检验检测中心（湖北）',
        placeAddress: '湖北省鄂州市鄂州葛店经济技术开发区创业大道东侧节能中心',
      },
      {
        placeId: '460F377537D63663E0639602A8C0EA21',
        placeType: '分场所',
        placeName: '国家饮料及粮油制品质量监督检验中心',
        placeAddress: '湖北省鄂州市鄂州葛店经济技术开发区创业大道东侧',
      },
      {
        placeId: '460F3775444F3663E0639602A8C0EA21',
        placeType: '分场所',
        placeName: '国家太阳能热水器产品质量检验检测中心（武汉）',
        placeAddress: '湖北省鄂州市鄂州葛店经济技术开发区创业大道东侧研发中心',
      },
      {
        placeId: '460F377549C63663E0639602A8C0EA21',
        placeType: '分场所',
        placeName: '国家金刚石工具质量监督检验中心（湖北）',
        placeAddress: '湖北省鄂州市鄂城区滨湖南路103号',
      },
    ],
  },
];

// ─── 数据库初始化 ──────────────────────────────────────────────────────

function ensureNatCmaTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS nat_cma_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cert_code TEXT NOT NULL,
      place_id TEXT NOT NULL,
      place_name TEXT NOT NULL,
      place_address TEXT NOT NULL,
      place_type TEXT NOT NULL DEFAULT '分场所',
      subscribed_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_synced_at TEXT,
      ability_count INTEGER DEFAULT 0,
      UNIQUE(cert_code, place_id)
    );
    CREATE INDEX IF NOT EXISTS idx_nat_cma_sub_cert ON nat_cma_subscriptions(cert_code);
  `);
}

// ─── 路由 ──────────────────────────────────────────────────────────────

export function createNatCmaRoutes(
  db: Database.Database,
  requireAuth: express.RequestHandler,
  requireTab: RequireTab,
): express.Router {
  const router = express.Router();
  const requireQual = requireTab('qual');

  // 确保表存在
  ensureNatCmaTables(db);

  // ─── 获取内置机构列表 ──────────────────────────────────────────────
  router.get('/api/nat-cma/orgs', requireAuth, (req, res) => {
    const orgs = BUILTIN_NAT_CMA_ORGS.map(org => {
      // 检查哪些场所已订阅
      const subscribed = db.prepare(
        'SELECT place_id FROM nat_cma_subscriptions WHERE cert_code = ?'
      ).all(org.certCode) as Array<{ place_id: string }>;
      const subscribedPlaceIds = new Set(subscribed.map(r => r.place_id));

      return {
        certCode: org.certCode,
        orgName: org.orgName,
        address: org.address,
        places: org.places.map(p => ({
          ...p,
          subscribed: subscribedPlaceIds.has(p.placeId),
        })),
        subscribedCount: subscribed.length,
        totalCount: org.places.length,
      };
    });

    respond(res, { items: orgs });
  });

  // ─── 获取订阅的场所列表 ──────────────────────────────────────────
  router.get('/api/nat-cma/subscriptions', requireAuth, (req, res) => {
    const subs = db.prepare(
      'SELECT * FROM nat_cma_subscriptions ORDER BY subscribed_at DESC'
    ).all();

    // 补充内置信息
    const enriched = subs.map((sub: any) => {
      const builtin = BUILTIN_NAT_CMA_ORGS.find(o => o.certCode === sub.cert_code);
      const place = builtin?.places.find(p => p.placeId === sub.place_id);
      return {
        ...sub,
        orgName: builtin?.orgName || '',
        placeType: place?.placeType || sub.place_type,
      };
    });

    respond(res, { items: enriched });
  });

  // ─── 订阅场所 ──────────────────────────────────────────────────
  router.post('/api/nat-cma/subscribe', requireQual, (req, res, next) => {
    try {
      const schema = z.object({
        certCode: z.string().trim().min(1),
        placeId: z.string().trim().min(1),
      });
      const { certCode, placeId } = schema.parse(req.body);

      // 查找内置场所信息
      const org = BUILTIN_NAT_CMA_ORGS.find(o => o.certCode === certCode);
      if (!org) {
        respondError(res, 404, 'NOT_FOUND', '未找到该机构');
        return;
      }
      const place = org.places.find(p => p.placeId === placeId);
      if (!place) {
        respondError(res, 404, 'NOT_FOUND', '未找到该场所');
        return;
      }

      // 插入订阅
      db.prepare(`
        INSERT OR IGNORE INTO nat_cma_subscriptions
        (cert_code, place_id, place_name, place_address, place_type)
        VALUES (?, ?, ?, ?, ?)
      `).run(certCode, placeId, place.placeName, place.placeAddress, place.placeType);

      respond(res, { ok: true, placeId, placeName: place.placeName });
    } catch (e) { next(normalizeError(e)); }
  });

  // ─── 取消订阅 ──────────────────────────────────────────────────
  router.delete('/api/nat-cma/subscribe/:placeId', requireQual, (req, res, next) => {
    try {
      const placeId = req.params.placeId;
      db.prepare('DELETE FROM nat_cma_subscriptions WHERE place_id = ?').run(placeId);
      respond(res, { ok: true });
    } catch (e) { next(normalizeError(e)); }
  });

  // ─── 获取订阅状态统计 ──────────────────────────────────────────
  router.get('/api/nat-cma/status', requireAuth, (req, res) => {
    const total = (db.prepare('SELECT COUNT(*) as cnt FROM nat_cma_subscriptions').get() as { cnt: number }).cnt;
    const totalAbilities = (db.prepare('SELECT COALESCE(SUM(ability_count), 0) as cnt FROM nat_cma_subscriptions').get() as { cnt: number }).cnt;
    const lastSynced = (db.prepare('SELECT MAX(last_synced_at) as ts FROM nat_cma_subscriptions').get() as { ts: string | null }).ts;

    respond(res, {
      total,
      totalAbilities,
      lastSynced,
      source: '国家 CMA (cma.cnca.cn)',
    });
  });

  return router;
}
