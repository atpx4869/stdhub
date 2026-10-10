import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { DOC88_RENDER_INVARIANTS, Doc88Renderer } from './doc88-renderer';

const state = vi.hoisted(() => ({ contexts: [] as any[], closed: false, png: Buffer.alloc(36_000), pdf: vi.fn() }));
vi.mock('playwright', () => ({ chromium: { launch: async () => ({
  isConnected: () => true,
  on: () => {},
  close: async () => { state.closed = true; },
  newContext: async () => {
    let rejectNavigation: (e: Error) => void = () => {};
    const context = {
      addCookies: vi.fn(),
      close: async () => { rejectNavigation(new Error('context closed')); },
      newPage: async () => ({
        setDefaultTimeout: () => {},
        goto: async () => { await new Promise((_resolve, reject) => { rejectNavigation = reject; }); },
        close: async () => {},
      }),
    };
    state.contexts.push(context);
    return context;
  },
}) } }));

afterEach(() => { state.contexts.length = 0; state.closed = false; });

describe('Doc88 renderer protected invariants', () => {
  it('keeps the proven canvas rendering contract', () => {
    expect(DOC88_RENDER_INVARIANTS).toMatchObject({ minPngBytes: 35_000, jobs: 1, cookieFlags: ['cdb_IMGR', 'cdb_H5R'], preferCssPageSize: true });
    expect(DOC88_RENDER_INVARIANTS.userAgent).toContain('Chrome/71.0.3578.98');
    const code = readFileSync('src/sources/doc88/doc88-renderer.ts', 'utf8');
    expect(code).toContain("typeof Viewer !== 'undefined' ? Viewer");
    expect(code).toContain('viewer._OA = viewer._F8');
    expect(code).toContain('preferCSSPageSize: true');
    expect(code).toContain('height:${height}px;overflow:hidden');
  });

  it('cancellation closes the context to interrupt a pending navigation', async () => {
    const renderer = new Doc88Renderer();
    const controller = new AbortController();
    const render = renderer.render('123456789012', '/tmp/doc88-not-created.pdf', {
      cookie: 'test-only=1', scale: 2, pageTimeoutMs: 30_000, signal: controller.signal,
    });
    const rejection = expect(render).rejects.toThrow(/context closed|取消/);
    await vi.waitFor(() => expect(state.contexts.length).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort(new Error('任务已取消'));
    await rejection;
    await renderer.close();
    expect(state.closed).toBe(true);
  });
});
