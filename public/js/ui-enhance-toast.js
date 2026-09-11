/**
 * StdHub UI Enhancement — Toast Notification System
 * 
 * Lightweight toast notifications with auto-dismiss, stacking, and tone support.
 * Replaces ad-hoc alert() / status messages with consistent UI.
 * 
 * Usage:
 *   StdHub.toast.success('下载完成')
 *   StdHub.toast.error('连接失败', { duration: 5000 })
 *   StdHub.toast.info('正在同步…', { persistent: true })
 */
(function () {
  'use strict';

  var ns = (window.StdHub = window.StdHub || {});

  var CONTAINER_CLASS = 'ui-toast-container';
  var STACK_LIMIT = 5;
  var DEFAULT_DURATION = 3500;
  var FADE_DURATION = 220;

  var container = null;
  var queue = [];

  function ensureContainer() {
    if (container && document.body.contains(container)) return container;
    container = document.createElement('div');
    container.className = CONTAINER_CLASS;
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('aria-atomic', 'false');
    // Styles
    var s = container.style;
    s.position = 'fixed';
    s.top = 'calc(var(--topbar-h, 56px) + 12px)';
    s.right = '16px';
    s.zIndex = '9999';
    s.display = 'flex';
    s.flexDirection = 'column';
    s.gap = '8px';
    s.maxWidth = '380px';
    s.width = '100%';
    s.pointerEvents = 'none';
    document.body.appendChild(container);
    return container;
  }

  function createToastEl(message, opts) {
    opts = opts || {};
    var tone = opts.tone || 'info';
    var duration = typeof opts.duration === 'number' ? opts.duration : DEFAULT_DURATION;
    var persistent = !!opts.persistent;

    var icons = {
      success: 'ti ti-circle-check',
      error:   'ti ti-alert-circle',
      warning: 'ti ti-alert-triangle',
      info:    'ti ti-info-circle'
    };

    var el = document.createElement('div');
    el.className = 'ui-toast ui-toast-' + tone;
    el.setAttribute('role', 'status');

    // Styles
    var s = el.style;
    s.display = 'flex';
    s.alignItems = 'center';
    s.gap = '10px';
    s.padding = '12px 16px';
    s.borderRadius = 'var(--radius, 10px)';
    s.background = 'var(--surface-elevated, var(--surface))';
    s.border = '1px solid var(--border, rgba(255,255,255,0.1))';
    s.boxShadow = '0 8px 24px rgba(0,0,0,0.25)';
    s.backdropFilter = 'blur(16px)';
    s.webkitBackdropFilter = 'blur(16px)';
    s.color = 'var(--text, #e4e6ea)';
    s.fontSize = '13px';
    s.fontFamily = "'DM Sans', sans-serif";
    s.fontWeight = '500';
    s.lineHeight = '1.4';
    s.pointerEvents = 'auto';
    s.cursor = 'default';
    s.animation = 'toastIn 250ms var(--ease-out, cubic-bezier(0.16,1,0.3,1)) both';
    s.borderLeft = '3px solid var(--accent, #4f6df0)';

    // Tone colors
    var toneColors = {
      success: 'var(--success, #36b988)',
      error:   'var(--danger, #d75541)',
      warning: 'var(--warning, #cba03e)',
      info:    'var(--accent, #4f6df0)'
    };
    s.borderLeftColor = toneColors[tone] || toneColors.info;

    // Icon
    var iconEl = document.createElement('i');
    iconEl.className = (icons[tone] || icons.info) + ' ui-toast-icon';
    iconEl.setAttribute('aria-hidden', 'true');
    iconEl.style.fontSize = '16px';
    iconEl.style.flexShrink = '0';
    iconEl.style.color = toneColors[tone] || toneColors.info;

    // Message
    var msgEl = document.createElement('span');
    msgEl.className = 'ui-toast-msg';
    msgEl.style.flex = '1';
    msgEl.textContent = message;

    // Close button
    var closeBtn = document.createElement('button');
    closeBtn.className = 'ui-toast-close';
    closeBtn.innerHTML = '×';
    closeBtn.setAttribute('aria-label', '关闭');
    var cs = closeBtn.style;
    cs.background = 'none';
    cs.border = 'none';
    cs.color = 'var(--text-3, #696d77)';
    cs.fontSize = '18px';
    cs.cursor = 'pointer';
    cs.padding = '0 2px';
    cs.lineHeight = '1';
    cs.flexShrink = '0';
    cs.width = '24px';
    cs.height = '24px';
    cs.display = 'flex';
    cs.alignItems = 'center';
    cs.justifyContent = 'center';
    cs.borderRadius = '50%';
    cs.transition = 'color 0.15s, background 0.15s';

    closeBtn.onmouseenter = function () {
      this.style.color = 'var(--text, #e4e6ea)';
      this.style.background = 'var(--surface-h, rgba(255,255,255,0.06))';
    };
    closeBtn.onmouseleave = function () {
      this.style.color = 'var(--text-3, #696d77)';
      this.style.background = 'none';
    };

    el.appendChild(iconEl);
    el.appendChild(msgEl);
    el.appendChild(closeBtn);

    // Dismiss logic
    var timer = null;

    function dismiss() {
      if (timer) { clearTimeout(timer); timer = null; }
      el.style.animation = 'toastOut 200ms var(--ease-out, cubic-bezier(0.16,1,0.3,1)) both';
      setTimeout(function () {
        if (el.parentNode) el.parentNode.removeChild(el);
        var idx = queue.indexOf(el);
        if (idx !== -1) queue.splice(idx, 1);
      }, FADE_DURATION);
    }

    closeBtn.onclick = dismiss;

    if (!persistent && duration > 0) {
      // Pause on hover
      el.onmouseenter = function () {
        if (timer) { clearTimeout(timer); timer = null; }
      };
      el.onmouseleave = function () {
        if (!timer) timer = setTimeout(dismiss, 1500);
      };
      timer = setTimeout(dismiss, duration);
    }

    el._dismiss = dismiss;

    return el;
  }

  function show(message, opts) {
    var c = ensureContainer();
    var el = createToastEl(message, opts);

    // Stack limit: remove oldest
    while (queue.length >= STACK_LIMIT) {
      var oldest = queue.shift();
      if (oldest._dismiss) oldest._dismiss();
    }

    queue.push(el);
    c.appendChild(el);
    return el;
  }

  ns.toast = {
    show: show,
    success: function (msg, opts) { return show(msg, Object.assign({ tone: 'success' }, opts || {})); },
    error:   function (msg, opts) { return show(msg, Object.assign({ tone: 'error' }, opts || {})); },
    warning: function (msg, opts) { return show(msg, Object.assign({ tone: 'warning' }, opts || {})); },
    info:    function (msg, opts) { return show(msg, Object.assign({ tone: 'info' }, opts || {})); },
    clear:   function () {
      for (var i = queue.length - 1; i >= 0; i--) {
        if (queue[i]._dismiss) queue[i]._dismiss();
      }
    }
  };
})();
