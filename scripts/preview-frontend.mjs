import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../demos/', import.meta.url));
const port = Number(process.env.PORT || 4173);
const entry = process.argv.includes('--experience') ? '/experience-lab/index.html' : '/frontend-lab/index.html';
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8' };
const server = http.createServer(async (req, res) => {
  try {
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405).end(); return; }
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname === '/') { res.writeHead(302, { Location: entry }).end(); return; }
    const target = path.resolve(root, '.' + pathname);
    if (!target.startsWith(root) || !(await fs.stat(target)).isFile()) { res.writeHead(404).end(); return; }
    const body = await fs.readFile(target);
    res.writeHead(200, { 'Content-Type': types[path.extname(target)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch { res.writeHead(404).end(); }
});
server.listen(port, '127.0.0.1', () => console.log(`Frontend preview: http://127.0.0.1:${port}${entry}`));
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
