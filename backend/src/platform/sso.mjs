import { createHash, createPublicKey, randomBytes, randomUUID, verify } from 'node:crypto';
import { fail, parseCookies } from '../http.mjs';
import { bool, oneOf, text } from '../validate.mjs';
import { decryptJson, encryptJson } from './crypto.mjs';
import { createSession, hashPassword, newToken } from './auth.mjs';

// Single sign-on with OpenID Connect (authorization code flow with PKCE). Each workspace can
// connect one identity provider; people with a matching email domain can sign in through it and
// join the workspace automatically. Enforced SSO disables password sign-in for that domain.

const FLOW_COOKIE = 'schedora_sso';
const discoveryCache = new Map();

export function getSsoConfig(app, workspaceId) {
  const row = app.db.get('SELECT issuer, client_id, email_domain, default_role, enforced, enabled, updated_at FROM sso_configs WHERE workspace_id = ?', workspaceId);
  return row ? { ...row, enforced: Boolean(row.enforced), enabled: Boolean(row.enabled), redirect_uri: redirectUri(app) } : { redirect_uri: redirectUri(app) };
}

const redirectUri = app => `${app.config.baseUrl}/api/auth/sso/callback`;
// Sign-in may start on a product subdomain and return to BASE_URL, so share the cookie across them.
const flowCookieScope = app => `${app.config.production ? '; Secure' : ''}${app.config.cookieDomain ? '; Domain=' + app.config.cookieDomain : ''}`;

export function saveSsoConfig(app, workspaceId, body) {
  let issuer;
  try { issuer = new URL(text(body.issuer, 'issuer', { min: 1, max: 300 })); } catch { fail(400, 'validation_failed', 'Enter the issuer URL from your identity provider.', { field: 'issuer' }); }
  if (issuer.protocol !== 'https:') fail(400, 'validation_failed', 'The issuer must use https.', { field: 'issuer' });
  const domain = text(body.email_domain, 'email_domain', { min: 3, max: 100 }).toLowerCase().replace(/^@/, '');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) fail(400, 'validation_failed', 'Enter a domain like example.com.', { field: 'email_domain' });
  const clash = app.db.get('SELECT workspace_id FROM sso_configs WHERE email_domain = ? AND workspace_id <> ?', domain, workspaceId);
  if (clash) fail(409, 'domain_taken', 'Another workspace already uses SSO for this domain.', { field: 'email_domain' });
  const existing = app.db.get('SELECT client_secret FROM sso_configs WHERE workspace_id = ?', workspaceId);
  const secret = body.client_secret ? encryptJson(app.config, { secret: text(body.client_secret, 'client_secret', { min: 1, max: 500 }) }) : existing?.client_secret;
  if (!secret) fail(400, 'validation_failed', 'Enter the client secret.', { field: 'client_secret' });
  app.db.run(`INSERT INTO sso_configs (workspace_id, issuer, client_id, client_secret, email_domain, default_role, enforced, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id) DO UPDATE SET issuer = excluded.issuer, client_id = excluded.client_id, client_secret = excluded.client_secret, email_domain = excluded.email_domain,
      default_role = excluded.default_role, enforced = excluded.enforced, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  workspaceId, issuer.href.replace(/\/$/, ''), text(body.client_id, 'client_id', { min: 1, max: 300 }), secret, domain, oneOf(body.default_role ?? 'member', 'default_role', ['member', 'admin']),
  body.enforced === undefined ? 0 : bool(body.enforced, 'enforced') ? 1 : 0, body.enabled === undefined ? 1 : bool(body.enabled, 'enabled') ? 1 : 0, app.now());
  discoveryCache.delete(workspaceId);
  return getSsoConfig(app, workspaceId);
}

async function discover(app, issuer) {
  const cached = discoveryCache.get(issuer);
  if (cached && cached.until > Date.now()) return cached.value;
  const response = await app.fetchProvider(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) fail(502, 'sso_unavailable', 'The identity provider could not be reached.');
  const value = await response.json();
  discoveryCache.set(issuer, { value, until: Date.now() + 3600000 });
  return value;
}

// Password sign-in is refused for addresses whose domain enforces SSO.
export function assertPasswordAllowed(app, email) {
  const domain = String(email).split('@')[1]?.toLowerCase();
  const config = domain && app.db.get('SELECT w.slug FROM sso_configs s JOIN workspaces w ON w.id = s.workspace_id WHERE s.email_domain = ? AND s.enforced = 1 AND s.enabled = 1', domain);
  if (config) fail(403, 'sso_required', 'Your organization requires single sign-on.', { workspace: config.slug });
}

// Finds the SSO workspace for an email address or a workspace slug.
export function ssoWorkspaceFor(app, { email, workspace }) {
  const domain = email ? String(email).split('@')[1]?.toLowerCase() : null;
  return app.db.get(`SELECT w.id, w.slug FROM sso_configs s JOIN workspaces w ON w.id = s.workspace_id WHERE s.enabled = 1 AND (w.slug = ? OR s.email_domain = ?)`, workspace ?? '', domain ?? '');
}

export async function startSso(app, workspaceId) {
  const config = app.db.get('SELECT * FROM sso_configs WHERE workspace_id = ? AND enabled = 1', workspaceId);
  if (!config) fail(404, 'not_found', 'Single sign-on is not set up for this workspace.');
  const metadata = await discover(app, config.issuer);
  const verifier = randomBytes(32).toString('base64url');
  const flow = { ws: workspaceId, state: newToken(16), nonce: newToken(16), verifier, exp: app.now() + 10 * 60000 };
  const params = new URLSearchParams({
    client_id: config.client_id, response_type: 'code', scope: 'openid email profile', redirect_uri: redirectUri(app),
    state: flow.state, nonce: flow.nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256'
  });
  // The flow details (including the PKCE verifier) travel in an encrypted, HttpOnly cookie.
  const cookie = `${FLOW_COOKIE}=${encodeURIComponent(encryptJson(app.config, flow))}; Path=/api/auth/sso; HttpOnly; SameSite=Lax; Max-Age=600${flowCookieScope(app)}`;
  return { url: `${metadata.authorization_endpoint}?${params}`, cookie };
}

function decodeJwt(token) {
  const [header, payload, signature] = String(token).split('.');
  if (!header || !payload || !signature) throw new Error('Malformed ID token.');
  return { header: JSON.parse(Buffer.from(header, 'base64url')), payload: JSON.parse(Buffer.from(payload, 'base64url')), signed: `${header}.${payload}`, signature: Buffer.from(signature, 'base64url') };
}

async function verifyIdToken(app, metadata, config, idToken, nonce) {
  const token = decodeJwt(idToken);
  if (!['RS256', 'ES256', 'PS256'].includes(token.header.alg)) throw new Error('Unsupported token algorithm.');
  const jwks = await (await app.fetchProvider(metadata.jwks_uri, { signal: AbortSignal.timeout(10000) })).json();
  const jwk = jwks.keys?.find(key => key.kid === token.header.kid) || (jwks.keys?.length === 1 ? jwks.keys[0] : null);
  if (!jwk) throw new Error('Signing key not found.');
  const key = createPublicKey({ key: jwk, format: 'jwk' });
  const options = token.header.alg === 'PS256' ? { key, padding: 6, saltLength: 32 } : token.header.alg === 'ES256' ? { key, dsaEncoding: 'ieee-p1363' } : key;
  if (!verify('sha256', Buffer.from(token.signed), options, token.signature)) throw new Error('ID token signature is invalid.');
  const claims = token.payload;
  const now = app.now() / 1000;
  if (claims.iss !== metadata.issuer && claims.iss !== config.issuer) throw new Error('ID token issuer does not match.');
  if (!(Array.isArray(claims.aud) ? claims.aud.includes(config.client_id) : claims.aud === config.client_id)) throw new Error('ID token audience does not match.');
  if (!claims.exp || claims.exp < now - 60) throw new Error('ID token expired.');
  if (claims.nonce !== nonce) throw new Error('ID token nonce does not match.');
  return claims;
}

export async function finishSso(app, request, query) {
  const raw = parseCookies(request.headers.cookie)[FLOW_COOKIE];
  if (!raw) fail(400, 'invalid_state', 'Sign-in session expired. Try again.');
  let flow;
  try { flow = decryptJson(app.config, raw); } catch { fail(400, 'invalid_state', 'Sign-in session expired. Try again.'); }
  if (flow.exp < app.now() || flow.state !== query.get('state')) fail(400, 'invalid_state', 'Sign-in session expired. Try again.');
  if (query.get('error')) fail(401, 'sso_denied', 'The identity provider did not approve the sign-in.');
  const config = app.db.get('SELECT * FROM sso_configs WHERE workspace_id = ? AND enabled = 1', flow.ws);
  if (!config) fail(404, 'not_found', 'Single sign-on is not set up for this workspace.');
  const metadata = await discover(app, config.issuer);
  const response = await app.fetchProvider(metadata.token_endpoint, {
    method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: query.get('code') || '', redirect_uri: redirectUri(app), client_id: config.client_id,
      client_secret: decryptJson(app.config, config.client_secret).secret, code_verifier: flow.verifier })
  });
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || !tokens.id_token) fail(401, 'sso_failed', 'The identity provider did not complete sign-in.');
  let claims;
  try { claims = await verifyIdToken(app, metadata, config, tokens.id_token, flow.nonce); }
  catch (error) { fail(401, 'sso_failed', error.message); }
  const email = String(claims.email || '').toLowerCase();
  if (!email || claims.email_verified === false) fail(403, 'sso_failed', 'The identity provider did not share a verified email address.');
  if (email.split('@')[1] !== config.email_domain) fail(403, 'sso_failed', `Only @${config.email_domain} accounts can sign in here.`);
  let user = app.db.get('SELECT id FROM users WHERE email = ?', email);
  if (!user) {
    // SSO-only accounts get an unusable random password.
    user = { id: randomUUID() };
    app.db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', user.id, email, String(claims.name || email.split('@')[0]).slice(0, 100), await hashPassword(newToken(32)), app.now());
  }
  app.db.run('INSERT OR IGNORE INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)', flow.ws, user.id, config.default_role, app.now());
  const session = createSession(app, user.id);
  return { cookies: [session.cookie, `${FLOW_COOKIE}=; Path=/api/auth/sso; HttpOnly; SameSite=Lax; Max-Age=0${flowCookieScope(app)}`], workspaceId: flow.ws };
}
