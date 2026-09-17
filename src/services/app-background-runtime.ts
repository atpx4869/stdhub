import type Database from 'better-sqlite3';
import { AutoSyncScheduler } from './auto-sync-scheduler';
import { CapLibService } from './cap-lib-service';
import { CheckService } from './check-service';
import { getSetting } from './db';
import { scanLibrary, startLibraryWatcher, stopLibraryWatcher } from './library-index';
import type { PdfPreviewService } from './pdf-preview-service';
import type { QualificationService } from './qualification-service';
import type { SourceRegistry } from './source-registry';
import { runEnvironmentCheck } from './environment-check';

interface BackgroundRuntimeOptions {
  db: Database.Database;
  sourceRegistry: SourceRegistry;
  qualificationService: QualificationService;
  previewService: PdfPreviewService;
  enabled: boolean;
}

export function startAppBackgroundRuntime(options: BackgroundRuntimeOptions) {
  const { db, sourceRegistry, qualificationService, previewService, enabled } = options;
  const autoSync = new AutoSyncScheduler(db, qualificationService, new CapLibService(db));
  const checkTimers: Array<ReturnType<typeof setTimeout>> = [];
  let watcherStarted = false;
  let previewStartPromise: Promise<void> = Promise.resolve();

  if (enabled) {
    previewStartPromise = previewService.start(true).catch(error => console.error('[pdf-preview] startup failed:', error));
    void runEnvironmentCheck();
    scanLibrary(db, { full: false }).catch(error => console.error('[library] startup scan failed:', error));
    if (getSetting(db, 'library_watcher_enabled', '1') === '1') {
      watcherStarted = true;
      startLibraryWatcher(db).catch(error => console.error('[library] startup watcher failed:', error));
    }
    const checkService = new CheckService(db, sourceRegistry);
    const runChecks = () => checkService.runDueAutoChecks()
      .then(changed => changed.forEach(item => console.warn(`[check-auto] 清单「${item.name}」检出 ${item.changedCount} 项标准变动`)))
      .catch(error => console.error('[check-auto] 自动查新调度失败:', error instanceof Error ? error.message : String(error)));
    checkTimers.push(setTimeout(runChecks, 30_000));
    checkTimers.push(setInterval(runChecks, 6 * 60 * 60 * 1_000));
    autoSync.start();
  }

  return {
    autoSync,
    async stop(): Promise<void> {
      await autoSync.close();
      for (const timer of checkTimers) { clearTimeout(timer); clearInterval(timer); }
      checkTimers.length = 0;
      if (watcherStarted) await stopLibraryWatcher().catch(() => {});
      await previewStartPromise;
    },
  };
}
