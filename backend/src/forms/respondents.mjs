// Respondent sign-in (docs/FORMS.md, "Respondent sign-in"). Three things stay separate:
//   - a question key targets a field (definitions, prefilled links);
//   - a response id identifies a submission (receipt reference, inbox);
//   - a verified respondent is who signed in through the workspace's identity provider.
// A respondent session is not a user, a membership or a member session. It is only read by the public
// form routes of the workspace it belongs to, and gives no access to anything a workspace member can do.
import { createHash, randomBytes } from 'node:crypto';
import { fail, parseCookies } from '../http.mjs';
import { assertAuthoringOpen } from './freeze.mjs';
import { getForm } from './service.mjs';

export const RESPONDENT_COOKIE = 'schedora_respondent';
export const RESPONDENT_SESSION_MS = 2 * 60 * 60 * 1000;
export const FORM_ACCESS = ['public', 'signin'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const cookieScope = app => `; Path=/api/public/forms; HttpOnly; SameSite=Lax${app.config.production ? '; Secure' : ''}${app.config.cookieDomain ? '; Domain=' + app.config.cookieDomain : ''}`;

/** The signed-in respondent for this workspace, or null. Expired or foreign sessions count as none. */
export function respondentFor(app, request, workspaceId) {
  const token = parseCookies(request.headers.cookie)[RESPONDENT_COOKIE];
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{30,64}$/.test(token)) return null;
  const row = app.db.get('SELECT workspace_id, issuer, subject, email, name, created_at, expires_at FROM respondent_sessions WHERE token_hash = ?', sha256(token));
  if (!row || row.workspace_id !== workspaceId || row.expires_at <= app.now()) return null;
  return { issuer: row.issuer, subject: row.subject, email: row.email, name: row.name || null, verified_at: row.created_at };
}

/** Starts a respondent session after a verified sign-in. Returns the cookie to set. */
export function createRespondentSession(app, workspaceId, identity) {
  if (!identity.subject || !identity.email) fail(403, 'sso_failed', 'The identity provider did not share who you are.');
  const token = randomBytes(32).toString('base64url');
  const now = app.now();
  app.db.run('DELETE FROM respondent_sessions WHERE expires_at <= ?', now);
  app.db.run('INSERT INTO respondent_sessions (token_hash, workspace_id, issuer, subject, email, name, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    sha256(token), workspaceId, identity.issuer, identity.subject, identity.email, identity.name, now, now + RESPONDENT_SESSION_MS);
  return `${RESPONDENT_COOKIE}=${token}${cookieScope(app)}; Max-Age=${RESPONDENT_SESSION_MS / 1000}`;
}

/** Ends the session in this browser, if any. Returns the cookie that clears it. */
export function endRespondentSession(app, request) {
  const token = parseCookies(request.headers.cookie)[RESPONDENT_COOKIE];
  if (typeof token === 'string') app.db.run('DELETE FROM respondent_sessions WHERE token_hash = ?', sha256(token));
  return `${RESPONDENT_COOKIE}=${cookieScope(app)}; Max-Age=0`;
}

/** Whether respondent sign-in is switched on for this deployment (FORMS_RESPONDENT_SIGNIN=enabled). */
export const respondentSigninEnabled = app => app.config.respondentSignin === true;
const SWITCHED_OFF = 'This form only accepts people who sign in, and sign-in for respondents is switched off. Nothing was shown or submitted. Contact the form owner.';

const signinAvailable = (app, workspaceId) => app.db.get('SELECT issuer, email_domain FROM sso_configs WHERE workspace_id = ? AND enabled = 1', workspaceId) || null;

/** What the builder may show about sign-in for this workspace. Never the client id or secret. */
export function signinProvider(app, workspaceId) {
  const config = signinAvailable(app, workspaceId);
  if (!config) return null;
  let host = config.issuer;
  try { host = new URL(config.issuer).host; } catch { /* keep the stored value */ }
  return { issuer_host: host, email_domain: config.email_domain };
}

/**
 * Enforces a form's access setting for a public request: returns the respondent (or null on a public
 * form), or refuses. Sign-in is checked before anything about the form's content is revealed or stored.
 */
export function assertFormAccess(app, request, form) {
  if ((form.access || 'public') !== 'signin') return null;
  // Switched off: a sign-in-only form fails closed for everyone, whatever session the request carries.
  if (!respondentSigninEnabled(app)) fail(503, 'signin_unavailable', SWITCHED_OFF, { workspace_name: form.workspace_name, reason: 'switched_off' });
  if (!signinAvailable(app, form.workspace_id)) fail(503, 'signin_unavailable', 'This form needs you to sign in, and sign-in is not available right now. Nothing was submitted. Contact the form owner.', { workspace_name: form.workspace_name });
  const respondent = respondentFor(app, request, form.workspace_id);
  if (!respondent) fail(401, 'signin_required', 'Sign in to answer this form.', { workspace_name: form.workspace_name, signin_url: `/api/public/forms/${form.slug}/signin` });
  return respondent;
}

/** Sets who can respond. Requires the workspace's SSO for 'signin'; takes effect on the live form at once. */
export function setFormAccess(app, workspaceId, id, body) {
  assertAuthoringOpen(app);
  const access = body?.access;
  if (!FORM_ACCESS.includes(access)) fail(400, 'validation_failed', 'Choose who can respond: anyone with the link, or only people who sign in.', { field: 'access' });
  getForm(app, workspaceId, id);
  if (access === 'signin' && !respondentSigninEnabled(app)) fail(400, 'respondent_signin_disabled', 'Sign-in for respondents is switched off on this Schedora deployment, so a form cannot require it. Anyone with the link can still respond.', { field: 'access' });
  if (access === 'signin' && !signinAvailable(app, workspaceId)) fail(400, 'signin_unavailable', 'Set up single sign-on for this workspace first (Account & settings → Single sign-on). Respondents sign in with the same identity provider.', { field: 'access' });
  app.db.run('UPDATE forms SET access = ?, updated_at = ? WHERE id = ? AND workspace_id = ?', access, app.now(), id, workspaceId);
  return getForm(app, workspaceId, id);
}

/** Keeps only what a sign-in return address may carry back to the form page: its own query string. */
export function safeReturnSearch(raw) {
  if (typeof raw !== 'string' || raw.length > 2000) return '';
  const params = new URLSearchParams(raw.replace(/^\?/, ''));
  params.delete('signin_error');
  const text = params.toString();
  return text ? '?' + text : '';
}
