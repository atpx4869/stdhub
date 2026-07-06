# by 源实现文档

## 概述

by 源对接 **标院内网标准管理系统** (`http://172.16.100.72:8080`)，是一个基于 ASP.NET WebForms 的内网系统，需要登录后才能搜索和下载标准。

## 关键配置

| 配置项 | 值 | 说明 |
|--------|-----|------|
| `BY_BASE` | `http://172.16.100.72:8080` | 内网地址 |
| `LOGIN_URL` | `/login.aspx` | 登录页 |
| `DEPT_ID` | `fc4186fba640402188b91e6bd0d491a6` | 部门 ID |
| `USERNAME` | `leiming` | 用户名 |
| `PASSWORD` | `888888` | 密码 |
| `MAX_PAGES` | `5` | 最大分页数 |

## 登录流程

ASP.NET WebForms 典型三步登录：

```
Step 1: GET /login.aspx
  → 提取 __VIEWSTATE, __EVENTVALIDATION

Step 2: POST /login.aspx (选择部门)
  → __EVENTTARGET=ddlDept
  → ddlDept=DEPT_ID

Step 3: POST /login.aspx (提交凭证)
  → ddlUserName, txtLogidPwd, btnLogin=登录
  → 期望 302 重定向

Step 4: 跟随 Landing 页面 → 登录完成
```

## 搜索

- **URL**: `GET /Customer/StandSerarch/StandInfoList.aspx?A100={keyword}&A298=`
- **响应格式**: HTML 页面，通过正则提取
- **提取字段**:
  - `stdNo` - 标准号
  - `stdName` - 标准名称
  - `status` - 标准状态
  - `publish` - 发布日期
  - `implement` - 实施日期
  - `siid` - 标准信息 ID
  - `pdfPath` - PDF 文件路径 (hidB000)
- **分页**: 通过 POST 模拟 `AspNetPager1` postback

## 下载

两种方式（按优先级）：

1. **直接 PDF 路径**: 从搜索结果中提取 `pdfPath`，拼接 `BY_BASE + pdfPath` 下载
2. **详情页**: `GET /Manager/StandManager/StandDetail.aspx?SIId={siid}` → 提取 `hidB000` → 下载

## 限制

- 仅在内网环境可用（`172.16.100.x` 网段）
- 登录需要 ASP.NET Session Cookie
- 搜索结果可能有分页限制（最多 5 页）
