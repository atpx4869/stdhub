// ── UI Components: toast, confirm, prompt ──

// #73 类似 showConfirm 但 body 支持 HTML（用于格式化预览列表渲染）
// 扩展：confirmDisabled 让按钮 disabled（无可执行项时不诱导用户点）；
//       onMount(overlay) 让调用方在 modal 挂载后挂事件（chip 切换 / 展开等）
function showConfirmHtml({ title = '请确认', bodyHtml = '', confirmText = '确定', cancelText = '取消', danger = false, confirmDisabled = false, onMount } = {}) {
  return new Promise(resolve => {
    let overlay = document.getElementById('confirmOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirmOverlay';
      overlay.className = 'confirm-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="confirm-card${danger ? ' danger' : ''}" role="dialog" aria-modal="true" style="min-width:560px;max-width:760px">
        <div class="confirm-title">${escapeHtml(title)}</div>
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
    requestAnimationFrame(() => overlay.classList.add('open'));
    const finish = (result) => {
      document.removeEventListener('keydown', onKey);
      resolve(result);
      // 被后续弹窗接管 → 不要动 overlay（新弹窗自己负责显示/清理）
      if (showConfirmHtml._gen !== myGen) return;
      overlay.classList.remove('open');
      setTimeout(() => { if (showConfirmHtml._gen === myGen) overlay.innerHTML = ''; }, 200);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      if (e.key === 'Enter' && !confirmDisabled) { e.preventDefault(); finish(true); }
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-confirm-action="cancel"]').addEventListener('click', () => finish(false));
    const confirmBtn = overlay.querySelector('[data-confirm-action="confirm"]');
    if (!confirmDisabled) {
      confirmBtn.addEventListener('click', () => finish(true));
    } else {
      // 即使禁用也允许「关闭」语义（如果文案是「关闭」）
      confirmBtn.addEventListener('click', () => finish(false));
    }
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); }, { once: true });
    if (typeof onMount === 'function') {
      try { onMount(overlay); } catch (err) { console.error(err); }
    }
    confirmBtn.focus();
  });
}

// 文本输入弹窗 —— 替代 window.prompt（Electron/win 客户端禁用原生 prompt，
// 返回空且控制台报 "prompt() is not supported"，导致依赖 prompt 的功能在 win 端
// 静默失效）。基于 showConfirmHtml 的 onMount 钩子塞一个 input。
// 返回 Promise<string|null>：确认返回输入值（已 trim），取消返回 null。
// opts: { title, label, defaultValue, placeholder, confirmText, multiline }
function showPrompt({ title = '请输入', label = '', defaultValue = '', placeholder = '', confirmText = '确定', multiline = false } = {}) {
  const fieldId = 'promptField_' + Math.random().toString(36).slice(2, 8);
  const field = multiline
    ? `<textarea id="${fieldId}" class="batch-textarea" style="min-height:96px" placeholder="${escapeHtml(placeholder)}">${escapeHtml(defaultValue)}</textarea>`
    : `<input id="${fieldId}" type="text" class="qual-search-input" style="width:100%" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}">`;
  const bodyHtml = `${label ? `<div style="margin-bottom:8px;font-size:13px;color:var(--text-2);white-space:pre-wrap">${escapeHtml(label)}</div>` : ''}${field}`;
  return showConfirmHtml({
    title,
    bodyHtml,
    confirmText,
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
  toast.innerHTML = `<span class="toast-icon" aria-hidden="true">${TOAST_ICON[type]}</span><span class="toast-msg">${escapeHtml(msg)}</span><div class="toast-bar" style="animation-duration:${duration}ms"></div>`;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.2s'; setTimeout(() => toast.remove(), 200); }, duration);
}

/**
 * Promise-based confirmation modal. Replaces native `confirm()` which is ugly,
 * blocks the page, and on Electron can be inconsistent.
 *   const ok = await showConfirm({ title: '确认删除', body: '...', danger: true });
 * Returns true if user clicked confirm, false otherwise.
 */
function showConfirm(opts) {
  const { title = '请确认', body = '', confirmText = '确定', cancelText = '取消', danger = false } = opts || {};
  return new Promise(resolve => {
    let overlay = document.getElementById('confirmOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'confirmOverlay';
      overlay.className = 'confirm-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div class="confirm-card${danger ? ' danger' : ''}" role="dialog" aria-modal="true">
        <div class="confirm-title">${escapeHtml(title)}</div>
        <div class="confirm-body">${escapeHtml(body)}</div>
        <div class="confirm-actions">
          <button class="btn btn-ghost btn-sm" data-confirm-action="cancel">${escapeHtml(cancelText)}</button>
          <button class="btn btn-sm ${danger ? 'btn-danger' : 'btn-primary'}" data-confirm-action="confirm">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    requestAnimationFrame(() => overlay.classList.add('open'));

    const finish = (result) => {
      overlay.classList.remove('open');
      setTimeout(() => { overlay.innerHTML = ''; }, 200);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); finish(false); }
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    };
    document.addEventListener('keydown', onKey);
    overlay.querySelector('[data-confirm-action="cancel"]').addEventListener('click', () => finish(false));
    overlay.querySelector('[data-confirm-action="confirm"]').addEventListener('click', () => finish(true));
    overlay.addEventListener('click', (e) => { if (e.target === overlay) finish(false); }, { once: true });
    overlay.querySelector('[data-confirm-action="confirm"]').focus();
  });
}
