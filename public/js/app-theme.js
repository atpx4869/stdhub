// app-theme.js — 主题切换(dark / light / paper / legacy),所有用户可用
//
// 设计:
//  - 四主题:dark(默认) / light(Arctic Blue 蓝调) / paper(Claude Linen 温暖印刷品)
//    / legacy(Win7 / Chrome ≤109 兜底,全 hex 调色 + 无 backdrop-filter + 系统字体)
//  - 持久化:localStorage 'bzxz.theme'
//  - 切换载体:<html data-theme="dark|light|paper|legacy">
//  - legacy 自动触发:index.html FOUC 内联 script 检测 UA(Win NT 5.x/6.x 或 Chrome ≤109)
//    → 自动写入 localStorage 兜底,首次进入即生效
//  - 入口:
//    - 手机「我」页:4 chip 行,4 选 1 显式切换
//    - 桌面 topbar:icon 按钮点击展开 picker(4 项菜单),不再 toggle 两态
//  - 避免 FOUC:public/index.html + web/index.html <head> 顶部加内联 script
//
// 公开 API:
//   window.bzxzTheme.get()             返回 'dark' | 'light' | 'paper' | 'legacy'
//   window.bzxzTheme.set(theme)        切换 + persist
//   window.bzxzTheme.toggle()          legacy 接口(只在 dark<->light 切,其它走 set)
//   window.bzxzTheme.togglePicker()    展开/关闭 topbar picker
//   syncThemeUI()                      让所有 UI(我页 chip / topbar icon / picker
//                                       active 态)反映当前
//
// 事件:CustomEvent('themechange', { detail: { theme } }) 派发到 document

(function() {
  'use strict';

  var KEY = 'bzxz.theme';
  var VALID = ['dark', 'light', 'paper', 'legacy'];

  var THEME_META = {
    dark:   { iconClass: 'ti-moon', label: '深色' },
    light:  { iconClass: 'ti-sun', label: '浅色' },
    paper:  { iconClass: 'ti-file-text', label: 'Paper' },
    legacy: { iconClass: 'ti-diamond', label: '经典' },
  };

  function getTheme() {
    try {
      var t = localStorage.getItem(KEY);
      return VALID.indexOf(t) >= 0 ? t : 'dark';
    } catch (e) { return 'dark'; }
  }

  function setTheme(theme) {
    if (VALID.indexOf(theme) < 0) theme = 'dark';
    try { localStorage.setItem(KEY, theme); } catch (e) { /* ignore */ }
    document.documentElement.setAttribute('data-theme', theme);
    closePicker();
    syncThemeUI();
    try {
      document.dispatchEvent(new CustomEvent('themechange', { detail: { theme: theme } }));
    } catch (e) { /* ignore */ }
  }

  /** legacy 接口:dark<->light 两态切换。paper / legacy 主题用户走 set() 或 picker */
  function toggleTheme() {
    var cur = getTheme();
    if (cur === 'paper' || cur === 'legacy') setTheme('dark');  // 非 dark/light 主题兜底回 dark
    else setTheme(cur === 'light' ? 'dark' : 'light');
  }

  function openPicker() {
    var picker = document.getElementById('topbarThemePicker');
    if (picker) picker.classList.add('open');
  }
  function closePicker() {
    var picker = document.getElementById('topbarThemePicker');
    if (picker) picker.classList.remove('open');
  }
  function togglePicker() {
    var picker = document.getElementById('topbarThemePicker');
    if (!picker) { toggleTheme(); return; } // picker 不存在 → 退回 toggle
    if (picker.classList.contains('open')) closePicker();
    else openPicker();
  }

  function syncThemeUI() {
    var theme = getTheme();
    var meta = THEME_META[theme] || THEME_META.dark;
    // 「我」页 chip
    var chips = document.querySelectorAll('.me-theme-btn');
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      c.classList.toggle('active', c.getAttribute('data-theme') === theme);
    }
    // topbar 当前主题 icon 按钮
    var toggleBtn = document.getElementById('topbarThemeToggle');
    if (toggleBtn) {
      toggleBtn.innerHTML = '<i class="ti ' + meta.iconClass + '" aria-hidden="true"></i>';
      toggleBtn.setAttribute('title', '切换主题:' + meta.label);
      toggleBtn.setAttribute('aria-label', '当前 ' + meta.label + ',点击切换');
    }
    // topbar picker 内项 active 高亮
    var pickerItems = document.querySelectorAll('#topbarThemePicker [data-theme]');
    for (var j = 0; j < pickerItems.length; j++) {
      var pi = pickerItems[j];
      pi.classList.toggle('active', pi.getAttribute('data-theme') === theme);
    }
  }

  // 启动:防御性再次应用(head 内联 script 已经设过,这里兜底处理 race)
  document.documentElement.setAttribute('data-theme', getTheme());

  // 点击 picker 外部时关闭
  document.addEventListener('click', function(e) {
    var picker = document.getElementById('topbarThemePicker');
    if (!picker || !picker.classList.contains('open')) return;
    var toggle = document.getElementById('topbarThemeToggle');
    if (picker.contains(e.target)) return;       // 点 picker 内部不关
    if (toggle && toggle.contains(e.target)) return; // 点 toggle 自己交给 togglePicker 处理
    closePicker();
  });

  // DOM ready 后同步 UI
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncThemeUI);
  } else {
    syncThemeUI();
  }

  // 暴露
  window.bzxzTheme = {
    get: getTheme, set: setTheme, toggle: toggleTheme,
    togglePicker: togglePicker, openPicker: openPicker, closePicker: closePicker,
  };
  window.syncThemeUI = syncThemeUI;
})();
