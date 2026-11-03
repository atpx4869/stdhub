import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from './app';

async function fixture(year = '2016') {
  const book = new ExcelJS.Workbook();
  const sheet = book.addWorksheet('检验检测能力申请表');
  sheet.getCell('A2').value = '大类序号';
  sheet.getCell('H3').value = '编号（含年号）';
  sheet.addRow([]);
  sheet.getRow(4).values = ['十九','家具','407','塑料家具','407.1','部分参数','塑料家具通用技术条件','GB/T 32487-'+year,'不测：阻燃性能','扩项','不导入姓名','不导入身份证'];
  sheet.getRow(5).values = ['一','空气及材料有害物质','6','家具有害物质','6.1','全部参数','家具中有害物质限量','GB 18584-2024','','变更'];
  return Buffer.from(await book.xlsx.writeBuffer());
}

describe('approved national CMA table API through real app auth and CSRF', () => {
  let app: ReturnType<typeof createApp>;
  let agent: ReturnType<typeof request.agent>;
  let root: string, csrf = '', firstId = 0, firstFile: Buffer;
  const previousPassword = process.env.STDHUB_ADMIN_PASSWORD;
  const prefix = '/api/nat-cma/table';
  beforeAll(async () => {
    process.env.STDHUB_ADMIN_PASSWORD = 'national-cma-test-password';
    root = mkdtempSync(path.join(tmpdir(), 'stdhub-nat-table-api-'));
    mkdirSync(path.join(root, 'data'));
    app = createApp({ baseDir: root, dbPath: path.join(root, 'data/test.db'), startBackgroundJobs: false });
    agent = request.agent(app);
    const response = await agent.post('/api/auth/login').send({ password: 'national-cma-test-password' });
    expect(response.status).toBe(200);
    const cookies = response.headers['set-cookie'] as unknown as string[];
    csrf = decodeURIComponent(cookies.find(s => s.startsWith('bzxz_csrf='))!.split(';')[0].split('=')[1]);
    firstFile = await fixture();
  });
  afterAll(async () => {
    await app.shutdown();
    if (previousPassword === undefined) delete process.env.STDHUB_ADMIN_PASSWORD;
    else process.env.STDHUB_ADMIN_PASSWORD = previousPassword;
    rmSync(root, { recursive: true, force: true });
  });
  it('allows guest reads but forbids management and enforces admin CSRF', async () => {
    const status = await request(app).get(prefix+'/status');
    expect(status.status).toBe(200);
    expect(status.body.data).toMatchObject({ orgName:'湖北省产品质量监督检验研究院', source:'approved_table', batch:null });
    expect((await request(app).post(prefix+'/preview')).status).toBe(403);
    expect((await request(app).post(prefix+'/activate').send({ batchId:1 })).status).toBe(403);
    expect((await agent.post(prefix+'/confirm').send({ previewId:'00000000-0000-4000-8000-000000000000' })).status).toBe(403);
    const old = await agent.post('/api/nat-cma/sync-all').set('X-CSRF-Token',csrf);
    expect(old.status).toBe(503);
  });
  it('previews without changing active data then confirms one approved version', async () => {
    const preview = await agent.post(prefix+'/preview').set('X-CSRF-Token',csrf).attach('file',firstFile,'approved.xlsx');
    expect(preview.status).toBe(200);
    expect(preview.body.data).toMatchObject({ rowCount:2,standardCount:2 });
    expect(JSON.stringify(preview.body.data)).not.toContain('不导入姓名');
    expect(JSON.stringify(preview.body.data)).not.toContain('不导入身份证');
    expect((await request(app).get(prefix+'/status')).body.data.batch).toBeNull();
    const confirm = await agent.post(prefix+'/confirm').set('X-CSRF-Token',csrf).send({ previewId:preview.body.data.previewId,name:'已批准能力 v1' });
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.alreadyImported).toBe(false);
    firstId = confirm.body.data.batch.id;
  });
  it('queries grouped restrictions and returns precise-year read-only matches to guests', async () => {
    const search = await request(app).get(prefix+'/search').query({ q:'32487-2016' });
    expect(search.status).toBe(200);
    expect(search.body.data.total).toBe(1);
    expect(search.body.data.items[0].entries[0]).toMatchObject({ parameterName:'部分参数',limitDesc:'不测：阻燃性能',note:'扩项',rowNumber:4 });
    const matches = await request(app).post(prefix+'/batch-match').send({ stdCodes:['GB/T 32487-2016','GB/T 32487-2025'] });
    expect(matches.status).toBe(200);
    expect(matches.body.data['GB/T 32487-2016']).toMatchObject({ abilityCount:1,limited:true,batchId:firstId });
    expect(matches.body.data['GB/T 32487-2025'].abilityCount).toBe(0);
    const params = await request(app).get(prefix+'/search').query({q:'阻燃性能'});
    expect(params.body.data.total).toBe(1);
  });
  it('rejects malformed files and invalid activation without disturbing active version', async () => {
    const upload = await agent.post(prefix+'/preview').set('X-CSRF-Token',csrf).attach('file',Buffer.from('not an xlsx'),'bad.xlsx');
    expect(upload.status).toBe(400);
    expect((await agent.post(prefix+'/activate').set('X-CSRF-Token',csrf).send({batchId:999999})).status).toBe(404);
    expect((await request(app).get(prefix+'/status')).body.data.batch.id).toBe(firstId);
  });
  it('does not accumulate identical uploads and supports explicit rollback', async () => {
    const upload = async (file:Buffer) => (await agent.post(prefix+'/preview').set('X-CSRF-Token',csrf).attach('file',file,'approved.xlsx')).body.data;
    const confirm = async (id:string) => (await agent.post(prefix+'/confirm').set('X-CSRF-Token',csrf).send({ previewId:id })).body.data;
    const duplicate = await confirm((await upload(firstFile)).previewId);
    expect(duplicate.alreadyImported).toBe(true);
    const second = await confirm((await upload(await fixture('2025'))).previewId);
    expect(second.batch.id).not.toBe(firstId);
    expect((await request(app).get(prefix+'/batches')).body.data.items).toHaveLength(2);
    const result = await agent.post(prefix+'/activate').set('X-CSRF-Token',csrf).send({batchId:firstId});
    expect(result.status).toBe(200);
    const matches = await request(app).post(prefix+'/batch-match').send({stdCodes:['GB/T 32487-2016','GB/T 32487-2025']});
    expect(matches.body.data['GB/T 32487-2016'].abilityCount).toBe(1);
    expect(matches.body.data['GB/T 32487-2025'].abilityCount).toBe(0);
  });
});
