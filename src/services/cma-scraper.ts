import * as cheerio from 'cheerio';
import { pooledFetch } from '../shared/http';

const CMA_BASE = 'http://223.75.53.51:81';

export interface CmaSearchResult {
  publicDetailId: string;
  licSysId: string;
  sysName: string;
  licHolderCode: string;
  licNumber: string;
  licDate: string;
  licValidTimeBegin: string;
  licValidTimeEnd: string;
  licState: string;
  addr: string;
  areaName: string;
  majorCategory: string;
}

export interface CmaDetail {
  publicDetailId: string;
  licSysId: string;
  sysName: string;
  sysZzjgdm: string;
  certificateNumber: string;
  sysGjsjzx: string;
  majorCategory: string;
  businessDepartment: string;
  registerAddress: string;
  sysFzrName: string;
  sysLxrName: string;
  leRep: string;
  techDirectorName: string;
  licNumber: string;
  licDate: string;
  licValidTimeBegin: string;
  licValidTimeEnd: string;
  licUnitname: string;
  licHolder: string;
  addr: string;
  certStatus: string;
  areaName: string;
  updateTime: number;
}

export interface CmaCapability {
  jcnlId: string;
  type: string;
  cpNumber: string;
  cpName: string;
  yjbzNameNumber: string;
  yjbzNumber: string;
  xzfw: string;
  sm: string;
  parentNo: string;
  parentName: string;
  placeName: string;
  certId: string;
  updateTime: number;
}

export interface CmaSearchOptions {
  orgName?: string;
  standard?: string;
  category?: string;
  areaCode?: string;
  licState?: '1' | '2' | '';
  page?: number;
}

export class CmaScraper {
  async search(params: CmaSearchOptions): Promise<CmaSearchResult[]> {
    const html = await this.fetchListHtml(params);
    return this.parseSearchResults(html);
  }

  async searchLabsByName(orgName: string, licState: '1' | '2' | '' = '1'): Promise<CmaSearchResult[]> {
    return this.search({ orgName, licState });
  }

  async searchByStandard(standard: string, licState: '1' | '2' | '' = '1'): Promise<CmaSearchResult[]> {
    return this.search({ standard, licState });
  }

  async getDetail(publicDetailId: string): Promise<CmaDetail> {
    const html = await this.fetchDetailHtml(publicDetailId);
    return this.parseDetail(html, publicDetailId);
  }

  async getCapabilities(
    publicDetailId: string,
    onProgress?: (fetched: number, total: number) => void,
  ): Promise<CmaCapability[]> {
    const html = await this.fetchDetailHtml(publicDetailId);
    const detail = this.parseDetail(html, publicDetailId);
    const capabilities = this.parseCapabilities(html, detail.certificateNumber);
    onProgress?.(capabilities.length, capabilities.length);
    return capabilities;
  }

  async scrapeFull(
    publicDetailId: string,
    onProgress?: (stage: string, fetched: number, total: number) => void,
  ): Promise<{ detail: CmaDetail; capabilities: CmaCapability[] }> {
    onProgress?.('detail', 0, 0);
    const html = await this.fetchDetailHtml(publicDetailId);
    const detail = this.parseDetail(html, publicDetailId);
    onProgress?.('capabilities', 0, 0);
    const capabilities = this.parseCapabilities(html, detail.certificateNumber);
    onProgress?.('capabilities', capabilities.length, capabilities.length);
    return { detail, capabilities };
  }

  async checkForUpdate(publicDetailId: string, cachedLicDate: string): Promise<{
    hasUpdate: boolean;
    currentLicDate: string;
    licSysId: string;
  }> {
    const detail = await this.getDetail(publicDetailId);
    return {
      hasUpdate: detail.licDate !== cachedLicDate,
      currentLicDate: detail.licDate,
      licSysId: publicDetailId,
    };
  }

  async fetchListHtml(params: CmaSearchOptions): Promise<string> {
    const qs = new URLSearchParams();
    if (params.page && params.page > 1) qs.set('page', String(params.page));
    qs.set('laboraname', params.orgName ?? '');
    qs.set('licState', params.licState ?? '1');
    qs.set('cplb', params.category ?? '');
    qs.set('tpro', '');
    qs.set('tp', params.standard ?? '');
    if (params.areaCode) qs.append('xzqh', params.areaCode);

    const resp = await pooledFetch(`${CMA_BASE}/socialPublicController.do?right&${qs}`, {
      timeoutMs: 20_000,
      retries: 2,
    });
    if (!resp.ok) throw new Error(`CMA public search failed: ${resp.status}`);
    return resp.text();
  }

  async fetchDetailHtml(publicDetailId: string): Promise<string> {
    const qs = new URLSearchParams({
      fl: '1',
      id: publicDetailId,
      tp: '',
      cplb: '',
      tpro: '',
    });
    const resp = await pooledFetch(`${CMA_BASE}/socialPublicController.do?seelabinfo&${qs}`, {
      timeoutMs: 25_000,
      retries: 2,
    });
    if (!resp.ok) throw new Error(`CMA public detail failed: ${resp.status}`);
    return resp.text();
  }

  parseSearchResults(html: string): CmaSearchResult[] {
    const $ = cheerio.load(html);
    const rows: CmaSearchResult[] = [];

    $('#content tr').each((_idx, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < 6) return;
      const onclick = $(cells[5]).find('a').attr('onclick') ?? '';
      const publicDetailId = onclick.match(/seeMore\('([^']+)'\)/)?.[1] ?? '';
      if (!publicDetailId) return;

      const name = cleanText($(cells[1]).text());
      const areaName = cleanText($(cells[2]).text());
      const majorCategory = cleanText($(cells[3]).text());
      const licState = cleanText($(cells[4]).text());

      rows.push({
        publicDetailId,
        licSysId: publicDetailId,
        sysName: name,
        licHolderCode: '',
        licNumber: '',
        licDate: '',
        licValidTimeBegin: '',
        licValidTimeEnd: '',
        licState,
        addr: '',
        areaName,
        majorCategory,
      });
    });

    return rows;
  }

  parseDetail(html: string, publicDetailId: string): CmaDetail {
    const $ = cheerio.load(html);
    const spanText = (id: string) => cleanText($(`#${id}`).text());
    const certNumber = findValueAfterLabel($, '证书编号');

    return {
      publicDetailId,
      licSysId: publicDetailId,
      sysName: spanText('LaboraName'),
      sysZzjgdm: spanText('lbljgdm'),
      certificateNumber: certNumber,
      sysGjsjzx: spanText('zgglzName'),
      majorCategory: spanText('Label2'),
      businessDepartment: '',
      registerAddress: spanText('LaboraAddress'),
      sysFzrName: spanText('zgglzName'),
      sysLxrName: spanText('ContactMen'),
      leRep: spanText('Header'),
      techDirectorName: '',
      licNumber: certNumber,
      licDate: normalizeDate(findValueAfterLabel($, '证书颁发时间')),
      licValidTimeBegin: normalizeDate(findValueAfterLabel($, '证书有效期起始时间')),
      licValidTimeEnd: normalizeDate(findValueAfterLabel($, '证书有效期截止时间')),
      licUnitname: spanText('LaboraName'),
      licHolder: spanText('LaboraName'),
      addr: spanText('LaboraAddress'),
      certStatus: cleanText(findValueAfterLabel($, '证书状态')),
      areaName: spanText('xzqh'),
      updateTime: 0,
    };
  }

  parseCapabilities(html: string, certId: string): CmaCapability[] {
    const $ = cheerio.load(html);
    const table = $('table').filter((_idx, el) => {
      const directRows = directTableRows($, el);
      const text = cleanText(directRows.slice(0, 2).text());
      return directRows.length > 1
        && text.includes('产品/项目/参数')
        && text.includes('标准(方法)名称')
        && text.includes('限制范围');
    }).last();

    const rows: CmaCapability[] = [];
    directTableRows($, table.get(0)).each((_idx, tr) => {
      const cells = $(tr).find('td');
      if (cells.length < 7) return;
      const seq = cleanText($(cells[0]).text());
      if (!/^\d+$/.test(seq)) return;

      const cpNumber = cleanText($(cells[1]).text());
      const parentName = cleanText($(cells[2]).text());
      const cpName = cleanText($(cells[3]).text());
      const standardName = cleanText($(cells[4]).text());
      const stdCode = cleanText($(cells[5]).text());
      const limitDesc = cleanText($(cells[6]).text());

      rows.push({
        jcnlId: `${certId || 'CMA'}-${seq}`,
        type: parentName,
        cpNumber,
        cpName,
        yjbzNameNumber: standardName,
        yjbzNumber: stdCode === '暂无' ? '' : stdCode,
        xzfw: limitDesc,
        sm: '',
        parentNo: cpNumber,
        parentName,
        placeName: '',
        certId,
        updateTime: 0,
      });
    });

    return rows;
  }
}

function directTableRows($: cheerio.CheerioAPI, table: unknown): cheerio.Cheerio<any> {
  if (!table) return cheerio.load('')('tr');
  const node = table as any;
  const directBodyRows = $(node).children('tbody').children('tr');
  return directBodyRows.length ? directBodyRows : $(node).children('tr');
}

function findValueAfterLabel($: cheerio.CheerioAPI, label: string): string {
  let value = '';
  $('td').each((_idx, td) => {
    if (value) return;
    const text = cleanText($(td).text());
    if (!text.startsWith(label)) return;
    const next = $(td).nextAll('td').filter((_i, el) => cleanText($(el).text()).length > 0).first();
    value = cleanText(next.text());
  });
  return value;
}

function cleanText(value: string): string {
  return value
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[:：\s]+|[:：\s]+$/g, '')
    .trim();
}

function normalizeDate(value: string): string {
  const text = cleanText(value);
  const m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/);
  if (!m) return text;
  return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
}
