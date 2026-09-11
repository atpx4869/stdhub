// app-command-palette.js — Command Palette (Ctrl+K / ⌘K)
// V3 UI R2: 全局命令面板，快速导航 + 快捷动作 + 搜索入口
//
// 公开 API:
//   window.StdHub.commandPalette.open()
//   window.StdHub.commandPalette.close()
//   window.StdHub.commandPalette.toggle()
//
// 键盘：↑↓ 选择、Enter 确认、Esc 关闭、焦点圈闭
// 生命周期：StdHub.lifecycle.register('commandPalette', ...)

(function () {
  'use strict';

  var root = (window.StdHub = window.StdHub || {});

  /* ── 常量 ── */
  var OVERLAY_CLASS   = 'cmd-palette-overlay';
  var PALETTE_CLASS   = 'cmd-palette';
  var INPUT_CLASS     = 'cmd-palette-input';
  var RESULTS_CLASS   = 'cmd-palette-results';
  var ITEM_CLASS      = 'cmd-palette-item';
  var ITEM_ACTIVE_CLS = 'cmd-palette-item--active';
  var KBD_CLASS       = 'cmd-palette-kbd';
  var GROUP_CLASS     = 'cmd-palette-group';
  var GROUP_LABEL_CLS = 'cmd-palette-group-label';
  var EMPTY_CLASS     = 'cmd-palette-empty';

  /* ── 9 个功能面 ── */
  var NAV_ITEMS = [
    { id: 'search',   label: '标准检索',  desc: '搜索和下载标准',       icon: 'ti ti-search',         keywords: '标准 检索 搜索 search' },
    { id: 'qual',     label: '资质查询',  desc: 'CNAS/CMA 资质',       icon: 'ti ti-shield-check',    keywords: '资质 认证 CNAS CMA qualification' },
    { id: 'cma-diff', label: 'CMA 一单一库', desc: '资质 vs 国家库比对', icon: 'ti ti-columns-3',       keywords: 'CMA 一单一库 比对 diff' },
    { id: 'local',    label: '本地文件库', desc: '已下载标准管理',       icon: 'ti ti-folders',         keywords: '本地 文件 库 文件库 local' },
    { id: 'history',  label: '下载历史',  desc: '查看下载记录',         icon: 'ti ti-history',         keywords: '历史 下载 记录 history' },
    { id: 'tools',    label: '工具箱',    desc: '查新/批量/补全',       icon: 'ti ti-tool',            keywords: '工具 管家 批量 查新 补全 tools' },
    { id: 'logs',     label: '运行日志',  desc: '搜索/下载/同步记录',   icon: 'ti ti-logs',            keywords: '日志 运行 log logs' },
    { id: 'stats',    label: '使用统计',  desc: '查看使用数据',         icon: 'ti ti-chart-histogram', keywords: '统计 使用 stats' },
    { id: 'settings', label: '系统设置',  desc: '下载参数和源',         icon: 'ti ti-settings',        keywords: '设置 配置 settings' },
  ];

  /* ── 快捷动作 ── */
  var THEME_ACTIONS = [
    { id: 'theme-dark',  label: '切换深色主题',  icon: 'ti ti-moon',       keywords: '深色 dark 暗色 主题' },
    { id: 'theme-light', label: '切换浅色主题',  icon: 'ti ti-sun',        keywords: '浅色 light 亮色 主题' },
    { id: 'theme-paper', label: '切换 Paper 主题', icon: 'ti ti-file-text', keywords: 'paper 纸 主题' },
    { id: 'theme-legacy', label: '切换经典主题', icon: 'ti ti-diamond',    keywords: '经典 legacy 传统 主题' },
  ];

  var QUICK_ACTIONS = [
    { id: 'task-center', label: '打开任务中心', desc: '查看下载任务', icon: 'ti ti-list-check', keywords: '任务 下载中心 task center' },
  ];

  /* ── DOM ── */
  var overlay  = null;
  var palette  = null;
  var input    = null;
  var listbox  = null;
  var activeIndex = -1;
  var filtered = [];
  var isOpen   = false;
  var triggerBtn = null; // 保存触发元素，关闭时还原焦点
  var _disposeReg = null;

  /* ── 创建 DOM ── */
  function buildDOM() {
    overlay = document.createElement('div');
    overlay.className = OVERLAY_CLASS;
    overlay.setAttribute('aria-hidden', 'true');

    palette = document.createElement('div');
    palette.className = PALETTE_CLASS;
    palette.setAttribute('role', 'dialog');
    palette.setAttribute('aria-modal', 'true');
    palette.setAttribute('aria-label', '命令面板');

    // 搜索区
    var searchWrap = document.createElement('div');
    searchWrap.className = 'cmd-palette-search';

    var searchIcon = document.createElement('i');
    searchIcon.className = 'ti ti-search cmd-palette-search-icon';
    searchIcon.setAttribute('aria-hidden', 'true');

    input = document.createElement('input');
    input.type = 'text';
    input.className = INPUT_CLASS;
    input.placeholder = '搜索功能、切换主题、输入标准号…';
    input.setAttribute('aria-label', '搜索命令');
    input.setAttribute('autocomplete', 'off');
    input.setAttribute('spellcheck', 'false');

    var kbdHint = document.createElement('span');
    kbdHint.className = KBD_CLASS;
    kbdHint.innerHTML = '<kbd>Esc</kbd>';

    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(input);
    searchWrap.appendChild(kbdHint);

    // 结果列表
    listbox = document.createElement('div');
    listbox.className = RESULTS_CLASS;
    listbox.setAttribute('role', 'listbox');
    listbox.setAttribute('aria-label', '命令列表');

    palette.appendChild(searchWrap);
    palette.appendChild(listbox);
    overlay.appendChild(palette);
    document.body.appendChild(overlay);

    // 事件绑定
    overlay.addEventListener('mousedown', onOverlayMouseDown);
    input.addEventListener('input', onInput);
    input.addEventListener('keydown', onInputKeydown);
    palette.addEventListener('keydown', onPaletteKeydown);
  }

  /* ── 过滤 & 匹配 ── */
  function normalize(s) { return (s || '').toLowerCase().trim(); }

  function buildAllItems() {
    var all = [];
    // 分组：导航
    NAV_ITEMS.forEach(function (item) {
      all.push({ type: 'nav', group: '功能导航', id: item.id, label: item.label, desc: item.desc, icon: item.icon, keywords: item.keywords });
    });
    // 分组：快捷动作
    THEME_ACTIONS.forEach(function (item) {
      all.push({ type: 'action', group: '快捷动作', id: item.id, label: item.label, desc: item.desc, icon: item.icon, keywords: item.keywords });
    });
    QUICK_ACTIONS.forEach(function (item) {
      all.push({ type: 'action', group: '快捷动作', id: item.id, label: item.label, desc: item.desc, icon: item.icon, keywords: item.keywords });
    });
    return all;
  }

  function filterItems(query) {
    var q = normalize(query);
    var all = buildAllItems();

    if (!q) return all;

    return all.filter(function (item) {
      var haystack = normalize(item.label + ' ' + (item.desc || '') + ' ' + (item.keywords || ''));
      // 逐字匹配
      return q.split(/\s+/).every(function (word) { return haystack.indexOf(word) >= 0; });
    });
  }

  /* ── 渲染结果 ── */
  function renderResults(query) {
    filtered = filterItems(query);
    listbox.innerHTML = '';
    activeIndex = -1;

    if (filtered.length === 0) {
      // 提供「检索 "xxx"」动作
      if (query.trim()) {
        filtered = [{
          type: 'search',
          group: '标准检索',
          id: '__search__',
          label: '检索 "' + escapeHtml(query.trim()) + '"',
          desc: '跳转搜索页并执行检索',
          icon: 'ti ti-search',
          _query: query.trim(),
        }];
        renderGrouped(filtered);
        setActive(0);
      } else {
        var empty = document.createElement('div');
        empty.className = EMPTY_CLASS;
        empty.textContent = '输入关键词开始搜索';
        listbox.appendChild(empty);
      }
      return;
    }

    // 有导航命中时，如果输入非空也追加「检索」
    if (query.trim()) {
      filtered.push({
        type: 'search',
        group: '标准检索',
        id: '__search__',
        label: '检索 "' + escapeHtml(query.trim()) + '"',
        desc: '跳转搜索页并执行检索',
        icon: 'ti ti-search',
        _query: query.trim(),
      });
    }

    renderGrouped(filtered);
    setActive(0);
  }

  function renderGrouped(items) {
    var currentGroup = '';
    items.forEach(function (item, index) {
      if (item.group !== currentGroup) {
        currentGroup = item.group;
        var groupLabel = document.createElement('div');
        groupLabel.className = GROUP_LABEL_CLS;
        groupLabel.textContent = currentGroup;
        listbox.appendChild(groupLabel);
      }
      var el = document.createElement('div');
      el.className = ITEM_CLASS;
      el.setAttribute('role', 'option');
      el.setAttribute('data-index', index);
      el.setAttribute('aria-selected', 'false');
      el.id = 'cmd-palette-item-' + index;

      var iconEl = document.createElement('i');
      iconEl.className = item.icon + ' cmd-palette-item-icon';
      iconEl.setAttribute('aria-hidden', 'true');

      var textWrap = document.createElement('div');
      textWrap.className = 'cmd-palette-item-text';

      var labelEl = document.createElement('span');
      labelEl.className = 'cmd-palette-item-label';
      labelEl.innerHTML = item.label;

      textWrap.appendChild(labelEl);
      if (item.desc) {
        var descEl = document.createElement('span');
        descEl.className = 'cmd-palette-item-desc';
        descEl.textContent = item.desc;
        textWrap.appendChild(descEl);
      }

      el.appendChild(iconEl);
      el.appendChild(textWrap);

      // 右侧快捷键提示
      if (item.type === 'nav') {
        var kbd = document.createElement('span');
        kbd.className = KBD_CLASS + ' cmd-palette-item-kbd';
        kbd.innerHTML = '<kbd>↵</kbd>';
        el.appendChild(kbd);
      }

      el.addEventListener('mouseenter', function () { setActive(index); });
      el.addEventListener('click', function (e) { e.preventDefault(); executeItem(index); });

      listbox.appendChild(el);
    });
  }

  /* ── 活跃项管理 ── */
  function setActive(index) {
    var items = listbox.querySelectorAll('.' + ITEM_CLASS);
    items.forEach(function (el) { el.classList.remove(ITEM_ACTIVE_CLS); el.setAttribute('aria-selected', 'false'); });
    if (index >= 0 && index < items.length) {
      items[index].classList.add(ITEM_ACTIVE_CLS);
      items[index].setAttribute('aria-selected', 'true');
      items[index].scrollIntoView({ block: 'nearest' });
      activeIndex = index;
      input.setAttribute('aria-activedescendant', items[index].id);
    } else {
      activeIndex = -1;
      input.removeAttribute('aria-activedescendant');
    }
  }

  function moveActive(delta) {
    var items = listbox.querySelectorAll('.' + ITEM_CLASS);
    if (!items.length) return;
    var next = activeIndex + delta;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    setActive(next);
  }

  /* ── 执行动作 ── */
  function executeItem(index) {
    var item = filtered[index];
    if (!item) return;

    close();

    switch (item.type) {
      case 'nav':
        if (typeof window.switchTab === 'function') window.switchTab(item.id);
        break;
      case 'action':
        executeAction(item.id);
        break;
      case 'search':
        navigateAndSearch(item._query);
        break;
    }
  }

  function executeAction(id) {
    switch (id) {
      case 'theme-dark':
      case 'theme-light':
      case 'theme-paper':
      case 'theme-legacy':
        var theme = id.replace('theme-', '');
        if (window.bzxzTheme && typeof window.bzxzTheme.set === 'function') {
          window.bzxzTheme.set(theme);
        }
        break;
      case 'task-center':
        if (typeof window.toggleDownloadCenter === 'function') {
          window.toggleDownloadCenter(true);
        }
        break;
    }
  }

  function navigateAndSearch(query) {
    // 先切到搜索页
    if (typeof window.switchTab === 'function') window.switchTab('search');
    // 延迟一帧让页面显示后再填值并搜索
    requestAnimationFrame(function () {
      var searchInput = document.getElementById('searchInput');
      if (searchInput) {
        searchInput.value = query;
        searchInput.focus();
        // 触发搜索
        var searchBtn = document.getElementById('searchBtn');
        if (searchBtn) searchBtn.click();
      }
    });
  }

  /* ── 打开/关闭 ── */
  function open(triggerEl) {
    if (isOpen) return;
    if (!overlay) buildDOM();

    triggerBtn = triggerEl || document.activeElement;
    isOpen = true;
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    input.value = '';
    renderResults('');
    // 焦点入输入框
    requestAnimationFrame(function () { input.focus(); });
    document.addEventListener('keydown', onGlobalKeydown, true);

    // 注册生命周期清理
    _disposeReg = root.lifecycle && root.lifecycle.register
      ? root.lifecycle.register('commandPalette', 'overlay', close)
      : null;
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    document.removeEventListener('keydown', onGlobalKeydown, true);
    // 焦点还原到触发按钮
    if (triggerBtn && typeof triggerBtn.focus === 'function') {
      triggerBtn.focus();
    }
    triggerBtn = null;

    if (_disposeReg) { _disposeReg(); _disposeReg = null; }
  }

  function toggle(triggerEl) {
    if (isOpen) close();
    else open(triggerEl);
  }

  /* ── 事件处理 ── */
  function onOverlayMouseDown(e) {
    // 点击遮罩关闭
    if (e.target === overlay) close();
  }

  function onInput() {
    renderResults(input.value);
  }

  function onInputKeydown(e) {
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        moveActive(1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        moveActive(-1);
        break;
      case 'Enter':
        e.preventDefault();
        if (activeIndex >= 0) executeItem(activeIndex);
        break;
      case 'Escape':
        e.preventDefault();
        close();
        break;
      case 'Tab':
        // 焦点圈闭：Tab 在 palette 内循环
        e.preventDefault();
        moveActive(e.shiftKey ? -1 : 1);
        break;
    }
  }

  function onPaletteKeydown(e) {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  function onGlobalKeydown(e) {
    if (e.key === 'Escape' && isOpen) {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  }

  /* ── 全局快捷键 ── */
  function registerGlobalShortcut() {
    document.addEventListener('keydown', function (e) {
      // Ctrl+K / Cmd+K
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        // 不在 textarea / contentEditable 内时
        var tag = (e.target.tagName || '').toLowerCase();
        if (tag === 'textarea' || e.target.isContentEditable) return;
        e.preventDefault();
        toggle();
      }
    }, true);
  }

  /* ── 工具函数 ── */
  function escapeHtml(str) {
    var el = document.createElement('span');
    el.textContent = str;
    return el.innerHTML;
  }

  /* ── 启动 ── */
  function init() {
    registerGlobalShortcut();

    // 绑定触发按钮（如果存在）
    var trigger = document.querySelector('.cmd-palette-trigger');
    if (trigger) {
      trigger.addEventListener('click', function (e) {
        e.preventDefault();
        open(trigger);
      });
    }
  }

  // DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* ── 暴露 ── */
  root.commandPalette = {
    open: open,
    close: close,
    toggle: toggle,
  };
})();
