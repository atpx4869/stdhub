import crypto from 'node:crypto';
import type { DownloadSessionInfo } from '../../domain/standard';

export interface GbwDownloadSessionRecord extends DownloadSessionInfo {
  userId: number;
  cookies: string[];
  showUrl: string;
  hcno: string;
}

const SESSION_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SWEEP_INTERVAL_MS = 10 * 60 * 1000; // 10 minutes

export class GbwDownloadSessionStore {
  private readonly sessions = new Map<string, GbwDownloadSessionRecord>();
  private _sweepTimer: ReturnType<typeof setInterval> | null = null;

  create(record: Omit<GbwDownloadSessionRecord, 'id' | 'createdAt' | 'updatedAt'>): GbwDownloadSessionRecord {
    const now = new Date().toISOString();
    const created: GbwDownloadSessionRecord = {
      ...record,
      // Unpredictable opaque id — matches export-task-store, keeps adjacent
      // users from guessing each other's in-flight session ids.
      id: `gbw_dl_${crypto.randomUUID()}`,
      createdAt: now,
      updatedAt: now,
    };

    this.sessions.set(created.id, created);
    this.evictExpired();
    this.ensureSweep();
    return created;
  }

  get(id: string): GbwDownloadSessionRecord | undefined {
    return this.sessions.get(id);
  }

  update(id: string, partial: Partial<GbwDownloadSessionRecord>): GbwDownloadSessionRecord | undefined {
    const current = this.sessions.get(id);
    if (!current) {
      return undefined;
    }

    const next: GbwDownloadSessionRecord = {
      ...current,
      ...partial,
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(id, next);
    return next;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const [id, session] of this.sessions) {
      if (new Date(session.updatedAt).getTime() < cutoff) {
        this.sessions.delete(id);
      }
    }
    if (this.sessions.size === 0 && this._sweepTimer) {
      clearInterval(this._sweepTimer);
      this._sweepTimer = null;
    }
  }

  // Run eviction on a timer too — otherwise a user who stops creating sessions
  // leaves the captcha image / cookies on the heap until the next create call.
  private ensureSweep(): void {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => this.evictExpired(), SWEEP_INTERVAL_MS);
    this._sweepTimer.unref?.();
  }
}
