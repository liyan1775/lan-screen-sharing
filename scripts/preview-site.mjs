import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function startSitePreview(directory, port = 0) {
  const root = path.resolve(directory);
  const types = { '.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.svg':'image/svg+xml','.png':'image/png' };
  const server = http.createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(new URL(request.url,'http://localhost').pathname);
      const file = path.resolve(root,'.' + (pathname.endsWith('/') ? pathname+'index.html' : pathname));
      if (!file.startsWith(root+path.sep)) { response.writeHead(403).end(); return; }
      const body = await readFile(file);
      response.writeHead(200,{'Content-Type':types[path.extname(file)]??'application/octet-stream','Cache-Control':'no-store'}).end(body);
    } catch { response.writeHead(404).end('Not found'); }
  });
  await new Promise((resolve,reject)=>server.once('error',reject).listen(port,'127.0.0.1',resolve));
  return {server,url:`http://127.0.0.1:${server.address().port}`,close:()=>new Promise(resolve=>server.close(resolve))};
}
if (process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
  const preview=await startSitePreview(process.argv[2]??'website',Number(process.argv[3]??4176));
  console.log('Product introduction: '+preview.url);
}
