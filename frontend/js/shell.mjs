// Signed-in product shell: keep the workspace and every product visible in one navigation, matching
// the workspace demo while retaining each live product's own sections and routes.
import { $, $$, boot, html, isAdmin, mount, raw, selectWorkspace, session, workspace } from './core.mjs';
import { icon } from './design-system.mjs';
import { NAVIGATION, PRODUCT_INFO, sectionLabel } from './products.mjs';

const lockup = key => html`<span class="lockup"><img src="${PRODUCT_INFO[key].logo}" alt="" width="28" height="28"><span class="lockup-name">${PRODUCT_INFO[key].name}${key === 'suite' ? '' : html`<small>by Schedora</small>`}</span></span>`;
const SWITCH_TEXT = { suite: 'Workspace overview and enquiries', meet: 'Appointments and booking pages', forms: 'Forms and responses', flow: 'Follow-up emails and tasks' };
const appHref = (key, links) => key === 'suite'
  ? new URL('/overview', new URL(links.dashboard.suite, location.origin)).href
  : links.dashboard[key];

function item([key, label, href, iconName], current) {
  return html`<li><a class="side-link" href="${href}" ${key === current ? raw('aria-current="page"') : ''}>${icon(iconName)}<span>${label}</span></a></li>`;
}

/**
 * @param product 'suite' | 'meet' | 'forms' | 'flow'
 * @param current sidebar key of the current page
 * @param links { dashboard: { [product]: url } } absolute product addresses for this host
 */
const initials = name => String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map(word => [...word][0]).join('').toUpperCase() || '·';

export function renderShell({ product, current, links, onWorkspaceChange }) {
  const sidebar = $('#app-sidebar');
  const topbar = $('#app-topbar');
  const ws = workspace();
  // Setup is a Schedora-wide journey, even when opened from a product subdomain.
  const shellProduct = product;
  const groups = NAVIGATION[shellProduct];
  mount(sidebar, html`<div class="side-top">
      <a class="side-brand" href="${shellProduct === 'suite' ? appHref('suite', links) : links.dashboard[shellProduct]}" aria-label="${PRODUCT_INFO[shellProduct].name}${shellProduct === 'suite' ? '' : ' by Schedora'}, workspace">${lockup(shellProduct)}</a>
      <button class="btn btn-small side-close" type="button" id="side-close">Close<span class="visually-hidden"> navigation</span></button>
    </div>
    ${ws ? html`<div class="side-workspace"><span class="side-workspace-avatar" aria-hidden="true">${initials(ws.name)}</span><div class="side-workspace-text">${session.workspaces.length > 1
      ? html`<label for="side-workspace-select">Workspace</label><select id="side-workspace-select" title="${ws.name}">${session.workspaces.map(entry => html`<option value="${entry.id}" ${entry.id === session.workspaceId ? raw('selected') : ''}>${entry.name}</option>`)}</select>`
      : html`<span class="side-label" id="side-workspace-label">Workspace</span><strong class="side-workspace-name" id="side-workspace-name">${ws.name}</strong>`}</div></div>` : ''}
    <div class="side-apps" id="side-apps"><button class="side-apps-toggle" type="button" aria-expanded="false" aria-controls="side-apps-panel"><img src="${PRODUCT_INFO.suite.logo}" alt="" width="18" height="18"><span>Workspace &amp; products</span><span class="side-apps-chevron" aria-hidden="true"></span></button>
      <div class="side-apps-panel" id="side-apps-panel" hidden><ul>${['suite', 'meet', 'forms', 'flow'].map(key => html`<li><a class="side-app side-app--${key}" data-app="${key}" href="${appHref(key, links)}" ${key === shellProduct ? raw('aria-current="page"') : ''}>
        <img src="${PRODUCT_INFO[key].logo}" alt="" width="22" height="22"><span><strong>${key === 'suite' ? 'All products' : PRODUCT_INFO[key].name}${key === shellProduct ? html` <span class="side-app-current">Current</span>` : ''}</strong><small>${SWITCH_TEXT[key]}</small></span></a></li>`)}</ul></div></div>
    <nav class="side-nav" aria-label="${PRODUCT_INFO[shellProduct].name}">${groups.map(([title, items], index) => html`<h2 class="side-group" id="side-group-${index}">${title}</h2><ul aria-labelledby="side-group-${index}">${items.map(entry => item(entry, current))}</ul>`)}</nav>
    <div class="side-bottom"><details class="side-profile-menu"><summary class="side-person"><span class="side-person-avatar" aria-hidden="true">${initials(session.user.name || session.user.email)}</span><span><strong title="${session.user.name}">${session.user.name}</strong><small title="${session.user.email}">${session.user.email}</small></span><span class="side-profile-chevron" aria-hidden="true"></span></summary>
      <nav class="side-profile-links" aria-label="Account menu"><a href="${shellProduct === 'suite' ? '/setup' : `/setup/${shellProduct}`}" ${current === 'setup' ? raw('aria-current="page"') : ''}>${icon('GraduationCap')}<span>Help &amp; setup</span></a><a href="/account" ${current === 'account' ? raw('aria-current="page"') : ''}>${icon('Settings')}<span>Account &amp; settings</span></a>${isAdmin() ? html`<a href="/billing" ${current === 'billing' ? raw('aria-current="page"') : ''}>${icon('BriefcaseBusiness')}<span>Plans &amp; billing</span></a>` : ''}</nav>
    </details></div>`);
  mount(topbar, html`<button class="btn btn-small" type="button" id="side-open" aria-expanded="false" aria-controls="app-sidebar">Menu</button>
    <a class="side-brand" href="${shellProduct === 'suite' ? appHref('suite', links) : links.dashboard[shellProduct]}" aria-label="${PRODUCT_INFO[shellProduct].name}${shellProduct === 'suite' ? '' : ' by Schedora'}, workspace">${lockup(shellProduct)}</a>
    <span class="topbar-workspace">${ws?.name || 'Schedora workspace'}</span><span class="topbar-divider" aria-hidden="true">/</span><span class="topbar-section">${sectionLabel(shellProduct, current)}</span>`);
  bindDrawer();
  bindApps();
  bindWorkspaceName();
  $('#side-workspace-select')?.addEventListener('change', event => { selectWorkspace(event.target.value); onWorkspaceChange(); });
}

// Phones: the sidebar becomes a drawer. Opening moves focus into it and makes the page behind
// inert; Escape, Close, the backdrop or following a link close it and return focus to Menu.
function bindDrawer() {
  drawerCleanup?.();
  const sidebar = $('#app-sidebar');
  const toggle = $('#side-open');
  const media = window.matchMedia('(max-width:899px)');
  const behind = ['#main', '#site-footer', '#app-topbar'].map(selector => $(selector)).filter(Boolean);
  const close = (restore = true) => {
    if (!document.body.classList.contains('drawer-open')) return;
    document.body.classList.remove('drawer-open');
    toggle.setAttribute('aria-expanded', 'false');
    sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); sidebar.removeAttribute('aria-label');
    behind.forEach(element => { element.inert = false; });
    if (restore) toggle.focus();
  };
  toggle.onclick = () => {
    document.body.classList.add('drawer-open');
    toggle.setAttribute('aria-expanded', 'true');
    sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); sidebar.setAttribute('aria-label', 'Product navigation');
    behind.forEach(element => { element.inert = true; });
    bindWorkspaceName(); // measurable only once the drawer is shown
    $('#side-close').focus();
  };
  $('#side-close').onclick = () => close();
  sidebar.onkeydown = event => {
    if (event.key === 'Tab' && document.body.classList.contains('drawer-open')) {
      const stops = [...sidebar.querySelectorAll('a[href],button,select,summary')].filter(el => el.getClientRects().length && !el.disabled);
      const first = stops[0], last = stops.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    if (event.key === 'Escape' && document.body.classList.contains('drawer-open')) { event.preventDefault(); close(); } };
  $$('a[href]', sidebar).forEach(link => link.addEventListener('click', () => close(false)));
  $('#drawer-backdrop').onclick = () => close();
  const resized = () => { if (!media.matches) close(false); };
  media.addEventListener('change', resized);
  drawerCleanup = () => media.removeEventListener('change', resized);
}

function bindApps() {
  appsCleanup?.();
  appsCleanup = null;
  const root = $('#side-apps');
  if (!root) return;
  const toggle = $('.side-apps-toggle', root);
  const panel = $('#side-apps-panel', root);
  const sidebar = $('#app-sidebar');
  const placePanel = () => {
    if (panel.hidden) return;
    const trigger = toggle.getBoundingClientRect();
    const rail = sidebar.getBoundingClientRect();
    const edge = 12;
    const width = Math.max(180, Math.min(rail.width - 32, window.innerWidth - edge * 2));
    const left = Math.max(edge, Math.min(trigger.left, window.innerWidth - width - edge));
    const below = window.innerHeight - trigger.bottom - edge;
    const above = trigger.top - edge;
    const openBelow = below >= 230 || below >= above;
    const maxHeight = Math.max(120, Math.min(window.innerHeight - edge * 2, (openBelow ? below : above) - 8));
    panel.style.left = `${left}px`;
    panel.style.width = `${width}px`;
    panel.style.maxHeight = `${maxHeight}px`;
    panel.style.top = `${openBelow ? trigger.bottom + 6 : Math.max(edge, trigger.top - maxHeight - 6)}px`;
  };
  const setOpen = open => {
    toggle.setAttribute('aria-expanded', String(open));
    panel.hidden = !open;
    if (open) requestAnimationFrame(placePanel);
  };
  toggle.onclick = () => setOpen(panel.hidden);
  root.onkeydown = event => {
    if (event.key !== 'Escape' || panel.hidden) return;
    event.preventDefault(); event.stopPropagation(); setOpen(false); toggle.focus();
  };
  const outside = event => {
    if (!root.isConnected) return document.removeEventListener('pointerdown', outside);
    if (!panel.hidden && !root.contains(event.target)) setOpen(false);
  };
  document.addEventListener('pointerdown', outside);
  window.addEventListener('resize', placePanel);
  sidebar.addEventListener('scroll', placePanel, { passive: true });
  appsCleanup = () => { window.removeEventListener('resize', placePanel); sidebar.removeEventListener('scroll', placePanel); document.removeEventListener('pointerdown', outside); };
}

// A long workspace name is shortened to two lines. When it is cut off, the name becomes a button that
// shows it in full, so keyboard and touch users can read it without a hover tooltip.
function bindWorkspaceName() {
  const name = $('#side-workspace-name');
  if (!name || name.tagName === 'BUTTON' || name.scrollHeight <= name.clientHeight + 1) return;
  const full = name.textContent;
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'side-workspace-name side-workspace-toggle';
  button.id = 'side-workspace-name';
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-describedby', 'side-workspace-label');
  button.textContent = full;
  button.title = full;
  button.onclick = () => { const open = button.getAttribute('aria-expanded') !== 'true'; button.setAttribute('aria-expanded', String(open)); button.classList.toggle('is-expanded', open); };
  name.replaceWith(button);
}

let drawerCleanup;
let appsCleanup;
export function clearShell() {
  drawerCleanup?.(); drawerCleanup = null;
  appsCleanup?.(); appsCleanup = null;
  document.body.classList.remove('drawer-open');
  for (const selector of ['#main', '#site-footer', '#app-topbar']) { const element = $(selector); if (element) element.inert = false; }
  mount($('#app-sidebar'), '');
  mount($('#app-topbar'), '');
}

export { lockup as productLockup };
