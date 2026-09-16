import type { AdapterSourceName } from './standard';

export const COMPLETION_REGISTRY_VERSION = 1 as const;
export const COMPLETION_API_VERSION = 2 as const;

export type CompletionMatchState =
  | 'success'
  | 'not_found'
  | 'multiple_candidates'
  | 'invalid_input'
  | 'upstream_error'
  | 'system_error';
export type CompletionLocalFileState = 'present' | 'absent' | 'error';
export type CompletionDetectionState = 'not_run' | 'success' | 'failed' | 'not_applicable';
export type CompletionTextLayerState = 'yes' | 'no' | 'not_checked' | 'not_applicable';
export type CompletionCost = 'L0' | 'L1' | 'L2' | 'L3' | 'L4';
export type CompletionCoverage = 'high' | 'medium' | 'low' | 'diagnostic';
export type CompletionValueType = 'string' | 'date' | 'integer' | 'enum' | 'url';

export interface CompletionFieldDefinition {
  fieldId: string;
  label: string;
  description: string;
  groupId: string;
  order: number;
  valueType: CompletionValueType;
  source: string;
  coverage: CompletionCoverage;
  cost: CompletionCost;
  enabled: boolean;
  defaultSelected: boolean;
  requiresDetail: boolean;
  requiresLocalFile: boolean;
  requiresContentDetection: boolean;
  capability?: 'available' | 'status_only' | 'unavailable';
  unavailableReason?: string;
}

export interface CompletionFieldGroup {
  groupId: string;
  label: string;
  order: number;
}

export interface CompletionPreset {
  presetId: string;
  label: string;
  description: string;
  fieldIds: string[];
  detectionPolicy: 'none' | 'text_layer';
}

export interface CompletionPlan {
  fields: CompletionFieldDefinition[];
  requiresDetail: boolean;
  requiresLocalFile: boolean;
  requiresContentDetection: boolean;
}

export interface CompletionOptionsV2 {
  apiVersion: typeof COMPLETION_API_VERSION;
  registryVersion: typeof COMPLETION_REGISTRY_VERSION;
  sheetName: string;
  headerRow: number;
  inputColumn: string;
  outputColumn: string;
  fieldIds: string[];
  sources: AdapterSourceName[];
  detectionPolicy: 'none' | 'text_layer';
  previewLimit: number;
  includeExplanationSheet?: boolean;
  previewToken?: string;
}

export interface CompletionSourceError {
  source: AdapterSourceName;
  message: string;
}

export interface CompletionCandidate {
  standardId: string;
  standardNumber: string;
  title: string;
  source: AdapterSourceName;
  status?: string;
  publishDate?: string | null;
  implementDate?: string | null;
  abolishedDate?: string | null;
  replacesNumbers?: string[];
  replacedByNumbers?: string[];
  sourceRecordId?: string;
  detailUrl?: string;
  standardType?: string;
  enName?: string;
  ics?: string;
  ccs?: string;
}

export interface CompletionResolution {
  input: string;
  matchState: CompletionMatchState;
  matchMethod: string;
  winner?: CompletionCandidate;
  candidates: CompletionCandidate[];
  sourceErrors: CompletionSourceError[];
  errorSummary?: string;
  qualityWarnings: string[];
}

export interface CompletionLocalFile {
  state: CompletionLocalFileState;
  fileName?: string;
  fileFormat?: string;
  fileSizeBytes?: number;
  indexedAt?: string;
  relativePath?: string;
  sha256?: string;
  pageCount?: number;
  errorSummary?: string;
}

export interface CompletionCollectedRow {
  input: string;
  resolution: CompletionResolution;
  localFile: CompletionLocalFile;
  detectionState: CompletionDetectionState;
  textLayerState: CompletionTextLayerState;
  values: Record<string, string | number>;
}

export type CompletionTaskPhase =
  | 'queued'
  | 'parsing'
  | 'matching'
  | 'fetching_details'
  | 'linking_local_files'
  | 'detecting_content'
  | 'writing'
  | 'complete'
  | 'failed'
  | 'cancelled';

export interface CompletionTask {
  id: string;
  userId: number;
  status: 'queued' | 'running' | 'success' | 'failed' | 'cancelled';
  phase: CompletionTaskPhase;
  current: number;
  total: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  fileName?: string;
  downloadUrl?: string;
  summary?: Record<string, unknown>;
  error?: { code: string; message: string; details?: unknown };
}
