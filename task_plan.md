# 项目全面审查计划

## 目标
仔细审阅由多个 AI 共同开发的 stdhub 项目，识别架构一致性、重复实现、正确性、安全性、性能、可维护性、测试与部署方面的优化点，并按优先级给出可执行建议。

## 阶段
- [complete] 阶段 1：项目结构、构建链路、入口与文档盘点
- [complete] 阶段 2：后端架构、数据层、抓取/同步与 API 审查
- [complete] 阶段 3：前端资源、样式与模块一致性审查
- [complete] 阶段 4：安全、性能、并发、错误处理与部署审查
- [complete] 阶段 5：测试覆盖、静态检查及重复代码量化
- [complete] 阶段 6：汇总高/中/低优先级建议与实施路线
- [complete] 阶段 7：实施第一批低风险高收益修复（上传安全、cron、CI 测试、Node 对齐）
- [complete] 阶段 8：实施网络边界与进程容错修复
- [complete] 阶段 9：验证、提交与推送
- [complete] 阶段 10：移除高危 xlsx 依赖，统一 ExcelJS 导入导出
- [complete] 阶段 11：收敛前端 CSS 资源真相源与缓存版本
- [complete] 阶段 12：补充安全检查、验证、提交与推送

## 审查原则
- 只报告有代码证据、能定位文件/行号的问题。
- 区分明确缺陷、技术债和可选优化。
- 未经用户要求，不直接实施大规模重构。

## Errors Encountered
| Error | Attempt | Resolution |
|---|---:|---|
| `npm audit` 使用 npmmirror 时返回 404（镜像未实现 advisories API） | 1 | 后续临时指定官方 npm registry 重跑；这是供应链检查配置缺口本身的证据。 |
| ExcelJS 动态相对导入在 Node16 moduleResolution 下缺少 `.js` 扩展名；Buffer 类型定义不兼容 | 1 | 动态导入改用 `../shared/excel.js`，Buffer 转换经 `unknown` 显式桥接。 |
| CSS 入口检查用简单 `includes('/styles.css')` 误命中 `/css/themes.css` 后缀 | 1 | 改为只匹配引号包围的完整资源路径。 |
