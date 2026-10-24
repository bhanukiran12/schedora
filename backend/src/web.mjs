import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { send } from './http.mjs';
import { findPublishedEventType } from './meet/event-types.mjs';

// Serves the static frontend for local development and single-host deployments. In the split
// deployment Vercel serves frontend/ with the same rules (frontend/vercel.json) and this is off.

const TYPES = { '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml; charset=utf-8' };
const STATIC = /^\/(app\.js|app\.css|favicon\.svg|social-preview\.svg|logo-[a-z]+\.png|robots\.txt|sitemap\.xml|js\/[a-z-]+\.mjs|shared\/[a-z-]+\.mjs)$/;
const LEGACY = { '/book': '/meet', '/form': '/forms' };
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const PAGES = [
  /^\/$/, /^\/meet$/, /^\/forms$/, /^\/flow$/, /^\/privacy$/, /^\/terms$/, /^\/account$/, /^\/billing$/,
  new RegExp(`^/meet/event-types/(new|${UUID})$`), /^\/meet\/manage\/[A-Za-z0-9_-]{20,100}$/,
  new RegExp(`^/forms/${UUID}(/responses)?$`), new RegExp(`^/flow/(runs|tasks|new|${UUID})$`)
];

function resolvePage(app, path) {
  if (PAGES.some(pattern => pattern.test(path))) return { status: 200 };
  const booking = /^\/meet\/([a-z0-9-]{2,60})\/([a-z0-9-]{2,60})$/.exec(path);
  if (booking && findPublishedEventType(app, booking[1], booking[2])) return { status: 200 };
  const form = /^\/f\/([a-z0-9-]{3,60})$/.exec(path);
  if (form && app.db.get('SELECT 1 FROM forms WHERE slug = ? AND published_version IS NOT NULL', form[1])) return { status: 200, embeddable: true };
  return { status: 404 };
}

export function createWeb(app) {
  const dir = app.config.frontendDir;
  return async function handleWeb(request, response, path, url) {
    if (!['GET', 'HEAD'].includes(request.method)) return send(request, response, 405, 'text/plain; charset=utf-8', 'Method not allowed', { Allow: 'GET, HEAD' });
    if (LEGACY[path]) return send(request, response, 301, 'text/plain; charset=utf-8', 'Moved', { Location: LEGACY[path] + url.search });
    if (STATIC.test(path)) {
      const body = await readFile(join(dir, path));
      return send(request, response, 200, TYPES[extname(path)], body, { 'Cache-Control': /\.(png|svg)$/.test(path) ? 'public, max-age=86400' : 'no-cache' });
    }
    const page = resolvePage(app, path);
    const html = await readFile(join(dir, 'index.html'));
    const headers = { 'Cache-Control': 'no-cache' };
    if (page.status === 404) headers['X-Robots-Tag'] = 'noindex';
    // Published forms may be embedded on other sites; every other page refuses framing.
    if (page.embeddable) headers['Content-Security-Policy'] = app.csp.replace("frame-ancestors 'none'", 'frame-ancestors *');
    return send(request, response, page.status, 'text/html; charset=utf-8', html, headers);
  };
}

export function securityHeaders(app, request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  response.setHeader('Content-Security-Policy', app.csp);
  if (isSecure(app, request)) response.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
}

export function isSecure(app, request) {
  return Boolean(request.socket.encrypted) || (app.config.trustProxy && request.headers['x-forwarded-proto'] === 'https');
}
