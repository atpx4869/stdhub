/**
 * 国家 CMA 能力项目库（"一单一库"）的 11 个顶层领域。
 *
 * Why 硬编码而非动态拉远端 /system/domain/list：
 * 1) 远端 list 接口实测一次返回 154 条（11 顶层 + 143 子领域），但 `standardData/list?domain=`
 *    **只接顶层名**（实测 `domainId` / 子领域名都返回 0 行），子领域对查询无用
 * 2) 顶层 11 个是政策性命名，市场监管总局多年未变，每天递增的是库内条目数而非领域结构
 * 3) 写死避免每次同步前都先抖一次 /domain/list，前端 UI 也能立即拿到列表
 *
 * 守门：CI 加一个网络可达时的测试，对比顶层名与远端是否一致；漏 case 时打红，提醒手动加。
 *
 * 数量是 2026-06 抓取实测，会持续增长，仅作 UI 默认显示用，真实数量以同步后
 * cma_capability_lib_meta.remote_total 为准。
 */
export interface CapLibDomain {
  /** 顶层领域名，作为 standardData/list 接口的 domain 参数值 */
  name: string;
  /** 默认是否给用户预勾选 */
  recommendedDefault: boolean;
  /** 2026-06 抓取时的远端 total，仅用于首次 UI 显示估算同步耗时 */
  approxCount: number;
}

export const CAP_LIB_DOMAINS: readonly CapLibDomain[] = [
  // 占库 80% 的最大领域，对覆盖最广的实验室最相关
  { name: '产品质量检验',            recommendedDefault: true,  approxCount: 41285 },
  { name: '食品检验',                recommendedDefault: true,  approxCount: 4047  },
  { name: '农产品质量检验',          recommendedDefault: false, approxCount: 2114  },
  { name: '医疗器械检验',            recommendedDefault: false, approxCount: 1623  },
  { name: '生态环境监测',            recommendedDefault: false, approxCount: 1198  },
  { name: '司法鉴定检测',            recommendedDefault: false, approxCount: 463   },
  { name: '进出口商品检验',          recommendedDefault: false, approxCount: 442   },
  { name: '林业产品质量检验',        recommendedDefault: false, approxCount: 373   },
  { name: '化妆品检验',              recommendedDefault: false, approxCount: 337   },
  { name: '机动车排放、安全技术检验', recommendedDefault: false, approxCount: 18    },
  { name: '林木种子、草种质量检验',   recommendedDefault: false, approxCount: 10    },
] as const;

export const CAP_LIB_DOMAIN_NAMES: readonly string[] = CAP_LIB_DOMAINS.map(d => d.name);

export function isValidCapLibDomain(name: string): boolean {
  return CAP_LIB_DOMAIN_NAMES.includes(name);
}
