/**
 * CMA 一单一库比对 — 子 tab 切换 + 能力项目库搜索。
 *
 * 从 app-cma-diff.js 拆出。依赖 domains.js 先加载（loadCapLibPage 等）。
 */

(function () {
  if (typeof window === 'undefined') return;

  // ── 子 tab 切换 ──────────────────────────────────────────────

  window.switchCapLibTab = function (tab) {
    document.querySelectorAll('.cap-lib-tab').forEach(function (t) { t.classList.remove('active'); });
    var activeTab = document.querySelector('.cap-lib-tab[onclick*="' + tab + '"]');
    if (activeTab) activeTab.classList.add('active');
    document.querySelectorAll('.cap-lib-tab-content').forEach(function (c) { c.style.display = 'none'; });
    var target = document.getElementById('capLibTab' + tab.charAt(0).toUpperCase() + tab.slice(1));
    if (target) target.style.display = '';
    if (tab === 'domains' || tab === 'labs') {
      try { loadCapLibPage(); } catch (e) { /* ignore */ }
    }
  };

  // ── 能力项目库搜索 ──────────────────────────────────────────

  var _capLibSearchPage = 1;
  var _CAP_LIB_SEARCH_PAGE_SIZE = 50;
  var _capLibSearchStatus = '';
  var CAP_LIB_STATUS_LABELS = {
    active: '在库',
    cite_only: '废止可引用',
    abolished: '已废止',
  };

  window.capLibInitSearchDomains = function () {
    var sel = document.getElementById('capLibSearchDomain');
    if (!sel || sel.options.length > 1) return;
    var meta = window._capLibDomainsMeta || [];
    for (var i = 0; i < meta.length; i++) {
      var opt = document.createElement('option');
      opt.value = meta[i].domain;
      opt.textContent = meta[i].domain;
      sel.appendChild(opt);
    }
  };

  function updateCapLibAdvancedFilterButton() {
    var button = document.getElementById('capLibAdvancedBtn');
    if (!button) return;
    var count = button.querySelector('.filter-drawer-count');
    var isActive = !!_capLibSearchStatus;
    button.classList.toggle('is-active', isActive);
    if (count) {
      count.hidden = !isActive;
      count.textContent = isActive ? '1' : '';
    }
  }

  window.capLibOpenAdvancedFilter = function () {
    if (typeof window.openFilterDrawer !== 'function') return;
    window.openFilterDrawer({
      title: '能力项目库筛选',
      description: '领域已放在搜索框旁；在这里按资料状态缩小结果范围。',
      bodyHtml: '<div class="filter-drawer-field"><div class="filter-drawer-label">资料状态</div><div class="filter-choice-set filter-choice-set-stack">'
        + '<label class="filter-choice"><input type="radio" name="capLibStatus" value=""' + (!_capLibSearchStatus ? ' checked' : '') + '><span>全部状态</span></label>'
        + Object.keys(CAP_LIB_STATUS_LABELS).map(function (status) { return '<label class="filter-choice"><input type="radio" name="capLibStatus" value="' + status + '"' + (_capLibSearchStatus === status ? ' checked' : '') + '><span>' + CAP_LIB_STATUS_LABELS[status] + '</span></label>'; }).join('')
        + '</div><p class="filter-drawer-help">状态来自能力项目库的资料维护标记。</p></div>',
      onReset: function () {
        var input = document.querySelector('input[name="capLibStatus"][value=""]');
        if (input) input.checked = true;
      },
      onApply: function () {
        var input = document.querySelector('input[name="capLibStatus"]:checked');
        _capLibSearchStatus = input ? input.value : '';
        updateCapLibAdvancedFilterButton();
        window.capLibDoSearch();
      },
    });
  };

  window.capLibDoSearch = function (page) {
    _capLibSearchPage = page || 1;
    var q = (document.getElementById('capLibSearchInput') && document.getElementById('capLibSearchInput').value || '').trim();
    var domain = document.getElementById('capLibSearchDomain') && document.getElementById('capLibSearchDomain').value || '';
    var offset = (_capLibSearchPage - 1) * _CAP_LIB_SEARCH_PAGE_SIZE;

    var params = new URLSearchParams();
    if (q) params.set('q', q);
    if (domain) params.set('domain', domain);
    if (_capLibSearchStatus) params.set('status', _capLibSearchStatus);
    params.set('limit', String(_CAP_LIB_SEARCH_PAGE_SIZE));
    params.set('offset', String(offset));

    var resultsEl = document.getElementById('capLibSearchResults');
    var summaryEl = document.getElementById('capLibSearchSummary');
    var pagerEl = document.getElementById('capLibSearchPager');
    if (!resultsEl) return;

    resultsEl.innerHTML = '<div style="color:var(--text-3);font-size:13px">\u641C\u7D22\u4E2D\u2026</div>';
    if (pagerEl) pagerEl.innerHTML = '';

    fetch(API + '/api/cma-diff/search?' + params)
      .then(function (r) { return readApiResponse(r); })
      .then(function (data) {
        var items = data.items || [];
        var total = data.total || 0;
        if (summaryEl) summaryEl.textContent = total > 0 ? '\u5171 ' + total + ' \u6761' + (_capLibSearchStatus ? ' · ' + CAP_LIB_STATUS_LABELS[_capLibSearchStatus] : '') : '';

        if (items.length === 0) {
          resultsEl.innerHTML = '<div style="color:var(--text-3);font-size:13px">\u672A\u627E\u5230\u5339\u914D\u8BB0\u5F55</div>';
          return;
        }

        var html = '<table class="cap-lib-search-table"><thead><tr>'
          + '<th>\u6807\u51C6\u53F7</th><th>\u68C0\u6D4B\u65B9\u6CD5</th><th>\u9886\u57DF</th><th>\u72B6\u6001</th><th>\u5907\u6CE8</th>'
          + '</tr></thead><tbody>';
        for (var i = 0; i < items.length; i++) {
          var item = items[i];
          html += '<tr>'
            + '<td>' + escHtml(item.stdCode) + '</td>'
            + '<td>' + escHtml(item.method) + '</td>'
            + '<td>' + escHtml(item.domain) + '</td>'
            + '<td><span class="cap-lib-status-tag cap-lib-status-' + escAttr(item.status || '') + '">' + escHtml(CAP_LIB_STATUS_LABELS[item.status] || item.status || '未标记') + '</span></td>'
            + '<td style="max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escAttr(item.remark) + '">' + escHtml(item.remark) + '</td>'
            + '</tr>';
        }
        html += '</tbody></table>';
        resultsEl.innerHTML = html;

        if (pagerEl && total > _CAP_LIB_SEARCH_PAGE_SIZE) {
          var totalPages = Math.ceil(total / _CAP_LIB_SEARCH_PAGE_SIZE);
          var pager = '';
          if (_capLibSearchPage > 1) pager += '<button class="btn btn-sm btn-ghost" onclick="capLibDoSearch(' + (_capLibSearchPage - 1) + ')">\u4E0A\u4E00\u9875</button>';
          pager += '<span style="font-size:12px;color:var(--text-3)">' + _capLibSearchPage + ' / ' + totalPages + '</span>';
          if (_capLibSearchPage < totalPages) pager += '<button class="btn btn-sm btn-ghost" onclick="capLibDoSearch(' + (_capLibSearchPage + 1) + ')">\u4E0B\u4E00\u9875</button>';
          pagerEl.innerHTML = pager;
        }
      })
      .catch(function (err) {
        resultsEl.innerHTML = '<div style="color:var(--danger);font-size:13px">\u641C\u7D22\u5931\u8D25: ' + escHtml(err.message) + '</div>';
      });
  };

  setTimeout(function () { capLibInitSearchDomains(); updateCapLibAdvancedFilterButton(); }, 500);
})();
