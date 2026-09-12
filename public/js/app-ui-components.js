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

/**
 * 登录卡片 —— 管理员登录 / 初始化设置密码的专用 UI。
 * 卷宗设计语言：品牌区（logo + 标准盒子）+ 标题 + 密码框 + 单一主操作。
 * 返回 Promise<string|null>：确认返回密码（已 trim），取消/关闭返回 null。
 * opts: { title, subtitle, submitText, placeholder, showGuest, onLogin }
 *   onLogin: async (password) => 返回 { ok: true } 或 { ok: false, error: '...' }
 *   若未提供 onLogin，则直接返回输入的密码。
 */
function showLoginCard({ title = '管理员登录', subtitle = '', submitText = '登录', placeholder = '请输入管理员密码', showGuest = false, onGuest, onLogin } = {}) {
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
    const myGen = (showLoginCard._gen = (showLoginCard._gen || 0) + 1);
    const subtitleHtml = subtitle ? `<p class="login-card-subtitle">${escapeHtml(subtitle)}</p>` : '';
    const footerHtml = showGuest
      ? `<div class="login-card-footer"><button type="button" class="login-card-link" data-login-action="guest">继续以访客身份使用</button></div>`
      : '';
    overlay.innerHTML = `
      <div class="login-card" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="login-card-brand">
          <img src="/favicon-256.png" alt="" class="login-card-logo" aria-hidden="true">
          <div class="login-card-brandname">标准盒子<span>StandardsBox</span></div>
        </div>
        <h2 class="login-card-title">${escapeHtml(title)}</h2>
        ${subtitleHtml}
        <div class="login-card-field">
          <i class="ti ti-lock login-card-field-icon" aria-hidden="true"></i>
          <input id="loginCardPassword" type="password" class="login-card-input" placeholder="${escapeHtml(placeholder)}" autocomplete="current-password">
          <button type="button" class="login-card-toggle" data-login-action="toggle" aria-label="显示/隐藏密码" title="显示/隐藏密码"><i class="ti ti-eye" aria-hidden="true"></i></button>
        </div>
        <div class="login-card-error" id="loginCardError"></div>
        <button type="button" class="login-card-submit" data-login-action="submit"><i class="ti ti-login" aria-hidden="true"></i>${escapeHtml(submitText)}</button>
        ${footerHtml}
      </div>`;
    overlay.setAttribute('aria-hidden', 'false');
    overlay.classList.add('open');
    let finished = false;
    let submitting = false;
    const finish = (result) => {
      if (finished) return;
      finished = true;
      document.removeEventListener('keydown', onKey, true);
      if (showLoginCard._gen === myGen) {
        overlay.classList.remove('open');
        overlay.setAttribute('aria-hidden', 'true');
        setTimeout(() => { if (showLoginCard._gen === myGen) overlay.innerHTML = ''; }, 200);
        if (returnFocus?.isConnected) returnFocus.focus();
      }
      resolve(result);
    };
    const showError = (msg) => {
      const el = overlay.querySelector('#loginCardError');
      if (el) { el.textContent = msg; el.classList.add('visible'); }
    };
    const doSubmit = async () => {
      if (submitting) return;
      const input = overlay.querySelector('#loginCardPassword');
      const password = input ? input.value.trim() : '';
      if (!password) { showError('请输入密码'); if (input) input.focus(); return; }
      if (!onLogin) { finish(password); return; }
      submitting = true;
      const btn = overlay.querySelector('[data-login-action="submit"]');
      if (btn) { btn.disabled = true; }
      try {
        const r = await onLogin(password);
        if (r && r.ok) finish(password);
        else showError((r && r.error) || '登录失败');
      } catch (e) {
        showError(e && e.message ? e.message : String(e));
      } finally {
        submitting = false;
        if (btn && !finished) btn.disabled = false;
      }
    };
    const onKey = (e) => {
      if (showLoginCard._gen !== myGen) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); finish(null); return; }
      if (e.key === 'Tab') {
        const focusable = confirmFocusableElements(overlay);
        if (!focusable.length) return;
        const first = focusable[0], last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName);
      if (e.key === 'Enter' && !editing && !submitting) { e.preventDefault(); e.stopImmediatePropagation(); doSubmit(); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('[data-login-action="submit"]').addEventListener('click', doSubmit);
    const toggleBtn = overlay.querySelector('[data-login-action="toggle"]');
    toggleBtn.addEventListener('click', () => {
      const input = overlay.querySelector('#loginCardPassword');
      if (!input) return;
      const isPwd = input.type === 'password';
      input.type = isPwd ? 'text' : 'password';
      toggleBtn.innerHTML = `<i class="ti ${isPwd ? 'ti-eye-off' : 'ti-eye'}" aria-hidden="true"></i>`;
      input.focus();
    });
    const guestBtn = overlay.querySelector('[data-login-action="guest"]');
    if (guestBtn) guestBtn.addEventListener('click', () => { finish(null); if (typeof onGuest === 'function') onGuest(); });
    overlay.onclick = e => { if (e.target === overlay) finish(null); };
    const input = overlay.querySelector('#loginCardPassword');
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doSubmit(); } });
    setTimeout(() => { if (showLoginCard._gen === myGen && !finished) input.focus(); }, 0);
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

window.StdHub.modal = Object.assign(window.StdHub.modal || {}, {
  confirm: showConfirm,
  confirmHtml: showConfirmHtml,
  prompt: showPrompt,
  loginCard: showLoginCard,
  toast: showToast,
});
