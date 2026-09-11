/**
 * StdHub UI Enhancement — DOM Observer & Card Index
 * 
 * Observes DOM mutations to auto-assign staggered animation indices
 * to dynamically loaded result cards, and provides visual enhancements.
 * 
 * @requires animations.css loaded
 */
(function () {
  'use strict';

  var ns = (window.StdHub = window.StdHub || {});

  var CARD_SELECTORS = [
    '.result-card',
    '.download-task',
    '.labr-row',
    '.qual-result-group',
    '.skeleton-result-card',
    '.skeleton-file-row'
  ];

  var CARD_SELECTOR = CARD_SELECTORS.join(', ');

  /** Assign staggered --card-index to newly added cards */
  function assignCardIndices(container) {
    if (!container) return;
    var cards = container.querySelectorAll(CARD_SELECTOR);
    var delay = 0;
    for (var i = 0; i < cards.length; i++) {
      var card = cards[i];
      if (card.dataset.indexed) continue;
      card.dataset.indexed = '1';
      card.style.setProperty('--card-index', String(delay));
      delay++;
    }
  }

  /** Observe a container for new cards */
  function observeResults(containerId) {
    var container = document.getElementById(containerId);
    if (!container) return null;

    // Initial pass
    assignCardIndices(container);

    var observer = new MutationObserver(function (mutations) {
      for (var i = 0; i < mutations.length; i++) {
        var m = mutations[i];
        if (m.type === 'childList' && m.addedNodes.length > 0) {
          assignCardIndices(container);
          break;
        }
      }
    });

    observer.observe(container, { childList: true, subtree: true });
    return observer;
  }

  /** Badge pop animation helper */
  function popBadge(el) {
    if (!el) return;
    el.classList.remove('badge-pop');
    // Force reflow
    void el.offsetWidth;
    el.classList.add('badge-pop');
    setTimeout(function () {
      el.classList.remove('badge-pop');
    }, 350);
  }

  /** Enhance download center badge updates */
  function watchDownloadBadge() {
    var badge = document.getElementById('downloadCenterBadge');
    if (!badge) return;

    var lastText = badge.textContent;
    var observer = new MutationObserver(function () {
      var newText = badge.textContent;
      if (newText !== lastText) {
        lastText = newText;
        popBadge(badge);
      }
    });

    observer.observe(badge, { childList: true, characterData: true, subtree: true });
  }

  /** Enhance log nav badge updates */
  function watchLogBadge() {
    var badge = document.getElementById('logNavBadge');
    if (!badge) return;

    var observer = new MutationObserver(function () {
      if (badge.style.display !== 'none') {
        popBadge(badge);
      }
    });

    observer.observe(badge, { attributes: true, attributeFilter: ['style'] });
  }

  /** Register CSS card index for stagger on dynamic content */
  function enhanceStagger() {
    // For result cards that render all at once (not incremental),
    // we still want stagger. Hook into any function that sets innerHTML
    // on result containers.
    var targets = ['results', 'labrResults', 'qualResults', 'fileList'];
    targets.forEach(function (id) {
      observeResults(id);
    });
  }

  /** Initialize all observers */
  function init() {
    enhanceStagger();
    watchDownloadBadge();
    watchLogBadge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    // Slight delay to let existing JS initialize
    setTimeout(init, 200);
  }

  ns.uiObserver = {
    observeResults: observeResults,
    assignCardIndices: assignCardIndices,
    popBadge: popBadge,
    init: init
  };
})();
