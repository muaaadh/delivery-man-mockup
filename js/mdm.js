// Namespace, site root and id generator. Loaded first on every page.
// ROOT is derived from this script's URL, so links built with MDM.href() work on localhost and under a GitHub Pages sub-path alike.
(function () { 'use strict';
  const root = new URL('../', document.currentScript.src).href;   // js/ sits one level below the site root
  window.MDM = {
    ROOT: root,
    SCHEMA: 1,
    href: function (p) { return root + String(p || '').replace(/^\/+/, ''); },
    // Prefixes: ord_, cus_, drv_, pkg_, stp_, evt_, adj_, breq_, bacc_, inv_, file_. Never crypto.randomUUID (undefined on http:// LAN addresses).
    id: function (prefix) { return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8); },
  };
})();
