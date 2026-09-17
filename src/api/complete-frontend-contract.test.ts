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

  it('places execution actions in the configuration header above export and result sections', () => {
    const configStart = html.indexOf('<section class="complete-card tool-work-panel">');
    const upload = html.indexOf('id="completeUploadBtn"', configStart);
    const headActions = html.lastIndexOf('class="complete-card-head-actions"', upload);
    const exportLane = html.indexOf('class="complete-export-lane"', configStart);
    const resultSection = html.indexOf('<section class="complete-card tool-work-panel">', configStart + 1);
    expect(headActions).toBeGreaterThan(configStart);
    expect(upload).toBeGreaterThan(headActions);
    expect(upload).toBeLessThan(exportLane);
    expect(exportLane).toBeLessThan(resultSection);
    expect(html).not.toContain('class="complete-actions"');
    expect(css).toMatch(/\.complete-card-head-actions[\s\S]*min-height: 44px/);
  });

  it('uses full-width horizontal field groups and an export-order track', () => {
    expect(html).toContain('class="complete-field-workspace"');
    expect(html).toContain('class="complete-field-groups"');
    expect(html).toContain('class="complete-export-lane"');
    expect(html).toContain('class="complete-selected-track"');
    expect(html).not.toContain('class="complete-field-layout"');
    expect(script).toContain("section.className = 'complete-field-group'");
    expect(script).toContain("lane.className = 'complete-field-card-track'");
    expect(script).toContain("[['左移', '←', -1], ['右移', '→', 1]]");
    expect(script).toContain("toggle.textContent = allSelected ? '取消全选' : '全选'");
    expect(css).toMatch(/\.complete-workspace \{\s*grid-template-columns: minmax\(0, 1fr\)/);
    expect(script).toContain('collapsedGroups: new Set()');
    expect(script).toContain('section.open = Boolean(query) || !state.collapsedGroups.has(group.groupId)');
    expect(script).toContain('if (query) return;');
    expect(css).toMatch(/\.complete-field-card-track \{[\s\S]*display: grid;[\s\S]*grid-template-columns: repeat\(6/);
    expect(css).not.toMatch(/\.complete-field-card-track \{[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/\.complete-selected-track \{[\s\S]*overflow-x: auto/);
    expect(css).not.toMatch(/\.complete-field-groups[\s\S]{0,160}max-height:\s*430px/);
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
    expect(css).toMatch(/\.complete-workspace[\s\S]*grid-template-columns: 1fr/);
    expect(css).toMatch(/\.complete-selected-actions \.btn \{[\s\S]*min-height: 44px/);
    expect(css).toMatch(/\.complete-field-card-track \{[\s\S]*grid-template-columns: repeat\(2/);
  });
});
