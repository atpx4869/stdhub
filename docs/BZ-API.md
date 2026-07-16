# BZ 源 API 备忘（bz.gxzl.org.cn）

> 实测整理（2026-05-31，以 `GB/T 3324-2017`、记录 id=2343830 为样本）。
> 字段名是 BZ 后端原始 key，adapter 在 `src/sources/shared/bz-utils.ts` 做映射。
> 沉淀此文档免得每次猜字段。

base: `https://bz.gxzl.org.cn`

## 1. 列表 / 搜索 `GET /api/gxist-standard/standardstd/list`

参数：`language=zh&current=1&size=20&keywords=<查询词>`。返回 `data.records[]`，
每条是 `BzSearchRow`。**用于标准检索 + 查新的首轮匹配**。

要点：
- `id`：BZ 内部记录主键（如 2343830）。**detail / detail-dm 都靠它定位**，不是标准号。
- `stdStatus`：**数字码**（'1'-'9'），经 `BZ_STATUS_MAP` 映射为中文：
  `1=现行有效 2=部分有效 3=即将实施 4=即将废止 5=已经废止 6=调整转号 9=其它`
- `stdNo` 标准号、`cnName` 名称、`pubDate` 发布、`actDate` 实施、`endData` 废止日期。
- `replacedStd`：**本标准代替的旧标准（前身）**，方向是"我取代了谁"，**不是**"我被谁取代"。
- 列表里 **没有 `insteadStd`**（被谁取代）——要拿"被新标准代替"必须查 detail-dm。

## 2. 详情（基础）`GET /api/gxist-standard/standardstd/detail?id=<id>`

adapter 现用此接口做 `getStandardDetail`。返回 `data` 为 `BzSearchRow` 同构。
（与 detail-dm 的字段覆盖差异未逐一比对，但替换关系字段以 detail-dm 实测为准。）

## 3. 详情（完整，元数据最全）`GET /api/gxist-standard/standardstd/detail-dm?id=<id>`

**替换 / 废止信息最全的接口**，查新"被代替"必须用它。实测关键字段：

| 字段 | 实测值（3324-2017） | 含义 |
|---|---|---|
| `stdNo` | `GB/T 3324-2017` | 标准号 |
| `cnName` | 木家具通用技术条件 | 名称 |
| `stdStatus` | `已经废止` | **状态（detail-dm 直接是中文，不是数字码！）** |
| `pubDate` | `2017-10-14` | 发布日期 |
| `actDate` | `2018-05-01` | 实施日期 |
| `endData` | `2025-05-01` | **废止日期** |
| `replacedStd` | `GB/T 3324-2008` | **本标准代替的旧标准（前身）= "我取代了谁"** |
| `insteadStd` | `GB/T 3324-2024` | **代替本标准的新标准 = "我被谁取代"**（查新"被代替"要的就是这个） |
| `preface` | 本标准代替 GB/T 3324-2008…历次版本 GB/T 3324-1995、GB/T 3324-2008 | 前言（含替换历史叙述） |
| `stdNum` | `3324` | 主号 |
| `stdYear` | `2017` | 年版 |
| `cnClass` / `icsClass` | Y80 / 【97.140】家具 | 分类 |
| `isPdf` | `true` | 有 PDF |

**易错点（这次踩的坑）**：
- `replacedStd` 与 `insteadStd` 是**相反方向**。"被谁代替"用 **`insteadStd`**；
  `replacedStd` 是前身。早期把 `replacedStd` 当"被代替"显示 → 出现"2017 被 2008 代替"的荒谬结果。
- `list` 与 `detail-dm` 的 `stdStatus` 类型不同（码 vs 中文），映射时要分别处理。

## 4. 其它已知端点

- `GET /api/gxist-standard/standardstd/read-pages?…` 预览分页
- `GET /api/gxist-standard/standardstd/read-image?no=<stdNo>&page=<n>` 预览页图
