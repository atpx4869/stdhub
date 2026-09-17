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
    summary.innerHTML = `<span style="color:var(--danger)">加载失败：${escapeHtml(e.message || String(e))}</span>`;
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

// ── 国家 CMA 订阅 ──────────────────────────────────────────────────────

let _natCmaSyncPollTimer = null;
let _natCmaSyncTaskId = null;
let _natCmaSearchOffset = 0;
let _natCmaSearchTotal = 0;

function stopNatCmaSyncPoll() {
  if (_natCmaSyncPollTimer) { clearInterval(_natCmaSyncPollTimer); _natCmaSyncPollTimer = null; }
  _natCmaSyncTaskId = null;
}
(window._tabCleanup = window._tabCleanup || {}).natCmaSyncPoll = stopNatCmaSyncPoll;

function startNatCmaSyncPoll(taskId) {
  if (taskId) _natCmaSyncTaskId = taskId;
  if (_natCmaSyncPollTimer) return;
  _natCmaSyncPollTimer = setInterval(async () => {
    await loadNatCmaSubscriptions();
    try {
      const res = await fetch('/api/nat-cma/sync/progress');
      const data = await readApiResponse(res);
      const progress = data?.items || {};
      const states = Object.values(progress);
      const anySyncing = states.some(p => p.status === 'syncing' || p.status === 'queued');
      if (!anySyncing) {
        clearInterval(_natCmaSyncPollTimer);
        _natCmaSyncPollTimer = null;
        const failed = states.find(p => p.status === 'error');
        if (_natCmaSyncTaskId && typeof completeTaskCenterTask === 'function') {
          if (failed) {
            completeTaskCenterTask(_natCmaSyncTaskId, 'fail', { error: failed.error || '国家 CMA 同步失败', progress: failed.error || '国家 CMA 同步失败' });
          } else {
            completeTaskCenterTask(_natCmaSyncTaskId, 'success', { progress: '国家 CMA 机构级能力同步完成' });
          }
        }
        if (failed && typeof showToast === 'function') showToast('国家 CMA 同步失败：' + (failed.error || '请稍后重试'), 'error');
        if (!failed && typeof natCmaInvalidateCache === 'function') natCmaInvalidateCache();
        _natCmaSyncTaskId = null;
      }
    } catch { /* 保持轮询，等待下一次接口恢复 */ }
  }, 2000);
}

function formatNatCmaSyncStatus(place) {
  const statusColors = { success: 'var(--success)', syncing: 'var(--warning)', error: 'var(--danger)', pending: 'var(--text-3)' };
  const status = place.syncStatus || 'pending';
  const color = statusColors[status] || 'var(--text-3)';
  if (status === 'syncing' && place.syncProgress) {
    const { fetched, total } = place.syncProgress;
    const pct = total > 0 ? Math.round(fetched / total * 100) : 0;
    return `<span style="color:${color}">同步中</span> <span style="color:var(--accent);font-weight:600">${fetched}/${total > 0 ? total : '?'}</span>${total > 0 ? ` (${pct}%)` : ''}`;
  }
  if (status === 'pending') return `<span style="color:var(--text-3)">待同步</span>`;
  return `<span style="color:${color}">${status}</span>`;
}

async function loadNatCmaSubscriptions() {
  const container = document.getElementById('natCmaSection');
  if (!container) return;

  try {
    const res = await fetch('/api/nat-cma/orgs');
    const data = await readApiResponse(res);
    const orgs = (data && (data.items || data)) || [];
    if (!orgs.length) {
      container.innerHTML = '<div style="color:var(--text-3);font-size:12px">暂无内置机构</div>';
      return;
    }

    const providerReady = false;
    const providerMessage = '国家 CMA 数据源无限期暂停；当前仅保留已有本地数据的只读展示。';
    const esc = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    // 健康状态面板
    let healthHtml = '';
    try {
      const statusRes = await fetch('/api/nat-cma/status');
      const statusData = await readApiResponse(statusRes);
      if (statusData && statusData.providerReady) {
        const lastSync = statusData.lastSynced ? utcToBeijing(statusData.lastSynced) : '从未同步';
        const errColor = (statusData.errorCount || 0) > 0 ? 'var(--danger)' : 'var(--success)';
        healthHtml = '<div class="set-card" style="padding:10px 12px;margin:0 0 10px;display:flex;gap:16px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--text-2)">'
          + '<span>能力记录: <strong style="color:var(--accent)">' + (statusData.totalAbilities || 0) + '</strong></span>'
          + '<span>上次同步: <strong style="color:var(--text)">' + lastSync + '</strong></span>'
          + '<span>成功: <strong style="color:var(--success)">' + (statusData.successCount || 0) + '</strong></span>'
          + '<span>失败: <strong style="color:' + errColor + '">' + (statusData.errorCount || 0) + '</strong></span>'
          + (statusData.lastError ? '<span style="color:var(--danger)" title="' + esc(statusData.lastError) + '">最近错误: ' + esc(statusData.lastError).slice(0, 50) + '</span>' : '')
          + '</div>';
      }
    } catch (_e) { /* 静默 */ }

    const providerNotice = !providerReady
      ? '<div class="set-card" style="padding:12px;margin:0 0 10px;border-left:3px solid var(--warning)">'
        + '<div style="color:var(--warning);font-size:12px;font-weight:600">国家 CMA 真实数据源待接入</div>'
        + '<div style="margin-top:4px;color:var(--text-2);font-size:11px">' + esc(providerMessage) + '</div></div>'
      : '';

    const cards = orgs.map(org => {
      const totalAbilities = org.abilityCount || 0;
      const places = org.places.map(place => {
        const statusHtml = formatNatCmaSyncStatus(place);
        const lastSync = place.lastSyncedAt ? utcToBeijing(place.lastSyncedAt) : '—';
        const certStatusColor = /正常|有效/.test(place.certStatus || '') ? 'var(--success)' : (place.certStatus ? 'var(--warning)' : 'var(--text-3)');
        const actions = '<span style="color:var(--warning);font-size:11px">国家 CMA 同步已暂停</span>';
        const details = place.subscribed
          ? '<div style="margin-top:6px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:3px 12px;line-height:1.5;color:var(--text-2);font-size:11px">'
            + '<div>同步状态: ' + statusHtml + '</div><div>能力记录: <span style="color:var(--text)">' + (place.abilityCount || 0) + '</span></div><div>上次同步: <span style="color:var(--text)">' + lastSync + '</span></div>'
            + (place.syncProgress && place.syncProgress.status === 'syncing' && place.syncProgress.total > 0
              ? '<div>同步进度: <span style="color:var(--accent);font-weight:600">' + place.syncProgress.fetched + ' / ' + place.syncProgress.total + ' (' + Math.round(place.syncProgress.fetched / place.syncProgress.total * 100) + '%)</span></div>'
              : '')
            + (place.certStatus ? '<div>证书状态: <span style="color:' + certStatusColor + '">' + esc(place.certStatus) + '</span></div>' : '')
            + (place.certValidFrom ? '<div>有效期: <span style="color:var(--text)">' + esc(place.certValidFrom) + ' ~ ' + esc(place.certValidTo || '—') + '</span></div>' : '')
            + '</div>' + (place.syncError ? '<div style="color:var(--danger);font-size:11px;margin-top:4px">' + esc(place.syncError) + '</div>' : '')
          : '';
        return '<div style="padding:8px 10px;background:var(--surface-h);border-radius:4px;font-size:12px">'
          + '<div style="display:flex;align-items:center;justify-content:space-between"><div style="flex:1;min-width:0">'
          + '<span style="color:var(--accent);font-size:10px;margin-right:4px">' + esc(place.placeType) + '</span><span style="color:var(--text)">' + esc(place.placeName) + '</span>'
          + '<div style="color:var(--text-3);font-size:11px;margin-top:2px">' + esc(place.placeAddress) + '</div></div>'
          + '<div style="flex-shrink:0;margin-left:8px;display:flex;gap:4px;align-items:center">' + actions + '</div></div>' + details + '</div>';
      }).join('');
      return '<div class="qual-lab-card" style="border-left:3px solid var(--accent)"><div class="qual-lab-header"><div class="qual-lab-name">' + esc(org.orgName) + '</div>'
        + '<div class="qual-lab-actions" style="font-size:11px;gap:6px;align-items:center"><span style="color:var(--text-3)">已订阅 ' + org.subscribedCount + '/' + org.totalCount + ' 个场所</span>'
        + '</div></div><div class="qual-lab-meta"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:4px 14px;line-height:1.6;font-size:12px;color:var(--text-2);margin-bottom:8px">'
        + '<div>证书编号: <span style="color:var(--text)">' + esc(org.certCode) + '</span></div><div>地址: <span style="color:var(--text)">' + esc(org.address) + '</span></div>'
        + (totalAbilities > 0 ? '<div>机构级能力条目: <span style="color:var(--accent)">' + totalAbilities + '</span></div>' : '')
        + '</div><div style="display:grid;gap:6px">' + places + '</div></div></div>';
    }).join('');
    container.innerHTML = healthHtml + providerNotice + cards;
  } catch (_) {
    container.innerHTML = '<div style="color:var(--danger);font-size:12px">加载国家 CMA 机构失败</div>';
  }
}

async function searchNatCmaAbilities(offset) {
  const input = document.getElementById('natCmaSearchInput');
  const resultBox = document.getElementById('natCmaSearchResults');
  const query = (input && input.value || '').trim();
  if (!query) {
    if (resultBox) resultBox.innerHTML = '<div style="color:var(--text-3);font-size:12px">请输入标准号、检测方法、产品或领域关键词</div>';
    return;
  }
  const nextOffset = Number.isFinite(offset) ? Math.max(0, offset) : 0;
  if (resultBox) resultBox.innerHTML = '<div style="color:var(--text-3);font-size:12px">正在检索本地国家 CMA 能力…</div>';
  try {
    const res = await fetch('/api/nat-cma/search?q=' + encodeURIComponent(query) + '&limit=20&offset=' + nextOffset);
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error((data && data.error) || '检索失败');
    const items = data.items || [];
    _natCmaSearchOffset = nextOffset;
    _natCmaSearchTotal = data.total || 0;
    if (!resultBox) return;
    if (!items.length) {
      resultBox.innerHTML = '<div style="color:var(--text-3);font-size:12px">未找到已同步的机构级能力记录</div>';
      return;
    }
    const esc = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const rows = items.map(item => '<div style="padding:8px 0;border-top:1px solid var(--border);font-size:12px">'
      + '<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class="qual-badge qual-badge-cma" style="cursor:default"><span class="qual-dot"></span>国家CMA·机构级</span><strong style="color:var(--text)">' + esc(item.stdCode || '未标注标准号') + '</strong><span style="color:var(--text-2)">' + esc(item.productName || item.stdName || '—') + '</span></div>'
      + '<div style="margin-top:3px;color:var(--text-3)">' + esc(item.orgName) + (item.category ? ' · ' + esc(item.category) : '') + (item.subCategory ? ' / ' + esc(item.subCategory) : '') + '</div>'
      + (item.limitDesc ? '<div style="margin-top:2px;color:var(--text-2)">' + esc(item.limitDesc) + '</div>' : '')
      + '</div>').join('');
    const previousDisabled = nextOffset <= 0 ? 'disabled' : '';
    const nextDisabled = nextOffset + items.length >= _natCmaSearchTotal ? 'disabled' : '';
    resultBox.innerHTML = '<div style="font-size:11px;color:var(--text-3);margin-bottom:4px">命中 ' + _natCmaSearchTotal + ' 条机构级能力记录</div>' + rows
      + '<div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px"><button class="btn btn-sm btn-ghost" data-nat-cma-offset="' + Math.max(0, nextOffset - 20) + '" ' + previousDisabled + '>上一页</button><button class="btn btn-sm btn-ghost" data-nat-cma-offset="' + (nextOffset + 20) + '" ' + nextDisabled + '>下一页</button></div>';
  } catch (error) {
    if (resultBox) resultBox.innerHTML = '<div style="color:var(--danger);font-size:12px">检索失败：' + String(error && error.message || error) + '</div>';
  }
}

async function subscribeNatCma(certCode, placeId, btn) {
  if (!certCode || !placeId) return;
  if (btn) { btn.disabled = true; btn.textContent = '订阅中…'; }

  try {
    const res = await fetch('/api/nat-cma/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ certCode, placeId }),
    });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error((data && data.error) || '订阅失败');
    if (typeof natCmaInvalidateCache === 'function') natCmaInvalidateCache();
    if (typeof showToast === 'function') showToast('订阅成功', 'success');
    await loadNatCmaSubscriptions();
  } catch (e) {
    if (typeof showToast === 'function') showToast('订阅失败：' + (e.message || e), 'error');
    if (btn) { btn.disabled = false; btn.textContent = '订阅'; }
  }
}

async function unsubscribeNatCma(certCode, placeId, btn) {
  if (!placeId) return;
  if (!await showConfirm({ title: '取消订阅', body: '确定取消订阅此场所？已同步的历史数据不会立即删除。', danger: true, confirmText: '取消订阅' })) return;
  if (btn) { btn.disabled = true; btn.textContent = '取消中…'; }

  try {
    const res = await fetch('/api/nat-cma/subscribe/' + encodeURIComponent(placeId) + '?certCode=' + encodeURIComponent(certCode), { method: 'DELETE' });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error((data && data.error) || '取消失败');
    if (typeof natCmaInvalidateCache === 'function') natCmaInvalidateCache();
    if (typeof showToast === 'function') showToast('已取消订阅', 'success');
    await loadNatCmaSubscriptions();
  } catch (e) {
    if (typeof showToast === 'function') showToast('取消失败：' + (e.message || e), 'error');
    if (btn) { btn.disabled = false; btn.textContent = '取消订阅'; }
  }
}

async function syncNatCma(certCode, placeId, btn, maxPages) {
  if (!placeId) return;
  if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
  const taskId = typeof createTaskCenterTask === 'function'
    ? createTaskCenterTask({ type: 'sync', label: '国家CMA同步 · ' + placeId.slice(0, 8), progress: '正在同步…' })
    : null;
  showToast('正在同步…');
  startNatCmaSyncPoll(taskId);
  try {
    const res = await fetch('/api/nat-cma/sync/' + encodeURIComponent(placeId), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: maxPages ? JSON.stringify({ maxPages }) : undefined });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error((data && data.error) || '同步失败');
    if (data.status === 'already_syncing') {
      showToast('该场所正在同步中');
      return;
    }
    // 同步已启动，等待轮询完成
  } catch (e) {
    if (typeof showToast === 'function') showToast('同步失败：' + (e.message || e), 'error');
    if (taskId && typeof completeTaskCenterTask === 'function') {
      completeTaskCenterTask(taskId, 'fail', { error: e.message, progress: e.message });
    }
    stopNatCmaSyncPoll();
    await loadNatCmaSubscriptions();
  }
}

async function syncAllNatCma(maxPages) {
  const taskId = typeof createTaskCenterTask === 'function'
    ? createTaskCenterTask({ type: 'sync', label: '国家CMA同步 · 全部机构', progress: '正在同步全部已订阅机构的能力数据…' })
    : null;
  showToast('正在同步全部国家 CMA 机构…');
  startNatCmaSyncPoll(taskId);
  try {
    const res = await fetch('/api/nat-cma/sync-all', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: maxPages ? JSON.stringify({ maxPages }) : undefined });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error((data && data.error) || '同步失败');
  } catch (e) {
    if (typeof showToast === 'function') showToast('同步失败：' + (e.message || e), 'error');
    if (taskId && typeof completeTaskCenterTask === 'function') {
      completeTaskCenterTask(taskId, 'fail', { error: e.message, progress: e.message });
    }
    stopNatCmaSyncPoll();
    await loadNatCmaSubscriptions();
  }
}

document.getElementById('natCmaSearchResults')?.addEventListener('click', function (event) {
  const button = event.target.closest('[data-nat-cma-offset]');
  if (button) searchNatCmaAbilities(Number(button.dataset.natCmaOffset));
});
