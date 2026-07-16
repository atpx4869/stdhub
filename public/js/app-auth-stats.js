// ── Auth Statistics ──

// ── Stats ──
async function loadStats() {
  const from = document.getElementById('statsFrom').value;
  const to = document.getElementById('statsTo').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);

  try {
    const [summaryRes, tsRes, srcRes, popularRes, healthRes] = await Promise.all([
      apiFetch(`/api/stats/summary?${params}`).then(r => readApiResponse(r)),
      apiFetch(`/api/stats/timeseries?${params}`).then(r => readApiResponse(r)),
      apiFetch(`/api/stats/by-source?${params}`).then(r => readApiResponse(r)),
      apiFetch(`/api/stats/popular-standards?${params}`).then(r => readApiResponse(r)),
      apiFetch(`/api/stats/source-health`).then(r => readApiResponse(r)),
    ]);

    // Summary cards
    const typeMap = { search: '搜索', download: '下载', batch_resolve: '批量解析', complete: '补全', qual_search: '资质查询', preview: '预览', open: '打开', check: '查新' };
    const total = summaryRes.total || 0;
    const failCount = summaryRes.failCount || 0;
    const successRate = total > 0 ? Math.round((total - failCount) / total * 100) : 100;
    let html = `<div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">总操作数</div></div>`;
    html += `<div class="stat-card"><div class="stat-value">${summaryRes.uniqueUsers}</div><div class="stat-label">活跃用户</div></div>`;
    html += `<div class="stat-card stat-fail"><div class="stat-value">${successRate}%</div><div class="stat-label">成功率</div></div>`;
    if (failCount > 0) {
      html += `<div class="stat-card stat-fail"><div class="stat-value">${failCount}</div><div class="stat-label">失败</div></div>`;
    }
    for (const item of summaryRes.byType) {
      html += `<div class="stat-card"><div class="stat-value">${item.count}</div><div class="stat-label">${typeMap[item.eventType] || item.eventType}</div></div>`;
    }
    document.getElementById('statsSummary').innerHTML = html;

    // Source success rates panel
    renderSourceRates(srcRes.items || []);

    // Trend chart
    const dates = [...new Set(tsRes.items.map(r => r.date))].sort();
    const types = [...new Set(tsRes.items.map(r => r.eventType))];
    const colors = { search: '#3b82f6', download: '#10b981', batch_resolve: '#f59e0b', complete: '#8b5cf6', qual_search: '#ec4899', check: '#f97316' };
    const datasets = types.map(t => ({
      label: typeMap[t] || t,
      data: dates.map(d => { const row = tsRes.items.find(r => r.date === d && r.eventType === t); return row ? row.count : 0; }),
      borderColor: colors[t] || '#666',
      backgroundColor: (colors[t] || '#666') + '33',
      tension: 0.3, fill: true,
    }));
    if (trendChart) trendChart.destroy();
    trendChart = new Chart(document.getElementById('chartTrend'), {
      type: 'line',
      data: { labels: dates, datasets },
      options: { responsive: true, plugins: { legend: { labels: { color: '#aaa', font: { size: 11 } } } }, scales: { x: { ticks: { color: '#888', font: { size: 10 } } }, y: { beginAtZero: true, ticks: { color: '#888', font: { size: 10 }, stepSize: 1 } } } },
    });

    // Source pie chart
    const srcLabels = srcRes.items.map(r => r.source);
    const srcCounts = srcRes.items.map(r => r.count);
    const srcColors = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6'];
    if (sourceChart) sourceChart.destroy();
    sourceChart = new Chart(document.getElementById('chartSource'), {
      type: 'doughnut',
      data: { labels: srcLabels, datasets: [{ data: srcCounts, backgroundColor: srcColors }] },
      options: { responsive: true, plugins: { legend: { labels: { color: '#aaa', font: { size: 11 } } } } },
    });

    // Popular standards panel
    renderPopularStandards(popularRes.items || []);

    // Source health dashboard
    renderSourceHealth(healthRes.sources || {});

    // 操作明细（Phase 2）
    loadStatsActivity();
  } catch (e) { console.error('Stats load error:', e); }
}
window.loadStats = loadStats;

// ── 来源成功率面板 ──
function renderSourceRates(items) {
  const el = document.getElementById('statsSourceRates');
  if (!el) return;
  if (!items.length) { el.innerHTML = '<div class="stat-panel-empty">暂无数据</div>'; return; }
  const srcLabels = { bz: 'BZ 标准在线', gbw: 'BW 国标网', by: 'BY 内网', labr: 'Labr 补给' };
  el.innerHTML = items.map(r => {
    const total = r.count || 0;
    const ok = r.successCount || 0;
    const fail = r.failCount || 0;
    const rate = total > 0 ? Math.round(ok / total * 100) : 0;
    const barColor = rate >= 90 ? 'var(--success)' : rate >= 70 ? 'var(--warning)' : 'var(--danger)';
    return `<div class="src-rate-row">
      <div class="src-rate-name">${srcLabels[r.source] || r.source}</div>
      <div class="src-rate-bar"><div class="src-rate-fill" style="width:${rate}%;background:${barColor}"></div></div>
      <div class="src-rate-nums">${ok}/${total} (${rate}%)</div>
    </div>`;
  }).join('');
}

// ── 热门标准面板 ──
function renderPopularStandards(items) {
  const el = document.getElementById('statsPopular');
  if (!el) return;
  if (!items.length) { el.innerHTML = '<div class="stat-panel-empty">暂无数据</div>'; return; }
  el.innerHTML = `<table class="stat-mini-table"><thead><tr><th>标准号</th><th>来源</th><th>操作数</th><th>成功率</th></tr></thead><tbody>` +
    items.map(r => {
      const rate = r.count > 0 ? Math.round((r.successCount || 0) / r.count * 100) : 0;
      return `<tr><td class="mono">${escapeHtml(r.standardId || '—')}</td><td>${r.source || '—'}</td><td>${r.count}</td><td>${rate}%</td></tr>`;
    }).join('') + '</tbody></table>';
}

// ── 源健康看板 ──
function renderSourceHealth(sources) {
  const el = document.getElementById('statsHealth');
  if (!el) return;
  const srcLabels = { bz: 'BZ', gbw: 'BW', by: 'BY', labr: 'Labr' };
  const keys = Object.keys(sources);
  if (!keys.length) { el.innerHTML = '<div class="stat-panel-empty">暂无数据</div>'; return; }
  el.innerHTML = keys.map(k => {
    const h = sources[k];
    const hasRecentFail = h.lastFail && (!h.lastSuccess || h.lastFail > h.lastSuccess);
    const status = hasRecentFail ? 'warn' : (h.lastSuccess ? 'ok' : 'idle');
    const statusLabel = status === 'warn' ? '有失败' : (status === 'ok' ? '正常' : '未使用');
    const lastAct = h.lastSuccess || h.lastFail || '—';
    const lastShort = lastAct !== '—' ? lastAct.replace('T', ' ').substring(5, 16) : '—';
    return `<div class="health-row health-${status}">
      <span class="health-dot"></span>
      <span class="health-name">${srcLabels[k] || k}</span>
      <span class="health-status">${statusLabel}</span>
      <span class="health-meta">成功${h.successTotal} / 失败${h.failTotal}</span>
      <span class="health-time">最近: ${lastShort}</span>
    </div>`;
  }).join('');
}

// escapeHtml 已在 app-core.js 中定义

// 操作明细筛选态
var statsActFilter = { eventType: '', result: '' };
var STATS_ACT_TYPE_MAP = { search: '查询', download: '下载', batch_resolve: '批量解析', complete: '补全', qual_search: '资质查询', preview: '预览', open: '打开', check: '查新' };
var STATS_CLIENT_MAP = { web: ['web', 'cl-web'], desktop: ['桌面', 'cl-desktop'], mobile: ['手机', 'cl-mobile'], system: ['系统', 'cl-web'] };

async function loadStatsActivity() {
  const host = document.getElementById('statsActivity');
  if (!host) return;
  const from = document.getElementById('statsFrom').value;
  const to = document.getElementById('statsTo').value;
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  params.set('collapse', '5m');
  params.set('limit', '300');
  if (statsActFilter.eventType) params.set('eventType', statsActFilter.eventType);
  if (statsActFilter.result) params.set('result', statsActFilter.result);
  try {
    const data = await apiFetch(`/api/stats/activity?${params}`).then(r => readApiResponse(r));
    const groups = data.groups || [];
    if (!groups.length) { host.innerHTML = '<div class="sa-empty">暂无操作记录</div>'; return; }
    host.innerHTML = groups.map((g, gi) => renderActivityGroup(g, gi)).join('');
  } catch (e) { console.error('activity load error:', e); host.innerHTML = '<div class="sa-empty">加载失败</div>'; }
}

function fmtActTime(iso) {
  if (!iso) return '';
  const d = new Date(iso); const p = n => String(n).padStart(2, '0');
  return `${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function clientBadge(c) {
  const m = STATS_CLIENT_MAP[c] || [c || '—', 'cl-web'];
  return c ? `<span class="cl-badge ${m[1]}">${m[0]}</span>` : '<span class="muted">—</span>';
}
function renderActivityGroup(g, gi) {
  const collapsed = g.count > 1;
  const typeLabel = STATS_ACT_TYPE_MAP[g.eventType] || g.eventType;
  const hasFail = g.failCount > 0;
  const resultCell = collapsed
    ? `${g.successCount ? `<span class="res-badge res-ok">${g.successCount} 成功</span>` : ''}${hasFail ? ` <span class="res-badge res-fail">${g.failCount} 失败</span>` : ''}`
    : (g.children[0] && g.children[0].result === 'fail' ? '<span class="res-badge res-fail">失败</span>' : (g.children[0] && g.children[0].result === 'success' ? '<span class="res-badge res-ok">成功</span>' : '<span class="muted">—</span>'));
  const opCell = collapsed ? `<span class="sa-caret">▸</span>${typeLabel} ×${g.count}` : typeLabel;
  const objCell = collapsed
    ? `<span class="muted">5 分钟内 ${g.count} 次</span>`
    : escapeHtml((g.children[0] && (g.children[0].label || g.children[0].standardId || g.children[0].source || '')) || '—');
  const childRows = collapsed ? `<div class="sa-children" style="display:none">${g.children.map(c => `
    <div class="sa-child">
      <span class="mono">${fmtActTime(c.createdAt)}</span>
      ${c.result === 'fail' ? '<span class="res-badge res-fail">失败</span>' : (c.result === 'success' ? '<span class="res-badge res-ok">成功</span>' : '')}
      <span>${escapeHtml(c.label || c.standardId || c.source || '—')}</span>
      ${c.error ? `<div class="sa-err">${escapeHtml(c.error)}</div>` : ''}
    </div>`).join('')}</div>` : (g.children[0] && g.children[0].error ? `<div class="sa-children" style="display:none"><div class="sa-err">${escapeHtml(g.children[0].error)}</div></div>` : '');
  const expandable = collapsed || (g.children[0] && g.children[0].error);
  return `<div class="sa-row${hasFail ? ' sa-fail' : ''}${expandable ? ' sa-expandable' : ''}"${expandable ? ` onclick="toggleActivityRow(this)"` : ''}>
    <div class="sa-cells">
      <span class="mono">${fmtActTime(g.endAt)}</span>
      <span class="sa-user">${escapeHtml(g.displayName || g.username)}</span>
      <span class="mono">${g.hostname ? escapeHtml(g.hostname) : '<span class="muted">—</span>'}</span>
      <span class="mono">${g.ip ? escapeHtml(g.ip) : '<span class="muted">—</span>'}</span>
      <span>${clientBadge(g.client)}</span>
      <span class="sa-op">${opCell}</span>
      <span class="sa-res">${resultCell}</span>
      <span class="sa-obj">${objCell}</span>
    </div>
    ${childRows}
  </div>`;
}
function toggleActivityRow(el) {
  el.classList.toggle('open');
  const kids = el.querySelector('.sa-children');
  if (kids) kids.style.display = el.classList.contains('open') ? 'block' : 'none';
}
// 工具条筛选（事件委托，绑一次）
(function initStatsActivityToolbar() {
  document.addEventListener('click', function (e) {
    const b = e.target.closest && e.target.closest('#statsActivityToolbar .sa-chip');
    if (!b) return;
    if (b.hasAttribute('data-act-type')) {
      statsActFilter.eventType = b.getAttribute('data-act-type');
      b.parentElement.querySelectorAll('[data-act-type]').forEach(x => x.classList.toggle('active', x === b));
    } else if (b.hasAttribute('data-act-result')) {
      statsActFilter.result = b.getAttribute('data-act-result');
      b.parentElement.querySelectorAll('[data-act-result]').forEach(x => x.classList.toggle('active', x === b));
    }
    loadStatsActivity();
  });
})();
