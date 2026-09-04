// ── Search Core: orchestration, toolbar, keyboard ──

// ── Search mode switcher (标准检索 / Labr 补给) ──
function switchSearchMode(mode) {
  document.querySelectorAll('.search-mode-tab').forEach(t => {
    const active = t.dataset.searchMode === mode;
    t.classList.toggle('active', active);
    t.setAttribute('aria-selected', String(active));
  });
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
_searchStatusEl.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:400;display:none;align-items:center;gap:8px;padding:10px 18px;border-radius:8px;background:var(--surface-elevated);backdrop-filter:blur(12px);border:1px solid var(--border-overlay, var(--border));box-shadow:0 8px 32px color-mix(in srgb, var(--text) 22%, transparent);font-size:13px;font-weight:500;color:var(--text);transition:opacity 0.25s;pointer-events:none;';
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
    persistSearchPreferences();
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
      if (typeof fetchNatCmaBadges === 'function') {
        fetchNatCmaBadges(stdNums).catch(() => { /* silent */ });
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
  document.getElementById('searchBtn').innerHTML = '<i class="search-btn-icon ti ti-search" aria-hidden="true"></i><span class="search-btn-label">搜索</span>'; document.getElementById('searchBtn').disabled = false;
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
  renderFilterBar();
  if (results.length === 0 && !searchAborted) {
    document.getElementById('results').innerHTML = '<div class="workspace-empty-state"><i class="ti ti-file-off" aria-hidden="true"></i><strong>未找到相关标准</strong><span>尝试更换关键词、放宽筛选条件，或切换数据源后重试。支持标准号和关键词混合搜索。</span></div>';
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
  if (e.key === 'Enter') doSearch();
});
document.getElementById('searchBtn').addEventListener('click', () => {
  const btn = document.getElementById('searchBtn');
  if (btn.textContent.includes('取消')) {
    searchAborted = true;
    return;
  }
  doSearch();
});

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
    }).then(() => syncSavedStandardsAcrossDevices()).catch(() => { /* 本地收藏态已保存，稍后会自动重试同步。 */ });
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
  persistSearchPreferences();
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
