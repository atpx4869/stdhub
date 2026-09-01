export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1' || host.toLowerCase() === 'localhost';
}

/**
 * 产品模式：单用户免登录管理员。
 * 本机 loopback 可直接使用；非本机监听必须由反代注入 STDHUB_PROXY_TOKEN。
 * 仅在明确设置 STDHUB_ALLOW_OPEN_ADMIN=1 时允许无 token 的局域网/公网监听。
 */
export function checkOpenAdminBoundary(host: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isLoopbackHost(host)) return;
  if (env.STDHUB_PROXY_TOKEN?.trim()) return;
  if (env.STDHUB_ALLOW_OPEN_ADMIN === '1') {
    console.warn(
      `[stdhub] 已显式允许开放管理员模式：监听 ${host} 且未设置 STDHUB_PROXY_TOKEN。` +
        '同网段可直接访问全部管理员功能。',
    );
    return;
  }
  throw new Error(
    `[stdhub] 拒绝启动：当前监听 ${host} 且未设置 STDHUB_PROXY_TOKEN。` +
      '本产品是单用户免登录管理员模式，非本机监听必须由 Lucky/Nginx 注入 X-StdHub-Proxy-Token。' +
      ' 如确认要开放局域网直连，请设置 STDHUB_PROXY_TOKEN，或显式设置 STDHUB_ALLOW_OPEN_ADMIN=1。',
  );
}
