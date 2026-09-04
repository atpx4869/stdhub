/**
 * CMA 一单一库比对 — 机构列表 + 行级操作（黑名单/手动映射/重试/诊断/导出/清理）。
 *
 * 从 app-cma-diff.js 拆出。依赖 domains.js 先加载：
 *  - window._cmaDiff 暴露常量 & isAdminUser
 *  - file-scope 格式化工具（formatDateTime / escHtml / escAttr / cssEscape）
 *  - readApiResponse / showToast / API 来自 app-core / app-ui-components
 */

(function () {
  if (typeof window === 'undefined') return;

  var _c = window._cmaDiff || {};
  var DIFF_STATUS_META = _c.DIFF_STATUS_META || {};
  var STATUS_ORDER = _c.STATUS_ORDER || [];
  var GROUP_ORDER = _c.GROUP_ORDER || [];
  var PAGE_SIZE_OPTIONS = _c.PAGE_SIZE_OPTIONS || [];
  var getPageSize = _c.getPageSize || function () { return 100; };
  var setPageSize = _c.setPageSize || function () {};
  var isAdminUser = _c.isAdminUser || function () { return false; };

  // ── 机构列表 ──────────────────────────────────────────────────────

  async function renderLabs() {
    var box = document.getElementById('capLibLabsBody');
    if (!box) return;
    try {
      var res = await fetch('/api/cma-diff/labs');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await readApiResponse(res);
      var items = (data && data.items) || [];
      if (!items.length) {
        box.innerHTML = '<div class="cap-lib-empty">未订阅任何 CMA 机构。请先到「资质查询」页订阅。</div>';
        return;
      }
      items.sort(function (a, b) {
        var sa = (a.byStatus && a.byStatus.not_in_lib || 0) + (a.byStatus && a.byStatus.series_only || 0);
        var sb = (b.byStatus && b.byStatus.not_in_lib || 0) + (b.byStatus && b.byStatus.series_only || 0);
        if (sa !== sb) return sb - sa;
        return (b.total || 0) - (a.total || 0);
      });
      box.innerHTML = '<div class="cap-lib-labs-list">' + items.map(function (lab) {
        var statusChips = STATUS_ORDER.map(function (k) {
          var n = lab.byStatus && lab.byStatus[k] || 0;
          if (!n) return '';
          var meta = DIFF_STATUS_META[k];
          return '<span class="cap-lib-lab-status" style="--status-color:' + meta.color + '"><span>' + meta.emoji + '</span><span>' + escHtml(meta.label) + '</span><b>' + n.toLocaleString() + '</b></span>';
        }).filter(Boolean).join('');
        var attention = (lab.byStatus && lab.byStatus.not_in_lib || 0) + (lab.byStatus && lab.byStatus.series_only || 0);
        var gid = 'capLibLab_' + escAttr(lab.certNumber);
        var labNameAttr = escAttr(lab.labName || lab.certNumber);
        return ''
          + '<article class="cap-lib-lab-group' + (attention ? ' has-attention' : '') + '">'
          + '<div class="cap-lib-lab-head" onclick="capLibToggleLab(\'' + escAttr(lab.certNumber) + '\')">'
          + '<span class="cap-lib-lab-arrow" id="' + gid + '_arrow">\u25B8</span>'
          + '<div class="cap-lib-lab-identity">'
          + '<span class="cap-lib-lab-name">' + escHtml(lab.labName || '未命名机构') + '</span>'
          + '<span class="cap-lib-lab-cert">证书号 ' + escHtml(lab.certNumber) + '</span>'
          + '</div>'
          + '<div class="cap-lib-lab-counts">' + (statusChips || '<span class="cap-lib-lab-status is-empty">暂无比对数据</span>') + '</div>'
          + '<div class="cap-lib-lab-summary">'
          + (attention ? '<span class="cap-lib-lab-attention">' + attention.toLocaleString() + ' 项待关注</span>' : '<span class="cap-lib-lab-ok">无需重点处理</span>')
          + '<span class="cap-lib-lab-total">共 ' + (lab.total || 0).toLocaleString() + ' 项</span>'
          + '</div>'
          + '<div class="cap-lib-lab-actions">'
          + '<button class="btn btn-sm btn-ghost cap-lib-lab-recompare"'
          + ' onclick="event.stopPropagation();capLibRecompareLab(\'' + escAttr(lab.certNumber) + '\')"'
          + ' title="\u6E05\u7F13\u5B58\u91CD\u65B0\u4E0E\u56FD\u5BB6\u5E93\u5BF9\u6BD4">\u91CD\u65B0\u5BF9\u6BD4</button>'
          + '<button class="btn btn-sm btn-ghost cap-lib-lab-export"'
          + ' onclick="event.stopPropagation();capLibExportDiff({ certNumbers: [\'' + escAttr(lab.certNumber) + '\'] }, this)"'
          + ' title="\u5BFC\u51FA\u300C' + labNameAttr + '\u300D\u6574\u8868">\u5BFC\u51FA</button>'
          + '</div>'
          + '</div>'
          + '<div class="cap-lib-lab-body" id="' + gid + '_body" style="display:none"></div>'
          + '</article>';
      }).join('') + '</div>';
    } catch (e) {
      box.innerHTML = '<div style="color:var(--danger)">\u52A0\u8F7D\u5931\u8D25\uFF1A' + escHtml(e.message || String(e)) + '</div>';
    }
  }

  window._cmaDiffRenderLabs = renderLabs;

  window.capLibToggleLab = async function (certNumber) {
    var gid = 'capLibLab_' + certNumber;
    var body = document.getElementById(gid + '_body');
    var arrow = document.getElementById(gid + '_arrow');
    if (!body) return;
    if (body.style.display === '') {
      body.style.display = 'none';
      if (arrow) arrow.textContent = '\u25B8';
      body._capLibGroups = null;
      body.dataset.loaded = '';
      return;
    }
    body.style.display = '';
    if (arrow) arrow.textContent = '\u25BE';
    if (body.dataset.loaded === '1') return;
    body.innerHTML = '<div style="padding:8px;color:var(--text-3)">\u52A0\u8F7D\u4E2D\u2026</div>';
    try {
      var res = await fetch('/api/cma-diff/labs/' + encodeURIComponent(certNumber));
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await readApiResponse(res);
      var rows = (data && data.rows) || [];
      if (!rows.length) {
        body.innerHTML = '<div style="padding:8px;color:var(--text-3)">\u8BE5\u673A\u6784\u65E0 CMA \u8D44\u8D28\u884C</div>';
        body.dataset.loaded = '1';
        return;
      }
      var groups = { not_in_lib: [], series_only: [], abolished: [], cite_only: [], in_lib: [] };
      for (var i = 0; i < rows.length; i++) (groups[rows[i].diffStatus] || groups.not_in_lib).push(rows[i]);
      body._capLibGroups = groups;
      body.dataset.cert = certNumber;
      body.innerHTML = ''
        + '<div class="cap-lib-lab-search">'
        + '<input type="text" class="cap-lib-lab-search-input" placeholder="\u5728\u672C\u673A\u6784\u5185\u641C\u6807\u51C6\u53F7 / \u6807\u51C6\u540D / \u68C0\u6D4B\u9879\u76EE\u2026"'
        + ' oninput="capLibSearchLab(this)">'
        + '</div>'
        + '<div class="cap-lib-lab-groups" id="' + escAttr('capLibLab_' + certNumber) + '_groups"></div>';
      var groupsHost = body.querySelector('.cap-lib-lab-groups');
      renderStatusGroups(groupsHost, groups, certNumber);
      body.dataset.loaded = '1';
    } catch (e) {
      body.innerHTML = '<div style="padding:8px;color:var(--danger)">\u52A0\u8F7D\u5931\u8D25\uFF1A' + escHtml(e.message || String(e)) + '</div>';
    }
  };

  window.capLibSearchLab = function (input) {
    var labBody = input.closest('.cap-lib-lab-body');
    if (!labBody) return;
    var host = labBody.querySelector('.cap-lib-lab-groups');
    var groups = labBody._capLibGroups;
    var certNumber = labBody.dataset.cert || '';
    if (!host || !groups) return;
    clearTimeout(input._capLibSearchTimer);
    input._capLibSearchTimer = setTimeout(function () {
      var kw = (input.value || '').trim().toLowerCase();
      if (!kw) {
        renderStatusGroups(host, groups, certNumber);
        return;
      }
      var filtered = { not_in_lib: [], series_only: [], abolished: [], cite_only: [], in_lib: [] };
      var hits = 0;
      for (var si = 0; si < GROUP_ORDER.length; si++) {
        var status = GROUP_ORDER[si];
        var list = groups[status] || [];
        for (var ri = 0; ri < list.length; ri++) {
          var r = list[ri];
          var testItems = (r.testItems && r.testItems.length ? r.testItems : (r.testItem ? [r.testItem] : []));
          var hay = (r.stdCode + ' ' + (r.stdName || '') + ' ' + testItems.join(' ')).toLowerCase();
          if (hay.indexOf(kw) !== -1) { filtered[status].push(r); hits++; }
        }
      }
      renderStatusGroups(host, filtered, certNumber, {
        expandAll: true,
        emptyText: '\u6CA1\u6709\u5339\u914D\u300C' + (input.value || '').trim() + '\u300D\u7684\u6807\u51C6\u884C',
      });
      void hits;
    }, 200);
  };

  function renderStatusGroups(body, groups, certNumber, opts) {
    var expandAll = !!(opts && opts.expandAll);
    body._capLibViewGroups = groups;
    var firstNonEmpty = null;
    for (var fi = 0; fi < GROUP_ORDER.length; fi++) {
      if ((groups[GROUP_ORDER[fi]] || []).length > 0) { firstNonEmpty = GROUP_ORDER[fi]; break; }
    }
    if (!firstNonEmpty) {
      body.innerHTML = '<div class="cap-lib-lab-search-empty">' + escHtml((opts && opts.emptyText) || '\u65E0\u6570\u636E') + '</div>';
      return;
    }
    var html = '';
    for (var gi = 0; gi < GROUP_ORDER.length; gi++) {
      var status = GROUP_ORDER[gi];
      var list = groups[status] || [];
      if (!list.length) continue;
      var meta = DIFF_STATUS_META[status];
      var expanded = expandAll || status === firstNonEmpty;
      var gid = body.id + '_s_' + status;
      var exportBtn = '<button class="btn btn-sm btn-ghost cap-lib-stgroup-export"'
        + ' onclick="event.stopPropagation();capLibExportDiff({ certNumbers: [\'' + escAttr(certNumber) + '\'], statuses: [\'' + status + '\'] }, this)"'
        + ' title="\u53EA\u5BFC\u8BE5\u6863">\u5BFC\u51FA</button>';
      html += ''
        + '<div class="cap-lib-stgroup" data-status="' + status + '">'
        + '<div class="cap-lib-stgroup-head" onclick="capLibToggleStGroup(\'' + gid + '\')">'
        + '<span class="cap-lib-stgroup-arrow" id="' + gid + '_arrow">' + (expanded ? '\u25BE' : '\u25B8') + '</span>'
        + '<span style="color:' + meta.color + '">' + meta.emoji + ' ' + escHtml(meta.label) + '</span>'
        + '<span class="cap-lib-stgroup-count">' + list.length + ' \u6761</span>'
        + exportBtn
        + '</div>'
        + '<div class="cap-lib-stgroup-body" id="' + gid + '_body" data-page="1"'
        + ' data-rendered="' + (expanded ? '1' : '') + '" style="display:' + (expanded ? '' : 'none') + '">'
        + (expanded ? renderPagedTable(list, 1, certNumber) : '')
        + '</div>'
        + '</div>';
    }
    body.innerHTML = html;
  }

  function renderPagedTable(list, page, certNumber) {
    var total = list.length;
    var pageSize = getPageSize();
    var pages = Math.ceil(total / pageSize) || 1;
    var p = Math.min(Math.max(1, page), pages);
    var slice = list.slice((p - 1) * pageSize, p * pageSize);
    var pageSizeSel = '<label class="cap-lib-pagesize">\u6BCF\u9875'
      + '<select onchange="capLibSetPageSize(this)">'
      + PAGE_SIZE_OPTIONS.map(function (n) { return '<option value="' + n + '" ' + (n === pageSize ? 'selected' : '') + '>' + n + '</option>'; }).join('')
      + '</select> \u6761</label>';
    var blackBar = '<div class="cap-lib-black-bar">'
      + '<button class="cap-lib-row-act" onclick="capLibAddCheckedToBlacklist(this)">\u52FE\u9009\u9879\u52A0\u5165\u9ED1\u540D\u5355</button>'
      + '<span class="cap-lib-black-hint">\u9ED1\u540D\u5355\u5185\u7684\u6807\u51C6\u53F7\u4E0D\u663E\u793A\u4E5F\u4E0D\u53C2\u4E0E\u5339\u914D\uFF08\u7528\u4E8E\u5C4F\u853D\u8868\u683C\u5408\u5E76\u4EA7\u751F\u7684\u975E\u6807\u51C6\u53F7\u810F\u884C\uFF09</span>'
      + pageSizeSel
      + '</div>';
    var tableHtml = ''
      + '<table class="cap-lib-diff-table cap-lib-diff-table-actions">'
      + '<thead><tr><th class="cap-lib-row-pick"><input type="checkbox" class="cap-lib-row-checkall" onchange="capLibToggleCheckAll(this)" title="\u5168\u9009/\u53D6\u6D88\u672C\u9875"></th><th>\u72B6\u6001</th><th>\u6807\u51C6\u53F7</th><th>\u6807\u51C6\u540D</th><th>\u7C7B\u522B/\u9879\u76EE</th><th>\u66FF\u4EE3/\u5907\u6CE8</th><th>\u64CD\u4F5C</th></tr></thead>'
      + '<tbody>' + slice.map(function (r) { return renderDiffRow(r, certNumber); }).join('') + '</tbody>'
      + '</table>';
    var pagerHtml = pages > 1
      ? renderPager(p, pages, total)
      : '<div class="cap-lib-pager">\u5171 ' + total + ' \u6761</div>';
    return blackBar + tableHtml + pagerHtml;
  }

  function renderPager(current, pages, total) {
    var btns = compressPages(current, pages);
    return '<div class="cap-lib-pager">'
      + '<button onclick="capLibPageGo(this, ' + (current - 1) + ')" ' + (current === 1 ? 'disabled' : '') + '>\u2039</button>'
      + btns.map(function (pg) { return pg === '\u2026'
        ? '<span class="cap-lib-pager-gap">\u2026</span>'
        : '<button class="' + (pg === current ? 'is-active' : '') + '" onclick="capLibPageGo(this, ' + pg + ')">' + pg + '</button>';
      }).join('')
      + '<button onclick="capLibPageGo(this, ' + (current + 1) + ')" ' + (current === pages ? 'disabled' : '') + '>\u203A</button>'
      + '<span class="cap-lib-pager-info">\u5171 ' + total + ' \u6761</span>'
      + '</div>';
  }

  function compressPages(cur, pages) {
    if (pages <= 7) return Array.from({ length: pages }, function (_, i) { return i + 1; });
    var out = [1];
    if (cur > 3) out.push('\u2026');
    for (var p = Math.max(2, cur - 1); p <= Math.min(pages - 1, cur + 1); p++) out.push(p);
    if (cur < pages - 2) out.push('\u2026');
    out.push(pages);
    return out;
  }

  function viewGroupsFor(el) {
    var host = el.closest('.cap-lib-lab-groups');
    if (host && host._capLibViewGroups) return host._capLibViewGroups;
    var labBody = el.closest('.cap-lib-lab-body');
    return (labBody && labBody._capLibGroups) || {};
  }

  window.capLibPageGo = function (btn, page) {
    var stbody = btn.closest('.cap-lib-stgroup-body');
    var group = btn.closest('.cap-lib-stgroup');
    var labBody = btn.closest('.cap-lib-lab-body');
    if (!stbody || !group || !labBody) return;
    var status = group.getAttribute('data-status');
    var list = viewGroupsFor(btn)[status] || [];
    var certNumber = labBody.dataset.cert || '';
    stbody.dataset.page = String(page);
    stbody.innerHTML = renderPagedTable(list, page, certNumber);
    stbody.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  };

  window.capLibSetPageSize = function (sel) {
    var v = parseInt(sel.value, 10);
    setPageSize(v);
    var labBody = sel.closest('.cap-lib-lab-body');
    if (!labBody) return;
    var certNumber = labBody.dataset.cert || '';
    labBody.querySelectorAll('.cap-lib-stgroup').forEach(function (group) {
      var stbody = group.querySelector('.cap-lib-stgroup-body');
      if (!stbody || !stbody.dataset.rendered) return;
      var status = group.getAttribute('data-status');
      var viewGroups = (group.closest('.cap-lib-lab-groups') && group.closest('.cap-lib-lab-groups')._capLibViewGroups) || labBody._capLibGroups || {};
      var list = viewGroups[status] || [];
      stbody.dataset.page = '1';
      stbody.innerHTML = renderPagedTable(list, 1, certNumber);
    });
  };

  window.capLibToggleStGroup = function (gid) {
    var stbody = document.getElementById(gid + '_body');
    var arrow = document.getElementById(gid + '_arrow');
    if (!stbody) return;
    if (stbody.style.display === 'none') {
      if (!stbody.dataset.rendered) {
        var group = stbody.closest('.cap-lib-stgroup');
        var labBody = stbody.closest('.cap-lib-lab-body');
        var status = group && group.getAttribute('data-status');
        var list = viewGroupsFor(stbody)[status] || [];
        var certNumber = (labBody && labBody.dataset.cert) || '';
        stbody.innerHTML = renderPagedTable(list, Number(stbody.dataset.page) || 1, certNumber);
        stbody.dataset.rendered = '1';
      }
      stbody.style.display = '';
      if (arrow) arrow.textContent = '\u25BE';
    } else {
      stbody.style.display = 'none';
      if (arrow) arrow.textContent = '\u25B8';
    }
  };

  function renderDiffRow(r, certNumber) {
    var meta = DIFF_STATUS_META[r.diffStatus] || { label: r.diffStatus, color: 'var(--text-3)', emoji: '\u00B7' };
    var note = r.diffStatus === 'series_only' && r.seriesNewCode
      ? '\u5EFA\u8BAE\u6539\u7528 <b>' + escHtml(r.seriesNewCode) + '</b>' + (r.seriesDomain ? ' \u00B7 ' + escHtml(r.seriesDomain) : '')
      : (r.libRemark ? escHtml(r.libRemark) : '');
    var items = (r.testItems && r.testItems.length ? r.testItems : (r.testItem ? [r.testItem] : []));
    var itemHtml = items.map(escHtml).join('\u3001');
    var codeAttr = escAttr(r.stdCode);
    var certAttr = escAttr(certNumber || '');
    var mappedTag = r.manualMapped ? ' <span class="cap-lib-mapped-tag" title="\u5DF2\u624B\u52A8\u6620\u5C04">\u270E</span>' : '';
    var isNotInLib = r.diffStatus === 'not_in_lib';
    var actions = '<div class="cap-lib-row-actions">'
      + (isNotInLib
          ? '<button class="cap-lib-row-act" onclick="capLibManualMap(\'' + certAttr + '\',\'' + codeAttr + '\')" title="\u624B\u52A8\u6307\u5B9A\u5E93\u5185\u6807\u51C6\u53F7">\u6307\u5B9A</button>'
          : '')
      + '<button class="cap-lib-row-act" onclick="capLibRematchRow(this,\'' + certAttr + '\',\'' + codeAttr + '\')" title="\u91CD\u65B0\u5339\u914D\u6B64\u6807\u51C6\u53F7">\u91CD\u8BD5</button>'
      + '<button class="cap-lib-row-act" onclick="capLibDiagnose(\'' + codeAttr + '\')" title="\u8BCA\u65AD\uFF1A\u5F52\u4E00\u5316\u503C + \u672C\u5730\u5E93\u547D\u4E2D + \u5404\u9886\u57DF\u540C\u6B65\u72B6\u6001">\u8BCA\u65AD</button>'
      + '</div>';
    return ''
      + '<tr class="cap-lib-diff-row" data-status="' + r.diffStatus + '" data-code="' + codeAttr + '">'
      + '<td class="cap-lib-row-pick"><input type="checkbox" class="cap-lib-row-check" data-code="' + codeAttr + '" onchange="capLibSyncCheckAll(this)" title="\u52FE\u9009\u540E\u53EF\u52A0\u5165\u9ED1\u540D\u5355"></td>'
      + '<td><span class="cap-lib-row-status" style="color:' + meta.color + '">' + meta.emoji + ' ' + escHtml(meta.label) + '</span></td>'
      + '<td class="cap-lib-row-code">' + escHtml(r.stdCode) + mappedTag + '</td>'
      + '<td>' + escHtml(r.stdName || '') + '</td>'
      + '<td><div class="cap-lib-row-cat">' + escHtml(r.category || '') + '</div><div class="cap-lib-row-item">' + itemHtml + '</div></td>'
      + '<td>' + note + '</td>'
      + '<td class="cap-lib-row-actcell">' + actions + '</td>'
      + '</tr>';
  }

  // ── 导出 ────────────────────────────────────────────────────────

  window.capLibExportDiff = async function (filter, btn) {
    if (btn) btn.disabled = true;
    try {
      var res = await fetch('/api/cma-diff/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(filter || { certNumbers: [] }),
      });
      if (!res.ok) {
        var txt = await res.text().catch(function () { return ''; });
        showToast('\u5BFC\u51FA\u5931\u8D25\uFF1A' + (txt || res.status), 'fail');
        return;
      }
      var blob = await res.blob();
      var cd = res.headers.get('Content-Disposition') || '';
      var m = cd.match(/filename\*=UTF-8''([^;]+)/);
      var fn = m ? decodeURIComponent(m[1]) : 'CMA\u4E00\u5355\u4E00\u5E93\u6BD4\u5BF9.xlsx';
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = fn; document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 100);
      showToast('\u5DF2\u5BFC\u51FA\uFF1A' + fn);
    } catch (e) {
      showToast('\u5BFC\u51FA\u5931\u8D25\uFF1A' + (e.message || e), 'fail');
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  // ── 黑名单 / 手动映射 / 重试 ───────────────────────────────────

  window.capLibToggleCheckAll = function (master) {
    var table = master.closest('table');
    if (!table) return;
    table.querySelectorAll('tbody .cap-lib-row-check').forEach(function (cb) { cb.checked = master.checked; });
  };

  window.capLibSyncCheckAll = function (row) {
    var table = row.closest('table');
    var master = table && table.querySelector('.cap-lib-row-checkall');
    if (!master) return;
    var all = Array.from(table.querySelectorAll('tbody .cap-lib-row-check'));
    var checked = all.filter(function (cb) { return cb.checked; }).length;
    master.checked = checked > 0 && checked === all.length;
    master.indeterminate = checked > 0 && checked < all.length;
  };

  window.capLibAddCheckedToBlacklist = async function (btn) {
    if (!isAdminUser()) { showToast('\u4EC5\u7BA1\u7406\u5458\u53EF\u64CD\u4F5C', 'fail'); return; }
    var scope = btn.closest('.cap-lib-stgroup-body') || document;
    var codes = Array.from(scope.querySelectorAll('.cap-lib-row-check:checked'))
      .map(function (cb) { return cb.getAttribute('data-code'); }).filter(Boolean);
    if (!codes.length) { showToast('\u672A\u52FE\u9009\u4EFB\u4F55\u884C', 'fail'); return; }
    if (!confirm('\u786E\u8BA4\u628A\u52FE\u9009\u7684 ' + codes.length + ' \u4E2A\u6807\u51C6\u53F7\u52A0\u5165\u9ED1\u540D\u5355\uFF1F\u52A0\u5165\u540E\u4E0D\u518D\u663E\u793A\u3001\u4E0D\u53C2\u4E0E\u5339\u914D\u3002')) return;
    btn.disabled = true;
    try {
      var res = await fetch('/api/cma-diff/blacklist', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: codes.map(function (c) { return { stdCode: c }; }) }),
      });
      if (!res.ok) { var t = await res.text(); showToast('\u52A0\u5165\u5931\u8D25\uFF1A' + (t || res.status), 'fail'); return; }
      var body = await readApiResponse(res);
      showToast('\u5DF2\u52A0\u5165\u9ED1\u540D\u5355 ' + (body.added || 0) + ' \u4E2A');
      if (window.capLibInvalidateCache) window.capLibInvalidateCache();
      reloadLabAfterChange(btn);
      if (window._cmaDiffRenderLabs) window._cmaDiffRenderLabs();
    } catch (e) { showToast('\u52A0\u5165\u5931\u8D25\uFF1A' + (e.message || e), 'fail'); }
    finally { btn.disabled = false; }
  };

  window.capLibManualMap = async function (certNumber, srcStdCode) {
    if (!isAdminUser()) { showToast('\u4EC5\u7BA1\u7406\u5458\u53EF\u64CD\u4F5C', 'fail'); return; }
    var libStdCode = await showPrompt({
      title: '\u6307\u5B9A\u5E93\u5185\u6807\u51C6',
      label: '\u4E3A\u300C' + srcStdCode + '\u300D\u6307\u5B9A\u56FD\u5BB6\u5E93\u4E2D\u7684\u6807\u51C6\u53F7',
      placeholder: 'GB/T 1234-2024',
      confirmText: '\u786E\u8BA4\u6307\u5B9A',
    });
    if (libStdCode == null) return;
    var v = libStdCode.trim();
    if (!v) { showToast('\u672A\u586B\u5199\u6807\u51C6\u53F7', 'fail'); return; }
    try {
      var res = await fetch('/api/cma-diff/manual-map', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ certNumber: certNumber, srcStdCode: srcStdCode, libStdCode: v }),
      });
      if (!res.ok) { var t = await res.text(); showToast('\u6307\u5B9A\u5931\u8D25\uFF1A' + (t || res.status), 'fail'); return; }
      showToast('\u5DF2\u6307\u5B9A\uFF0C\u6B63\u5728\u91CD\u65B0\u5339\u914D\u2026');
      await rematchAndReplaceRow(certNumber, srcStdCode);
    } catch (e) { showToast('\u6307\u5B9A\u5931\u8D25\uFF1A' + (e.message || e), 'fail'); }
  };

  window.capLibRematchRow = async function (btn, certNumber, stdCode) {
    if (btn) btn.disabled = true;
    try { await rematchAndReplaceRow(certNumber, stdCode); }
    finally { if (btn) btn.disabled = false; }
  };

  async function rematchAndReplaceRow(certNumber, stdCode) {
    try {
      var res = await fetch('/api/cma-diff/rematch', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ certNumber: certNumber, stdCode: stdCode }),
      });
      if (!res.ok) { var t = await res.text(); showToast('\u91CD\u8BD5\u5931\u8D25\uFF1A' + (t || res.status), 'fail'); return; }
      var body = await readApiResponse(res);
      var row = body && body.row;
      if (!row) { showToast('\u672A\u627E\u5230\u8BE5\u6807\u51C6\u53F7'); return; }
      capLibRecompareLab(certNumber);
      showToast('\u5DF2\u91CD\u65B0\u5339\u914D\uFF1A' + (DIFF_STATUS_META[row.diffStatus] && DIFF_STATUS_META[row.diffStatus].label || row.diffStatus));
    } catch (e) { showToast('\u91CD\u8BD5\u5931\u8D25\uFF1A' + (e.message || e), 'fail'); }
  }

  window.capLibRecompareLab = function (certNumber) {
    var gid = 'capLibLab_' + certNumber;
    var body = document.getElementById(gid + '_body');
    if (!body) return;
    body.dataset.loaded = '';
    body._capLibGroups = null;
    if (body.style.display !== 'none') {
      body.style.display = 'none';
      capLibToggleLab(certNumber);
    }
  };

  function reloadLabAfterChange(el) {
    var labBody = el.closest && el.closest('.cap-lib-lab-body');
    var cert = labBody && labBody.dataset.cert;
    if (cert) capLibRecompareLab(cert);
  }

  // ── 黑名单管理 ─────────────────────────────────────────────────

  window.capLibOpenBlacklist = async function () {
    var card = document.getElementById('capLibBlacklistCard');
    var bodyEl = document.getElementById('capLibBlacklistBody');
    if (!card || !bodyEl) return;
    card.style.display = '';
    card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    bodyEl.innerHTML = '<div style="color:var(--text-3)">\u52A0\u8F7D\u4E2D\u2026</div>';
    try {
      var res = await fetch('/api/cma-diff/blacklist');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await readApiResponse(res);
      var items = (data && data.items) || [];
      if (!items.length) {
        bodyEl.innerHTML = '<div style="color:var(--text-3)">\u9ED1\u540D\u5355\u4E3A\u7A7A\u3002\u5728\u673A\u6784\u5BF9\u6BD4\u8868\u91CC\u52FE\u9009\u810F\u884C\u70B9\u300C\u52FE\u9009\u9879\u52A0\u5165\u9ED1\u540D\u5355\u300D\u5373\u53EF\u6DFB\u52A0\u3002</div>';
        return;
      }
      var isAdmin = isAdminUser();
      var rows = items.map(function (it) {
        return '<label class="cap-lib-black-item">'
          + '<input type="checkbox" class="cap-lib-black-pick" data-id="' + it.id + '" ' + (isAdmin ? '' : 'disabled') + '>'
          + '<span class="cap-lib-row-code">' + escHtml(it.stdCode) + '</span>'
          + (it.reason ? '<span class="cap-lib-black-reason">' + escHtml(it.reason) + '</span>' : '')
          + '</label>';
      }).join('');
      var removeBtn = isAdmin
        ? '<button class="cap-lib-row-act" onclick="capLibRemoveBlacklist(this)">\u79FB\u9664\u52FE\u9009</button>'
        : '';
      bodyEl.innerHTML = '<div class="cap-lib-black-toolbar">' + removeBtn
        + '<span class="cap-lib-black-hint">\u5171 ' + items.length + ' \u6761</span></div>'
        + '<div class="cap-lib-black-list">' + rows + '</div>';
    } catch (e) {
      bodyEl.innerHTML = '<div style="color:var(--danger)">\u52A0\u8F7D\u5931\u8D25\uFF1A' + escHtml(e.message || String(e)) + '</div>';
    }
  };

  window.capLibRemoveBlacklist = async function (btn) {
    if (!isAdminUser()) return;
    var ids = Array.from(document.querySelectorAll('.cap-lib-black-pick:checked'))
      .map(function (cb) { return Number(cb.getAttribute('data-id')); }).filter(Boolean);
    if (!ids.length) { showToast('\u672A\u52FE\u9009\u4EFB\u4F55\u6761\u76EE', 'fail'); return; }
    btn.disabled = true;
    try {
      var res = await fetch('/api/cma-diff/blacklist', {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: ids }),
      });
      if (!res.ok) { var t = await res.text(); showToast('\u79FB\u9664\u5931\u8D25\uFF1A' + (t || res.status), 'fail'); return; }
      var body = await readApiResponse(res);
      showToast('\u5DF2\u79FB\u9664 ' + (body.removed || 0) + ' \u6761');
      capLibOpenBlacklist();
      if (window.capLibInvalidateCache) window.capLibInvalidateCache();
      if (window._cmaDiffRenderLabs) window._cmaDiffRenderLabs();
      if (window.loadCapLibPage) window.loadCapLibPage();
    } catch (e) { showToast('\u79FB\u9664\u5931\u8D25\uFF1A' + (e.message || e), 'fail'); }
    finally { btn.disabled = false; }
  };

  window.capLibCloseBlacklist = function () {
    var card = document.getElementById('capLibBlacklistCard');
    if (card) card.style.display = 'none';
  };

  // ── 诊断 ──────────────────────────────────────────────────────

  window.capLibDiagnose = async function (stdCode) {
    var card = document.getElementById('capLibDiagCard');
    var bodyEl = document.getElementById('capLibDiagBody');
    if (!card || !bodyEl) return;
    card.style.display = '';
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    bodyEl.innerHTML = '<div style="color:var(--text-3)">\u8BCA\u65AD\u4E2D\u2026</div>';
    try {
      var res = await fetch('/api/cma-diff/diagnose?stdCode=' + encodeURIComponent(stdCode));
      if (!res.ok) { var t = await res.text(); bodyEl.innerHTML = '<div style="color:var(--danger)">\u8BCA\u65AD\u5931\u8D25\uFF1A' + escHtml(t || res.status) + '</div>'; return; }
      var d = await readApiResponse(res);
      bodyEl.innerHTML = renderDiagnose(d);
    } catch (e) {
      bodyEl.innerHTML = '<div style="color:var(--danger)">\u8BCA\u65AD\u5931\u8D25\uFF1A' + escHtml(e.message || String(e)) + '</div>';
    }
  };

  window.capLibDiagnoseInput = function () {
    var inp = document.getElementById('capLibDiagInput');
    var v = inp && inp.value.trim();
    if (!v) { showToast('\u8BF7\u8F93\u5165\u6807\u51C6\u53F7', 'fail'); return; }
    capLibDiagnose(v);
  };

  window.capLibCloseDiag = function () {
    var card = document.getElementById('capLibDiagCard');
    if (card) card.style.display = 'none';
  };

  function renderDiagnose(d) {
    var fmt = function (s) { return s ? formatDateTime(s) : '\u4ECE\u672A'; };
    var exact = (d.exactMatches || []).map(function (m) {
      return '<li><span class="cap-lib-row-code">' + escHtml(m.stdCode) + '</span> \u00B7 ' + escHtml(m.domain) + ' \u00B7 ' + escHtml(m.libStatus) + (m.remark ? ' \u00B7 ' + escHtml(m.remark) : '') + ' <span style="color:var(--text-3)">(\u89C1\u4E8E ' + escHtml(fmt(m.lastSeenAt)) + ')</span></li>';
    }).join('');
    var series = (d.seriesMatches || []).map(function (m) {
      return '<li><span class="cap-lib-row-code">' + escHtml(m.stdCode) + '</span> \u00B7 ' + escHtml(m.domain) + ' \u00B7 ' + escHtml(m.libStatus) + '</li>';
    }).join('');
    var domains = (d.domainSyncState || []).map(function (s) {
      var stale = !s.lastSyncedAt;
      var short = s.localTotal < s.remoteTotal;
      var warn = stale ? '\u26A0 \u4ECE\u672A\u540C\u6B65' : (short ? '\u26A0 \u672C\u5730\u5C11\u4E8E\u8FDC\u7AEF' : '');
      return '<tr><td>' + escHtml(s.domain) + '</td><td>' + escHtml(fmt(s.lastSyncedAt)) + '</td><td>' + (s.localTotal || 0).toLocaleString() + ' / ' + (s.remoteTotal || 0).toLocaleString() + '</td><td style="color:var(--warning)">' + warn + '</td></tr>';
    }).join('');
    return ''
      + '<div class="cap-lib-diag-row"><b>\u8F93\u5165</b>\uFF1A' + escHtml(d.input) + '</div>'
      + '<div class="cap-lib-diag-row"><b>\u5F52\u4E00\u5316</b>\uFF1A\u6E05\u6D17=<code>' + escHtml(d.cleaned) + '</code> \u00B7 \u4FDD\u5E74=<code>' + escHtml(d.full) + '</code> \u00B7 \u5265\u5E74=<code>' + escHtml(d.base) + '</code></div>'
      + '<div class="cap-lib-diag-row"><b>\u672C\u5730\u5E93\u4FDD\u5E74\u547D\u4E2D</b>\uFF1A' + (exact ? '<ul class="cap-lib-diag-list">' + exact + '</ul>' : '<span style="color:var(--text-3)">\u65E0</span>') + '</div>'
      + (series ? '<div class="cap-lib-diag-row"><b>\u5265\u5E74(\u65B0\u5E74\u7248)\u547D\u4E2D</b>\uFF1A<ul class="cap-lib-diag-list">' + series + '</ul></div>' : '')
      + '<div class="cap-lib-diag-row"><b>\u9ED1\u540D\u5355</b>\uFF1A' + (d.blacklisted ? '<span style="color:var(--danger)">\u662F\uFF08\u5DF2\u6392\u9664\uFF09</span>' : '\u5426') + ' \u00B7 <b>\u624B\u52A8\u6620\u5C04</b>\uFF1A' + (d.manualMap ? escHtml(d.manualMap.libNorm) + (d.manualMap.certNumber ? '\uFF08\u673A\u6784 ' + escHtml(d.manualMap.certNumber) + '\uFF09' : '\uFF08\u5168\u5C40\uFF09') : '\u65E0') + '</div>'
      + '<div class="cap-lib-diag-verdict">' + escHtml(d.verdict) + '</div>'
      + '<details class="cap-lib-diag-domains"><summary>\u5404\u8BA2\u9605\u9886\u57DF\u540C\u6B65\u72B6\u6001\uFF08\u70B9\u5F00\uFF09</summary>'
      + '<table class="cap-lib-diff-table"><thead><tr><th>\u9886\u57DF</th><th>\u4E0A\u6B21\u540C\u6B65</th><th>\u672C\u5730/\u8FDC\u7AEF</th><th></th></tr></thead>'
      + '<tbody>' + (domains || '<tr><td colspan="4" style="color:var(--text-3)">\u65E0\u8BA2\u9605\u9886\u57DF</td></tr>') + '</tbody></table>'
      + '</details>';
  }

  // ── Cleanup（admin） ───────────────────────────────────────────

  window.capLibCleanup = async function () {
    if (!confirm('\u786E\u8BA4\u5220\u9664 30 \u5929\u672A\u5728\u8FDC\u7AEF\u51FA\u73B0\u7684\u672C\u5730\u6761\u76EE\uFF1F\u6B64\u64CD\u4F5C\u4E0D\u53EF\u6062\u590D\u3002')) return;
    try {
      var res = await fetch('/api/cma-diff/cleanup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ days: 30 }),
      });
      if (!res.ok) {
        var txt = await res.text();
        showToast('\u6E05\u7406\u5931\u8D25\uFF1A' + (txt || res.status), 'fail'); return;
      }
      var body = await readApiResponse(res);
      showToast('\u6E05\u7406\u5B8C\u6210\uFF1A\u5220\u9664 ' + (body.deleted || 0) + ' \u6761');
      if (window.capLibInvalidateCache) window.capLibInvalidateCache();
      window.loadCapLibPage();
    } catch (e) { showToast('\u6E05\u7406\u5931\u8D25\uFF1A' + (e.message || e), 'fail'); }
  };

})();
