// ── Qual Search & Badges ──
let qualSearchSource = '';
let qualSearchLimit = 50;
let qualData = {}; // stdCode -> Qualification[] (from search result badges)
let byStdSource = '';            // 「按标准查」的 source 过滤（''=全部 / CNAS / CMA）
let byStdLimit = 100;
let byStdGroups = [];            // 上次查询返回的分组（展开时从这里取 rows，免重复请求）
// beijingDate 已在 app-core.js 中定义
function beijingTime() { const d = new Date(new Date().getTime() + 8*3600000); return d.toISOString().slice(0, 19).replace('T', ' '); }
function utcToBeijing(utcStr) { if (!utcStr) return ''; const d = new Date(utcStr); d.setTime(d.getTime() + 8*3600000); return d.toISOString().slice(0, 16).replace('T', ' '); }

function switchQualTab(tab) {
  // 订阅管理 / 同步日志 已迁移到「系统设置」，这里只保留搜索 + 可视化。
  if (tab === 'labs' || tab === 'logs') {
    if (typeof switchTab === 'function') switchTab('settings');
    setTimeout(() => switchQualSettingsTab(tab === 'logs' ? 'logs' : 'labs'), 0);
    return;
  }
  // 手机端两个子标签都可用（搜索 + 可视化）。早期版本曾强制重定向到可视化，
  // 但用户能看到「搜索」按钮却点不动反而更糟。窄屏下若搜索页有局部排版问题，
  // 应在 CSS 单点修，不要禁掉整个功能。
  // 外观（文字色 / 下边框）由 .qual-tab[.active] CSS 接管，这里只切 class
  // （与 switchQualSettingsTab 同款写法，消除内联 style）。
  document.querySelectorAll('.qual-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.qualTab === tab);
  });
  const searchEl = document.getElementById('qualSearchTab');
  const visualEl = document.getElementById('qualVisualTab');
  const byStdEl = document.getElementById('qualByStdTab');
  if (searchEl) searchEl.style.display = tab === 'search' ? '' : 'none';
  if (visualEl) visualEl.style.display = tab === 'visual' ? '' : 'none';
  if (byStdEl) byStdEl.style.display = tab === 'bystd' ? 'flex' : 'none';
}

// Sub-tab switcher for the qual-subscription section that lives inside
// the 系统设置 page. Tabs: 'labs' (订阅管理) or 'logs' (同步日志).
function switchQualSettingsTab(tab) {
  // 外观（文字色 / 下边框）由 .set-tab[.active] CSS 接管，这里只切 class。
  document.querySelectorAll('.qual-settings-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.qualSettingsTab === tab);
  });
  const labsEl = document.getElementById('qualLabsTab');
  const logsEl = document.getElementById('qualLogsTab');
  if (labsEl) labsEl.style.display = tab === 'labs' ? '' : 'none';
  if (logsEl) logsEl.style.display = tab === 'logs' ? '' : 'none';
  if (tab === 'labs') {
    if (typeof loadQualLabs === 'function') loadQualLabs();
    if (typeof loadLabsSyncLogs === 'function') loadLabsSyncLogs();
  } else if (tab === 'logs') {
    if (typeof loadQualSyncLogs === 'function') loadQualSyncLogs('cnas');
  }
}

async function doQualBatchVisual() {
  const input = document.getElementById('qualBatchInput');
  // 行内分隔符：换行 / 逗号（中英）/ 分号（中英）/ 顿号 / 中文句号 / 制表符
  // 不切英文句号 `.`，否则 "GB 5009.9" 这类标准号会被切坏
  const queries = [...new Set(input.value.split(/[\n\r,，;；、。\t]+/).map(s => s.trim()).filter(Boolean))];
  const stats = document.getElementById('qualVisualStats');
  const out = document.getElementById('qualVisualResults');
  if (!queries.length) {
    stats.innerHTML = '请输入关键词';
    out.innerHTML = '';
    return;
  }
  stats.innerHTML = '<span class="spinner"></span> 正在查询本地缓存';
  out.innerHTML = '';
  try {
    const res = await fetch('/api/qualifications/visual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries }),
    });
    const data = await readQualApiJson(res);
    if (!res.ok) throw new Error(data.message || '查询失败');
    renderQualVisual(queries, data);
    // 手机模式：查询成功后折叠输入框，让结果占满视野
    if (typeof window.isMobile === 'function' && window.isMobile()) {
      const card = document.getElementById('qualVisualInputCard');
      if (card) card.classList.add('collapsed');
    }
  } catch (e) {
    stats.innerHTML = `<span style="color:var(--danger)">查询失败: ${escapeHtml(e.message)}</span>`;
  }
}

function expandQualVisualInput() {
  // 仅手机模式生效：折叠态点击标题 → 展开回 textarea
  if (typeof window.isMobile !== 'function' || !window.isMobile()) return;
  const card = document.getElementById('qualVisualInputCard');
  if (!card || !card.classList.contains('collapsed')) return;
  card.classList.remove('collapsed');
  const input = document.getElementById('qualBatchInput');
  if (input) setTimeout(() => input.focus(), 50);
}

function fillQualBatchFromSaved() {
  const input = document.getElementById('qualBatchInput');
  input.value = savedStandards.map(s => s.standardNumber).filter(Boolean).join('\n');
  input.focus();
}

function renderQualVisual(queries, data) {
  const stats = document.getElementById('qualVisualStats');
  const out = document.getElementById('qualVisualResults');
  const now = beijingDate();

  // 全局统计：跨 query 跨 source 累计能力数 + 过期数
  let covered = 0, cnasCnt = 0, cmaCnt = 0, expiredCnt = 0;
  for (const query of queries) {
    const items = data[query] || [];
    if (items.length) covered++;
    for (const it of items) {
      if (it.source === 'CNAS') cnasCnt++;
      if (it.source === 'CMA') cmaCnt++;
      if (it.expiryDate && it.expiryDate < now) expiredCnt++;
    }
  }

  stats.innerHTML = `
    <div><strong>${covered}/${queries.length}</strong><span>关键词命中</span></div>
    <div><strong>${cnasCnt}</strong><span>CNAS 能力</span></div>
    <div><strong>${cmaCnt}</strong><span>CMA 能力</span></div>
    <div class="${expiredCnt ? 'warn' : ''}"><strong>${expiredCnt}</strong><span>已过期记录</span></div>`;

  if (!queries.some(query => (data[query] || []).length)) {
    out.innerHTML = '<div class="qual-empty">本地缓存暂无匹配资质。请先在「系统设置 → 资质订阅」中订阅机构并同步能力。</div>';
    return;
  }

  // 多 query 时按 query 分 section；每 section 内套用资质查询-搜索同款统一列表
  // （标准号分组、CNAS 段 → CMA 段、默认收起）
  const sections = queries.map((query, qIdx) => {
    const items = data[query] || [];
    const sectionId = `qvs_${qIdx}`;
    const opts = { gidPrefix: `qvg_${qIdx}_` };

    const headerHtml = `<div class="qual-visual-query-head">
      <div class="qv-section-title"><strong>${escapeHtml(query)}</strong><span>${items.length ? items.length + ' 条' : '无结果'}</span></div>
      <div class="qual-visual-query-actions">
        <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px" onclick="toggleQualVisualSection('${sectionId}', true)">全部展开</button>
        <button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px" onclick="toggleQualVisualSection('${sectionId}', false)">全部收起</button>
      </div>
    </div>`;

    const body = items.length
      ? buildQualUnifiedList(items, opts)
      : '<div class="qual-empty" style="padding:14px 0">该关键词无匹配</div>';

    return `<section class="qual-visual-query-section" id="${sectionId}">${headerHtml}${body}</section>`;
  }).join('');

  out.innerHTML = `<div class="qual-visual-results">${sections}</div>`;
}

function toggleQualVisualSection(sectionId, expand) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  // 每张分组卡里的 _body / _arrow —— 跟资质查询-搜索的 toggleAllQualGroups 同行为
  section.querySelectorAll('[id$="_body"]').forEach(el => { el.style.display = expand ? '' : 'none'; });
  section.querySelectorAll('.qual-group-arrow').forEach(el => { el.style.transform = expand ? 'rotate(90deg)' : ''; });
}

function updateQualAdvancedFilterButton(mode) {
  const isByStd = mode === 'bystd';
  const button = document.getElementById(isByStd ? 'qualByStdAdvancedBtn' : 'qualSearchAdvancedBtn');
  if (!button) return;
  const isActive = (isByStd ? byStdLimit : qualSearchLimit) !== (isByStd ? 100 : 50);
  const count = button.querySelector('.filter-drawer-count');
  button.classList.toggle('is-active', isActive);
  if (count) {
    count.hidden = !isActive;
    count.textContent = isActive ? '1' : '';
  }
}

window.openQualAdvancedFilter = function (mode) {
  const isByStd = mode === 'bystd';
  const defaultLimit = isByStd ? 100 : 50;
  const currentLimit = isByStd ? byStdLimit : qualSearchLimit;
  const choices = isByStd ? [100, 200, 300] : [50, 100, 200];
  if (typeof window.openFilterDrawer !== 'function') return;
  window.openFilterDrawer({
    title: isByStd ? '详细搜索筛选' : '资质搜索筛选',
    description: '常用来源已放在搜索框下方；这里仅调整单次返回的结果数量。',
    bodyHtml: '<div class="filter-drawer-field"><div class="filter-drawer-label">单次返回数量</div><div class="filter-choice-set">'
      + choices.map(function (limit) { return '<label class="filter-choice"><input type="radio" name="qualResultLimit" value="' + limit + '"' + (limit === currentLimit ? ' checked' : '') + '><span>' + limit + ' 条</span></label>'; }).join('')
      + '</div><p class="filter-drawer-help">更多结果适合精确查找；较少结果打开更快、更易浏览。</p></div>',
    onReset: function () {
      const input = document.querySelector('input[name="qualResultLimit"][value="' + defaultLimit + '"]');
      if (input) input.checked = true;
    },
    onApply: function () {
      const input = document.querySelector('input[name="qualResultLimit"]:checked');
      const limit = input ? Number(input.value) : defaultLimit;
      if (isByStd) byStdLimit = limit;
      else qualSearchLimit = limit;
      updateQualAdvancedFilterButton(mode);
      if (isByStd) doQualByStdSearch();
      else doQualSearch();
    },
  });
};

function setQualFilter(btn, source) {
  qualSearchSource = source;
  btn.closest('.qual-filters').querySelectorAll('.qual-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
  doQualSearch();
}

async function doQualSearch() {
  const q = document.getElementById('qualSearchInput').value.trim();
  if (!q) { document.getElementById('qualResults').innerHTML = '<div class="qual-empty">输入关键词搜索资质信息</div>'; return; }
  // 手机端 landing → active：搜索框 sticky 吸顶
  if (typeof setSearchStage === 'function') setSearchStage('qual', 'active');
  document.getElementById('qualResults').innerHTML = '<span class="spinner"></span>';
  try {
    const url = `/api/qualifications/search?q=${encodeURIComponent(q)}${qualSearchSource ? '&source=' + qualSearchSource : ''}&limit=${qualSearchLimit}`;
    const res = await fetch(url);
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message);
    renderQualSearchResults(data.items || []);
  } catch (e) {
    document.getElementById('qualResults').innerHTML = `<div class="qual-empty" style="color:var(--danger)">搜索失败: ${escapeHtml(e.message)}</div>`;
  }
}

// ===== 按标准查（关键词 → 按标准号聚合，产品标准可展开 / 方法直显）=====

function setByStdFilter(btn, source) {
  byStdSource = source;
  btn.closest('.qual-filters').querySelectorAll('.qual-filter-btn').forEach(b => b.classList.toggle('active', b === btn));
  doQualByStdSearch();
}

async function doQualByStdSearch() {
  const q = document.getElementById('qualByStdInput').value.trim();
  const box = document.getElementById('qualByStdResults');
  if (!q) { box.innerHTML = '<div class="qual-empty">输入关键词，按标准号聚合查询本地缓存资质。产品标准可展开看全部资质行；方法标准直接显示。</div>'; return; }
  if (typeof setSearchStage === 'function') setSearchStage('qual', 'active');
  box.innerHTML = '<span class="spinner"></span>';
  try {
    const url = `/api/qualifications/search-by-standard?q=${encodeURIComponent(q)}${byStdSource ? '&source=' + byStdSource : ''}`;
    const res = await fetch(url);
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message);
    byStdGroups = data.items || [];
    renderByStdResults(byStdGroups);
  } catch (e) {
    box.innerHTML = `<div class="qual-empty" style="color:var(--danger)">搜索失败: ${escapeHtml(e.message)}</div>`;
  }
}

function renderByStdResults(groups) {
  const box = document.getElementById('qualByStdResults');
  if (!groups.length) { box.innerHTML = '<div class="qual-empty">未匹配到资质</div>'; return; }
  box.innerHTML = groups.map((g, i) => {
    const name = cleanStdNameForQual(g.stdCode, g.stdName);
    const cat = g.category ? `<span class="qual-bystd-cat">${escapeHtml(g.category)}</span>` : '';
    const trunc = g.truncated ? `<span class="qual-bystd-trunc" title="行数过多已截断，仅展示前 ${g.rows.length} 行">截断</span>` : '';
    // 机构弱化：实际只有一家机构时不显「· M 家」（避免重复噪声）
    const labMeta = (g.labCount || 0) > 1 ? ` · ${g.labCount} 家` : '';
    if (g.isProduct) {
      return `
        <div class="qual-bystd-card" data-idx="${i}">
          <div class="qual-bystd-head" onclick="toggleByStdGroup(${i})">
            <span class="qual-bystd-arrow" id="byStd_${i}_arrow">▸</span>
            <span class="qual-bystd-kind">📦 产品标准</span>
            <span class="qual-bystd-code">${escapeHtml(g.stdCode)}</span>
            ${typeof capLibBadgeHtml === 'function' ? capLibBadgeHtml(g.stdCode || '') : ''}
            <span class="qual-bystd-name">${escapeHtml(name)}</span>
            <span class="qual-bystd-meta">${g.rowCount} 项${labMeta} · ${escapeHtml(g.source)}</span>
            ${cat}${trunc}
          </div>
          <div class="qual-bystd-body" id="byStd_${i}_body" style="display:none"></div>
        </div>`;
    }
    const param = g.rows[0] ? (g.rows[0].testParam || g.rows[0].testObject || '') : '';
    return `
      <div class="qual-bystd-card qual-bystd-method" data-idx="${i}">
        <div class="qual-bystd-head" onclick="toggleByStdGroup(${i})">
          <span class="qual-bystd-arrow" id="byStd_${i}_arrow">▸</span>
          <span class="qual-bystd-kind qual-bystd-kind-method">🔬 方法</span>
          <span class="qual-bystd-code">${escapeHtml(g.stdCode)}</span>
          ${typeof capLibBadgeHtml === 'function' ? capLibBadgeHtml(g.stdCode || '') : ''}
          <span class="qual-bystd-name">${escapeHtml(name)}</span>
          <span class="qual-bystd-meta">${param ? '参数:' + escapeHtml(param) : ''}${labMeta} · ${escapeHtml(g.source)}</span>
          ${cat}
        </div>
        <div class="qual-bystd-body" id="byStd_${i}_body" style="display:none"></div>
      </div>`;
  }).join('');
  // 异步拉取一单一库匹配状态，替换占位徽章
  if (typeof fetchCapLibBadges === 'function') {
    const codes = [...new Set(groups.map(g => g.stdCode).filter(Boolean))];
    fetchCapLibBadges(codes).catch(() => {});
  }
}

window.toggleByStdGroup = function (i) {
  const body = document.getElementById('byStd_' + i + '_body');
  const arrow = document.getElementById('byStd_' + i + '_arrow');
  if (!body) return;
  if (body.style.display === 'none') {
    if (!body.dataset.rendered) {
      body.innerHTML = renderByStdRows(byStdGroups[i]);
      body.dataset.rendered = '1';
    }
    body.style.display = '';
    if (arrow) arrow.textContent = '▾';
  } else {
    body.style.display = 'none';
    if (arrow) arrow.textContent = '▸';
  }
};

function renderByStdRows(g) {
  const isCnas = g.source === 'CNAS';
  // 机构弱化：实际只有一家机构（labCount<=1）时不出「机构」列，避免每行重复同一家名。
  const showLab = (g.labCount || 0) > 1;
  const labHead = showLab ? '<th>机构</th>' : '';
  const labCell = r => showLab ? `<td>${escapeHtml(r.labName || r.labNo)}</td>` : '';
  const head = isCnas
    ? `<th>检测对象</th><th>检测参数</th><th>方法/标准</th>${labHead}<th>限值</th>`
    : `<th>检测项目</th><th>方法/标准</th>${labHead}<th>限值</th>`;
  const rows = g.rows.map(r => isCnas
    ? `<tr><td>${escapeHtml(r.testObject)}</td><td>${escapeHtml(r.testParam)}</td><td>${escapeHtml(r.testStandard)}</td>${labCell(r)}<td>${escapeHtml(r.limitDesc)}</td></tr>`
    : `<tr><td>${escapeHtml(r.testParam)}</td><td>${escapeHtml(r.testStandard)}</td>${labCell(r)}<td>${escapeHtml(r.limitDesc)}</td></tr>`
  ).join('');
  return `<table class="qual-bystd-table"><thead><tr>${head}</tr></thead><tbody>${rows}</tbody></table>`;
}

// Strip duplicated standard code from stdName (e.g. "家具... GB 18584-2024" -> "家具...")
function cleanStdNameForQual(code, name) {
  if (!name) return '';
  var escaped = code.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return name.replace(new RegExp('\\s*' + escaped + '\\s*$', 'i'), '').trim()
             .replace(new RegExp('^\\s*' + escaped + '\\s*', 'i'), '').trim() || name;
}

/**
 * 资质统一列表渲染 —— 资质查询-搜索和可视化-按关键词都共用这套样式。
 *
 * 布局规则（v3，2026-05-27）：
 * 1) 不再分 CMA / CNAS 两列，而是按 (stdCode + source) 分组、所有分组单列纵向排列
 * 2) 全局严格 CNAS 段在前、CMA 段在后，段间画一条 <hr> 分割
 * 3) 同 source 内按 stdCode 升序自然聚类；组内 items 含"全部参数"→ 0、"部分参数"→ 1、其它 → 2
 * 4) 单条记录字段：类别 chip + 检测项目 + 生效/到期；不显示机构名、不显示 limitDesc
 * 5) 含"全部参数 / 部分参数"的 item 整张卡加粗 + 淡背景，凸显"覆盖范围"信号
 *
 * gidPrefix 让多个 tab 的 group id 不冲突（搜索页用 'qg_'，可视化页 'qvg_<qIdx>_'）
 */
function paramScopeRank(it) {
  // 0 = 全部参数（最顶）；1 = 部分参数；2 = 其它
  // 这类条目代表整张证书覆盖范围，比单项检测更有信号价值
  var s = (it.testItem || '') + ' ' + (it.testStandard || '');
  if (/全部参数/.test(s)) return 0;
  if (/部分参数/.test(s)) return 1;
  return 2;
}

function buildQualUnifiedList(items, opts) {
  opts = opts || {};
  var gidPrefix = opts.gidPrefix || 'qg_';
  var now = beijingDate();
  if (!items.length) {
    return '<div class="qual-empty" style="padding:20px 0">无匹配结果</div>';
  }

  // Group by stdCode + source
  var groupMap = {}; // key = source + '|' + stdCode
  var groupOrder = []; // 保留出现顺序，稳定排序
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var key = (it.source || '') + '|' + (it.stdCode || '');
    if (!groupMap[key]) {
      groupMap[key] = { source: it.source, stdCode: it.stdCode, stdName: it.stdName, items: [], seen: new Set() };
      groupOrder.push(key);
    }
    var g = groupMap[key];
    var dedupKey = (it.category || '') + '|' + (it.testItem || '') + '|' + (it.testStandard || '');
    if (g.seen.has(dedupKey)) continue;
    g.seen.add(dedupKey);
    g.items.push(it);
  }

  // 排序：CNAS(0) < CMA(1) < 其它(2)；同 source 内按 stdCode
  function sourceRank(s) { return s === 'CNAS' ? 0 : s === 'CMA' ? 1 : 2; }
  groupOrder.sort(function (a, b) {
    var ga = groupMap[a], gb = groupMap[b];
    var sd = sourceRank(ga.source) - sourceRank(gb.source);
    if (sd !== 0) return sd;
    return (ga.stdCode || '').localeCompare(gb.stdCode || '');
  });

  var html = '';
  var prevSource = null;
  var groupIdx = 0;
  for (var k = 0; k < groupOrder.length; k++) {
    var grp = groupMap[groupOrder[k]];
    grp.items.sort(function (a, b) { return paramScopeRank(a) - paramScopeRank(b); });

    // 段间分割线（CNAS → CMA 等切换 source 时插入，但首段不插）
    if (prevSource !== null && grp.source !== prevSource) {
      html += '<hr class="qual-source-divider">';
    }
    prevSource = grp.source;

    var gid = gidPrefix + grp.source + '_' + (groupIdx++);
    var cleanName = cleanStdNameForQual(grp.stdCode, grp.stdName);
    var sourceCls = grp.source === 'CNAS' ? 'qual-source-chip-cnas' : (grp.source === 'CMA' ? 'qual-source-chip-cma' : '');
    var sourceChip = grp.source
      ? '<span class="qual-source-chip ' + sourceCls + '">' + escapeHtml(grp.source) + '</span>'
      : '';

    // 计算组级 scope（"全部参数"≻"部分参数"≻null）。"全部参数"是更强信号，
    // 同组里只要有一条命中就标全部；否则只要有"部分参数"就标部分。
    var groupScope = null;
    for (var si = 0; si < grp.items.length; si++) {
      var sr = paramScopeRank(grp.items[si]);
      if (sr === 0) { groupScope = 'all'; break; }
      if (sr === 1) groupScope = 'partial';
    }

    var scopeChip = '';
    if (groupScope === 'all') {
      scopeChip = '<span class="qual-scope-badge scope-all">全部参数</span>';
    } else if (groupScope === 'partial') {
      scopeChip = '<span class="qual-scope-badge scope-partial">部分参数</span>';
    }

    // 部分参数场景：把所有 partial item 的 limitDesc 合并、去重、单行长驻展示
    // （用户能直接看到"不测：xxx"而无需展开）。原文已带"不测："前缀，不再叠加。
    // 全部参数 / 其它场景不渲此行（全部 = 无限制，其它 = 没意义的限定信息）。
    var limitRowHtml = '';
    if (groupScope === 'partial') {
      var limitSeen = {};
      var limitParts = [];
      for (var li = 0; li < grp.items.length; li++) {
        var lit = grp.items[li];
        if (paramScopeRank(lit) !== 1) continue;
        var ld = (lit.limitDesc || '').trim();
        if (!ld || ld === '/' || ld === '—' || limitSeen[ld]) continue;
        limitSeen[ld] = 1;
        limitParts.push(ld);
      }
      if (limitParts.length) {
        limitRowHtml = '<div class="qual-scope-limit-row">' + escapeHtml(limitParts.join('；')) + '</div>';
      }
    }

    var rows = grp.items.map(function (it) {
      var expired = it.expiryDate && it.expiryDate < now;
      var highlight = paramScopeRank(it) < 2; // 全部参数 / 部分参数 → 高亮
      var parts = [];
      if (it.category) {
        var cats = it.category.split('-').map(function (s) { return s.trim(); }).filter(Boolean);
        parts.push('<div class="qual-item-cats">' + cats.map(function (c) { return '<span style="display:inline-block;padding:1px 5px;background:var(--surface-h);border-radius:3px;font-size:10px;color:var(--text-2);margin-right:3px;margin-bottom:2px">' + escapeHtml(c) + '</span>'; }).join('') + '</div>');
      }
      if (it.testItem) {
        parts.push('<div class="qual-item-test"><span style="color:var(--text-3);font-size:10px">检测项目 </span>' + escapeHtml(it.testItem.length > 80 ? it.testItem.slice(0, 80) + '…' : it.testItem) + '</div>');
      }
      var dates = [];
      if (it.effectiveDate) dates.push('<span style="color:' + (expired ? 'var(--danger)' : 'var(--success)') + '">生效 ' + escapeHtml(it.effectiveDate) + '</span>');
      if (it.expiryDate) dates.push('<span style="color:' + (expired ? 'var(--danger)' : 'var(--text-2)') + '">' + (expired ? '已过期 ' : '到期 ') + escapeHtml(it.expiryDate) + '</span>');
      if (dates.length) parts.push('<div class="qual-item-dates">' + dates.join(' · ') + '</div>');
      return '<div class="qual-result-item' + (highlight ? ' qual-result-item-scope' : '') + '">' + parts.join('') + '</div>';
    }).join('');

    // 全部参数：组内每条都是"覆盖全部"，再展开看 N 条同质 item 没价值，整组折叠态干净更好
    // 部分参数 / 其它：仍可展开看明细（生效日期 / 到期日期 / 测试项对用户重要）
    var collapsible = groupScope !== 'all';
    var headerAttrs = collapsible
      ? ' onclick="toggleQualGroup(\'' + gid + '\')" style="cursor:pointer"'
      : '';
    var arrowHtml = collapsible
      ? '<span class="qual-group-arrow" id="' + gid + '_arrow" style="display:inline-block;width:16px;font-size:10px;color:var(--text-3);transition:transform 0.2s">▶</span>'
      : '<span style="display:inline-block;width:16px"></span>';
    // 全部参数：N 项徽章保留（告诉用户"5 家机构都能测全部"），但不渲 body
    var bodyHtml = (groupScope === 'all')
      ? ''
      : '<div id="' + gid + '_body" style="display:none">' + rows + '</div>';

    html += '<div class="qual-result-group">'
      + '<div class="qual-result-std"' + headerAttrs + '>'
      + arrowHtml
      + sourceChip
      + '<span class="qual-std-code">' + escapeHtml(grp.stdCode || '') + '</span>'
      + (typeof capLibBadgeHtml === 'function' ? capLibBadgeHtml(grp.stdCode || '') : '')
      + scopeChip
      + '<span class="qual-std-name">' + escapeHtml(cleanName) + '</span>'
      + '<span style="margin-left:auto;font-size:11px;color:var(--text-3)">' + grp.items.length + ' 项</span>'
      + '</div>'
      + limitRowHtml
      + bodyHtml
      + '</div>';
  }
  return '<div class="qual-unified-list">' + html + '</div>';
}

function renderQualSearchResults(items) {
  if (!items.length) { document.getElementById('qualResults').innerHTML = '<div class="qual-empty">未找到匹配的资质信息</div>'; return; }

  const totalCount = items.length;
  const header = '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">'
    + '<span style="font-size:11px;color:var(--text-3)">共 ' + totalCount + ' 条资质</span>'
    + '<span style="display:flex;gap:8px">'
    + '<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px" onclick="toggleAllQualGroups(true)">全部展开</button>'
    + '<button class="btn btn-ghost btn-sm" style="font-size:11px;padding:3px 8px" onclick="toggleAllQualGroups(false)">全部收起</button>'
    + '</span></div>';
  const content = buildQualUnifiedList(items, { gidPrefix: 'qg_' });
  document.getElementById('qualResults').innerHTML = header + content;
  // 异步把搜索结果里出现的 std_code 一次性 batch-status 拉一遍，
  // 拿到后由 fetchCapLibBadges 走 DOM 替换占位，不重渲整页
  if (typeof fetchCapLibBadges === 'function') {
    const codes = [...new Set(items.map(it => it.stdCode).filter(Boolean))];
    fetchCapLibBadges(codes).catch(() => { /* silent */ });
  }
}

function toggleAllQualGroups(expand) {
  document.querySelectorAll('#qualResults [id$="_body"]').forEach(function(el) {
    el.style.display = expand ? '' : 'none';
  });
  document.querySelectorAll('#qualResults .qual-group-arrow').forEach(function(el) {
    el.style.transform = expand ? 'rotate(90deg)' : '';
  });
}

function toggleQualGroup(gid) {
  var body = document.getElementById(gid + '_body');
  var arrow = document.getElementById(gid + '_arrow');
  if (!body) return;
  if (body.style.display === 'none') {
    body.style.display = '';
    arrow.style.transform = 'rotate(90deg)';
  } else {
    body.style.display = 'none';
    arrow.style.transform = '';
  }
}

// ── Qual badges for search results ──
//
// Tooltip 浮层定位机制(2026-05):
// badge 内部 inline 渲染 `<span class="qual-tooltip">`,但用户报浮层被
// `.status-group-body { overflow: hidden }` 裁剪 + `.result-card { transition: transform }`
// 创建的 containing block 共同导致 position:absolute / position:fixed 都跳不出来。
// 解决:hover 时把 tooltip detach 到 document.body 末尾用 position:fixed 算 viewport 坐标,
// mouseleave 再放回 badge 内部。这样完全绕开任何祖先的 overflow / transform 问题。
function qualBadgeHtml(standardNumber) {
  if (!qualData || !standardNumber) return '';
  const quals = qualData[standardNumber];
  if (!quals || !quals.length) return '';
  const cnas = quals.filter(q => q.source === 'CNAS');
  const cma = quals.filter(q => q.source === 'CMA');
  let html = '<span class="qual-badges">';
  // Badge text 只显示 source 简称（CNAS / CMA），保持两源视觉对齐；
  // 完整证书有效期 / 机构数等明细在 hover tooltip 里给。
  if (cnas.length) {
    const tip = buildQualTooltip(cnas, 'CNAS');
    html += `<span class="qual-badge qual-badge-cnas"><span class="qual-dot"></span>CNAS<span class="qual-tooltip">${tip}</span></span>`;
  }
  if (cma.length) {
    const tip = buildQualTooltip(cma, 'CMA');
    html += `<span class="qual-badge qual-badge-cma"><span class="qual-dot"></span>CMA<span class="qual-tooltip">${tip}</span></span>`;
  }
  html += '</span>';
  return html;
}

// 全局事件代理 — 把任意 .qual-badge 的 tooltip 在 hover 时挪到 body 末尾
// 用 viewport 坐标定位,绕过 overflow:hidden / transform containing block 等裁剪
(function setupQualTooltipPortal() {
  if (typeof document === 'undefined' || document.__qualTooltipPortalReady) return;
  document.__qualTooltipPortalReady = true;

  /** @type {HTMLElement|null} 当前正在显示的 tooltip 节点 */
  let activeTip = null;
  /** @type {HTMLElement|null} tooltip 的原属 badge,mouseleave 时复位 */
  let activeBadge = null;
  /** @type {Comment|null} placeholder 占位,detach 后回插用 */
  let activePlaceholder = null;

  function showTip(badge) {
    if (activeTip) hideTip(); // 切换 badge 时先复位上一条
    const tip = badge.querySelector(':scope > .qual-tooltip');
    if (!tip) return;
    activeBadge = badge;
    activeTip = tip;
    activePlaceholder = document.createComment('qual-tooltip-placeholder');
    badge.insertBefore(activePlaceholder, tip);
    document.body.appendChild(tip);
    // detach 出 badge 后 `.qual-badge .qual-tooltip` 后代选择器不再命中,样式全失效。
    // 加 floating class 触发 `.qual-tooltip.qual-tooltip-floating` 独立选择器,
    // 把背景/字号/毛玻璃/阴影等样式重新喂上
    tip.classList.add('qual-tooltip-floating');

    // 先把 tooltip 显示出来才能拿正确的 getBoundingClientRect(尺寸)
    tip.style.position = 'fixed';
    tip.style.opacity = '0';                        // 暂不可见,免得在 (0,0) 闪一下
    tip.style.left = '0px';
    tip.style.top = '0px';
    tip.style.transform = 'none';                   // 抹掉原 CSS 里的 translateX(-50%)
    tip.style.zIndex = '9999';                      // 高于所有 stacking context

    // 用 viewport 坐标定位 —— badge.getBoundingClientRect 拿到的就是 viewport 系
    const rect = badge.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();
    let top = rect.top - tipRect.height - 8;        // badge 上方,8px 间距
    let left = rect.left + rect.width / 2 - tipRect.width / 2;
    // 视口边界保护:超左/右贴边、上方不够时倒挂到下方
    const margin = 8;
    if (left < margin) left = margin;
    if (left + tipRect.width > window.innerWidth - margin) left = window.innerWidth - tipRect.width - margin;
    if (top < margin) top = rect.bottom + 8;
    tip.style.top = `${top}px`;
    tip.style.left = `${left}px`;
    tip.style.opacity = '1';
  }

  function hideTip() {
    if (!activeTip) return;
    activeTip.classList.remove('qual-tooltip-floating');
    activeTip.style.opacity = '';
    activeTip.style.position = '';
    activeTip.style.top = '';
    activeTip.style.left = '';
    activeTip.style.transform = '';
    activeTip.style.zIndex = '';
    if (activeBadge && activePlaceholder && activePlaceholder.parentNode === activeBadge) {
      activeBadge.insertBefore(activeTip, activePlaceholder);
      activePlaceholder.remove();
    } else if (activeBadge) {
      // placeholder 失效兜底:直接 append 回 badge
      activeBadge.appendChild(activeTip);
    }
    activeTip = null;
    activeBadge = null;
    activePlaceholder = null;
  }

  document.addEventListener('mouseover', (e) => {
    const badge = e.target.closest && e.target.closest('.qual-badge');
    if (badge && badge !== activeBadge) showTip(badge);
  });
  document.addEventListener('mouseout', (e) => {
    if (!activeBadge) return;
    const to = e.relatedTarget;
    // 移到 tooltip 自身上不算离开(用户可能想点击/复制内容,虽然 pointer-events:none)
    if (to && (activeBadge.contains(to) || (activeTip && activeTip.contains(to)))) return;
    hideTip();
  });
  // 滚动 / resize 时 tooltip 位置失效,直接隐藏让用户重新 hover
  window.addEventListener('scroll', () => { if (activeTip) hideTip(); }, true);
  window.addEventListener('resize', () => { if (activeTip) hideTip(); });
})();

function buildQualTooltip(quals, source) {
  const now = beijingDate();
  const parts = [];

  // Deduplicate by testStandard + category
  const seen = new Set();
  const unique = quals.filter(q => {
    const k = (q.testStandard || '') + '|' + (q.category || '');
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  for (const q of unique.slice(0, 4)) {
    const lines = [];
    if (q.stdName && q.stdName !== q.testStandard) {
      lines.push('<b>' + escapeHtml(q.stdName) + '</b>');
    }
    if (q.category) lines.push('<span style="color:var(--text-3)">领域</span> ' + escapeHtml(q.category));
    if (q.testItem) lines.push('<span style="color:var(--text-3)">项目</span> ' + escapeHtml(q.testItem.length > 40 ? q.testItem.slice(0, 40) + '…' : q.testItem));
    if (q.limitDesc && q.limitDesc !== '/' && q.limitDesc !== '—') {
      lines.push('<span style="color:var(--warning)">限定</span> ' + escapeHtml(q.limitDesc.length > 30 ? q.limitDesc.slice(0, 30) + '…' : q.limitDesc));
    }
    // Authorization dates
    const dates = [];
    if (q.effectiveDate) {
      const expired = q.expiryDate && q.expiryDate < now;
      dates.push('<span style="color:' + (expired ? 'var(--danger)' : 'var(--success)') + '">生效 ' + escapeHtml(q.effectiveDate) + '</span>');
    }
    if (q.expiryDate) {
      const expired = q.expiryDate < now;
      dates.push('<span style="color:' + (expired ? 'var(--danger)' : 'var(--text-2)') + '">到期 ' + escapeHtml(q.expiryDate) + '</span>');
    }
    if (dates.length) lines.push(dates.join(' · '));
    if (lines.length) parts.push(lines.join('<br>'));
  }

  if (unique.length > 4) parts.push('<span style="color:var(--text-3)">…还有 ' + (unique.length - 4) + ' 项</span>');
  return parts.join('<hr style="border:none;border-top:1px solid var(--border);margin:6px 0">') || source + ' 资质';
}

async function fetchQualBadges(standardNumbers) {
  if (!standardNumbers.length) return;
  try {
    // 只查 qualData 里还没有的 stdCode —— 增量拉,避免重复网络请求
    // 多源搜索时各源异步返回,每个源到达都调用一次本函数补查新增 stdCode
    const unique = [...new Set(standardNumbers)].filter(Boolean);
    const pending = unique.filter(code => !(code in qualData));
    if (!pending.length) return;
    const res = await fetch('/api/qualifications/batch-query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stdCodes: pending }),
    });
    if (!res.ok) return;
    const data = await readApiResponse(res);
    // merge 而非 replace:后端只返回有命中的 stdCode,但 pending 里全部 stdCode 都该
    // 标记为"已查过"(用 [] 占位),避免下次 pending 过滤把没命中的又算成 pending
    for (const code of pending) {
      qualData[code] = data[code] || [];
    }
  } catch { /* silent */ }
}
