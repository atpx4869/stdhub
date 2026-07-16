/** Reusable advanced-filter drawer for desktop and mobile search pages. */
(function () {
  if (typeof window === 'undefined') return;
  var activeConfig = null;
  function getOverlay() { return document.getElementById('filterDrawerOverlay'); }
  function closeDrawer() {
    var overlay = getOverlay();
    if (!overlay) return;
    overlay.classList.remove('open');
    overlay.setAttribute('aria-hidden', 'true');
    activeConfig = null;
  }
  window.openFilterDrawer = function (config) {
    var overlay = getOverlay();
    var title = document.getElementById('filterDrawerTitle');
    var description = document.getElementById('filterDrawerDescription');
    var body = document.getElementById('filterDrawerBody');
    if (!overlay || !title || !description || !body) return;
    activeConfig = config || {};
    title.textContent = activeConfig.title || '高级筛选';
    description.textContent = activeConfig.description || '';
    body.innerHTML = activeConfig.bodyHtml || '';
    overlay.classList.add('open');
    overlay.setAttribute('aria-hidden', 'false');
    if (typeof activeConfig.onOpen === 'function') activeConfig.onOpen();
  };
  window.closeFilterDrawer = closeDrawer;
  window.resetFilterDrawer = function () { if (activeConfig && typeof activeConfig.onReset === 'function') activeConfig.onReset(); };
  window.applyFilterDrawer = function () { if (activeConfig && typeof activeConfig.onApply === 'function') activeConfig.onApply(); closeDrawer(); };
  document.addEventListener('click', function (event) { var overlay = getOverlay(); if (overlay && event.target === overlay) closeDrawer(); });
  document.addEventListener('keydown', function (event) { var overlay = getOverlay(); if (event.key === 'Escape' && overlay && overlay.classList.contains('open')) { event.preventDefault(); closeDrawer(); } });
})();
