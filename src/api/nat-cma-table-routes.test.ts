import {describe,it,expect,afterEach} from 'vitest';
import express from 'express';
import request from 'supertest';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import {createNatCmaTableRoutes} from './nat-cma-table-routes';
import type {RequireTab} from './auth-middleware';
const dbs:Database.Database[]=[];
afterEach(()=>{for(const db of dbs.splice(0))db.close();});
async function xlsx(){const w=new ExcelJS.Workbook(),s=w.addWorksheet('表');s.getCell('A2').value='大类序号';s.getCell('H3').value='编号（含年号）';s.getRow(4).values=['一','材料','1','涂料','1.1','耐候性','标准名','GB 1-2020','限制','说明','PRIVATE','ID'];return Buffer.from(await w.xlsx.writeBuffer());}
function app(){const db=new Database(':memory:');dbs.push(db);const app=express();app.use(express.json());app.use((req,_res,next)=>{if(req.headers['x-owner'])req.user={id:Number(req.headers['x-owner']),username:'admin',display_name:'Admin',role:'admin',allowed_tabs:null};next();});const auth:express.RequestHandler=(req,res,next)=>{if(!req.user){res.status(401).end();return;}next();};const admin:express.RequestHandler=(req,res,next)=>{if(req.user?.role!=='admin'){res.status(403).end();return;}next();};const tab:RequireTab=(...tabs)=>(req,res,next)=>{if(req.headers['x-deny-tab']){res.status(403).end();return;}res.setHeader('x-tabs',tabs.join(','));next();};app.use(createNatCmaTableRoutes(db,auth,admin,tab));return app;}
const base='/api/nat-cma/table';
describe('CMA table guarded router',()=>{
 it('allows tab-protected public reads and does not guard unrelated root routes',async()=>{const a=app();a.get('/other',(_req,res)=>res.send('ok'));const s=await request(a).get(base+'/status');expect(s.status).toBe(200);expect(s.body.data.source).toBe('approved_table');expect(s.body.error).toBeNull();expect(s.headers['x-tabs']).toBe('qual,search,local');expect((await request(a).get(base+'/status').set('x-deny-tab','1')).status).toBe(403);expect((await request(a).get('/other').set('x-deny-tab','1')).status).toBe(200);});
 it('protects writes, binds ownership, confirms and matches exact year',async()=>{
  const a=app();expect((await request(a).post(base+'/preview').attach('file',await xlsx(),'x.xlsx')).status).toBe(401);
  const p=await request(a).post(base+'/preview').set('x-owner','1').attach('file',await xlsx(),'14检验检测能力申请表.xlsx');expect(p.status).toBe(200);expect(p.body.data.filename).toBe('14检验检测能力申请表.xlsx');expect(p.body.data.rowCount).toBe(1);expect(JSON.stringify(p.body)).not.toContain('PRIVATE');const previewId=p.body.data.previewId;
  expect((await request(a).post(base+'/confirm').set('x-owner','2').send({previewId})).status).toBe(404);
  const confirmed=await request(a).post(base+'/confirm').set('x-owner','1').send({previewId,name:'批准版本'});expect(confirmed.status).toBe(200);expect(confirmed.body.data.alreadyImported).toBe(false);
  const m=await request(a).post(base+'/batch-match').send({stdCodes:['GB 1-2020','GB 1-2021',' GB 1-2020 ']});expect(m.status).toBe(200);expect(m.body.data['GB 1-2020'].abilityCount).toBe(1);expect(m.body.data['GB 1-2021'].abilityCount).toBe(0);expect(m.body.data[' GB 1-2020 '].abilityCount).toBe(1);
  const search=await request(a).get(base+'/search').query({q:'限制'});expect(search.status).toBe(200);expect(search.body.data.items[0].entries[0]).toMatchObject({limitDesc:'限制',note:'说明',sheetName:'表',rowNumber:4});expect((await request(a).get(base+'/abilities').query({stdCode:'GB 1-2020'})).body.data.entries).toHaveLength(1);
  expect((await request(a).get(base+'/batches')).body.data.items[0].active).toBe(true);expect((await request(a).post(base+'/activate').set('x-owner','1').send({batchId:confirmed.body.data.batch.id})).status).toBe(200);
 });
 it('rejects bad and ambiguous query/body inputs and invalid uploads',async()=>{const a=app();for(const query of [{limit:'0'},{limit:'101'},{offset:'-1'},{q:['a','b']},{limit:'1x'}])expect((await request(a).get(base+'/search').query(query)).status).toBe(400);expect((await request(a).post(base+'/batch-match').send({stdCodes:'x'})).status).toBe(400);expect((await request(a).post(base+'/activate').set('x-owner','1').send({batchId:'1'})).status).toBe(400);expect((await request(a).post(base+'/preview').set('x-owner','1').attach('file',Buffer.from('bad'),'x.xlsx')).status).toBe(400);expect((await request(a).post(base+'/preview').set('x-owner','1').attach('file',await xlsx(),'x.xls')).status).toBe(400);expect((await request(a).post(base+'/preview').set('x-owner','1').attach('file',Buffer.alloc(10*1024*1024+1),'x.xlsx')).status).toBe(413);});
});
