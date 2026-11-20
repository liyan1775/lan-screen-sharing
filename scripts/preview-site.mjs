import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function startSitePreview(directory, port = 0) {
  const root = path.resolve(directory);
  const types = {
    '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.mp4': 'video/mp4', '.vtt': 'text/vtt; charset=utf-8',
  };
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url,'http://localhost').pathname);
      const file = path.resolve(root,'.' + (pathname.endsWith('/') ? pathname+'index.html' : pathname));
      if (!file.startsWith(root+path.sep)) { response.writeHead(403).end(); return; }
      const body = await readFile(file);
      const type = types[path.extname(file)] ?? 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'Content-Length': body.length };
      if (type === 'video/mp4') {
        headers['Accept-Ranges'] = 'bytes';
        if (request.headers.range) {
          const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
          const start = range?.[1] ? Number(range[1]) : Math.max(0, body.length - Number(range?.[2]));
          const end = range?.[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
          if (!range || (!range[1] && !range[2]) || start > end || !Number.isSafeInteger(start)) {
            response.writeHead(416, { 'Content-Range': `bytes */${body.length}` }).end();
            return;
          }
          const part = body.subarray(start, end + 1);
          response.writeHead(206, {
            ...headers, 'Content-Length': part.length, 'Content-Range': `bytes ${start}-${end}/${body.length}`,
          }).end(request.method === 'HEAD' ? undefined : part);
          return;
        }
      }
      response.writeHead(200, headers).end(request.method === 'HEAD' ? undefined : body);
    } catch { response.writeHead(404).end('Not found'); }
  });
  await new Promise((resolve,reject)=>server.once('error',reject).listen(port,'127.0.0.1',resolve));
  return {server,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const preview=await startSitePreview(process.argv[2]??'website',Number(process.argv[3]??4176));
  console.log('Product introduction: '+preview.url);
}
