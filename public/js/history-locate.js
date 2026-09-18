(function initializeHistoryLocate(global) {
  'use strict';

  function chooseLegacyHistoryCandidate(candidates, fileName, standardNumber) {
    const expectedName = String(fileName || '').trim();
    const expectedStandard = String(standardNumber || '').trim();
    const matches = (Array.isArray(candidates) ? candidates : []).filter(candidate => {
      if (String(candidate.fileName || '').trim() !== expectedName) return false;
      return !expectedStandard || String(candidate.standardNumber || '').trim() === expectedStandard;
    });
    return { candidate: matches.length === 1 ? matches[0] : null, ambiguous: matches.length > 1 };
  }

  global.StdHub = global.StdHub || {};
  global.StdHub.chooseLegacyHistoryCandidate = chooseLegacyHistoryCandidate;
  if (typeof module !== 'undefined' && module.exports) module.exports = { chooseLegacyHistoryCandidate };
})(typeof window !== 'undefined' ? window : globalThis);
