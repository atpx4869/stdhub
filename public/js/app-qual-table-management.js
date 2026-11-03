/** Settings-only management for the local approved table; no online collection. */
(function setupNatCmaTableManagement() {
  const root = window.StdHub;
  let _natCmaTablePreview = null;
  let _natCmaTableBusy = false;
  let generation = 0;
  let controller = null;
  let mounted = null;
  function isCurrent(epoch) { return epoch === generation && natCmaTableAdmin() && mounted && mounted === document.getElementById('natCmaTableAdmin'); }
  async function adminApi(path, init) {
    const epoch = generation;
    if (!isCurrent(epoch)) throw new Error('请以管理员身份重新打开资质数据');
    const data = await natCmaTableApi(path, { ...(init || {}), signal: controller.signal });
    if (!isCurrent(epoch)) throw new Error('权限或页面已变更，请重新预览');
    return data;
  }
  function resetPreview(message) {
    _natCmaTablePreview = null;
    const button = document.getElementById('natCmaTableConfirm');
    if (button) button.hidden = true;
    natCmaTableText('natCmaTablePreview', message || '');
  }
  function dispose() {
    generation++;
    if (controller) controller.abort();
    // A cancelled write may already have committed server-side; never retain old badge evidence.
    if (_natCmaTableBusy && typeof natCmaInvalidateCache === 'function') natCmaInvalidateCache();
    if (mounted) { mounted.removeEventListener('click', onClick); mounted.removeEventListener('change', onChange); }
    resetPreview();
    const file = document.getElementById('natCmaTableFile'); if (file) file.value = '';
    const name = document.getElementById('natCmaTableBatchName'); if (name) name.value = '';
    natCmaTableSetBusy(false);
    mounted = null; controller = null;
  }
  async function refresh() {
    const epoch = generation;
    try {
      const data = await adminApi('/status');
      natCmaTableText('natCmaTableAdminStatus', natCmaTableBatchLabel(data.batch) + ' · 共 ' + Number(data.batchCount || 0) + ' 个批次');
      await loadNatCmaTableBatches();
    } catch (error) { if (isCurrent(epoch)) natCmaTableError('natCmaTableAdminStatus', error); }
  }
  async function refreshAfterMutation() {
    await refresh();
    await loadNatCmaSubscriptions();
    if (natCmaTableAllowed()) await searchNatCmaAbilities(0);
  }
  async function loadNatCmaTableBatches() {
    if (!natCmaTableAdmin()) return;
    const epoch = generation;
    natCmaTableText('natCmaTableBatches', '正在读取批次历史…');
    try {
      const data = await adminApi('/batches');
      const box = document.getElementById('natCmaTableBatches');
      if (!box) return;
      box.innerHTML = (data.items || []).map(batch => '<div class="nat-cma-batch"><span>' + natCmaTableEsc(natCmaTableBatchLabel(batch)) + '</span> '
        + (batch.active ? '<strong>当前启用</strong>' : '<button type="button" class="btn btn-sm btn-ghost" data-nat-cma-activate="' + natCmaTableEsc(batch.id) + '">启用 / 回滚至此批次</button>') + '</div>').join('') || '暂无导入历史';
    } catch (error) { if (isCurrent(epoch)) natCmaTableError('natCmaTableBatches', error); }
  }
  function natCmaTableSetBusy(busy) {
    _natCmaTableBusy = busy;
    const node = document.getElementById('natCmaTableAdmin');
    if (node) node.querySelectorAll('button,input').forEach(el => { el.disabled = busy; });
  }
  async function previewNatCmaTable() {
    if (!natCmaTableAdmin() || _natCmaTableBusy) return;
    const epoch = generation;
    const input = document.getElementById('natCmaTableFile');
    const file = input && input.files && input.files[0];
    _natCmaTablePreview = null;
    const confirm = document.getElementById('natCmaTableConfirm');
    if (confirm) confirm.hidden = true;
    if (!file) { natCmaTableText('natCmaTablePreview', '请先选择已批准的 Excel 表格文件。'); return; }
    natCmaTableSetBusy(true);
    natCmaTableText('natCmaTablePreview', '正在解析预览，尚未导入或切换批次…');
    try {
      const form = new FormData(); form.append('file', file);
      const data = await adminApi('/preview', { method: 'POST', body: form });
      const esc = natCmaTableEsc;
      const warnings = Array.isArray(data.warnings) ? data.warnings : [];
      const samples = Array.isArray(data.samples) ? data.samples : [];
      const box = document.getElementById('natCmaTablePreview');
      if (box) box.innerHTML = '<p><strong>预览（未导入）：' + esc(data.filename) + '</strong></p><p>'
        + Number(data.rowCount || 0) + ' 行 · ' + Number(data.standardCount || 0) + ' 个标准 · ' + Number(data.categoryCount || 0) + ' 个大类 · ' + Number(data.productCount || 0) + ' 个产品类别 · 重复 ' + Number(data.duplicateCount || 0) + ' 行 · 警告 ' + Number(data.warningCount || 0) + ' 条</p>'
        + '<p class="nat-cma-meta">SHA-256：' + esc(data.sha256) + (data.existingBatchId != null ? ' · 已存在批次：' + esc(data.existingBatchId) + '（重复文件不会自动切换当前版本；如需启用，请在批次历史中确认切换）' : '') + '</p>'
        + '<p>警告（最多展示 50 条）：</p><ul>' + warnings.slice(0, 50).map(w => '<li>第 ' + esc(w.row) + ' 行：' + esc(w.message) + '</li>').join('') + '</ul>'
        + '<details open><summary>参数样例（最多 10 行，非完整覆盖清单）</summary>' + renderNatCmaTableEntries(samples.slice(0, 10)) + '</details>'
        + '<p>请核对限制、备注和警告后，点击「确认导入并启用」。预览不会自动导入。</p>';
      _natCmaTablePreview = data.previewId;
      if (confirm) confirm.hidden = !data.previewId;
    } catch (error) { if (isCurrent(epoch)) natCmaTableError('natCmaTablePreview', error); }
    finally { if (isCurrent(epoch)) natCmaTableSetBusy(false); }
  }
  async function confirmNatCmaTable() {
    if (!natCmaTableAdmin() || _natCmaTableBusy || !_natCmaTablePreview) return;
    const epoch = generation;
    const previewId = _natCmaTablePreview;
    if (!await showConfirm({ title: '确认国CMA表格导入', body: '新文件将保存并启用为当前版本；若文件已导入，仅复用已有批次，不自动切换版本（须在历史中另行启用）。仅以所列参数及限制为准。', confirmText: '确认导入并启用' })) return;
    if (!isCurrent(epoch) || _natCmaTableBusy || previewId !== _natCmaTablePreview) return;
    const name = document.getElementById('natCmaTableBatchName');
    natCmaTableSetBusy(true);
    try {
      const data = await adminApi('/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewId, name: name && name.value.trim() || undefined }) });
      _natCmaTablePreview = null;
      const button = document.getElementById('natCmaTableConfirm'); if (button) button.hidden = true;
      natCmaTableText('natCmaTablePreview', (data.alreadyImported ? '文件已导入，已复用已有批次；当前启用版本未更改。如需回滚，请在批次历史中确认启用。' : '导入成功，已启用新批次。') + natCmaTableBatchLabel(data.batch));
      if (typeof natCmaInvalidateCache === 'function') natCmaInvalidateCache();
      await refreshAfterMutation();
    } catch (error) { if (isCurrent(epoch)) natCmaTableError('natCmaTablePreview', error); }
    finally { if (isCurrent(epoch)) natCmaTableSetBusy(false); }
  }
  async function activateNatCmaTable(batchId) {
    if (!natCmaTableAdmin() || _natCmaTableBusy) return;
    const epoch = generation;
    if (!await showConfirm({ title: '切换国CMA查询批次', body: '确认启用批次 ' + String(batchId) + '？查询和徽章将使用该历史版本，可再次切换回其他批次。', confirmText: '确认启用' })) return;
    if (!isCurrent(epoch) || _natCmaTableBusy) return;
    natCmaTableSetBusy(true);
    try {
      await adminApi('/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: Number(batchId) }) });
      if (typeof natCmaInvalidateCache === 'function') natCmaInvalidateCache();
      await refreshAfterMutation();
    } catch (error) { if (isCurrent(epoch)) natCmaTableError('natCmaTableBatches', error); }
    finally { if (isCurrent(epoch)) natCmaTableSetBusy(false); }
  }

  function onClick(event) {
    const button = event.target.closest('button');
    if (!button || !mounted || !mounted.contains(button) || button.disabled) return;
    if (button.hasAttribute('data-nat-cma-activate')) return activateNatCmaTable(button.dataset.natCmaActivate);
    else if (button.id === 'natCmaTablePreviewButton') return previewNatCmaTable();
    else if (button.id === 'natCmaTableConfirm') return confirmNatCmaTable();
    else if (button.id === 'natCmaTableAdminRefresh') return refresh();
  }
  function onChange(event) {
    if (event.target.id === 'natCmaTableFile') resetPreview('文件已选择；请点击「上传并预览」，不会自动导入。');
  }
  function mount() {
    dispose();
    if (!natCmaTableAdmin()) return;
    mounted = document.getElementById('natCmaTableAdmin');
    if (!mounted) return;
    controller = new AbortController();
    mounted.addEventListener('click', onClick); mounted.addEventListener('change', onChange);
    return refresh();
  }
  root.lifecycle.register('tab', 'nat-cma-table-management', dispose);
  root.natCmaTableManagement = { render: () => natCmaTableAdmin() ? `
          <section class="set-card" id="natCmaTableAdmin" data-admin-only aria-labelledby="natCmaTableAdminTitle"><div class="set-card-head"><h3 id="natCmaTableAdminTitle">国CMA · 已批准表格管理</h3><button type="button" class="btn btn-sm btn-ghost" id="natCmaTableAdminRefresh">刷新状态 / 历史</button></div><div class="set-card-body"><p>固定来源：本院已批准表格（approved_table）。在线采集保持停用，导入与远程 CNAS / CMA 同步相互独立。</p><div id="natCmaTableAdminStatus" role="status" aria-live="polite">打开资质数据后读取批次状态</div>
            <p>仅管理员可导入、启用或回滚。选择原始 Excel 文件 → 上传预览 → 核对样例与警告 → 明确确认后导入并启用。</p>
            <div class="nat-cma-import"><label for="natCmaTableFile">已批准表格文件</label><input id="natCmaTableFile" type="file" accept=".xlsx"><label for="natCmaTableBatchName">批次名称（可选）</label><input id="natCmaTableBatchName" type="text" maxlength="120" placeholder="不填写则使用默认名称"><button class="btn btn-sm btn-ghost" type="button" id="natCmaTablePreviewButton">上传并预览</button><button class="btn btn-sm btn-primary" type="button" id="natCmaTableConfirm" hidden>确认导入并启用</button></div>
            <div id="natCmaTablePreview" role="status" aria-live="polite"></div>
            <h3>批次历史 · 可确认切换 / 回滚</h3><div id="natCmaTableBatches" aria-live="polite"></div>
</div></section>
` : '', mount, dispose };
  // Authentication has no event bus yet. Chain its existing completion hook, without changing auth internals.
  const previousAuthReady = window.onAuthReady;
  function authReady() {
    dispose();
    resetNatCmaTableQuery();
    const previousPanel = document.getElementById('natCmaTableAdmin');
    if (previousPanel) previousPanel.remove();
    const result = previousAuthReady.apply(this, arguments);
    if (typeof natCmaInvalidateCache === 'function') natCmaInvalidateCache();
    if (document.getElementById('page-settings')?.style.display === 'block' && typeof renderSettings === 'function') renderSettings();
    if (document.getElementById('page-qual')?.style.display === 'block' && natCmaTableAllowed()) { loadNatCmaSubscriptions(); searchNatCmaAbilities(0); }
    return result;
  }
  window.onAuthReady = authReady;
  root.lifecycle.register('global', 'nat-cma-table-auth', () => { dispose(); if (window.onAuthReady === authReady) window.onAuthReady = previousAuthReady; });
})();
