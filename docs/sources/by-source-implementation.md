# by 源实现文档

## 概述

by 源对接**标院内网标准管理系统**，是一个基于 ASP.NET WebForms 的内网系统，需要登录后才能搜索和下载标准。

- 内网直连：`http://172.16.100.72:8080`（仅内网网段可达）
- **外网接入（VPS/NAS 部署）**：经 frp stcp 隧道把内网系统映射到部署机本地端口，`BY_BASE_URL` 指向隧道入口即可，无需改代码。见下文「隧道部署」。

## 关键配置

凭据一律从 `.env.local`（或真实环境变量）注入，**禁止写死进仓库/文档**：

| 环境变量 | 必填 | 说明 |
|----------|------|------|
| `BY_USERNAME` | ✅ | 标院内网系统登录用户名 |
| `BY_PASSWORD` | ✅ | 登录密码 |
| `BY_DEPT_ID` | ✅ | 部门 ID（登录页 `ddlDept` 的 option value，如 `fc4186...` 建材产品检测研究所） |
| `BY_BASE_URL` | 可选 | 内网系统入口覆盖，默认 `http://172.16.100.72:8080`；隧道部署时指向本地隧道入口（如 `http://host.docker.internal:18080`） |

代码常量：`MAX_PAGES = 5`（最大分页数）、`TIMEOUT_MS = 10000`、`TIMEOUT_FAST_MS = 5000`。

## 登录流程

ASP.NET WebForms 四步登录：

```
Step 1: GET /login.aspx
  → 提取 __VIEWSTATE, __EVENTVALIDATION
Step 2: POST /login.aspx (选择部门)
  → __EVENTTARGET=ddlDept, ddlDept=BY_DEPT_ID
Step 3: POST /login.aspx (提交凭证)
  → ddlUserName, txtLogidPwd, btnLogin=登录
  → 期望 302 重定向
Step 4: 跟随 Landing 页面 → 登录完成
```

**隧道场景注意**：IIS 的 302 `Location` 用的是站点配置端口（内网 8080），隧道部署下直接跟随会连到隧道外不存在的端口。adapter 对**同主机名**的绝对 Location 强制改用 `BY_BASE` 的 origin（端口跟随隧道入口）；内网直连场景 origin 相同，行为不变；跨主机跳转保持原样。

## 搜索

- **URL**: `GET /Customer/StandSerarch/StandInfoList.aspx?A100={keyword}&A298=`
- **响应格式**: HTML 页面，通过正则提取
- **提取字段**: `stdNo` / `stdName` / `status` / `publish` / `implement` / `siid` / `pdfPath`(hidB000)
- **分页**: POST 模拟 `AspNetPager1` postback，最多 `MAX_PAGES` 页

## 下载

两种方式（按优先级）：

1. **直接 PDF 路径**: 从搜索结果提取 `pdfPath`，拼接 `BY_BASE + pdfPath` 下载
2. **详情页**: `GET /Manager/StandManager/StandDetail.aspx?SIId={siid}` → 提取 `hidB000` → 下载

下载前 `assertDownloadedPdf` 校验 PDF 头（防 0KB/错误页）；写入前 `ensureExportsDir()` 确保导出目录存在。

## 网络层要点（隧道场景）

- BY 源使用**独立的近无 keep-alive Agent**（`createFreshAgent`，`keepAliveTimeout: 1`）：
  frp/SSH 隧道会静默关闭空闲连接，undici 默认 keep-alive 复用到已断连接会抛 `fetch failed`
  （登录/搜索/下载全链路失败）。极短保活让连接用完即关，隧道下稳定。
  注意 undici 不接受 `keepAliveTimeout: 0`（抛 `UND_ERR_INVALID_ARG`）。
- 所有请求经 `pooledFetch(url, { dispatcher: byAgent })` 传入，`src/shared/http.ts` 支持
  per-call `dispatcher` 覆盖（默认仍为全局 `httpAgent`）。

## 隧道部署（VPS / NAS 外网接入）

拓扑：

```
内网 BY (172.16.100.72:8080)
  ← frpc (stcp, secretKey) ←→ VPS frps (:bindPort)
  → VPS/NAS 本地 visitor（bindAddr=172.17.0.1, bindPort=18080）
  → StdHub 容器（extra_hosts: host.docker.internal:host-gateway）
  → BY_BASE_URL=http://host.docker.internal:18080
```

关键点：

1. **frpc（内网）**：`type = "stcp"` + `secretKey`，`localIP/localPort = 172.16.100.72:8080`
2. **frps（VPS）**：`bindPort` 放行防火墙；stcp 通道定义在 frpc 侧，frps 无需配 proxy
3. **visitor（部署机）**：`bindAddr` 用 **`172.17.0.1`**（docker0 网关）而非 `127.0.0.1`——
   容器内访问宿主机走网关地址，绑 127.0.0.1 容器连不到
4. **compose**：`extra_hosts: - "host.docker.internal:host-gateway"`
5. **`.env.local`**：`BY_BASE_URL=http://host.docker.internal:18080`

容器内 `.env.local` 以 bind mount `:ro` 挂载时，宿主文件需 `chmod 644` + `setfacl -m u:996:r`
（容器用户 stdhub uid=996）；**每次用编辑器改写 `.env.local` 后权限/ACL 可能被重置**，
若 BY 源突然报 `not accessible`，先查 `docker logs stdhub | grep env`。

## 限制

- 内网直连仅限内网网段；外网部署必须走隧道（frp/SSH），且隧道端会静默关闭空闲连接
- 登录需要 ASP.NET Session Cookie
- 搜索结果最多 5 页
- `isAvailable` 对 `BY_BASE` 根路径发 HEAD 探测，失败负缓存 60s（隧道断线后最多 60s 内
  源健康状态仍显示可用）
