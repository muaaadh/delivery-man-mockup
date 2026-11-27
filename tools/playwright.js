// Playwright for the local tools (shot.js, geo-*.js, tools/_scratch, tools/supabase): it is not a dependency of either repo.
// Looked for in $PLAYWRIGHT (the package folder), then ~/.mdm-tools/playwright (npm i playwright there, then npx playwright install
// chromium), then a normal install. Until 27/11/2026 each tool had the old Mac's path in it.
//   const { chromium } = require('./playwright')();          (from tools/; '../playwright' from a folder below it)
'use strict';
const path = require('path');
const os = require('os');
module.exports = function playwright() {
  const tried = [process.env.PLAYWRIGHT, path.join(os.homedir(), '.mdm-tools', 'playwright', 'node_modules', 'playwright'), 'playwright'].filter(Boolean);
  for (const p of tried) {
    try { return require(p); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
  }
  throw new Error('Playwright not found (tried ' + tried.join(', ') + '). Install it: mkdir -p ~/.mdm-tools/playwright && cd ~/.mdm-tools/playwright && npm i playwright && npx playwright install chromium');
};
