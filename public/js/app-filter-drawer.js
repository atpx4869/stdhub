/** Reusable advanced-filter drawer for desktop and mobile search pages. */
(function () {
  if (typeof window === 'undefined') return;
  var activeConfig = null;
  var returnFocus = null;
  function getOverlay() { return document.getElementById('filterDrawerOverlay'); }
  function closeDrawer() {
    var overlay = getOverlay();
    if (!overlay) return;
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    activeConfig = null;
    if (returnFocus && returnFocus.isConnected) returnFocus.focus();
    returnFocus = null;
  }
  window.openFilterDrawer = function (config) {
    var overlay = getOverlay();
    var title = document.getElementById('filterDrawerTitle');
    var description = document.getElementById('filterDrawerDescription');
    var body = document.getElementById('filterDrawerBody');
    if (!overlay || !title || !description || !body) return;
    returnFocus = document.activeElement;
    activeConfig = config || {};
    title.textContent = activeConfig.title || '高级筛选';
    description.textContent = activeConfig.description || '';
    body.innerHTML = activeConfig.bodyHtml || '';
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    if (typeof activeConfig.onOpen === 'function') activeConfig.onOpen();
    requestAnimationFrame(function () { overlay.querySelector('.filter-drawer button, .filter-drawer input, .filter-drawer select')?.focus(); });
  };
  window.closeFilterDrawer = closeDrawer;
  window.resetFilterDrawer = function () { if (activeConfig && typeof activeConfig.onReset === 'function') activeConfig.onReset(); };
  window.applyFilterDrawer = function () { if (activeConfig && typeof activeConfig.onApply === 'function') activeConfig.onApply(); closeDrawer(); };
  document.addEventListener('click', function (event) { var overlay = getOverlay(); if (overlay && event.target === overlay) closeDrawer(); });
  document.addEventListener('keydown', function (event) {
    var overlay = getOverlay();
    if (!overlay || !overlay.classList.contains('open')) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeDrawer(); return; }
    if (event.key !== 'Tab') return;
    var focusable = Array.from(overlay.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]')).filter(function (el) { return el.offsetParent !== null; });
    if (!focusable.length) return;
    var first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
})();
