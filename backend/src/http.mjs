import { gzipSync } from 'node:zlib';

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export const fail = (status, code, message, details) => { throw new HttpError(status, code, message, details); };

export function send(request, response, status, type, body, headers = {}) {
  let data = Buffer.isBuffer(body) ? body : Buffer.from(body ?? '');
  response.statusCode = status;
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  if (type) response.setHeader('Content-Type', type);
  response.setHeader('Vary', 'Accept-Encoding');
  const compressible = /^(text\/|application\/(json|xml|javascript))|image\/svg/.test(type || '');
  if (compressible && data.length > 512 && /\bgzip\b/.test(request.headers['accept-encoding'] || '')) {
    data = gzipSync(data);
    response.setHeader('Content-Encoding', 'gzip');
  }
  response.setHeader('Content-Length', data.length);
  response.end(request.method === 'HEAD' ? undefined : data);
}

export function sendJson(request, response, status, value, headers) {
  send(request, response, status, 'application/json; charset=utf-8', status === 204 ? '' : JSON.stringify(value), { 'Cache-Control': 'no-store', ...headers });
}

export async function readBody(request, limit = 65536) {
  const declared = Number(request.headers['content-length'] || 0);
  if (declared > limit) fail(413, 'payload_too_large', 'Request body is too large.');
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) fail(413, 'payload_too_large', 'Request body is too large.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

export async function readJson(request, limit) {
  if (!/^application\/json\b/i.test(request.headers['content-type'] || '')) fail(415, 'unsupported_media_type', 'Send JSON with Content-Type: application/json.');
  const raw = await readBody(request, limit);
  if (!raw.length) return {};
  try {
    const value = JSON.parse(raw.toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { fail(400, 'invalid_json', 'Request body must be a JSON object.'); }
}

export function parseCookies(header = '') {
  const cookies = {};
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0) cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

// With N trusted proxies, the client is the Nth address from the right of X-Forwarded-For;
// anything further left was supplied by the client and cannot be trusted.
export function clientAddress(request, trustProxy, hops = 1) {
  if (trustProxy) {
    const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').map(value => value.trim()).filter(Boolean);
    if (forwarded.length) return forwarded[Math.max(0, forwarded.length - hops)];
  }
  return request.socket.remoteAddress || 'unknown';
}

// Fixed-window counters held in memory. Suitable for a single instance; a multi-instance
// deployment must add an edge or shared-store limiter.
export function createRateLimiter() {
  const buckets = new Map();
  let lastSweep = 0;
  return function hit(key, limit, windowMs, now = Date.now()) {
    if (now - lastSweep > 60000) {
      for (const [bucketKey, bucket] of buckets) if (bucket.until < now) buckets.delete(bucketKey);
      lastSweep = now;
    }
    let bucket = buckets.get(key);
    if (!bucket || bucket.until < now) { bucket = { count: 0, until: now + windowMs }; buckets.set(key, bucket); }
    bucket.count++;
    return bucket.count <= limit ? 0 : Math.ceil((bucket.until - now) / 1000);
  };
}

// Small path router: patterns like '/api/workspaces/:ws/forms/:id'.
export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler, options = {}) => {
    const names = [];
    const regex = new RegExp('^' + pattern.replace(/[.]/g, '\\.').replace(/:(\w+)/g, (_, name) => { names.push(name); return '([^/]+)'; }) + '$');
    routes.push({ method, regex, names, handler, options });
  };
  const match = (method, path) => {
    let pathMatched = false;
    for (const route of routes) {
      const result = route.regex.exec(path);
      if (!result) continue;
      pathMatched = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params = {};
      route.names.forEach((name, index) => {
        try { params[name] = decodeURIComponent(result[index + 1]); } catch { params[name] = ''; }
      });
      return { route, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  };
  return { add, match, get: (...args) => add('GET', ...args), post: (...args) => add('POST', ...args), patch: (...args) => add('PATCH', ...args), put: (...args) => add('PUT', ...args), delete: (...args) => add('DELETE', ...args) };
}
