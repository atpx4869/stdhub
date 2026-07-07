// ── Qualification ──
let qualSearchSource = '';
let qualData = {}; // stdCode -> Qualification[] (from search result badges)
let byStdSource = '';            // 「按标准查」的 source 过滤（''=全部 / CNAS / CMA）
let byStdGroups = [];            // 上次查询返回的分组（展开时从这里取 rows，免重复请求）
function beijingDate() { const d = new Date(new Date().getTime() + 8*3600000); return d.toISOString().slice(0, 10); }
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
    const url = `/api/qualifications/search?q=${encodeURIComponent(q)}${qualSearchSource ? '&source=' + qualSearchSource : ''}`;
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

// ── Qual Lab Management ──
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
  showToast(`正在同步 ${id}…`);
  startSyncProgressPoll();
  try {
    const res = await fetch(url, { method: 'POST' });
    const data = await readApiResponse(res);
    if (!res.ok) throw new Error(data.message);
    loadQualLabs();
    loadLabsSyncLogs();
    showToast(`同步完成: ${data.records} 条记录`);
  } catch (e) { showToast(`同步失败: ${e.message}`, 'fail'); }
}

async function syncAllQualLabs() {
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
    showToast('全部同步完成');
  } catch (e) { showToast(`同步失败: ${e.message}`, 'fail'); }
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

// ── Init ──
checkAuthStatus();
