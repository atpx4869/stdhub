// 公告系统：管理员公告 + 版本升级公告
// NOTE: 所有后端接口都返回 { data, error } 信封；这里通过 app-core.js 暴露的
// apiGet / apiPostJson / apiPutJson / apiDelete 自动解信封，避免 data.items / data.version
// 这类访问拿不到值导致前端"没反应"。
(function () {
  'use strict';

  const LS_VERSION_KEY = 'bzxz:last-seen-version';

  // ---------- Minimal Markdown renderer ----------
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function renderMarkdown(md) {
    if (!md) return '';
    const lines = String(md).replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let inList = false;
    let inCode = false;
    let codeBuf = [];

    const inline = (s) => {
      let t = escapeHtml(s);
      t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
      t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      t = t.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
      return t;
    };

    const closeList = () => { if (inList) { out.push('</ul>'); inList = false; } };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^```/.test(line)) {
        if (inCode) {
          out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
          codeBuf = []; inCode = false;
        } else { closeList(); inCode = true; }
        continue;
      }
      if (inCode) { codeBuf.push(line); continue; }
      let m;
      if ((m = line.match(/^###\s+(.*)/))) { closeList(); out.push('<h3>' + inline(m[1]) + '</h3>'); continue; }
      if ((m = line.match(/^##\s+(.*)/)))  { closeList(); out.push('<h2>' + inline(m[1]) + '</h2>'); continue; }
      if ((m = line.match(/^#\s+(.*)/)))   { closeList(); out.push('<h1>' + inline(m[1]) + '</h1>'); continue; }
      if ((m = line.match(/^\s*[-*]\s+(.*)/))) {
        if (!inList) { out.push('<ul>'); inList = true; }
        out.push('<li>' + inline(m[1]) + '</li>');
        continue;
      }
      if (/^\s*$/.test(line)) { closeList(); out.push(''); continue; }
      closeList();
      out.push('<p>' + inline(line) + '</p>');
    }
    if (inCode) out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
    closeList();
    return out.join('\n');
  }

  // ---------- Modal ----------
  function ensureModal() {
    let modal = document.getElementById('announcement-modal');
    if (modal) return modal;
    modal = document.createElement('div');
    modal.id = 'announcement-modal';
    modal.className = 'ann-modal-mask';
    modal.style.display = 'none';
    modal.innerHTML = `
      <div class="ann-modal-card">
        <div class="ann-modal-header">
          <span class="ann-modal-title">公告</span>
          <button class="ann-modal-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="ann-modal-body markdown-body"></div>
        <div class="ann-modal-footer">
          <button class="ann-modal-ok btn btn-primary" type="button">我知道了</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    return modal;
  }

  function showModal(title, contentHtml, onClose) {
    const modal = ensureModal();
    modal.querySelector('.ann-modal-title').textContent = title || '公告';
    modal.querySelector('.ann-modal-body').innerHTML = contentHtml || '';
    modal.style.display = 'flex';
    const close = () => {
      modal.style.display = 'none';
      if (typeof onClose === 'function') onClose();
    };
    modal.querySelector('.ann-modal-close').onclick = close;
    modal.querySelector('.ann-modal-ok').onclick = close;
  }

  // ---------- Admin announcements: queued display ----------
  async function checkAnnouncements() {
    try {
      // apiGet unwraps { data, error } automatically (see app-core.js).
      const data = await apiGet('/api/announcements/unread');
      const list = (data && (data.announcements || data.items)) || [];
      if (!Array.isArray(list) || !list.length) return;
      let idx = 0;
      const next = () => {
        if (idx >= list.length) return;
        const item = list[idx++];
        const html = renderMarkdown(item.contentMd || item.content_md || '');
        showModal(item.title || '公告', html, async () => {
          try { await apiPostJson('/api/announcements/' + item.id + '/read', {}); } catch (e) {}
          next();
        });
      };
      next();
    } catch (e) {
      console.warn('[announcements] check failed', e);
    }
  }

  // ---------- Release-notes: first launch / upgrade ----------
  async function checkReleaseNotesIfUpgraded() {
    try {
      let version = '';
      try {
        const h = await apiGet('/api/health');
        version = (h && (h.version || h.appVersion)) || '';
      } catch (e) {}
      if (!version) return;
      const last = localStorage.getItem(LS_VERSION_KEY);
      if (last === version) return;

      let notes = null;
      try {
        notes = await apiGet('/api/announcements/release-notes?version=' + encodeURIComponent(version));
      } catch (e) {}

      // 拉取最近 10 次提交，作为升级公告的一部分
      let commitsMd = '';
      try {
        const cm = await apiGet('/api/announcements/recent-commits?limit=10');
        const list = (cm && cm.commits) || [];
        if (Array.isArray(list) && list.length) {
          const lines = list.map(c => {
            const sha = c.shortSha || (c.sha ? String(c.sha).slice(0, 7) : '');
            const title = (c.title || '').replace(/[\r\n]+/g, ' ').trim();
            const author = c.author || '';
            const date = c.date ? String(c.date).slice(0, 10) : '';
            const meta = [author, date].filter(Boolean).join(', ');
            const link = c.htmlUrl ? '[`' + sha + '`](' + c.htmlUrl + ')' : '`' + sha + '`';
            return '- ' + link + ' ' + title + (meta ? ' _(' + meta + ')_' : '');
          });
          commitsMd = '\n\n### 最近 10 次提交\n\n' + lines.join('\n');
        }
      } catch (e) {}

      const isFirstLaunch = !last;
      const headerTitle = (notes && notes.available && notes.name)
        ? notes.name
        : (isFirstLaunch ? '欢迎使用标准盒子 v' + version : '已升级到 v' + version);
      const baseBody = (notes && notes.available && (notes.bodyMd || notes.body))
        ? (notes.bodyMd || notes.body)
        : (isFirstLaunch
            ? '感谢使用标准盒子！\n\n- 当前版本：**v' + version + '**\n- 默认权限仅包含 *标准检索 / 批量下载 / 标准补全*；管理员可在用户管理中按账号分配更多功能。\n- 如需查看完整更新日志，请打开 [GitHub Releases](https://github.com/atpx4869/bzxz/releases)。'
            : '已升级到版本 **v' + version + '**\n\n详细变更见 [GitHub Releases](https://github.com/atpx4869/bzxz/releases/tag/v' + version + ')。');
      const bodyMd = baseBody + commitsMd;
      const html = renderMarkdown(bodyMd);
      showModal(headerTitle, html, () => {
        try { localStorage.setItem(LS_VERSION_KEY, version); } catch (e) {}
      });
    } catch (e) {
      console.warn('[release-notes] check failed', e);
    }
  }

  // ---------- Admin UI helpers ----------
  async function adminListAnnouncements() { return apiGet('/api/admin/announcements'); }
  async function adminCreateAnnouncement(payload) { return apiPostJson('/api/admin/announcements', payload); }
  async function adminUpdateAnnouncement(id, payload) { return apiPutJson('/api/admin/announcements/' + id, payload); }
  async function adminDeleteAnnouncement(id) { return apiDelete('/api/admin/announcements/' + id); }

  window.checkAnnouncements = checkAnnouncements;
  window.checkReleaseNotesIfUpgraded = checkReleaseNotesIfUpgraded;
  window.renderAnnouncementMarkdown = renderMarkdown;
  window.showAnnouncementModal = (title, md) => showModal(title, renderMarkdown(md || ''));
  window.adminListAnnouncements = adminListAnnouncements;
  window.adminCreateAnnouncement = adminCreateAnnouncement;
  window.adminUpdateAnnouncement = adminUpdateAnnouncement;
  window.adminDeleteAnnouncement = adminDeleteAnnouncement;
})();
