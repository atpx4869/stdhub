import BetterSqlite3 from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { QualificationService, buildFuzzyLikePattern } from './qualification-service';
import { extractBaseCode, extractFullCode, cleanStdCode } from '../shared/std-code';

describe('extractBaseCode', () => {
  it('strips type designator and year suffix on clean input', () => {
    expect(extractBaseCode('GB/T 23440-2009')).toBe('GB23440');
  });

  it('handles stray space before the year dash (CNAS scraper variant)', () => {
    // Real-world: CNAS DB stores 'GB/T 3325 -2024'.
    expect(extractBaseCode('GB/T 3325 -2024')).toBe('GB3325');
  });

  it('handles trailing whitespace after the year', () => {
    expect(extractBaseCode('GB/T 3325-2024 ')).toBe('GB3325');
  });

  it('produces the same base for clean and stray-space variants (cross-source match)', () => {
    expect(extractBaseCode('GB/T 3325-2024')).toBe(extractBaseCode('GB/T 3325 -2024'));
  });

  it('strips type designator even when no whitespace follows (regression: lookahead bug)', () => {
    // Previous regex used (?=\s) lookahead and would leave the /T in place for clean variants,
    // so 'GB/T 3325-2024' became 'GB/T3325' instead of 'GB3325'.
    expect(extractBaseCode('GB/T 3325-2024')).toBe('GB3325');
  });

  it('handles type designators other than T', () => {
    expect(extractBaseCode('GBZ/T 188-2014')).toBe('GBZ188');
    expect(extractBaseCode('YY/T 0316-2016')).toBe('YY0316');
  });

  it('passes through codes without type designator', () => {
    expect(extractBaseCode('GB 5749-2022')).toBe('GB5749');
  });

  it('uppercases lowercase input', () => {
    expect(extractBaseCode('gb/t 3325-2024')).toBe('GB3325');
  });

  it('handles full-width digits / letters / punctuation (Excel autocorrect, copy-paste)', () => {
    // 用户从 Word/Excel 复制可能带全角，CNAS 站点偶发把 '-' 渲染成全角破折号
    expect(extractBaseCode('ＧＢ／Ｔ ３３２５－２０２４')).toBe('GB3325');
    expect(extractBaseCode('GB/T 3325－2024')).toBe('GB3325'); // 全角破折号
    expect(extractBaseCode('GB/T　3325-2024')).toBe('GB3325'); // 全角空格
  });

  it('handles ISO colon year separator', () => {
    // 国际标准号常见写法 'ISO 4287:1997' —— 冒号也是年份分隔
    expect(extractBaseCode('ISO 4287:1997')).toBe('ISO4287');
  });

  it('handles no-space variant (GB/T3325-2024) — collapses to same base', () => {
    // 老正则 /\/[A-Z]+/gi 在无空格变体上会把 '/T3325' 整段当 type-designator 删空
    // 新正则用 lookahead 限定 '/T' 后必须接数字/空白/结尾才剥
    expect(extractBaseCode('GB/T3325-2024')).toBe('GB3325');
    expect(extractBaseCode('GB/T3325-2024')).toBe(extractBaseCode('GB/T 3325-2024'));
  });

  it('handles revision suffix (e.g. 2010A) on year', () => {
    // GB/T 3836-2010A 真实存在；年份后缀是 4 位数字 + 可选 1 字母
    expect(extractBaseCode('GB/T 3836-2010A')).toBe('GB3836');
  });
});

describe('extractFullCode', () => {
  it('preserves year while normalizing prefix and whitespace', () => {
    expect(extractFullCode('GB/T 3325-2024')).toBe('GB3325-2024');
    expect(extractFullCode('GB/T 3325 -2024')).toBe('GB3325-2024');
    expect(extractFullCode('GB/T3325-2024')).toBe('GB3325-2024');
    expect(extractFullCode('gb/t 3325-2024')).toBe('GB3325-2024');
  });

  it('cross-source clean and dirty variants produce identical full code (precise match enabler)', () => {
    // CNAS 抓出来 'GB/T 3325 -2024'、CMA 抓出来 'GB/T 3325-2024' —— 两个 full code 必须相等，
    // 这样 Step 2-3 把 std_code_norm 落库后可以走索引等值查询
    expect(extractFullCode('GB/T 3325 -2024')).toBe(extractFullCode('GB/T 3325-2024'));
  });

  it('passes through codes without year (legacy std without revision)', () => {
    expect(extractFullCode('JB 4730')).toBe('JB4730');
  });

  it('ISO colon variant becomes dash variant for storage', () => {
    expect(extractFullCode('ISO 4287:1997')).toBe('ISO4287-1997');
  });

  it('strips clause/appendix/section suffixes after the year (year is the terminator)', () => {
    // 年份是天然终止符，年份后挂的条款/附录/章节都是引用修饰，应整体丢弃 → 同标准的不同条款归同号
    expect(extractFullCode('GB/T 24977-2024第8.3.1.3条')).toBe('GB24977-2024');
    expect(extractFullCode('GB/T 24977-2024第8.6.3条')).toBe('GB24977-2024');
    expect(extractFullCode('GB 26753-2011 4.2条')).toBe('GB26753-2011');
    expect(extractFullCode('GB 20950-2020 附录A')).toBe('GB20950-2020');
    expect(extractFullCode('GB 20950-2020 附录B')).toBe('GB20950-2020');
    // 同一标准的多条款必须归一为同一个 full code（去重聚合的前提）
    expect(extractFullCode('GB 26753-2011 4.2条')).toBe(extractFullCode('GB 26753-2011 4.9条'));
  });

  it('strips full/half-width question mark noise (OCR/scrape garbage)', () => {
    expect(extractFullCode('？QB/T？4566-2025')).toBe('QB4566-2025');
    expect(extractFullCode('？QB/T？4566-2025')).toBe(extractFullCode('QB/T 4566-2025'));
  });
});

describe('cleanStdCode', () => {
  it('collapses whitespace around year-dash (the CNAS scraper dirty case)', () => {
    // 真实数据：CNAS 抓出来 'GB/T 3325 -2024'，子串 LIKE '%3325-%' 因为中间空格漏命中
    expect(cleanStdCode('GB/T 3325 -2024')).toBe('GB/T 3325-2024');
    expect(cleanStdCode('GB/T 3325- 2024')).toBe('GB/T 3325-2024');
    expect(cleanStdCode('GB/T 3325 - 2024')).toBe('GB/T 3325-2024');
  });

  it('preserves prefix capitalization and slash (does not normalize the prefix)', () => {
    // cleanStdCode 跟 extractFullCode 不同 —— 不大写、不删 '/T'，只是清洗空白
    // 这样 DB 里的 std_code 字段保留可读形态供 UI 回显
    expect(cleanStdCode('GB/T 3325-2024')).toBe('GB/T 3325-2024');
    expect(cleanStdCode('gb/t 3325-2024')).toBe('gb/t 3325-2024');
  });

  it('folds multiple internal spaces', () => {
    expect(cleanStdCode('GB/T  3325-2024')).toBe('GB/T 3325-2024');
  });

  it('trims leading/trailing whitespace', () => {
    expect(cleanStdCode('  GB/T 3325-2024  ')).toBe('GB/T 3325-2024');
  });

  it('handles revision suffix (year + letter)', () => {
    expect(cleanStdCode('GB/T 3836 -2010A')).toBe('GB/T 3836-2010A');
  });

  it('is idempotent (running twice produces the same result)', () => {
    // db.ts::fixupDirtyStdCodes 用 `cleaned !== std_code` 做 dirty 判定，幂等是必要前提
    const cleaned = cleanStdCode('GB/T 3325 -2024');
    expect(cleanStdCode(cleaned)).toBe(cleaned);
  });
});

describe('buildFuzzyLikePattern', () => {
  it('splits clean base into prefix%digits% (the core selectivity boost)', () => {
    // 'GB/T 3325-2024' → base 'GB3325' → 'GB%3325%'
    // CNAS 表里 GB 前缀有几万条，加上 3325 数字过滤就收敛到几十条 —— LIMIT 截断不再丢命中行。
    expect(buildFuzzyLikePattern('GB3325')).toBe('GB%3325%');
  });

  it('handles multi-letter prefixes (GBZ, YY, etc.)', () => {
    expect(buildFuzzyLikePattern('GBZ188')).toBe('GBZ%188%');
    expect(buildFuzzyLikePattern('YY0316')).toBe('YY%0316%');
  });

  it('falls back to prefix-only LIKE when base has no digit tail', () => {
    expect(buildFuzzyLikePattern('GB')).toBe('GB%');
  });

  it('returns null for non-letter prefix (regex guard)', () => {
    expect(buildFuzzyLikePattern('123ABC')).toBeNull();
    expect(buildFuzzyLikePattern('')).toBeNull();
  });

  it('returns null when prefix exceeds the 8-char safety cap', () => {
    // 防止恶意/异常输入把 LIKE prefix 撑大、变成全表扫描的 DoS 向量
    expect(buildFuzzyLikePattern('ABCDEFGHI123')).toBeNull();
  });

  it('strips SQL wildcard characters from the digit tail', () => {
    // base 通常已经经过 extractBaseCode 清洗，但这里再做一道防线 —— 万一上游漏了
    // % / _ 不会被原样拼进 LIKE 扩成全表扫描
    expect(buildFuzzyLikePattern('GB33%25')).toBe('GB%3325%');
    expect(buildFuzzyLikePattern('GB33_25')).toBe('GB%3325%');
  });

  it('caps the digit tail to 16 characters', () => {
    const longTail = '12345678901234567890';
    const result = buildFuzzyLikePattern(`GB${longTail}`);
    expect(result).toBe('GB%1234567890123456%');
  });
});

// Helper: tiny in-memory schema covering only what queryByStdCodes touches.
// We don't need the full migration here — just the SELECT/WHERE surface.
// Step 2-3 加了 std_code_norm / std_code_base 归一化列，所以测试 schema 也要带上。
function makeTestDb() {
  const db = new BetterSqlite3(':memory:');
  db.exec(`
    CREATE TABLE cnas_qualifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_no TEXT, std_code TEXT, std_code_norm TEXT, std_code_base TEXT, std_name TEXT,
      effective_date TEXT, expiry_date TEXT, category TEXT,
      test_object TEXT, test_param TEXT, test_standard TEXT, limit_desc TEXT
    );
    CREATE TABLE cnas_labs (lab_no TEXT, lab_name TEXT);
    CREATE TABLE cma_qualifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cert_number TEXT, std_code TEXT, std_code_norm TEXT, std_code_base TEXT, std_name TEXT,
      effective_date TEXT, expiry_date TEXT, category TEXT,
      test_item TEXT, test_standard TEXT, limit_desc TEXT
    );
    CREATE TABLE cma_labs (cert_number TEXT, lab_name TEXT);
    CREATE TABLE qualification_lab_links (
      display_name TEXT, cnas_lab_no TEXT, cma_cert_number TEXT
    );
  `);
  return db;
}

describe('queryByStdCodes (Step 2-3: index-based exact match, strict same-year)', () => {
  it('finds GB/T 3325-2024 across stray-whitespace variant via std_code_base index', () => {
    // 老回归 case 升级：原来用 800 行 GB 噪音测 LIKE+LIMIT 截断；
    // 新算法用 std_code_base 索引等值匹配，根本不用 LIMIT 兜底，但回归 case 留着确保
    // 行为不变（CNAS 脏空格变体 'GB/T 3325 -2024' 仍能匹到用户搜的 'GB/T 3325-2024'）
    const db = makeTestDb();
    db.prepare("INSERT INTO cnas_labs (lab_no, lab_name) VALUES ('LAB001', 'Test Lab')").run();
    const insertNoise = db.prepare(`
      INSERT INTO cnas_qualifications (lab_no, std_code, std_code_norm, std_code_base, std_name, effective_date, expiry_date, category, test_object, test_param, test_standard, limit_desc)
      VALUES ('LAB001', ?, ?, ?, '', '', '', '', '', '', '', '')
    `);
    // 仍灌 800 行无关 GB 数据，证明跨年/跨变体不会受表大小影响
    for (let i = 0; i < 800; i++) {
      const code = `GB/T ${10000 + i}-2020`;
      insertNoise.run(code, extractFullCode(code), extractBaseCode(code));
    }
    // CNAS-scraper 脏空格变体 —— 这是真实数据
    const dirtyCode = 'GB/T 3325 -2024';
    insertNoise.run(dirtyCode, extractFullCode(dirtyCode), extractBaseCode(dirtyCode));

    const svc = new QualificationService(db as any);
    const result = svc.queryByStdCodes(['GB/T 3325-2024']);

    expect(result['GB/T 3325-2024']).toBeDefined();
    expect(result['GB/T 3325-2024'].length).toBeGreaterThanOrEqual(1);
    expect(result['GB/T 3325-2024'][0].source).toBe('CNAS');
    db.close();
  });

  it('does NOT match different years of same standard: search 2024 ignores 2017/2008/1995 versions', () => {
    // 产品语义"同号不同年 = 不同资质"。DB 里有 GB/T 3325 的 2017/2008/1995 三版,
    // 用户搜 2024 时全都不命中 —— 防止"实验室持有老版能力 → 新版搜索误亮徽章"。
    // 跨年复用需求请走 /resources/standard-search 关键词查询(用户能看到具体年版)。
    const db = makeTestDb();
    db.prepare("INSERT INTO cma_labs (cert_number, lab_name) VALUES ('CERT001', 'Test CMA')").run();
    const insert = db.prepare(`
      INSERT INTO cma_qualifications (cert_number, std_code, std_code_norm, std_code_base, std_name, effective_date, expiry_date, category, test_item, test_standard, limit_desc)
      VALUES ('CERT001', ?, ?, ?, '', '', '', '', '', '', '')
    `);
    for (const code of ['GB/T 3325-1995', 'GB/T 3325-2008', 'GB/T 3325-2017']) {
      insert.run(code, extractFullCode(code), extractBaseCode(code));
    }

    const svc = new QualificationService(db as any);
    const result = svc.queryByStdCodes(['GB/T 3325-2024']);

    // 同号跨年不再命中 —— 严格同年同号才贴徽章
    expect(result['GB/T 3325-2024']).toBeUndefined();
    db.close();
  });


  it('returns a clearly marked cross-year hint only when requested', () => {
    const db = makeTestDb();
    db.prepare("INSERT INTO cnas_labs (lab_no, lab_name) VALUES ('LAB001', 'Test Lab')").run();
    const code = 'GB/T 3324-2024';
    db.prepare(`
      INSERT INTO cnas_qualifications (lab_no, std_code, std_code_norm, std_code_base, std_name, effective_date, expiry_date, category, test_object, test_param, test_standard, limit_desc)
      VALUES ('LAB001', ?, ?, ?, '', '', '', '', '', '', '', '')
    `).run(code, extractFullCode(code), extractBaseCode(code));

    const svc = new QualificationService(db as any);
    expect(svc.queryByStdCodes(['GB/T 3324-2017'])['GB/T 3324-2017']).toBeUndefined();

    const result = svc.queryByStdCodes(['GB/T 3324-2017'], { includeCrossYear: true });
    expect(result['GB/T 3324-2017']).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'CNAS', stdCode: code, versionHint: true }),
    ]));
    db.close();
  });

  it('matches when DB has the exact same year as input', () => {
    // 同号同年正常命中 —— 收紧逻辑不影响正常路径
    const db = makeTestDb();
    db.prepare("INSERT INTO cma_labs (cert_number, lab_name) VALUES ('CERT001', 'Test CMA')").run();
    const insert = db.prepare(`
      INSERT INTO cma_qualifications (cert_number, std_code, std_code_norm, std_code_base, std_name, effective_date, expiry_date, category, test_item, test_standard, limit_desc)
      VALUES ('CERT001', ?, ?, ?, '', '', '', '', '', '', '')
    `);
    const code = 'GB/T 3325-2024';
    insert.run(code, extractFullCode(code), extractBaseCode(code));

    const svc = new QualificationService(db as any);
    const result = svc.queryByStdCodes(['GB/T 3325-2024']);

    expect(result['GB/T 3325-2024']).toBeDefined();
    expect(result['GB/T 3325-2024'].length).toBe(1);
    expect(result['GB/T 3325-2024'][0].stdCode).toBe('GB/T 3325-2024');
    db.close();
  });

  it('does not match GB/T 33325-2016 when searching GB/T 3325-2024 (selectivity)', () => {
    // 防回归：早期 LIKE 'GB%3325%' 会同时命中 'GB/T 33325' 五位数字标准号 —— 老 buildFuzzyLikePattern
    // 靠 JS 端 base 比对兜底剔除。现在用 std_code_base 索引等值，'GB3325' ≠ 'GB33325'，
    // 5 位数字号根本不进结果集，更严谨
    const db = makeTestDb();
    db.prepare("INSERT INTO cma_labs (cert_number, lab_name) VALUES ('CERT001', 'Test CMA')").run();
    const insert = db.prepare(`
      INSERT INTO cma_qualifications (cert_number, std_code, std_code_norm, std_code_base, std_name, effective_date, expiry_date, category, test_item, test_standard, limit_desc)
      VALUES ('CERT001', ?, ?, ?, '', '', '', '', '', '', '')
    `);
    const code = 'GB/T 33325-2016';
    insert.run(code, extractFullCode(code), extractBaseCode(code));

    const svc = new QualificationService(db as any);
    const result = svc.queryByStdCodes(['GB/T 3325-2024']);
    expect(result['GB/T 3325-2024']).toBeUndefined();   // 不能误命中
    db.close();
  });
});

describe('searchQualifications (Step 4: keyword search uses std_code_norm/base)', () => {
  it('finds stray-whitespace variant when user searches clean code', () => {
    // 老实现纯 LIKE 子串：搜 'GB/T 3325-2024' 时 'GB/T 3325 -2024' 匹不上（中间空格断了）。
    // 修法：query 算出 fullCode/baseCode 走归一化列等值，与传统 LIKE 兜底 OR 起来
    const db = makeTestDb();
    db.prepare("INSERT INTO cnas_labs (lab_no, lab_name) VALUES ('LAB001', 'Test Lab')").run();
    const dirtyCode = 'GB/T 3325 -2024';
    db.prepare(`
      INSERT INTO cnas_qualifications (lab_no, std_code, std_code_norm, std_code_base, std_name, effective_date, expiry_date, category, test_object, test_param, test_standard, limit_desc)
      VALUES ('LAB001', ?, ?, ?, '', '', '', '', '', '', '', '')
    `).run(dirtyCode, extractFullCode(dirtyCode), extractBaseCode(dirtyCode));

    const svc = new QualificationService(db as any);
    const results = svc.searchQualifications('GB/T 3325-2024');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].source).toBe('CNAS');
    expect(results[0].stdCode).toBe(dirtyCode);   // DB 里的原始脏数据照原样回显
    db.close();
  });

  it('finds row when user searches with a code fragment (Step 6 regression)', () => {
    // 真实案例：用户搜 '3325-' 这种片段时，老实现只走 std_code LIKE '%3325-%'，
    // CNAS 脏空格变体 'GB/T 3325 -2024' 因为中间空格断了不命中。
    // Step 6 修法：用 query 算出的 fullCode/baseCode 再做一遍归一化列 LIKE
    // ('3325-' → '3325-' → 'GB3325-2024' 含 '3325-' ✓)
    const db = makeTestDb();
    db.prepare("INSERT INTO cnas_labs (lab_no, lab_name) VALUES ('LAB001', 'Test Lab')").run();
    const dirtyCode = 'GB/T 3325 -2024';
    db.prepare(`
      INSERT INTO cnas_qualifications (lab_no, std_code, std_code_norm, std_code_base, std_name, effective_date, expiry_date, category, test_object, test_param, test_standard, limit_desc)
      VALUES ('LAB001', ?, ?, ?, '', '', '', '', '', '', '', '')
    `).run(dirtyCode, extractFullCode(dirtyCode), extractBaseCode(dirtyCode));

    const svc = new QualificationService(db as any);
    const results = svc.searchQualifications('3325-');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].source).toBe('CNAS');
    db.close();
  });

  it('does NOT return other years when user searches with a full year (hasFullYear path)', () => {
    // 用户报需求:资质查询页搜 '3324-2024' 不应返 '3324-2008/3324-2017' 这种跨年噪音。
    // 修法:query 带完整 4 位年份时禁用 std_code_base 路径,只走 std_code_norm 精确路径。
    // 想跨年搜请改成 '3324' 不带年。
    const db = makeTestDb();
    db.prepare("INSERT INTO cma_labs (cert_number, lab_name) VALUES ('CERT001', 'Test CMA')").run();
    const insert = db.prepare(`
      INSERT INTO cma_qualifications (cert_number, std_code, std_code_norm, std_code_base, std_name, effective_date, expiry_date, category, test_item, test_standard, limit_desc)
      VALUES ('CERT001', ?, ?, ?, '', '', '', '', '', '', '')
    `);
    for (const code of ['GB/T 3324-2008', 'GB/T 3324-2017', 'GB/T 3324-2024']) {
      insert.run(code, extractFullCode(code), extractBaseCode(code));
    }

    const svc = new QualificationService(db as any);
    const results = svc.searchQualifications('GB/T 3324-2024');

    // 只命中 2024 版,2008/2017 跨年版本不返
    expect(results.length).toBe(1);
    expect(results[0].stdCode).toBe('GB/T 3324-2024');
    expect(results[0].matchType).toBe('exact');
    db.close();
  });

  it('returns cross-year matches when user searches without year (片段路径)', () => {
    // 反向验证:搜片段(不带年)时仍跨年模糊,let user 主动选择宽匹配
    const db = makeTestDb();
    db.prepare("INSERT INTO cma_labs (cert_number, lab_name) VALUES ('CERT001', 'Test CMA')").run();
    const insert = db.prepare(`
      INSERT INTO cma_qualifications (cert_number, std_code, std_code_norm, std_code_base, std_name, effective_date, expiry_date, category, test_item, test_standard, limit_desc)
      VALUES ('CERT001', ?, ?, ?, '', '', '', '', '', '', '')
    `);
    for (const code of ['GB/T 3324-2008', 'GB/T 3324-2017', 'GB/T 3324-2024']) {
      insert.run(code, extractFullCode(code), extractBaseCode(code));
    }

    const svc = new QualificationService(db as any);
    const results = svc.searchQualifications('3324');

    // 三个年版都返(走 std_code_base = 'GB3324' 跨年路径)
    expect(results.length).toBe(3);
    expect(results.every(r => r.matchType === 'series')).toBe(true);
    db.close();
  });

  it('uses standard-code fast path before broad fuzzy fields', () => {
    const db = makeTestDb();
    db.prepare("INSERT INTO cma_labs (cert_number, lab_name) VALUES ('CERT001', 'Fast CMA')").run();
    const insert = db.prepare(`
      INSERT INTO cma_qualifications (cert_number, std_code, std_code_norm, std_code_base, std_name, effective_date, expiry_date, category, test_item, test_standard, limit_desc)
      VALUES ('CERT001', ?, ?, ?, ?, '', '', '', '', '', '')
    `);
    const exactCode = 'GB/T 3324-2024';
    insert.run(exactCode, extractFullCode(exactCode), extractBaseCode(exactCode), '木家具通用技术条件');
    insert.run('GB/T 9999-2024', extractFullCode('GB/T 9999-2024'), extractBaseCode('GB/T 9999-2024'), '包含 GB/T 3324-2024 的噪音名称');

    const svc = new QualificationService(db as any);
    const results = svc.searchQualifications('GB/T 3324-2024');

    expect(results.map(r => r.stdCode)).toEqual([exactCode]);
    expect(results[0].matchType).toBe('exact');
    db.close();
  });
});

describe('searchByStandard (standard-code fast path)', () => {
  it('returns exact standard groups without mixing fuzzy std_name noise', () => {
    const db = makeTestDb();
    db.prepare("INSERT INTO cnas_labs (lab_no, lab_name) VALUES ('LAB001', 'Fast CNAS')").run();
    const insert = db.prepare(`
      INSERT INTO cnas_qualifications (lab_no, std_code, std_code_norm, std_code_base, std_name, effective_date, expiry_date, category, test_object, test_param, test_standard, limit_desc)
      VALUES ('LAB001', ?, ?, ?, ?, '', '', '', '对象', '参数', '', '')
    `);
    const exactCode = 'GB/T 3324-2024';
    insert.run(exactCode, extractFullCode(exactCode), extractBaseCode(exactCode), '木家具通用技术条件');
    insert.run('GB/T 9999-2024', extractFullCode('GB/T 9999-2024'), extractBaseCode('GB/T 9999-2024'), '包含 GB/T 3324-2024 的噪音名称');

    const svc = new QualificationService(db as any);
    const groups = svc.searchByStandard('GB/T 3324-2024');

    expect(groups.map(g => g.stdCode)).toEqual([exactCode]);
    expect(groups[0].matchType).toBe('exact');
    db.close();
  });

  it('can return standard summaries without row details', () => {
    const db = makeTestDb();
    db.prepare("INSERT INTO cnas_labs (lab_no, lab_name) VALUES ('LAB001', 'Summary CNAS')").run();
    const code = 'GB/T 3324-2024';
    db.prepare(`
      INSERT INTO cnas_qualifications (lab_no, std_code, std_code_norm, std_code_base, std_name, effective_date, expiry_date, category, test_object, test_param, test_standard, limit_desc)
      VALUES ('LAB001', ?, ?, ?, '木家具通用技术条件', '', '', '', '对象', '参数', '', '')
    `).run(code, extractFullCode(code), extractBaseCode(code));

    const svc = new QualificationService(db as any);
    const summary = svc.searchByStandard(code, 'CNAS', 10, { includeRows: false });
    const rows = svc.getStandardGroupRows(code, 'CNAS');

    expect(summary).toHaveLength(1);
    expect(summary[0].rows).toEqual([]);
    expect(summary[0].rowCount).toBe(1);
    expect(rows).toHaveLength(1);
    db.close();
  });
});
