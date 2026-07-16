// ── Qual Lab Management & Sync ──
let qualCnasLabsCache = [];
let qualCmaLabsCache = [];

async function loadQualLabs() {
  try {
    const [cnasRes, cmaRes] = await Promise.all([fetch('/api/qualifications/labs/cnas'), fetch('/api/qualifications/labs/cma')]);
    const cnasData = await readApiResponse(cnasRes);
    const cmaData = await readApiResponse(cmaRes);
    const cnasLabs = cnasData.items || cnasData || [];
    const cmaLabs = cmaData.items || cmaData || [];
    qualCnasLabsCache = cnasLabs;
    qualCmaLabsCache = cmaLabs;
    renderQualLabs('cnas', cnasLabs);
    renderQualLabs('cma', cmaLabs);
    loadQualPresets();
    loadNatCmaSubscriptions();
  } catch (e) { /* silent */ }
}

async function loadQualPresets() {
  const box = document.getElementById('qualPresetCnas');
  if (!box) return;
  try {
    const res = await fetch('/api/qualifications/presets/cnas');
    const data = await readApiResponse(res);
    const items = (data && (data.items || data)) || [];
    if (!Array.isArray(items) || !items.length) {
      box.innerHTML = '<div style="color:var(--text-3);font-size:12px">暂无内置候选机构</div>';
      return;
    }
    box.innerHTML = items.map(it => {
      const labelEsc = (s) => String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      const subscribed = !!it.subscribed;
      const btn = subscribed
        ? '<button class="btn btn-sm btn-ghost" disabled>已订阅</button>'
        : `<button class="btn btn-sm btn-primary" onclick="subscribeQualPreset('${labelEsc(it.labNo)}', this)">一键订阅</button>`;
      const meta = [it.certUpdateTs ? '认可更新 ' + it.certUpdateTs : '', it.validate ? '有效期 ' + it.validate : ''].filter(Boolean).join(' · ');
      return `<div class="qual-preset-item">
        <div class="qual-preset-info">
          <div class="qual-preset-name">${labelEsc(it.labName)} <span class="qual-preset-no">${labelEsc(it.labNo)}</span></div>
          ${it.note ? `<div class="qual-preset-note">${labelEsc(it.note)}</div>` : ''}
          ${meta ? `<div class="qual-preset-meta">${labelEsc(meta)}</div>` : ''}
        </div>
        <div class="qual-preset-actions">${btn}</div>
      </div>`;
    }).join('');
  } catch (e) {
    box.innerHTML = '<div style="color:var(--danger);font-size:12px">加载推荐订阅失败</div>';
  }
}

async function subscribeQualPreset(labNo, btn) {
  if (!labNo) return;
  if (btn) { btn.disabled = true; btn.textContent = '订阅中…'; }
  try {
    const res = await fetch('/api/qualifications/presets/cnas/' + encodeURIComponent(labNo) + '/subscribe', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error((data && data.error) || '订阅失败');
    if (typeof showToast === 'function') showToast('订阅成功，开始同步…', 'success');
    try {
      await fetch('/api/qualifications/labs/cnas/sync?labNo=' + encodeURIComponent(labNo), { method: 'POST' });
    } catch (e) {}
    await loadQualLabs();
  } catch (e) {
    if (typeof showToast === 'function') showToast('订阅失败：' + (e.message || e), 'error');
    if (btn) { btn.disabled = false; btn.textContent = '一键订阅'; }
  }
}

function formatSyncStatus(lab) {
  const statusColors = { success: 'var(--success)', syncing: 'var(--warning)', error: 'var(--danger)' };
  const color = statusColors[lab.syncStatus] || 'var(--text-3)';
  const statusText = lab.syncStatus || '—';
  if (lab.syncStatus === 'syncing' && lab.syncProgress) {
    const { fetched, total } = lab.syncProgress;
    const pct = total > 0 ? Math.round(fetched / total * 100) : 0;
    return `<span style="color:${color}">同步中</span> <span style="color:var(--accent);font-weight:600">${fetched}/${total > 0 ? total : '?'}</span>${total > 0 ? ` (${pct}%)` : ''}`;
  }
  return `<span style="color:${color}">${statusText}</span>`;
}

function renderQualLabs(type, labs) {
  const container = document.getElementById(type === 'cnas' ? 'qualCnasLabs' : 'qualCmaLabs');
  if (!labs.length) { container.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:8px 0">暂无订阅</div>'; return; }
  // 字段名用 camelCase —— API 返回的是 labNo / labName / certNumber（见同函数
  // 471/477/487/519 行）。曾误写 snake_case(lab_no/lab_name)导致 lab[idField]
  // 取到 undefined → 编辑/关联按钮拿到空 id → PUT /cnas/(尾部空)、关联 body
  // cnas_lab_no 为空 → 后端 invalid request。CNAS 卡受影响、CMA 卡另走分支故幸免。
  const nameField = 'labName';
  const idField = type === 'cnas' ? 'labNo' : 'certNumber';
  container.innerHTML = labs.map(lab => {
    const syncInfo = lab.lastSyncAt ? `<span>${utcToBeijing(lab.lastSyncAt)}</span>` : '<span style="color:var(--text-3)">未同步</span>';
    const statusHtml = formatSyncStatus(lab);
    if (type === 'cma') {
      const certStatusColor = /正常|有效/.test(lab.certStatus || '') ? 'var(--success)' : 'var(--warning)';
      return `<div class="qual-lab-card">
        <div class="qual-lab-header">
          <div class="qual-lab-name">${escapeHtml(lab.labName || lab.certNumber)}</div>
          <div class="qual-lab-actions">
            <button onclick="linkQualLab('cma','${escapeHtml(lab.certNumber)}',${JSON.stringify(lab.labName || '').replace(/"/g, '&quot;')})">关联CNAS</button>
            <button onclick="syncQualLab('cma','${escapeHtml(lab.certNumber)}')">同步</button>
            <button class="danger" onclick="deleteQualLab('cma','${escapeHtml(lab.certNumber)}')">删除</button>
          </div>
        </div>
        <div class="qual-lab-meta">
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:4px 14px;line-height:1.6">
            <div>地址: <span>${escapeHtml(lab.address || '—')}</span></div>
            <div>证书编号: <span>${escapeHtml(lab.certNumber || '—')}</span></div>
            <div>证书颁发时间: <span>${escapeHtml(lab.issueDate || '—')}</span></div>
            <div>有效期起始: <span>${escapeHtml(lab.validFrom || '—')}</span></div>
            <div>有效期截止: <span>${escapeHtml(lab.validTo || '—')}</span></div>
            <div>证书状态: <span style="color:${certStatusColor}">${escapeHtml(lab.certStatus || '—')}</span></div>
          </div>
          <div style="margin-top:6px">同步状态: ${statusHtml} | 记录: <span>${lab.recordCount}</span> | 上次同步: ${syncInfo}</div>
          ${lab.linkedCnasLabNo ? `<div>已关联 CNAS: <span>${escapeHtml(lab.linkedCnasLabNo)}</span> · <button class="qual-inline-btn" onclick="unlinkQualLab('CMA','${escapeHtml(lab.certNumber)}')">取消关联</button></div>` : ''}
          ${lab.syncError ? `<div style="color:var(--danger);font-size:11px">${escapeHtml(lab.syncError)}</div>` : ''}
        </div>
      </div>`;
    }
    let certTasksHtml = '';
    try {
      const tasks = JSON.parse(lab.certTasks || '[]');
      if (tasks.length) {
        const taskRows = tasks.map(t => `<tr><td>${escapeHtml(t.taskNo)}</td><td>${escapeHtml(t.reviewType)}</td><td>${escapeHtml(t.signDate)}</td><td>${escapeHtml(t.scopeStatus)}</td></tr>`).join('');
        certTasksHtml = `<div class="qual-lab-tasks"><div class="qual-lab-tasks-title">证书附件（能力范围）</div><table class="qual-lab-tasks-table"><thead><tr><th>任务编号</th><th>评审类型</th><th>签发日期</th><th>公布状态</th></tr></thead><tbody>${taskRows}</tbody></table></div>`;
      }
    } catch { /* ignore */ }
    return `<div class="qual-lab-card">
      <div class="qual-lab-header">
        <div class="qual-lab-name">${escapeHtml((lab[nameField] && !/^[?]+$/.test(lab[nameField]) && lab[nameField].length > 1) ? lab[nameField] + '（' + lab[idField] + '）' : lab[idField])}</div>
        <div class="qual-lab-actions">
          <button onclick="editQualLabName('${type}','${escapeHtml(lab[idField])}',${JSON.stringify(lab[nameField] || '').replace(/"/g, '&quot;')})">编辑</button>
          <button onclick="linkQualLab('cnas','${escapeHtml(lab[idField])}',${JSON.stringify(lab[nameField] || '').replace(/"/g, '&quot;')})">关联CMA</button>
          <button onclick="syncQualLab('${type}','${escapeHtml(lab[idField])}')">同步</button>
          <button class="danger" onclick="deleteQualLab('${type}','${escapeHtml(lab[idField])}')">删除</button>
        </div>
      </div>
      <div class="qual-lab-meta">
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:3px 12px;line-height:1.6">
          <div>注册编号: <span>${escapeHtml(lab.labNo || '—')}</span></div>
          ${lab.otherNames ? `<div>其他名称: <span>${escapeHtml(lab.otherNames)}</span></div>` : ''}
          ${lab.orgAddress ? `<div>单位地址: <span>${escapeHtml(lab.orgAddress)}</span></div>` : ''}
          ${lab.validityPeriod ? `<div>认可有效期限: <span>${escapeHtml(lab.validityPeriod)}</span></div>` : ''}
          ${lab.certUpdateTs ? `<div>证书更新日期: <span>${escapeHtml(lab.certUpdateTs)}</span></div>` : ''}
          ${lab.validate ? `<div>有效期至: <span>${escapeHtml(lab.validate)}</span></div>` : ''}
        </div>
        <div style="margin-top:5px">状态: ${statusHtml} | 记录: <span>${lab.recordCount}</span> | 上次同步: ${syncInfo}</div>
        ${lab.linkedCmaCertNumber ? `<div>已关联 CMA: <span>${escapeHtml(lab.linkedCmaCertNumber)}</span> · <button class="qual-inline-btn" onclick="unlinkQualLab('CNAS','${escapeHtml(lab[idField])}')">取消关联</button></div>` : ''}
        ${lab.syncError ? `<div style="color:var(--danger);font-size:11px">${escapeHtml(lab.syncError)}</div>` : ''}
      </div>
      ${certTasksHtml}
    </div>`;
  }).join('');
}

async function searchCmaLabCandidates() {
  const input = document.getElementById('qualCmaInput');
  const container = document.getElementById('qualCmaCandidates');
  const q = input.value.trim();
  if (!q) return;
  container.innerHTML = '<span class="spinner"></span> 正在搜索机构…';
  try {
    const res = await fetch(`/api/qualifications/labs/cma/search?q=${encodeURIComponent(q)}`);
    const data = await readQualApiJson(res);
    if (!res.ok) throw new Error(data.message || '搜索失败');
    const items = data.items || [];
    if (!items.length) {
      container.innerHTML = '<div style="color:var(--text-3);font-size:12px;padding:8px 0">未找到候选机构</div>';
      return;
    }
    container.innerHTML = items.map(item => {
      const id = escapeHtml(item.publicDetailId);
      return `
      <div class="qual-lab-card" style="margin-bottom:6px" data-cma-candidate="${id}">
        <div class="qual-lab-header">
          <div>
            <div class="qual-lab-name">${escapeHtml(item.sysName || '未命名机构')}</div>
            <div class="qual-lab-meta">行政区划: ${escapeHtml(item.areaName || '—')} | 行业: ${escapeHtml(item.majorCategory || '—')} | 状态: ${escapeHtml(item.licState || '—')}</div>
          </div>
          <div class="qual-lab-actions">
            <button data-cma-subscribe="${id}" onclick="subscribeCmaCandidate('${id}')">订阅</button>
          </div>
        </div>
        <div class="qual-cma-progress" data-cma-progress="${id}"></div>
      </div>
    `;
    }).join('');
  } catch (e) {
    container.innerHTML = `<div style="color:var(--danger);font-size:12px;padding:8px 0">搜索失败: ${escapeHtml(e.message)}</div>`;
  }
}

async function subscribeCmaCandidate(publicDetailId) {
  const btn = document.querySelector(`[data-cma-subscribe="${cssEscape(publicDetailId)}"]`);
  const progress = document.querySelector(`[data-cma-progress="${cssEscape(publicDetailId)}"]`);
  const card = document.querySelector(`[data-cma-candidate="${cssEscape(publicDetailId)}"]`);
  document.querySelectorAll('[data-cma-subscribe]').forEach(b => { b.disabled = true; });
  if (btn) btn.innerHTML = '<span class="spinner"></span>订阅中';
  if (card) card.classList.add('is-working');
  if (progress) progress.innerHTML = '<span class="spinner"></span>正在获取证书详情，请稍候…';
  try {
    const res = await fetch('/api/qualifications/labs/cma', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publicDetailId: publicDetailId }),
    });
    const data = await readQualApiJson(res);
    if (!res.ok) throw new Error(data.message || '订阅失败');
    if (progress) progress.innerHTML = `已订阅 ${escapeHtml(data.labName || data.certNumber || 'CMA 机构')}，正在刷新列表…`;
    loadQualLabs();
    setTimeout(() => { document.getElementById('qualCmaCandidates').innerHTML = ''; }, 900);
    showToast(`已订阅 CMA 机构: ${data.labName || data.certNumber}`);
  } catch (e) {
    document.querySelectorAll('[data-cma-subscribe]').forEach(b => { b.disabled = false; });
    if (btn) btn.innerHTML = '订阅';
    if (card) card.classList.remove('is-working');
    if (progress) progress.innerHTML = `<span style="color:var(--danger)">订阅失败: ${escapeHtml(e.message)}</span>`;
    showToast(`订阅失败: ${e.message}`, 'fail');
  }
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

async function readQualApiJson(res) {
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    if (text.trim().startsWith('<!DOCTYPE') || text.trim().startsWith('<html')) {
      throw new Error('接口返回了页面 HTML，后端可能还没重启或未加载最新路由');
    }
    throw new Error('接口返回格式不是 JSON');
  }
  // Unwrap Result envelope { data, error } if present
  if (parsed && typeof parsed === 'object' && 'data' in parsed && 'error' in parsed) {
    if (parsed.error) {
      return { code: parsed.error.code, message: parsed.error.message, details: parsed.error.details };
    }
    return parsed.data == null ? {} : parsed.data;
  }
  return parsed;
}

async function addQualLab(type) {
  const input = document.getElementById(type === 'cnas' ? 'qualCnasInput' : 'qualCmaInput');
  const val = input.value.trim();
  if (!val) return;
  try {
    let body;
    if (type === 'cnas') {
      // Try parsing as URL
      const parsed = val.includes('://') ? CnasScraper_parseUrl(val) : null;
      if (parsed) {
        body = { labNo: parsed.labNo, baseInfoId: parsed.baseInfoId, certUpdateTs: parsed.certUpdateTs, validate: parsed.validate, urlParams: parsed.urlParams };
      } else {
        body = { labNo: val };
      }
      const res = await fetch('/api/qualifications/labs/cnas', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!res.ok) { const d = await readApiResponse(res); throw new Error(d.message); }
    } else {
      await searchCmaLabCandidates();
      return;
    }
    input.value = '';
    loadQualLabs();
    showToast(`已添加 ${type.toUpperCase()} 实验室`);
  } catch (e) {
    showToast(`添加失败: ${e.message}`, 'fail');
  }
}

async function editQualLabName(type, id, currentName) {
  const newName = await showPrompt({ title: '编辑机构名称', label: '输入机构名称', defaultValue: currentName || '', confirmText: '保存' });
  if (newName === null) return;
  const url = type === 'cnas' ? `/api/qualifications/labs/cnas/${encodeURIComponent(id)}` : `/api/qualifications/labs/cma/${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ labName: newName }),
    });
    if (!res.ok) { const d = await readApiResponse(res); throw new Error(d.message); }
    loadQualLabs();
    showToast('名称已更新');
  } catch (e) {
    showToast(`更新失败: ${e.message}`, 'fail');
  }
}

async function linkQualLab(type, id, currentName) {
  const candidates = type === 'cnas' ? qualCmaLabsCache : qualCnasLabsCache;
  const targetLabel = type === 'cnas' ? 'CMA证书编号' : 'CNAS实验室编号';
  const options = candidates.slice(0, 12).map(l => {
    const candidateId = type === 'cnas' ? l.certNumber : l.labNo;
    return `${candidateId} - ${l.labName || ''}`;
  }).join('\n');
  const targetId = await showPrompt({ title: '关联机构', label: `输入要关联的${targetLabel}：\n\n可选项：\n${options || '暂无可选订阅'}`, placeholder: targetLabel, confirmText: '下一步' });
  if (!targetId) return;
  const displayName = await showPrompt({ title: '关联机构', label: '输入合并后显示的机构名称', defaultValue: currentName || '', confirmText: '保存关联' });
  if (!displayName) return;

  const body = type === 'cnas'
    ? { display_name: displayName, cnas_lab_no: id, cma_cert_number: targetId.trim() }
    : { display_name: displayName, cnas_lab_no: targetId.trim(), cma_cert_number: id };

  try {
    const res = await fetch('/api/qualifications/links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await readQualApiJson(res);
    if (!res.ok) throw new Error(data.message || '关联失败');
    loadQualLabs();
    showToast('机构关联已保存');
  } catch (e) {
    showToast(`关联失败: ${e.message}`, 'fail');
  }
}

async function unlinkQualLab(source, id) {
  if (!await showConfirm({ title: '取消关联', body: '确定取消这组机构关联？', confirmText: '确定取消' })) return;
  try {
    const res = await fetch(`/api/qualifications/links/${source}/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await readQualApiJson(res);
    if (!res.ok) throw new Error(data.message || '取消关联失败');
    loadQualLabs();
    showToast('机构关联已取消');
  } catch (e) {
    showToast(`取消关联失败: ${e.message}`, 'fail');
  }
}

function CnasScraper_parseUrl(url) {
  try {
    const u = new URL(url);
    const p = u.searchParams;
    const baseInfoId = p.get('baseInfoId');
    const licNo = p.get('licNo');
    if (!baseInfoId || !licNo) return null;
    const extraKeys = ['id', 'labType', 'scopeStr', 'orgEnOrCh', 'attactdate'];
    const urlParams = {};
    for (const key of extraKeys) {
      const val = p.get(key);
      if (val) urlParams[key] = val;
    }
    return { baseInfoId, labNo: licNo, certUpdateTs: p.get('certUpdateTs') || '', validate: p.get('validate') || '', urlParams };
  } catch { return null; }
}

async function deleteQualLab(type, id) {
  if (!await showConfirm({ title: '删除订阅', body: `确定删除 ${id} 及其所有资质数据？此操作不可恢复。`, danger: true, confirmText: '删除' })) return;
  const url = type === 'cnas' ? `/api/qualifications/labs/cnas/${encodeURIComponent(id)}` : `/api/qualifications/labs/cma/${encodeURIComponent(id)}`;
  try {
    const res = await fetch(url, { method: 'DELETE' });
    if (!res.ok) throw new Error((await readApiResponse(res)).message);
    loadQualLabs();
    showToast('已删除');
  } catch (e) { showToast(`删除失败: ${e.message}`, 'fail'); }
}

let _qualSyncPollTimer = null;

function stopQualSyncPoll() {
  if (_qualSyncPollTimer) { clearInterval(_qualSyncPollTimer); _qualSyncPollTimer = null; }
}
(window._tabCleanup = window._tabCleanup || {}).qualSyncPoll = stopQualSyncPoll;

function startSyncProgressPoll() {
  if (_qualSyncPollTimer) return;
  _qualSyncPollTimer = setInterval(async () => {
    await loadQualLabs();
    const anySyncing = qualCnasLabsCache.some(l => l.syncStatus === 'syncing') || qualCmaLabsCache.some(l => l.syncStatus === 'syncing');
    if (!anySyncing) {
      clearInterval(_qualSyncPollTimer);
      _qualSyncPollTimer = null;
      loadLabsSyncLogs();
    }
  }, 2000);
}

async function syncQualLab(type, id) {
  const url = type === 'cnas' ? `/api/qualifications/labs/cnas/sync?labNo=${encodeURIComponent(id)}` : `/api/qualifications/labs/cma/sync?certNumber=${encodeURIComponent(id)}`;
  const taskId = createTaskCenterTask({ type: 'sync', label: '资质同步 · ' + id, progress: '正在同步…' });
  showToast(`正在同步 ${id}…`);
  startSyncProgressPoll();
  try {
    const res = await fetch(url, { method: 'POST' });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message);
    loadQualLabs();
    loadLabsSyncLogs();
    completeTaskCenterTask(taskId, 'success', { progress: '完成 · ' + data.records + ' 条记录' });
    showToast(`同步完成: ${data.records} 条记录`);
  } catch (e) {
    completeTaskCenterTask(taskId, 'fail', { error: e.message, progress: e.message });
    showToast(`同步失败: ${e.message}`, 'fail');
  }
}

async function syncAllQualLabs() {
  const taskId = createTaskCenterTask({ type: 'sync', label: '资质同步 · 全部实验室', progress: '正在同步 CNAS 与 CMA 数据…' });
  showToast('正在同步全部实验室…');
  startSyncProgressPoll();
  try {
    const [cnasRes, cmaRes] = await Promise.all([
      fetch('/api/qualifications/labs/cnas/sync', { method: 'POST' }),
      fetch('/api/qualifications/labs/cma/sync', { method: 'POST' }),
    ]);
    await readApiResponse(cnasRes); await readApiResponse(cmaRes);
    loadQualLabs();
    loadLabsSyncLogs();
    completeTaskCenterTask(taskId, 'success', { progress: 'CNAS 与 CMA 实验室同步完成' });
    showToast('全部同步完成');
  } catch (e) {
    completeTaskCenterTask(taskId, 'fail', { error: e.message, progress: e.message });
    showToast(`同步失败: ${e.message}`, 'fail');
  }
}

// ── Qual Sync Logs ──
let qualLogSource = 'cnas';

function switchLogSource(btn, source) {
  qualLogSource = source;
  btn.parentElement.querySelectorAll('.qual-filter-btn').forEach(b => {
    b.classList.toggle('active', b === btn);
  });
  loadQualSyncLogs(source);
}

async function loadQualSyncLogs(source) {
  try {
    const res = await fetch(`/api/${source}/sync-logs?limit=30`);
    const data = await readApiResponse(res);
    const logs = data.items || data || [];
    const container = document.getElementById('qualSyncLogs');
    if (!logs.length) { container.innerHTML = '<div style="color:var(--text-3);padding:16px 0;text-align:center">暂无同步记录</div>'; return; }
    const statusColors = { success: 'var(--success)', error: 'var(--danger)' };
    container.innerHTML = logs.map(l => {
      const time = utcToBeijing(l.startedAt);
      const idField = l.labNo || l.certNumber || '';
      return `<div class="qual-sync-log">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <span><span style="color:var(--text)">${escapeHtml(idField)}</span> ${escapeHtml(l.action)}</span>
          <span style="color:${statusColors[l.status] || 'var(--text-3)'}">${l.status}</span>
        </div>
        <div class="log-time">${time} | ${l.recordsFetched} 条${l.errorMessage ? ' | <span style="color:var(--danger)">' + escapeHtml(l.errorMessage) + '</span>' : ''}</div>
      </div>`;
    }).join('');
  } catch (e) { /* silent */ }
}

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

    const providerReady = orgs.every(org => org.providerReady !== false);
    const providerMessage = orgs.find(org => org.providerMessage)?.providerMessage || '';
    const esc = value => String(value == null ? '' : value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const searchPanel = providerReady
      ? '<div class="set-card" style="padding:12px;margin:0 0 10px">'
        + '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">'
        + '<input id="natCmaSearchInput" style="flex:1;min-width:180px" placeholder="检索已同步能力：标准号、方法、产品或领域" onkeydown="if(event.key===\'Enter\')searchNatCmaAbilities(0)">'
        + '<button class="btn btn-sm btn-ghost" onclick="searchNatCmaAbilities(0)">检索</button></div>'
        + '<div style="margin-top:6px;color:var(--text-3);font-size:11px">仅检索本地已同步的国家 CMA 机构级能力；标准号按同年版严格匹配。</div>'
        + '<div id="natCmaSearchResults" style="margin-top:8px"></div></div>'
      : '<div class="set-card" style="padding:12px;margin:0 0 10px;border-left:3px solid var(--warning)">'
        + '<div style="color:var(--warning);font-size:12px;font-weight:600">国家 CMA 真实数据源待接入</div>'
        + '<div style="margin-top:4px;color:var(--text-2);font-size:11px">' + esc(providerMessage) + '</div></div>';

    const cards = orgs.map(org => {
      const anySyncing = org.places.some(place => place.syncStatus === 'syncing');
      const sourceReady = org.providerReady !== false;
      const totalAbilities = org.abilityCount || 0;
      const places = org.places.map(place => {
        const statusHtml = formatNatCmaSyncStatus(place);
        const lastSync = place.lastSyncedAt ? utcToBeijing(place.lastSyncedAt) : '—';
        const certStatusColor = /正常|有效/.test(place.certStatus || '') ? 'var(--success)' : (place.certStatus ? 'var(--warning)' : 'var(--text-3)');
        const syncButton = sourceReady
          ? '<button class="btn btn-sm btn-primary" style="font-size:11px" onclick="syncNatCma(\'' + esc(org.certCode) + '\',\'' + esc(place.placeId) + '\',this)" ' + (place.syncStatus === 'syncing' ? 'disabled' : '') + '>' + (place.syncStatus === 'syncing' ? '同步中…' : '同步') + '</button>'
          : '<span style="color:var(--warning);font-size:11px">源待接入</span>';
        const actions = place.subscribed
          ? syncButton + '<button class="btn btn-sm btn-ghost" style="color:var(--danger);font-size:11px" onclick="unsubscribeNatCma(\'' + esc(org.certCode) + '\',\'' + esc(place.placeId) + '\',this)">取消订阅</button>'
          : '<button class="btn btn-sm btn-primary" style="font-size:11px" onclick="subscribeNatCma(\'' + esc(org.certCode) + '\',\'' + esc(place.placeId) + '\',this)">订阅</button>';
        const details = place.subscribed
          ? '<div style="margin-top:6px;display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:3px 12px;line-height:1.5;color:var(--text-2);font-size:11px">'
            + '<div>同步状态: ' + statusHtml + '</div><div>能力记录: <span style="color:var(--text)">' + (place.abilityCount || 0) + '</span></div><div>上次同步: <span style="color:var(--text)">' + lastSync + '</span></div>'
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
        + (org.subscribedCount > 0 && sourceReady ? '<button class="btn btn-sm btn-primary" style="font-size:11px" onclick="syncAllNatCma()" ' + (anySyncing ? 'disabled' : '') + '>' + (anySyncing ? '同步中…' : '同步全部') + '</button>' : '')
        + '</div></div><div class="qual-lab-meta"><div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:4px 14px;line-height:1.6;font-size:12px;color:var(--text-2);margin-bottom:8px">'
        + '<div>证书编号: <span style="color:var(--text)">' + esc(org.certCode) + '</span></div><div>地址: <span style="color:var(--text)">' + esc(org.address) + '</span></div>'
        + (totalAbilities > 0 ? '<div>机构级能力条目: <span style="color:var(--accent)">' + totalAbilities + '</span></div>' : '')
        + '</div><div style="display:grid;gap:6px">' + places + '</div></div></div>';
    }).join('');
    container.innerHTML = searchPanel + cards;
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
      + '<div style="display:flex;justify-content:flex-end;gap:6px;margin-top:8px"><button class="btn btn-sm btn-ghost" onclick="searchNatCmaAbilities(' + Math.max(0, nextOffset - 20) + ')" ' + previousDisabled + '>上一页</button><button class="btn btn-sm btn-ghost" onclick="searchNatCmaAbilities(' + (nextOffset + 20) + ')" ' + nextDisabled + '>下一页</button></div>';
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
  if (!confirm('确定取消订阅此场所？')) return;
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

async function syncNatCma(certCode, placeId, btn) {
  if (!placeId) return;
  if (btn) { btn.disabled = true; btn.textContent = '同步中…'; }
  const taskId = typeof createTaskCenterTask === 'function'
    ? createTaskCenterTask({ type: 'sync', label: '国家CMA同步 · ' + placeId.slice(0, 8), progress: '正在同步…' })
    : null;
  showToast('正在同步…');
  startNatCmaSyncPoll(taskId);
  try {
    const res = await fetch('/api/nat-cma/sync/' + encodeURIComponent(placeId), { method: 'POST' });
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

async function syncAllNatCma() {
  const taskId = typeof createTaskCenterTask === 'function'
    ? createTaskCenterTask({ type: 'sync', label: '国家CMA同步 · 全部机构', progress: '正在同步全部已订阅机构的能力数据…' })
    : null;
  showToast('正在同步全部国家 CMA 机构…');
  startNatCmaSyncPoll(taskId);
  try {
    const res = await fetch('/api/nat-cma/sync-all', { method: 'POST' });
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
