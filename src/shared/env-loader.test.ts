import { afterEach, describe, expect, it, vi } from 'vitest';

// env-loader 通过 node:fs 读取文件，所以在这一层模拟即可精确复现容器内的
// 读取失败，不依赖运行机器上是否真的存在 .env.local。
// （不要尝试 mock dotenv：加载器用 require() 调用它，vitest 的模块 mock 拦不住，
// 测试会退化成读宿主机真实文件，结果随机器而变。）
const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: mocks.existsSync,
  readFileSync: mocks.readFileSync,
}));

async function loadFreshEnvLoader() {
  vi.resetModules();
  return import('./env-loader.js');
}

/** 构造容器里的真实报错：文件存在，但运行用户无权读取。 */
function permissionError(code: 'EACCES' | 'EPERM'): NodeJS.ErrnoException {
  const error = new Error(
    `${code}: permission denied, open '/app/.env.local'`,
  ) as NodeJS.ErrnoException;
  error.code = code;
  return error;
}

describe('loadDotEnvLocal', () => {
  const originalSkip = process.env.STDHUB_SKIP_DOTENV_LOCAL;

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
    delete process.env.ENV_LOADER_TEST_NEW;
    delete process.env.ENV_LOADER_TEST_EXISTING;
    if (originalSkip === undefined) delete process.env.STDHUB_SKIP_DOTENV_LOCAL;
    else process.env.STDHUB_SKIP_DOTENV_LOCAL = originalSkip;
  });

  it('does not inspect the container filesystem when Compose already injected env_file', async () => {
    process.env.STDHUB_SKIP_DOTENV_LOCAL = '1';
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { loadDotEnvLocal } = await loadFreshEnvLoader();

    expect(loadDotEnvLocal()).toEqual({ loaded: false });
    expect(mocks.existsSync).not.toHaveBeenCalled();
    expect(mocks.readFileSync).not.toHaveBeenCalled();
    // 跳过读取必须说明原因，避免“文件明明在却没生效”的再次误判
    const logged = log.mock.calls.flat().join(' ');
    expect(logged).toContain('STDHUB_SKIP_DOTENV_LOCAL');
    expect(logged).toContain('env_file');
  });

  it('reports a missing optional file without attempting to read it', async () => {
    delete process.env.STDHUB_SKIP_DOTENV_LOCAL;
    mocks.existsSync.mockReturnValue(false);
    const { loadDotEnvLocal } = await loadFreshEnvLoader();

    expect(loadDotEnvLocal()).toEqual({ loaded: false });
    expect(mocks.existsSync).toHaveBeenCalledOnce();
    expect(mocks.readFileSync).not.toHaveBeenCalled();
  });

  it('classifies an unreadable file as a permission problem, not a parse error, and never echoes the raw error', async () => {
    delete process.env.STDHUB_SKIP_DOTENV_LOCAL;
    mocks.existsSync.mockReturnValue(true);
    const denied = permissionError('EACCES');
    mocks.readFileSync.mockImplementation(() => {
      throw denied;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { loadDotEnvLocal } = await loadFreshEnvLoader();
    expect(loadDotEnvLocal()).toEqual({ loaded: false });

    const warned = warn.mock.calls.flat().join(' ');
    // 必须给出可执行的修复方向
    expect(warned).toContain('env_file');
    // 不得把权限问题误报成解析错误——线上误导排查的就是这一句
    expect(warned).not.toMatch(/parse error/i);
    // 不得回显原始错误（可能携带路径等信息）
    expect(warned).not.toContain(denied.message);
    expect(warned).not.toContain('/app/.env.local');
    // 不得声称加载成功
    expect(log).not.toHaveBeenCalled();
  });

  it('classifies EPERM the same way as EACCES', async () => {
    delete process.env.STDHUB_SKIP_DOTENV_LOCAL;
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockImplementation(() => {
      throw permissionError('EPERM');
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { loadDotEnvLocal } = await loadFreshEnvLoader();

    expect(loadDotEnvLocal()).toEqual({ loaded: false });
    expect(warn.mock.calls.flat().join(' ')).toContain('env_file');
  });

  it('does not misreport other read failures as a permission problem', async () => {
    delete process.env.STDHUB_SKIP_DOTENV_LOCAL;
    mocks.existsSync.mockReturnValue(true);
    const broken = new Error('EISDIR: illegal operation on a directory') as NodeJS.ErrnoException;
    broken.code = 'EISDIR';
    mocks.readFileSync.mockImplementation(() => {
      throw broken;
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const { loadDotEnvLocal } = await loadFreshEnvLoader();

    expect(loadDotEnvLocal()).toEqual({ loaded: false });
    const warned = warn.mock.calls.flat().join(' ');
    expect(warned).toContain('could not be read');
    expect(warned).not.toContain('env_file');
  });

  it('caches the first result instead of reporting a phantom load', async () => {
    delete process.env.STDHUB_SKIP_DOTENV_LOCAL;
    mocks.existsSync.mockReturnValue(false);
    const { loadDotEnvLocal } = await loadFreshEnvLoader();

    expect(loadDotEnvLocal()).toEqual({ loaded: false });
    // 旧实现第二次调用会谎报 { loaded: true }
    expect(loadDotEnvLocal()).toEqual({ loaded: false });
    expect(mocks.existsSync).toHaveBeenCalledOnce();
  });

  it('injects parsed values without overriding variables that are already set', async () => {
    delete process.env.STDHUB_SKIP_DOTENV_LOCAL;
    process.env.ENV_LOADER_TEST_EXISTING = 'from-real-env';
    delete process.env.ENV_LOADER_TEST_NEW;
    mocks.existsSync.mockReturnValue(true);
    mocks.readFileSync.mockReturnValue(
      'ENV_LOADER_TEST_NEW=from-file\nENV_LOADER_TEST_EXISTING=from-file\n',
    );
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const { loadDotEnvLocal } = await loadFreshEnvLoader();
    const result = loadDotEnvLocal();

    expect(result.loaded).toBe(true);
    expect(result.path).toMatch(/[\\/]\.env\.local$/);
    expect(process.env.ENV_LOADER_TEST_NEW).toBe('from-file');
    // Compose 的 env_file / environment 注入优先，不得被文件内容覆盖
    expect(process.env.ENV_LOADER_TEST_EXISTING).toBe('from-real-env');
  });
});
