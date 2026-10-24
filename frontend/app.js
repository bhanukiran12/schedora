import { $, api, boot, html, loadMe, mount, raw, selectWorkspace, session, storage, workspace } from './js/core.mjs';
import * as pages from './js/pages.mjs';
import * as meet from './js/meet.mjs';
import * as team from './js/meet-team.mjs';
import * as forms from './js/forms.mjs';
import * as flow from './js/flow.mjs';
import * as account from './js/account.mjs';
import { loadStartupConfig } from './js/connection.mjs';
import { productLanding } from './js/product-landing.mjs';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const routes = [
  [/^\/$/, pages.home],
  [/^\/products\/(meet|forms|flow)$/, productLanding],
  [/^\/meet$/, meet.dashboard],
  [new RegExp(`^/meet/event-types/(new|${UUID.slice(1, -1)})$`), meet.editor],
  [/^\/meet\/manage\/([A-Za-z0-9_-]{20,100})$/, meet.manage],
  [/^\/meet\/pay\/([A-Za-z0-9_-]{20,100})$/, meet.pay],
  [/^\/meet\/poll\/([a-z0-9-]{3,60})$/, team.publicPoll],
  [new RegExp(`^/meet/contacts/${UUID}$`), team.contactPage],
  [/^\/recap\/([A-Za-z0-9_-]{20,100})$/, ctx => team.publicRecap(ctx)],
  [/^\/(?:embed\/)?meet\/([a-z0-9-]{2,60})\/([a-z0-9-]{2,60})$/, meet.booking],
  [/^\/meet\/([a-z0-9-]{2,60})$/, meet.workspacePage],
  [/^\/forms$/, forms.dashboard],
  [new RegExp(`^/forms/${UUID}$`), forms.builder],
  [new RegExp(`^/forms/${UUID}/responses$`), forms.responses],
  [/^\/f\/([a-z0-9-]{3,60})$/, forms.publicForm],
  [/^\/flow$/, flow.dashboard],
  [/^\/flow\/(runs|tasks)$/, flow.dashboard],
  [new RegExp(`^/flow/(new|${UUID.slice(1, -1)})$`), flow.editor],
  [/^\/account$/, account.account],
  [/^\/billing$/, account.billing],
  [/^\/privacy$/, pages.privacy],
  [/^\/terms$/, pages.terms]
];

const PRODUCTS = {
  suite: { name: 'Schedora', logo: '/logo-schedora.png' },
  meet: { name: 'Meet', logo: '/logo-meet.png' },
  forms: { name: 'Forms', logo: '/logo-forms.png' },
  flow: { name: 'Flow', logo: '/logo-flow.png' }
};
export const productFor = path => /^\/products\/(meet|forms|flow)$/.exec(path)?.[1] || (path.startsWith('/meet') || path.startsWith('/embed/meet') || path.startsWith('/recap') ? 'meet' : path.startsWith('/forms') || path.startsWith('/f/') ? 'forms' : path.startsWith('/flow') ? 'flow' : 'suite');
export const lockup = (key, large = false) => html`<span class="lockup ${large ? 'lockup-lg' : ''}"><img src="${PRODUCTS[key].logo}" alt="" width="28" height="28"><span class="lockup-name">${PRODUCTS[key].name}${key === 'suite' ? '' : html`<small>by Schedora</small>`}</span></span>`;

// ---- Theme ----
const THEMES = ['system', 'light', 'dark'];
let theme = THEMES.includes(storage.get('schedora.theme')) ? storage.get('schedora.theme') : 'system';
function applyTheme() {
  if (theme === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}
applyTheme();

// ---- Layout ----
let firstRender = true;
let currentPath = location.pathname;

function renderHeader(product) {
  const links = boot.links;
  const nav = [['suite', 'Suite', links.suite], ['meet', 'Meet', boot.landings.meet], ['forms', 'Forms', boot.landings.forms], ['flow', 'Flow', boot.landings.flow], ['billing', 'Plans', '/billing']];
  const current = currentPath === '/billing' ? 'billing' : product;
  const home = product === 'suite' ? links.suite : boot.landings[product];
  mount($('#site-header'), html`<div class="container header-inner">
    <a class="lockup" href="${home}" aria-label="${PRODUCTS[product].name}${product === 'suite' ? '' : ' by Schedora'}, home">${lockup(product)}</a>
    <nav class="site-nav" aria-label="Products">${nav.map(([key, label, href]) => html`<a href="${href}" ${key === current ? raw('aria-current="page"') : ''}>${label}</a>`)}</nav>
    <div class="header-tools">
      ${session.user && session.workspaces.length > 1 ? html`<label class="visually-hidden" for="workspace-switch">Workspace</label>
        <select id="workspace-switch">${session.workspaces.map(item => html`<option value="${item.id}" ${item.id === session.workspaceId ? raw('selected') : ''}>${item.name}</option>`)}</select>` : ''}
      <button class="btn btn-small" type="button" id="theme-toggle" aria-label="Color theme: ${theme}. Activate to change."><span aria-hidden="true">◐</span><span class="theme-label">${theme[0].toUpperCase() + theme.slice(1)}</span></button>
      <a class="btn btn-small" href="/account">${session.user ? 'Account' : 'Sign in'}</a>
    </div></div>`);
  $('#theme-toggle').onclick = () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    storage.set('schedora.theme', theme);
    applyTheme();
    renderHeader(product);
    $('#theme-toggle').focus();
  };
  const switcher = $('#workspace-switch');
  if (switcher) switcher.onchange = () => { selectWorkspace(switcher.value); render(); };
}

function renderFooter() {
  mount($('#site-footer'), html`<div class="container footer-inner">
    <span>Schedora · Make time for what matters.</span>
    <nav class="footer-links" aria-label="Legal"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><button class="btn-link" type="button" id="cookie-settings">Cookie settings</button></nav>
  </div>`);
  $('#cookie-settings').onclick = () => consentBanner(true);
}

// ---- Consent (optional analytics only; essential storage is listed in the privacy notice) ----
const CONSENT_KEY = 'schedora.consent.v1';
function consent() {
  try {
    const saved = JSON.parse(storage.get(CONSENT_KEY));
    return saved && Date.now() - saved.time < 180 * 86400000 ? saved.choice : null;
  } catch { return null; }
}
function consentBanner(focus) {
  $('.cookie-banner')?.remove();
  const panel = document.createElement('section');
  panel.className = 'cookie-banner';
  panel.setAttribute('aria-labelledby', 'consent-title');
  mount(panel, html`<h2 id="consent-title">Your privacy choices</h2>
    <p>Schedora uses a sign-in cookie and stores your theme, workspace and this choice in your browser. These are needed for the service. Optional analytics ${boot.analytics ? 'counts page views without identifiers' : 'is currently switched off'}. No advertising cookies. <a href="/privacy">Privacy policy</a>.</p>
    <div class="actions"><button class="btn" data-choice="rejected">Reject optional</button><button class="btn btn-primary" data-choice="accepted">Accept analytics</button></div>`);
  panel.querySelectorAll('[data-choice]').forEach(button => button.onclick = () => {
    storage.set(CONSENT_KEY, JSON.stringify({ choice: button.dataset.choice, time: Date.now() }));
    panel.remove();
    $('#cookie-settings')?.focus();
    countPage();
  });
  document.body.append(panel);
  if (focus) panel.querySelector('button').focus();
}
function countPage() {
  if (!boot.analytics || consent() !== 'accepted' || navigator.globalPrivacyControl) return;
  fetch('/api/analytics', { method: 'POST', headers: { 'X-Analytics-Consent': 'accepted', 'X-Page-Path': currentPath }, credentials: 'same-origin' }).catch(() => {});
}

// ---- Router ----
let renderToken = 0;
export function navigate(path, { replace = false } = {}) {
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  currentPath = location.pathname;
  render();
}

export async function render() {
  const token = ++renderToken;
  const main = $('#main');
  const query = new URLSearchParams(location.search);
  const product = productFor(currentPath);
  document.body.dataset.product = product === 'suite' ? 'meet' : product;
  if (query.get('embed') === '1' && currentPath.startsWith('/f/')) document.body.dataset.embed = '1';
  renderHeader(product);
  let view = pages.notFound;
  let params = [];
  for (const [pattern, handler] of routes) {
    const match = pattern.exec(currentPath);
    if (match) { view = handler; params = match.slice(1); break; }
  }
  const ctx = { main, params, query, path: currentPath, alive: () => token === renderToken, navigate, render, lockup };
  if (boot.offline) mount(main, html`<div class="container page"><h1>Schedora is temporarily unavailable</h1><div class="notice notice-bad" role="alert"><p>The service may be starting up or temporarily unavailable. Please try again. No booking has been submitted.</p></div><a class="btn" data-external href="${location.pathname + location.search}">Try again</a></div>`);
  else try {
    await view(ctx);
  } catch (error) {
    if (ctx.alive()) mount(main, html`<div class="container page"><h1>Something went wrong</h1><div class="notice notice-bad" role="alert"><p>${error.message}</p></div><a class="btn" href="${currentPath}">Try again</a></div>`);
  }
  if (!ctx.alive()) return;
  if (!firstRender) (main.querySelector('h1') ? main : main).focus({ preventScroll: true });
  if (!firstRender) window.scrollTo(0, 0);
  firstRender = false;
  countPage();
}

document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (link.target || link.hasAttribute('download') || link.dataset.external !== undefined) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
  if (document.body.dataset.dirty && !window.confirm('You have unsaved changes. Leave this page?')) { event.preventDefault(); return; }
  event.preventDefault();
  delete document.body.dataset.dirty;
  if (url.pathname === location.pathname && url.search === location.search) return render();
  navigate(url.pathname + url.search);
});
window.addEventListener('popstate', () => { currentPath = location.pathname; render(); });
window.addEventListener('beforeunload', event => { if (document.body.dataset.dirty) event.preventDefault(); });

// ---- Start ----
// Product subdomains (meet./forms./flow.) open their product at the root path, and product
// navigation uses absolute, allowlisted subdomain links when served from the product domain.
async function start() {
  const fallback = { productDomain: 'schedora.in', analytics: false, billingMode: 'open', operator: {}, providers: { email: 'outbox', calendar: 'ICS feed', billing: 'none' } };
  mount($('#main'), html`<div class="container page" role="status"><h1>Connecting to Schedora…</h1><p>The service may take a moment to start.</p></div>`);
  try { Object.assign(boot, fallback, await loadStartupConfig(() => api('GET', '/api/config')), { offline: false }); } catch { Object.assign(boot, fallback, { offline: true }); }
  const host = location.hostname;
  const subdomain = host.endsWith('.' + boot.productDomain) ? host.slice(0, -(boot.productDomain.length + 1)) : '';
  const productRoot = { meet: '/meet', book: '/meet', forms: '/forms', flow: '/flow' }[subdomain];
  if (location.pathname === '/' && productRoot) currentPath = productRoot;
  const onProductDomain = host === boot.productDomain || Boolean(subdomain);
  boot.links = onProductDomain
    ? { suite: `https://${boot.productDomain}/`, meet: `https://meet.${boot.productDomain}/`, forms: `https://forms.${boot.productDomain}/`, flow: `https://flow.${boot.productDomain}/` }
    : { suite: '/', meet: '/meet', forms: '/forms', flow: '/flow' };
  boot.landings = Object.fromEntries(['meet', 'forms', 'flow'].map(key => [key, `${onProductDomain ? `https://${boot.productDomain}` : ''}/products/${key}`]));
  if (location.pathname === '/book' || location.pathname === '/form') { history.replaceState(null, '', location.pathname === '/book' ? '/meet' : '/forms'); currentPath = location.pathname; }
}
await start();
// Installable app (PWA). Skipped where service workers are unavailable.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
renderFooter();
try { await loadMe(); } catch { /* signed-out experience still works */ }
if (!consent()) consentBanner(false);
await render();
export { api, workspace };
