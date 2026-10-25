'use strict';
/* Server lokal untuk pengembangan & tes: node dev-server.js  →  http://localhost:3000
   Memakai penyimpanan memori kecuali variabel Redis diset. */
const http = require('http'), fs = require('fs'), path = require('path'), url = require('url');
const handler = require('./api/room.js');
const PUB = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };
function start(port) {
  const srv = http.createServer((req, res) => {
    const u = url.parse(req.url, true);
    if (u.pathname === '/api/room') {
      let raw = ''; req.on('data', c => raw += c);
      req.on('end', () => {
        try { req.body = raw ? JSON.parse(raw) : undefined; } catch (e) { req.body = undefined; }
        req.query = u.query;
        res.status = c => { res.statusCode = c; return res; };
        res.json = o => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
        handler(req, res);
      });
      return;
    }
    let f = path.join(PUB, u.pathname === '/' ? 'index.html' : u.pathname);
    if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.statusCode = 404; return res.end('404'); }
    res.setHeader('Content-Type', TYPES[path.extname(f)] || 'application/octet-stream'); res.end(fs.readFileSync(f));
  });
  return new Promise(r => srv.listen(port, () => r(srv)));
}
module.exports = { start };
if (require.main === module) start(process.env.PORT || 3000).then(() => console.log('Dev server: http://localhost:' + (process.env.PORT || 3000)));
