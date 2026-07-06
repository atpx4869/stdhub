// ── Search mode switcher (标准检索 / Labr 补给) ──
function switchSearchMode(mode) {
  document.querySelectorAll('.search-mode-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.search-mode-tab[onclick*="${mode}"]`)?.classList.add('active');
  document.getElementById('searchModeStd').style.display = mode === 'std' ? '' : 'none';
  document.getElementById('searchModeLabr').style.display = mode === 'labr' ? '' : 'none';
  // 切回标准检索时恢复搜索框焦点
  if (mode === 'std') {
    const input = document.getElementById('searchInput');
    if (input && !input.value) input.focus();
  }
  if (mode === 'labr') {
    const input = document.getElementById('labrSearchInput');
    if (input && !input.value) input.focus();
  }
}
window.switchSearchMode = switchSearchMode;

// ── Search status indicator ──
const _searchStatusEl = document.createElement('div');
_searchStatusEl.id = 'searchStatus';
_searchStatusEl.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:400;display:none;align-items:center;gap:8px;padding:10px 18px;border-radius:8px;background:oklch(20% 0.016 255 / 0.92);backdrop-filter:blur(12px);border:1px solid var(--border);box-shadow:0 8px 32px rgba(0,0,0,0.4);font-size:13px;font-weight:500;color:var(--text);transition:opacity 0.25s;pointer-events:none;';
document.body.appendChild(_searchStatusEl);
function showSearchStatus(msg, spinning) {
  _searchStatusEl.innerHTML = (spinning ? '<span class="spinner" style="width:14px;height:14px;border-width:2px"></span>' : '') + `<span>${escapeHtml(msg)}</span>`;
  _searchStatusEl.style.display = 'flex';
  _searchStatusEl.style.opacity = '1';
}
function hideSearchStatus() {
  _searchStatusEl.style.opacity = '0';
  setTimeout(() => { _searchStatusEl.style.display = 'none'; }, 300);
}

let _resultsRenderFrame = 0;
let _scheduledFilterBar = false;
let _scheduledToolbar = false;
let _searchRankSeq = 0;
let _searchRankByKey = new Map();
function scheduleResultsRender(options = {}) {
  _scheduledFilterBar = _scheduledFilterBar || !!options.filterBar;
  _scheduledToolbar = _scheduledToolbar || !!options.toolbar;
  if (_resultsRenderFrame) return;
  _resultsRenderFrame = requestAnimationFrame(() => {
    _resultsRenderFrame = 0;
    const shouldRenderFilterBar = _scheduledFilterBar;
    const shouldUpdateToolbar = _scheduledToolbar;
    _scheduledFilterBar = false;
    _scheduledToolbar = false;
    if (shouldRenderFilterBar) renderFilterBar();
    renderResults();
    if (shouldUpdateToolbar) updateToolbar();
  });
}

// ── Source tag init ──
document.querySelectorAll('.source-tag').forEach(tag => {
  const src = tag.dataset.source;
  if (selectedSources.has(src)) tag.classList.add('active'); else tag.classList.remove('active');
  tag.addEventListener('click', () => {
    if (selectedSources.has(src)) { selectedSources.delete(src); tag.classList.remove('active'); }
    else { selectedSources.add(src); tag.classList.add('active'); }
  });
});

// ── GBW text availability polling ──
let _gbwTextPollTimer = null;
let _gbwTextPollAbort = false;
function stopGbwTextPoll() {
  if (_gbwTextPollTimer) { clearTimeout(_gbwTextPollTimer); _gbwTextPollTimer = null; }
  _gbwTextPollAbort = true;
}
(window._tabCleanup = window._tabCleanup || {}).gbwTextPoll = stopGbwTextPoll;
function pollGbwTextAvailability() {
  if (_gbwTextPollTimer) return;
  _gbwTextPollAbort = false;
  const gbwIds = results.filter(r => r._source === 'gbw' || (r._sourceIds && r._sourceIds.gbw)).map(r => r._sourceIds?.gbw || r.sourceId).filter(Boolean);
  if (!gbwIds.length) return;
  let emptyPolls = 0;
  const poll = async () => {
    if (_gbwTextPollAbort) return;
    try {
      const resp = await fetch(`/api/standards/text-availability?ids=${gbwIds.join(',')}`);
      const data = await readApiResponse(resp);
      let updated = false;
      for (const r of results) {
        const gbwId = r._sourceIds?.gbw || (r._source === 'gbw' ? r.sourceId : null);
        if (gbwId && data[gbwId] !== undefined) {
          const newVal = data[gbwId];
          // Mark gbw as checked so the tri-state badge can transition out of 'checking'
          if (!r._gbwTextChecked) { r._gbwTextChecked = true; updated = true; }
          if (r._source === 'gbw') {
            if (r.previewAvailable !== newVal) { r.previewAvailable = newVal; updated = true; }
          }
          if (r._previewAvailableBySource && r._previewAvailableBySource.gbw !== undefined) {
            r._previewAvailableBySource.gbw = newVal;
            r.previewAvailable = Object.values(r._previewAvailableBySource).some(Boolean);
            updated = true;
          }
        }
      }
      if (updated) scheduleResultsRender();
      const hasAnyData = Object.keys(data).length > 0;
      const allChecked = hasAnyData && gbwIds.every(id => data[id] !== undefined);
      if (allChecked) {
        _gbwTextPollTimer = null;
        // 静默结束：每张卡片的「检测中」徽章已自然过渡到「有文本/无文本」
        return;
      }
      if (!hasAnyData) {
        emptyPolls++;
        if (emptyPolls >= 20) {
          _gbwTextPollTimer = null;
          // Mark all gbw rows as checked so the checking spinner stops
          let anyMark = false;
          for (const r of results) {
            const gbwId = r._sourceIds?.gbw || (r._source === 'gbw' ? r.sourceId : null);
            if (gbwId && !r._gbwTextChecked) { r._gbwTextChecked = true; anyMark = true; }
          }
          if (anyMark) scheduleResultsRender();
          // 静默结束：未拿到结果的卡片已被标记为 _gbwTextChecked，徽章会落到「无文本」
          return;
        }
      } else {
        emptyPolls = 0;
      }
      // New data arrived → poll again quickly; no change → back off
      _gbwTextPollTimer = setTimeout(poll, updated ? 500 : 2000);
    } catch {
      _gbwTextPollTimer = setTimeout(poll, 2000);
    }
  };
  // 首次 poll 几乎立即发起，让缓存命中场景"瞬时"返回；之前 2s 的等待是历史保守值
  _gbwTextPollTimer = setTimeout(poll, 300);
}

// ── Per-source progress strip ──
function renderSourceProgressStrip(states) {
  const strip = document.getElementById('sourceProgressStrip');
  if (!strip) return;
  if (!states || Object.keys(states).length === 0) { strip.style.display = 'none'; strip.innerHTML = ''; return; }
  const order = ['bz', 'gbw', 'by'];
  const html = order.filter(s => states[s]).map(s => {
    const st = states[s];
    const cls = st.status; // 'loading' | 'ok' | 'fail'
    const icon = cls === 'loading' ? '<span class="src-prog-spin"></span>' : (cls === 'ok' ? '✓' : '✗');
    const num = cls === 'loading' ? '检索中' : (cls === 'ok' ? `${st.count} 条` : (st.error || '失败'));
    return `<span class="src-prog-chip src-prog-${cls} src-prog-${s}"><span class="src-prog-label">${escapeHtml(srcLabel(s))}</span><span class="src-prog-icon">${icon}</span><span class="src-prog-value">${escapeHtml(num)}</span></span>`;
  }).join('');
  strip.innerHTML = html;
  strip.style.display = html ? 'flex' : 'none';
}

// ── Search ──
async function doSearch() {
  if (searchAborted === 'cancelling') return; // already cancelling
  if (_gbwTextPollTimer) { clearTimeout(_gbwTextPollTimer); _gbwTextPollTimer = null; _gbwTextPollAbort = true; }
  const q = document.getElementById('searchInput').value.trim();
  if (!q) return;
  // 手机端 landing → active：搜索框 sticky 吸顶，结果区出现
  if (typeof setSearchStage === 'function') setSearchStage('search', 'active');
  document.getElementById('searchBtn').innerHTML = '<span class="spinner"></span><span class="search-btn-label">取消</span>';
  document.getElementById('searchBtn').disabled = false;
  results = []; selectedIds.clear(); updateToolbar(); searchAborted = false; qualData = {};
  _searchRankSeq = 0; _searchRankByKey = new Map();
  _libraryFileIds.clear();
  showSearchStatus('正在搜索...', true);
  // Initialize per-source progress chips
  const _sourceProgress = {};
  for (const s of selectedSources) _sourceProgress[s] = { status: 'loading', count: 0 };
  renderSourceProgressStrip(_sourceProgress);
  // Show skeleton — count proportional to selected sources, capped 6
  const _skeletonCount = Math.min(6, Math.max(4, selectedSources.size * 2));
  document.getElementById('results').innerHTML = Array.from({ length: _skeletonCount }, (_, i) =>
    `<div class="skeleton-card sk-row" style="animation-delay:${(i * 80).toFixed(0)}ms">
      <div class="sk-check skeleton-line"></div>
      <div class="sk-id"><div class="skeleton-line sk-num"></div></div>
      <div class="sk-body">
        <div class="skeleton-line sk-title"></div>
        <div class="skeleton-line sk-sub"></div>
      </div>
      <div class="sk-state">
        <div class="skeleton-line sk-status"></div>
        <div class="skeleton-line sk-text"></div>
      </div>
      <div class="sk-source"><div class="skeleton-line sk-src"></div></div>
      <div class="sk-date"><div class="skeleton-line sk-d1"></div><div class="skeleton-line sk-d2"></div></div>
      <div class="sk-actions"><div class="skeleton-line sk-btn"></div><div class="skeleton-line sk-btn"></div><div class="skeleton-line sk-btn"></div></div>
    </div>`
  ).join('');
  document.getElementById('toolbar').style.display = 'none';
  saveSearchHistory(q);

  const sources = [...selectedSources];
  const promises = sources.map(src => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 6000);
    return fetch(`${API}/api/standards/search?q=${encodeURIComponent(q)}&source=${src}`, { signal: ctrl.signal })
      .then(r => readApiResponse(r)).then(data => ({ ok: true, src, items: (data.items || []).map(i => ({ ...i, _source: src })) }))
      .catch(e => ({ ok: false, src, error: e.name === 'AbortError' ? '超时' : e.message }))
      .finally(() => clearTimeout(timer));
  });

  let receivedCount = 0; const receivedResults = [];
  for (const p of promises) {
    const outcome = await p; receivedCount++;
    if (searchAborted) break;
    if (outcome.ok) {
      receivedResults.push(...outcome.items);
      addLog(`搜索 ${outcome.src}(${q}) 完成 (+${outcome.items.length} 条)`, 'success');
      _sourceProgress[outcome.src] = { status: 'ok', count: outcome.items.length };
    } else {
      addLog(`搜索 ${outcome.src}(${q}) 失败: ${outcome.error}`, 'fail');
      _sourceProgress[outcome.src] = { status: 'fail', count: 0, error: outcome.error };
    }
    renderSourceProgressStrip(_sourceProgress);
    showSearchStatus(`搜索中 ${receivedCount}/${sources.length} 源...`, true);
    results = dedupeResults(receivedResults); results.sort(sortByStatus);
    document.getElementById('summary').innerHTML = `<span class="count-anim">找到 ${results.length} 条结果 (${receivedCount}/${sources.length} 源)</span>`;
    document.getElementById('toolbar').style.display = results.length > 0 ? 'flex' : 'none';
    if (results.length > 0) scheduleResultsRender({ toolbar: true });
    else updateToolbar();
    // 每个源返回都增量拉徽章 —— fetchQualBadges 内部按 stdCode 去重,只查新增的。
    // 不能等"第一个源返回"就锁死(qualFetched 旧逻辑的坑):某些源返回慢、结果集差异大,
    // 后到的结果(如 BZ 截断 size=20 漏掉、但 GBW/BY 返回的 stdCode)会拿不到徽章。
    if (results.length > 0) {
      const stdNums = results.map(r => r.standardNumber).filter(Boolean);
      // 徽章到达后只更新视觉与筛选计数，不改变默认排序/分组，避免卡片跳动。
      fetchQualBadges(stdNums).then(() => {
        if (results.length > 0) scheduleResultsRender({ filterBar: true });
      });
      // 同步触发一单一库徽章拉取（与 qual 徽章并行；occupant 已在 renderResults
      // 渲染时给出占位 .cap-lib-badge-pending，回调里 DOM 直接替换不重渲）
      if (typeof fetchCapLibBadges === 'function') {
        fetchCapLibBadges(stdNums).catch(() => { /* silent */ });
      }
    }
    // Poll GBW text availability in background (non-blocking)
    pollGbwTextAvailability();
  }
  if (searchAborted) {
    addLog('搜索已取消', 'fail');
    document.getElementById('summary').innerHTML = `<span class="count-anim">已取消 (${results.length} 条结果)</span>`;
    hideSearchStatus();
  }
  document.getElementById('searchBtn').innerHTML = '<span class="search-btn-icon" aria-hidden="true">🔍</span><span class="search-btn-label">搜索</span>'; document.getElementById('searchBtn').disabled = false;
  if (results.length > 0 && !searchAborted) {
    // 文本检测进度由每张卡片右侧的「检测中」徽章承担，底部 toast 不再常驻
    showSearchStatus(`搜索完成 (${results.length}条)`, false);
    setTimeout(hideSearchStatus, 1800);
  } else {
    hideSearchStatus();
  }
  // Final poll for GBW text availability
  pollGbwTextAvailability();
  // 后台批量查本地库命中（非阻塞 / 失败静默）：填 _libraryFileIds + 涂绿点
  if (results.length > 0) fetchLibraryAvailability(results);
  filterState.sources.clear(); filterState.statuses.clear();
  filterState.onlyDownloadable = false; filterState.onlyQualified = false; filterState.onlySaved = false; filterState.sort = 'smart';
  renderFilterBar();
  if (results.length === 0 && !searchAborted) {
    document.getElementById('results').innerHTML = `<div class="empty"><p>—</p><p>未找到相关标准</p><p style="font-size:13px;color:var(--text-3)">尝试更换关键词或数据源</p></div>`;
    document.getElementById('toolbar').style.display = 'none';
  }
}

function dedupeResults(items) {
  const map = new Map();
  for (const item of items) {
    const rawKey = item.standardNumber || item.title || '';
    const key = rawKey.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    if (!key) continue; // 跳过无标准号且无标题的条目
    if (!_searchRankByKey.has(key)) _searchRankByKey.set(key, _searchRankSeq++);
    if (map.has(key)) {
      const existing = map.get(key);
      if (!existing.sources.includes(item._source)) { existing.sources.push(item._source); existing._multiSource = existing.sources.join('+'); }
      if (!existing.title && item.title) existing.title = item.title;
      if (!existing.publishDate && item.publishDate) existing.publishDate = item.publishDate;
      if (!existing.implementDate && item.implementDate) existing.implementDate = item.implementDate;
      existing._sourceIds = existing._sourceIds || {};
      existing._sourceIds[item._source] = item.id;
      existing._previewAvailableBySource = existing._previewAvailableBySource || {};
      existing._previewAvailableBySource[item._source] = Boolean(item.previewAvailable);
      existing.previewAvailable = Boolean(existing.previewAvailable || item.previewAvailable);
    } else {
      map.set(key, {
        ...item,
        _searchRank: _searchRankByKey.get(key),
        previewAvailable: Boolean(item.previewAvailable),
        sources: [item._source],
        _multiSource: item._source,
        _sourceIds: { [item._source]: item.id },
        _previewAvailableBySource: { [item._source]: Boolean(item.previewAvailable) },
      });
    }
  }
  return [...map.values()];
}

function sortByStatus(a, b) {
  const pa = statusPriority(a.status), pb = statusPriority(b.status);
  if (pa !== pb) return pa - pb;
  if (a.previewAvailable !== b.previewAvailable) return a.previewAvailable ? -1 : 1;
  return resultRank(a) - resultRank(b);
}
function statusPriority(s) {
  if (!s) return 3; if (s.includes('现行')) return 0; if (s.includes('即将实施')) return 1; if (s.includes('废止')) return 4; return 2;
}
function resultRank(r) {
  return Number.isFinite(r?._searchRank) ? r._searchRank : 0;
}

document.getElementById('searchInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') { hideSearchHistory(); doSearch(); }
  if (e.key === 'Escape') hideSearchHistory();
});
document.getElementById('searchInput').addEventListener('input', () => {
  const q = document.getElementById('searchInput').value.trim().toLowerCase();
  if (!q) { renderSearchHistory(); return; }
  const hist = loadSearchHistory().filter(h => h.toLowerCase().includes(q)).slice(0, 5);
  const el = document.getElementById('searchHistory');
  if (!hist.length) { el.classList.remove('open'); return; }
  el.innerHTML = hist.map(h => `<div class="search-history-item" data-query="${escapeHtml(h)}"><span class="hist-icon">🕐</span><span class="hist-query">${escapeHtml(h)}</span></div>`).join('');
  el.classList.add('open');
});
document.getElementById('searchBtn').addEventListener('click', () => {
  const btn = document.getElementById('searchBtn');
  if (btn.textContent.includes('取消')) {
    searchAborted = true;
    return;
  }
  doSearch();
});

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
        <button data-action="detail" data-id="${escapeHtml(r.id)}">详情</button>
        <button data-action="preview" data-id="${escapeHtml(r.id)}" title="本地预览（已下载的标准）" ${isPreviewable(r) ? '' : 'disabled'}>预览</button>
        <button data-action="download" data-id="${escapeHtml(r.id)}" ${isDownloadable(r) ? '' : 'disabled'}>下载</button>
      </div>
    </div>`;
}

// Status group collapse state — persisted. v3 回到纯状态分组，避免异步徽章回流触发跳组。
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
});

// ── PDF 预览（Phase 2 + Phase 3 polish）──
// 流程：POST /api/preview/request →
//   ready       → iframe 加载 /api/preview/file/:id
//   downloading → 后端已起任务，前端 poll /api/preview/task/:id 直到 ready / failed
//                 → ready 切 iframe；failed 提示用户、给「重试」按钮
//
// Phase 3 调整：
// - 后端无 deadline，前端只在 ready / failed / 用户主动关闭时停 poll
// - 失败 UI 加「重试」按钮，触发新的 /api/preview/request（后端按 stdCode+year 去重，
//   若旁路还有 pending/downloading 任务会复用；否则起新任务）
let _previewCurrent = null; // { fileId, url, fileName }
// 仅服务 overlay 模式的 pollPreviewTask；closePreviewOverlay 会 abort 它。
// Popup 模式（pollPreviewTaskForPopup）每个 popup 用自己的局部 AbortController，
// 不共享这个全局变量 —— 避免连续点 A→B 时把 A 的 poll 误杀。
let _previewPollAbort = null;
let _previewLastId = null;   // 缓存最近一次预览的结果 id，用于失败重试

async function pollPreviewTask(taskId, stdCode) {
  // 用 AbortController 让"关闭预览 / 重试"能立刻停掉旧 poll。
  const ctrl = new AbortController();
  _previewPollAbort = ctrl;
  let attempt = 0;
  // 无 deadline：只在 ready / failed / abort 时返回。
  // 后端 preview-task-store 有 10 分钟无更新的 TTL 兜底，最坏情况会返回 404。
  while (!ctrl.signal.aborted) {
    attempt++;
    setPreviewBody(`<div class="preview-loading">正在自动下载…（${attempt}）<br><span class="preview-empty-hint">首次入库可能 5~30 秒，受源站速度影响</span></div>`);
    // 前 5 次 300ms 快速捕获缓存命中（CNAS/By 源 ~1-2s 就完成），之后退化到 1500ms 减负载
    const wait = attempt <= 5 ? 300 : 1500;
    await new Promise(r => setTimeout(r, wait));
    if (ctrl.signal.aborted) return;
    let data;
    let httpOk = true;
    try {
      const res = await fetch(`${API}/api/preview/task/${encodeURIComponent(taskId)}`, { signal: ctrl.signal });
      httpOk = res.ok;
      data = await readApiResponse(res);
    } catch (e) {
      if (ctrl.signal.aborted) return;
      // 轮询接口短暂抖动 → 继续重试
      continue;
    }
    // 任务过期（TTL 兜底命中）→ 当作失败处理，让用户点重试
    if (!httpOk || !data || data.status === undefined) {
      renderPreviewFailedUi(data?.error || '任务已过期或不存在，请重试');
      return;
    }
    if (data.status === 'ready') {
      _previewCurrent = { fileId: data.fileId, url: data.url, fileName: stdCode };
      if (data.fileId && _previewLastId) { _libraryFileIds.set(_previewLastId, data.fileId); applyLibraryDots(); }
      // Electron 桌面端：跳系统浏览器（与 runPreviewWithOverlay ready 分支一致）
      if (window.bzxz && window.bzxz.isElectron) {
        window.open(`${API}${data.url}`, '_blank');
        closePreviewOverlay();
        return;
      }
      // 不再加 ?t=Date.now() cache-buster；后端发 ETag + must-revalidate，浏览器走 304 复用
      setPreviewBody(`<iframe class="preview-iframe" src="${escapeHtml(data.url)}" title="预览 ${escapeHtml(stdCode)}"></iframe>`);
      return;
    }
    if (data.status === 'failed') {
      renderPreviewFailedUi(data.error || '所有源都未能下载到此标准。');
      return;
    }
    // pending / downloading → 继续循环
  }
}

/**
 * 渲染预览失败弹层：「关闭」+「重试」。
 * 重试逻辑：调用 previewStandard(_previewLastId) 重新走 /api/preview/request。
 * 后端会按 stdCode+year 去重，若有活跃任务复用，否则起新任务。
 */
function renderPreviewFailedUi(errorMsg) {
  setPreviewBody(`
    <div class="preview-empty">
      <div class="preview-empty-title">自动下载失败</div>
      <div class="preview-empty-hint">${escapeHtml(errorMsg || '未能下载到此标准。')}</div>
      <div class="preview-empty-actions">
        <button class="btn btn-primary" id="previewRetryBtn">重试</button>
        <button class="btn btn-ghost" id="previewCloseFailedBtn">关闭</button>
      </div>
    </div>`);
  const retry = document.getElementById('previewRetryBtn');
  if (retry) retry.addEventListener('click', () => {
    if (!_previewLastId) { closePreviewOverlay(); return; }
    // 停旧 poll，再走一次完整流程
    if (_previewPollAbort) {
      try { _previewPollAbort.abort(); } catch { /* ignore */ }
      _previewPollAbort = null;
    }
    previewStandard(_previewLastId);
  });
  const cls = document.getElementById('previewCloseFailedBtn');
  if (cls) cls.addEventListener('click', closePreviewOverlay);
}

/**
 * 预览入口（Phase 2 — 新 tab 流）。
 *
 * 三条路径：
 * 1. **热路径**（_libraryFileIds 已知命中 = 绿点亮）：直接 `window.open` 新 tab 跳
 *    `/api/preview/file/:fileId`，跳过 `/api/preview/request` 整轮 RTT。浏览器原生
 *    PDF viewer 比 iframe-in-overlay 快得多（少 overlay layout + iframe sandbox）。
 * 2. **冷路径 + 弹窗 OK**：在 click 同一调用栈里先 `window.open('about:blank')` 占位
 *    （popup blocker 只拦截非用户手势的 open），写个 loading 骨架；主页 POST request
 *    + poll，ready 时 `popup.location.replace(file)`，failed 时写错误页。
 * 3. **冷路径 + 弹窗被拦**：fallback 走原 overlay 路径，避免极端环境完全用不了预览。
 *
 * Phase 1 的 _libraryFileIds 缓存是热路径的关键。预览成功后会把新拿到的 fileId
 * 也写回缓存，下次再点同一标准走热路径。
 */
async function previewStandard(id) {
  const r = findResultByAnyId ? findResultByAnyId(id) : results.find(x => x.id === id);
  if (!r) { showToast('未找到该标准', 'fail'); return; }
  const stdCode = r.standardNumber || '';
  if (!stdCode) { showToast('该结果缺少标准号，无法预览', 'fail'); return; }
  _previewLastId = id;

  // 热路径：本地命中已知 → 直接跳新 tab
  const cachedFid = _libraryFileIds.get(id);
  if (cachedFid) {
    window.open(`${API}/api/preview/file/${encodeURIComponent(cachedFid)}`, '_blank');
    return;
  }

  // 冷路径：先在 click tick 里占一个 about:blank tab（popup blocker safe）
  let popup = null;
  try { popup = window.open('about:blank', '_blank'); } catch { /* blocked */ }

  if (popup && !popup.closed) {
    writePreviewLoadingPage(popup, stdCode);
    runPreviewWithPopup(id, stdCode, popup);
    return;
  }

  // 弹窗被拦 → fallback 走原 overlay 流程
  await runPreviewWithOverlay(id, stdCode, r);
}

/**
 * 把简陋的 loading 骨架写进 about:blank 弹窗。
 * 用 popup.document.write 而非 innerHTML 因为新 about:blank 没有 body 节点。
 * 跨同源 origin (about:blank 继承 opener)，写权限 OK；之后 `location.replace`
 * 走掉新 URL 后，我们就再也访问不到这个 document 了 —— 但那时我们也不需要了。
 */
function writePreviewLoadingPage(win, stdCode) {
  try {
    const t = escapeHtml(stdCode);
    win.document.open();
    win.document.write(
      '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
      + '<title>预览 ' + t + '…</title>'
      + '<style>html,body{height:100%;margin:0;background:#0a0d12;color:#c8cfd9;'
      + 'font-family:-apple-system,"Segoe UI",system-ui,sans-serif}'
      + '.box{display:flex;flex-direction:column;align-items:center;justify-content:center;'
      + 'height:100%;gap:14px;padding:24px;text-align:center}'
      + '.ttl{font-size:16px;font-weight:600}.hint{font-size:13px;color:#7c8696;max-width:480px;line-height:1.55}'
      + '.spin{width:38px;height:38px;border:3px solid #2a3140;border-top-color:#59aaf8;'
      + 'border-radius:50%;animation:s .9s linear infinite}'
      + '@keyframes s{to{transform:rotate(360deg)}}</style></head><body>'
      + '<div class="box"><div class="spin"></div>'
      + '<div class="ttl">正在自动下载 ' + t + '…</div>'
      + '<div class="hint" id="hint">首次入库 5~30 秒，受源站速度影响。该标签页会自动跳转到 PDF。</div>'
      + '</div></body></html>'
    );
    win.document.close();
  } catch { /* about:blank navigated away / cross-origin —— 忽略 */ }
}

/**
 * 把错误页写进弹窗（自动下载失败时）。
 * 给一个「关闭」按钮 + 错误文字。重试入口故意不放在弹窗里 —— 失败后用户回主页重点
 * 一次 预览按钮即可，避免把状态机搬到弹窗里。
 */
function writePreviewErrorPage(win, stdCode, msg) {
  try {
    const t = escapeHtml(stdCode);
    const m = escapeHtml(msg || '未能下载到此标准。');
    win.document.open();
    win.document.write(
      '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
      + '<title>预览失败 - ' + t + '</title>'
      + '<style>html,body{height:100%;margin:0;background:#0a0d12;color:#c8cfd9;'
      + 'font-family:-apple-system,"Segoe UI",system-ui,sans-serif}'
      + '.box{display:flex;flex-direction:column;align-items:center;justify-content:center;'
      + 'height:100%;gap:14px;padding:24px;text-align:center}'
      + '.ttl{font-size:18px;font-weight:600;color:#ee5a5a}'
      + '.hint{font-size:13px;color:#7c8696;max-width:520px;line-height:1.55}'
      + 'button{padding:8px 18px;border-radius:6px;border:1px solid #2a3140;background:#161b22;'
      + 'color:#c8cfd9;cursor:pointer;font-size:14px}button:hover{background:#1c222d}</style></head><body>'
      + '<div class="box"><div class="ttl">' + t + ' 预览失败</div>'
      + '<div class="hint">' + m + '</div>'
      + '<button onclick="window.close()">关闭此标签</button>'
      + '</div></body></html>'
    );
    win.document.close();
  } catch { /* 弹窗已关 —— 忽略 */ }
}

/**
 * 弹窗模式：发请求 → 命中直跳 / 未命中轮询任务 → 命中后 navigate 弹窗。
 * 任何阶段失败 → writePreviewErrorPage。
 */
async function runPreviewWithPopup(id, stdCode, popup) {
  // 每个 popup 独立 AbortController，不共享全局 _previewPollAbort（那个只服务
  // overlay 路径）。这样连续点不同标准的预览时，第一个 popup 的 poll 不会被第二个
  // 意外终结。popup.closed 检测仍然保留 —— 用户主动关 tab 就停 poll。
  const ctrl = new AbortController();
  const yearMatch = stdCode.match(/-\s*(\d{4})\s*$/);
  const year = yearMatch ? yearMatch[1] : undefined;
  const body = year ? { stdCode, year } : { stdCode };
  try {
    const res = await fetch(`${API}/api/preview/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = await readApiResponse(res);
    if (popup.closed) { ctrl.abort(); return; }
    if (data.status === 'ready' && data.fileId) {
      _libraryFileIds.set(id, data.fileId);
      applyLibraryDots();
      popup.location.replace(`${API}/api/preview/file/${encodeURIComponent(data.fileId)}`);
      return;
    }
    if (data.status === 'downloading' && data.taskId) {
      await pollPreviewTaskForPopup(data.taskId, stdCode, popup, id, ctrl);
      return;
    }
    writePreviewErrorPage(popup, stdCode, '后端返回未知状态：' + JSON.stringify(data));
  } catch (e) {
    if (popup.closed || ctrl.signal.aborted) return;
    writePreviewErrorPage(popup, stdCode, e?.message || String(e));
  }
}

/**
 * 弹窗版任务轮询。
 * - popup.closed → 取消轮询（用户关掉标签 = 不想要了）
 * - ready → navigate popup 到 file URL，同时回填 _libraryFileIds 缓存
 * - failed / 404 → 写错误页
 *
 * ctrl 由调用方（runPreviewWithPopup）传入，每个 popup 一个独立 AbortController，
 * 不再写全局 _previewPollAbort —— 历史 bug：用户连点 A→B 时，B 的入口 abort 全局
 * controller 把 A 的 poll 也杀了，导致 A 标签卡死。
 */
async function pollPreviewTaskForPopup(taskId, stdCode, popup, resultId, ctrl) {
  if (!ctrl) ctrl = new AbortController();
  let attempt = 0;
  while (!ctrl.signal.aborted) {
    if (popup.closed) { ctrl.abort(); return; }
    attempt++;
    // 前 5 次 300ms 快速捕获，之后 1500ms 减负载（与 pollPreviewTask 一致）
    const wait = attempt <= 5 ? 300 : 1500;
    await new Promise(r => setTimeout(r, wait));
    if (ctrl.signal.aborted || popup.closed) return;
    let data, ok = true;
    try {
      const res = await fetch(`${API}/api/preview/task/${encodeURIComponent(taskId)}`, { signal: ctrl.signal });
      ok = res.ok;
      data = await readApiResponse(res);
    } catch (e) {
      if (ctrl.signal.aborted || popup.closed) return;
      continue;
    }
    if (!ok || !data || data.status === undefined) {
      writePreviewErrorPage(popup, stdCode, data?.error || '任务已过期或不存在，请重试');
      return;
    }
    if (data.status === 'ready' && data.fileId) {
      if (resultId) { _libraryFileIds.set(resultId, data.fileId); applyLibraryDots(); }
      popup.location.replace(`${API}/api/preview/file/${encodeURIComponent(data.fileId)}`);
      return;
    }
    if (data.status === 'failed') {
      writePreviewErrorPage(popup, stdCode, data.error || '所有源都未能下载到此标准。');
      return;
    }
    // pending / downloading → 更新弹窗 hint 文案让用户感知到进度
    try {
      const hint = popup.document?.getElementById?.('hint');
      if (hint) hint.textContent = `轮询中… 已 ${attempt} 次（首次入库通常 5~30 秒）`;
    } catch { /* 弹窗已 navigate 走或关闭 —— 忽略 */ }
  }
}

/**
 * 老 overlay 路径（popup blocker 拦截时 fallback）。
 * 行为与 Phase 2 之前的 previewStandard 完全一致。
 */
async function runPreviewWithOverlay(id, stdCode, r) {
  if (_previewPollAbort) {
    try { _previewPollAbort.abort(); } catch { /* ignore */ }
    _previewPollAbort = null;
  }
  openPreviewOverlay(stdCode + (r.title ? `  ${r.title}` : ''));
  setPreviewBody(`<div class="preview-loading">查询本地库…</div>`);
  try {
    const yearMatch = stdCode.match(/-\s*(\d{4})\s*$/);
    const year = yearMatch ? yearMatch[1] : undefined;
    const body = year ? { stdCode, year } : { stdCode };
    const res = await fetch(`${API}/api/preview/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await readApiResponse(res);
    if (data.status === 'ready') {
      _previewCurrent = { fileId: data.fileId, url: data.url, fileName: stdCode };
      if (data.fileId) { _libraryFileIds.set(id, data.fileId); applyLibraryDots(); }
      // Electron 桌面端：跳系统浏览器（setWindowOpenHandler 路由到 shell.openExternal）
      // 体验比 overlay iframe 好得多（全屏 / 缩放 / 打印 / 另存为都用浏览器原生）。
      // Web 浏览器侧仍然在 overlay 内 iframe 渲染。
      if (window.bzxz && window.bzxz.isElectron) {
        window.open(`${API}${data.url}`, '_blank');
        closePreviewOverlay();
        return;
      }
      // 不再加 ?t=Date.now() cache-buster；后端发 ETag + must-revalidate，浏览器走 304 复用
      setPreviewBody(`<iframe class="preview-iframe" src="${escapeHtml(data.url)}" title="预览 ${escapeHtml(stdCode)}"></iframe>`);
      // 多源 picker：仅当此 stdCode 在 ≥2 个源都有文件时显示
      loadPreviewSourcePicker(stdCode, year, data.fileId);
    } else if (data.status === 'downloading' && data.taskId) {
      _previewCurrent = null;
      await pollPreviewTask(data.taskId, stdCode);
    } else if (data.status === 'not_in_library') {
      // 旧 Phase 1 兜底分支（理论上 Phase 2 后端不再返回这个 status）
      _previewCurrent = null;
      setPreviewBody(`
        <div class="preview-empty">
          <div class="preview-empty-title">本地库尚无此标准</div>
          <div class="preview-empty-hint">先点击下方"下载"按钮把 PDF 拉到本地后，再点预览即可直接打开。</div>
          <div class="preview-empty-actions">
            <button class="btn btn-primary" id="previewDownloadFallbackBtn">立即下载</button>
            <button class="btn btn-ghost" id="previewCloseFallbackBtn">关闭</button>
          </div>
        </div>`);
      const dl = document.getElementById('previewDownloadFallbackBtn');
      if (dl) dl.addEventListener('click', () => {
        closePreviewOverlay();
        const card = document.querySelector(`.result-card[data-sid="${CSS.escape(id)}"]`);
        const btn = card ? card.querySelector('[data-action="download"]') : null;
        if (typeof downloadOne === 'function') downloadOne(id, btn);
      });
      const cls = document.getElementById('previewCloseFallbackBtn');
      if (cls) cls.addEventListener('click', closePreviewOverlay);
    } else {
      setPreviewBody(`<div class="preview-empty"><div class="preview-empty-title">预览失败</div><div class="preview-empty-hint">${escapeHtml(JSON.stringify(data))}</div></div>`);
    }
  } catch (e) {
    setPreviewBody(`<div class="preview-empty"><div class="preview-empty-title">预览失败</div><div class="preview-empty-hint">${escapeHtml(e?.message || String(e))}</div></div>`);
  }
}

function openPreviewOverlay(title) {
  const overlay = document.getElementById('previewOverlay');
  if (!overlay) return;
  document.getElementById('previewTitle').textContent = title || '预览';
  overlay.classList.add('open');
  overlay.setAttribute('aria-hidden', 'false');
}
function closePreviewOverlay() {
  const overlay = document.getElementById('previewOverlay');
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.setAttribute('aria-hidden', 'true');
  setPreviewBody(''); // 卸载 iframe，停止后台流式下载
  const picker = document.getElementById('previewSourcePicker');
  if (picker) { picker.innerHTML = ''; picker.style.display = 'none'; }
  _previewCurrent = null;
  // Phase 2：用户主动关闭 → 取消 poll，避免后台继续抢请求
  if (_previewPollAbort) {
    try { _previewPollAbort.abort(); } catch { /* ignore */ }
    _previewPollAbort = null;
  }
}
function setPreviewBody(html) {
  const body = document.getElementById('previewBody');
  if (body) body.innerHTML = html;
}
(function bindPreviewOverlayEvents() {
  const overlay = document.getElementById('previewOverlay');
  if (!overlay) return;
  document.getElementById('previewClose')?.addEventListener('click', closePreviewOverlay);
  // 点击遮罩空白（panel 外）关闭；点击 panel 内不要触发
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closePreviewOverlay();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closePreviewOverlay();
  });
  document.getElementById('previewDownloadBtn')?.addEventListener('click', () => {
    if (!_previewCurrent) return;
    // 走 attachment=1 强制浏览器另存为，避免再次内联打开
    const a = document.createElement('a');
    a.href = `${_previewCurrent.url}?attachment=1`;
    a.download = '';
    document.body.appendChild(a); a.click(); a.remove();
  });
  document.getElementById('previewOpenNewBtn')?.addEventListener('click', () => {
    if (!_previewCurrent) return;
    window.open(_previewCurrent.url, '_blank', 'noopener,noreferrer');
  });
})();

// ── 多源 preview picker ──
// 后端 /api/preview/files 列出该 (stdCode, year) 在 gbw/bz/by/labr 4 源里能找到的所有文件，
// 按 (year DESC, priority 排序) 给前端。≥2 个候选时显示 picker 让用户切源。
//
// 行为：
// - 高亮当前正在预览的 fileId
// - 点击其它源 → 直接换 iframe src 到 /api/preview/file/:fileId（不重新拉 /preview/request）
// - 只有 1 个候选 → 不显示（picker container 保持 display:none）
async function loadPreviewSourcePicker(stdCode, year, activeFileId) {
  const picker = document.getElementById('previewSourcePicker');
  if (!picker) return;
  picker.innerHTML = '';
  picker.style.display = 'none';
  try {
    const params = new URLSearchParams({ stdCode });
    if (year) params.set('year', String(year));
    const res = await fetch(`${API}/api/preview/files?${params.toString()}`);
    const data = await readApiResponse(res);
    if (!res.ok) return; // 静默失败，picker 不显示
    const items = (data && (data.items || data.files)) || [];
    if (items.length < 2) return; // 只有 1 个源不显示 picker
    const sourceLabel = { gbw: 'GBW', bz: 'BZ', by: 'BY', labr: 'Labr' };
    const html = items.map(it => {
      const active = it.fileId === activeFileId ? 'active' : '';
      const label = sourceLabel[it.source] || it.source;
      const extBadge = it.ext && it.ext !== 'pdf'
        ? `<span class="preview-source-ext">${escapeHtml(it.ext.toUpperCase())}</span>`
        : '';
      const yr = it.year ? `<span class="preview-source-year">${escapeHtml(it.year)}</span>` : '';
      return `<button class="preview-source-btn ${active}" data-fid="${escapeHtml(it.fileId)}" data-source="${escapeHtml(it.source)}" title="${escapeHtml(label + (it.year ? ' / ' + it.year : '') + (it.ext ? ' / ' + it.ext : ''))}">
        <span class="preview-source-name">${escapeHtml(label)}</span>${yr}${extBadge}
      </button>`;
    }).join('');
    picker.innerHTML = `<span class="preview-source-label">源：</span>${html}`;
    picker.style.display = '';
    picker.querySelectorAll('.preview-source-btn').forEach(btn => {
      btn.addEventListener('click', () => switchPreviewSource(btn.dataset.fid, stdCode));
    });
  } catch { /* 静默 */ }
}

function switchPreviewSource(fileId, stdCode) {
  if (!fileId) return;
  const url = `${API}/api/preview/file/${encodeURIComponent(fileId)}`;
  _previewCurrent = { fileId, url, fileName: stdCode };
  setPreviewBody(`<iframe class="preview-iframe" src="${escapeHtml(url)}" title="预览 ${escapeHtml(stdCode || '')}"></iframe>`);
  // 高亮换到点中的按钮
  const picker = document.getElementById('previewSourcePicker');
  if (picker) {
    picker.querySelectorAll('.preview-source-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.fid === fileId);
    });
  }
}

// ── Right-click context menu ──
let _ctxMenuEl = null;
function hideCtxMenu() { if (_ctxMenuEl) { _ctxMenuEl.remove(); _ctxMenuEl = null; } }
document.addEventListener('click', hideCtxMenu);
document.addEventListener('keydown', e => { if (e.key === 'Escape') hideCtxMenu(); });
document.addEventListener('scroll', hideCtxMenu, true);

function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => showToast('已复制', 'success')).catch(() => showToast('复制失败', 'fail'));
  } else {
    const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta);
    ta.select(); try { document.execCommand('copy'); showToast('已复制', 'success'); } catch { showToast('复制失败', 'fail'); }
    ta.remove();
  }
}

// ── j/k vim-style row navigation ──
let _activeRowId = null;
function _setActiveRow(card) {
  document.querySelectorAll('.result-card.row-active').forEach(el => el.classList.remove('row-active'));
  if (!card) { _activeRowId = null; return; }
  card.classList.add('row-active');
  _activeRowId = card.dataset.sid;
  // Scroll into view if needed
  const rect = card.getBoundingClientRect();
  if (rect.top < 80 || rect.bottom > window.innerHeight - 40) {
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
}
function _getVisibleCards() {
  return Array.from(document.querySelectorAll('.result-card')).filter(c => {
    const grp = c.closest('.status-group');
    return !grp || !grp.classList.contains('collapsed');
  });
}
function _moveActiveRow(delta) {
  const cards = _getVisibleCards();
  if (!cards.length) return;
  let idx = cards.findIndex(c => c.dataset.sid === _activeRowId);
  if (idx < 0) idx = delta > 0 ? -1 : cards.length;
  idx = Math.max(0, Math.min(cards.length - 1, idx + delta));
  _setActiveRow(cards[idx]);
}
document.addEventListener('keydown', e => {
  // Mobile layout: 键盘快捷键（j/k/g/G/x/d/s 等）不可用 —— 没有物理键盘场景，
  // 也避免和"我"页等没有 active-row 的页面交互冲突。
  if (typeof window.isMobile === 'function' && window.isMobile()) return;
  // Skip when typing in input/textarea/contenteditable
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;
  // Skip when modal/overlay open
  if (document.querySelector('.modal.open, .shortcuts-overlay.open')) return;
  // Skip if not on search page
  const searchPage = document.getElementById('page-search');
  if (!searchPage || searchPage.style.display === 'none') return;
  // Skip combos with modifiers (let them through)
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  if (e.key === 'j') { e.preventDefault(); _moveActiveRow(1); return; }
  if (e.key === 'k') { e.preventDefault(); _moveActiveRow(-1); return; }
  if (e.key === 'g') { e.preventDefault(); const cards = _getVisibleCards(); if (cards.length) _setActiveRow(cards[0]); return; }
  if (e.key === 'G') { e.preventDefault(); const cards = _getVisibleCards(); if (cards.length) _setActiveRow(cards[cards.length - 1]); return; }
  if (!_activeRowId) return;
  const card = document.querySelector(`.result-card[data-sid="${CSS.escape(_activeRowId)}"]`);
  if (!card) return;
  if (e.key === 'x' || e.key === ' ') {
    e.preventDefault();
    const cb = card.querySelector('input[type="checkbox"]');
    if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('change', { bubbles: true })); }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    showDetail(_activeRowId);
  } else if (e.key === 'd') {
    e.preventDefault();
    // 手机端禁用下载快捷键：CSS 已隐掉触发入口，这里再防一道外接键盘绕过。
    // 与 toggleSavedStandard 的兜底风格对齐。
    if (typeof window.isMobile === 'function' && window.isMobile()) return;
    const btn = card.querySelector('[data-action="download"]');
    if (btn && !btn.disabled) downloadOne(_activeRowId, btn); else showToast('该标准无可用文本', 'fail');
  } else if (e.key === 's') {
    e.preventDefault();
    toggleSavedStandard(_activeRowId);
  }
});

document.getElementById('results').addEventListener('contextmenu', e => {
  const card = e.target.closest('.result-card');
  if (!card) return;
  e.preventDefault();
  hideCtxMenu();
  const id = card.dataset.sid;
  const r = findResultByAnyId ? findResultByAnyId(id) : results.find(x => x.id === id);
  if (!r) return;
  // 手机端长按触发的右键菜单去掉「下载该标准」「加入收藏」，与 CSS 隐藏入口对齐
  const onMobile = typeof window.isMobile === 'function' && window.isMobile();
  const items = [
    { label: '复制标准号', icon: '#', action: () => copyToClipboard(r.standardNumber || '') },
    { label: '复制名称', icon: 'T', action: () => copyToClipboard(r.title || '') },
    { label: '复制标准号 + 名称', icon: '≣', action: () => copyToClipboard(`${r.standardNumber || ''}  ${r.title || ''}`.trim()) },
    { divider: true },
    { label: '查看详情', icon: '👁', action: () => showDetail(id) },
    { label: isPreviewable(r) ? '预览（本地）' : '预览（本地）（不可用）', icon: '🗎', action: () => { if (isPreviewable(r)) previewStandard(id); else showToast('该标准无本地缓存且无可下载源', 'fail'); } },
    ...(onMobile ? [] : [
      { label: isDownloadable(r) ? '下载该标准' : '下载该标准（无文本）', icon: '↓', action: () => { const btn = card.querySelector('[data-action="download"]'); if (btn && !btn.disabled) downloadOne(id, btn); else showToast('该标准无可用文本', 'fail'); } },
      { label: isStandardSaved(r) ? '取消收藏' : '加入收藏', icon: '★', action: () => toggleSavedStandard(id) },
    ]),
    { divider: true },
    { label: '复制为 JSON', icon: '{}', action: () => copyToClipboard(JSON.stringify(r, null, 2)) },
  ];
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  menu.innerHTML = items.map((it, idx) => it.divider
    ? '<div class="ctx-menu-divider"></div>'
    : `<div class="ctx-menu-item" data-idx="${idx}"><span class="ctx-menu-icon">${it.icon || ''}</span><span class="ctx-menu-label">${escapeHtml(it.label)}</span></div>`
  ).join('');
  // Position with viewport clamp
  const VW = window.innerWidth, VH = window.innerHeight;
  const MW = 220, MH = items.length * 30 + 20;
  const x = Math.min(e.clientX, VW - MW - 8);
  const y = Math.min(e.clientY, VH - MH - 8);
  menu.style.cssText = `position:fixed;left:${x}px;top:${y}px;z-index:10000;`;
  document.body.appendChild(menu);
  _ctxMenuEl = menu;
  menu.addEventListener('click', ev => {
    const item = ev.target.closest('.ctx-menu-item');
    if (!item) return;
    const idx = parseInt(item.dataset.idx);
    const cmd = items[idx];
    if (cmd && cmd.action) cmd.action();
    hideCtxMenu();
  });
});

function setRowDownloadState(id, state) {
  const card = document.querySelector(`.result-card[data-sid="${CSS.escape(id)}"]`);
  if (!card) return;
  const btn = card.querySelector('[data-action="download"]');
  card.classList.remove('download-success', 'download-fail');
  if (state === 'downloading') {
    card.classList.add('downloading');
    if (btn) { btn.disabled = true; btn.innerHTML = '<span class="btn-spinner" style="display:inline-block"></span>下载中'; }
  } else {
    card.classList.remove('downloading');
    if (state === 'success') card.classList.add('download-success');
    else if (state === 'fail') card.classList.add('download-fail');
    if (btn) { btn.disabled = false; btn.textContent = '下载'; }
    setTimeout(() => card.classList.remove('download-success', 'download-fail'), 2500);
  }
}

function statusClass(s) { if (!s) return ''; if (s.includes('废止')) return 'expired'; if (s.includes('实施')) return 'upcoming'; if (s.includes('现行')) return 'current'; return ''; }

// ── Toolbar ──
function updateToolbar() {
  document.getElementById('selectedCount').textContent = `已选 ${selectedIds.size}`;
  const dlBtn = document.getElementById('downloadSelected');
  if (dlBtn) dlBtn.disabled = selectedIds.size === 0 || isDownloading;
  renderSavedToolbar();
}
document.getElementById('selectAll').addEventListener('click', () => {
  const filtered = getFilteredResults();
  const allSelected = filtered.length > 0 && filtered.every(r => selectedIds.has(r.id));
  filtered.forEach(r => allSelected ? selectedIds.delete(r.id) : selectedIds.add(r.id));
  renderResults(); updateToolbar();
});

document.getElementById('exportResults').addEventListener('click', () => {
  const data = getFilteredResults();
  if (!data.length) { showToast('没有可导出的结果', 'fail'); return; }
  const rows = [['标准号', '标准名称', '状态', '来源', '发布日期', '实施日期']];
  data.forEach(r => {
    rows.push([r.standardNumber, r.title, r.status || '', (r.sources || [r._source]).join('+'), r.publishDate || '', r.implementDate || '']);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `搜索结果_${beijingDate()}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast(`已导出 ${data.length} 条结果`);
});

function toggleSavedStandard(id) {
  // 手机端禁用收藏：CSS 已经隐掉触发入口，这里再防一道键盘 / 外部脚本绕过
  if (typeof window !== 'undefined' && typeof window.isMobile === 'function' && window.isMobile()) return;
  const r = findResultByAnyId(id);
  if (!r) return;
  const key = standardSaveKey(r);
  const exists = savedStandards.some(s => s.key === key);
  if (exists) {
    savedStandards = savedStandards.filter(s => s.key !== key);
    showToast('已取消收藏');
  } else {
    savedStandards.unshift({
      key,
      id: r.id,
      standardNumber: r.standardNumber,
      title: r.title || '',
      status: r.status || '',
      sources: r.sources || [r._source],
      savedAt: Date.now(),
    });
    showToast('已加入收藏，将自动关注更新');
  }
  persistSavedStandards();
  // 同步到后端"我的收藏"查新清单（点收藏 = 关注该标准更新）。fire-and-forget，不卡 UI。
  // 标准号带年代号才能查新；不带的（极少）后端 cleanStdCode 容错，查不到标 not_found。
  try {
    apiFetch('/api/check/saved/toggle', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stdCode: r.standardNumber }),
    }).catch(() => { /* 静默：本地收藏态已更新，查新同步失败不影响 */ });
  } catch { /* ignore */ }
  renderResults();
  renderFilterBar();
  updateToolbar();
}

function renderSavedToolbar() {
  const savedCount = results.filter(r => isStandardSaved(r)).length;
  const countEl = document.getElementById('savedCount');
  const toggle = document.getElementById('savedOnlyToggle');
  const density = document.getElementById('densityToggle');
  if (countEl) countEl.textContent = `收藏 ${savedCount}`;
  if (toggle) {
    toggle.classList.toggle('active', filterState.onlySaved);
    toggle.disabled = results.length === 0;
  }
  if (density) {
    density.textContent = resultDensity === 'compact' ? '舒展' : '紧凑';
    density.classList.toggle('active', resultDensity === 'compact');
  }
}

document.getElementById('savedOnlyToggle').addEventListener('click', () => {
  filterState.onlySaved = !filterState.onlySaved;
  renderFilterBar(); renderResults(); updateToolbar();
});

document.getElementById('densityToggle').addEventListener('click', () => {
  setResultDensity(resultDensity === 'compact' ? 'comfortable' : 'compact');
  renderSavedToolbar();
});

document.getElementById('searchTemplates').addEventListener('click', e => {
  const btn = e.target.closest('[data-template]');
  if (!btn) return;
  const input = document.getElementById('searchInput');
  const template = btn.dataset.template || '';
  const current = input.value.trim();
  input.value = current && !current.startsWith(template.trim()) ? `${template}${current}` : template;
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
});
