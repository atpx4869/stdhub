(function initializeSelectedFieldOrder(global) {
  'use strict';

  /** Return a reordered copy with one field moved to a new index. */
  function moveSelectedField(selected, from, to) {
    const next = Array.isArray(selected) ? [...selected] : [];
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= next.length || to < 0 || to >= next.length || from === to) return next;
    const [fieldId] = next.splice(from, 1);
    next.splice(to, 0, fieldId);
    return next;
  }

  global.StdHub = global.StdHub || {};
  global.StdHub.moveSelectedField = moveSelectedField;
  if (typeof module !== 'undefined' && module.exports) module.exports = { moveSelectedField };
})(typeof window !== 'undefined' ? window : globalThis);
