import type {
  ExportResult,
  PreviewInfo,
  SearchStandardsInput,
  SourceAdapter,
  StandardDetail,
  StandardSummary,
} from '../domain/standard';

export class StandardService {
  constructor(private readonly adapter: SourceAdapter) {}

  searchStandards(input: SearchStandardsInput): Promise<StandardSummary[]> {
    return this.adapter.searchStandards(input);
  }

  getStandardDetail(id: string): Promise<StandardDetail> {
    return this.adapter.getStandardDetail(id);
  }

  detectPreview(id: string): Promise<PreviewInfo> {
    return this.adapter.detectPreview(id);
  }

  exportStandard(id: string): Promise<ExportResult> {
    return this.adapter.exportStandard(id);
  }
}
