// Tiny static server for local QA. Usage: node tools/serve.js [port]      (HOST=0.0.0.0 node tools/serve.js to test from a phone)
// Serves the repo's parent folder so that the pages live under /mr-delivery-man-mockup/ (and a worktree beside it under its own
// folder name) like GitHub Pages, and folder URLs (/request/) resolve to index.html.
// Only copies of the site are served (a top folder with js/mdm.js), never a file or folder whose name starts with a dot (.env, .git),
// and only to this computer unless HOST says otherwise. Until 27/11/2026 it served the whole parent folder (the home folder: .ssh,
// the .env with the Supabase keys, Desktop) to every device on the network.
const http = require('http');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..', '..'); // parent of the repo, so pages live under /mr-delivery-man-mockup/ like GitHub Pages
const port = Number(process.argv[2] || 4180);
const host = process.env.HOST || '127.0.0.1';
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
const site = new Map();   // top folder → is it a copy of the site
const isSite = top => { if (!site.has(top)) site.set(top, fs.existsSync(path.join(root, top, 'js', 'mdm.js'))); return site.get(top); };
const refuse = (res, status, text) => { res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end(text); };
http.createServer((req, res) => {
  let p;
  try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch (e) { return refuse(res, 400, '400'); }
  const parts = p.split('/').filter(Boolean);
  if (/[\0\r\n]/.test(p) || parts.some(s => s.charAt(0) === '.') || !parts.length || !isSite(parts[0])) return refuse(res, 404, '404 ' + p);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(root, p);
  if (!file.startsWith(root + path.sep)) return refuse(res, 403, '403');
  fs.stat(file, (err, st) => {
    if (!err && st.isDirectory()) { res.writeHead(301, { Location: encodeURI(p + '/') }); return res.end(); }
    if (err || !st.isFile()) return refuse(res, 404, '404 ' + p);
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}).listen(port, host, () => console.log('serving the site folders in', root, 'on http://' + (host === '0.0.0.0' ? 'localhost' : host) + ':' + port + ' (' + host + ')'));
