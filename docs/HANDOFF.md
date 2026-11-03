# StdHub 交接说明（2026-11-03）

本文件只记录可公开状态，不含密码、Cookie 或 FRP token。

## 仓库与发布

- 仓库：https://github.com/atpx4869/stdhub ，分支 `main`。
- CI 已恢复：Trivy SARIF 必须设置 `limit-severities-for-sarif: true`，保留 HIGH/CRITICAL 与 `exit-code: 1`；不要改成无条件放行。
- 正式发布使用 CI 构建的 `jzrm/stdhub:latest`，不再使用旧镜像覆盖 dist/public 的临时方案。
- 最近已验证版本：`1c4ee0f20b0cefa377c19bd478fe4f27595fb212`（CI 41595556690）。本次新增国CMA能力表，具体部署修订以容器标签与本次 CI 结论为准。
- `gh run watch` 退出 0 不足以证明工作流全部完成；须另查最终 conclusion 与镜像修订。

## NAS 环境

- NAS：`192.168.5.120`，SSH 32288，用户 jzrm；本机通过 `sudo -n docker` 管理。
- Compose：`/vol1/1000/compose/stdhub/docker-compose.yml`，服务 `stdhub`。
- 地址：http://192.168.5.120:33004 ，宿主 33004 → 容器 3000。
- 挂载：`./stdhub-data` → `/app/data`；`./stdhub-standards` → `/app/standards`。
- 保留旧镜像 `jzrm/stdhub:rollback-20261103-before-a48fc92` 供回退；回退镜像不等于回退业务数据库。

## 国CMA 已批准表格库

- 固定主体湖北省产品质量监督检验研究院；来源 `approved_table`，徽章严格使用 **国CMA**。
- 与 CNAS、省 CMA、国家库独立；旧在线国CMA采集与订阅入口继续暂停，不触发旧同步。
- 使用 `nat_cma_table_*` 独立表。首次启动仅幂等建表，不自动从附件路径读取或导入。
- 管理员进入资质查询页的国CMA区：选择 XLSX → 上传并预览 → 核对警告 → 明确确认并启用。游客可查询，不能导入或切换批次。
- SHA-256 相同文件复用已有批次，**不会**自动重新启用旧批次；版本回退必须在历史中明确启用。
- 原表 A:J、工作表名、原行号保留；K/L 签字人和身份证不导入。仅完整标准号与年版匹配；命中不是全项覆盖。限制与备注逐条展示。
- 无法完全识别的标准号保留原文和警告，可查询核对，但不参与自动徽章匹配。
- 详细接口与数量口径见 `docs/NATIONAL_CMA_TABLE.md`。

## 已上线功能及已知事项

- BW 文本状态为 available/unavailable/unknown；网络失败不是“无文本”。44632-2024 无文本、3324-2024 有文本已验证。
- 本地文件库 CNAS/CMA/国家库徽章共存；本次国CMA加入同一标准号后的徽章区，不影响预览下载。
- BY 通过 NAS **原生** frps（不是 Docker）转发：7000 / 公网 TCP 17000，远端端口 18080 绑定 `192.168.5.120`。容器 `BY_BASE_URL=http://192.168.5.120:18080`。
- 公司 Win11 frpc 连接 `std.524869.xyz:17000`，映射内网 `172.16.100.72:8080`；WinSW 服务 `StdHubBYTunnel` 自动延迟启动、失败重启已验证。配置名必须是 `D:\frp\stdhub-by-service.exe.xml`；重启后验收尚待用户，休眠/关机会中断 BY。
- Doc88 Cookie 已过期，需用户替换；不要把 Cookie 提交到仓库。

## 部署与验证

```bash
# 等待全部 CI 成功后拉取
sudo -n docker compose -f /vol1/1000/compose/stdhub/docker-compose.yml pull stdhub
# 先核对本地 latest 镜像 revision 与待发布提交一致，再更新容器
sudo -n docker image inspect jzrm/stdhub:latest --format '{{json .Config.Labels}}'
sudo -n docker compose -f /vol1/1000/compose/stdhub/docker-compose.yml up -d --no-build stdhub
curl -fsS http://192.168.5.120:33004/api/health
curl -fsS http://192.168.5.120:33004/api/nat-cma/table/status
```

导入前按 SQLite backup API 备份运行数据库；不要直接复制活动 WAL 数据库的单个主文件。导入后核对行数、限制/备注与 GB/T 32487-2016，检查搜索、本地库的国CMA徽章与移动端。

## 凭据

凭据只保留在 NAS 环境变量、`.env` 和受限 secret 文件。Doc88 使用 `DOC88_COOKIE_FILE` 引用 `/run/secrets/doc88-cookie.txt`；不把任何值写进文档、Issue、日志或仓库。
