import { describe, expect, it, vi } from 'vitest';
import { ExportTaskStore } from './export-task-store';

const HOUR = 60 * 60 * 1000;

describe('ExportTaskStore', () => {
  it.each(['bz', 'by', 'sby'] as const)('shares active %s tasks across users and flags only the new task as created', source => {
    const store = new ExportTaskStore();
    const { task, created } = store.create(source, source + ':1', 1);
    expect(created).toBe(true);
    expect(store.create(source, task.standardId, 1)).toEqual({ task, created: false });
    expect(store.create(source, task.standardId, 2)).toMatchObject({ task: { id: task.id, subscribers: [1, 2] }, created: false });
    expect(store.isSubscriber(task.id, 2)).toBe(true);
    expect(store.isSubscriber(task.id, 3)).toBe(false);
  });

  it('keeps BW auto-download tasks per user, while still deduplicating the same user', () => {
    const store = new ExportTaskStore();
    const first = store.create('gbw', 'gbw:3', 10);
    expect(store.create('gbw', 'gbw:3', 10)).toEqual({ task: first.task, created: false });
    const second = store.create('gbw', 'gbw:3', 11);
    expect(second.created).toBe(true);
    expect(second.task.id).not.toBe(first.task.id);
    expect(store.isSubscriber(first.task.id, 11)).toBe(false);
    expect(store.isSubscriber(second.task.id, 10)).toBe(false);
  });

  it('never expires queued or running tasks, and times terminal retention from completion', () => {
    vi.useFakeTimers();
    try {
      const store = new ExportTaskStore();
      const running = store.create('bz', 'bz:1', 1).task;
      const queued = store.create('by', 'by:2', 1).task;
      store.markPhase(running.id, 'downloading');
      vi.advanceTimersByTime(2 * HOUR);
      expect(store.get(running.id)?.status).toBe('running');
      expect(store.get(queued.id)).toBe(queued);
      const completed = store.markSuccess(running.id, { fileId: 12 });
      const fresh = store.create('bz', running.standardId, 2);
      expect(fresh.created).toBe(true);
      expect(fresh.task.id).not.toBe(running.id);
      vi.advanceTimersByTime(HOUR - 1);
      expect(store.get(running.id)).toBe(completed);
      vi.advanceTimersByTime(1);
      expect(store.get(running.id)).toBeUndefined();
      expect(store.get(queued.id)?.status).toBe('queued');
    } finally {
      vi.useRealTimers();
    }
  });
});
