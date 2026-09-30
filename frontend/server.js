const http = require('http');
const fs = require('fs');
const path = require('path');

const d = 'C:\\Users\\Lenovo\\.gemini\\antigravity\\scratch\\justflip-dashboard\\frontend';

http.createServer((req, res) => {
  let f = path.join(d, req.url === '/' ? 'landing-page-studio.html' : req.url);
  fs.readFile(f, (e, c) => {
    if (e) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    const ext = path.extname(f);
    const types = {
      '.html': 'text/html',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.json': 'application/json',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, { 'Content-Type': types[ext] || 'text/plain' });
    res.end(c);
  });
}).listen(3000, () => console.log('Server running on http://localhost:3000'));