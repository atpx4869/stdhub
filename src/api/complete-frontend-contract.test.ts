import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const script = readFileSync(path.join(root, 'public', 'js', 'app-complete.js'), 'utf8');
const css = readFileSync(path.join(root, 'public', 'css', 'workspace.css'), 'utf8');

describe('completion V2 frontend contract', () => {
  it('accepts only xlsx and requires explicit coordinates', () => {
    expect(html).toContain('accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"');
    expect(html).not.toContain('accept=".xlsx,.xls,.csv"');
    expect(html).toContain('id="completeSheetName"');
    expect(html).toContain('id="completeHeaderRow"');
    expect(html).toContain('id="completeInputColumn"');
    expect(html).toContain('id="completeOutputColumn"');
  });

  it('executes directly after inspect without rendering a sample preview', () => {
    expect(html).not.toContain('预览前 8 行');
    expect(html).not.toContain('completePreviewBtn');
    expect(script).not.toContain('refreshCompletePreview');
    expect(script).not.toContain('sampleRows');
    expect(script).not.toContain('state.preview');
    expect(script).toContain("api.request('/api/standards/complete'");
  });

  it('uses shared API/lifecycle and page-local progress rather than task center', () => {
    expect(script).toContain('const api = StdHub.api');
    expect(script).toContain("StdHub.lifecycle.register('complete', 'task-stream'");
    expect(script).not.toContain('createTaskCenterTask');
    expect(script).toContain('/api/standards/complete/tasks/');
    expect(script).toContain("field.capability === 'status_only'");
    expect(script).toContain('cancelCompleteTask');
  });

  it('has mobile single-column field layout and 44px touch targets', () => {
    expect(css).toContain('@media (max-width: 700px)');
    expect(css).toMatch(/\.complete-field-layout[\s\S]*grid-template-columns: 1fr/);
    expect(css).toMatch(/\.complete-selected-field,[\s\S]*min-height: 44px/);
  });
});
