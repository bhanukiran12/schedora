// Frontend-only preview. Does not load .env, databases or backend integrations.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../frontend/', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json', '.xml': 'application/xml' };
createServer(async (req, res) => {
  try {
    const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    if (pathname.startsWith('/api/')) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{"error":{"message":"Frontend preview has no backend."}}'); return; }
    let file = resolve(root, '.' + pathname);
    if (file !== resolve(root) && !file.startsWith(resolve(root) + sep)) { res.writeHead(403); res.end(); return; }
    if (!(await stat(file).catch(() => null))?.isFile()) file = resolve(root, 'index.html');
    const content = await readFile(file);
    res.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'" }); res.end(content);
  } catch { res.writeHead(500); res.end('Preview unavailable'); }
}).listen(4176, '127.0.0.1', () => console.log('Frontend preview listening on port 4176'));
