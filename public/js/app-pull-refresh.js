// app-pull-refresh.js — 手机端下拉刷新组件
// 在指定页面容器上启用下拉刷新手势

(function() {
  'use strict';

  const THRESHOLD = 80;     // 触发刷新的下拉距离(px)
  const MAX_PULL = 120;     // 最大下拉距离
  const RESISTANCE = 0.5;   // 阻尼系数

  function enablePullRefresh(selector, onRefresh) {
    const el = document.querySelector(selector);
    if (!el) return;

    let startY = 0;
    let pulling = false;
    let indicator = null;

    // 创建刷新指示器
    function createIndicator() {
      if (indicator) return indicator;
      indicator = document.createElement('div');
      indicator.className = 'pull-refresh-indicator';
      indicator.innerHTML = '<span class="pull-refresh-spinner"></span><span class="pull-refresh-text">下拉刷新</span>';
      el.parentNode.insertBefore(indicator, el);
      return indicator;
    }

    function updateIndicator(pullDistance) {
      const ind = createIndicator();
      const progress = Math.min(pullDistance / THRESHOLD, 1);
      ind.style.transform = `translateY(${pullDistance - 40}px)`;
      ind.style.opacity = progress;
      const text = ind.querySelector('.pull-refresh-text');
      if (pullDistance >= THRESHOLD) {
        text.textContent = '释放刷新';
        ind.classList.add('pull-refresh-ready');
      } else {
        text.textContent = '下拉刷新';
        ind.classList.remove('pull-refresh-ready');
      }
    }

    function showRefreshing() {
      const ind = createIndicator();
      ind.classList.add('pull-refresh-active');
      ind.style.transform = `translateY(${THRESHOLD - 40}px)`;
      ind.style.opacity = '1';
      ind.querySelector('.pull-refresh-text').textContent = '刷新中…';
    }

    function hideIndicator() {
      if (indicator) {
        indicator.classList.remove('pull-refresh-active', 'pull-refresh-ready');
        indicator.style.transform = 'translateY(-40px)';
        indicator.style.opacity = '0';
        setTimeout(() => {
          if (indicator && indicator.parentNode) {
            indicator.parentNode.removeChild(indicator);
            indicator = null;
          }
        }, 300);
      }
    }

    // 只在手机端启用
    function isMobile() {
      return window.matchMedia('(max-width: 640px)').matches &&
        !document.body.classList.contains('force-desktop');
    }

    el.addEventListener('touchstart', function(e) {
      if (!isMobile()) return;
      if (el.scrollTop > 5) return; // 已滚动则不触发
      startY = e.touches[0].clientY;
      pulling = true;
    }, { passive: true });

    el.addEventListener('touchmove', function(e) {
      if (!pulling || !isMobile()) return;
      const deltaY = e.touches[0].clientY - startY;
      if (deltaY <= 0) { pulling = false; return; }
      const pull = deltaY * RESISTANCE;
      if (pull > 5) {
        e.preventDefault();
        updateIndicator(pull);
      }
    }, { passive: false });

    el.addEventListener('touchend', function() {
      if (!pulling) return;
      pulling = false;
      const ind = indicator;
      if (ind && ind.classList.contains('pull-refresh-ready')) {
        showRefreshing();
        Promise.resolve(onRefresh()).finally(() => {
          setTimeout(hideIndicator, 500);
        });
      } else {
        hideIndicator();
      }
    }, { passive: true });
  }

  // 暴露全局 API
  window.enablePullRefresh = enablePullRefresh;
})();
