import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../..');
const html = readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const script = readFileSync(path.join(root, 'public', 'js', 'app-complete.js'), 'utf8');
const orderScript = readFileSync(path.join(root, 'public', 'js', 'selected-field-order.js'), 'utf8');
const css = readFileSync(path.join(root, 'public', 'css', 'workspace.css'), 'utf8');
const componentsCss = readFileSync(path.join(root, 'public', 'css', 'components-pages.css'), 'utf8');
const pagesCss = readFileSync(path.join(root, 'public', 'css', 'pages.css'), 'utf8');
const coreScript = readFileSync(path.join(root, 'public', 'js', 'app-core.js'), 'utf8');
const mobileScript = readFileSync(path.join(root, 'public', 'js', 'app-mobile.js'), 'utf8');
const commandPaletteScript = readFileSync(path.join(root, 'public', 'js', 'app-command-palette.js'), 'utf8');

describe('completion V2 frontend contract', () => {
  it('accepts only xlsx and requires explicit coordinates', () => {
    expect(html).toContain('accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"');
    expect(html).not.toContain('accept=".xlsx,.xls,.csv"');
    expect(html).toContain('id="completeSheetName"');
    expect(html).toContain('id="completeHeaderRow"');
    expect(html).toContain('id="completeInputColumn"');
    expect(html).toContain('id="completeOutputColumn"');
  });

  it('keeps the late-loaded page CSS on the same single-column workspace contract', () => {
    // components-pages.css is appended dynamically after workspace.css, so a
    // desktop two-column rule in either entrypoint can silently win by order.
    const doubleColumn = /\.complete-workspace\s*\{[^}]*grid-template-columns:\s*minmax\([^;]+\)\s+minmax\(/s;
    expect(componentsCss).toMatch(/\.complete-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s);
    expect(componentsCss).not.toMatch(doubleColumn);
    expect(css).not.toMatch(doubleColumn);
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
    expect(html).toContain('/js/selected-field-order.js');
    expect(orderScript).toContain('module.exports = { moveSelectedField }');
    expect(script).toContain("handle.draggable = true");
    expect(script).toContain("handle.setAttribute('aria-grabbed', 'false')");
    expect(script).toContain("handle.addEventListener('dragstart'");
    expect(script).toContain("item.addEventListener('dragover'");
    expect(script).toContain("item.addEventListener('drop'");
    expect(script).toContain("handle.addEventListener('pointerdown'");
    expect(script).toMatch(/const timer = setTimeout\(\(\) => \{[\s\S]*pointerDrag = \{ from: index, pointerId \}/);
    expect(script).toContain("handle.setPointerCapture(event.pointerId)");
    expect(script).toContain("event.type !== 'pointercancel'");
    expect(script).toContain("event.key === 'ArrowLeft'");
    expect(script).not.toContain("[['左移'");
    expect(script).not.toContain("['右移'");
    expect(css).toContain('.is-drop-before::before');
    expect(css).toContain('.is-drop-after::after');
    expect(script).toContain("toggle.textContent = allSelected ? '取消全选' : '全选'");
    expect(css).toMatch(/\.complete-workspace \{\s*grid-template-columns: minmax\(0, 1fr\)/);
    expect(script).toContain('collapsedGroups: new Set()');
    expect(script).toContain('section.open = Boolean(query) || !state.collapsedGroups.has(group.groupId)');
    expect(script).toContain('if (query) return;');
    expect(css).toMatch(/#toolsTabComplete \.complete-field-card-track \{[^}]*display: flex;[^}]*flex-wrap: wrap;/s);
    expect(css).not.toMatch(/\.complete-field-card-track \{[^}]*overflow-x:\s*auto/s);
    expect(css).toMatch(/#toolsTabComplete \.complete-selected-track \{[^}]*flex-wrap: wrap;[^}]*overflow: visible;/s);
    expect(css).not.toMatch(/\.complete-field-card-track \{[^}]*repeat\([246],/s);
    expect(script).not.toContain("document.createElement('small')");
    expect(script).toContain('label.title +=');
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

  it('keeps the complete tool desktop-only while preserving its desktop contract', () => {
    expect(html).toContain('data-me-tab="tools"');
    const mobileToolsRule = [...pagesCss.matchAll(/@media \(max-width: 700px\) \{([\s\S]*?)\n\}/g)]
      .map(match => match[1])
      .find(block => block.includes('#page-tools')) || '';
    expect(mobileToolsRule).toContain('[data-me-tab="tools"]');
    expect(mobileToolsRule).toContain('.mobile-tab[data-tab="tools"]');
    expect(mobileToolsRule).toContain('[data-mobile-tools-entry]');
    expect(mobileToolsRule).toContain('#page-tools');
    expect(mobileToolsRule).toContain('display: none !important');
    expect(coreScript).toContain("tab === 'tools' && typeof window.isMobile === 'function' && window.isMobile()");
    expect(coreScript).toContain("showToast('工具箱仅支持桌面端使用'");
    expect(mobileScript).toContain('updateMobileToolsAvailability(mode)');
    expect(mobileScript).toContain("window.switchTab('search')");
    expect(commandPaletteScript).toContain("item.id === 'tools' && typeof window.isMobile === 'function' && window.isMobile()");
    expect(css).toMatch(/#toolsTabComplete \.complete-coordinate-grid select,[\s\S]*width: 100%;[\s\S]*height: 34px;/);
  });
});
