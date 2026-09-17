import { afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { getDb } from './db';
import {
  ensureHubeiQualificationProfile,
  HUBEI_QUALIFICATION_PROFILE,
} from './hubei-qualification-profile';

const openDatabases: Database.Database[] = [];

function createDb(): Database.Database {
  const db = getDb(':memory:');
  openDatabases.push(db);
  return db;
}

function readCnasLab(db: Database.Database): Record<string, unknown> | undefined {
  return db.prepare(`
    SELECT lab_no, lab_name, base_info_id, cert_update_ts, validate, url_params,
           record_count, last_sync_at
    FROM cnas_labs
    WHERE lab_no = ?
  `).get(HUBEI_QUALIFICATION_PROFILE.cnas.labNo) as Record<string, unknown> | undefined;
}

function readCmaLab(db: Database.Database): Record<string, unknown> | undefined {
  return db.prepare(`
    SELECT cert_number, lab_name, credit_code, public_detail_id,
           record_count, last_sync_at
    FROM cma_labs
    WHERE cert_number = ?
  `).get(HUBEI_QUALIFICATION_PROFILE.cma.certNumber) as Record<string, unknown> | undefined;
}

afterEach(() => {
  while (openDatabases.length > 0) openDatabases.pop()?.close();
});

describe('HUBEI_QUALIFICATION_PROFILE', () => {
  it('exports the canonical immutable identifiers and verified CNAS URL parameters', () => {
    expect(HUBEI_QUALIFICATION_PROFILE).toMatchObject({
      displayName: '湖北省产品质量监督检验研究院',
      cnas: {
        labNo: 'L0290',
        baseInfoId: 'd0afae34c5f6426b99d8704072763256',
        certUpdateTs: '2026-03-13',
        validate: '2029-10-30',
        urlParams: {
          id: '34e24dc0bb2b42528f676f3ac5fccf6d',
          baseInfoId: 'd0afae34c5f6426b99d8704072763256',
          labType: 'L',
          scopeStr: 'decideStd_abilityL1Engry_abilityL1_signPerson_keyBranch_',
          orgEnOrCh: 'Ch',
          licNo: 'L0290',
          certUpdateTs: '2026-03-13',
          validate: '2029-10-30',
          attactdate: '2026-03-13',
        },
      },
      cma: {
        certNumber: '221700110366',
        publicDetailId: 'LI201581410348LI5860',
        creditCode: '12420000420003187N',
      },
    });
    expect(Object.isFrozen(HUBEI_QUALIFICATION_PROFILE)).toBe(true);
    expect(Object.isFrozen(HUBEI_QUALIFICATION_PROFILE.cnas)).toBe(true);
    expect(Object.isFrozen(HUBEI_QUALIFICATION_PROFILE.cnas.urlParams)).toBe(true);
    expect(Object.isFrozen(HUBEI_QUALIFICATION_PROFILE.cma)).toBe(true);
  });
});

describe('ensureHubeiQualificationProfile', () => {
  it('inserts missing CNAS and CMA lab rows without creating qualification snapshots', () => {
    const db = createDb();

    ensureHubeiQualificationProfile(db);

    expect(readCnasLab(db)).toEqual({
      lab_no: 'L0290',
      lab_name: '湖北省产品质量监督检验研究院',
      base_info_id: 'd0afae34c5f6426b99d8704072763256',
      cert_update_ts: '2026-03-13',
      validate: '2029-10-30',
      url_params: JSON.stringify(HUBEI_QUALIFICATION_PROFILE.cnas.urlParams),
      record_count: 0,
      last_sync_at: null,
    });
    expect(readCmaLab(db)).toEqual({
      cert_number: '221700110366',
      lab_name: '湖北省产品质量监督检验研究院',
      credit_code: '12420000420003187N',
      public_detail_id: 'LI201581410348LI5860',
      record_count: 0,
      last_sync_at: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS count FROM cnas_qualifications').get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM cma_qualifications').get()).toEqual({ count: 0 });
  });

  it('is a no-op for correct rows', () => {
    const db = createDb();
    ensureHubeiQualificationProfile(db);
    const cnasBefore = readCnasLab(db);
    const cmaBefore = readCmaLab(db);
    const cnasChangesBefore = db.prepare('SELECT total_changes() AS changes').get();

    ensureHubeiQualificationProfile(db);

    expect(readCnasLab(db)).toEqual(cnasBefore);
    expect(readCmaLab(db)).toEqual(cmaBefore);
    expect(db.prepare('SELECT total_changes() AS changes').get()).toEqual(cnasChangesBefore);
  });

  it('does not modify existing qualification snapshots', () => {
    const db = createDb();
    db.prepare(`
      INSERT INTO cnas_qualifications (lab_no, std_code, std_name)
      VALUES (?, 'GB/T 1-2026', 'CNAS snapshot')
    `).run(HUBEI_QUALIFICATION_PROFILE.cnas.labNo);
    db.prepare(`
      INSERT INTO cma_qualifications (cert_number, std_code, std_name)
      VALUES (?, 'GB/T 2-2026', 'CMA snapshot')
    `).run(HUBEI_QUALIFICATION_PROFILE.cma.certNumber);
    const cnasBefore = db.prepare('SELECT * FROM cnas_qualifications').all();
    const cmaBefore = db.prepare('SELECT * FROM cma_qualifications').all();

    ensureHubeiQualificationProfile(db);

    expect(db.prepare('SELECT * FROM cnas_qualifications').all()).toEqual(cnasBefore);
    expect(db.prepare('SELECT * FROM cma_qualifications').all()).toEqual(cmaBefore);
  });

  it('fills only missing metadata and preserves record_count and last_sync_at', () => {
    const db = createDb();
    db.prepare(`
      INSERT INTO cnas_labs (
        lab_no, lab_name, base_info_id, cert_update_ts, validate, url_params,
        record_count, last_sync_at
      ) VALUES (?, '', '', '', '', ?, 37, '2026-04-01T01:02:03Z')
    `).run(
      HUBEI_QUALIFICATION_PROFILE.cnas.labNo,
      JSON.stringify({ custom: 'keep-me' }),
    );
    db.prepare(`
      INSERT INTO cma_labs (
        cert_number, lab_name, credit_code, public_detail_id,
        record_count, last_sync_at
      ) VALUES (?, '', '', '', 41, '2026-04-02T03:04:05Z')
    `).run(HUBEI_QUALIFICATION_PROFILE.cma.certNumber);

    ensureHubeiQualificationProfile(db);

    const cnas = readCnasLab(db);
    expect(cnas).toMatchObject({
      lab_name: HUBEI_QUALIFICATION_PROFILE.displayName,
      base_info_id: HUBEI_QUALIFICATION_PROFILE.cnas.baseInfoId,
      cert_update_ts: HUBEI_QUALIFICATION_PROFILE.cnas.certUpdateTs,
      validate: HUBEI_QUALIFICATION_PROFILE.cnas.validate,
      record_count: 37,
      last_sync_at: '2026-04-01T01:02:03Z',
    });
    expect(JSON.parse(cnas?.url_params as string)).toEqual({
      custom: 'keep-me',
      ...HUBEI_QUALIFICATION_PROFILE.cnas.urlParams,
    });
    expect(readCmaLab(db)).toMatchObject({
      lab_name: HUBEI_QUALIFICATION_PROFILE.displayName,
      credit_code: HUBEI_QUALIFICATION_PROFILE.cma.creditCode,
      public_detail_id: HUBEI_QUALIFICATION_PROFILE.cma.publicDetailId,
      record_count: 41,
      last_sync_at: '2026-04-02T03:04:05Z',
    });
  });

  it('throws on a conflicting CNAS stable identifier and rolls back CMA insertion', () => {
    const db = createDb();
    db.prepare(`
      INSERT INTO cnas_labs (lab_no, lab_name, base_info_id, url_params)
      VALUES (?, 'Existing CNAS', 'conflicting-base-id', '{}')
    `).run(HUBEI_QUALIFICATION_PROFILE.cnas.labNo);

    expect(() => ensureHubeiQualificationProfile(db)).toThrow(
      'Hubei qualification profile conflict: cnas.baseInfoId',
    );
    expect(readCmaLab(db)).toBeUndefined();
  });

  it('throws on a conflicting CMA stable identifier and rolls back CNAS insertion', () => {
    const db = createDb();
    db.prepare(`
      INSERT INTO cma_labs (cert_number, lab_name, credit_code, public_detail_id)
      VALUES (?, 'Existing CMA', ?, 'conflicting-detail-id')
    `).run(
      HUBEI_QUALIFICATION_PROFILE.cma.certNumber,
      HUBEI_QUALIFICATION_PROFILE.cma.creditCode,
    );

    expect(() => ensureHubeiQualificationProfile(db)).toThrow(
      'Hubei qualification profile conflict: cma.publicDetailId',
    );
    expect(readCnasLab(db)).toBeUndefined();
  });

  it('throws when stable identifiers inside CNAS URL parameters conflict', () => {
    const db = createDb();
    db.prepare(`
      INSERT INTO cnas_labs (lab_no, lab_name, base_info_id, url_params)
      VALUES (?, ?, ?, ?)
    `).run(
      HUBEI_QUALIFICATION_PROFILE.cnas.labNo,
      HUBEI_QUALIFICATION_PROFILE.displayName,
      HUBEI_QUALIFICATION_PROFILE.cnas.baseInfoId,
      JSON.stringify({ licNo: 'L9999' }),
    );

    expect(() => ensureHubeiQualificationProfile(db)).toThrow(
      'Hubei qualification profile conflict: cnas.urlParams.licNo',
    );
  });
});
