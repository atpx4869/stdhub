(function initializeStdHub(global) {
  'use strict';

  const root = global.StdHub = global.StdHub || {};

  function createApiError(message, code, status, details) {
    const error = new Error(message || '请求失败');
    error.code = code || 'UNKNOWN';
    error.status = status;
    error.details = details;
    return error;
  }

  // Returns a short, safe, human-facing message for an upstream/proxy error page
  // (e.g. Go Reauth Proxy) instead of leaking the raw HTML into the UI.
  function sanitizeRawBody(raw, status) {
    const trimmed = String(raw || '').trim();
    if (!trimmed) return null;
    const looksLikeHtml = /^\s*</.test(trimmed) || /<!doctype html/i.test(trimmed) || /<html[\s>]/i.test(trimmed);
    if (looksLikeHtml) {
      if (/Go\s*Reauth\s*Proxy/i.test(trimmed) || /上游暂时不可用/i.test(trimmed) || /20005/i.test(trimmed)) {
        return '上游服务暂时不可用，请稍后重试';
      }
      if (/20005/i.test(trimmed) || /502 Bad Gateway/i.test(trimmed)) {
        return '上游服务暂时不可用，请稍后重试';
      }
      return `服务返回了非预期的页面（HTTP ${status}），请稍后重试`;
    }
    // Plain-text non-JSON body: keep it short and strip any accidental markup.
    const cleaned = trimmed.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.length > 200 ? cleaned.slice(0, 200) + '…' : cleaned;
  }

  async function readResponse(response) {
    const raw = await response.text();
    if (!raw) return {};
    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const message = sanitizeRawBody(raw, response.status) || '请求失败';
      return { code: 'INVALID_RESPONSE', message };
    }
    if (parsed && typeof parsed === 'object' && 'data' in parsed && 'error' in parsed) {
      return parsed.error
        ? { code: parsed.error.code, message: parsed.error.message, details: parsed.error.details }
        : (parsed.data == null ? {} : parsed.data);
    }
    return parsed;
  }

  async function request(path, options) {
    let response;
    try {
      response = await global.fetch(path, { credentials: 'same-origin', ...(options || {}) });
    } catch (error) {
      throw createApiError(error?.message || '网络错误', 'NETWORK_ERROR');
    }
    const data = await readResponse(response);
    if (!response.ok || data?.code) {
      throw createApiError(data?.message || `HTTP ${response.status}`, data?.code || 'HTTP_ERROR', response.status, data?.details);
    }
    return data;
  }

  root.api = Object.assign(root.api || {}, {
    fetch(path, options) {
      return global.fetch(path, { credentials: 'same-origin', ...(options || {}) });
    },
    request,
    readResponse,
    get(path, options) { return request(path, { ...(options || {}), method: 'GET' }); },
    post(path, body, options) {
      return request(path, {
        ...(options || {}),
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
        body: JSON.stringify(body || {}),
      });
    },
    put(path, body, options) {
      return request(path, {
        ...(options || {}),
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
        body: JSON.stringify(body || {}),
      });
    },
    delete(path, options) { return request(path, { ...(options || {}), method: 'DELETE' }); },
  });

  const assetPromises = new Map();
  root.assets = Object.assign(root.assets || {}, {
    loadScript(src) {
      if (assetPromises.has(src)) return assetPromises.get(src);
      const version = new URL(document.querySelector('script[src*="app-foundation.js"]')?.src || location.href).searchParams.get('v');
      const url = version ? `${src}${src.includes('?') ? '&' : '?'}v=${encodeURIComponent(version)}` : src;
      const promise = new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[data-stdhub-src="${CSS.escape(src)}"]`);
        if (existing?.dataset.loaded === '1') { resolve(existing); return; }
        const script = existing || document.createElement('script');
        script.src = url;
        script.async = true;
        script.dataset.stdhubSrc = src;
        script.addEventListener('load', () => { script.dataset.loaded = '1'; resolve(script); }, { once: true });
        script.addEventListener('error', () => { assetPromises.delete(src); reject(new Error(`资源加载失败：${src}`)); }, { once: true });
        if (!existing) document.head.appendChild(script);
      });
      assetPromises.set(src, promise);
      return promise;
    },
  });

  root.dom = Object.assign(root.dom || {}, {
    escapeHtml(value) {
      const element = document.createElement('div');
      element.textContent = String(value ?? '');
      return element.innerHTML;
    },
    setText(target, value) {
      const element = typeof target === 'string' ? document.querySelector(target) : target;
      if (element) element.textContent = String(value ?? '');
      return element;
    },
    delegate(rootElement, eventName, selector, handler) {
      const listener = (event) => {
        const match = event.target?.closest?.(selector);
        if (match && rootElement.contains(match)) handler(event, match);
      };
      rootElement.addEventListener(eventName, listener);
      return () => rootElement.removeEventListener(eventName, listener);
    },
  });

  function actionArguments(raw, element) {
    if (!raw.trim()) return [];
    return raw.split(/\s*,\s*/).map(value => {
      if (value === 'this') return element;
      if (value === 'this.checked') return element.checked;
      if (value === 'this.value') return element.value;
      if (value === 'false') return false;
      if (value === 'true') return true;
      if (value === "{ certNumbers: [] }") return { certNumbers: [] };
      const quoted = /^(['"])(.*)\1$/.exec(value);
      if (quoted) return quoted[2];
      throw new Error(`不支持的声明式动作参数：${value}`);
    });
  }

  function invokeAction(expression, event, element) {
    let statement = expression.trim();
    const keyGuard = /^if\(event\.key===['"]([^'"]+)['"]\)(.+)$/.exec(statement);
    if (keyGuard) {
      if (event.key !== keyGuard[1]) return;
      statement = keyGuard[2];
    }
    if (statement === "document.getElementById('capLibDiagCard').style.display='';document.getElementById('capLibDiagInput').focus()") {
      document.getElementById('capLibDiagCard').style.display = '';
      document.getElementById('capLibDiagInput').focus();
      return;
    }
    const call = /^([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\((.*)\)$/.exec(statement);
    if (!call) throw new Error(`不支持的声明式动作：${statement}`);
    const parts = call[1].split('.');
    let owner = global;
    for (let index = 0; index < parts.length - 1; index++) owner = owner?.[parts[index]];
    const fn = owner?.[parts.at(-1)];
    if (typeof fn !== 'function') throw new Error(`动作不存在：${call[1]}`);
    return fn.apply(owner, actionArguments(call[2], element));
  }

  root.actions = Object.assign(root.actions || {}, { invoke: invokeAction });
  for (const eventName of ['click', 'change', 'input', 'keydown']) {
    document.addEventListener(eventName, event => {
      const element = event.target?.closest?.(`[data-stdhub-${eventName}]`);
      if (!element) return;
      try { invokeAction(element.dataset[`stdhub${eventName[0].toUpperCase()}${eventName.slice(1)}`], event, element); }
      catch (error) { console.error('[ui-action]', error); }
    }, true);
  }

  const lifecycleScopes = new Map();
  const legacyRegistries = new Map();
  root.lifecycle = Object.assign(root.lifecycle || {}, {
    register(scope, key, dispose) {
      if (!lifecycleScopes.has(scope)) lifecycleScopes.set(scope, new Map());
      const entries = lifecycleScopes.get(scope);
      entries.get(key)?.();
      entries.set(key, dispose);
      return () => {
        if (entries.get(key) === dispose) entries.delete(key);
        dispose();
      };
    },
    bindLegacyRegistry(scope, registry) { legacyRegistries.set(scope, registry); },
    disposeScope(scope) {
      for (const dispose of lifecycleScopes.get(scope)?.values() || []) {
        try { dispose(); } catch { /* one module must not block others */ }
      }
      const legacy = legacyRegistries.get(scope);
      if (legacy) {
        for (const dispose of Object.values(legacy)) {
          try { if (typeof dispose === 'function') dispose(); } catch { /* compatibility */ }
        }
      }
    },
    disposeAll() {
      for (const scope of new Set([...lifecycleScopes.keys(), ...legacyRegistries.keys()])) this.disposeScope(scope);
    },
  });

  root.ui = Object.assign(root.ui || {}, {
    setBusy(target, busy, busyText) {
      const element = typeof target === 'string' ? document.querySelector(target) : target;
      if (!element) return;
      element.toggleAttribute('aria-busy', Boolean(busy));
      if ('disabled' in element) element.disabled = Boolean(busy);
      if (busyText && busy) {
        if (!element.dataset.idleText) element.dataset.idleText = element.textContent || '';
        element.textContent = busyText;
      } else if (!busy && element.dataset.idleText) {
        element.textContent = element.dataset.idleText;
        delete element.dataset.idleText;
      }
    },
    renderMessage(target, state, title, detail) {
      const element = typeof target === 'string' ? document.querySelector(target) : target;
      if (!element) return;
      element.replaceChildren();
      const wrapper = document.createElement('div');
      wrapper.className = `workspace-empty-state is-${state || 'empty'}`;
      const strong = document.createElement('strong');
      strong.textContent = title || '';
      wrapper.appendChild(strong);
      if (detail) {
        const span = document.createElement('span');
        span.textContent = detail;
        wrapper.appendChild(span);
      }
      element.appendChild(wrapper);
    },
  });

  global.addEventListener('beforeunload', () => root.lifecycle.disposeAll(), { once: true });
})(window);
