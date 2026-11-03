import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalTableStandard, parseNatCmaTable, NAT_CMA_TABLE_ORG_NAME, type ParsedTable, type ParsedTableRow } from './nat-cma-table-parser';
export { NAT_CMA_TABLE_ORG_NAME } from './nat-cma-table-parser';
export interface NatCmaTableBatch { id: number; name: string; filename: string; importedAt: string; rowCount: number; standardCount: number }
export interface NatCmaTableEntry extends Omit<ParsedTableRow, 'standards' | 'standardParseWarning'> { id: number; standardWarning: string | null }
export interface NatCmaTableMatch { abilityCount: number; limited: boolean; summary: string; batchId: number | null }
interface Prepared { owner: number; expires: number; filename: string; sha256: string; parsed: ParsedTable }
export class NatCmaTableError extends Error { constructor(message: string, public readonly status = 400) { super(message); } }
const BATCH_COLUMNS = 'id,name,filename,imported_at AS importedAt,row_count AS rowCount,standard_count AS standardCount';
const ENTRY_COLUMNS = 'a.id,a.major_no AS majorNo,a.major_category AS majorCategory,a.category_no AS categoryNo,a.category,a.parameter_no AS parameterNo,a.parameter_name AS parameterName,a.std_name AS stdName,a.std_code AS stdCode,a.limit_desc AS limitDesc,a.note,a.row_number AS rowNumber,a.sheet_name AS sheetName,CASE WHEN l.matchable=0 THEN \'标准编号未完全识别，不参与自动精确匹配，请核对原文\' ELSE NULL END AS standardWarning';
export class NatCmaTableService {
  private readonly previews = new Map<string, Prepared>();
  private pendingPreviews = 0;
  constructor(private readonly db: Database.Database, private readonly now: () => number = Date.now) { this.ensureSchema(); }
  private ensureSchema(): void {
    this.db.exec(      'CREATE TABLE IF NOT EXISTS nat_cma_table_batches (id INTEGER PRIMARY KEY,name TEXT NOT NULL,filename TEXT NOT NULL,sha256 TEXT NOT NULL UNIQUE,imported_at TEXT NOT NULL,row_count INTEGER NOT NULL,standard_count INTEGER NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS nat_cma_table_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1),batch_id INTEGER NOT NULL REFERENCES nat_cma_table_batches(id));' +
      'CREATE TABLE IF NOT EXISTS nat_cma_table_abilities (id INTEGER PRIMARY KEY,batch_id INTEGER NOT NULL REFERENCES nat_cma_table_batches(id),major_no TEXT NOT NULL,major_category TEXT NOT NULL,category_no TEXT NOT NULL,category TEXT NOT NULL,parameter_no TEXT NOT NULL,parameter_name TEXT NOT NULL,std_name TEXT NOT NULL,std_code TEXT NOT NULL,limit_desc TEXT NOT NULL,note TEXT NOT NULL,row_number INTEGER NOT NULL,sheet_name TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS nat_cma_table_links (ability_id INTEGER NOT NULL REFERENCES nat_cma_table_abilities(id),batch_id INTEGER NOT NULL REFERENCES nat_cma_table_batches(id),std_key TEXT NOT NULL,std_code TEXT NOT NULL,matchable INTEGER NOT NULL,PRIMARY KEY(ability_id,std_key));' +
      'CREATE INDEX IF NOT EXISTS idx_nat_cma_table_links_lookup ON nat_cma_table_links(batch_id,std_key,matchable);' +
      'CREATE INDEX IF NOT EXISTS idx_nat_cma_table_abilities_batch ON nat_cma_table_abilities(batch_id);');
  }
  private activeBatch(): NatCmaTableBatch | null { return this.db.prepare('SELECT '+BATCH_COLUMNS+' FROM nat_cma_table_batches WHERE id=(SELECT batch_id FROM nat_cma_table_state WHERE singleton=1)').get() as NatCmaTableBatch | undefined ?? null; }
  status() { return { orgName:NAT_CMA_TABLE_ORG_NAME,source:'approved_table' as const,batch:this.activeBatch(),batchCount:(this.db.prepare('SELECT COUNT(*) AS n FROM nat_cma_table_batches').get() as {n:number}).n }; }
  batches() { const active = this.activeBatch()?.id; return {items:(this.db.prepare('SELECT '+BATCH_COLUMNS+' FROM nat_cma_table_batches ORDER BY id DESC').all() as NatCmaTableBatch[]).map(b=>({...b,active:b.id===active}))}; }
  private purge(): void { for (const [id,p] of this.previews) if (p.expires <= this.now()) this.previews.delete(id); }
  async preview(buffer: Buffer, filename: string, owner: number) {
    this.purge();
    if (!Number.isSafeInteger(owner) || owner <= 0) throw new NatCmaTableError('预览需要已认证管理员',401);
    if (typeof filename !== 'string' || filename.length > 255 || !/\.xlsx$/i.test(filename) || /[\x00-\x1f\/\\]/.test(filename)) throw new NatCmaTableError('只支持 XLSX 文件名');
    if (this.previews.size + this.pendingPreviews >= 4) throw new NatCmaTableError('待确认预览已满，请稍后再试',429);
    this.pendingPreviews++;
    try {
      const parsed = await parseNatCmaTable(buffer);
      const sha256 = createHash('sha256').update(buffer).digest('hex'), previewId = randomUUID();
      const existing = this.db.prepare('SELECT id FROM nat_cma_table_batches WHERE sha256=?').get(sha256) as {id:number}|undefined;
      this.previews.set(previewId,{owner,expires:this.now()+10*60*1000,filename,sha256,parsed});
      return {previewId,filename,sha256,rowCount:parsed.rows.length,standardCount:parsed.standardCount,categoryCount:parsed.categoryCount,productCount:parsed.productCount,duplicateCount:parsed.duplicateCount,warningCount:parsed.warnings.length,warnings:parsed.warnings,samples:parsed.rows.slice(0,10),...(existing ? {existingBatchId:existing.id} : {})};
    } finally { this.pendingPreviews--; }
  }
  confirm(previewId: string, owner: number, name?: string): {batch:NatCmaTableBatch;alreadyImported:boolean} {
    this.purge();
    if (typeof previewId !== 'string' || previewId.length > 100 || (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 120))) throw new NatCmaTableError('预览ID或批次名称非法');
    const p = this.previews.get(previewId);
    if (!p || p.owner !== owner) throw new NatCmaTableError('预览不存在、已过期或不属于当前用户',404);
    const result = this.db.transaction(() => {
      const existing = this.db.prepare('SELECT '+BATCH_COLUMNS+' FROM nat_cma_table_batches WHERE sha256=?').get(p.sha256) as NatCmaTableBatch|undefined;
      // Identical imports are no-ops, including the active version (rollback must be explicit).
      if (existing) return {batch:existing,alreadyImported:true};
      const id = Number(this.db.prepare('INSERT INTO nat_cma_table_batches(name,filename,sha256,imported_at,row_count,standard_count) VALUES(?,?,?,?,?,?)').run(name?.trim() || p.filename.replace(/\.xlsx$/i,''),p.filename,p.sha256,new Date(this.now()).toISOString(),p.parsed.rows.length,p.parsed.standardCount).lastInsertRowid);
      const insert = this.db.prepare('INSERT INTO nat_cma_table_abilities(batch_id,major_no,major_category,category_no,category,parameter_no,parameter_name,std_name,std_code,limit_desc,note,row_number,sheet_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)');
      const link = this.db.prepare('INSERT INTO nat_cma_table_links(ability_id,batch_id,std_key,std_code,matchable) VALUES(?,?,?,?,?)');
      for (const r of p.parsed.rows) {
        const aid = Number(insert.run(id,r.majorNo,r.majorCategory,r.categoryNo,r.category,r.parameterNo,r.parameterName,r.stdName,r.stdCode,r.limitDesc,r.note,r.rowNumber,r.sheetName).lastInsertRowid);
        for (const s of r.standards) link.run(aid,id,s.key,s.code,r.standardParseWarning ? 0 : 1);
        if (!r.standards.length) link.run(aid,id,'RAW:'+r.stdCode,r.stdCode,0);
      }
      return {batch:this.activate(id).batch,alreadyImported:false};
    })();
    this.previews.delete(previewId); return result;
  }
  activate(batchId: number): {batch:NatCmaTableBatch} {
    if (!Number.isSafeInteger(batchId) || batchId < 1) throw new NatCmaTableError('批次ID非法');
    return this.db.transaction(() => {
      const batch = this.db.prepare('SELECT '+BATCH_COLUMNS+' FROM nat_cma_table_batches WHERE id=?').get(batchId) as NatCmaTableBatch|undefined;
      if (!batch) throw new NatCmaTableError('批次不存在',404);
      this.db.prepare('INSERT INTO nat_cma_table_state(singleton,batch_id) VALUES(1,?) ON CONFLICT(singleton) DO UPDATE SET batch_id=excluded.batch_id').run(batchId); return {batch};
    })();
  }
  abilities(stdCode: string) {
    if (typeof stdCode !== 'string' || !stdCode.trim() || stdCode.length > 300) throw new NatCmaTableError('标准号非法');
    const batch = this.activeBatch();
    const entries = batch ? this.db.prepare('SELECT '+ENTRY_COLUMNS+' FROM nat_cma_table_abilities a JOIN nat_cma_table_links l ON l.ability_id=a.id WHERE l.batch_id=? AND l.std_key=? AND l.matchable=1 ORDER BY a.id').all(batch.id,canonicalTableStandard(stdCode)) as NatCmaTableEntry[] : [];
    return {entries,batch,orgName:NAT_CMA_TABLE_ORG_NAME};
  }
  batchMatch(stdCodes: string[]): Record<string,NatCmaTableMatch> {
    if (!Array.isArray(stdCodes) || stdCodes.length > 500 || stdCodes.some(s=>typeof s !== 'string' || !s.trim() || s.length > 300)) throw new NatCmaTableError('标准号列表非法（最多500项）');
    const result: Record<string,NatCmaTableMatch> = Object.create(null);
    const batch = this.activeBatch();
    const query = this.db.prepare("SELECT COUNT(*) AS n,MAX(CASE WHEN trim(a.limit_desc)<>'' OR a.parameter_name LIKE '%部分参数%' THEN 1 ELSE 0 END) AS limited FROM nat_cma_table_links l JOIN nat_cma_table_abilities a ON a.id=l.ability_id WHERE l.batch_id=? AND l.std_key=? AND l.matchable=1");
    for (const code of stdCodes) {
      const row = batch ? query.get(batch.id,canonicalTableStandard(code)) as {n:number;limited:number|null} : {n:0,limited:0};
      result[code]={abilityCount:row.n,limited:!!row.limited,summary:row.n ? row.n+'项能力'+(row.limited ? '（有限制，须查看明细）' : '（须查看参数明细）') : '本表未收录该完整标准号及年版',batchId:batch?.id ?? null};
    }
    return result;
  }
  search(q = '', limit = 20, offset = 0, category?: string) {
    if (typeof q !== 'string' || q.length > 300 || !Number.isSafeInteger(limit) || limit<1 || limit>100 || !Number.isSafeInteger(offset) || offset<0 || offset>1000000 || (category !== undefined && (typeof category !== 'string' || category.length > 300))) throw new NatCmaTableError('查询参数非法');
    const batch = this.activeBatch();
    if (!batch) return {total:0,items:[],batch,orgName:NAT_CMA_TABLE_ORG_NAME};
    const params: (string|number)[]=[batch.id];
    let where = 'l.batch_id=?';
    if (q.trim()) {
      const escaped = q.trim().replace(/[\\%_]/g,'\\$&');
      const key = canonicalTableStandard(q.trim()).replace(/[\\%_]/g,'\\$&');
      where += " AND (l.std_key LIKE ? ESCAPE '\\' OR a.std_code LIKE ? ESCAPE '\\' OR a.std_name LIKE ? ESCAPE '\\' OR a.major_category LIKE ? ESCAPE '\\' OR a.category LIKE ? ESCAPE '\\' OR a.parameter_name LIKE ? ESCAPE '\\' OR a.parameter_no LIKE ? ESCAPE '\\' OR a.limit_desc LIKE ? ESCAPE '\\' OR a.note LIKE ? ESCAPE '\\')";
      params.push('%'+key+'%',...Array(8).fill('%'+escaped+'%'));
    }
    if (category) { where += ' AND (a.major_category=? OR a.category=?)'; params.push(category,category); }
    const from = ' FROM nat_cma_table_links l JOIN nat_cma_table_abilities a ON a.id=l.ability_id WHERE '+where;
    const total = (this.db.prepare('SELECT COUNT(DISTINCT l.std_key) AS n'+from).get(...params) as {n:number}).n;
    const groups = this.db.prepare('SELECT l.std_key AS key,MIN(l.std_code) AS stdCode,MIN(a.std_name) AS stdName'+from+' GROUP BY l.std_key ORDER BY stdCode LIMIT ? OFFSET ?').all(...params,limit,offset) as {key:string;stdCode:string;stdName:string}[];
    // Include every ability of a matched standard, not only the keyword-matching subset.
    const entriesQuery = this.db.prepare('SELECT '+ENTRY_COLUMNS+' FROM nat_cma_table_abilities a JOIN nat_cma_table_links l ON a.id=l.ability_id WHERE l.batch_id=? AND l.std_key=? ORDER BY a.id');
    const items = groups.map(g=>{const entries=entriesQuery.all(batch.id,g.key) as NatCmaTableEntry[];return {stdCode:g.stdCode,stdName:g.stdName,abilityCount:entries.length,exactMatchAvailable:entries.some(e=>!e.standardWarning),entries};});
    return {total,items,batch,orgName:NAT_CMA_TABLE_ORG_NAME};
  }
}
