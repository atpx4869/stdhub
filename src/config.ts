import { z } from 'zod';

const optionalTrimmed = z.preprocess(
  value => typeof value === 'string' && value.trim() === '' ? undefined : value,
  z.string().trim().optional(),
);

function integerFromEnv(defaultValue: number, min: number, max: number) {
  return z.preprocess(
    value => value === undefined || value === '' ? defaultValue : Number(value),
    z.number().int().min(min).max(max),
  );
}

const boolFromEnv = z.preprocess(value => {
  if (value === undefined || value === '') return false;
  if (value === '1' || value === 'true') return true;
  if (value === '0' || value === 'false') return false;
  return value;
}, z.boolean());

const envSchema = z.object({
  NODE_ENV: optionalTrimmed,
  VITEST: optionalTrimmed,
  PORT: integerFromEnv(3000, 0, 65_535),
  STDHUB_BIND_HOST: optionalTrimmed,
  HOST: optionalTrimmed,
  STDHUB_TRUST_PROXY: optionalTrimmed,
  STDHUB_PROXY_TOKEN: optionalTrimmed,
  STDHUB_ALLOW_OPEN_ADMIN: boolFromEnv,
  STDHUB_ADMIN_SETUP_TOKEN: optionalTrimmed,
  STDHUB_ADMIN_PASSWORD: optionalTrimmed,
  BZXZ_COOKIE_SECURE: boolFromEnv,
  BZXZ_APP_VERSION: optionalTrimmed,
  npm_package_version: optionalTrimmed,
  STDHUB_DISABLE_DISK_LOGS: boolFromEnv,
  STDHUB_HIGH_COST_RATE_PER_MINUTE: integerFromEnv(30, 1, 10_000),
  STDHUB_HEAVY_SYNC_RATE_PER_10_MINUTES: integerFromEnv(8, 1, 10_000),
  STDHUB_HIGH_COST_ACTIVE_LIMIT: integerFromEnv(4, 1, 100),
  STDHUB_HIGH_COST_QUEUE_LIMIT: integerFromEnv(12, 0, 1_000),
  STDHUB_HIGH_COST_QUEUE_TIMEOUT_MS: integerFromEnv(15_000, 100, 600_000),
  STDHUB_HEAVY_SYNC_ACTIVE_LIMIT: integerFromEnv(2, 1, 100),
  STDHUB_HEAVY_SYNC_QUEUE_LIMIT: integerFromEnv(4, 0, 1_000),
  STDHUB_HEAVY_SYNC_QUEUE_TIMEOUT_MS: integerFromEnv(10_000, 100, 600_000),
  STDHUB_PREVIEW_CONCURRENCY: integerFromEnv(1, 1, 4),
  STDHUB_PREVIEW_WIDTH: integerFromEnv(1_800, 800, 2_400),
  STDHUB_PREVIEW_MAX_HEIGHT: integerFromEnv(2_600, 1_200, 5_000),
  STDHUB_PREVIEW_QUALITY: integerFromEnv(88, 50, 100),
  STDHUB_PREVIEW_TIMEOUT_MS: integerFromEnv(120_000, 5_000, 600_000),
  STDHUB_PREVIEW_MIN_FREE_MB: integerFromEnv(256, 0, 1_048_576),
  STDHUB_COMPLETION_MAX_UPLOAD_MB: integerFromEnv(10, 1, 100),
  STDHUB_COMPLETION_MAX_SHEETS: integerFromEnv(20, 1, 100),
  STDHUB_COMPLETION_MAX_USED_CELLS: integerFromEnv(300_000, 1_000, 5_000_000),
  STDHUB_COMPLETION_MAX_ROWS: integerFromEnv(2_000, 1, 100_000),
  STDHUB_COMPLETION_MAX_UNIQUE: integerFromEnv(1_000, 1, 100_000),
  STDHUB_COMPLETION_MAX_FIELDS: integerFromEnv(30, 1, 100),
  STDHUB_COMPLETION_MAX_PREVIEW_ROWS: integerFromEnv(10, 1, 10),
  STDHUB_COMPLETION_CONCURRENCY: integerFromEnv(1, 1, 4),
  STDHUB_COMPLETION_QUEUE_LIMIT: integerFromEnv(2, 0, 20),
  BZXZ_OCR_STARTUP_TIMEOUT_MS: integerFromEnv(20_000, 1_000, 300_000),
  CNAS_BROWSER_CHANNEL: optionalTrimmed,
  BY_BASE_URL: optionalTrimmed,
  BY_DEPT_ID: optionalTrimmed,
  BY_USERNAME: optionalTrimmed,
  BY_PASSWORD: optionalTrimmed,
  LABR_USERNAME: optionalTrimmed,
  LABR_PASSWORD: optionalTrimmed,
});

export type RuntimeConfig = ReturnType<typeof readConfig>;

/** Parse on demand so tests and embedded callers may provide an isolated env object. */
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`环境配置无效：${details}`);
  }
  const value = parsed.data;
  const trustProxyRaw = value.STDHUB_TRUST_PROXY;
  const trustProxy = trustProxyRaw && /^\d+$/.test(trustProxyRaw)
    ? Number.parseInt(trustProxyRaw, 10)
    : (trustProxyRaw || 1);
  return {
    isTest: value.NODE_ENV === 'test' || Boolean(value.VITEST),
    port: value.PORT,
    bindHost: value.STDHUB_BIND_HOST || value.HOST || '127.0.0.1',
    trustProxy,
    proxyToken: value.STDHUB_PROXY_TOKEN || '',
    allowOpenAdmin: value.STDHUB_ALLOW_OPEN_ADMIN,
    adminSetupToken: value.STDHUB_ADMIN_SETUP_TOKEN || '',
    adminPassword: value.STDHUB_ADMIN_PASSWORD,
    cookieSecure: value.BZXZ_COOKIE_SECURE,
    appVersion: value.npm_package_version || value.BZXZ_APP_VERSION || '',
    disableDiskLogs: value.STDHUB_DISABLE_DISK_LOGS,
    highCostRatePerMinute: value.STDHUB_HIGH_COST_RATE_PER_MINUTE,
    heavySyncRatePerTenMinutes: value.STDHUB_HEAVY_SYNC_RATE_PER_10_MINUTES,
    highCostActiveLimit: value.STDHUB_HIGH_COST_ACTIVE_LIMIT,
    highCostQueueLimit: value.STDHUB_HIGH_COST_QUEUE_LIMIT,
    highCostQueueTimeoutMs: value.STDHUB_HIGH_COST_QUEUE_TIMEOUT_MS,
    heavySyncActiveLimit: value.STDHUB_HEAVY_SYNC_ACTIVE_LIMIT,
    heavySyncQueueLimit: value.STDHUB_HEAVY_SYNC_QUEUE_LIMIT,
    heavySyncQueueTimeoutMs: value.STDHUB_HEAVY_SYNC_QUEUE_TIMEOUT_MS,
    preview: {
      concurrency: value.STDHUB_PREVIEW_CONCURRENCY,
      width: value.STDHUB_PREVIEW_WIDTH,
      maxHeight: value.STDHUB_PREVIEW_MAX_HEIGHT,
      quality: value.STDHUB_PREVIEW_QUALITY,
      timeoutMs: value.STDHUB_PREVIEW_TIMEOUT_MS,
      minFreeMb: value.STDHUB_PREVIEW_MIN_FREE_MB,
    },
    completion: {
      maxUploadBytes: value.STDHUB_COMPLETION_MAX_UPLOAD_MB * 1024 * 1024,
      maxSheets: value.STDHUB_COMPLETION_MAX_SHEETS,
      maxUsedCells: value.STDHUB_COMPLETION_MAX_USED_CELLS,
      maxRows: value.STDHUB_COMPLETION_MAX_ROWS,
      maxUnique: value.STDHUB_COMPLETION_MAX_UNIQUE,
      maxFields: value.STDHUB_COMPLETION_MAX_FIELDS,
      maxPreviewRows: value.STDHUB_COMPLETION_MAX_PREVIEW_ROWS,
      concurrency: value.STDHUB_COMPLETION_CONCURRENCY,
      queueLimit: value.STDHUB_COMPLETION_QUEUE_LIMIT,
    },
    ocrStartupTimeoutMs: value.BZXZ_OCR_STARTUP_TIMEOUT_MS,
    cnasBrowserChannel: value.CNAS_BROWSER_CHANNEL,
    by: {
      baseUrl: value.BY_BASE_URL || 'http://172.16.100.72:8080',
      deptId: value.BY_DEPT_ID,
      username: value.BY_USERNAME,
      password: value.BY_PASSWORD,
    },
    labr: { username: value.LABR_USERNAME, password: value.LABR_PASSWORD },
  };
}
