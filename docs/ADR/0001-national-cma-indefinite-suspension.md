# ADR 0001：国家 CMA 无限期暂停

- 状态：Accepted
- 日期：2026-08-10
- 适用版本：v1.4.17 之后

## 决策

国家 CMA 功能无限期暂停。Web/NAS 生产服务不得自动抓取、同步或展示国家 CMA 匹配徽章。

保留：

- 历史数据库记录，只读；
- `scripts/cma_fetch_place.py`、`scripts/cma_search.py`，仅作为离线研究工具；
- 只读状态、历史机构和历史搜索 API。

禁止：

- 生产装配默认构造 `PythonCmaProvider`；
- 自动同步调度调用国家 CMA；
- 订阅、取消订阅、同步、批量徽章匹配写接口；
- 在搜索、资质、文件库和 Labr 页面展示机构级国家 CMA 匹配徽章；
- 单个 AI 或普通维护提交自行恢复功能。

## 原因

当前官方数据应按“证书 → 场所 → 能力”建模，而现有 Web 实现是机构级聚合，可能把某场所能力扩大为整个机构能力；同时真实站点包含验证要求，不适合作为 NAS 后台默认自动抓取链路。

## 生产门禁

- `NatCmaService` 默认使用 `NationalCmaProviderUnavailable`。
- 国家 CMA 数据变更和徽章 API 返回 `503 / NAT_CMA_SUSPENDED`。
- 自动同步不持有国家 CMA service。
- `/api/health` 标记 `features.natCma.state = suspended`，但服务整体保持健康。
- 前端只显示暂停公告。

## 恢复条件

必须同时满足：

1. 获得稳定、合规的数据入口或审核后的离线数据；
2. 完成 place_id 级建模、匹配和 UI；
3. 同步过程可限频、暂停、追溯并原子替换；
4. 通过专门 ADR 和人工审批；
5. 完整回归测试和部署验证通过。
