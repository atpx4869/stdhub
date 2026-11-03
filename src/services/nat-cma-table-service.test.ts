import { describe,it,expect,afterEach } from 'vitest';
import Database from 'better-sqlite3';
import ExcelJS from 'exceljs';
import {createRequire} from 'node:module';
import {readFileSync,existsSync} from 'node:fs';
import {parseNatCmaTable,parseTableStandards,canonicalTableStandard,validateTableArchive,MAX_TABLE_UPLOAD_BYTES} from './nat-cma-table-parser';
import {NatCmaTableService,NAT_CMA_TABLE_ORG_NAME} from './nat-cma-table-service';

async function fixture(codes=['GB∕T 123.1-2020','GB∕T 123.1-2020','ISO 16474-1：2013 ISO16474-2:2013','未知方法']) {
 const w=new ExcelJS.Workbook(),s=w.addWorksheet('能力表');s.getCell('A2').value='大类序号';s.getCell('H3').value='编号（含年号）';
 codes.forEach((code,i)=>{s.getRow(i+4).values=['一','材料','1','涂料','1.1','耐候性','试验方法',code,'仅限A','变更','机密签字人','420000000000000000'];});
 return Buffer.from(await w.xlsx.writeBuffer());
}
const databases:Database.Database[]=[];
function setup(now?:()=>number) {const db=new Database(':memory:');db.pragma('foreign_keys=ON');databases.push(db);return {db,svc:new NatCmaTableService(db,now)};}
afterEach(()=>{for(const d of databases.splice(0))d.close();});
describe('approved table parser',()=>{
 it('retains duplicates, all A:J fields and provenance, excludes signer columns',async()=>{
  const p=await parseNatCmaTable(await fixture());expect(p.rows).toHaveLength(4);expect(p.duplicateCount).toBe(1);expect(p.standardCount).toBe(3);expect(p.categoryCount).toBe(1);expect(p.productCount).toBe(1);
  expect(p.rows[0]).toMatchObject({majorNo:'一',majorCategory:'材料',categoryNo:'1',category:'涂料',parameterNo:'1.1',parameterName:'耐候性',limitDesc:'仅限A',note:'变更',sheetName:'能力表',rowNumber:4,stdCode:'GB∕T 123.1-2020'});
  expect(JSON.stringify(p)).not.toContain('机密');expect(JSON.stringify(p)).not.toContain('420000');expect(p.warnings.some(w=>w.row===7&&w.message.includes('不支持'))).toBe(true);
 });
 it('parses multi codes without losing parts/years and canonicalizes typography only',()=>{
  const p=parseTableStandards('GB/T 3810.12-2016ISO 10545-12：1995');expect(p.standards.map(s=>s.key)).toEqual(['GB/T3810.12-2016','ISO10545-12-1995']);expect(p.unsupported).toBe(false);
  expect(canonicalTableStandard(' gb∕t 123.1－2020 ')).toBe('GB/T123.1-2020');expect(parseTableStandards('GB/T 123').standards).toEqual([]);
  expect(parseTableStandards('GB/T 123-2020 附录A').unsupported).toBe(true);
 });
 it('ignores malformed metadata of the real source format',async()=>{
  const J=createRequire(__filename)('jszip');const z=await J.loadAsync(await fixture(['GB 123-2020']));z.file('docProps/core.xml','<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"><lastModifiedBy>bad</lastModifiedBy></cp:coreProperties>');
  expect((await parseNatCmaTable(await z.generateAsync({type:'nodebuffer'}))).rows).toHaveLength(1);
 });
 it('rejects invalid archive, oversized upload and inflated-size lies',async()=>{
  expect(()=>validateTableArchive(Buffer.from('invalid'))).toThrow();expect(()=>validateTableArchive(Buffer.alloc(MAX_TABLE_UPLOAD_BYTES+1))).toThrow();
  const b=await fixture();const index=b.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));b.writeUInt32LE(101*1024*1024,index+24);expect(()=>validateTableArchive(b)).toThrow(/超限/);
  const lie=await fixture();const idx=lie.indexOf(Buffer.from([0x50,0x4b,0x01,0x02]));lie.writeUInt32LE(1,idx+24);expect(()=>validateTableArchive(lie)).toThrow();
 });
 it('rejects unrelated workbooks',async()=>{const w=new ExcelJS.Workbook();w.addWorksheet('other').getCell('A1').value='not a table';await expect(parseNatCmaTable(Buffer.from(await w.xlsx.writeBuffer()))).rejects.toThrow(/未找到/);});
 const real='/vol1/@appshare/Harness/.dsh/attachments/v1/files/6d/6dc9eda6c458c11dfba2d08eef6d4099cb16c47fb3cb250084b78f11f98e33ea/14检验检测能力申请表.xlsx';
 it.skipIf(!existsSync(real))('imports the real approved application-named source without dropping any rows',async()=>{
  const p=await parseNatCmaTable(readFileSync(real));expect(p.rows).toHaveLength(6365);expect(p.rows[0].rowNumber).toBe(4);expect(p.rows.at(-1)?.rowNumber).toBe(6368);expect(p.duplicateCount).toBe(5);expect(p.categoryCount).toBe(19);expect(p.productCount).toBe(435);expect(new Set(p.rows.map(r=>r.stdCode)).size).toBe(1138);expect(p.rows.filter(r=>r.limitDesc).length).toBe(410);expect(p.rows.filter(r=>r.note).length).toBe(1795);
 },30000);
});
describe('independent versioned table SQL service',()=>{
 it('ensures schema, has empty status and never reads or changes historical tables',async()=>{
  const {svc,db}=setup();db.exec("CREATE TABLE nat_cma_abilities(secret TEXT);INSERT INTO nat_cma_abilities VALUES('history')");expect(svc.status()).toEqual({orgName:NAT_CMA_TABLE_ORG_NAME,source:'approved_table',batch:null,batchCount:0});expect(svc.search().total).toBe(0);
  const p=await svc.preview(await fixture(),'能力申请表.xlsx',1);expect(svc.status().batch).toBeNull();const r=svc.confirm(p.previewId,1);expect(r.batch.rowCount).toBe(4);expect((db.prepare('SELECT secret FROM nat_cma_abilities').get() as {secret:string}).secret).toBe('history');expect(db.pragma('integrity_check',{simple:true})).toBe('ok');expect(db.pragma('foreign_key_check')).toEqual([]);
 });
 it('groups links, searches all fields and exactly matches full standards including years',async()=>{
  const {svc}=setup();const p=await svc.preview(await fixture(),'approved.xlsx',1);svc.confirm(p.previewId,1);
  const m=svc.batchMatch(['GB/T123.1-2020','GB/T123.1-2021','GB/T123.1','ISO 16474-2-2013','__proto__']);expect(m['GB/T123.1-2020']).toMatchObject({abilityCount:2,limited:true});expect(m['GB/T123.1-2021'].abilityCount).toBe(0);expect(m['GB/T123.1'].abilityCount).toBe(0);expect(m['ISO 16474-2-2013'].abilityCount).toBe(1);expect(m['__proto__'].abilityCount).toBe(0);
  expect(svc.abilities('GB/T 123.1-2020').entries).toHaveLength(2);for(const q of ['耐候','仅限','变更','材料','涂料','试验','gb/t123.1'])expect(svc.search(q).total).toBeGreaterThan(0);
  expect(svc.search('%').total).toBe(0);expect(svc.search("' OR 1=1 --").total).toBe(0);expect(svc.search('',1,1).items).toHaveLength(1);expect(svc.search('',20,0,'不存在').total).toBe(0);expect(svc.search('未知').items[0].entries[0].stdCode).toBe('未知方法');expect(svc.batchMatch(['未知方法'])['未知方法'].abilityCount).toBe(0);
 });
 it('identical SHA is idempotent; activation and rollback retain previous batches',async()=>{
  const {svc}=setup();const b=await fixture(['GB 1-2020']);const p=await svc.preview(b,'one.xlsx',1);const a=svc.confirm(p.previewId,1,'one');const p2=await svc.preview(await fixture(['GB 2-2021']),'two.xlsx',1);const second=svc.confirm(p2.previewId,1);
  const again=await svc.preview(b,'renamed.xlsx',1);expect(again.existingBatchId).toBe(a.batch.id);expect(svc.confirm(again.previewId,1).alreadyImported).toBe(true);expect(svc.status().batch?.id).toBe(second.batch.id);expect(svc.status().batchCount).toBe(2);
  svc.activate(a.batch.id);expect(svc.batchMatch(['GB 1-2020'])['GB 1-2020'].abilityCount).toBe(1);expect(svc.batchMatch(['GB 2-2021'])['GB 2-2021'].abilityCount).toBe(0);expect(svc.batches().items.filter(b=>b.active)).toHaveLength(1);
 });
 it('failed SQL import rolls back batch, rows and activation and permits retry',async()=>{
  const {svc,db}=setup();const a=await svc.preview(await fixture(['GB 1-2020']),'one.xlsx',1);const first=svc.confirm(a.previewId,1);const p=await svc.preview(await fixture(['GB 2-2020','GB 3-2020']),'two.xlsx',1);
  db.exec("CREATE TRIGGER fail_table_insert BEFORE INSERT ON nat_cma_table_links WHEN NEW.std_key='GB3-2020' BEGIN SELECT RAISE(ABORT,'test failure'); END");expect(()=>svc.confirm(p.previewId,1)).toThrow('test failure');expect(svc.status().batchCount).toBe(1);expect(svc.status().batch?.id).toBe(first.batch.id);expect((db.prepare('SELECT COUNT(*) AS n FROM nat_cma_table_abilities').get() as {n:number}).n).toBe(1);db.exec('DROP TRIGGER fail_table_insert');expect(svc.confirm(p.previewId,1).alreadyImported).toBe(false);
 });
 it('binds preview owner and TTL and caps prepared previews',async()=>{
  let now=1000;const {svc}=setup(()=>now);const b=await fixture();const p=await svc.preview(b,'x.xlsx',1);expect(()=>svc.confirm(p.previewId,2)).toThrow(/不属于/);now+=10*60*1000;expect(()=>svc.confirm(p.previewId,1)).toThrow(/过期/);
  for(let i=0;i<4;i++)await svc.preview(b,'x.xlsx',1);await expect(svc.preview(b,'x.xlsx',1)).rejects.toThrow(/已满/);
 });
 it('does not grant badge matches from unresolved suffixes and marks partial parameters limited',async()=>{
  const {svc}=setup();const b=await fixture(['GB 1-2020 方法A','GB 2-2020']);const J=createRequire(__filename)('jszip');const zip=await J.loadAsync(b);const xml=await zip.file('xl/sharedStrings.xml').async('string');zip.file('xl/sharedStrings.xml',xml.replace('耐候性','部分参数').replace('仅限A',''));const p=await svc.preview(await zip.generateAsync({type:'nodebuffer'}),'partial.xlsx',1);svc.confirm(p.previewId,1);expect(svc.batchMatch(['GB 1-2020'])['GB 1-2020'].abilityCount).toBe(0);expect(svc.search('方法A').total).toBe(1);expect(svc.search('方法A').items[0].exactMatchAvailable).toBe(false);expect(svc.search('方法A').items[0].entries[0].standardWarning).toContain('未完全识别');expect(svc.search('GB2-2020').items[0].exactMatchAvailable).toBe(true);expect(svc.batchMatch(['GB 2-2020'])['GB 2-2020'].limited).toBe(true);
 });
 it('validates standalone service inputs',async()=>{const {svc}=setup();await expect(svc.preview(await fixture(),'bad.xls',1)).rejects.toThrow();expect(()=>svc.activate(0)).toThrow();expect(()=>svc.activate(99)).toThrow();expect(()=>svc.search('',101)).toThrow();expect(()=>svc.batchMatch(Array(501).fill('GB 1-2020'))).toThrow();expect(()=>svc.abilities('')).toThrow();});
});
