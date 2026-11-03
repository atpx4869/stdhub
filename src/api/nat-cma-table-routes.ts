import express from 'express';
import multer from 'multer';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { RequireTab } from './auth-middleware';
import { respond, respondError } from '../shared/response';
import { NatCmaTableService, NatCmaTableError } from '../services/nat-cma-table-service';
import { MAX_TABLE_UPLOAD_BYTES } from '../services/nat-cma-table-parser';

/** Standalone approved-table library; intentionally does not restore the suspended online provider. */
export function createNatCmaTableRoutes(
  db: Database.Database,
  requireAuth: express.RequestHandler,
  requireAdmin: express.RequestHandler,
  requireTab: RequireTab,
): express.Router {
  const router = express.Router(), service = new NatCmaTableService(db);
  const read = requireTab('qual','search','local');
  const prefix = '/api/nat-cma/table';
  const upload = multer({storage:multer.memoryStorage(),limits:{fileSize:MAX_TABLE_UPLOAD_BYTES,files:1,fields:0,parts:1},fileFilter:(_req,file,cb)=>{
    if (!/\.xlsx$/i.test(file.originalname)) { cb(new NatCmaTableError('只支持 XLSX 文件')); return; } cb(null,true);
  }}).single('file');
  const run = (handler: (req:express.Request,res:express.Response)=>unknown): express.RequestHandler => (req,res,next)=>{
    Promise.resolve().then(()=>handler(req,res)).catch(e=>{
      if (e instanceof NatCmaTableError) respondError(res,e.status,'NAT_CMA_TABLE_ERROR',e.message);
      else if (e instanceof z.ZodError) respondError(res,400,'BAD_REQUEST','请求参数非法');
      else next(e);
    });
  };
  const filename = (value:string):string => {
    // Busboy interprets filename bytes as latin1. Decode only a lossless UTF-8 round trip.
    if ([...value].some(ch => ch.charCodeAt(0)>255)) return value;
    const decoded = Buffer.from(value,'latin1').toString('utf8');
    return !decoded.includes('\uFFFD') && Buffer.from(decoded,'utf8').toString('latin1')===value ? decoded : value;
  };
  const owner = (req:express.Request):number => {
    if (!req.user || req.user.role !== 'admin' || !Number.isSafeInteger(req.user.id) || req.user.id<=0) throw new NatCmaTableError('需要已认证管理员',401);
    return req.user.id;
  };
  router.get(prefix+'/status',read,run((_req,res)=>respond(res,service.status())));
  router.get(prefix+'/batches',read,run((_req,res)=>respond(res,service.batches())));
  router.get(prefix+'/search',read,run((req,res)=>{
    const query = z.object({q:z.string().max(300).default(''),limit:z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).default(20),offset:z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(0).max(1000000)).default(0),category:z.string().max(300).optional()}).parse(req.query);
    respond(res,service.search(query.q,query.limit,query.offset,query.category));
  }));
  router.get(prefix+'/abilities',read,run((req,res)=>{
    const {stdCode} = z.object({stdCode:z.string().trim().min(1).max(300)}).parse(req.query);
    respond(res,service.abilities(stdCode));
  }));
  // Read-only POST: existing global CSRF protection still applies.
  router.post(prefix+'/batch-match',read,run((req,res)=>{
    const {stdCodes}=z.object({stdCodes:z.array(z.string().min(1).max(300).refine(s=>!!s.trim())).max(500)}).strict().parse(req.body);
    respond(res,service.batchMatch(stdCodes));
  }));
  router.post(prefix+'/preview',requireAuth,requireAdmin,(req,res,next)=>{
    try { owner(req); } catch(e) { if(e instanceof NatCmaTableError) respondError(res,e.status,'NAT_CMA_TABLE_ERROR',e.message); else next(e); return; }
    upload(req,res,error=>{
      if(error) {respondError(res,error instanceof multer.MulterError && error.code==='LIMIT_FILE_SIZE' ? 413 : 400,'BAD_UPLOAD',error.message);return;}
      void run(async(request,response)=>{
        if(!request.file) throw new NatCmaTableError('请选择 XLSX 文件');
        try {respond(response,await service.preview(request.file.buffer,filename(request.file.originalname),owner(request)));}
        catch(e) {if(e instanceof NatCmaTableError) throw e; throw new NatCmaTableError(e instanceof Error ? e.message : '无法解析 XLSX');}
      })(req,res,next);
    });
  });
  router.post(prefix+'/confirm',requireAuth,requireAdmin,run((req,res)=>{
    const {previewId,name}=z.object({previewId:z.string().uuid(),name:z.string().trim().min(1).max(120).optional()}).strict().parse(req.body);
    respond(res,service.confirm(previewId,owner(req),name));
  }));
  router.post(prefix+'/activate',requireAuth,requireAdmin,run((req,res)=>{
    owner(req);
    const {batchId}=z.object({batchId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)}).strict().parse(req.body);
    respond(res,service.activate(batchId));
  }));
  return router;
}
