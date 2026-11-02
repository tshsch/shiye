const fs = require('fs');
const path = require('path');
const { ROOT } = require('./config');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.zip': 'application/zip'
};

function serveStatic(res, pathname) {
  let p = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(ROOT, 'static', path.normalize(p).replace(/^([.]{2}[\/\\])+/, ''));
  if (!file.startsWith(path.join(ROOT, 'static'))) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('404');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'Cache-Control': 'no-cache'
  });
  fs.createReadStream(file).pipe(res);
}

module.exports = { serveStatic };