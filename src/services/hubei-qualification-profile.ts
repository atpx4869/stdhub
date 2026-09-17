import type Database from 'better-sqlite3';

/** Fixed qualification metadata for the Hubei institute. */
export interface HubeiQualificationProfile {
  readonly displayName: string;
  readonly cnas: {
    readonly labNo: string;
    readonly baseInfoId: string;
    readonly certUpdateTs: string;
    readonly validate: string;
    readonly urlParams: Readonly<Record<string, string>>;
  };
  readonly cma: {
    readonly certNumber: string;
    readonly publicDetailId: string;
    readonly creditCode: string;
  };
}

const HUBEI_CNAS_URL_PARAMS: Readonly<Record<string, string>> = Object.freeze({
  id: '34e24dc0bb2b42528f676f3ac5fccf6d',
  baseInfoId: 'd0afae34c5f6426b99d8704072763256',
  labType: 'L',
  scopeStr: 'decideStd_abilityL1Engry_abilityL1_signPerson_keyBranch_',
  orgEnOrCh: 'Ch',
  licNo: 'L0290',
  certUpdateTs: '2026-03-13',
  validate: '2029-10-30',
  attactdate: '2026-03-13',
});

/**
 * Canonical, runtime-immutable identifiers and metadata for 湖北省产品质量监督检验研究院.
 *
 * CNAS URL parameters are copied from the verified entry in preset-cnas-labs.ts.
 */
export const HUBEI_QUALIFICATION_PROFILE: Readonly<HubeiQualificationProfile> = Object.freeze({
  displayName: '湖北省产品质量监督检验研究院',
  cnas: Object.freeze({
    labNo: 'L0290',
    baseInfoId: 'd0afae34c5f6426b99d8704072763256',
    certUpdateTs: '2026-03-13',
    validate: '2029-10-30',
    urlParams: HUBEI_CNAS_URL_PARAMS,
  }),
  cma: Object.freeze({
    certNumber: '221700110366',
    publicDetailId: 'LI201581410348LI5860',
    creditCode: '12420000420003187N',
  }),
});

type CnasProfileRow = {
  lab_name: string | null;
  base_info_id: string | null;
  cert_update_ts: string | null;
  validate: string | null;
  url_params: string | null;
};

type CmaProfileRow = {
  lab_name: string | null;
  credit_code: string | null;
  public_detail_id: string | null;
};

const CNAS_STABLE_URL_PARAM_KEYS = ['id', 'baseInfoId', 'licNo'] as const;

function isMissing(value: string | null | undefined): boolean {
  return value == null || value.trim() === '';
}

function assertStableIdentifier(
  source: string,
  field: string,
  actual: string | null | undefined,
  expected: string,
): void {
  if (!isMissing(actual) && actual !== expected) {
    throw new Error(
      `Hubei qualification profile conflict: ${source}.${field} expected "${expected}" but found "${actual}"`,
    );
  }
}

function parseUrlParams(raw: string | null): Record<string, string> {
  if (isMissing(raw)) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw as string);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Hubei qualification profile conflict: cnas.url_params is invalid JSON: ${reason}`);
  }
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('Hubei qualification profile conflict: cnas.url_params must be a JSON object');
  }

  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      throw new Error(
        `Hubei qualification profile conflict: cnas.url_params.${key} must be a string`,
      );
    }
    result[key] = value;
  }
  return result;
}

function ensureCnasProfile(db: Database.Database): void {
  const profile = HUBEI_QUALIFICATION_PROFILE;
  const row = db.prepare(`
    SELECT lab_name, base_info_id, cert_update_ts, validate, url_params
    FROM cnas_labs
    WHERE lab_no = ?
  `).get(profile.cnas.labNo) as CnasProfileRow | undefined;

  if (!row) {
    db.prepare(`
      INSERT INTO cnas_labs (
        lab_no, lab_name, base_info_id, cert_update_ts, validate, url_params
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      profile.cnas.labNo,
      profile.displayName,
      profile.cnas.baseInfoId,
      profile.cnas.certUpdateTs,
      profile.cnas.validate,
      JSON.stringify(profile.cnas.urlParams),
    );
    return;
  }

  assertStableIdentifier('cnas', 'baseInfoId', row.base_info_id, profile.cnas.baseInfoId);
  const existingUrlParams = parseUrlParams(row.url_params);
  for (const key of CNAS_STABLE_URL_PARAM_KEYS) {
    assertStableIdentifier(
      'cnas.urlParams',
      key,
      existingUrlParams[key],
      profile.cnas.urlParams[key],
    );
  }

  const mergedUrlParams: Record<string, string> = { ...existingUrlParams };
  let urlParamsChanged = false;
  for (const [key, value] of Object.entries(profile.cnas.urlParams)) {
    if (isMissing(mergedUrlParams[key])) {
      mergedUrlParams[key] = value;
      urlParamsChanged = true;
    }
  }

  const updates: string[] = [];
  const values: string[] = [];
  const addMissing = (column: string, current: string | null, value: string): void => {
    if (isMissing(current)) {
      updates.push(`${column} = ?`);
      values.push(value);
    }
  };
  addMissing('lab_name', row.lab_name, profile.displayName);
  addMissing('base_info_id', row.base_info_id, profile.cnas.baseInfoId);
  addMissing('cert_update_ts', row.cert_update_ts, profile.cnas.certUpdateTs);
  addMissing('validate', row.validate, profile.cnas.validate);
  if (urlParamsChanged) {
    updates.push('url_params = ?');
    values.push(JSON.stringify(mergedUrlParams));
  }

  if (updates.length > 0) {
    db.prepare(`UPDATE cnas_labs SET ${updates.join(', ')} WHERE lab_no = ?`)
      .run(...values, profile.cnas.labNo);
  }
}

function ensureCmaProfile(db: Database.Database): void {
  const profile = HUBEI_QUALIFICATION_PROFILE;
  const row = db.prepare(`
    SELECT lab_name, credit_code, public_detail_id
    FROM cma_labs
    WHERE cert_number = ?
  `).get(profile.cma.certNumber) as CmaProfileRow | undefined;

  if (!row) {
    db.prepare(`
      INSERT INTO cma_labs (cert_number, lab_name, credit_code, public_detail_id)
      VALUES (?, ?, ?, ?)
    `).run(
      profile.cma.certNumber,
      profile.displayName,
      profile.cma.creditCode,
      profile.cma.publicDetailId,
    );
    return;
  }

  assertStableIdentifier('cma', 'creditCode', row.credit_code, profile.cma.creditCode);
  assertStableIdentifier(
    'cma',
    'publicDetailId',
    row.public_detail_id,
    profile.cma.publicDetailId,
  );

  const updates: string[] = [];
  const values: string[] = [];
  const addMissing = (column: string, current: string | null, value: string): void => {
    if (isMissing(current)) {
      updates.push(`${column} = ?`);
      values.push(value);
    }
  };
  addMissing('lab_name', row.lab_name, profile.displayName);
  addMissing('credit_code', row.credit_code, profile.cma.creditCode);
  addMissing('public_detail_id', row.public_detail_id, profile.cma.publicDetailId);

  if (updates.length > 0) {
    db.prepare(`UPDATE cma_labs SET ${updates.join(', ')} WHERE cert_number = ?`)
      .run(...values, profile.cma.certNumber);
  }
}

/**
 * Idempotently fills missing CNAS/CMA lab metadata for the fixed Hubei profile.
 *
 * The operation is local and transactional. It never performs synchronization or
 * touches qualification snapshot tables. Existing non-empty metadata is preserved;
 * conflicts in stable identifiers fail explicitly instead of being overwritten.
 */
export function ensureHubeiQualificationProfile(db: Database.Database): void {
  db.transaction(() => {
    ensureCnasProfile(db);
    ensureCmaProfile(db);
  })();
}
