/**
 * 一单一库 remark 字段语义解析 + 4+1 档比对状态枚举。
 *
 * 拆出来的原因：cap-lib-service 入库时算 lib_status / API 层做 diffByLab / 前端徽章组件都要
 * 引用同一套枚举值，单独成文件避免循环依赖。
 *
 * Why 4+1 档而非 2 档「在/不在库」：
 * - 实测 remark 字段 ~9% 非空，典型值包含「废止，仅限能力项目库范围内现行有效产品标准引用本标准…」
 *   这类「废止但可引用」的特殊状态 —— 用户报检时口径要求不一样
 * - 同号跨年（机构持 GB9744-2015、库内只有 GB9744-2024 active）是政策上「应换年版」的核心场景，
 *   必须独立一档让用户看到推荐替代年版
 */

/**
 * 单条入库记录的状态（解析自 remark）—— 落 cma_capability_lib.lib_status 列
 */
export type LibStatus = 'active' | 'cite_only' | 'abolished';

export const LIB_STATUS_VALUES: readonly LibStatus[] = ['active', 'cite_only', 'abolished'];

/**
 * 机构资质 vs 库 的对比状态（5 档）—— 由 diffByLab 计算
 *
 * - in_lib       保年命中 active           ✅ 绿
 * - cite_only    保年命中 cite_only        ⚠ 黄  （废止但库内允许引用）
 * - abolished    保年命中 abolished        🟠 橙 （已废止，库内不允许引用）
 * - series_only  保年未命中 + 剥年命中 active  🔴 红 （持有的年版不在库，但系列新年版在库）
 * - not_in_lib   两者都未命中              ⛔ 深红（整个标准号系列都不在库）
 *
 * UI 徽章简化为 4 档（cite_only / abolished 合并为 ⚠「已废止」），比对页用 5 档完整。
 */
export type DiffStatus = 'in_lib' | 'cite_only' | 'abolished' | 'series_only' | 'not_in_lib';

export const DIFF_STATUS_VALUES: readonly DiffStatus[] = [
  'in_lib', 'cite_only', 'abolished', 'series_only', 'not_in_lib',
];

/**
 * 把 remark 字段解析成 LibStatus。
 *
 * 已观测样本：
 * - null / ''                                    → active
 * - '废止，仅限能力项目库范围内现行有效产品标准引用本标准及监督抽检时申请'  → cite_only
 * - '废止'                                       → abolished
 * - '被 XX 替代' / '作废'                        → abolished
 * - 其它（少量备注说明文字）                     → active（保守不影响数据可用性）
 *
 * Why 顺序：cite_only 必须先于 abolished 判断 —— 后者的正则也会匹配前者文本。
 */
export function parseLibStatus(remark: string | null | undefined): LibStatus {
  if (!remark) return 'active';
  const r = remark.trim();
  if (!r) return 'active';
  // 仅限引用：含「废止」且含「仅限 / 引用 / 监督抽检」中至少一个
  if (/废止/.test(r) && /(仅限|引用|监督抽检)/.test(r)) return 'cite_only';
  if (/(废止|作废|被.{0,5}替代)/.test(r)) return 'abolished';
  return 'active';
}
