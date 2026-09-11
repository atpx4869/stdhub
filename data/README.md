# 运行数据

本目录只存运行时数据。`bzxz.db`、`cma_national.db`、WAL/SHM、导出、备份、日志和预览缓存均由部署实例拥有，不进入 Git。

国家 CMA 当前无限期暂停；`cma_national.db` 仅保留为本机历史数据，不是 seed，也不是发布资产。恢复数据源前必须新增 ADR，并明确合规数据入口、place_id 建模、迁移与测试方案。
