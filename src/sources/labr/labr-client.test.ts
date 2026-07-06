import { describe, expect, it } from 'vitest';

import {
  extractStateJson,
  extractStdCodeFromTitle,
  normalizeLabrExt,
} from './labr-client';

// 不测网络路径（login/recList/preview2/downloadDirect），那些走 #54 labr-service 的
// live integration test。本文件只覆盖 labr-client 的纯函数解析层，回归点：
// 1. extractStateJson 的括号 / 字符串配平不被 JSON 内部的 ) / ] / " 干扰
// 2. extractStdCodeFromTitle 能从 labr 实测 title 形态（| 分隔，全角 ｜，多空格）抽出 stdCode
// 3. normalizeLabrExt 把 labr 的拼写错 xsxl → xlsx

describe('extractStateJson — 抽 SSR 内联 JSON', () => {
  it('抽出 dataList（含嵌套对象 / 引号 / 括号字符）', () => {
    const html = `
      <script>
        state.dataList = JSON.parse(JSON.stringify([{"did":"3100","title":"GB/T 3324-2017|木家具通用技术条件 (新版)","views":189}]))
        state.sum = JSON.parse(JSON.stringify([0, 24, 200]))
      </script>
    `;
    const result = extractStateJson(html, 'dataList') as Array<{ did: string; title: string }>;
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(1);
    expect(result[0].did).toBe('3100');
    // title 里的括号不应让括号配平提前结束
    expect(result[0].title).toBe('GB/T 3324-2017|木家具通用技术条件 (新版)');
  });

  it('抽出 info 对象（嵌套 + null）', () => {
    const html = `
      state.info = JSON.parse(JSON.stringify({"did":14718,"kind":1,"abstract":null,"price":0}))
    `;
    const info = extractStateJson(html, 'info') as { did: number; kind: number; abstract: null };
    expect(info.did).toBe(14718);
    expect(info.kind).toBe(1);
    expect(info.abstract).toBeNull();
  });

  it('抽出 detail（含字符串里的反斜杠 / 中文符号）', () => {
    const html = `
      state.detail = JSON.parse(JSON.stringify({"ddid":5818,"filepath":"filesystem\\/frontend\\/document\\/202502\\/x.docx","filename":"1质量手册（27025新版）.docx"}))
    `;
    const detail = extractStateJson(html, 'detail') as { ddid: number; filename: string };
    expect(detail.ddid).toBe(5818);
    expect(detail.filename).toBe('1质量手册（27025新版）.docx');
  });

  it('找不到 key → null', () => {
    expect(extractStateJson('no state here', 'dataList')).toBeNull();
  });

  it('括号没配平 → null，不抛错', () => {
    const broken = 'state.foo = JSON.parse(JSON.stringify([{"a":1}';
    expect(extractStateJson(broken, 'foo')).toBeNull();
  });

  it('JSON 字面量含 `JSON.parse(JSON.stringify(` 子串也不误配（字符串内部）', () => {
    const html = `state.x = JSON.parse(JSON.stringify({"hint":"call JSON.parse(JSON.stringify(... ) again"}))`;
    const x = extractStateJson(html, 'x') as { hint: string };
    expect(x.hint).toBe('call JSON.parse(JSON.stringify(... ) again');
  });
});

describe('extractStdCodeFromTitle — labr title 形态', () => {
  it('| 分隔（最常见，dataList[0] 实测形态）', () => {
    expect(extractStdCodeFromTitle('GB/T 3324-2017|木家具通用技术条件')).toEqual({
      stdCode: 'GB/T 3324-2017',
      rest: '木家具通用技术条件',
    });
  });

  it('全角 ｜ 分隔', () => {
    expect(extractStdCodeFromTitle('GB 46035-2025｜橡胶塑料机械 通用安全要求')).toEqual({
      stdCode: 'GB 46035-2025',
      rest: '橡胶塑料机械 通用安全要求',
    });
  });

  it('多空格分隔（rec-list 实测形态 "GB 46035-2025  橡胶..."）', () => {
    const r = extractStdCodeFromTitle('GB 46035-2025  橡胶塑料机械  通用安全要求');
    expect(r.stdCode).toBe('GB 46035-2025');
    expect(r.rest).toMatch(/^橡胶/);
  });

  it('ISO 单 token 前缀 + 数字（labr 实测 "ISO 4287-1997|...")', () => {
    expect(extractStdCodeFromTitle('ISO 4287-1997|表面粗糙度')).toEqual({
      stdCode: 'ISO 4287-1997',
      rest: '表面粗糙度',
    });
  });

  it('多 token 前缀（"IEC TR 63282-102-2025"）当前不识别 — 已知 limitation', () => {
    // labr 有这种多 token 头部（IEC TR / GB/T Z 等），规则严格"前缀 (/T)? + \s+ + \d+"
    // 在 IEC 后面遇字母 TR 而不是数字直接失败。labr-service 拿到空 stdCode 时应降级
    // 匹配整段 title（不点徽章但能下文件）。
    expect(extractStdCodeFromTitle('IEC TR 63282-102-2025 LVDC systems')).toEqual({
      stdCode: '',
      rest: 'IEC TR 63282-102-2025 LVDC systems',
    });
  });

  it('GB/T 数字 + 小数（JB/T 4730.5 形态）', () => {
    expect(extractStdCodeFromTitle('JB/T 4730.5-2005|承压设备无损检测')).toEqual({
      stdCode: 'JB/T 4730.5-2005',
      rest: '承压设备无损检测',
    });
  });

  it('DB44/T（地方标准、prefix 含数字）', () => {
    expect(extractStdCodeFromTitle('DB44/T 2107-2018|某省地标')).toEqual({
      stdCode: 'DB44/T 2107-2018',
      rest: '某省地标',
    });
  });

  it('无年份标准号', () => {
    expect(extractStdCodeFromTitle('GB 3324|木质家具')).toEqual({
      stdCode: 'GB 3324',
      rest: '木质家具',
    });
  });

  it('title 不像标准号 → stdCode 空，rest = 原文', () => {
    expect(extractStdCodeFromTitle('质量手册（27025新版）.docx')).toEqual({
      stdCode: '',
      rest: '质量手册（27025新版）.docx',
    });
  });

  it('标准号后无分隔符直连中文（实测 did=14718 形态）', () => {
    // labr did=14718 实测 title：标准号末位 `-2024` 直接连中文，无 | / : / 空白
    // 修前正则要求 `\s*[|｜:：\s]` 必有分隔符 → 抽不出 → 走 LABR-${did} fallback
    expect(extractStdCodeFromTitle('GB/T 35607-2024绿色产品评价 家具')).toEqual({
      stdCode: 'GB/T 35607-2024',
      rest: '绿色产品评价 家具',
    });
  });

  it('整段就是标准号（无 rest）', () => {
    expect(extractStdCodeFromTitle('GB/T 3324-2017')).toEqual({
      stdCode: 'GB/T 3324-2017',
      rest: '',
    });
  });
});

describe('normalizeLabrExt — labr ext 别名表', () => {
  it('xsxl → xlsx（labr 自己拼错了）', () => {
    expect(normalizeLabrExt('xsxl')).toBe('xlsx');
  });

  it('大小写归一', () => {
    expect(normalizeLabrExt('PDF')).toBe('pdf');
    expect(normalizeLabrExt('Docx')).toBe('docx');
  });

  it('未识别 ext 原样小写', () => {
    expect(normalizeLabrExt('zip')).toBe('zip');
  });

  it('空字符串容错', () => {
    expect(normalizeLabrExt('')).toBe('');
  });
});
