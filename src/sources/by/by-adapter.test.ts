import { describe, expect, it } from 'vitest';
import { loadDotEnvLocal } from '../../shared/env-loader';
import { ByAdapter } from './by-adapter';

// vitest 环境不会自动加载 .env.local（只有 src/index.ts 启动时调用 loadDotEnvLocal）。
// 这里显式加载一次（幂等），让"配置了 BY 凭据"时下面的真实网络测试真正生效；
// 未配置凭据时 hasByCredentials() 为 false，测试自动 skipped（CI / 无凭据场景行为不变）。
loadDotEnvLocal();

function hasByCredentials(): boolean {
  return Boolean(
    process.env.BY_USERNAME?.trim()
      && process.env.BY_PASSWORD?.trim()
      && process.env.BY_DEPT_ID?.trim(),
  );
}

describe('ByAdapter basics', () => {
  it('has source by', () => {
    const adapter = new ByAdapter();
    expect(adapter.source).toBe('by');
  });

  // 真实网络测试：仅当 .env.local 配置了 BY 凭据时运行（CI 无凭据 → 自动 skipped）。
  // 内网不可达（'not accessible'）时跳过——可达性是环境问题；其余错误（登录失败、
  // 凭据错误、断言失败）如实抛出，避免"配错凭据还静默通过"。
  it.runIf(hasByCredentials())('searches for 18584-2024 on by internal network', async () => {
    const adapter = new ByAdapter();

    try {
      const results = await adapter.searchStandards({ query: '18584-2024' });
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.id.startsWith('by:')).toBe(true);
    } catch (e: any) {
      if (e.message?.includes('not accessible')) return; // 内网不可达，环境问题，跳过
      throw e;
    }
  }, 20000);
});
