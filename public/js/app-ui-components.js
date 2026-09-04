// ── UI Components: toast, confirm, prompt ──

function confirmFocusableElements(overlay) {
  return Array.from(overlay.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'))
    .filter(element => !element.hidden && element.offsetParent !== null);
}

// 富内容确认框。普通确认和文本输入也复用这一生命周期。
function showConfirmHtml({ title = '请确认', bodyHtml = '', confirmText = '确定', cancelText = '取消', danger = false, confirmDisabled = false, wide = true, initialFocus, onMount } = {}) {
  return new Promise(resolve => {
    let overlay = document.getElementById('confirmOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirmOverlay';
      overlay.className = 'confirm-overlay';
      overlay.setAttribute('aria-hidden', 'true');
      document.body.appendChild(overlay);
    }
    const returnFocus = document.activeElement;
    const titleId = 'confirmTitle_' + Math.random().toString(36).slice(2, 9);
    overlay.innerHTML = `
      <div class="confirm-card${danger ? ' danger' : ''}${wide ? ' confirm-card-wide' : ''}" role="dialog" aria-modal="true" aria-labelledby="${titleId}">
        <div class="confirm-title" id="${titleId}">${escapeHtml(title)}</div>
        <div class="confirm-body" style="text-align:left;max-height:60vh;overflow-y:auto">${bodyHtml}</div>
        <div class="confirm-actions">
          <button class="btn btn-ghost btn-sm" data-confirm-action="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm-action="confirm"${confirmDisabled ? ' disabled' : ''}>${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    // 代际守卫：连续弹窗（如关联流程连开两次 showPrompt）复用同一 #confirmOverlay。
    // finish() 里延迟 200ms 清空 innerHTML，若期间已开新弹窗，旧 timer 会把新弹窗的
    // 卡片清掉，只剩带 backdrop-filter 的空遮罩 → 界面卡在高斯模糊。记一个递增 token，
    // 只有"自己仍是最新一次"才真正收起/清空。
    const myGen = (showConfirmHtml._gen = (showConfirmHtml._gen || 0) + 1);
    overlay.setAttribute('aria-hidden', 'false');
    overlay.classList.add('open');
    let finished = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey, true);
      // 被后续弹窗接管 → 不要动 overlay（新弹窗自己负责显示/清理）
      if (showConfirmHtml._gen === myGen) {
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
        setTimeout(() => { if (showConfirmHtml._gen === myGen) overlay.innerHTML = ''; }, 200);
        if (returnFocus?.isConnected) returnFocus.focus();
      }
      resolve(result);
    };
    const onKey = (e) => {
      if (showConfirmHtml._gen !== myGen) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(false); return; }
      if (e.key === 'Tab') {
        const focusable = confirmFocusableElements(overlay);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if (e.key === 'Enter' && !editing && !confirmDisabled) { e.preventDefault(); e.stopImmediatePropagation(); finish(true); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('[data-confirm-action="cancel"]').addEventListener('click', () => finish(false));
    const confirmBtn = overlay.querySelector('[data-confirm-action="confirm"]');
    if (!confirmDisabled) {
      confirmBtn.addEventListener('click', () => finish(true));
    } else {
      // 即使禁用也允许「关闭」语义（如果文案是「关闭」）
      confirmBtn.addEventListener('click', () => finish(false));
    }
    overlay.onclick = e => { if (e.target === overlay) finish(false); };
    if (typeof onMount === 'function') {
      try { onMount(overlay, { finish }); } catch (err) { console.error(err); }
    }
    setTimeout(() => {
      if (showConfirmHtml._gen !== myGen || finished) return;
      const requested = typeof initialFocus === 'string' ? overlay.querySelector(initialFocus) : initialFocus;
      (requested || confirmBtn || overlay.querySelector('[data-confirm-action="cancel"]'))?.focus();
    }, 0);
  });
}

// 文本输入弹窗 —— 替代 window.prompt（Electron/win 客户端禁用原生 prompt，
// 返回空且控制台报 "prompt() is not supported"，导致依赖 prompt 的功能在 win 端
// 静默失效）。基于 showConfirmHtml 的 onMount 钩子塞一个 input。
// 返回 Promise<string|null>：确认返回输入值（已 trim），取消返回 null。
// opts: { title, label, defaultValue, placeholder, confirmText, multiline }
function showPrompt({ title = '请输入', label = '', defaultValue = '', placeholder = '', confirmText = '确定', multiline = false, type = 'text' } = {}) {
  const fieldId = 'promptField_' + Math.random().toString(36).slice(2, 8);
  const field = multiline
    ? `<textarea id="${fieldId}" class="batch-textarea" style="min-height:96px" placeholder="${escapeHtml(placeholder)}">${escapeHtml(defaultValue)}</textarea>`
    : `<input id="${fieldId}" type="${type === 'password' ? 'password' : 'text'}" class="qual-search-input" style="width:100%" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}">`;
  const bodyHtml = `${label ? `<div style="margin-bottom:8px;font-size:13px;color:var(--text-2);white-space:pre-wrap">${escapeHtml(label)}</div>` : ''}${field}`;
  return showConfirmHtml({
    title,
    bodyHtml,
    confirmText,
    wide: false,
    initialFocus: '#' + fieldId,
    onMount(overlay) {
      const el = overlay.querySelector('#' + fieldId);
      if (el) {
        el.focus();
        if (!multiline && typeof el.select === 'function') el.select();
        // 单行：Enter 提交（多行交给 showConfirmHtml 默认行为，避免吞掉换行）
        if (!multiline) {
          el.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              const btn = overlay.querySelector('[data-confirm-action="confirm"]');
              if (btn) btn.click();
            }
          });
        }
      }
    },
  }).then(ok => {
    if (!ok) return null;
    const el = document.getElementById(fieldId);
    return el ? el.value.trim() : null;
  });
}

// ── Toast ──
// type: 'success' | 'fail' | 'warn' | 'info'
// icon 用 BMP 区单色字符(Win7 / 任意 Chrome 都有字形),颜色由 CSS .toast-icon 染白叠状态色背景。
// 之前用 ✅❌ℹ️ 彩色 emoji 在 Win7 显方框 + 与 toast 主体灰色对比突兀,新设计统一视觉。
const TOAST_ICON = { success: '✓', fail: '✕', warn: '!', info: 'i' };
function showToast(msg, type, duration) {
  type = type || 'success'; duration = duration || 3000;
  if (!TOAST_ICON[type]) type = 'info';
  const container = document.getElementById('toastContainer');
  if (!container) return;

  // 去重：相同消息+类型 2 秒内不重复弹出；fail 类型始终显示
  if (type !== 'fail') {
    var key = type + '::' + msg;
    var now = Date.now();
    if (!showToast._last) showToast._last = {};
    if (showToast._last[key] && now - showToast._last[key] < 2000) return;
    showToast._last[key] = now;
  }

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', type === 'fail' ? 'alert' : 'status');
  toast.innerHTML = `<span class="toast-icon" aria-hidden="true">${TOAST_ICON[type]}</span><span class="toast-msg">${escapeHtml(msg)}</span><button class="toast-close" type="button" aria-label="关闭提示" title="关闭"><i class="ti ti-x" aria-hidden="true"></i></button><div class="toast-bar" style="animation-duration:${duration}ms"></div>`;
  container.appendChild(toast);
  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 200);
  };
  toast.querySelector('.toast-close').addEventListener('click', dismiss);
  timer = setTimeout(dismiss, duration);
}

/**
 * Promise-based confirmation modal. Replaces native `confirm()` which is ugly,
 * blocks the page, and on Electron can be inconsistent.
 *   const ok = await showConfirm({ title: '确认删除', body: '...', danger: true });
 * Returns true if user clicked confirm, false otherwise.
 */
function showConfirm(opts) {
  const { title = '请确认', body = '', confirmText = '确定', cancelText = '取消', danger = false } = opts || {};
  return showConfirmHtml({
    title,
    bodyHtml: `<div style="white-space:pre-wrap">${escapeHtml(body)}</div>`,
    confirmText,
    cancelText,
    danger,
    wide: false,
  });
}
