(function initializeCompletion(global) {
  'use strict';

  const StdHub = global.StdHub;
  const api = StdHub.api;
  const state = {
    catalog: null,
    selected: [],
    collapsedGroups: new Set(),
    taskId: '',
    eventSource: null,
    pollTimer: null,
  };

  function byId(id) { return document.getElementById(id); }
  function text(target, value) { StdHub.dom.setText(target, value); }
  function selectedDefinitions() {
    const byField = new Map((state.catalog?.fields || []).map(field => [field.fieldId, field]));
    return state.selected.map(id => byField.get(id)).filter(Boolean);
  }
  function columnNumber(value) {
    const raw = String(value || '').trim().toUpperCase();
    if (/^\d+$/.test(raw)) return Number(raw);
    if (!/^[A-Z]{1,3}$/.test(raw)) return 0;
    let number = 0;
    for (const character of raw) number = number * 26 + character.charCodeAt(0) - 64;
    return number;
  }
  function columnName(number) {
    let result = '';
    while (number > 0) { const remainder = (number - 1) % 26; result = String.fromCharCode(65 + remainder) + result; number = Math.floor((number - 1) / 26); }
    return result;
  }
  function currentFile() { return byId('completeFileInput')?.files?.[0] || null; }
  function options() {
    return {
      apiVersion: 2,
      registryVersion: 1,
      sheetName: byId('completeSheetName')?.value || '',
      headerRow: Math.max(1, Number(byId('completeHeaderRow')?.value || 1)),
      inputColumn: String(byId('completeInputColumn')?.value || '').trim().toUpperCase(),
      outputColumn: String(byId('completeOutputColumn')?.value || '').trim().toUpperCase(),
      fieldIds: [...state.selected],
      sources: (global.downloadPriority || ['bz', 'gbw', 'by']).filter(source => (global.downloadSources || ['bz', 'gbw', 'by']).includes(source)),
      detectionPolicy: 'none',
      previewLimit: 8,
    };
  }
  function validOptions() {
    const value = options();
    return Boolean(currentFile() && value.sheetName && value.fieldIds.length && columnNumber(value.inputColumn) && columnNumber(value.outputColumn));
  }
  function setSummary(title, detail, type) {
    const container = byId('completeSummary');
    if (!container) return;
    container.className = `complete-status ${type || 'idle'}`;
    container.replaceChildren();
    const strong = document.createElement('strong'); strong.textContent = title; container.appendChild(strong);
    if (detail) { const span = document.createElement('span'); span.textContent = detail; container.appendChild(span); }
  }
  function updateRange() {
    const start = columnNumber(byId('completeOutputColumn')?.value);
    const end = start && state.selected.length ? start + state.selected.length - 1 : 0;
    text('#completeRange', end <= 16384 ? `${columnName(start)}:${columnName(end)}，共 ${state.selected.length} 列` : '超过 XFD');
    const enabled = validOptions() && end <= 16384;
    if (byId('completeUploadBtn')) byId('completeUploadBtn').disabled = !enabled;
  }
  function renderCatalog() {
    const catalog = byId('completeFieldCatalog');
    if (!catalog || !state.catalog) return;
    catalog.replaceChildren();
    const query = String(byId('completeFieldSearch')?.value || '').trim().toLowerCase();
    for (const group of state.catalog.groups) {
      const fields = state.catalog.fields.filter(field => field.groupId === group.groupId && (!query || `${field.label} ${field.fieldId}`.toLowerCase().includes(query)));
      if (!fields.length) continue;
      const section = document.createElement('details');
      section.className = 'complete-field-group';
      section.open = Boolean(query) || !state.collapsedGroups.has(group.groupId);
      section.dataset.groupId = group.groupId;
      section.addEventListener('toggle', () => {
        // Search temporarily expands matches; it must not erase the user's
        // remembered collapsed state until the search is cleared.
        if (query) return;
        if (section.open) state.collapsedGroups.delete(group.groupId);
        else state.collapsedGroups.add(group.groupId);
      });
      const summary = document.createElement('summary'); summary.className = 'complete-field-group-head';
      const heading = document.createElement('strong'); heading.textContent = group.label;
      const selectedCount = fields.filter(field => state.selected.includes(field.fieldId)).length;
      const count = document.createElement('span'); count.className = 'complete-field-group-count'; count.textContent = `${selectedCount}/${fields.length}`;
      const toggle = document.createElement('button'); toggle.type = 'button'; toggle.className = 'complete-group-toggle';
      const enabledIds = fields.filter(field => field.enabled).map(field => field.fieldId);
      const allSelected = enabledIds.length > 0 && enabledIds.every(id => state.selected.includes(id));
      toggle.textContent = allSelected ? '取消全选' : '全选';
      toggle.addEventListener('click', event => {
        event.preventDefault(); event.stopPropagation();
        state.selected = allSelected
          ? state.selected.filter(id => !enabledIds.includes(id))
          : [...state.selected, ...enabledIds.filter(id => !state.selected.includes(id))];
        renderCatalog(); renderSelected(); updateRange();
      });
      summary.append(heading, count, toggle); section.appendChild(summary);
      const lane = document.createElement('div'); lane.className = 'complete-field-card-track';
      for (const field of fields) {
        const label = document.createElement('label');
        const selected = state.selected.includes(field.fieldId);
        label.className = `complete-field-option${field.enabled ? '' : ' is-disabled'}${selected ? ' is-selected' : ''}`;
        label.title = field.enabled
          ? `${field.label} · ${field.coverage} · ${field.cost} · ${field.source}${field.description ? ` · ${field.description}` : ''}`
          : (field.unavailableReason || field.description || field.label);
        const input = document.createElement('input'); input.type = 'checkbox'; input.checked = selected; input.disabled = !field.enabled;
        input.addEventListener('change', () => { state.selected = input.checked ? [...state.selected, field.fieldId] : state.selected.filter(id => id !== field.fieldId); renderCatalog(); renderSelected(); updateRange(); });
        if (field.capability === 'status_only') {
          label.title += ` · 仅状态输出：${field.unavailableReason || '真实检测能力未启用'}`;
        }
        const name = document.createElement('span'); name.textContent = field.label;
        label.append(input, name);
        label.addEventListener('click', event => {
          if (event.target === input || !field.enabled) return;
          event.preventDefault();
          input.checked = !input.checked;
          input.dispatchEvent(new Event('change', { bubbles: true }));
        });
        lane.appendChild(label);
      }
      section.appendChild(lane); catalog.appendChild(section);
    }
  }
  function announceSelectedOrder(message) {
    const target = byId('completeOrderAnnouncement');
    if (target) target.textContent = message;
  }
  function commitSelectedMove(from, to) {
    const next = StdHub.moveSelectedField(state.selected, from, to);
    if (next.every((id, index) => id === state.selected[index])) return false;
    state.selected = next; renderSelected(); updateRange();
    announceSelectedOrder(`字段已移动到第 ${to + 1} 位`);
    return true;
  }
  function clearDropIndicators(list) {
    list.querySelectorAll('.is-drop-before, .is-drop-after').forEach(item => item.classList.remove('is-drop-before', 'is-drop-after'));
  }
  function renderSelected() {
    const list = byId('completeSelectedFields');
    if (!list) return;
    list.replaceChildren();
    let draggedIndex = -1;
    let pointerDrag = null;
    selectedDefinitions().forEach((field, index) => {
      const item = document.createElement('li'); item.className = 'complete-selected-field'; item.dataset.index = String(index); item.dataset.fieldId = field.fieldId;
      const handle = document.createElement('button'); handle.type = 'button'; handle.className = 'complete-selected-drag'; handle.draggable = true; handle.tabIndex = 0; handle.textContent = '⋮⋮'; handle.title = '拖动排序'; handle.setAttribute('aria-label', `拖动排序：${field.label}`); handle.setAttribute('aria-grabbed', 'false');
      const order = document.createElement('span'); order.className = 'complete-selected-order'; order.textContent = String(index + 1);
      const label = document.createElement('strong'); label.className = 'complete-selected-name'; label.textContent = field.label;
      handle.addEventListener('keydown', event => {
        const direction = event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowRight' ? 1 : 0;
        if ((!event.altKey && !event.ctrlKey) || !direction) return;
        event.preventDefault();
        const target = Math.max(0, Math.min(state.selected.length - 1, index + direction));
        if (commitSelectedMove(index, target)) requestAnimationFrame(() => list.querySelector(`[data-index="${target}"] .complete-selected-drag`)?.focus());
      });
      handle.addEventListener('dragstart', event => { draggedIndex = index; item.classList.add('is-dragging'); handle.setAttribute('aria-grabbed', 'true'); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', field.fieldId); });
      handle.addEventListener('dragend', () => { draggedIndex = -1; item.classList.remove('is-dragging'); handle.setAttribute('aria-grabbed', 'false'); clearDropIndicators(list); });
      item.addEventListener('dragover', event => { if (draggedIndex < 0) return; event.preventDefault(); clearDropIndicators(list); const after = event.clientX >= item.getBoundingClientRect().left + item.offsetWidth / 2; item.classList.add(after ? 'is-drop-after' : 'is-drop-before'); });
      item.addEventListener('drop', event => { if (draggedIndex < 0) return; event.preventDefault(); const after = item.classList.contains('is-drop-after'); let target = index + (after ? 1 : 0); if (draggedIndex < target) target--; target = Math.max(0, Math.min(state.selected.length - 1, target)); commitSelectedMove(draggedIndex, target); });
      let pendingTouch = null;
      const cancelPendingTouch = () => {
        if (!pendingTouch) return;
        clearTimeout(pendingTouch.timer);
        pendingTouch = null;
      };
      handle.addEventListener('pointerdown', event => {
        if (event.pointerType === 'mouse' || pendingTouch || pointerDrag) return;
        handle.setPointerCapture(event.pointerId);
        const startX = event.clientX, startY = event.clientY;
        const pointerId = event.pointerId;
        const timer = setTimeout(() => {
          if (!pendingTouch || pendingTouch.pointerId !== pointerId) return;
          pendingTouch = null;
          pointerDrag = { from: index, pointerId };
          item.classList.add('is-dragging');
          handle.setAttribute('aria-grabbed', 'true');
        }, 300);
        pendingTouch = { timer, pointerId, startX, startY };
      });
      handle.addEventListener('pointermove', event => {
        if (pendingTouch?.pointerId === event.pointerId &&
            Math.hypot(event.clientX - pendingTouch.startX, event.clientY - pendingTouch.startY) > 8) {
          cancelPendingTouch();
        }
        if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
        event.preventDefault(); clearDropIndicators(list);
        const targetItem = document.elementFromPoint(event.clientX, event.clientY)?.closest('.complete-selected-field');
        if (!targetItem || targetItem === item) return;
        const rect = targetItem.getBoundingClientRect(); targetItem.classList.add(event.clientX >= rect.left + rect.width / 2 ? 'is-drop-after' : 'is-drop-before');
      });
      const finishPointer = event => {
        if (pendingTouch?.pointerId === event.pointerId) cancelPendingTouch();
        if (!pointerDrag || pointerDrag.pointerId !== event.pointerId) return;
        const from = pointerDrag.from;
        const targetItem = document.elementFromPoint(event.clientX, event.clientY)?.closest('.complete-selected-field');
        const targetIndex = targetItem ? Number(targetItem.dataset.index) : -1;
        const after = Boolean(targetItem?.classList.contains('is-drop-after'));
        pointerDrag = null;
        item.classList.remove('is-dragging');
        handle.setAttribute('aria-grabbed', 'false');
        clearDropIndicators(list);
        if (event.type !== 'pointercancel' && targetIndex >= 0 && targetItem !== item) {
          let to = targetIndex + (after ? 1 : 0);
          if (from < to) to--;
          commitSelectedMove(from, Math.max(0, Math.min(state.selected.length - 1, to)));
        }
      };
      handle.addEventListener('pointerup', finishPointer); handle.addEventListener('pointercancel', finishPointer);
      handle.addEventListener('lostpointercapture', event => {
        if (pendingTouch?.pointerId === event.pointerId) cancelPendingTouch();
        if (pointerDrag?.pointerId !== event.pointerId) return;
        pointerDrag = null;
        item.classList.remove('is-dragging');
        handle.setAttribute('aria-grabbed', 'false');
        clearDropIndicators(list);
      });
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'btn btn-ghost btn-xs complete-selected-remove'; remove.textContent = '×'; remove.setAttribute('aria-label', '删除字段'); remove.title = '删除字段';
      remove.addEventListener('click', () => { state.selected = state.selected.filter(id => id !== field.fieldId); renderCatalog(); renderSelected(); updateRange(); });
      const fallback = document.createElement('details'); fallback.className = 'complete-selected-more';
      const more = document.createElement('summary'); more.textContent = '⋯'; more.setAttribute('aria-label', '更多排序操作'); fallback.appendChild(more);
      for (const [title, delta] of [['前移', -1], ['后移', 1]]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = title;
        button.disabled = index + delta < 0 || index + delta >= state.selected.length;
        button.addEventListener('click', () => commitSelectedMove(index, index + delta)); fallback.appendChild(button);
      }
      item.append(handle, order, label, remove, fallback); list.appendChild(item);
    });
  }
  function applyPreset(id) {
    const preset = state.catalog?.presets?.find(item => item.presetId === id);
    if (!preset) return;
    state.selected = [...preset.fieldIds]; renderCatalog(); renderSelected(); updateRange();
  }
  async function loadCatalog() {
    state.catalog = await api.get('/api/standards/complete/fields?registryVersion=1');
    const select = byId('completePreset'); select.replaceChildren();
    for (const preset of state.catalog.presets) { const option = document.createElement('option'); option.value = preset.presetId; option.textContent = preset.label; select.appendChild(option); }
    applyPreset('common');
  }
  async function onCompleteFileSelected() {
    const file = currentFile(); text('#completeFileName', file?.name || '未选择文件');
    if (byId('completeFileName')) byId('completeFileName').title = file?.name || '';
    updateRange();
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.xlsx')) { setSummary('文件格式不支持', '仅支持 .xlsx。', 'fail'); return; }
    setSummary('正在读取工作簿', '正在列出工作表和推荐安全输出列…', 'working');
    try {
      const form = new FormData(); form.append('file', file); form.append('options', JSON.stringify(options()));
      const inspected = await api.request('/api/standards/complete/inspect', { method: 'POST', body: form });
      const select = byId('completeSheetName'); select.replaceChildren();
      for (const sheet of inspected.sheets) { const option = document.createElement('option'); option.value = sheet.name; option.textContent = `${sheet.name}（${sheet.rowCount} 行 × ${sheet.columnCount} 列）`; option.dataset.recommendedOutput = sheet.recommendedOutputColumn; select.appendChild(option); }
      if (inspected.sheets[0]) byId('completeOutputColumn').value = inspected.sheets[0].recommendedOutputColumn;
      setSummary('可直接执行补全', `已读取工作表；请确认坐标和 ${state.selected.length} 个字段。执行阶段会再次检查资源上限、合并区域和输出冲突。`, 'ready'); updateRange();
    } catch (error) { setSummary('读取失败', error.message, 'fail'); }
  }
  function renderTask(task) {
    setSummary(task.status === 'success' ? '补全完成' : task.status === 'failed' ? '补全失败' : task.status === 'cancelled' ? '任务已取消' : task.message, `${task.phase} · ${task.current || 0}/${task.total || 0}`, task.status === 'failed' ? 'fail' : task.status === 'success' ? 'success' : 'working');
    byId('completeCancelBtn').hidden = !['queued', 'running'].includes(task.status);
    if (task.status === 'success' && task.downloadUrl) {
      const container = byId('completeDownload'); container.replaceChildren(); const link = document.createElement('a'); link.className = 'btn btn-primary btn-sm'; link.href = task.downloadUrl; link.download = task.fileName || ''; link.textContent = `下载 ${task.fileName || '补全结果'}`; container.appendChild(link);
      stopTracking();
    } else if (['failed', 'cancelled'].includes(task.status)) stopTracking();
  }
  function stopTracking() {
    state.eventSource?.close(); state.eventSource = null; clearInterval(state.pollTimer); state.pollTimer = null;
  }
  function trackTask() {
    stopTracking();
    const stream = new EventSource(`/api/standards/complete/tasks/${encodeURIComponent(state.taskId)}/stream`); state.eventSource = stream;
    stream.onmessage = event => { const envelope = JSON.parse(event.data); if (envelope.error) setSummary('进度错误', envelope.error.message, 'fail'); else renderTask(envelope.data); };
    stream.onerror = () => { stream.close(); state.eventSource = null; if (!state.pollTimer) state.pollTimer = setInterval(async () => { try { renderTask(await api.get(`/api/standards/complete/tasks/${encodeURIComponent(state.taskId)}`)); } catch (error) { setSummary('进度获取失败', error.message, 'fail'); } }, 1500); };
    StdHub.lifecycle.register('complete', 'task-stream', stopTracking);
  }
  async function doComplete() {
    if (!validOptions()) { setSummary('配置不完整', '请选择工作表并确认坐标和字段。', 'fail'); return; }
    const form = new FormData(); form.append('file', currentFile()); form.append('options', JSON.stringify(options()));
    try { const task = await api.request('/api/standards/complete', { method: 'POST', body: form }); state.taskId = task.id; renderTask(task); trackTask(); }
    catch (error) { setSummary('执行失败', error.message, 'fail'); }
  }
  async function cancelCompleteTask() { if (state.taskId) renderTask(await api.post(`/api/standards/complete/tasks/${encodeURIComponent(state.taskId)}/cancel`, {})); }

  function bind() {
    byId('completePreset')?.addEventListener('change', event => applyPreset(event.target.value));
    byId('completeFieldSearch')?.addEventListener('input', renderCatalog);
    ['completeHeaderRow', 'completeInputColumn', 'completeOutputColumn'].forEach(id => byId(id)?.addEventListener('input', updateRange));
    byId('completeSheetName')?.addEventListener('change', event => {
      const recommended = event.target.selectedOptions?.[0]?.dataset?.recommendedOutput;
      if (recommended) byId('completeOutputColumn').value = recommended;
      updateRange();
    });
  }
  async function init() { try { await loadCatalog(); bind(); updateRange(); } catch (error) { setSummary('字段目录加载失败', error.message, 'fail'); } }

  Object.assign(global, { onCompleteFileSelected, doComplete, cancelCompleteTask });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else void init();
})(window);
