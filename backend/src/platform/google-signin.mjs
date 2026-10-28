import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { fail, parseCookies } from '../http.mjs';
import { email as validEmail } from '../validate.mjs';
import { clearSessionCookie, createSession, createWorkspaceRecord, deleteAccountRecords, hashPassword, newToken, sha256, signOut } from './auth.mjs';
import { decryptJson, encryptJson } from './crypto.mjs';
import { assertPasswordAllowed } from './sso.mjs';

const FLOW_COOKIE = 'schedora_google_login';
const AUTHORIZE = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const JWKS = 'https://www.googleapis.com/oauth2/v3/certs';
export const googleLoginSettings = app => app.config.googleSignIn?.clientId ? app.config.googleSignIn : app.config.google;
export const googleLoginEnabled = app => Boolean(googleLoginSettings(app)?.clientId && googleLoginSettings(app)?.clientSecret && (!app.config.production || app.config.encryptionKey));
export const googleLoginRedirect = app => `${app.config.baseUrl}/api/auth/google/callback`;
const cookieScope = app => `${app.config.production ? '; Secure' : ''}${app.config.cookieDomain ? '; Domain=' + app.config.cookieDomain : ''}`;
export const clearGoogleLoginCookie = app => `${FLOW_COOKIE}=; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=0${cookieScope(app)}`;
const NEXT_PATH = /^\/(meet|forms|flow|account|billing|enquiries|setup)(?:[/?#]|$)/;
// Where to return after Google: a same-host app path, or an absolute https address on the product
// domain or its meet./forms./flow. hosts (so sign-in keeps the product the person started from).
export function safeGoogleNext(next, productDomain = 'schedora.in') {
  if (typeof next !== 'string' || next.length >= 500 || /[\\\s]/.test(next)) return '/meet';
  if (NEXT_PATH.test(next)) return next;
  let url;
  try { url = new URL(next); } catch { return '/meet'; }
  const hosts = [productDomain, ...['meet', 'forms', 'flow'].map(key => `${key}.${productDomain}`)];
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !hosts.includes(url.hostname)) return '/meet';
  const path = url.pathname + url.search + url.hash;
  return NEXT_PATH.test(path) ? url.origin + path : '/meet';
}
// The product host a validated next address belongs to ('' for a same-host path).
export const nextOrigin = next => /^https:\/\//.test(next || '') ? new URL(next).origin : '';

export function startGoogleLogin(app, { next, userId = null, action = 'login' } = {}) {
  if (!googleLoginEnabled(app)) fail(503, 'google_not_configured', 'Google sign-in is not configured on this server yet.');
  const flow = { state: newToken(), nonce: newToken(), verifier: newToken(), next: safeGoogleNext(next, app.config.productDomain), userId, action, exp: app.now() + 600000 };
  app.db.run('DELETE FROM auth_login_flows WHERE expires_at < ?', app.now());
  app.db.run('INSERT INTO auth_login_flows (state_hash, expires_at) VALUES (?, ?)', sha256(flow.state), flow.exp);
  const cookie = `${FLOW_COOKIE}=${encodeURIComponent(encryptJson(app.config, flow))}; Path=/api/auth/google; HttpOnly; SameSite=Lax; Max-Age=600${cookieScope(app)}`;
  const params = new URLSearchParams({ client_id: googleLoginSettings(app).clientId, redirect_uri: googleLoginRedirect(app), response_type: 'code', scope: 'openid email profile',
    state: flow.state, nonce: flow.nonce, prompt: 'select_account', code_challenge: createHash('sha256').update(flow.verifier).digest('base64url'), code_challenge_method: 'S256' });
  return { url: `${AUTHORIZE}?${params}`, cookie };
}

async function googleClaims(app, token, nonce) {
  const pieces = String(token || '').split('.');
  if (pieces.length !== 3) throw new Error('Malformed ID token.');
  const header = JSON.parse(Buffer.from(pieces[0], 'base64url'));
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('Invalid signing algorithm.');
  const response = await app.fetchProvider(JWKS, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error('Signing keys unavailable.');
  const keys = await response.json();
  const jwk = keys.keys?.find(key => key.kid === header.kid && key.kty === 'RSA' && (!key.use || key.use === 'sig') && (!key.alg || key.alg === 'RS256'));
  if (!jwk || !verify('sha256', Buffer.from(pieces.slice(0, 2).join('.')), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(pieces[2], 'base64url'))) throw new Error('Invalid ID token signature.');
  const claims = JSON.parse(Buffer.from(pieces[1], 'base64url'));
  const clientId = googleLoginSettings(app).clientId;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const now = app.now() / 1000;
  if (!['https://accounts.google.com', 'accounts.google.com'].includes(claims.iss) || !audiences.includes(clientId)) throw new Error('Invalid token issuer or audience.');
  if ((audiences.length > 1 && claims.azp !== clientId) || (claims.azp && claims.azp !== clientId)) throw new Error('Invalid authorized party.');
  if (!Number.isFinite(claims.exp) || claims.exp <= now || !Number.isFinite(claims.iat) || claims.iat > now + 60 || claims.nonce !== nonce) throw new Error('Expired or invalid sign-in token.');
  if (typeof claims.sub !== 'string' || !claims.sub || claims.sub.length > 255 || claims.email_verified !== true) throw new Error('Verified Google identity required.');
  claims.email = validEmail(claims.email);
  return claims;
}

export async function finishGoogleLogin(app, request, query, currentSession) {
  let flow;
  try { flow = decryptJson(app.config, parseCookies(request.headers.cookie)[FLOW_COOKIE]); }
  catch { fail(400, 'invalid_state', 'Google sign-in expired. Please start again.'); }
  // Errors return to the product host the sign-in started from.
  try { return await completeGoogleLogin(app, flow, query, currentSession); }
  catch (error) { error.returnOrigin = nextOrigin(flow?.next); throw error; }
}

async function completeGoogleLogin(app, flow, query, currentSession) {
  if (!flow || flow.exp <= app.now() || flow.state !== query.get('state')) fail(400, 'invalid_state', 'Google sign-in expired. Please start again.');
  // Consuming the stored state makes even a copied cookie/callback one-time across restarts.
  if (!app.db.run('DELETE FROM auth_login_flows WHERE state_hash = ? AND expires_at >= ?', sha256(flow.state), app.now()).changes) fail(400, 'invalid_state', 'This Google sign-in has already been used. Start again.');
  if (flow.userId && currentSession?.user.id !== flow.userId) fail(403, 'account_changed', 'Sign in to the account that started the Google connection.');
  if (query.get('error')) fail(401, 'google_denied', 'Google sign-in was canceled. You can try again or use your password.');
  const code = query.get('code');
  if (!code || code.length > 4000) fail(400, 'google_failed', 'Google did not return a sign-in code. Try again.');
  const credentials = googleLoginSettings(app);
  const response = await app.fetchProvider(TOKEN, { method: 'POST', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: googleLoginRedirect(app), client_id: credentials.clientId, client_secret: credentials.clientSecret, code_verifier: flow.verifier }) });
  const tokens = await response.json().catch(() => ({}));
  if (!response.ok || !tokens.id_token) fail(401, 'google_failed', 'Google could not complete sign-in. Please try again.');
  let claims;
  try { claims = await googleClaims(app, tokens.id_token, flow.nonce); }
  catch { fail(401, 'google_failed', 'Google could not verify this sign-in. Please start again.'); }
  assertPasswordAllowed(app, claims.email);
  const identity = app.db.get("SELECT user_id FROM auth_identities WHERE provider = 'google' AND subject = ?", claims.sub);
  if (flow.action === 'delete') {
    if (!flow.userId || !identity || identity.user_id !== flow.userId) fail(403, 'account_changed', 'Choose the Google account already linked to your Schedora account.');
    deleteAccountRecords(app, { id: flow.userId });
    return { cookie: clearSessionCookie(app.config), next: nextOrigin(flow.next) + '/account?deleted=1' };
  }
  let userId;
  if (flow.userId) {
    const user = app.db.get('SELECT id, email FROM users WHERE id = ?', flow.userId);
    if (!user || user.email !== claims.email) fail(409, 'email_mismatch', 'Choose the Google account with the same email as your Schedora account.');
    if (identity && identity.user_id !== user.id) fail(409, 'identity_taken', 'This Google account is already connected to another Schedora account.');
    const connected = app.db.get("SELECT subject FROM auth_identities WHERE provider = 'google' AND user_id = ?", user.id);
    if (connected && connected.subject !== claims.sub) fail(409, 'identity_taken', 'A different Google identity is already connected to this account.');
    userId = user.id;
    if (!identity) app.db.run("INSERT INTO auth_identities (provider, subject, user_id, email, created_at) VALUES ('google', ?, ?, ?, ?)", claims.sub, userId, claims.email, app.now());
  } else if (identity) {
    userId = identity.user_id;
    assertPasswordAllowed(app, app.db.get('SELECT email FROM users WHERE id = ?', userId).email);
  } else {
    const passwordHash = await hashPassword(newToken());
    app.db.transaction(() => {
      if (app.db.get('SELECT id FROM users WHERE email = ?', claims.email)) fail(409, 'account_exists', 'An account with this email already exists. Sign in with your password, then connect Google in Account.');
      userId = randomUUID();
      const name = String(claims.name || claims.email.split('@')[0]).trim().slice(0, 100) || 'Schedora user';
      app.db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', userId, claims.email, name, passwordHash, app.now());
      app.db.run("INSERT INTO auth_identities (provider, subject, user_id, email, created_at) VALUES ('google', ?, ?, ?, ?)", claims.sub, userId, claims.email, app.now());
      createWorkspaceRecord(app, userId, `${name}'s workspace`.slice(0, 100));
    });
  }
  if (currentSession) signOut(app, currentSession);
  const session = createSession(app, userId);
  return { cookie: session.cookie, next: flow.userId ? nextOrigin(flow.next) + '/account?google=connected' : flow.next };
}
