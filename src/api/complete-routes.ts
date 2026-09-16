import path from 'node:path';
import { Router, type RequestHandler } from 'express';
import multer from 'multer';
import { z } from 'zod';
import type Database from 'better-sqlite3';

import { COMPLETION_API_VERSION, COMPLETION_REGISTRY_VERSION, type CompletionOptionsV2 } from '../domain/completion';
import type { AdapterSourceName } from '../domain/standard';
import { readConfig } from '../config';
import { BadRequestError, CompletionError, normalizeError } from '../shared/errors';
import { respond } from '../shared/response';
import { normalizeUploadedFileName } from '../shared/excel';
import { CompletionCollector } from '../services/completion-collector';
import { CompletionExcelService, numberToColumn } from '../services/completion-excel';
import ExcelJS from 'exceljs';
import { CompletionFieldRegistry } from '../services/completion-field-registry';
import type { CompletionTaskStore } from '../services/completion-task-store';
import type { SourceRegistry } from '../services/source-registry';

const sourceSchema = z.enum(['bz', 'gbw', 'by']);
const inspectOptionsSchema = z.object({
  apiVersion: z.literal(COMPLETION_API_VERSION),
  registryVersion: z.literal(COMPLETION_REGISTRY_VERSION),
  sheetName: z.string().max(31).default(''),
  headerRow: z.number().int().min(1).default(1),
  inputColumn: z.string().min(1).max(5).default('A'),
  outputColumn: z.string().min(1).max(5).default('B'),
  fieldIds: z.array(z.string()).default(['standard.number.canonical', 'standard.title.zh', 'match.state']),
  sources: z.array(sourceSchema).min(1).default(['bz']),
  detectionPolicy: z.enum(['none', 'text_layer']).default('none'),
  previewLimit: z.number().int().min(1).max(10).default(8),
  includeExplanationSheet: z.boolean().optional(),
});

const optionsSchema = z.object({
  apiVersion: z.literal(COMPLETION_API_VERSION),
  registryVersion: z.literal(COMPLETION_REGISTRY_VERSION),
  sheetName: z.string().min(1).max(31),
  headerRow: z.number().int().min(1),
  inputColumn: z.string().min(1).max(5),
  outputColumn: z.string().min(1).max(5),
  fieldIds: z.array(z.string()).min(1),
  sources: z.array(sourceSchema).min(1),
  detectionPolicy: z.enum(['none', 'text_layer']).default('none'),
  previewLimit: z.number().int().min(1).max(10).default(8),
  includeExplanationSheet: z.boolean().optional(),
  previewToken: z.string().length(64).optional(),
});

function parseJsonOptions(raw: unknown, fallback: unknown = undefined): unknown {
  if (raw === undefined && fallback !== undefined) return fallback;
  if (typeof raw !== 'string') throw new BadRequestError('options 是必填 JSON 字段');
  try { return JSON.parse(raw); }
  catch { throw new BadRequestError('options 不是有效 JSON'); }
}

function validateDetectionPolicy(options: CompletionOptionsV2): void {
  if (options.detectionPolicy !== 'none') {
    throw new CompletionError(400, 'COMPLETE_DETECTION_UNAVAILABLE', '真实 PDF 文本层检测能力尚未启用，请将 detectionPolicy 设为 none');
  }
}

function parseOptions(body: Record<string, unknown>): CompletionOptionsV2 {
  const raw = body.options;
  const legacyKeys = ['sources', 'inputColumn', 'outputColumn', 'preserveStyle', 'includeSource', 'includeStatus', 'includeDownloadLink', 'includeTextFlag', 'templateMode'];
  if (typeof raw === 'string' && legacyKeys.some(key => body[key] !== undefined)) throw new BadRequestError('V2 options 与旧参数禁止混传');
  if (typeof raw !== 'string') throw new BadRequestError('options 是必填 JSON 字段；旧补全参数已进入兼容退役期，请刷新页面使用 V2');
  const options = optionsSchema.parse(parseJsonOptions(raw));
  validateDetectionPolicy(options);
  return options;
}

export interface CompleteRoutesDeps {
  db: Database.Database;
  sourceRegistry: SourceRegistry;
  taskStore: CompletionTaskStore;
  requireAdmin: RequestHandler;
  baseDir: string;
}

export function createCompleteRoutes({ db, sourceRegistry, taskStore, requireAdmin, baseDir }: CompleteRoutesDeps) {
  const config = readConfig();
  const registry = new CompletionFieldRegistry();
  const excel = new CompletionExcelService(config.completion);
  const collector = new CompletionCollector(db, sourceRegistry, path.resolve(baseDir, 'standards'));
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: config.completion.maxUploadBytes, files: 1, fields: 2, parts: 3, fieldSize: 64 * 1024 },
    fileFilter: (_request, file, callback) => {
      if (path.extname(file.originalname).toLowerCase() !== '.xlsx') {
        callback(new BadRequestError('仅支持 .xlsx 格式'));
        return;
      }
      callback(null, true);
    },
  });
  const router = Router();

  router.get('/api/standards/complete/fields', requireAdmin, (req, res, next) => {
    try {
      const requested = Number(req.query.registryVersion ?? COMPLETION_REGISTRY_VERSION);
      if (requested !== COMPLETION_REGISTRY_VERSION) throw new BadRequestError(`不支持字段注册表版本 ${requested}`);
      respond(res, { registryVersion: registry.registryVersion, groups: registry.listGroups(), fields: registry.listFields(), presets: registry.listPresets() });
    } catch (error) { next(normalizeError(error)); }
  });

  router.post('/api/standards/complete/inspect', requireAdmin, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) throw new BadRequestError('请上传 .xlsx 文件');
      req.file.originalname = normalizeUploadedFileName(req.file.originalname);
      const inspected = inspectOptionsSchema.parse(parseJsonOptions(req.body.options, {}));
      const workbook = new ExcelJS.Workbook();
      try { await workbook.xlsx.load(req.file.buffer as unknown as ArrayBuffer); }
      catch { throw new BadRequestError('工作簿损坏或不是有效 .xlsx 文件'); }
      if (!workbook.worksheets.length) throw new BadRequestError('工作簿没有工作表');
      const sheetName = inspected.sheetName || workbook.worksheets[0].name;
      const plan = registry.compilePlan(inspected.fieldIds);
      const options = { ...inspected, sheetName } as CompletionOptionsV2;
      await excel.analyze(req.file.buffer, req.file.originalname, options, plan);
      respond(res, {
        fileName: req.file.originalname,
        sheets: workbook.worksheets.map(sheet => ({
          name: sheet.name,
          rowCount: sheet.rowCount,
          columnCount: sheet.columnCount,
          state: sheet.state,
          recommendedOutputColumn: numberToColumn(Math.min(Math.max(sheet.columnCount + 1, 1), 16_384)),
        })),
      });
    } catch (error) { next(normalizeError(error)); }
  });

  router.post('/api/standards/complete/preview', requireAdmin, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) throw new BadRequestError('请上传 .xlsx 文件');
      req.file.originalname = normalizeUploadedFileName(req.file.originalname);
      const options = parseOptions(req.body);
      const plan = registry.compilePlan(options.fieldIds);
      const analysis = await excel.analyze(req.file.buffer, req.file.originalname, options, plan);
      const previewInput = analysis.previewRows.map(row => ({ rowNumber: row.rowNumber, value: row.value, valid: row.valid, inputError: row.inputError }));
      const rows = await collector.collect(previewInput, plan, options, new AbortController().signal, () => {});
      respond(res, {
        ...analysis,
        sampleRows: analysis.previewRows.map(row => ({
          rowNumber: row.rowNumber,
          input: row.value,
          valid: row.valid,
          values: rows.get(row.rowNumber)?.values ?? {},
        })),
      });
    } catch (error) { next(normalizeError(error)); }
  });

  router.post('/api/standards/complete', requireAdmin, upload.single('file'), async (req, res, next) => {
    try {
      if (!req.file) throw new BadRequestError('请上传 .xlsx 文件');
      req.file.originalname = normalizeUploadedFileName(req.file.originalname);
      const options = parseOptions(req.body);
      if (!options.previewToken) throw new BadRequestError('执行前必须先预览并提交 previewToken');
      const plan = registry.compilePlan(options.fieldIds);
      const buffer = Buffer.from(req.file.buffer);
      const originalName = req.file.originalname;
      const userId = req.user!.id;
      const task = taskStore.create(userId, async (taskId, signal) => {
        const analysis = await excel.analyze(buffer, originalName, options, plan);
        if (analysis.previewToken !== options.previewToken) throw new BadRequestError('预览令牌已失效，请重新预览');
        if (analysis.conflicts.length) throw new BadRequestError('输出范围存在冲突', { conflicts: analysis.conflicts });
        const allInputs = analysis.inputs.map(row => ({ rowNumber: row.rowNumber, value: row.value, valid: row.valid, inputError: row.inputError }));
        const rows = await collector.collect(allInputs, plan, options, signal, (phase, current, total, message) => {
          taskStore.progress(taskId, phase as any, current, total, message);
        });
        taskStore.progress(taskId, 'writing', 0, allInputs.length, '正在生成新工作簿');
        const output = await excel.writeNewFile(buffer, options, plan, analysis, rows, path.resolve(baseDir, 'data', 'exports'));
        const stateCounts: Record<string, number> = {};
        for (const row of rows.values()) stateCounts[row.resolution.matchState] = (stateCounts[row.resolution.matchState] ?? 0) + 1;
        return {
          fileName: output.fileName,
          downloadUrl: `/api/downloads/${encodeURIComponent(output.fileName)}`,
          current: allInputs.length,
          total: allInputs.length,
          summary: { ...analysis.counts, matchStates: stateCounts },
        };
      });
      respond(res, task, 202);
    } catch (error) { next(normalizeError(error)); }
  });

  router.get('/api/standards/complete/tasks/:taskId', requireAdmin, (req, res, next) => {
    try { respond(res, taskStore.get(String(req.params.taskId), req.user!.id)); }
    catch (error) { next(normalizeError(error)); }
  });

  router.post('/api/standards/complete/tasks/:taskId/cancel', requireAdmin, (req, res, next) => {
    try { respond(res, taskStore.cancel(String(req.params.taskId), req.user!.id)); }
    catch (error) { next(normalizeError(error)); }
  });

  router.get('/api/standards/complete/tasks/:taskId/stream', requireAdmin, (req, res) => {
    try {
      taskStore.get(String(req.params.taskId), req.user!.id);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      const unsubscribe = taskStore.subscribe(String(req.params.taskId), req.user!.id, task => {
        res.write(`data: ${JSON.stringify({ data: task, error: null })}\n\n`);
        if (['success', 'failed', 'cancelled'].includes(task.status)) res.end();
      });
      req.on('close', unsubscribe);
    } catch {
      res.status(404).json({ data: null, error: { code: 'NOT_FOUND', message: 'Task not found' } });
    }
  });

  return router;
}
