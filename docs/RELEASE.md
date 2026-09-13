# 发布流程

StdHub 不再对每次 `main` 推送自动升版。正式版本只能由维护者在 GitHub Actions 手动运行 **Release (manual version bump)**。

## 镜像标签策略

- 每次 `main` 推送：CI/CD 门禁通过后构建并推送「提交 SHA」标签镜像（如 `stdhub:bcf81a2`），可按提交拉取验证；**不写** `latest`/版本号标签。
- 手动发布派发：Release 流程 bump 版本后触发 `docker-publish`，是唯一的 `latest`、裸版本和 `v` 前缀版本标签写入者，避免与 push 构建竞态覆盖。
- pull_request：不构建镜像（fork PR 无 secrets 权限，也没有发布语义）。

工作流顺序固定为：

1. 从最新 `main` 安装依赖并执行构建、CSS 检查、Vitest 与 Chromium E2E。
2. 构建候选 Docker 镜像，实际启动容器并验证 `/api/health`。
3. 用 Trivy 扫描镜像；存在可修复的 HIGH/CRITICAL 漏洞即停止。
4. 所有门禁通过后才递增 patch 版本、提交 `package.json/package-lock.json`、创建 tag 和 GitHub Release。
5. 派发镜像发布流程，重复构建/扫描后推送 `latest`、裸版本和 `v` 前缀版本标签，并签名、上传 SBOM。

失败的候选不会产生版本提交、tag 或 Release。发布前应确认工作树已合并、变更记录和 `docs/PRODUCT_STATUS.md` 与代码一致，并对数据库变更完成备份与恢复演练。
