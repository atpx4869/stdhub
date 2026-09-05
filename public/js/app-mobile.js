// app-mobile.js — 手机端布局切换 & 底部 tab bar 路由
//
// 与 app-core.js 的 switchTab() 解耦：本文件只负责
// (1) 检测视口宽度，给 <body> 加 layout-mobile / force-desktop class
// (2) ?desktop=1 URL 逃生口(给开发者 / 远程调试用,不暴露 UI 按钮)
// (3) 底部 mobile-tabbar 点击 -> 现有 switchTab()
// (4) 订阅 'tabchange' 事件，同步 tabbar 的 active 高亮
// (5) window.isMobile() 暴露给 legacy 脚本（app-search.js 等）做 guard
//
// 注:之前在 "我"页有 toggleDesktopLayout 按钮("切换到完整版"/"回到手机版"),
// 切到桌面布局后用户在桌面 sidebar 找不到回手机版的入口 → 切不回去 → 用户
// 反馈"纯纯多余"。已删除按钮 + 切换函数,只保留 ?desktop=1 URL 参数逃生口。
//
// CSS 侧：所有 ≤640px 规则用 body:not(.force-desktop) 包裹，保证桌面端
// 强制（URL）能完全绕过手机收敛。

(function() {
  'use strict';

  var MOBILE_BP = 640;
  var mobileTabHistory = [];
  var mobileHistoryBackInProgress = false;
  var edgeSwipe = null;

  // 清理历史残留:旧版本曾允许用户在"我"页 toggle 切换布局,把选择存在 localStorage
  // 'bzxz.layout'。该功能已删除(切到 desktop 后切不回的设计 bug)。残留值不主动清就
  // 会让升级用户继续被卡在桌面布局,这里启动时统一删除。
  try { localStorage.removeItem('bzxz.layout'); } catch (e) { /* ignore */ }

  function readForcedMode() {
    // 只读 URL ?desktop=1 / ?desktop=0(开发者/远程调试逃生口)。
    // 之前还读 localStorage,配合 "我" 页按钮切换 → 已删除(切到 desktop 后切不回的设计 bug)
    try {
      var params = new URLSearchParams(window.location.search);
      var v = params.get('desktop');
      if (v === '1') return 'desktop';
      if (v === '0') return 'mobile';
    } catch (e) { /* ignore */ }
    return null;
  }

  function viewportIsMobile() {
    try {
      return window.matchMedia('(max-width: ' + MOBILE_BP + 'px)').matches;
    } catch (e) {
      return window.innerWidth <= MOBILE_BP;
    }
  }

  // 真实生效的布局模式：受强制开关 + 视口宽度联合决定
  function getLayoutMode() {
    var forced = readForcedMode();
    if (forced === 'desktop') return 'desktop';
    if (forced === 'mobile') return 'mobile';
    return viewportIsMobile() ? 'mobile' : 'desktop';
  }

  function applyLayoutMode() {
    var mode = getLayoutMode();
    var forced = readForcedMode();
    var body = document.body;
    if (!body) return;

    // layout-mobile: 真实生效为手机版
    body.classList.toggle('layout-mobile', mode === 'mobile');

    // force-desktop: 视口本来是手机宽度，但被用户强制切到桌面
    // 该 class 用来让 CSS 的 @media (max-width:640px) body:not(.force-desktop)
    // 规则失效，避免桌面布局再被手机 CSS 收敛回去
    body.classList.toggle('force-desktop', forced === 'desktop' && viewportIsMobile());

    updateMobileTabbarVisibility(mode);
  }

  // 切换 mobile-tabbar 的可见性。
  // CSS 已经用 @media 自动隐藏/显示，这里仅保证 force-desktop 时强制不显示。
  function updateMobileTabbarVisibility(mode) {
    var bar = document.getElementById('mobileTabbar');
    if (!bar) return;
    // 让 CSS 决定主控，此处只在 force-desktop 时显式隐藏
    if (document.body.classList.contains('force-desktop')) {
      bar.style.display = 'none';
    } else {
      bar.style.display = '';
    }
  }

  // legacy 脚本 guard 入口：if (window.isMobile()) return;
  function isMobile() {
    return document.body && document.body.classList.contains('layout-mobile');
  }

  // ── 底部 tabbar 点击路由 ──
  function installMobileTabbar() {
    var bar = document.getElementById('mobileTabbar');
    if (!bar) return;
    bar.addEventListener('click', function(e) {
      var btn = e.target && e.target.closest ? e.target.closest('.mobile-tab') : null;
      if (!btn) return;
      var tab = btn.getAttribute('data-tab');
      if (!tab) return;
      if (typeof window.switchTab === 'function') {
        window.switchTab(tab);
      }
    });
  }

  // ── 同步 active 高亮 ──
  // app-core.js 的 switchTab() 末尾会 dispatch 'tabchange' 事件
  function syncTabbarActive(tab) {
    var tabs = document.querySelectorAll('#mobileTabbar .mobile-tab');
    for (var i = 0; i < tabs.length; i++) {
      var t = tabs[i];
      var active = t.getAttribute('data-tab') === tab;
      t.classList.toggle('active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }

  function currentTabFromLocation() {
    try { return new URLSearchParams(window.location.search).get('tab') || 'search'; }
    catch (e) { return 'search'; }
  }

  function rememberMobileTab(tab) {
    if (!tab) return;
    if (mobileHistoryBackInProgress) {
      mobileHistoryBackInProgress = false;
      return;
    }
    if (mobileTabHistory[mobileTabHistory.length - 1] !== tab) mobileTabHistory.push(tab);
    if (mobileTabHistory.length > 20) mobileTabHistory.shift();
  }

  function closeTopMobileLayer() {
    var preview = document.getElementById('previewOverlay');
    if (preview && preview.classList.contains('open')) {
      if (typeof window.closePreviewOverlay === 'function') window.closePreviewOverlay();
      else document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      return true;
    }
    var overlays = ['confirmOverlay', 'shortcutsOverlay', 'modalOverlay', 'filterDrawerOverlay'];
    for (var i = 0; i < overlays.length; i++) {
      var overlay = document.getElementById(overlays[i]);
      if (overlay && overlay.classList.contains('open')) {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
        return true;
      }
    }
    var center = document.getElementById('downloadCenterPanel');
    if (center && center.classList.contains('open')) {
      if (typeof window.toggleDownloadCenter === 'function') window.toggleDownloadCenter(false);
      return true;
    }
    var dropdown = document.getElementById('userDropdown');
    if (dropdown && dropdown.classList.contains('open')) { dropdown.classList.remove('open'); return true; }
    var openMenu = document.querySelector('.local-row-menu[open], .page-action-menu[open]');
    if (openMenu) { openMenu.open = false; return true; }
    return false;
  }

  function navigateMobileBack() {
    if (closeTopMobileLayer()) return;
    if (mobileTabHistory.length > 1 && typeof window.switchTab === 'function') {
      mobileTabHistory.pop();
      var previousTab = mobileTabHistory[mobileTabHistory.length - 1];
      mobileHistoryBackInProgress = true;
      window.switchTab(previousTab);
      return;
    }
    if (window.history.length > 1) window.history.back();
  }

  function installEdgeSwipeBack() {
    document.addEventListener('touchstart', function(event) {
      if (!isMobile() || event.touches.length !== 1) { edgeSwipe = null; return; }
      var touch = event.touches[0];
      edgeSwipe = touch.clientX <= 28 ? { x: touch.clientX, y: touch.clientY, time: Date.now(), horizontal: false } : null;
    }, { passive: true });
    document.addEventListener('touchmove', function(event) {
      if (!edgeSwipe || event.touches.length !== 1) { edgeSwipe = null; return; }
      var touch = event.touches[0];
      var dx = touch.clientX - edgeSwipe.x;
      var dy = touch.clientY - edgeSwipe.y;
      if (Math.abs(dy) > 70 && Math.abs(dy) > Math.abs(dx)) { edgeSwipe = null; return; }
      if (dx > 12 && Math.abs(dx) > Math.abs(dy) * 1.25) { edgeSwipe.horizontal = true; event.preventDefault(); }
    }, { passive: false });
    document.addEventListener('touchend', function(event) {
      if (!edgeSwipe || !event.changedTouches.length) { edgeSwipe = null; return; }
      var touch = event.changedTouches[0];
      var dx = touch.clientX - edgeSwipe.x;
      var dy = Math.abs(touch.clientY - edgeSwipe.y);
      var elapsed = Date.now() - edgeSwipe.time;
      var shouldGoBack = edgeSwipe.horizontal && dx >= 84 && dy <= 80 && elapsed <= 900;
      edgeSwipe = null;
      if (shouldGoBack) navigateMobileBack();
    }, { passive: true });
    document.addEventListener('touchcancel', function() { edgeSwipe = null; }, { passive: true });
  }

  // ── 启动 ──
  function init() {
    applyLayoutMode();
    installMobileTabbar();
    installEdgeSwipeBack();
    rememberMobileTab(currentTabFromLocation());
    window.addEventListener('resize', applyLayoutMode);
    window.addEventListener('tabchange', function(e) {
      var tab = e && e.detail && e.detail.tab;
      if (tab) { syncTabbarActive(tab); rememberMobileTab(tab); }
    });
    // 下拉刷新：搜索结果和文件库
    if (typeof window.enablePullRefresh === 'function') {
      window.enablePullRefresh('#results', function() {
        if (typeof doSearch === 'function') doSearch();
      });
      window.enablePullRefresh('#fileLibraryList', function() {
        if (typeof refreshFileLibrary === 'function') refreshFileLibrary();
      });
    }
  }

  // 暴露 API（legacy 全局风格，避免引入模块系统）
  window.isMobile = isMobile;
  window.getLayoutMode = getLayoutMode;
  window.applyLayoutMode = applyLayoutMode;
  window.navigateMobileBack = navigateMobileBack;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
