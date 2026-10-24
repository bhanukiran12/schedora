import { randomBytes, randomUUID, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fail, parseCookies } from '../http.mjs';
import { email as validEmail, password as validPassword, text, slugify } from '../validate.mjs';

const scryptAsync = promisify(scrypt);
const SESSION_DAYS = 30;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export const newToken = (bytes = 32) => randomBytes(bytes).toString('base64url');

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$16384$8$1$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, N, r, p, salt, hash] = String(stored).split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(N), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
  return timingSafeEqual(expected, actual);
}

// A dummy hash keeps sign-in timing similar whether or not the email exists.
let dummyHash;
const getDummyHash = async () => dummyHash ??= await hashPassword(newToken());

export function cookieName(config) {
  return config.cookieDomain || !config.production ? 'schedora_session' : '__Host-schedora_session';
}

function sessionCookie(config, value, maxAgeSeconds) {
  const parts = [`${cookieName(config)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (config.production) parts.push('Secure');
  if (config.cookieDomain) parts.push('Domain=' + config.cookieDomain);
  return parts.join('; ');
}

export function createSession(app, userId) {
  const token = newToken();
  const csrf = newToken(24);
  const now = app.now();
  app.db.run('INSERT INTO sessions (token_hash, user_id, csrf_token, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', sha256(token), userId, csrf, now, now + SESSION_DAYS * 86400000);
  return { cookie: sessionCookie(app.config, token, SESSION_DAYS * 86400), csrf };
}

export function clearSessionCookie(config) {
  return sessionCookie(config, '', 0);
}

export function loadSession(app, request) {
  const token = parseCookies(request.headers.cookie)[cookieName(app.config)];
  if (!token) return null;
  const session = app.db.get(`SELECT s.token_hash, s.csrf_token, s.expires_at, u.id, u.email, u.name
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`, sha256(token));
  if (!session || session.expires_at < app.now()) return null;
  return { tokenHash: session.token_hash, csrf: session.csrf_token, user: { id: session.id, email: session.email, name: session.name } };
}

export async function signUp(app, body) {
  const name = text(body.name, 'name', { min: 1, max: 100 });
  const address = validEmail(body.email);
  const secret = validPassword(body.password);
  const workspaceName = text(body.workspace || `${name}'s workspace`, 'workspace', { min: 1, max: 100 });
  const passwordHash = await hashPassword(secret);
  const now = app.now();
  const userId = randomUUID();
  app.db.transaction(() => {
    if (app.db.get('SELECT 1 FROM users WHERE email = ?', address)) fail(409, 'email_taken', 'An account with this email already exists. Sign in instead.', { field: 'email' });
    app.db.run('INSERT INTO users (id, email, name, password_hash, created_at) VALUES (?, ?, ?, ?, ?)', userId, address, name, passwordHash, now);
    createWorkspaceRecord(app, userId, workspaceName);
  });
  return userId;
}

export function createWorkspaceRecord(app, ownerId, name) {
  const id = randomUUID();
  // Workspace slugs share the /meet/<workspace>/<event> namespace with host pages.
  let base = slugify(name).slice(0, 40);
  if (['event-types', 'manage', 'new', 'bookings', 'pay', 'poll', 'polls', 'route', 'u', 'api', 'contacts', 'embed'].includes(base) || base.length < 2) base = `${base}-workspace`.replace(/^-/, '');
  let slug = base;
  for (let attempt = 2; app.db.get('SELECT 1 FROM workspaces WHERE slug = ?', slug); attempt++) slug = `${base}-${attempt}`;
  const now = app.now();
  app.db.run('INSERT INTO workspaces (id, name, slug, created_at) VALUES (?, ?, ?, ?)', id, name, slug, now);
  app.db.run("INSERT INTO memberships (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)", id, ownerId, now);
  return id;
}

export async function signIn(app, body) {
  const address = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const { assertPasswordAllowed } = await import('./sso.mjs');
  assertPasswordAllowed(app, address);
  const secret = typeof body.password === 'string' ? body.password : '';
  const user = address && app.db.get('SELECT id, password_hash FROM users WHERE email = ?', address);
  const ok = user ? await verifyPassword(secret, user.password_hash) : (await verifyPassword(secret, await getDummyHash()), false);
  if (!ok) fail(401, 'invalid_credentials', 'Email or password is incorrect.');
  return user.id;
}

export function signOut(app, session) {
  if (session) app.db.run('DELETE FROM sessions WHERE token_hash = ?', session.tokenHash);
}

// Deletes the account. Workspaces where the user is the only owner are deleted with all their data;
// other workspaces keep their records and lose this member.
export async function deleteAccount(app, user, body) {
  const record = app.db.get('SELECT password_hash FROM users WHERE id = ?', user.id);
  if (!record || !(await verifyPassword(String(body.password || ''), record.password_hash))) fail(401, 'invalid_credentials', 'Password is incorrect.', { field: 'password' });
  app.db.transaction(() => {
    const owned = app.db.all("SELECT workspace_id FROM memberships WHERE user_id = ? AND role = 'owner'", user.id);
    for (const { workspace_id } of owned) {
      const owners = app.db.get("SELECT COUNT(*) AS count FROM memberships WHERE workspace_id = ? AND role = 'owner'", workspace_id).count;
      if (owners === 1) app.db.run('DELETE FROM workspaces WHERE id = ?', workspace_id);
    }
    app.db.run('DELETE FROM users WHERE id = ?', user.id);
  });
}
