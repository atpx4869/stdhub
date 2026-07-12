// ── Search Render: filter, cards, progressive rendering ──

// ── Filter bar ──
// 分组只按标准状态。资质 / 一单一库徽章是异步到达的，若参与分组，
// 用户正在阅读的卡片会突然跳到别处；资质仍通过徽章和「有资质」筛选表达。
function statusCategory(s, standardNumber) {
  void standardNumber;
  if (!s) return '其它';
  if (s.includes('现行') || s.includes('部分有效')) return '现行';
  if (s.includes('废止')) return '废止';
  if (s.includes('即将实施')) return '即将实施';
  return '其它';
}

function getFilteredResults() {
  const filtered = results.filter(r => {
    if (filterState.sources.size > 0) {
      const rSources = r.sources || [r._source];
      if (!rSources.some(s => filterState.sources.has(s))) return false;
    }
    if (filterState.statuses.size > 0) {
      const baseCat = statusCategory(r.status, r.standardNumber);
      if (!filterState.statuses.has(baseCat)) return false;
    }
    if (filterState.onlyDownloadable && !r.previewAvailable) return false;
    if (filterState.onlyQualified && !hasQualificationBadge(r.standardNumber)) return false;
    if (filterState.onlySaved && !isStandardSaved(r)) return false;
    return true;
  });
  return sortFilteredResults(filtered);
}

function hasQualificationBadge(standardNumber) {
  const items = qualData?.[standardNumber] || [];
  return Array.isArray(items) && items.length > 0;
}

function sortFilteredResults(items) {
  const sorted = [...items];
  const dateValue = (value) => {
    const t = value ? new Date(value).getTime() : 0;
    return Number.isNaN(t) ? 0 : t;
  };
  if (filterState.sort === 'date') {
    sorted.sort((a, b) => (dateValue(b.implementDate || b.publishDate) - dateValue(a.implementDate || a.publishDate)) || (resultRank(a) - resultRank(b)));
  } else if (filterState.sort === 'downloadable') {
    sorted.sort((a, b) => (Number(Boolean(b.previewAvailable)) - Number(Boolean(a.previewAvailable))) || sortByStatus(a, b));
  } else if (filterState.sort === 'sourceCount') {
    sorted.sort((a, b) => (((b.sources || [b._source]).length - (a.sources || [a._source]).length)) || sortByStatus(a, b));
  } else {
    sorted.sort(sortByStatus);
  }
  return sorted;
}

function renderFilterBar() {
  const bar = document.getElementById('filterBar');
  if (!results.length) { bar.classList.remove('visible'); bar.innerHTML = ''; return; }

  const srcCounts = {}; const statusCounts = {};
  let downloadableCount = 0; let qualifiedCount = 0; let savedCount = 0;
  for (const r of results) {
    for (const s of (r.sources || [r._source])) { srcCounts[s] = (srcCounts[s] || 0) + 1; }
    const baseCat = statusCategory(r.status, r.standardNumber);
    statusCounts[baseCat] = (statusCounts[baseCat] || 0) + 1;
    if (r.previewAvailable) downloadableCount++;
    if (hasQualificationBadge(r.standardNumber)) qualifiedCount++;
    if (isStandardSaved(r)) savedCount++;
  }

  const srcChips = [
    { key: '', label: '全部', count: results.length },
    ...['bz','gbw','by'].map(s => ({ key: s, label: srcLabel(s), count: srcCounts[s] || 0 }))
  ];
  const statusChips = [
    { key: '', label: '全部', count: results.length },
    { key: '现行', label: '现行', count: statusCounts['现行'] || 0 },
    { key: '废止', label: '废止', count: statusCounts['废止'] || 0 },
    { key: '即将实施', label: '即将实施', count: statusCounts['即将实施'] || 0 },
    { key: '其它', label: '其它', count: statusCounts['其它'] || 0 }
  ];

  function chipHtml(chips, set) {
    const allActive = set.size === 0;
    return chips.map(c => {
      const active = c.key === '' ? allActive : set.has(c.key);
      return `<span class="filter-chip${active ? ' active' : ''}" data-filter-type="${set === filterState.sources ? 'source' : 'status'}" data-filter-key="${escapeHtml(c.key)}">${escapeHtml(c.label)}<span class="chip-count">${c.count}</span></span>`;
    }).join('');
  }

  const quickTools = `
    <span class="filter-sep"></span>
    <button class="filter-chip filter-toggle${filterState.onlyDownloadable ? ' active' : ''}" data-filter-toggle="downloadable">可下载<span class="chip-count">${downloadableCount}</span></button>
    <button class="filter-chip filter-toggle${filterState.onlyQualified ? ' active' : ''}" data-filter-toggle="qualified">有资质<span class="chip-count">${qualifiedCount}</span></button>
    <button class="filter-chip filter-toggle${filterState.onlySaved ? ' active' : ''}" data-filter-toggle="saved">收藏<span class="chip-count">${savedCount}</span></button>
    <label class="filter-sort">
      <span>排序</span>
      <select id="resultSortSelect">
        <option value="smart" ${filterState.sort === 'smart' ? 'selected' : ''}>智能</option>
        <option value="downloadable" ${filterState.sort === 'downloadable' ? 'selected' : ''}>可下载优先</option>
        <option value="date" ${filterState.sort === 'date' ? 'selected' : ''}>日期最新</option>
        <option value="sourceCount" ${filterState.sort === 'sourceCount' ? 'selected' : ''}>来源最多</option>
      </select>
    </label>`;
  // 激活计数：非默认的筛选项个数（source/status 任一选中 + 三个 toggle 任一开 = 各算 1）
  // 用于折叠按钮上的徽章，让用户知道折叠态下有几条筛选生效
  const activeCount =
    (filterState.sources.size > 0 ? 1 : 0) +
    (filterState.statuses.size > 0 ? 1 : 0) +
    (filterState.onlyDownloadable ? 1 : 0) +
    (filterState.onlyQualified ? 1 : 0) +
    (filterState.onlySaved ? 1 : 0);
  const collapseBtn = `<button class="filter-collapse${activeCount ? ' has-active' : ''}" type="button" data-filter-collapse aria-expanded="false">
    <span class="filter-collapse-label">筛选</span>
    ${activeCount ? `<span class="filter-collapse-count">${activeCount}</span>` : ''}
    <span class="filter-collapse-caret" aria-hidden="true">▾</span>
  </button>`;
  const bodyHtml = chipHtml(srcChips, filterState.sources) + '<span class="filter-sep"></span>' + chipHtml(statusChips, filterState.statuses) + quickTools;
  bar.innerHTML = collapseBtn + `<div class="filter-bar-body">${bodyHtml}</div>`;
  bar.classList.add('visible');
}

// ── Render cards ──
// Progressive rendering: first batch is cheap (100 rows), then either user
// clicks "show all" or scrolls past the sentinel which triggers the next batch.
const RESULTS_FIRST_BATCH = 100;
const RESULTS_NEXT_BATCH = 200;
let _resultsRenderedCount = 0;
let _resultsLastFilteredCache = null;

// 本地库命中缓存：搜索完成后批量查一次 /api/preview/library-check，
// 这里只缓存 resultId → fileId。绿点 + Phase 2 的"秒开"路径都靠它判定。
// 每次 doSearch 开头会被清掉；之后无论怎么过滤排序 renderResults，都按缓存重涂。
let _libraryFileIds = new Map();
let _libraryCheckAbort = null;

function extractYearFromStdNumber(sn) {
  if (!sn) return null;
  const m = /-\s*(\d{4})\s*$/.exec(String(sn));
  return m ? m[1] : null;
}

// 后端 zod 限定 items.max(500)。多源合并后 results > 500 时整包提交会 400 → 绿点全瞎。
// 切 chunk 是前端响应；放宽后端上限会让单条 SQL IN(?,?,...) 参数过多（better-sqlite3
// 有 SQLITE_MAX_VARIABLE_NUMBER 默认 32766）。两边约束都要尊重，切片是正确做法。
const LIBRARY_CHECK_CHUNK = 400;

/**
 * 批量查本地库命中并缓存。
 * results > 400 时切片并发查询，结果合并写入 _libraryFileIds。
 * 失败静默 —— 绿点是 nice-to-have，搜索结果本身不依赖。
 */
async function fetchLibraryAvailability(rs) {
  if (!rs || !rs.length) return;
  if (_libraryCheckAbort) { try { _libraryCheckAbort.abort(); } catch {} }
  const ctrl = new AbortController();
  _libraryCheckAbort = ctrl;
  // 同时建 items + 对应的 result（保留 r.id 对齐，跳过空 standardNumber）
  const queryUnits = [];
  for (const r of rs) {
    if (!r.standardNumber) continue;
    queryUnits.push({
      result: r,
      item: {
        stdCode: r.standardNumber,
        year: extractYearFromStdNumber(r.standardNumber) || undefined,
      },
    });
  }
  if (!queryUnits.length) return;

  // 切 chunk 并发查询。任一 chunk 失败不影响其他 chunk 的结果。
  const chunks = [];
  for (let i = 0; i < queryUnits.length; i += LIBRARY_CHECK_CHUNK) {
    chunks.push(queryUnits.slice(i, i + LIBRARY_CHECK_CHUNK));
  }

  await Promise.all(chunks.map(async (chunk) => {
    try {
      const res = await fetch(`${API}/api/preview/library-check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: chunk.map(u => u.item) }),
        signal: ctrl.signal,
      });
      const data = await readApiResponse(res);
      const fileIds = (data && data.fileIds) || [];
      for (let k = 0; k < chunk.length; k++) {
        const fid = fileIds[k];
        if (fid) _libraryFileIds.set(chunk[k].result.id, fid);
      }
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      // 单 chunk 失败静默；其他 chunk 仍能给用户绘上绿点
    }
  }));

  if (!ctrl.signal.aborted) applyLibraryDots();
}

/**
 * 把缓存的命中状态涂到当前 DOM 上。
 * 每次 renderResults / appendNextResultsBatch 调一次，便于刷新过滤后新出现的行。
 * 命中：按钮加 .dot-local + data-file-id；未命中：移除（防 stale）。
 *
 * 同时复审"预览"按钮的 disabled 态:本地有缓存 → 必可点;否则按 isPreviewable
 * 严格判定(无可下载源 + 无本地 → 真没可看的)。library-check 增量到达后会再调一次,
 * 让"刚发现本地命中"的卡按钮从 disabled 翻成可点。
 */
function applyLibraryDots() {
  document.querySelectorAll('#results [data-action="preview"][data-id]').forEach(btn => {
    const id = btn.getAttribute('data-id');
    const fid = _libraryFileIds.get(id);
    if (fid) {
      btn.classList.add('dot-local');
      btn.setAttribute('data-file-id', String(fid));
      btn.setAttribute('title', '本地已有，秒开');
      btn.disabled = false;
    } else {
      btn.classList.remove('dot-local');
      btn.removeAttribute('data-file-id');
      btn.setAttribute('title', '本地预览（已下载的标准）');
      // 没本地命中 → 按"能不能下"判定。findResultByAnyId 拿不到时保守不动 disabled。
      try {
        const r = typeof findResultByAnyId === 'function' ? findResultByAnyId(id) : null;
        if (r) btn.disabled = !isPreviewable(r, false);
      } catch { /* ignore */ }
    }
  });
}

function resolveTextState(r) {
  // 废止 standards never have preview text — final state, no checking
  if (r.status && r.status.includes('废止')) return 'no_text';
  // Already confirmed has text (from any source) → final
  if (r.previewAvailable) return 'text';
  // gbw uses optimistic false until poll resolves — show checking spinner
  const sources = r.sources || (r._source ? [r._source] : []);
  if (sources.includes('gbw') && !r._gbwTextChecked) return 'checking';
  return 'no_text';
}

/**
 * 下载按钮是否允许点击。与 resolveTextState 解耦:
 *   - textBadge 显示「有文本/无文本/检测中」是 UI 信号(信息),用 resolveTextState
 *   - 下载按钮是行动入口,应该「能试就让试」 — 用本函数
 *
 * 放宽逻辑(对比旧 `hasText`):
 *   - 废止 → 不能下(终态)
 *   - 无任何源 → 不能下
 *   - 任一源 previewAvailable=true → 能下(原 hasText 同款)
 *   - gbw 在 sources 且还没轮询完 → 能下(optimistic,让用户试,级联会逐源尝试)
 *   - 其它(所有源已确认无文本) → 不能下
 *
 * 级联下载本身按 downloadPriority 顺序逐源尝试,一源失败自动跳下一个,
 * 全部失败才报 toast。所以"无文本但用户想试"的场景不会真坑用户。
 */
function isDownloadable(r) {
  if (r.status && r.status.includes('废止')) return false;
  const sources = r.sources || (r._source ? [r._source] : []);
  if (!sources.length) return false;
  if (r.previewAvailable) return true;
  if (sources.includes('gbw') && !r._gbwTextChecked) return true;
  return false;
}

/**
 * 预览按钮是否允许点击:
 *   - 本地有缓存(_libraryFileIds 命中)→ 必可点(秒开)
 *   - 否则按"能不能下"判定 — 能下就能拉文本预览;不能下也没本地 → disabled
 *
 * checkLocal 参数:为了让"首次渲染时按已知 _libraryFileIds 状态判定"和"DOM 已存在
 * 后 applyLibraryDots 再调一次"两条路径都能复用本函数。默认 true,buildResultCardHtml
 * 渲染时传 true 让首屏即时反映已知本地命中;applyLibraryDots 内部已经先按 fid 单独处理过了
 * 本地命中分支,这里传 false 让函数只判"非本地命中下能不能预览"。
 */
function isPreviewable(r, checkLocal = true) {
  if (checkLocal && _libraryFileIds && _libraryFileIds.get && _libraryFileIds.get(r.id)) return true;
  return isDownloadable(r);
}

function getStandardShareUrl(standardNumber) {
  const url = new URL(window.location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('tab', 'search');
  url.searchParams.set('q', standardNumber || '');
  return url.toString();
}

async function shareStandardResult(id) {
  const result = results.find(item => item.id === id);
  if (!result) return;

  const standardNumber = result.standardNumber || '';
  const title = result.title || '';
  const url = getStandardShareUrl(standardNumber);
  const shareTitle = standardNumber ? `${standardNumber} ${title}`.trim() : '标准检索';

  if (window.isMobile && window.isMobile() && navigator.share) {
    try {
      await navigator.share({ title: shareTitle, text: shareTitle, url });
      return;
    } catch (err) {
      if (err && err.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(url);
  } catch {
    const input = document.createElement('textarea');
    input.value = url;
    input.setAttribute('readonly', '');
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand('copy');
    input.remove();
    if (!copied) {
      showToast('复制链接失败，请手动复制地址栏');
      return;
    }
  }

  showToast('检索链接已复制');
}

function buildResultCardHtml(r, i) {
  const srcBadges = (r.sources || [r._source]).map(s => `<span class="source-badge source-${escapeHtml(String(s))}">${escapeHtml(srcLabel(String(s)))}</span>`).join(' ');
  const sCls = statusClass(r.status);
  const textState = resolveTextState(r);
  const hasText = textState === 'text';
  const isChecking = textState === 'checking';
  const saved = isStandardSaved(r);
  const statusBadge = r.status ? `<span class="status-indicator ${sCls}"><span class="dot"></span>${escapeHtml(r.status)}</span>` : '';
  const textBadge = isChecking
    ? '<span class="text-badge-checking"><span class="text-badge-dot"></span>检测中</span>'
    : (hasText ? '<span class="has-text-badge">有文本</span>' : '<span class="no-text-badge">无文本</span>');
  return `
    <div class="result-card card-enter${hasText ? '' : (isChecking ? ' checking-text' : ' no-text')}${saved ? ' saved' : ''}" data-sid="${escapeHtml(r.id)}">
      <div class="check-col"><input type="checkbox" data-idx="${i}" ${selectedIds.has(r.id) ? 'checked' : ''}></div>
      <div class="card-id">
        <!-- .card-number-row:标准号 + 资质徽章紧贴 (核心标识行)。
             桌面端 inline-flex 一行;手机端 wrap 时徽章跟在标准号后,不与标题挤. -->
        <div class="card-number-row">
          <span class="card-number">${escapeHtml(r.standardNumber)}</span>
          ${qualBadgeHtml(r.standardNumber)}
          ${typeof capLibBadgeHtml === 'function' ? capLibBadgeHtml(r.standardNumber) : ''}
        </div>
      </div>
      <div class="card-body">
        <div class="card-title-row">
          <span class="card-title">${escapeHtml(r.title || '—')}</span>
        </div>
        ${r.standardType ? `<div class="card-subtitle">${escapeHtml(r.standardType)}</div>` : ''}
      </div>
      <div class="card-state">
        ${statusBadge || '<span class="card-muted">—</span>'}
        ${textBadge}
      </div>
      <div class="card-source-line">${srcBadges}</div>
      <!-- 手机端合并行:桌面 display:none,手机显示,把 state / source 用 · 分隔显示。
           资质徽章已搬到 .card-number-row,这里不再渲. -->
      <div class="card-meta-line">
        ${statusBadge || ''}
        ${textBadge}
        ${srcBadges}
        ${r.publishDate ? `<span class="meta-date">${escapeHtml(r.publishDate)}</span>` : ''}
      </div>
      <div class="card-date">
        <span><b>发布</b>${r.publishDate || '—'}</span>
        <span><b>实施</b>${r.implementDate || '—'}</span>
      </div>
      <div class="card-actions">
        <button data-action="save" data-id="${escapeHtml(r.id)}" class="${saved ? 'saved' : ''}" title="${saved ? '取消收藏' : '收藏'}">${saved ? '已存' : '收藏'}</button>
        <button data-action="share" data-id="${escapeHtml(r.id)}" title="分享检索链接">分享</button>
        <button data-action="detail" data-id="${escapeHtml(r.id)}">详情</button>
        <button data-action="preview" data-id="${escapeHtml(r.id)}" title="本地预览（已下载的标准）" ${isPreviewable(r) ? '' : 'disabled'}>预览</button>
        <button data-action="download" data-id="${escapeHtml(r.id)}" ${isDownloadable(r) ? '' : 'disabled'}>下载</button>
      </div>
    </div>`;
}

const _collapsedGroupsKey = 'bzxz_collapsed_status_groups_v3';
let _collapsedGroups = new Set(safeJsonParse(localStorage.getItem(_collapsedGroupsKey), ['废止']));
function _persistCollapsedGroups() {
  try { localStorage.setItem(_collapsedGroupsKey, JSON.stringify([..._collapsedGroups])); } catch {}
}

const STATUS_GROUP_ORDER = [
  '现行', '即将实施', '其它', '废止',
];

function renderResults() {
  const filtered = getFilteredResults();
  const idxMap = new Map(results.map((r, i) => [r.id, i]));
  _resultsLastFilteredCache = filtered;
  _resultsRenderedCount = Math.min(RESULTS_FIRST_BATCH, filtered.length);

  const header = filtered.length ? `
    <div class="results-table-head">
      <span></span>
      <span>标准号</span>
      <span>标准名称</span>
      <span>状态</span>
      <span>来源</span>
      <span>日期</span>
      <span>操作</span>
    </div>` : '';

  // Group by status category when at least 2 categories present and we have >5 results.
  const visibleBatch = filtered.slice(0, _resultsRenderedCount);
  const catCounts = {};
  for (const r of filtered) { const c = statusCategory(r.status, r.standardNumber); catCounts[c] = (catCounts[c] || 0) + 1; }
  const usedCats = Object.keys(catCounts);
  const useGrouping = usedCats.length >= 2 && filtered.length > 5;

  let bodyHtml = '';
  if (useGrouping) {
    // Group first-batch rows by status category, then render in canonical order
    const groups = {};
    for (const r of visibleBatch) {
      const c = statusCategory(r.status, r.standardNumber);
      (groups[c] = groups[c] || []).push(r);
    }
    for (const cat of STATUS_GROUP_ORDER) {
      const rows = groups[cat];
      const total = catCounts[cat] || 0;
      if (!total) continue;
      const collapsed = _collapsedGroups.has(cat);
      const rendered = rows ? rows.length : 0;
      // CSS class 按"基础状态"映射(忽略资质前缀),颜色按状态走,资质前缀通过组名表达
      const baseStatus = cat;
      const statusCls = baseStatus === '现行' ? 'current'
        : baseStatus === '即将实施' ? 'upcoming'
        : baseStatus === '废止' ? 'expired'
        : 'other';
      const groupCls = `status-group status-group-${statusCls}${collapsed ? ' collapsed' : ''}`;
      bodyHtml += `<div class="${groupCls}" data-group-cat="${escapeHtml(cat)}">
        <div class="status-group-header" data-group-toggle="${escapeHtml(cat)}">
          <span class="status-group-caret">▾</span>
          <span class="status-group-name">${escapeHtml(cat)}</span>
          <span class="status-group-count">${rendered}${rendered < total ? ` / ${total}` : ''}</span>
        </div>
        <div class="status-group-body">${
          rows ? rows.map(r => buildResultCardHtml(r, idxMap.get(r.id))).join('') : ''
        }</div>
      </div>`;
    }
  } else {
    bodyHtml = visibleBatch.map(r => buildResultCardHtml(r, idxMap.get(r.id))).join('');
  }

  const moreHtml = filtered.length > _resultsRenderedCount
    ? `<div id="resultsMore" class="results-more"><button class="btn btn-ghost btn-sm" id="resultsLoadMoreBtn">显示更多（还剩 ${filtered.length - _resultsRenderedCount} 条）</button></div>`
    : '';
  document.getElementById('results').innerHTML = header + bodyHtml + moreHtml;
  // Wire status group toggles
  document.querySelectorAll('[data-group-toggle]').forEach(h => {
    h.addEventListener('click', () => {
      const cat = h.dataset.groupToggle;
      const group = h.closest('.status-group');
      if (_collapsedGroups.has(cat)) { _collapsedGroups.delete(cat); group.classList.remove('collapsed'); }
      else { _collapsedGroups.add(cat); group.classList.add('collapsed'); }
      _persistCollapsedGroups();
    });
  });
  document.querySelectorAll('input[data-idx]').forEach(cb => {
    cb.addEventListener('change', () => {
      const idx = parseInt(cb.dataset.idx);
      const r = results[idx];
      if (!r) return;
      cb.checked ? selectedIds.add(r.id) : selectedIds.delete(r.id);
      updateToolbar();
    });
  });
  const moreBtn = document.getElementById('resultsLoadMoreBtn');
  if (moreBtn) moreBtn.addEventListener('click', appendNextResultsBatch);
  applyLibraryDots();
}

function appendNextResultsBatch() {
  const filtered = _resultsLastFilteredCache;
  if (!filtered) return;
  const idxMap = new Map(results.map((r, i) => [r.id, i]));
  const end = Math.min(_resultsRenderedCount + RESULTS_NEXT_BATCH, filtered.length);
  const slice = filtered.slice(_resultsRenderedCount, end);
  const moreEl = document.getElementById('resultsMore');
  const grouped = !!document.querySelector('.status-group');
  if (grouped) {
    // Distribute new rows into their status-group bodies (already exist from initial render)
    for (const r of slice) {
      const cat = statusCategory(r.status, r.standardNumber);
      const body = document.querySelector(`.status-group[data-group-cat="${CSS.escape(cat)}"] .status-group-body`);
      const html = buildResultCardHtml(r, idxMap.get(r.id));
      if (body) body.insertAdjacentHTML('beforeend', html);
      else if (moreEl) moreEl.insertAdjacentHTML('beforebegin', html); // fallback
    }
    // Refresh group counts
    const catCounts = {};
    for (const r of filtered.slice(0, end)) { const c = statusCategory(r.status, r.standardNumber); catCounts[c] = (catCounts[c] || 0) + 1; }
    document.querySelectorAll('.status-group').forEach(g => {
      const cat = g.dataset.groupCat;
      const total = filtered.reduce((acc, r) => acc + (statusCategory(r.status, r.standardNumber) === cat ? 1 : 0), 0);
      const rendered = catCounts[cat] || 0;
      const cnt = g.querySelector('.status-group-count');
      if (cnt) cnt.textContent = rendered < total ? `${rendered} / ${total}` : `${rendered}`;
    });
  } else {
    const html = slice.map(r => buildResultCardHtml(r, idxMap.get(r.id))).join('');
    if (moreEl) moreEl.insertAdjacentHTML('beforebegin', html);
  }
  // Re-bind checkboxes for newly inserted rows
  document.querySelectorAll('input[data-idx]:not([data-bound])').forEach(cb => {
    cb.setAttribute('data-bound', '1');
    cb.addEventListener('change', () => {
      const idx = parseInt(cb.dataset.idx);
      const r = results[idx];
      if (!r) return;
      cb.checked ? selectedIds.add(r.id) : selectedIds.delete(r.id);
      updateToolbar();
    });
  });
  _resultsRenderedCount = end;
  if (_resultsRenderedCount >= filtered.length) {
    if (moreEl) moreEl.remove();
  } else if (moreEl) {
    const remaining = filtered.length - _resultsRenderedCount;
    moreEl.querySelector('button').textContent = `显示更多（还剩 ${remaining} 条）`;
  }
  applyLibraryDots();
}

// Filter bar chip clicks
document.getElementById('filterBar').addEventListener('click', e => {
  // 手机端折叠按钮：切 .open 让 .filter-bar-body 显隐；桌面端按钮 CSS display:none 永远不触发
  const collapseBtn = e.target.closest('[data-filter-collapse]');
  if (collapseBtn) {
    const bar = document.getElementById('filterBar');
    const open = bar.classList.toggle('open');
    collapseBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
    return;
  }
  const toggle = e.target.closest('[data-filter-toggle]');
  if (toggle) {
    if (toggle.dataset.filterToggle === 'downloadable') filterState.onlyDownloadable = !filterState.onlyDownloadable;
    if (toggle.dataset.filterToggle === 'qualified') filterState.onlyQualified = !filterState.onlyQualified;
    if (toggle.dataset.filterToggle === 'saved') filterState.onlySaved = !filterState.onlySaved;
    renderFilterBar(); renderResults(); updateToolbar();
    return;
  }
  const chip = e.target.closest('.filter-chip');
  if (!chip) return;
  const type = chip.dataset.filterType;
  const key = chip.dataset.filterKey;
  const set = type === 'source' ? filterState.sources : filterState.statuses;
  if (key === '') { set.clear(); }
  else if (set.has(key)) { set.delete(key); }
  else { set.add(key); }
  renderFilterBar(); renderResults(); updateToolbar();
});

document.getElementById('filterBar').addEventListener('change', e => {
  if (e.target.id !== 'resultSortSelect') return;
  filterState.sort = e.target.value;
  renderFilterBar(); renderResults(); updateToolbar();
});

// Delegated event handler for result card buttons
document.getElementById('results').addEventListener('click', e => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = btn.dataset.id;
  if (btn.dataset.action === 'detail') showDetail(id);
  else if (btn.dataset.action === 'download') downloadOne(id, btn);
  else if (btn.dataset.action === 'preview') previewStandard(id);
  else if (btn.dataset.action === 'save') toggleSavedStandard(id);
  else if (btn.dataset.action === 'share') shareStandardResult(id);
});
