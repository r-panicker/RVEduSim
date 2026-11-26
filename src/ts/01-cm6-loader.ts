// @ts-nocheck
/* ================================================================
   CodeMirror 6 loader (window.CM6)
   Loads a SINGLE self-contained CM6 bundle (cm6_bundle.min.js) —
   one copy of every @codemirror/@lezer package — from jsDelivr,
   with an automatic fallback to the local copy of the same bundle.
   (Loading individual ESM packages separately does NOT work: each
   +esm bundle inlines its own @lezer/common internals, so StreamLanguage
   extensions built against one instance fail EditorState validation
   with "Unrecognized extension value" and highlighting silently breaks.
   A single pre-bundled unit has consistent instances everywhere.)
   If window.CM6 is already present (e.g. tests pre-inject it), skip.
   The rest of the app defers its editor bootstrap until window.CM6
   exists, so load timing here is non-blocking.
   ================================================================ */
(function () {
  if (window.CM6) return; // already available
  // Tests / embedding pages that pre-inject their own CM6 can set this
  // flag synchronously in beforeParse to prevent the CDN <script> from
  // being fetched (jsdom cannot run layout-dependent CM6 code on the CDN
  // bundle). The app still boots via the pre-injected window.CM6.
  if (window.__CM6_DISABLE_CDN) return;

  // The copy vendored next to the page first: it is already on the way
  // (see the preload in index.html's <head>), and it works from file:// too. jsDelivr
  // serves this repository only while it is public, so it comes last.
  // See vendor/README.md.
  var SOURCES = ['vendor/codemirror/cm6_bundle.min.js',
                 'riscv_simulator_tests/cm6_bundle.min.js',
                 'https://cdn.jsdelivr.net/gh/r-panicker/RVEduSim@main/vendor/codemirror/cm6_bundle.min.js'];

  function load(i) {
    if (i >= SOURCES.length) {
      console.error('[CM6] No bundle could be loaded: ' + SOURCES.join(', '));
      return;
    }
    var s = document.createElement('script');
    s.src = SOURCES[i];
    s.onerror = function () { load(i + 1); };
    document.head.appendChild(s);
  }
  load(0);
})();
