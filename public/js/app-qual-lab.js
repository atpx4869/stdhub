// ── Fixed Hubei qualification snapshots & sync ──

function renderHubeiQualificationSource(source) {
  const id = escapeHtml(source.institutionId || '—');
  const name = escapeHtml(source.labName || '湖北省产品质量监督检验研究院');
  const records = Number(source.recordCount || 0).toLocaleString('zh-CN');
  const lastSync = source.lastSyncAt ? utcToBeijing(source.lastSyncAt) : '尚未同步';
  const lastCheck = source.lastCheckAt ? utcToBeijing(source.lastCheckAt) : '—';
  const snapshotText = source.snapshotAvailable
    ? `本地快照可用 · ${records} 条`
    : '本地尚无可查询数据';
  const statusColors = { success: 'var(--success)', syncing: 'var(--warning)', error: 'var(--danger)', pending: 'var(--text-3)' };
  const color = statusColors[source.syncStatus] || 'var(--text-3)';
  const progress = source.syncProgress
    ? `<div style="margin-top:6px;color:var(--accent)">同步进度：${source.syncProgress.fetched}/${source.syncProgress.total || '?'}</div>`
    : '';
  const error = source.syncError
    ? `<div style="margin-top:6px;color:var(--danger);font-size:12px">最近错误：${escapeHtml(source.syncError)}</div>`
    : '';
  return `<div class="qual-lab-card qual-fixed-source-card">
    <div class="qual-lab-header">
      <div>
        <div class="qual-lab-name">${escapeHtml(source.source)} · ${name}</div>
        <div class="qual-lab-meta">编号：${id}</div>
      </div>
      <div class="qual-lab-actions">
        <button data-stdhub-click="syncHubeiQualificationSource('${String(source.source || '').toLowerCase()}',this)">同步 ${escapeHtml(source.source)}</button>
      </div>
    </div>
    <div class="qual-lab-meta" style="line-height:1.7">
      <div>状态：<span style="color:${color}">${escapeHtml(source.syncStatus || 'pending')}</span> · ${snapshotText}</div>
      <div>最近成功同步：${lastSync} · 最近检查：${lastCheck}</div>
      ${progress}${error}
    </div>
  </div>`;
}

async function loadHubeiQualificationProfile(options) {
  const summary = document.getElementById('hubeiQualSummary');
  const sources = document.getElementById('hubeiQualSources');
  if (!summary || !sources) return;
  try {
    const res = await window.StdHub.api.fetch('/api/qualifications/profile');
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '加载资质数据失败');
    summary.innerHTML = `<div style="font-weight:600;color:var(--text)">${escapeHtml(data.displayName || '湖北省产品质量监督检验研究院')}</div>
      <div style="margin-top:6px;color:var(--text-3);font-size:12px">本地总记录：${Number(data.totalRecords || 0).toLocaleString('zh-CN')} 条 · 查询只读取本地快照</div>`;
    sources.innerHTML = [data.cnas, data.cma].filter(Boolean).map(renderHubeiQualificationSource).join('');
    const anySyncing = [data.cnas, data.cma].some(item => item && item.syncStatus === 'syncing');
    if (anySyncing && !(options && options.skipPollStart)) startSyncProgressPoll();
    return data;
  } catch (e) {
    const raw = String((e && e.message) || e || '加载资质数据失败');
    // 防御：无论上游/代理返回什么（HTML、超长文本），都只展示简短纯文本，
    // 绝不把代理错误页源码渲染到界面。
    const cleaned = raw.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    const message = /上游暂时不可用|Go\s*Reauth\s*Proxy|20005/i.test(cleaned)
      ? '上游服务暂时不可用，请稍后重试'
      : (cleaned.length > 200 ? cleaned.slice(0, 200) + '…' : cleaned || '加载资质数据失败');
    summary.innerHTML = `<span style="color:var(--danger)">加载失败：${escapeHtml(message)}</span>`;
    sources.innerHTML = '';
    return null;
  }
}

async function syncHubeiQualificationSource(source, btn) {
  const normalized = String(source || '').toLowerCase();
  if (!['cnas', 'cma', 'all'].includes(normalized)) return;
  const oldText = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
  const label = normalized === 'all' ? '全部来源' : normalized.toUpperCase();
  showToast(`正在同步${label}…`);
  startSyncProgressPoll();
  try {
    const res = await window.StdHub.api.fetch('/api/qualifications/sync/' + normalized, { method: 'POST' });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '同步失败');
    await loadHubeiQualificationProfile();
    await loadLabsSyncLogs();
    const parts = [];
    const failures = [];
    if (data.cnas && data.cnas.error) failures.push('CNAS：' + data.cnas.error);
    else if (data.cnas) parts.push('CNAS ' + data.cnas.records + ' 条');
    if (data.cma && data.cma.error) failures.push('CMA：' + data.cma.error);
    else if (data.cma) parts.push('CMA ' + data.cma.records + ' 条');
    if (failures.length) showToast('部分同步失败：' + failures.join('；'), 'fail');
    else showToast('同步完成' + (parts.length ? '：' + parts.join('，') : ''));
  } catch (e) {
    await loadHubeiQualificationProfile();
    showToast(`同步失败：${e.message || e}`, 'fail');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = oldText || '同步'; }
  }
}

let _qualSyncPollTimer = null;

function stopQualSyncPoll() {
  if (_qualSyncPollTimer) { clearInterval(_qualSyncPollTimer); _qualSyncPollTimer = null; }
}
(window._tabCleanup = window._tabCleanup || {}).qualSyncPoll = stopQualSyncPoll;

function startSyncProgressPoll() {
  if (_qualSyncPollTimer) return;
  _qualSyncPollTimer = setInterval(async () => {
    const fixedPage = document.getElementById('hubeiQualSources');
    if (fixedPage) {
      const data = await loadHubeiQualificationProfile({ skipPollStart: true });
      const anySyncing = [data && data.cnas, data && data.cma].some(item => item && item.syncStatus === 'syncing');
      if (!anySyncing) {
        clearInterval(_qualSyncPollTimer);
        _qualSyncPollTimer = null;
        loadLabsSyncLogs();
      }
      return;
    }
    clearInterval(_qualSyncPollTimer);
    _qualSyncPollTimer = null;
  }, 2000);
}

// ── Fixed qualification sync logs ──

async function loadLabsSyncLogs() {
  const container = document.getElementById('qualLabsSyncLogs');
  if (!container) return;
  try {
    const [cnasRes, cmaRes] = await Promise.all([
      fetch('/api/qualifications/labs/cnas/sync-logs?limit=15'),
      fetch('/api/qualifications/labs/cma/sync-logs?limit=15'),
    ]);
    const cnasData = await readApiResponse(cnasRes);
    const cmaData = await readApiResponse(cmaRes);
    const cnasLogs = cnasData.items || cnasData || [];
    const cmaLogs = cmaData.items || cmaData || [];
    const allLogs = [
      ...cnasLogs.map(l => ({ ...l, _src: 'CNAS' })),
      ...cmaLogs.map(l => ({ ...l, _src: 'CMA' })),
    ].sort((a, b) => (b.startedAt || '').localeCompare(a.startedAt || ''));
    if (!allLogs.length) { container.innerHTML = '<div style="color:var(--text-3);padding:16px 0;text-align:center">暂无同步记录</div>'; return; }
    const statusColors = { success: 'var(--success)', error: 'var(--danger)' };
    container.innerHTML = allLogs.slice(0, 30).map(l => {
      const time = utcToBeijing(l.startedAt);
      const idField = l.labNo || l.certNumber || '';
      return `<div class="qual-sync-log">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span><span style="color:var(--text-2);font-size:10px;margin-right:4px">${l._src}</span><span style="color:var(--text)">${escapeHtml(idField)}</span> ${escapeHtml(l.action)}</span>
          <span style="color:${statusColors[l.status] || 'var(--text-3)'}">${l.status}</span>
        </div>
        <div class="log-time">${time} | ${l.recordsFetched} 条${l.errorMessage ? ' | <span style="color:var(--danger)">' + escapeHtml(l.errorMessage) + '</span>' : ''}</div>
      </div>`;
    }).join('');
  } catch (e) { container.innerHTML = ''; }
}

// ── 国CMA：本院已批准表格库。旧在线采集/订阅入口保持停用。 ──
let _natCmaSearchOffset = 0;
let _natCmaSearchTotal = 0;
let _natCmaTablePreview = null;
let _natCmaTableSearchSequence = 0;
let _natCmaTableBusy = false;
let _natCmaTableLoaded = false;
const NAT_CMA_TABLE_ORG = '湖北省产品质量监督检验研究院';
function natCmaTableEsc(value) {
  return String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function natCmaTableAdmin() { return typeof currentUser !== 'undefined' && currentUser.role === 'admin'; }
function natCmaTableAllowed() {
  return typeof currentUser !== 'undefined' && (natCmaTableAdmin() || currentUser.allowedTabs === null || (Array.isArray(currentUser.allowedTabs) && currentUser.allowedTabs.includes('qual')));
}
function natCmaTableText(id, text) { const node = document.getElementById(id); if (node) node.textContent = text; }
function natCmaTableError(id, error) {
  natCmaTableText(id, '操作失败：' + String(error && error.message || error || '请稍后重试').slice(0, 300));
}
async function natCmaTableApi(path, init) {
  // 使用应用原生 fetch（包含现有 CSRF patch），multipart 不手动设置 Content-Type。
  const res = await fetch('/api/nat-cma/table' + path, init);
  const data = await readApiResponse(res);
  if (!res.ok) throw new Error(data && data.message || '请求失败（' + res.status + '）');
  return data;
}
function natCmaTableBatchLabel(batch) {
  if (!batch) return '尚无启用批次';
  return (batch.name || batch.filename || '未命名批次') + ' · ' + (batch.filename || '') + ' · ' + Number(batch.rowCount || 0) + ' 行 / ' + Number(batch.standardCount || 0) + ' 个标准 · 导入时间：' + (batch.importedAt || '—');
}
function renderNatCmaTableEntries(entries) {
  const esc = natCmaTableEsc;
  return entries.map(row => '<article class="nat-cma-entry"><div><strong>' + esc(row.parameterNo) + ' ' + esc(row.parameterName || '未标注参数名称') + '</strong></div>'
    + '<div>分类：' + esc([row.majorCategory, row.category].filter(Boolean).join(' / ') || '—') + '</div>'
    + '<div>标准：' + esc(row.stdCode) + ' ' + esc(row.stdName) + '</div>'
    + (row.standardWarning ? '<div class="nat-cma-limit">标准号识别警告：' + esc(row.standardWarning) + '（此原表行仅供人工核对，不参与徽章自动匹配）</div>' : '')
    + '<div class="nat-cma-limit">限制范围：' + esc(row.limitDesc || '表格未注明（不代表全项覆盖）') + '</div>'
    + '<div class="nat-cma-note">备注：' + esc(row.note || '—') + '</div>'
    + '<div class="nat-cma-provenance">来源：' + esc(row.sheetName || '未标注工作表') + ' · 原表第 ' + esc(row.rowNumber == null ? '—' : row.rowNumber) + ' 行</div></article>').join('');
}
function renderNatCmaTableGroups(items) {
  const esc = natCmaTableEsc;
  return items.map(item => {
    const entries = Array.isArray(item.entries) ? item.entries : [];
    const restricted = entries.some(row => row.limitDesc || row.note);
    return '<details class="nat-cma-standard"><summary><strong>' + esc(item.stdCode) + '</strong> ' + esc(item.stdName)
      + ' <span class="nat-cma-meta">' + Number(item.abilityCount || entries.length) + ' 个已批准参数 · ' + (restricted ? '含限制/备注' : '仅限所列参数')
      + '</span>' + (item.exactMatchAvailable === false ? ' <span class="nat-cma-limit">标准号待核对，不参与徽章自动匹配</span>' : '') + '</summary><div class="nat-cma-coverage">仅表示本批次表格列明的能力，不代表该标准全部项目。限制范围、备注须逐项核对。</div>'
      + renderNatCmaTableEntries(entries) + '</details>';
  }).join('');
}
async function loadNatCmaSubscriptions() {
  if (!document.getElementById('natCmaTablePanel') || !natCmaTableAllowed()) return;
  const admin = document.getElementById('natCmaTableAdmin');
  if (admin) admin.hidden = !natCmaTableAdmin();
  natCmaTableText('natCmaSection', '正在读取已批准表格库…');
  try {
    const data = await natCmaTableApi('/status');
    natCmaTableText('natCmaSection', NAT_CMA_TABLE_ORG + ' · 国CMA · 来源：已批准表格（approved_table） · ' + natCmaTableBatchLabel(data.batch) + ' · 共 ' + Number(data.batchCount || 0) + ' 个批次');
    _natCmaTableLoaded = true;
    if (natCmaTableAdmin()) await loadNatCmaTableBatches();
  } catch (error) { natCmaTableError('natCmaSection', error); }
}
async function searchNatCmaAbilities(offset) {
  if (!natCmaTableAllowed()) return;
  const input = document.getElementById('natCmaSearchInput');
  const category = document.getElementById('natCmaCategory');
  const resultBox = document.getElementById('natCmaSearchResults');
  if (!resultBox) return;
  const sequence = ++_natCmaTableSearchSequence;
  const nextOffset = Number.isFinite(offset) ? Math.max(0, Math.floor(offset)) : 0;
  const params = new URLSearchParams({ q: (input && input.value || '').trim(), limit: '20', offset: String(nextOffset) });
  if (category && category.value.trim()) params.set('category', category.value.trim());
  resultBox.setAttribute('aria-busy', 'true');
  natCmaTableText('natCmaSearchResults', '正在查询已批准参数…');
  try {
    const data = await natCmaTableApi('/search?' + params);
    if (sequence !== _natCmaTableSearchSequence) return;
    _natCmaSearchOffset = nextOffset;
    _natCmaSearchTotal = Number(data.total || 0);
    const items = Array.isArray(data.items) ? data.items : [];
    resultBox.innerHTML = '<div class="nat-cma-meta">' + natCmaTableEsc(natCmaTableBatchLabel(data.batch)) + ' · 共 ' + _natCmaSearchTotal + ' 个匹配标准 · 每页 20 个标准</div>'
      + (items.length ? renderNatCmaTableGroups(items) : '<p>未找到匹配的已批准参数；不据此推断其他来源的资质。</p>')
      + '<div class="nat-cma-pagination"><button type="button" class="btn btn-sm btn-ghost" data-nat-cma-offset="' + Math.max(0, nextOffset - 20) + '" ' + (nextOffset === 0 ? 'disabled' : '') + '>上一页</button>'
      + '<span>第 ' + (Math.floor(nextOffset / 20) + 1) + ' / ' + Math.max(1, Math.ceil(_natCmaSearchTotal / 20)) + ' 页</span>'
      + '<button type="button" class="btn btn-sm btn-ghost" data-nat-cma-offset="' + (nextOffset + 20) + '" ' + (nextOffset + 20 >= _natCmaSearchTotal ? 'disabled' : '') + '>下一页</button></div>';
  } catch (error) { if (sequence === _natCmaTableSearchSequence) natCmaTableError('natCmaSearchResults', error); }
  finally { if (sequence === _natCmaTableSearchSequence) resultBox.setAttribute('aria-busy', 'false'); }
}
async function loadNatCmaTableBatches() {
  if (!natCmaTableAdmin()) return;
  natCmaTableText('natCmaTableBatches', '正在读取批次历史…');
  try {
    const data = await natCmaTableApi('/batches');
    const box = document.getElementById('natCmaTableBatches');
    if (!box) return;
    box.innerHTML = (data.items || []).map(batch => '<div class="nat-cma-batch"><span>' + natCmaTableEsc(natCmaTableBatchLabel(batch)) + '</span> '
      + (batch.active ? '<strong>当前启用</strong>' : '<button type="button" class="btn btn-sm btn-ghost" data-nat-cma-activate="' + natCmaTableEsc(batch.id) + '">启用 / 回滚至此批次</button>') + '</div>').join('') || '暂无导入历史';
  } catch (error) { natCmaTableError('natCmaTableBatches', error); }
}
function natCmaTableSetBusy(busy) {
  _natCmaTableBusy = busy;
  const node = document.getElementById('natCmaTableAdmin');
  if (node) node.querySelectorAll('button,input').forEach(el => { el.disabled = busy; });
}
async function previewNatCmaTable() {
  if (!natCmaTableAdmin() || _natCmaTableBusy) return;
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
    const data = await natCmaTableApi('/preview', { method: 'POST', body: form });
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
  } catch (error) { natCmaTableError('natCmaTablePreview', error); }
  finally { natCmaTableSetBusy(false); }
}
async function confirmNatCmaTable() {
  if (!natCmaTableAdmin() || _natCmaTableBusy || !_natCmaTablePreview) return;
  const previewId = _natCmaTablePreview;
  if (!await showConfirm({ title: '确认国CMA表格导入', body: '新文件将保存并启用为当前版本；若文件已导入，仅复用已有批次，不自动切换版本（须在历史中另行启用）。仅以所列参数及限制为准。', confirmText: '确认导入并启用' })) return;
  if (!natCmaTableAdmin() || _natCmaTableBusy || previewId !== _natCmaTablePreview) return;
  const name = document.getElementById('natCmaTableBatchName');
  natCmaTableSetBusy(true);
  try {
    const data = await natCmaTableApi('/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ previewId, name: name && name.value.trim() || undefined }) });
    _natCmaTablePreview = null;
    const button = document.getElementById('natCmaTableConfirm'); if (button) button.hidden = true;
    natCmaTableText('natCmaTablePreview', (data.alreadyImported ? '文件已导入，已复用已有批次；当前启用版本未更改。如需回滚，请在批次历史中确认启用。' : '导入成功，已启用新批次。') + natCmaTableBatchLabel(data.batch));
    if (typeof natCmaInvalidateCache === 'function') natCmaInvalidateCache();
    await loadNatCmaSubscriptions(); await searchNatCmaAbilities(0);
  } catch (error) { natCmaTableError('natCmaTablePreview', error); }
  finally { natCmaTableSetBusy(false); }
}
async function activateNatCmaTable(batchId) {
  if (!natCmaTableAdmin() || _natCmaTableBusy) return;
  if (!await showConfirm({ title: '切换国CMA查询批次', body: '确认启用批次 ' + String(batchId) + '？查询和徽章将使用该历史版本，可再次切换回其他批次。', confirmText: '确认启用' })) return;
  if (!natCmaTableAdmin() || _natCmaTableBusy) return;
  natCmaTableSetBusy(true);
  try {
    await natCmaTableApi('/activate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ batchId: Number(batchId) }) });
    if (typeof natCmaInvalidateCache === 'function') natCmaInvalidateCache();
    await loadNatCmaSubscriptions(); await searchNatCmaAbilities(0);
  } catch (error) { natCmaTableError('natCmaTableBatches', error); }
  finally { natCmaTableSetBusy(false); }
}
window.openNatCmaTableStandard = async function openNatCmaTableStandard(stdCode) {
  if (!natCmaTableAllowed()) { if (typeof showToast === 'function') showToast('没有资质查询权限', 'fail'); return; }
  if (typeof switchTab === 'function') switchTab('qual');
  const input = document.getElementById('natCmaSearchInput'); if (input) input.value = String(stdCode || '');
  const category = document.getElementById('natCmaCategory'); if (category) category.value = '';
  const panel = document.getElementById('natCmaTablePanel'); if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  await searchNatCmaAbilities(0);
};
// Legacy globals stay inert: never reactivate suspended crawlers or subscription APIs.
function stopNatCmaSyncPoll() {}
function startNatCmaSyncPoll() {}
function subscribeNatCma() {}
function unsubscribeNatCma() {}
function syncNatCma() {}
function syncAllNatCma() {}
function loadNatCmaOrgs() { return loadNatCmaSubscriptions(); }
(window._tabCleanup = window._tabCleanup || {}).natCmaSyncPoll = stopNatCmaSyncPoll;
window.addEventListener('tabchange', function (event) {
  if (event.detail && event.detail.tab === 'qual') {
    loadNatCmaSubscriptions();
    if (!_natCmaTableLoaded) searchNatCmaAbilities(0);
  }
});
function initNatCmaTablePanel() {
  const panel = document.getElementById('natCmaTablePanel');
  if (!panel || panel.dataset.bound) return;
  panel.dataset.bound = 'true';
  panel.addEventListener('click', function (event) {
    const button = event.target.closest('button'); if (!button || !panel.contains(button) || button.disabled) return;
    if (button.hasAttribute('data-nat-cma-offset')) searchNatCmaAbilities(Number(button.dataset.natCmaOffset));
    else if (button.hasAttribute('data-nat-cma-activate')) activateNatCmaTable(button.dataset.natCmaActivate);
    else if (button.id === 'natCmaTableSearch') searchNatCmaAbilities(0);
    else if (button.id === 'natCmaTablePreviewButton') previewNatCmaTable();
    else if (button.id === 'natCmaTableConfirm') confirmNatCmaTable();
    else if (button.id === 'natCmaTableRefresh') loadNatCmaSubscriptions();
  });
  panel.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && ['natCmaSearchInput', 'natCmaCategory'].includes(event.target.id)) { event.preventDefault(); searchNatCmaAbilities(0); }
  });
  const file = document.getElementById('natCmaTableFile');
  if (file) file.addEventListener('change', function () { _natCmaTablePreview = null; const button = document.getElementById('natCmaTableConfirm'); if (button) button.hidden = true; natCmaTableText('natCmaTablePreview', '文件已选择；请点击「上传并预览」，不会自动导入。'); });
  const page = document.getElementById('page-qual');
  if (page && page.classList.contains('active')) { loadNatCmaSubscriptions(); searchNatCmaAbilities(0); }
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initNatCmaTablePanel);
else initNatCmaTablePanel();
