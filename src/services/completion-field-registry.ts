import {
  COMPLETION_REGISTRY_VERSION,
  type CompletionFieldDefinition,
  type CompletionFieldGroup,
  type CompletionPlan,
  type CompletionPreset,
} from '../domain/completion';
import { BadRequestError } from '../shared/errors';

const GROUPS: CompletionFieldGroup[] = [
  { groupId: 'standard', label: '基础信息', order: 10 },
  { groupId: 'lifecycle', label: '生命周期', order: 20 },
  { groupId: 'classification', label: '分类属性', order: 30 },
  { groupId: 'relation', label: '替代关系', order: 40 },
  { groupId: 'local', label: '本地文件', order: 50 },
  { groupId: 'content', label: '正文检测', order: 60 },
  { groupId: 'trace', label: '追溯诊断', order: 70 },
  { groupId: 'advanced', label: '高级审计', order: 80 },
];

function field(
  fieldId: string,
  label: string,
  groupId: string,
  order: number,
  options: Partial<CompletionFieldDefinition> = {},
): CompletionFieldDefinition {
  return {
    fieldId,
    label,
    groupId,
    order,
    description: options.description ?? label,
    valueType: options.valueType ?? 'string',
    source: options.source ?? '胜出标准来源',
    coverage: options.coverage ?? 'high',
    cost: options.cost ?? 'L0',
    enabled: options.enabled ?? true,
    defaultSelected: options.defaultSelected ?? false,
    requiresDetail: options.requiresDetail ?? false,
    requiresLocalFile: options.requiresLocalFile ?? false,
    requiresContentDetection: options.requiresContentDetection ?? false,
    capability: options.capability ?? 'available',
    unavailableReason: options.unavailableReason,
  };
}

const FIELDS: CompletionFieldDefinition[] = [
  field('standard.number.canonical', '规范标准号', 'standard', 10, { defaultSelected: true }),
  field('standard.title.zh', '中文名称', 'standard', 20, { defaultSelected: true }),
  field('standard.title.en', '英文名称', 'standard', 30, { requiresDetail: true, coverage: 'medium', cost: 'L2', source: 'BZ 详情' }),
  field('lifecycle.status', '标准状态', 'lifecycle', 10, { defaultSelected: true, valueType: 'enum' }),
  field('lifecycle.publishDate', '发布日期', 'lifecycle', 20, { defaultSelected: true, valueType: 'date' }),
  field('lifecycle.implementDate', '实施日期', 'lifecycle', 30, { defaultSelected: true, valueType: 'date' }),
  field('lifecycle.abolishedDate', '废止日期', 'lifecycle', 40, { valueType: 'date', coverage: 'medium' }),
  field('classification.level', '标准层级', 'classification', 10, { source: '标准号可靠推导' }),
  field('classification.type', '标准类别', 'classification', 20, { coverage: 'medium' }),
  field('classification.nature', '标准性质', 'classification', 30, { source: '标准号/BZ' }),
  field('classification.ics', 'ICS 分类号', 'classification', 40, { requiresDetail: true, coverage: 'medium', cost: 'L2', source: 'BZ 详情' }),
  field('classification.ccs', 'CCS 分类号', 'classification', 50, { requiresDetail: true, coverage: 'medium', cost: 'L2', source: 'BZ 详情' }),
  field('relation.replacesNumbers', '代替标准号', 'relation', 10, { defaultSelected: true, coverage: 'medium', source: 'BZ replacedStd' }),
  field('relation.replacedByNumbers', '被替代标准号', 'relation', 20, {
    defaultSelected: true,
    requiresDetail: true,
    coverage: 'medium',
    cost: 'L2',
    source: 'BZ detail-dm.insteadStd',
  }),
  field('local.fileState', '本地文件状态', 'local', 10, { defaultSelected: true, requiresLocalFile: true, cost: 'L1', valueType: 'enum', source: 'standard_files' }),
  field('local.fileName', '本地文件名', 'local', 20, { requiresLocalFile: true, cost: 'L1', source: 'standard_files' }),
  field('local.fileFormat', '文件格式', 'local', 30, { requiresLocalFile: true, cost: 'L1', source: 'standard_files' }),
  field('local.fileSizeBytes', '文件大小（字节）', 'local', 40, { requiresLocalFile: true, cost: 'L1', valueType: 'integer', source: 'standard_files' }),
  field('library.ingestedAt', '本地索引时间', 'local', 50, { requiresLocalFile: true, cost: 'L1', source: 'standard_files' }),
  field('content.detectionState', '正文检测状态', 'content', 10, {
    defaultSelected: true,
    requiresLocalFile: true,
    valueType: 'enum',
    capability: 'status_only',
    description: '当前仅如实输出未执行或不适用；真实文本层检测器尚不可用',
    unavailableReason: '真实 PDF 文本层检测能力尚未启用',
  }),
  field('content.hasTextLayer', '是否含文本层', 'content', 20, {
    defaultSelected: true,
    requiresLocalFile: true,
    valueType: 'enum',
    capability: 'status_only',
    description: '当前只能输出未检测/不适用，绝不使用 previewAvailable 或 contentText 推断',
    unavailableReason: '真实 PDF 文本层检测能力尚未启用',
  }),
  field('trace.source', '采用来源', 'trace', 10, { cost: 'L0' }),
  field('match.method', '匹配方式', 'trace', 20, { cost: 'L0', valueType: 'enum' }),
  field('match.state', '查询/匹配状态', 'trace', 30, { defaultSelected: true, coverage: 'diagnostic', valueType: 'enum' }),
  field('quality.warnings', '质量提示', 'trace', 40, { coverage: 'diagnostic' }),
  field('error.summary', '异常摘要', 'trace', 50, { coverage: 'diagnostic' }),
  field('standard.prefix', '标准号前缀', 'advanced', 10),
  field('standard.sequence', '标准顺序号', 'advanced', 20),
  field('standard.part', '部分号', 'advanced', 30),
  field('standard.year', '年代号', 'advanced', 40),
  field('match.candidateNumbers', '候选标准号', 'advanced', 50, { coverage: 'diagnostic' }),
  field('trace.sourceRecordId', '来源记录 ID', 'advanced', 60),
  field('trace.detailUrl', '来源详情链接', 'advanced', 70, { valueType: 'url' }),
  field('audit.originalRow', '原始行号', 'advanced', 80, { source: '输入工作簿' }),
  field('local.relativePath', '本地相对路径', 'advanced', 90, { requiresLocalFile: true, cost: 'L1', source: '标准库相对路径' }),
  field('local.sha256', '本地文件 SHA-256', 'advanced', 100, { enabled: false, requiresLocalFile: true, cost: 'L3', unavailableReason: '首版不对大量文件主动计算哈希' }),
  field('local.pageCount', '本地文件页数', 'advanced', 110, { enabled: false, requiresLocalFile: true, cost: 'L3', unavailableReason: '未引入可靠 PDF 页数解析依赖' }),
];

const PRESETS: CompletionPreset[] = [
  {
    presetId: 'common', label: '常用补全', description: '基础名称、生命周期与双向替代关系（固定导出顺序）', detectionPolicy: 'none',
    fieldIds: [
      'standard.number.canonical',
      'standard.title.zh',
      'standard.title.en',
      'lifecycle.status',
      'lifecycle.publishDate',
      'lifecycle.implementDate',
      'lifecycle.abolishedDate',
      'relation.replacesNumbers',
      'relation.replacedByNumbers',
    ],
  },
  {
    presetId: 'lifecycle', label: '生命周期检查', description: '检查状态、日期和替代关系', detectionPolicy: 'none',
    fieldIds: ['standard.number.canonical', 'standard.title.zh', 'lifecycle.status', 'lifecycle.publishDate', 'lifecycle.implementDate', 'lifecycle.abolishedDate', 'relation.replacesNumbers', 'relation.replacedByNumbers'].filter(id => FIELDS.find(item => item.fieldId === id)?.enabled),
  },
  {
    presetId: 'classification', label: '分类清单', description: '输出层级、类别、性质、ICS 和 CCS', detectionPolicy: 'none',
    fieldIds: ['standard.number.canonical', 'standard.title.zh', 'classification.level', 'classification.type', 'classification.nature', 'classification.ics', 'classification.ccs'],
  },
  {
    presetId: 'files', label: '文件盘点', description: '盘点本地文件；真实文本层检测器未启用，相关字段仅输出未检测/不适用', detectionPolicy: 'none',
    fieldIds: ['standard.number.canonical', 'standard.title.zh', 'local.fileState', 'content.detectionState', 'content.hasTextLayer', 'local.fileName', 'local.fileFormat', 'local.fileSizeBytes', 'library.ingestedAt'],
  },
  {
    presetId: 'audit', label: '追溯审计', description: '输出来源、匹配方式、状态、质量提示与异常', detectionPolicy: 'none',
    fieldIds: ['standard.number.canonical', 'standard.title.zh', 'trace.source', 'match.method', 'match.state', 'quality.warnings', 'error.summary'],
  },
];

export class CompletionFieldRegistry {
  readonly registryVersion = COMPLETION_REGISTRY_VERSION;
  private readonly byId = new Map(FIELDS.map(item => [item.fieldId, item]));

  listFields(): CompletionFieldDefinition[] {
    return FIELDS.map(item => ({ ...item }));
  }

  listGroups(): CompletionFieldGroup[] {
    return GROUPS.map(item => ({ ...item }));
  }

  listPresets(): CompletionPreset[] {
    return PRESETS.map(item => ({ ...item, fieldIds: [...item.fieldIds] }));
  }

  validate(fieldIds: string[]): CompletionFieldDefinition[] {
    if (fieldIds.length === 0) throw new BadRequestError('至少选择一个补全字段');
    if (new Set(fieldIds).size !== fieldIds.length) throw new BadRequestError('fieldIds 不得重复');
    return fieldIds.map(fieldId => {
      const definition = this.byId.get(fieldId);
      if (!definition) throw new BadRequestError(`未知字段: ${fieldId}`);
      if (!definition.enabled) throw new BadRequestError(`字段不可用: ${fieldId}`, { reason: definition.unavailableReason });
      return { ...definition };
    });
  }

  compilePlan(fieldIds: string[]): CompletionPlan {
    const fields = this.validate(fieldIds);
    return {
      fields,
      requiresDetail: fields.some(field => field.requiresDetail),
      requiresLocalFile: fields.some(field => field.requiresLocalFile),
      requiresContentDetection: fields.some(field => field.requiresContentDetection),
    };
  }
}
