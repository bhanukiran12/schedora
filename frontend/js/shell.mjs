// Signed-in product shell: a labelled left sidebar on wide screens and the same navigation in a
// drawer on phones. One lower area holds the workspace, account, billing and the only product
// switcher, so the current product is never offered again as "Open <product>".
import { $, $$, boot, html, isAdmin, mount, raw, selectWorkspace, session, workspace } from './core.mjs';
import { icon } from './design-system.mjs';
import { NAVIGATION, PRODUCT_INFO, sectionLabel } from './products.mjs';

const lockup = key => html`<span class="lockup"><img src="${PRODUCT_INFO[key].logo}" alt="" width="28" height="28"><span class="lockup-name">${PRODUCT_INFO[key].name}${key === 'suite' ? '' : html`<small>by Schedora</small>`}</span></span>`;
const SWITCH_TEXT = { suite: 'All products and enquiries', meet: 'Appointments and booking pages', forms: 'Forms and responses', flow: 'Follow-up emails and tasks' };

function item([key, label, href, iconName], current) {
  return html`<li><a class="side-link" href="${href}" ${key === current ? raw('aria-current="page"') : ''}>${icon(iconName)}<span>${label}</span></a></li>`;
}

/**
 * @param product 'suite' | 'meet' | 'forms' | 'flow'
 * @param current sidebar key of the current page
 * @param links { dashboard: { [product]: url } } absolute product addresses for this host
 */
export function renderShell({ product, current, links, onWorkspaceChange }) {
  const sidebar = $('#app-sidebar');
  const topbar = $('#app-topbar');
  const ws = workspace();
  const groups = product === 'suite'
    ? [['Products', ['meet', 'forms', 'flow'].map(key => [key, PRODUCT_INFO[key].name, links.dashboard[key], key === 'meet' ? 'CalendarDays' : key === 'forms' ? 'Files' : 'Workflow'])], ...NAVIGATION.suite]
    : NAVIGATION[product];
  const others = ['suite', 'meet', 'forms', 'flow'].filter(key => key !== product);
  mount(sidebar, html`<div class="side-top">
      <a class="side-brand" href="${PRODUCT_INFO[product].dashboard}" aria-label="${PRODUCT_INFO[product].name}${product === 'suite' ? '' : ' by Schedora'}, home">${lockup(product)}</a>
      <button class="btn btn-small side-close" type="button" id="side-close">Close<span class="visually-hidden"> navigation</span></button>
    </div>
    ${ws ? html`<div class="side-workspace">${session.workspaces.length > 1
      ? html`<label for="side-workspace-select">Workspace</label><select id="side-workspace-select">${session.workspaces.map(entry => html`<option value="${entry.id}" ${entry.id === session.workspaceId ? raw('selected') : ''}>${entry.name}</option>`)}</select>`
      : html`<span class="side-label">Workspace</span><strong>${ws.name}</strong>`}</div>` : ''}
    <nav class="side-nav" aria-label="${PRODUCT_INFO[product].name}">${groups.map(([title, items], index) => html`<h2 class="side-group" id="side-group-${index}">${title}</h2><ul aria-labelledby="side-group-${index}">${items.map(entry => item(entry, current))}</ul>`)}</nav>
    <div class="side-bottom">
      <nav aria-label="Account"><ul>
        ${item(['account', 'Account & settings', '/account', 'Settings'], current)}
        ${isAdmin() ? item(['billing', 'Plans & billing', '/billing', 'BriefcaseBusiness'], current) : ''}
      </ul></nav>
      <details class="side-switch"><summary>Other Schedora products</summary>
        <ul>${others.map(key => html`<li><a href="${links.home[key]}">${lockup(key)}<small>${SWITCH_TEXT[key]}</small></a></li>`)}</ul>
        <p class="hint">Same account and workspace. Access depends on your workspace plan.</p></details>
      <p class="side-person">${icon('CircleUserRound')}<span><strong>${session.user.name}</strong><small>${session.user.email}</small></span></p>
    </div>`);
  mount(topbar, html`<button class="btn btn-small" type="button" id="side-open" aria-expanded="false" aria-controls="app-sidebar">Menu</button>
    <a class="side-brand" href="${PRODUCT_INFO[product].dashboard}">${lockup(product)}</a><span class="topbar-section" aria-hidden="true">${sectionLabel(product, current)}</span>`);
  bindDrawer();
  $('#side-workspace-select')?.addEventListener('change', event => { selectWorkspace(event.target.value); onWorkspaceChange(); });
}

// Phones: the sidebar becomes a drawer. Opening moves focus into it and makes the page behind
// inert; Escape, Close, the backdrop or following a link close it and return focus to Menu.
function bindDrawer() {
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

let drawerCleanup;
export function clearShell() {
  drawerCleanup?.(); drawerCleanup = null;
  document.body.classList.remove('drawer-open');
  for (const selector of ['#main', '#site-footer', '#app-topbar']) { const element = $(selector); if (element) element.inert = false; }
  mount($('#app-sidebar'), '');
  mount($('#app-topbar'), '');
}

export { lockup as productLockup };
