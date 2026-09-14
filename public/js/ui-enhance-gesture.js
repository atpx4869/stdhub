/**
 * StdHub UI Enhancement — Touch Gesture Handler
 * 
 * Adds swipe-to-dismiss and keyboard-aware behavior for mobile.
 * Pure touch events, no library dependency.
 * 
 * Features:
 *   - Swipe left/right on result cards for quick actions
 *   - Keyboard-aware viewport adjustment
 */
(function () {
  'use strict';

  var ns = (window.StdHub = window.StdHub || {});

  /* ── Swipe to Action ── */

  var SWIPE_THRESHOLD = 60;
  var SWIPE_VELOCITY = 0.3;

  function initSwipe(container, opts) {
    if (!container) return;
    opts = opts || {};

    var startX, startY, startTime, currentX, swiping, locked;
    var card = null;

    container.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1) return;
      var t = e.touches[0];
      startX = t.clientX;
      startY = t.clientY;
      startTime = Date.now();
      currentX = startX;
      swiping = false;
      locked = false;

      // Find closest swipeable card
      card = e.target.closest('[data-swipeable]');
      if (card) {
        card.style.transition = 'none';
      }
    }, { passive: true });

    container.addEventListener('touchmove', function (e) {
      if (!card || locked) return;
      var t = e.touches[0];
      var dx = t.clientX - startX;
      var dy = t.clientY - startY;

      // Determine direction lock
      if (!swiping && Math.abs(dx) > 8) {
        if (Math.abs(dy) > Math.abs(dx)) {
          locked = true; // vertical scroll wins
          return;
        }
        swiping = true;
      }

      if (!swiping) return;

      currentX = t.clientX;
      var offset = Math.max(-120, Math.min(120, dx));
      card.style.transform = 'translateX(' + offset + 'px)';

      // Show action hint
      var actionEl = card.querySelector('.swipe-action');
      if (actionEl) {
        actionEl.style.opacity = Math.min(1, Math.abs(offset) / SWIPE_THRESHOLD);
      }

      e.preventDefault();
    }, { passive: false });

    container.addEventListener('touchend', function () {
      if (!card || !swiping) {
        card = null;
        return;
      }

      var dx = currentX - startX;
      var dt = Date.now() - startTime;
      var velocity = Math.abs(dx) / dt;
      var threshold = velocity > SWIPE_VELOCITY ? SWIPE_THRESHOLD * 0.5 : SWIPE_THRESHOLD;

      card.style.transition = 'transform 0.25s var(--ease-out)';

      if (Math.abs(dx) > threshold) {
        var direction = dx > 0 ? 'right' : 'left';
        // Animate off-screen then snap back
        card.style.transform = 'translateX(' + (dx > 0 ? '100%' : '-100%') + ')';
        card.style.opacity = '0.5';

        if (typeof opts.onSwipe === 'function') {
          opts.onSwipe(card, direction);
        }

        // Snap back after 300ms
        setTimeout(function () {
          if (card) {
            card.style.transition = 'transform 0.3s var(--ease-out), opacity 0.3s var(--ease-out)';
            card.style.transform = 'translateX(0)';
            card.style.opacity = '1';
          }
        }, 300);
      } else {
        // Snap back
        card.style.transform = 'translateX(0)';
        var actionEl = card.querySelector('.swipe-action');
        if (actionEl) actionEl.style.opacity = '0';
      }

      card = null;
      swiping = false;
    }, { passive: true });
  }

  /* ── Keyboard-Aware Viewport ── */

  function initKeyboardAware() {
    if (!window.visualViewport) return;

    var viewport = window.visualViewport;
    var body = document.body;

    function update() {
      var diff = window.innerHeight - viewport.height;
      if (diff > 120) {
        // Keyboard is likely open
        body.classList.add('keyboard-open');
        // Scroll focused input into view
        var focused = document.activeElement;
        if (focused && (focused.tagName === 'INPUT' || focused.tagName === 'TEXTAREA')) {
          setTimeout(function () {
            focused.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }, 100);
        }
      } else {
        body.classList.remove('keyboard-open');
      }
    }

    viewport.addEventListener('resize', update);
    viewport.addEventListener('scroll', update);
  }

  /* ── Initialize All ── */

  function init() {
    // Only on touch devices
    var isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

    if (isTouchDevice) {
      document.body.classList.add('touch-device');

      // Swipe on search results
      var resultsEl = document.getElementById('results');
      if (resultsEl) {
        initSwipe(resultsEl, {
          onSwipe: function (card, dir) {
            // Could trigger save (right) or quick-download (left)
          }
        });
      }

      // Swipe on file library
      var fileLib = document.getElementById('page-local');
      if (fileLib) {
        var fileList = fileLib.querySelector('.file-list, .workspace-table, [id*="file"]');
        if (fileList) {
          initSwipe(fileList, {
            onSwipe: function (card, dir) {
              // Could trigger delete (left) or preview (right)
            }
          });
        }
      }
    }

    // Keyboard-aware (all devices with visualViewport)
    initKeyboardAware();
  }

  // Auto-init on DOMContentLoaded
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  ns.gesture = {
    initSwipe: initSwipe,
    init: init
  };
})();
