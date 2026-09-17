# 湖北省质检院资质同步优化方案

> 状态：第一批已实施（2026-09-17）：固定 profile、页面收敛、固定同步接口、快照骤降保护；调度队列与遗留代码清理待后续阶段  
> 产品范围：当前仅维护湖北省质检院一套机构数据，不再向用户提供多机构订阅能力  
> 数据来源：CNAS `L0290` + CMA `221700110366`  
> 核心原则：查询只读本地库存；在线访问只发生在手动或定时同步中；任何同步失败都不得清空上一次成功快照

## 1. 范围调整

项目早期按“多机构订阅平台”设计，因此保留了推荐订阅、手工添加、机构搜索、机构关联、删除订阅、跨机构并发等能力。产品方向后来取消多机构，当前实际只维护湖北省产品质量监督检验研究院（界面简称“湖北省质检院”）。

当前本地数据库中的固定来源为：

| 来源 | 机构名称 | 稳定标识 | 上游定位字段 | 本地记录数（方案编写时） |
|---|---|---|---|---:|
| CNAS | 湖北省质检院 | `L0290` | `baseInfoId=d0afae34c5f6426b99d8704072763256` | 7,634 |
| CMA | 湖北省产品质量监督检验研究院 | `221700110366` | `publicDetailId=LI201581410348LI5860` | 28,110 |

因此当前产品不再需要“订阅管理”模型，而应调整为：

```text
固定机构配置
  ├─ CNAS 数据源（L0290）
  └─ CMA 数据源（221700110366）
       ↓
手动或定时同步
       ↓
本地资质快照
       ↓
资质查询只读本地数据
```

## 2. 优化目标

1. 将“系统设置 → 资质订阅”改为“系统设置 → 资质数据”；
2. 页面只展示湖北省质检院的 CNAS/CMA 两个来源，不再提供自由添加、删除、搜索和关联机构；
3. 保留现有 `cnas_labs/cma_labs` 表作为来源元数据存储，避免高风险数据库重构；
4. 将初始化、同步、状态、错误、日志和自动同步收敛为固定机构工作流；
5. 保持 staging + 事务替换机制，确保失败时旧库存不丢失；
6. 保留未来恢复多机构的代码扩展点，但不在当前 UI 和业务流程中暴露。

## 3. 非目标

本轮不做：

- 不开放任意 CNAS URL/baseInfoId 添加；
- 不开放 CMA 机构搜索和订阅；
- 不提供机构关联/取消关联；
- 不支持机构级独立 Cron；
- 不需要跨机构高并发同步；
- 不把在线抓取放进资质查询请求；
- 不恢复已无限期暂停的国家 CMA；
- 不删除现有资质快照或重做抓取器数据模型。

## 4. 当前代码中应下线的多机构功能

### 4.1 前端入口

从“资质数据”页面移除或隐藏：

- 推荐订阅；
- CNAS URL/baseInfoId 添加框；
- CMA 机构名称搜索和候选列表；
- 每张机构卡片上的“删除”；
- “关联 CNAS / 关联 CMA”；
- “取消关联”；
- “同步全部实验室”这种多机构文案。

替换为固定页面：

```text
湖北省产品质量监督检验研究院

CNAS  L0290
状态 / 本地记录数 / 最近成功同步 / 最近检查 / 错误 / 同步按钮

CMA   221700110366
状态 / 本地记录数 / 最近成功同步 / 最近检查 / 错误 / 同步按钮

[同步 CNAS] [同步 CMA] [同步全部来源]
```

### 4.2 前端脚本

当前 `public/js/app-qual-lab.js` 中以下函数应退出用户可达路径：

- `loadQualPresets`
- `subscribeQualPreset`
- `searchCmaLabCandidates`
- `subscribeCmaCandidate`
- `addQualLab`
- `editQualLabName`（固定名称不需要普通编辑）
- `linkQualLab`
- `unlinkQualLab`
- `deleteQualLab`
- `CnasScraper_parseUrl`

第一阶段可以仅移除界面入口并保留函数，确认生产稳定后再删除死代码，避免一次改动过大。

### 4.3 后端接口

当前多机构写接口应停止被前端调用：

```text
POST   /api/qualifications/presets/cnas/:labNo/subscribe
POST   /api/qualifications/labs/cnas
DELETE /api/qualifications/labs/cnas/:labNo
PUT    /api/qualifications/labs/cnas/:labNo
GET    /api/qualifications/labs/cma/search
POST   /api/qualifications/labs/cma
DELETE /api/qualifications/labs/cma/:certNumber
PUT    /api/qualifications/labs/cma/:certNumber
POST   /api/qualifications/links
DELETE /api/qualifications/links/:source/:id
```

建议分两步下线：

1. 第一阶段保留后端接口但不再从 UI 暴露，并增加管理员审计日志；
2. 一个发布周期后删除无使用方的接口、前端函数和 `qualification_lab_links` 相关流程。

不要立即删除表结构，先保留数据兼容和回滚能力。

## 5. 固定机构初始化

### 5.1 事实来源

固定机构标识应进入服务端常量，不由浏览器提交数据库关键字段：

```ts
const HUBEI_QUALIFICATION_PROFILE = {
  displayName: '湖北省产品质量监督检验研究院',
  cnas: {
    labNo: 'L0290',
    baseInfoId: 'd0afae34c5f6426b99d8704072763256',
    // 保留已验证的 URL 参数
  },
  cma: {
    certNumber: '221700110366',
    publicDetailId: 'LI201581410348LI5860',
    creditCode: '12420000420003187N',
  },
} as const;
```

前端只使用后端返回的数据，不再硬编码这组标识。

### 5.2 启动自检

应用启动时执行轻量幂等自检：

1. 检查 `cnas_labs` 是否存在 `L0290`；
2. 检查 `base_info_id` 是否为固定值；
3. 检查 `cma_labs` 是否存在证书 `221700110366` 或相同 `public_detail_id`；
4. 缺失时只补机构元数据，不自动执行重型同步；
5. 标识冲突时记录高优先级告警，不静默覆盖已有数据；
6. 不清理历史快照；
7. 不因上游暂时不可达阻断应用启动。

是否自动补数据应由显式迁移完成，不建议把写库副作用散落在普通请求中。

### 5.3 CMA 证书编号变化

CMA 上游可能更新证书编号。同步时继续使用 `public_detail_id` 作为相对稳定的定位键，并在事务内迁移：

- `cma_labs.cert_number`；
- `cma_qualifications.cert_number`；
- 仍存在的其他引用表。

即使界面不再展示多机构关联，迁移逻辑仍应保证旧数据不产生悬挂引用。

## 6. 同步状态模型

固定机构只需要两个来源状态，不需要多机构订阅状态。

| 状态 | 含义 | 页面行为 |
|---|---|---|
| `uninitialized` | 元数据存在，但从未成功同步 | 显示“尚无本地数据”，提供首次同步 |
| `syncing` | 正在抓取/落库 | 显示进度，禁止同来源重复触发 |
| `ready` | 本地快照可用且最近同步正常 | 显示记录数和时间 |
| `stale` | 本地快照可用，但超过预期周期 | 允许查询旧数据，提示尽快同步 |
| `error_with_snapshot` | 最近同步失败，但存在旧快照 | 明示旧数据仍可查询及其时间 |
| `error_empty` | 首次同步失败，无本地快照 | 明示当前无可查询数据 |

数据库第一阶段可以继续使用 `pending/syncing/success/error`，由服务层结合 `record_count`、`last_sync_at`、Cron 周期映射 UI 状态，避免立即迁移枚举。

机构卡片必须区分：

```text
同步失败，但保留 7,634 条 2026-09-11 的 CNAS 数据
```

与：

```text
首次同步失败，本地尚无 CNAS 数据
```

## 7. 同步接口设计

### 7.1 固定来源接口

建议新增面向当前产品语义的接口：

```text
GET  /api/qualifications/profile
POST /api/qualifications/sync/cnas
POST /api/qualifications/sync/cma
POST /api/qualifications/sync/all
GET  /api/qualifications/sync/status
GET  /api/qualifications/sync/logs?source=CNAS|CMA&limit=30
```

`profile` 返回固定机构及两个本地来源状态：

```json
{
  "displayName": "湖北省产品质量监督检验研究院",
  "cnas": {
    "labNo": "L0290",
    "recordCount": 7634,
    "snapshotAvailable": true,
    "status": "ready",
    "lastSyncAt": "...",
    "lastCheckAt": "...",
    "lastErrorCode": "",
    "lastErrorMessage": ""
  },
  "cma": {
    "certNumber": "221700110366",
    "recordCount": 28110,
    "snapshotAvailable": true,
    "status": "ready",
    "lastSyncAt": "..."
  },
  "autoSync": {
    "enabled": false,
    "nextRunAt": null
  }
}
```

### 7.2 同步结果

```ts
type FixedSourceSyncResult = {
  source: 'CNAS' | 'CMA';
  action: 'synced' | 'checked_skip' | 'manual_forced';
  records: number;
  snapshotAvailable: boolean;
  snapshotUpdated: boolean;
  startedAt: string;
  finishedAt: string;
};
```

### 7.3 旧接口兼容

现有接口暂时保留并在内部调用同一服务：

```text
POST /api/qualifications/labs/cnas/sync?labNo=L0290
POST /api/qualifications/labs/cma/sync?certNumber=221700110366
```

固定接口稳定一个发布周期后，再决定是否移除旧的多机构写接口。

## 8. 数据安全与落库

现有 staging + 事务提升必须保留：

```text
抓取完整数据
→ 分批写 TEMP staging
→ 校验数量和基本字段
→ 事务删除该来源旧快照
→ promote 新快照
→ 更新状态与时间
```

必须满足：

- 上游请求失败：旧快照不动；
- staging 写入失败：旧快照不动；
- promote 失败：事务回滚；
- 空结果不能默认覆盖非空快照；
- 上游确实返回“合法 0 条”时，需要显式的空结果确认机制，不能仅凭数组为空清库；
- 超过 `MAX_QUALIFICATIONS_PER_LAB` 时停止，不覆盖旧快照；
- 应增加最低记录数异常告警，例如从数千条突然降为个位数时要求人工确认或第二次抓取。

### 8.1 建议增加快照质量闸门

固定机构数据规模相对稳定，可增加保护：

```text
若新记录数 < max(100, 旧记录数 × 20%)
→ 标记 suspicious_snapshot
→ 不自动 promote
→ 保留旧快照并要求重试/人工确认
```

阈值应配置化，首次同步不适用比例判断，只使用绝对下限和结构校验。

## 9. 自动同步优化

### 9.1 只保留一个资质周期

当前只有固定机构，不需要机构级 Cron。继续使用：

```text
autosync_enabled
autosync_qual_enabled
autosync_qual_cron
```

默认资质 Cron：`0 3 * * 0`（每周日 03:00）。一个周期内固定顺序：

```text
CNAS → CMA
```

如 CNAS 失败，仍继续 CMA；周期结果分别记录，不因一个来源失败阻断另一个来源。

### 9.2 重型任务统一互斥

资质同步与 CMA 一单一库同步默认都可能在周日 03:00 触发。应使用统一队列：

```ts
enqueueCycle(kind: 'qualification' | 'capability-library' | 'all', trigger: 'cron' | 'manual')
```

规则：

1. 全局只运行一个重型同步周期；
2. 同类型已运行或已排队时去重；
3. 同刻触发按固定顺序串行；
4. 不静默丢弃 Cron：排队或记录明确的 skip 原因；
5. `running`、当前任务、开始时间、排队任务必须真实反映状态；
6. 手动触发与 Cron 共用同一把锁。

### 9.3 配置清理

| 配置 | 处理 |
|---|---|
| `autosync_enabled` | 保留 |
| `autosync_qual_enabled` | 保留 |
| `autosync_qual_cron` | 保留 |
| `autosync_caplib_enabled` | 保留 |
| `autosync_caplib_cron` | 保留 |
| `qual_sync_concurrency` | 当前固定两来源且顺序执行，可停止暴露；兼容期保留读取 |
| `qual_sync_enabled` | 无读取方，迁移删除 |
| `qual_sync_cron` | 无读取方，迁移删除 |

`next_sync_at` 当前是闲置机构级字段。固定机构共用全局 Cron，不需要分别维护，建议最终删除，只使用 `/api/auto-sync/status.nextQualRunAt`。

## 10. 错误分类与重试

| 错误类型 | 例子 | 自动重试 |
|---|---|---|
| 固定配置错误 | baseInfoId/publicDetailId 缺失 | 不重试，启动自检告警 |
| 上游永久错误 | 机构详情不存在、证书撤销 | 不重试，人工处理 |
| 网络瞬时错误 | reset、DNS、timeout | 指数退避 2 次 |
| 限流 | 429/503 | 尊重 `Retry-After`，长退避 2 次 |
| CNAS 反爬 | 521、非 JSON 挑战页 | 页面内短重试；周期级长退避 1 次 |
| 浏览器瞬时错误 | target/context/browser closed | 重建一次 |
| 上游结构变化 | 必填字段缺失、schema 不符 | 不盲目重试，保留旧快照并告警 |
| 数据质量异常 | 新记录数骤降 | 不 promote，二次抓取或人工确认 |
| 数据库事务失败 | staging 正常、提升失败 | 不在线重试，保留旧快照 |

建议退避：

```text
网络/超时：30s → 120s
429/503：120s → 600s
反爬：页面内 1.5s × 3；周期级等待 5–15 分钟后再试一次
浏览器关闭：立即重建一次
```

CNAS/CMA 更新检查策略统一为：

```text
检查成功且无变化 → checked_skip
瞬时检查失败 → 记录 warning，降级全量抓取
永久检查失败 → 结束并告警
```

## 11. 前端页面方案

将“资质订阅”改为“资质数据”，建议结构：

### 11.1 总览

```text
湖北省产品质量监督检验研究院
本地总记录：35,744
自动同步：已关闭
下一次同步：—
```

### 11.2 来源卡片

CNAS 卡片：

- CNAS L0290；
- 本地记录数；
- 最近成功同步；
- 最近检查；
- 本地快照状态；
- 同步进度/错误；
- “同步 CNAS”按钮。

CMA 卡片结构对称。

### 11.3 操作区

- 同步全部来源；
- 仅重试失败来源；
- 查看同步日志；
- 前往自动同步设置。

不提供添加、删除、关联、改名等机构管理功能。

### 11.4 文案

原文：

> CNAS / CMA 机构能力数据，订阅后定时同步至本地。

建议改为：

> 维护湖北省质检院 CNAS/CMA 能力数据。查询使用本地快照；可手动更新，也可在“自动同步”中启用定时更新。

## 12. 分阶段实施

### Phase 0：测试锁定与备份

- 备份 `data/bzxz.db`；
- 执行 `PRAGMA integrity_check`；
- 增加固定 profile 测试；
- 增加查询纯本地回归测试；
- 增加旧快照保护和异常骤降测试；
- 记录当前 CNAS/CMA 稳定标识和记录数。

验收：测试能覆盖固定机构初始化、同步和查询边界。

### Phase 1：页面收敛

- “资质订阅”更名“资质数据”；
- 移除多机构添加、搜索、删除、关联入口；
- 展示固定机构的 CNAS/CMA 来源卡片；
- 前端日志改用规范路径；
- 错误不再 silent catch；
- 明确自动同步开关状态。

验收：普通管理员无法通过 UI 添加第二家机构；固定两来源状态清晰。

### Phase 2：固定 profile 服务

- 服务端增加 `HUBEI_QUALIFICATION_PROFILE`；
- 增加幂等元数据自检/迁移；
- 新增固定 profile/status/sync 接口；
- 旧接口内部复用同一同步服务；
- 保留现有 staging + 事务提升。

验收：新库可以初始化固定元数据；旧库无数据丢失；同步成功更新本地快照。

### Phase 3：数据质量与错误状态

- 增加错误代码；
- 增加旧快照可用状态；
- 增加记录数骤降闸门；
- 统一 CNAS/CMA 更新检查降级；
- 根据错误类型重试。

验收：异常空结果/骤降不能清空有效快照；永久错误零重试。

### Phase 4：调度互斥

- 重型任务统一队列；
- 修复 `state.running`；
- 手动/Cron 共用互斥；
- 同刻任务串行；
- 状态 API 展示当前和排队任务。

验收：模拟周日 03:00 双任务，不并发、不静默丢任务。

### Phase 5：多机构遗留清理

一个版本周期稳定后：

- 删除不可达前端函数；
- 删除推荐订阅和机构搜索接口；
- 删除机构关联接口与相关 UI；
- 评估迁移/删除 `qualification_lab_links`；
- 删除 `qual_sync_enabled` / `qual_sync_cron`；
- 删除或弃用机构级 `next_sync_at`；
- 更新架构、TODO、WORKLOG。

## 13. 测试矩阵

### 13.1 固定配置

- CNAS L0290 元数据存在/缺失/错误；
- CMA 证书和 publicDetailId 存在/缺失/变更；
- 启动自检幂等；
- 自检不执行重型网络同步；
- 标识冲突不会静默覆盖。

### 13.2 同步安全

- CNAS/CMA 首次同步成功；
- 检查无变化返回 `checked_skip`；
- 抓取失败保留旧快照；
- staging 写入失败回滚；
- promote 失败回滚；
- 合法非空快照正常替换；
- 异常空结果、记录骤降被拦截；
- 同来源重复触发共享/拒绝；
- CNAS 失败不阻断 CMA。

### 13.3 查询

- 所有资质查询接口零在线调用；
- CNAS/CMA 各自只查本地快照；
- 旧快照状态为 error 时仍可查询；
- 无快照时返回明确空状态，不触发同步。

### 13.4 调度

- 总开关关闭时不排期；
- 手动同步不受总开关影响且文案明确；
- 手动和 Cron 不重复运行；
- 资质和能力库同刻触发时串行；
- 锁在成功/失败后都释放；
- 重启后重新计算 next run。

### 13.5 前端

- 只显示固定机构；
- 无添加/删除/关联入口；
- 两来源状态和错误准确；
- 同步中按钮防重复；
- 离开页面再进入可恢复状态；
- Paper/Legacy、桌面/390px 移动端可用。

## 14. 发布与回滚

### 发布顺序

1. 数据库备份和完整性检查；
2. 发布测试与固定 profile 后端兼容层；
3. 发布收敛后的前端；
4. 观察一次手动 CNAS/CMA 同步；
5. 观察一个自动同步周期；
6. 最后清理多机构死代码和旧配置。

### 监控

记录：

- 来源、触发方式、开始/结束时间；
- 抓取条数、最终写入条数、与旧快照差异比例；
- 是否保留旧快照；
- 错误代码和重试次数；
- 下一次同步时间、实际开始时间和漂移；
- 当前/排队任务。

### 回滚

- 新增 profile API 可回滚，旧同步接口保留一个版本周期；
- 数据库新增字段向后兼容，不要求回滚时删除；
- 多机构后端接口在最后一阶段才删除；
- staging + 事务替换始终保留；
- 调度队列重构独立发布，必要时可切回旧调度器；
- 不在同一版本里同时做页面收敛、表删除和调度重构。

## 15. 最终验收标准

1. 系统设置只展示湖北省质检院，不再暴露多机构订阅功能；
2. CNAS L0290 和 CMA 221700110366 状态独立、清晰；
3. 查询始终只读本地库存；
4. 手动和定时同步使用同一服务与互斥机制；
5. 任意同步失败都不会清空上一次成功快照；
6. 异常空结果或记录骤降不能直接覆盖有效数据；
7. 自动同步开关、下一次时间和当前任务真实可见；
8. 确定性错误不重试，瞬时错误按策略退避；
9. 一个来源失败不阻断另一个来源；
10. build、CSS 检查、全量 Vitest、两套 E2E、Docker 冒烟和数据库完整性检查全部通过。

## 16. 推荐实施顺序

Phase 0–2 的第一批已落地：固定机构事实已由常量与测试锁定；设置页已收敛为“资质数据”；新增固定 profile/status/sync 接口；自动资质周期改为只同步固定两来源；异常空结果/记录骤降会被安全闸门拒绝并保留旧快照。后续继续实施 Phase 3–4 的错误分类和统一调度队列。多机构死代码、旧接口与表结构清理仍放在最后，避免不可逆迁移。
