// 标准查新（见 docs/CHECK-UPDATE-AND-STATS.md）。Phase 1：导入清单 → 后端查三源存基线 +
// 立即 diff（首次基线==最新，故首查通常无变动）→ 分组渲染。后续在同一清单上「重新查新」才出变动。
// Phase 1 先做"建清单即查"的最小闭环；清单管理/Excel 导入是 Phase 2。

let checkCurrentWatchlistId = null;

const CHECK_FLAG_LABEL = {
  status: ['状态变化', 'bad'],
  newVersion: ['有新版本', 'warn'],
  implDate: ['实施日期变化', 'info'],
  replacedBy: ['被代替', 'info'],
};

// 前端预校验：标准号需带 4 位年代号（如 3324-2017 / GB/T 3325-2020）
function checkHasYear(code) { return /(?:^|[\s\-–—/])\d{4}\s*$/.test(code.trim()); }

async function doCheckImport() {
  const ta = document.getElementById('checkInput');
  const lines = (ta.value || '').split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
  if (!lines.length) { showToast('请粘贴标准号', 'fail'); return; }
  const withYear = lines.filter(checkHasYear);
  if (!withYear.length) { showToast('标准号必须带年代号，如 3324-2017', 'fail'); return; }
  const btn = document.getElementById('checkRunBtn');
  btn.disabled = true; btn.textContent = '查新中…';
  document.getElementById('checkResults').innerHTML = '<div class="check-empty">正在查 BZ 源，请稍候…（每批 50、分批查询）</div>';
  try {
    const res = await apiFetch('/api/check/watchlists', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lines }),
    });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '查新失败');
    checkCurrentWatchlistId = data.id;
    await loadCheckItems(data.id);
    let msg = `已导入 ${data.itemCount} 项并完成查新`;
    if (data.truncated) msg += `（超过 200 上限，已截断）`;
    if (data.skippedNoYear) msg += `（${data.skippedNoYear} 项无年代号已跳过）`;
    showToast(msg);
  } catch (e) {
    document.getElementById('checkResults').innerHTML = `<div class="check-empty">查新失败：${escapeHtml(e.message)}</div>`;
    showToast(`查新失败：${e.message}`, 'fail');
  } finally {
    btn.disabled = false; btn.textContent = '导入并查新';
  }
}

async function doRecheck() {
  if (!checkCurrentWatchlistId) return;
  const btn = document.getElementById('checkRecheckBtn');
  if (btn) { btn.disabled = true; btn.textContent = '查新中…'; }
  try {
    const res = await apiFetch(`/api/check/watchlists/${checkCurrentWatchlistId}/recheck`, { method: 'POST' });
    const data = await readApiResponse(res);
    if (res.status === 429) { showToast(data.message || '查新过于频繁，请稍后再试', 'fail'); return; }
    if (!res.ok) throw new Error(data.message || '查新失败');
    renderCheckItems(data.items || []);
    showToast('已重新查新');
  } catch (e) { showToast(`查新失败：${e.message}`, 'fail'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '重新查新'; } }
  if (btn) { btn.disabled = false; btn.textContent = '重新查新'; }
}

async function loadCheckItems(id) {
  const res = await apiFetch(`/api/check/watchlists/${id}`);
  const data = await readApiResponse(res);
  renderCheckItems(data.items || []);
}

function renderCheckItems(items) {
  const host = document.getElementById('checkResults');
  if (!items.length) { host.innerHTML = '<div class="check-empty">清单为空</div>'; return; }
  const changed = items.filter(i => (i.changeFlags || []).length > 0);
  const notFound = items.filter(i => i.sourceUsed === 'not_found');
  const pending = items.filter(i => i.sourceUsed === 'pending');  // 建清单时有其它清单在查，尚未查基线
  const checked = items.filter(i => (i.changeFlags || []).length === 0 && i.sourceUsed !== 'not_found' && i.sourceUsed !== 'pending');
  // 无变动里再分：非"现行有效"状态（已废止/即将废止/即将实施/部分有效…）单独"需关注"、可展开看详情；
  // 真正现行有效的才折叠进"无变动"。
  const attention = checked.filter(i => !isActiveStatus(i.lastStatus));
  const noChange = checked.filter(i => isActiveStatus(i.lastStatus));

  const stats = `<div class="set-stats" style="margin-bottom:16px">
    <div class="set-stat"><div class="set-stat-value">${items.length}</div><div class="set-stat-label">总计</div></div>
    <div class="set-stat is-bad"><div class="set-stat-value">${changed.length}</div><div class="set-stat-label">有变动</div></div>
    <div class="set-stat is-warn"><div class="set-stat-value">${attention.length}</div><div class="set-stat-label">需关注</div></div>
    <div class="set-stat is-ok"><div class="set-stat-value">${noChange.length}</div><div class="set-stat-label">现行·无变动</div></div>
  </div>
  <div class="check-toolbar">
    <label class="check-auto"><input type="checkbox" id="checkAutoToggle" onchange="onCheckAutoToggle(this.checked)"> 自动查新</label>
    <span class="check-auto-interval" id="checkAutoIntervalWrap" style="display:none">每
      <input type="number" id="checkAutoInterval" min="15" max="365" value="15" onchange="onCheckAutoInterval(this.value)" style="width:56px"> 天</span>
    <button class="btn btn-sm btn-ghost" id="checkRecheckBtn" onclick="doRecheck()">重新查新</button>
  </div>
  <div class="check-export-bar">
    <span class="check-export-label">勾选导出：</span>
    <button class="sa-chip" onclick="checkSelectCat('all')">全部</button>
    <button class="sa-chip" onclick="checkSelectCat('changed')">有变动</button>
    <button class="sa-chip" onclick="checkSelectCat('attention')">需关注</button>
    <button class="sa-chip" onclick="checkSelectCat('nochange')">现行·无变动</button>
    <button class="sa-chip" onclick="checkSelectCat('none')">清空</button>
    <button class="btn btn-sm btn-primary" style="margin-left:auto" onclick="doCheckExport()">导出 Excel（<span id="checkSelCount">0</span>）</button>
  </div>`;

  let html = stats;
  if (changed.length) {
    html += `<div class="check-group-title">⚠ 有变动（${changed.length}）</div>`;
    html += changed.map(i => renderCheckChangedItem(i)).join('');
  }
  if (attention.length) {
    html += `<div class="check-group-title">需关注（${attention.length}）· 非现行状态</div>`;
    html += attention.map(i => renderCheckAttentionItem(i)).join('');
  }
  if (noChange.length) {
    html += `<div class="check-group-title">现行·无变动（${noChange.length}）</div>`;
    html += `<div class="check-nochange">
      <div class="check-nc-head" onclick="this.parentElement.classList.toggle('open')"><span class="check-caret">▸</span>${noChange.length} 项与上次查新一致，点击展开</div>
      <div class="check-nc-body">${noChange.map(i =>
        `<div class="check-nc-row"><input type="checkbox" class="csel" data-cat="nochange" value="${i.id}" onchange="updateCheckSelCount()"><span class="check-code">${escapeHtml(i.stdCode)}</span><span class="check-title">${escapeHtml(i.lastTitle || '')}</span><span class="badge-ok">${escapeHtml(statusText(i.lastStatus))} · 无变动</span></div>`
      ).join('')}</div>
    </div>`;
  }
  if (notFound.length) {
    html += `<div class="check-group-title">无法核验（${notFound.length}）</div>`;
    html += notFound.map(i =>
      `<div class="check-item nf"><div class="check-item-head"><input type="checkbox" class="csel" data-cat="notfound" value="${i.id}" onchange="updateCheckSelCount()"><span class="check-code">${escapeHtml(i.stdCode)}</span><span class="check-title muted">BZ 源未命中</span></div></div>`
    ).join('');
  }
  if (pending.length) {
    html += `<div class="check-group-title">待查新（${pending.length}）</div>`;
    html += `<div class="check-nochange" onclick="this.classList.toggle('open')">
      <div class="check-nc-head"><span class="check-caret">▸</span>${pending.length} 项已登记、尚未查基线（导入时有其它清单在查），点「重新查新」即可查</div>
      <div class="check-nc-body">${pending.map(i =>
        `<div class="check-nc-row"><span class="check-code">${escapeHtml(i.stdCode)}</span><span class="check-title muted">待查新</span></div>`
      ).join('')}</div>
    </div>`;
  }
  host.innerHTML = html;
  loadCheckAutoState();
}

// 自动查新开关状态：从清单列表里取当前清单的 auto_enabled / interval 回填 UI。
async function loadCheckAutoState() {
  if (!checkCurrentWatchlistId) return;
  try {
    const res = await apiFetch('/api/check/watchlists');
    const data = await readApiResponse(res);
    const wl = (data.items || []).find(w => w.id === checkCurrentWatchlistId);
    if (!wl) return;
    const tg = document.getElementById('checkAutoToggle');
    const wrap = document.getElementById('checkAutoIntervalWrap');
    const inp = document.getElementById('checkAutoInterval');
    if (tg) tg.checked = !!wl.autoEnabled;
    if (inp) inp.value = wl.autoIntervalDays || 15;
    if (wrap) wrap.style.display = wl.autoEnabled ? '' : 'none';
  } catch { /* 静默 */ }
}
async function saveCheckAuto() {
  if (!checkCurrentWatchlistId) return;
  const enabled = document.getElementById('checkAutoToggle').checked;
  const intervalDays = Math.max(15, parseInt(document.getElementById('checkAutoInterval').value, 10) || 15);
  document.getElementById('checkAutoIntervalWrap').style.display = enabled ? '' : 'none';
  try {
    const res = await apiFetch(`/api/check/watchlists/${checkCurrentWatchlistId}/auto`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled, intervalDays }),
    });
    if (!res.ok) { const d = await readApiResponse(res); throw new Error(d.message || '设置失败'); }
    showToast(enabled ? `已开启自动查新（每 ${intervalDays} 天）` : '已关闭自动查新');
  } catch (e) { showToast(`设置失败：${e.message}`, 'fail'); }
}
function onCheckAutoToggle() { saveCheckAuto(); }
function onCheckAutoInterval() { if (document.getElementById('checkAutoToggle').checked) saveCheckAuto(); }

function renderCheckChangedItem(i) {
  const flags = (i.changeFlags || []).map(f => {
    const m = CHECK_FLAG_LABEL[f] || [f, 'info'];
    return `<span class="check-badge ${m[1]}">${m[0]}</span>`;
  }).join(' ');
  const sev = (i.changeFlags || []).includes('status') ? 'bad' : ((i.changeFlags || []).includes('newVersion') ? 'warn' : 'info');
  const srcLabel = (i.sourceUsed || 'BZ').toUpperCase();
  const diffRows = [];
  if ((i.changeFlags || []).includes('status'))
    diffRows.push(diffRow('状态', statusText(i.baseStatus), statusText(i.lastStatus)));
  if ((i.changeFlags || []).includes('newVersion'))
    diffRows.push(`<dt>新版本</dt><dd><span class="diff-new">${escapeHtml(i.newVersion || '同基础号更新年版')}</span>（据 ${srcLabel} 源，同基础号最新年版）</dd>`);
  if ((i.changeFlags || []).includes('implDate'))
    diffRows.push(diffRow('实施日期', i.baseImplDate || '—', i.lastImplDate || '—'));
  if ((i.changeFlags || []).includes('replacedBy'))
    diffRows.push(`<dt>被代替</dt><dd><span class="diff-new">本标准已被 ${escapeHtml(i.insteadStd || '')} 代替</span></dd>`);
  // 变动卡默认收起，点击展开看详情（勾选框 stopPropagation 不触发展开）
  return `<div class="check-item ${sev}" onclick="this.classList.toggle('open')">
    <div class="check-item-head">
      <input type="checkbox" class="csel" data-cat="changed" value="${i.id}" onclick="event.stopPropagation()" onchange="updateCheckSelCount()">
      <span class="check-caret">▸</span>
      <span class="check-code">${escapeHtml(i.stdCode)}</span>
      <span class="check-title">${escapeHtml(i.lastTitle || i.baseTitle || '')}</span>
      <span class="check-badges">${flags}</span>
    </div>
    <div class="check-detail"><dl class="check-diff">${diffRows.join('')}</dl></div>
  </div>`;
}

function diffRow(label, oldV, newV) {
  return `<dt>${label}</dt><dd><span class="diff-old">${escapeHtml(oldV)}</span><span class="diff-new">${escapeHtml(newV)}</span></dd>`;
}
function statusText(s) { return s || '—'; }

// 是否"现行有效"（含部分有效也算需关注，更醒目）。非此即归"需关注"组。
function isActiveStatus(s) { return /^现行有效$/.test((s || '').trim()); }
function isAbolishedStatus(s) { return /废止|废除|作废/.test(s || ''); }

// 需关注项（非现行状态、本次无变动）：默认收起、可点击展开看当前状态明细 + 替换信息。
function renderCheckAttentionItem(i) {
  const st = statusText(i.lastStatus);
  const sev = isAbolishedStatus(i.lastStatus) ? 'bad' : 'warn';
  // 有被代替(insteadStd)或检出新版本 → 标"有新版本"，否则"无变动"
  const hasSuccessor = !!(i.insteadStd || i.newVersion);
  const tail = hasSuccessor ? '有新版本' : '无变动';
  const rows = [];
  rows.push(`<dt>当前状态</dt><dd><span class="diff-new">${escapeHtml(st)}</span></dd>`);
  if (i.lastImplDate) rows.push(`<dt>实施日期</dt><dd>${escapeHtml(i.lastImplDate)}</dd>`);
  if (i.abolishDate) rows.push(`<dt>废止日期</dt><dd>${escapeHtml(i.abolishDate)}</dd>`);
  // 被代替 = insteadStd（被谁取代）；代替前身 = replacedStd（取代了谁）
  if (i.insteadStd) rows.push(`<dt>被代替</dt><dd><span class="diff-new">本标准已被 ${escapeHtml(i.insteadStd)} 代替</span></dd>`);
  else if (isAbolishedStatus(i.lastStatus)) rows.push(`<dt>被代替</dt><dd class="muted">BZ 暂未登记代替标准</dd>`);
  if (i.lastReplacedBy) rows.push(`<dt>代替前身</dt><dd class="muted">本标准代替了 ${escapeHtml(i.lastReplacedBy)}</dd>`);
  if (i.newVersion) rows.push(`<dt>新版本</dt><dd><span class="diff-new">${escapeHtml(i.newVersion)}</span></dd>`);
  return `<div class="check-item ${sev}" onclick="this.classList.toggle('open')">
    <div class="check-item-head">
      <input type="checkbox" class="csel" data-cat="attention" value="${i.id}" onclick="event.stopPropagation()" onchange="updateCheckSelCount()">
      <span class="check-caret">▸</span>
      <span class="check-code">${escapeHtml(i.stdCode)}</span>
      <span class="check-title">${escapeHtml(i.lastTitle || '')}</span>
      <span class="check-badges"><span class="check-badge ${sev}">${escapeHtml(st)} · ${tail}</span></span>
    </div>
    <div class="check-detail"><dl class="check-diff">${rows.join('')}</dl></div>
  </div>`;
}

// ── 勾选导出 ──
function allCheckSelBoxes() { return [...document.querySelectorAll('#checkResults .csel')]; }
function updateCheckSelCount() {
  const n = allCheckSelBoxes().filter(b => b.checked).length;
  const el = document.getElementById('checkSelCount');
  if (el) el.textContent = n;
}
// 按分类快速勾选：all/none/changed/attention/nochange（notfound 也可被"全部"选中）
function checkSelectCat(cat) {
  allCheckSelBoxes().forEach(b => {
    if (cat === 'all') b.checked = true;
    else if (cat === 'none') b.checked = false;
    else b.checked = (b.dataset.cat === cat);
  });
  updateCheckSelCount();
}
async function doCheckExport() {
  if (!checkCurrentWatchlistId) return;
  const ids = allCheckSelBoxes().filter(b => b.checked).map(b => Number(b.value));
  if (!ids.length) { showToast('请先勾选要导出的标准', 'fail'); return; }
  const taskId = createTaskCenterTask({ type: 'export', label: '导出标准查新', progress: '正在生成 ' + ids.length + ' 项结果…' });
  try {
    const res = await apiFetch(`/api/check/watchlists/${checkCurrentWatchlistId}/export`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message || '导出失败');
    // 触发下载
    const a = document.createElement('a');
    a.href = data.downloadUrl; a.download = data.fileName || '标准查新.xlsx';
    document.body.appendChild(a); a.click(); a.remove();
    completeTaskCenterTask(taskId, 'success', { progress: '已导出 ' + data.count + ' 项' });
    showToast(`已导出 ${data.count} 项`);
  } catch (e) {
    completeTaskCenterTask(taskId, 'fail', { error: e.message, progress: e.message });
    showToast(`导出失败：${e.message}`, 'fail');
  }
}
