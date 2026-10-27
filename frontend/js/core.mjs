// Shared browser utilities: safe templating, API client, session state, form errors, dialogs and time formatting.

// Filled at start-up from GET /api/config plus values derived from the current host.
export const boot = {};

class Raw { constructor(value) { this.value = value; } toString() { return this.value; } }
export const raw = value => new Raw(value);
export const esc = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
const renderValue = value => value == null || value === false ? '' : value instanceof Raw ? value.value : Array.isArray(value) ? value.map(renderValue).join('') : esc(value);
// Tagged template that escapes every interpolation unless it is already trusted markup.
export function html(strings, ...values) {
  let out = strings[0];
  values.forEach((value, index) => { out += renderValue(value) + strings[index + 1]; });
  return new Raw(out);
}
export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export function mount(target, content) { target.innerHTML = String(content); return target; }

export function uid() {
  if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
  return [...crypto.getRandomValues(new Uint8Array(16))].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export const storage = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked: preference lasts for this page only */ } }
};

// ---- API ----
export class ApiError extends Error {
  constructor(status, error) {
    super(error?.message || 'Request failed.');
    this.status = status;
    this.code = error?.code || 'error';
    this.details = error || {};
  }
}

export const session = { user: null, csrf: null, workspaces: [], workspaceId: null };

export async function api(method, path, body, headers = {}) {
  let response;
  try {
    response = await fetch(path, {
      method, credentials: 'same-origin',
      ...(method === 'GET' ? { signal: AbortSignal.timeout(25000) } : {}),
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(session.csrf ? { 'X-CSRF-Token': session.csrf } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
  } catch {
    throw new ApiError(0, { code: 'network', message: 'Could not reach Schedora. Check your connection and try again.' });
  }
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new ApiError(response.status, data?.error);
  return data;
}

export function applyMe(data) {
  session.user = data.user;
  session.csrf = data.csrf_token || null;
  session.workspaces = data.workspaces || [];
  const saved = storage.get('schedora.workspace');
  session.workspaceId = session.workspaces.some(workspace => workspace.id === saved) ? saved : session.workspaces[0]?.id || null;
}
export async function loadMe() { applyMe(await api('GET', '/api/me')); }
export const workspace = () => session.workspaces.find(item => item.id === session.workspaceId) || null;
export function selectWorkspace(id) { session.workspaceId = id; storage.set('schedora.workspace', id); }
export const wsPath = path => `/api/workspaces/${encodeURIComponent(session.workspaceId)}${path}`;
export const isAdmin = () => ['owner', 'admin'].includes(workspace()?.role);

// ---- Feedback ----
export function toast(message) {
  const region = document.getElementById('toasts');
  const item = document.createElement('div');
  item.className = 'toast';
  item.textContent = message;
  region.append(item);
  setTimeout(() => item.remove(), 5000);
}

export function notice(kind, content) {
  return html`<div class="notice notice-${kind}" role="${kind === 'bad' ? 'alert' : 'status'}">${content}</div>`;
}
export const loading = (label = 'Loading…') => html`<div class="loading" role="status">${label}</div>`;
export const errorBlock = error => notice('bad', html`<p>${error.message}</p>`);

const BADGES = {
  ok: ['confirmed', 'sent', 'succeeded', 'active', 'enabled', 'published', 'done', 'trialing'],
  warn: ['queued', 'scheduled', 'sending', 'running', 'retrying', 'pending', 'paused', 'draft', 'past_due', 'open', 'incomplete'],
  bad: ['failed', 'canceled', 'revoked', 'error']
};
export function badge(status, label) {
  const kind = Object.entries(BADGES).find(([, values]) => values.includes(status))?.[0] || 'neutral';
  return html`<span class="badge badge-${kind}">${label || status.replace(/_/g, ' ')}</span>`;
}

// Shows server or client validation errors next to the matching inputs, keeping typed answers.
export function showErrors(form, error) {
  clearErrors(form);
  const fieldErrors = error.details?.errors || (error.details?.field ? { [error.details.field]: error.message } : {});
  let first = null;
  const unmatched = [];
  for (const [name, message] of Object.entries(fieldErrors)) {
    const input = form.querySelector(`[name="${CSS.escape(name)}"]`);
    if (!input) { unmatched.push(message); continue; }
    const holder = input.closest('fieldset') || input;
    const id = (input.id || name.replace(/\W/g, '-')) + '-error';
    const message_ = document.createElement('div');
    message_.className = 'field-error';
    message_.id = id;
    message_.textContent = message;
    holder.insertAdjacentElement('afterend', message_);
    for (const target of holder.matches('fieldset') ? holder.querySelectorAll('input') : [input]) {
      target.setAttribute('aria-invalid', 'true');
      target.setAttribute('aria-describedby', [target.getAttribute('aria-describedby'), id].filter(Boolean).join(' '));
    }
    first ??= input;
  }
  const status = form.querySelector('[data-form-status]');
  if (status && (unmatched.length || !first)) {
    const problems = error.details?.problems;
    mount(status, notice('bad', problems?.length > 1 ? html`<p>${error.message}</p><ul>${problems.slice(1, 6).map(problem => html`<li>${problem}</li>`)}</ul>` : html`<p>${unmatched[0] || error.message}</p>`));
  }
  (first || status)?.focus?.();
  if (!first && status) status.scrollIntoView({ block: 'nearest' });
}
export function clearErrors(form) {
  $$('.field-error', form).forEach(element => element.remove());
  $$('[aria-invalid]', form).forEach(element => {
    element.removeAttribute('aria-invalid');
    const describedBy = (element.getAttribute('aria-describedby') || '').split(' ').filter(id => id && !id.endsWith('-error')).join(' ');
    if (describedBy) element.setAttribute('aria-describedby', describedBy); else element.removeAttribute('aria-describedby');
  });
  const status = form.querySelector('[data-form-status]');
  if (status) status.innerHTML = '';
}

export function values(form) {
  const result = {};
  for (const element of form.elements) {
    if (!element.name || element.disabled) continue;
    if (element.type === 'checkbox') result[element.name] = element.checked;
    else if (element.type === 'radio') { if (element.checked) result[element.name] = element.value; }
    else if (element.type === 'number') result[element.name] = element.value === '' ? null : Number(element.value);
    else result[element.name] = element.value;
  }
  return result;
}

// Wraps a submit handler with busy state and error display.
export function handleSubmit(form, handler) {
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.dataset.busy) return;
    const button = event.submitter || form.querySelector('[type="submit"]');
    form.dataset.busy = '1';
    button?.setAttribute('aria-disabled', 'true');
    clearErrors(form);
    try { await handler(values(form), event); }
    catch (error) { if (form.isConnected) showErrors(form, error); else toast(error.message); }
    finally { delete form.dataset.busy; button?.removeAttribute('aria-disabled'); }
  });
}

// Accessible modal using <dialog>. Resolves with form values or null when dismissed.
export function ask({ title, body = '', fields = '', confirm = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'card';
    dialog.setAttribute('aria-labelledby', 'dialog-title');
    mount(dialog, html`<form method="dialog"><h2 id="dialog-title">${title}</h2>${body ? html`<p>${body}</p>` : ''}${fields}
      <div class="actions"><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" value="ok">${confirm}</button><button class="btn" value="cancel" formnovalidate>Keep as is</button></div></form>`);
    const opener = document.activeElement;
    document.body.append(dialog);
    dialog.addEventListener('close', () => {
      const result = dialog.returnValue === 'ok' ? values(dialog.querySelector('form')) : null;
      dialog.remove();
      opener?.focus?.();
      resolve(result);
    });
    dialog.showModal();
  });
}

export async function copy(text, label = 'Link') {
  try { await navigator.clipboard.writeText(text); toast(`${label} copied.`); }
  catch { toast(`Copy failed. Select the ${label.toLowerCase()} and copy it manually.`); }
}

// ---- Time ----
// Older IANA names browsers still report (Chrome in India reports Asia/Calcutta). Mirrors
// ZONE_ALIASES in backend/src/time.mjs so the page and emails name a zone the same way.
const ZONE_ALIASES = { 'Asia/Calcutta': 'Asia/Kolkata', 'Asia/Saigon': 'Asia/Ho_Chi_Minh', 'Asia/Katmandu': 'Asia/Kathmandu', 'Asia/Rangoon': 'Asia/Yangon',
  'Europe/Kiev': 'Europe/Kyiv', 'America/Buenos_Aires': 'America/Argentina/Buenos_Aires', 'Etc/UTC': 'UTC', 'Etc/GMT': 'UTC', GMT: 'UTC' };
export const canonicalZone = timeZone => ZONE_ALIASES[timeZone] || timeZone;
const zonePlace = zone => zone === 'UTC' ? 'UTC' : zone.split('/').pop().replace(/_/g, ' ');
// "India Standard Time (UTC+05:30)" with the offset in effect at the given instant (daylight saving).
export function zoneLabel(timeZone, at = Date.now()) {
  const zone = canonicalZone(timeZone);
  const part = style => { try { return new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: style }).formatToParts(new Date(at)).find(item => item.type === 'timeZoneName')?.value || ''; } catch { return ''; } };
  const offset = part('longOffset').replace(/^GMT$/, 'GMT+00:00').replace('GMT', 'UTC');
  const name = part('long');
  return `${/^GMT|^UTC/.test(name) || !name ? (zone === 'UTC' ? 'Coordinated Universal Time' : zonePlace(zone)) : name}${offset ? ` (${offset})` : ''}`;
}
export const browserZone = () => canonicalZone(Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC');
export function timeZones(extra = []) {
  let zones = [];
  try { zones = Intl.supportedValuesOf('timeZone'); } catch { zones = ['UTC', 'Asia/Kolkata', 'Europe/London', 'America/New_York']; }
  return [...new Set([...extra.filter(Boolean), 'UTC', ...zones].map(canonicalZone))].sort((a, b) => a.localeCompare(b));
}
// Options keep the stored IANA value; the text names the place and its current offset.
export const zoneOptions = (selected, extra = []) => {
  const chosen = canonicalZone(selected);
  return timeZones([selected, ...extra]).map(zone => html`<option value="${zone}" ${zone === chosen ? raw('selected') : ''}>${zonePlace(zone)} · ${zoneLabel(zone)}</option>`);
};
export const fmt = (value, timeZone, options) => new Intl.DateTimeFormat(undefined, { timeZone, ...options }).format(new Date(value));
export const fmtDateTime = (value, timeZone) => fmt(value, timeZone, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtFull = (value, timeZone) => fmt(value, timeZone, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit' });
export const fmtTime = (value, timeZone) => fmt(value, timeZone, { hour: 'numeric', minute: '2-digit' });
export const dateKey = (value, timeZone) => new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
export const minutesToTime = minutes => minutes >= 1440 ? '00:00' : `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
export function timeToMinutes(value, isEnd) {
  const [hours, minutes] = String(value).split(':').map(Number);
  const total = hours * 60 + minutes;
  return isEnd && total === 0 ? 1440 : total;
}
