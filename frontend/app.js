import { $, api, boot, html, loadMe, mount, raw, selectWorkspace, session, storage, workspace } from './js/core.mjs';
import * as pages from './js/pages.mjs';
import * as meet from './js/meet.mjs';
import * as team from './js/meet-team.mjs';
import * as forms from './js/forms.mjs';
import * as flow from './js/flow.mjs';
import * as account from './js/account.mjs';
import * as video from './js/meet-video.mjs';
import { loadStartupConfig } from './js/connection.mjs';
import { productLanding } from './js/product-landing.mjs';
import { pricingProposal } from './js/pricing-proposal-page.mjs';
import { enquiries } from './js/enquiries.mjs';
import { ecosystemHome } from './js/ecosystem.mjs';
const previewView = name => async ctx => (await import('./js/studio.mjs'))[name](ctx);

import { canonicalRedirect, contextFor, hostInfo, isAppRoute, productUrl, landingUrl, safeReturnPath } from './js/context.mjs';
import { PRODUCT_INFO, currentSection } from './js/products.mjs';
import { renderShell, clearShell } from './js/shell.mjs';

const UUID = '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})';
const routes = [
  [/^\/$/, ecosystemHome],
  [/^\/demo(?:\/.*)?$/, previewView('studio')],
  [/^\/start(?:\/.*)?$/, previewView('onboarding')],
  [/^\/products\/(meet|forms|flow)$/, productLanding],
  [/^\/meet$/, meet.dashboard],
  [new RegExp(`^/meet/event-types/(new|${UUID.slice(1, -1)})$`), meet.editor],
  [/^\/meet\/manage\/([A-Za-z0-9_-]{20,100})$/, meet.manage],
  [/^\/meet\/pay\/([A-Za-z0-9_-]{20,100})$/, meet.pay],
  [/^\/meet\/room\/([A-Za-z0-9_-]{20,30})$/, video.hostRoom],
  [/^\/meet\/join\/([A-Za-z0-9_-]{40,60})$/, video.guestRoom],
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
  [/^\/pricing\/proposal$/, pricingProposal],
  [/^\/enquiries$/, enquiries],
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
document.documentElement.dataset.theme = 'light';

// ---- Layout ----
let firstRender = true;
let currentPath = location.pathname;

function renderHeader(product) {
  const individual = product !== 'suite';
  const authPage = currentPath === '/account';
  const home = individual ? boot.landings[product] : boot.links.suite;
  const next = PRODUCT_INFO[product].dashboard;
  const auth = mode => `/account?${mode ? 'mode=signup&' : ''}product=${product}&next=${encodeURIComponent(next)}`;
  mount($('#site-header'), html`<div class="container header-inner"><a class="lockup" href="${home}">${lockup(product)}</a>
    ${authPage ? '' : html`<nav class="site-nav" aria-label="${individual ? PRODUCT_INFO[product].name : 'Suite'} information">${individual ? html`<a href="${home}#features">Features</a><a href="${home}#how-it-works">How it works</a><a href="/demo/${product}">Try the demo</a>` : html`<a href="/#ecosystem">Products</a><a href="/#why-schedora">Why Schedora</a>`}<a href="/billing${individual ? '?product=' + product : ''}">Plans</a></nav>`}
    <div class="header-tools">${authPage ? html`<a href="${home}">Back to ${PRODUCT_INFO[product].name}</a>` : session.user ? html`<a class="btn btn-small" href="${individual ? boot.links[product] : '/enquiries'}">Go to workspace</a>` : html`<a class="btn btn-small" href="${auth(false)}">Sign in</a><a class="btn btn-small btn-primary" href="${auth(true)}">Get started</a>`}</div></div>`);
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
  if (!hostInfo(location.hostname, boot.productDomain).product && boot.context && boot.context !== 'suite' && /^\/(account|start|demo)(?:[/?#]|$)/.test(path) && !/^\/demo\/(meet|forms|flow)/.test(path)) {
    const target = new URL(path, location.origin); if (!target.searchParams.has('product')) target.searchParams.set('product', boot.context); path = target.pathname + target.search + target.hash;
  }
  if (replace) history.replaceState(null, '', path); else history.pushState(null, '', path);
  currentPath = location.pathname;
  render();
}

export async function render() {
  const token = ++renderToken;
  document.head.querySelectorAll('[data-page-meta]').forEach(element => element.remove()); // per-page tags such as noindex
  video.leaveMeeting(); // releases camera, microphone and the connection before any other view renders
  const main = $('#main');
  const query = new URLSearchParams(location.search);
  const redirect = canonicalRedirect(location, boot.productDomain);
  if (redirect) { location.replace(redirect); return; }
  let product = contextFor(location.hostname, currentPath, boot.productDomain);
  const entry = query.get('product');
  if (product === 'suite' && ['meet', 'forms', 'flow'].includes(entry)) product = entry;
  if (product === 'suite' && currentPath === '/account') product = productFor(safeReturnPath(query.get('next'), '/'));
  boot.context = product;
  if (currentPath === '/' && product !== 'suite' && session.user) return navigate(PRODUCT_INFO[product].dashboard, { replace: true });
  clearShell();
  const shell = Boolean(session.user && isAppRoute(currentPath));
  document.body.classList.toggle('app-shell', shell);
  if (shell) renderShell({ product, current: currentSection(product, currentPath, query), links: { dashboard: boot.links, home: { suite: boot.links.suite, ...boot.landings } }, onWorkspaceChange: render });
  document.body.dataset.design = currentPath.startsWith('/demo') ? 'workspace' : currentPath.startsWith('/start') ? 'onboarding' : currentPath === '/' && product === 'suite' ? 'marketing' : '';
  document.body.dataset.product = product === 'suite' ? 'meet' : product;
  delete document.body.dataset.embed;
  if (query.get('embed') === '1' && currentPath.startsWith('/f/')) document.body.dataset.embed = '1';
  if (!shell) renderHeader(product);
  let view = pages.notFound;
  let params = [];
  for (const [pattern, handler] of routes) {
    const match = pattern.exec(currentPath);
    if (match) { view = handler; params = match.slice(1); break; }
  }
  if (currentPath === '/' && product !== 'suite') { view = productLanding; params = [product]; }
  const ctx = { main, params, query, product, entryProduct: hostInfo(location.hostname, boot.productDomain).product || (['meet', 'forms', 'flow'].includes(entry) ? entry : 'suite'), path: currentPath, alive: () => token === renderToken, navigate, render, lockup };
  if (boot.offline && !['workspace', 'onboarding', 'marketing'].includes(document.body.dataset.design) && !currentPath.startsWith('/products/')) mount(main, html`<div class="container page"><h1>We can't reach ${product === 'suite' ? 'Schedora' : PRODUCTS[product].name} right now</h1><div class="notice notice-bad" role="alert"><p>The service did not respond. It may be starting up, or there may be a connection problem. Nothing has been submitted from this page. Please try again in a moment.</p></div><a class="btn" data-external href="${location.pathname + location.search}">Try again</a></div>`);
  else try {
    await view(ctx);
  } catch (error) {
    if (ctx.alive()) mount(main, html`<div class="container page"><h1>Something went wrong</h1><div class="notice notice-bad" role="alert"><p>${error.message}</p></div><a class="btn" href="${currentPath}">Try again</a></div>`);
  }
  if (!ctx.alive()) return;
  if (!firstRender) (main.querySelector('h1') ? main : main).focus({ preventScroll: true });
  if (!firstRender) window.scrollTo(0, 0);
  if (location.hash) { try { document.getElementById(decodeURIComponent(location.hash.slice(1)))?.scrollIntoView(); } catch { /* Ignore malformed hash links. */ } }
  firstRender = false;
  countPage();
}

document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (link.target || link.hasAttribute('download') || link.dataset.external !== undefined) return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Meeting pages carry their own camera/microphone and CSP headers, so entering or leaving one is a full page load.
  if (document.body.dataset.meetingPage || /^\/meet\/(room|join)\//.test(url.pathname)) return;
  if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
  if (document.body.dataset.dirty && !window.confirm('You have unsaved changes. Leave this page?')) { event.preventDefault(); return; }
  event.preventDefault();
  link.closest('dialog')?.close('cancel');
  delete document.body.dataset.dirty;
  if (url.pathname === location.pathname && url.search === location.search) return render();
  navigate(url.pathname + url.search + url.hash);
});
window.addEventListener('popstate', () => { currentPath = location.pathname; render(); });
window.addEventListener('beforeunload', event => { if (document.body.dataset.dirty) event.preventDefault(); });

// ---- Start ----
// Product subdomains (meet./forms./flow.) open their product at the root path, and product
// navigation uses absolute, allowlisted subdomain links when served from the product domain.
async function start() {
  const fallback = { productDomain: 'schedora.in', analytics: false, billingMode: 'open', operator: {}, providers: { email: 'outbox', calendar: 'ICS feed', billing: 'none' } };
  mount($('#main'), html`<div class="container page" role="status"><h1>Connecting to Schedora…</h1><p>The service may take a moment to start.</p></div>`);
  if (/^\/(demo|start)(\/|$)/.test(location.pathname)) Object.assign(boot, fallback, { offline: false });
  else try { Object.assign(boot, fallback, await loadStartupConfig(() => api('GET', '/api/config')), { offline: false }); } catch { Object.assign(boot, fallback, { offline: true }); }
  boot.links = Object.fromEntries(Object.keys(PRODUCT_INFO).map(key => [key, productUrl(key, PRODUCT_INFO[key].dashboard, location, boot.productDomain)]));
  boot.landings = Object.fromEntries(['meet', 'forms', 'flow'].map(key => [key, landingUrl(key, location, boot.productDomain)]));
  if (location.pathname === '/book' || location.pathname === '/form') { history.replaceState(null, '', location.pathname === '/book' ? '/meet' : '/forms'); currentPath = location.pathname; }
}
await start();
// Installable app (PWA). Skipped where service workers are unavailable.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('/sw.js').catch(() => {});
renderFooter();
if (!/^\/(demo|start)(\/|$)/.test(location.pathname)) try { await loadMe(); } catch { /* signed-out experience still works */ }
if (!consent()) consentBanner(false);
await render();
export { api, workspace };
