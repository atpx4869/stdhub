# gbw 源实现文档

> 状态：**已实现** — adapter 位于 `src/sources/gbw/gbw-adapter.ts`
>
> 以下为早期勘察记录，保留供后续维护参考。

---

本文档记录 `gbw` 源的接入方式和勘察过程。第一阶段目标是梳理页面结构、字段来源、全文入口能力和实现边界。

---

## 1. 源概览

### 1.1 源站点

当前 `gbw` 实际对应两套官方站点：

1. **全国标准信息公共服务平台**
   - 域名：`std.samr.gov.cn`
   - 作用：国家标准目录检索、标准详情元数据

2. **国家标准全文公开系统**
   - 域名：`openstd.samr.gov.cn`
   - 作用：公开标准的在线预览 / 下载入口

### 1.2 当前样例链接

- 搜索页：
  - `https://std.samr.gov.cn/gb/gbQuery`
- 目录详情页：
  - `https://std.samr.gov.cn/gb/search/gbDetailed?id=25940C3CEF158A9AE06397BE0A0A525A`
- 全文公开页：
  - `https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=96019B083A5A59FC7F84895DFFE7500B`

### 1.3 当前定位

`gbw` 与 `bz.zhenggui.vip` 不同，它目前更像：

- **官方元数据源**
- **官方公开全文入口源**

而不是“自定义分页预览图片源”。

也就是说，后续实现时不应默认复用 `bz` 的“分页 JPEG → 合并 PDF”思路。

---

## 2. 当前已确认事实

## 2.1 `std.samr.gov.cn/gb/gbQuery`

已确认：

- 搜索页是可访问的国家标准目录查询入口
- 页面不是 SPA 壳页，服务端 HTML 可直接拿到大量结构信息
- 页面上存在：
  - 检索输入框
  - 高级检索入口
  - ICS 分类筛选
  - 结果表格容器 `#gbtable`

当前尚未完全确认：

- 搜索结果是否通过前端表格组件异步加载
- 搜索提交具体使用的接口/参数

现已新增确认：

- 存在可直接调用的 JSON 搜索接口：
  - `https://std.samr.gov.cn/gb/search/gbQueryPage?searchText=<keyword>&page=1&pageSize=5`
- 返回结构为：
  - `total`
  - `pageNumber`
  - `rows[]`
- `rows[]` 已确认字段包括：
  - `id`
  - `C_STD_CODE`
  - `C_C_NAME`
  - `STD_NATURE`
  - `ACT_DATE`
  - `STATE`
  - `ISSUE_DATE`

这意味着 `gbw` 的搜索第一阶段可以直接走官方 JSON 接口，不必依赖浏览器。

## 2.2 `std.samr.gov.cn/gb/search/gbDetailed?id=...`

已确认：

- 目录详情页是服务端渲染 HTML
- 可稳定拿到以下元数据：
  - 标准号
  - 中文标准名称
  - 英文标准名称
  - 标准状态
  - 发布日期
  - 实施日期
  - 替代标准
  - ICS / CCS
  - 归口单位
  - 主管部门
  - 起草单位
  - 起草人
  - 相近标准 / 相关标准

这意味着：

- `gbw` 的 **detail** 能力应优先接 `std.samr.gov.cn`
- 元数据抽取难度比 `bz` 更低，稳定性也更高

## 2.3 `openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=...`

已确认：

- 页面为全文公开详情页
- 页面存在以下按钮或功能项：
  - 在线预览
  - 下载标准
  - 实施信息反馈
- 页面脚本中包含：

```js
showGb(gbCode, 'online')
showGb(gbCode, 'download')
```

并进一步跳转到：

```text
http://c.gb688.cn/bzgk/gb/showGb?type=online&hcno=<hcno>
http://c.gb688.cn/bzgk/gb/showGb?type=download&hcno=<hcno>
```

这说明：

- `gbw` 的全文访问入口不是当前页面直接内嵌出来的
- 真正的在线预览 / 下载行为还需要继续勘察 `c.gb688.cn`

现已新增确认：

- `showGb?type=download&hcno=...` 返回的是验证码页 HTML，不是直接文件流
- 页面中包含：
  - `#verifyCode` 输入框
  - `gc?...` 验证码图片
  - `checkCode()` 提交动作
- 验证码图片地址为：
  - `http://c.gb688.cn/bzgk/gb/gc?_<timestamp>`
- 验证码图片请求依赖：
  - 同一个 `JSESSIONID`
  - `Referer: showGb?type=download...`

这意味着 `gbw` 下载能力应被建模为：

- **captcha-assisted download flow**
- 而不是无交互直接下载

---

## 3. 当前实现建议定位

基于当前已确认信息，`gbw` 建议在项目中先按以下能力定位：

### 第一阶段

- `searchStandards`
- `getStandardDetail`
- `detectPreview`（仅提取官方公开全文入口，不做分页）

### 第二阶段

- `exportStandard`
  - 需要在确认 `showGb?type=download` 行为后再决定

### 当前最合理的建模方式

`gbw` 当前更适合被建模为：

> **metadata + public preview/download entry source**

而不是：

> **page-image preview/export source**

---

## 4. 建议的 adapter 实现边界

后续如果开始写 `src/sources/gbw/`，建议优先只做下面这些：

### 4.1 `searchStandards(query)`

目标：

- 返回国家标准目录检索结果

当前已确认：

- 可直接使用 `gbQueryPage`
- 结果页分页参数可包含：
  - `searchText`
  - `page`
  - `pageSize`

仍待确认：

- 更完整筛选参数集合
- 是否存在其他稳定排序/筛选参数

### 4.2 `getStandardDetail(id)`

目标：

- 从 `std.samr.gov.cn/gb/search/gbDetailed?id=...` 抽元数据

当前已确认可以拿到：

- 标准号
- 标准名称
- 英文名
- 标准状态
- 发布日期
- 实施日期
- 替代标准
- 分类号
- 主管/归口
- 起草单位/人

### 4.3 `detectPreview(id)`

目标：

- 找到该标准是否存在公开全文入口
- 提取 `hcno`
- 构造官方预览入口和下载入口

当前可以先返回：

- `previewUrl`
- `downloadUrl`
- `hcno`
- `sourcePageUrl`

### 4.4 `exportStandard(id)`

当前不要直接实现成自动无交互下载。

原因：

- 已确认 `download` 链路需要验证码
- 尚未确认 `checkCode()` 的提交接口与成功后的真实文件流行为

因此第一阶段可以暂定：

- 先实现 `createDownloadSession` / `submitDownloadCaptcha` 这类两段式能力
- 或者在统一接口下先只返回“官方下载入口 + 需要验证码”的事实

---

## 5. 与现有 bz 源的区别

## 5.1 相同点

- 都可以抽象为统一 `SourceAdapter`
- 都需要 `search/detail/preview/export` 四段能力来思考
- 都应保留原始源字段 `meta/raw/moreInfo`

## 5.2 不同点

### bz

- 搜索是 SPA + 动态签名接口
- 详情依赖浏览器行为
- 预览是分页图片资源
- 导出走分页 JPEG 合并 PDF

### gbw

- 搜索/详情更接近传统服务端页面
- 详情元数据更完整更规范
- 全文访问走官方公开系统和 `showGb` 跳转
- 当前没有证据表明它应按分页图片抓取实现

因此：

> `gbw` 不能简单复制 `bz` 的 export 逻辑。

---

## 6. 当前勘察脚本

已创建：

- `scripts/sources/gbw/inspect-source.ts`
- `scripts/sources/gbw/inspect-detail.ts`
- `scripts/sources/gbw/inspect-openstd.ts`
- `scripts/sources/gbw/inspect-showgb.ts`

用途：

- `inspect-source.ts`
  - 勘察目录搜索页行为
- `inspect-detail.ts`
  - 勘察 `std.samr.gov.cn` 详情页结构
- `inspect-openstd.ts`
  - 勘察全文公开页与 `showGb` 跳转线索
- `inspect-showgb.ts`
  - 勘察 `showGb` 下载页、验证码页与后续请求

---

## 7. 待确认问题

后续继续勘察时，优先解决下面这些问题：

### 7.1 搜索结果接口

- 搜索页是否存在 AJAX 接口
- 结果分页如何控制
- 是否可直接通过 URL 参数拿结果

### 7.2 `id` 与 `hcno` 的关系

当前已经看到：

- `std.samr.gov.cn` 详情使用 `id=...`
- `openstd.samr.gov.cn` 详情使用 `hcno=...`

待确认：

- 两者如何稳定映射
- 是否能通过详情页或搜索结果直接双向拿到

### 7.3 `showGb` 真正行为

需要继续确认：

- `type=online` 是否进入在线阅读器
- `type=download` 是否直接返回文件
- 是否需要验证码
- 是否需要登录
- 是否存在跳转链或临时下载地址

### 7.4 是否存在页级预览资源

当前没有证据表明 `gbw` 使用 `bz` 那样的分页图片链路。

所以必须确认：

- 是否存在可枚举的单页资源
- 还是只有官方阅读器/文件流

---

## 8. 当前建议的接入顺序

建议按以下顺序继续：

1. 完成 `gbw` 搜索页行为勘察
2. 明确 `id -> hcno` 的映射关系
3. 勘察 `showGb?type=online/download`
4. 再决定 `exportStandard` 的实现策略
5. 最后再创建 `src/sources/gbw/` adapter

---

## 9. 当前结论

在当前证据下，`gbw` 最适合的初始定义是：

> **官方国家标准源：元数据强、公开全文入口明确，但预览/下载机制独立于详情页，需要进一步勘察。**

因此，后续接入时应优先实现：

- 搜索
- 详情
- 公开全文入口发现

而不是直接照搬 `bz` 的分页导出模型。
