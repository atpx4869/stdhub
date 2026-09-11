/**
 * StdHub UI Enhancement — Skeleton Loading Generators
 * 
 * Provides shimmer placeholder HTML for various content types.
 * Usage: StdHub.skeleton.searchResults(5) returns HTML string.
 * 
 * @requires animations.css + skeleton.css loaded
 */
(function () {
  'use strict';

  var ns = (window.StdHub = window.StdHub || {});

  /** Internal: one shimmer bar */
  function bar(extraClass) {
    return '<div class="shimmer ' + (extraClass || '') + '"></div>';
  }

  /** Search result skeleton card */
  function searchResultCard() {
    return (
      '<div class="skeleton-result-card">' +
        '<div class="s-row1">' +
          bar('s-badge') +
          bar('s-code') +
          bar('s-title') +
        '</div>' +
        '<div class="s-row2">' +
          bar('s-meta') +
          bar('s-meta') +
          '<div class="s-actions">' +
            bar('s-btn') +
            bar('s-btn') +
          '</div>' +
        '</div>' +
      '</div>'
    );
  }

  /** Multiple search result skeletons */
  function searchResults(count) {
    count = count || 5;
    var html = '<div class="skeleton-results">';
    for (var i = 0; i < count; i++) {
      html += searchResultCard();
    }
    html += '</div>';
    return html;
  }

  /** File library row skeleton */
  function fileRow() {
    return (
      '<div class="skeleton-file-row">' +
        bar('s-icon') +
        bar('s-name') +
        bar('s-size') +
        bar('s-date') +
      '</div>'
    );
  }

  /** Multiple file rows */
  function fileRows(count) {
    count = count || 8;
    var html = '<div class="skeleton-results">';
    for (var i = 0; i < count; i++) {
      html += fileRow();
    }
    html += '</div>';
    return html;
  }

  /** Qualification result skeleton */
  function qualCard() {
    return (
      '<div class="skeleton-qual-card">' +
        bar('s-lab-name') +
        '<div class="s-lab-meta">' +
          bar('s-lab-field') +
          bar('s-lab-field') +
          bar('s-lab-field') +
        '</div>' +
        '<div class="s-badges">' +
          bar('s-badge-chip') +
          bar('s-badge-chip') +
        '</div>' +
      '</div>'
    );
  }

  /** Multiple qual results */
  function qualCards(count) {
    count = count || 4;
    var html = '<div class="skeleton-results">';
    for (var i = 0; i < count; i++) {
      html += qualCard();
    }
    html += '</div>';
    return html;
  }

  /** Table skeleton */
  function table(rows, cols) {
    rows = rows || 6;
    cols = cols || 4;
    var html = '<div class="skeleton-table">';
    // header
    html += '<div class="skeleton-table-header">';
    for (var c = 0; c < cols; c++) {
      html += bar('s-th');
    }
    html += '</div>';
    // rows
    for (var r = 0; r < rows; r++) {
      html += '<div class="skeleton-table-row">';
      for (var c2 = 0; c2 < cols; c2++) {
        html += bar('s-td');
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  /** Empty hero skeleton */
  function emptyHero() {
    return (
      '<div class="skeleton-empty-hero">' +
        bar('s-icon-lg') +
        bar('s-heading') +
        bar('s-desc') +
      '</div>'
    );
  }

  /** Spinner element */
  function spinner(size) {
    var cls = 'spinner';
    if (size === 'sm') cls += ' sm';
    else if (size === 'lg') cls += ' lg';
    return '<span class="' + cls + '" role="status" aria-label="加载中"></span>';
  }

  /** Show skeleton in a container, return function to restore */
  function show(container, type, count) {
    if (!container) return function () {};
    var original = container.innerHTML;
    var html;
    switch (type) {
      case 'search':   html = searchResults(count); break;
      case 'files':    html = fileRows(count); break;
      case 'qual':     html = qualCards(count); break;
      case 'table':    html = table(count); break;
      case 'empty':    html = emptyHero(); break;
      default:         html = searchResults(count || 5);
    }
    container.innerHTML = html;
    return function restore() {
      container.innerHTML = original;
    };
  }

  ns.skeleton = {
    searchResultCard: searchResultCard,
    searchResults: searchResults,
    fileRow: fileRow,
    fileRows: fileRows,
    qualCard: qualCard,
    qualCards: qualCards,
    table: table,
    emptyHero: emptyHero,
    spinner: spinner,
    show: show
  };
})();
