import { $, $$, api, applyMe, ask, badge, boot, errorBlock, fmtDateTime, handleSubmit, html, loadMe, loading, mount, notice, raw, selectWorkspace, session, toast, workspace, wsPath } from './core.mjs';
import { setTitle } from './pages.mjs';
import * as settings from './settings.mjs';
import { PRODUCT_INFO } from './products.mjs';
import { safeReturnPath, hostInfo } from './context.mjs';
import { brand, icon, mark, productNames } from './design-system.mjs';
import { creditsSection } from './meet-video.mjs';

const safeNext = value => typeof value === 'string' && /^\/(?!\/)[^\s]*$/.test(value) ? value : '/meet';
const PRODUCT_NAMES = { meet: 'Meet', forms: 'Forms', flow: 'Flow' };

export async function account(ctx) {
  setTitle('Account · Schedora');
  if (!session.user) return signedOut(ctx);
  if (ctx.path === '/login' || ctx.path === '/signup') {
    const fallback = ctx.product === 'suite' ? '/enquiries' : PRODUCT_INFO[ctx.product].dashboard;
    const target = safeReturnPath(ctx.query.get('next'), fallback);
    return ctx.navigate(/^\/(login|signup)(?:[?#]|$)/.test(target) ? fallback : target, { replace: true });
  }
  const ws = workspace();
  const owner = ws?.role === 'owner';
  const admin = ['owner', 'admin'].includes(ws?.role);
  const google = await api('GET', '/api/auth/google/status').catch(() => ({ enabled: false }));
  if (!ctx.alive()) return;
  mount(ctx.main, html`<div class="container page"><span class="tag">${PRODUCT_INFO[ctx.product || 'suite'].name}</span><h1>Account & settings</h1>
    <p>You're signed in across Schedora apps. Signing out ends this session in every app.</p>

    <div class="grid-2">
      <section class="card card-plain"><h2>Profile</h2><p><strong>${session.user.name}</strong><br>${session.user.email}</p><button class="btn" id="sign-out">Sign out</button>${google.enabled ? html`<hr><h3>Google sign-in</h3>${google.connected ? html`<p>Google is connected. You can use it to sign in.</p>` : html`<p>Connect Google with the same email to sign in next time. Calendar access is separate.</p><button class="btn" id="link-google">Connect Google sign-in</button>`}` : ''}${ctx.query.get('error') ? notice('bad', html`<p>${ctx.query.get('error')}</p>`) : ''}</section>
      <section class="card card-plain"><h2>Workspace</h2>
        ${session.workspaces.length ? html`<label for="ws-select">Current workspace</label><select id="ws-select">${session.workspaces.map(item => html`<option value="${item.id}" ${item.id === session.workspaceId ? raw('selected') : ''}>${item.name} (${item.role})</option>`)}</select>` : html`<p>You are not in a workspace yet.</p>`}
        <form id="new-ws" novalidate><label for="new-ws-name">Create another workspace</label><div class="row"><input id="new-ws-name" name="name" required maxlength="100" placeholder="Team name"><button class="btn" type="submit">Create</button></div><div data-form-status tabindex="-1"></div></form>
      </section>
    </div>
    ${ws ? html`
      <section class="card card-plain"><h2>${ws.name} settings</h2>
        <form id="ws-settings" novalidate><fieldset ${admin ? '' : raw('disabled')}>
          <label for="ws-name">Workspace name</label><input id="ws-name" name="name" required maxlength="100" value="${ws.name}">
          <label for="retention">Keep form responses and appointment details for (days)</label><span class="hint">Older responses are deleted and past appointments are anonymized automatically. 30–3650 days.</span>
          <input id="retention" name="retention_days" type="number" min="30" max="3650" value="${ws.retention_days || 365}">
          <div data-form-status tabindex="-1"></div>${admin ? html`<div class="actions"><button class="btn btn-primary" type="submit">Save settings</button></div>` : html`<p class="hint">Only owners and administrators can change these settings.</p>`}
        </fieldset></form></section>
      <section class="card card-plain"><h2>Members</h2><div id="members">${loading()}</div>
        ${admin ? html`<form id="add-member" novalidate><h3 class="label">Add a member</h3><p class="hint">They need a Schedora account with this email first.</p>
          <div class="inline-fields"><div><label for="member-email">Email</label><input id="member-email" name="email" type="email" required></div>
          <div><label for="member-role">Role</label><select id="member-role" name="role"><option value="member">Member: own event types, forms, tasks</option>${owner ? html`<option value="admin">Administrator: everything except billing and deletion</option>` : ''}</select></div></div>
          <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn" type="submit">Add member</button></div></form>` : ''}
      </section>` : ''}
    ${ws ? html`<div id="settings-extra" class="section-gap"></div>` : ''}
    <section class="card card-plain section-gap"><h2>Danger zone</h2>
      ${owner ? html`<p>Deleting <strong>${ws.name}</strong> permanently removes its event types, appointments, forms, responses, flows and subscriptions records.</p><button class="btn btn-danger" id="delete-ws">Delete workspace</button><hr>` : ws ? html`<button class="btn btn-danger" id="leave-ws">Leave ${ws.name}</button><hr>` : ''}
      <p>Deleting your account also deletes every workspace where you are the only owner.</p><button class="btn btn-danger" id="delete-account">Delete my account</button>
    </section></div>`);

  $('#sign-out').onclick = async () => { await api('POST', '/api/auth/logout'); applyMe({ user: null, workspaces: [] }); ctx.navigate('/', { replace: true }); };
  if ($('#link-google')) $('#link-google').onclick = async () => {
    try { const result = await api('POST', '/api/auth/google/link', {}); location.assign(result.url); }
    catch (error) { toast(error.message); }
  };
  $('#ws-select')?.addEventListener('change', event => { selectWorkspace(event.target.value); ctx.render(); });
  handleSubmit($('#new-ws'), async data => {
    const result = await api('POST', '/api/workspaces', data);
    session.workspaces = result.workspaces;
    selectWorkspace(result.id);
    toast('Workspace created.');
    ctx.render();
  });
  if (!ws) return;
  if (admin) handleSubmit($('#ws-settings'), async data => { await api('PATCH', wsPath(''), data); await loadMe(); toast('Settings saved.'); ctx.render(); });
  if (admin) handleSubmit($('#add-member'), async data => { await api('POST', wsPath('/members'), data); toast('Member added.'); drawMembers(); $('#member-email').value = ''; });

  async function drawMembers() {
    try {
      const members = await api('GET', wsPath('/members'));
      if (!ctx.alive()) return;
      mount($('#members'), html`<ul class="list">${members.map(member => html`<li class="row-between"><div><div class="list-title">${member.name}${member.id === session.user.id ? ' (you)' : ''}</div><div class="meta"><span>${member.email}</span></div></div>
        <div class="row">${admin && member.id !== session.user.id && (owner || member.role === 'member') ? html`<label class="visually-hidden" for="role-${member.id}">Role for ${member.name}</label>
          <select id="role-${member.id}" data-role="${member.id}">${['member', 'admin', 'owner'].filter(role => owner || role === 'member').map(role => html`<option value="${role}" ${role === member.role ? raw('selected') : ''}>${role}</option>`)}</select>
          <button class="btn btn-small btn-danger" data-remove="${member.id}">Remove</button>` : badge('neutral', member.role)}</div></li>`)}</ul>`);
      $$('[data-role]').forEach(select => select.onchange = async () => {
        try { await api('PATCH', wsPath('/members/' + select.dataset.role), { role: select.value }); toast('Role updated.'); } catch (error) { toast(error.message); drawMembers(); }
      });
      $$('[data-remove]').forEach(button => button.onclick = async () => {
        if (!(await ask({ title: 'Remove this member?', body: 'They lose access to this workspace immediately.', confirm: 'Remove member', danger: true }))) return;
        try { await api('DELETE', wsPath('/members/' + button.dataset.remove)); drawMembers(); } catch (error) { toast(error.message); }
      });
    } catch (error) { mount($('#members'), errorBlock(error)); }
  }
  drawMembers();
  settings.render(ctx, $('#settings-extra'));

  $('#delete-ws')?.addEventListener('click', async () => {
    const result = await ask({ title: `Delete ${ws.name}?`, body: 'This cannot be undone.', fields: html`<label for="confirm-name">Type the workspace name to confirm</label><input id="confirm-name" name="confirm" required autocomplete="off">`, confirm: 'Delete workspace', danger: true });
    if (!result) return;
    try { await api('DELETE', wsPath(''), { confirm: result.confirm }); await loadMe(); toast('Workspace deleted.'); ctx.render(); } catch (error) { toast(error.message); }
  });
  $('#leave-ws')?.addEventListener('click', async () => {
    if (!(await ask({ title: `Leave ${ws.name}?`, confirm: 'Leave workspace', danger: true }))) return;
    try { await api('DELETE', wsPath('/members/' + session.user.id)); await loadMe(); ctx.render(); } catch (error) { toast(error.message); }
  });
  $('#delete-account').onclick = async () => {
    if (google.connected) {
      const result = await ask({ title: 'Delete your account?', body: 'This permanently deletes your account and every workspace where you are the only owner. You will confirm with the Google account linked to Schedora.', fields: html`<label>Type DELETE to confirm<input name="confirm" required autocomplete="off" pattern="DELETE"></label>`, confirm: 'Continue to Google', danger: true });
      if (!result) return;
      try { const response = await api('POST', '/api/auth/google/delete-account', { confirm: result.confirm }); location.assign(response.url); }
      catch (error) { toast(error.message); }
      return;
    }
    const result = await ask({ title: 'Delete your account?', body: 'This cannot be undone.', fields: html`<label for="confirm-password">Enter your password to confirm</label><input id="confirm-password" name="password" type="password" required autocomplete="current-password">`, confirm: 'Delete my account', danger: true });
    if (!result) return;
    try { await api('DELETE', '/api/me', { password: result.password }); applyMe({ user: null, workspaces: [] }); ctx.navigate('/', { replace: true }); toast('Your account was deleted.'); }
    catch (error) { toast(error.message); }
  };
}

function signedOut(ctx) {
  const signup = ctx.path === '/signup' || (ctx.path === '/account' && ctx.query.get('mode') === 'signup');
  const product = ctx.product || 'suite';
  const next = safeReturnPath(ctx.query.get('next'), signup ? (product === 'suite' ? '/setup' : '/setup/' + product) : (PRODUCT_INFO[product].dashboard === '/' ? '/enquiries' : PRODUCT_INFO[product].dashboard));
  const googleNext = hostInfo(location.hostname, boot.productDomain).production ? new URL(next, location.origin).href : next;
  const signInCard = html`<section class="auth-fields" aria-label="Sign in with email"><form id="signin" novalidate>
      <label for="si-email">Email</label><input id="si-email" name="email" type="email" required autocomplete="email">
      <label for="si-password">Password</label><input id="si-password" name="password" type="password" required autocomplete="current-password">
      <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn btn-primary" type="submit">Sign in</button></div></form></section>`;
  const signUpCard = html`<section class="auth-fields" aria-label="Create an account with email"><form id="signup" novalidate>
      <label for="su-name">Your name</label><input id="su-name" name="name" required maxlength="100" autocomplete="name">
      <label for="su-email">Email</label><input id="su-email" name="email" type="email" required autocomplete="email">
      <label for="su-password">Password</label><span class="hint" id="pw-hint">At least 10 characters.</span><input id="su-password" name="password" type="password" required minlength="10" autocomplete="new-password" aria-describedby="pw-hint">
      <label for="su-workspace">Workspace name</label><span class="hint">Usually your business or team. You can rename it later.</span><input id="su-workspace" name="workspace" maxlength="100">
      <p class="hint">By creating an account you agree to the <a href="/terms">terms</a> and acknowledge the <a href="/privacy">privacy policy</a>.</p>
      <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn btn-primary" type="submit">Create account</button></div></form></section>`;
  const error = ctx.query.get('error');
  setTitle(`${signup ? 'Create account' : 'Sign in'} · ${PRODUCT_INFO[product].name}`);
  const switchQuery = new URLSearchParams();
  if (product !== 'suite') switchQuery.set('product', product);
  // Carry an explicit destination only. Otherwise sign-up starts setup, sign-in opens work.
  if (ctx.query.has('next')) switchQuery.set('next', next);
  const alternate = (signup ? '/login' : '/signup') + (switchQuery.size ? '?' + switchQuery : '');
  const headlines = { suite: "Your workspace, ready for what's next.", meet: 'Make time for the right conversations.', forms: 'Collect the context that matters.', flow: 'Keep the next step moving.' };
  const benefits = [['meet', 'Share your availability. Let people choose a time.'], ['forms', 'Collect enquiries and review responses in one place.'], ['flow', 'Track follow-up emails and tasks from start to finish.']];
  mount(ctx.main, html`<div class="ds-signup auth-layout"><aside><a href="${product === 'suite' ? '/' : boot.landings[product]}">${brand(product)}</a><p class="ds-eyebrow">${product === 'suite' ? 'A LITTLE LESS BUSYWORK' : productNames[product].toUpperCase() + ' BY SCHEDORA'}</p><h1>${headlines[product]}</h1><p>${PRODUCT_INFO[product].job}</p><div>${benefits.filter(([key]) => product === 'suite' || key === product).map(([key, text]) => html`<div class="ds-signup-benefit">${mark(key)}<div><strong>${productNames[key]}</strong><small>${text}</small></div></div>`)}</div><small>${product === 'suite' ? 'MEET · FORMS · FLOW' : productNames[product].toUpperCase() + ' BY SCHEDORA'}</small></aside>
    <section><p class="ds-signin-link">${signup ? 'Already have an account?' : 'New here?'} <a href="${alternate}">${signup ? 'Sign in' : 'Create an account'} →</a></p>
      <div class="auth-content"><p class="ds-eyebrow">WELCOME ${signup ? 'TO' : 'BACK TO'} ${productNames[product].toUpperCase()}</p><h2>${signup ? 'Create your account.' : 'Welcome back.'}</h2><p>${signup ? (product === 'suite' ? 'Set up Meet, Forms and Flow in one workspace.' : 'Get started with ' + productNames[product] + '.') : 'Sign in to ' + productNames[product] + ' to continue.'}</p>
      ${error ? notice('bad', html`<p>${error}</p>`) : ''}
      ${boot.googleSignIn ? html`<div class="auth-google"><a class="btn google-signin-button" href="/api/auth/google/start?next=${encodeURIComponent(googleNext)}" data-external><img src="/assets/figma/GoogleSignIn.png" alt="" width="20" height="20">Continue with Google</a><p class="hint">Calendar access is requested separately.</p></div><p class="auth-divider">or continue with email</p>` : ''}
      ${signup ? signUpCard : signInCard}
      ${!signup ? html`<p class="hint auth-terms">By continuing, you agree to the <a href="/terms">terms</a> and acknowledge the <a href="/privacy">privacy policy</a>.</p>` : ''}
      <details class="auth-sso"><summary>Organization single sign-on</summary><form id="sso" novalidate><label for="sso-email">Work email</label><input id="sso-email" name="email" type="email" required autocomplete="email"><button class="btn" type="submit">Continue with SSO</button></form><p class="hint">For organizations that have set up single sign-on.</p></details>
      <nav class="auth-legal" aria-label="Legal"><a href="/privacy">Privacy</a><a href="/terms">Terms</a><button class="btn-link" type="button" id="auth-cookie-settings">Cookie settings</button></nav>
    </div></section></div>`);
  $('#auth-cookie-settings').onclick = () => $('#cookie-settings')?.click();
  $('#sso').onsubmit = async event => {
    event.preventDefault();
    const email = $('#sso-email').value.trim();
    const found = await api('GET', '/api/auth/sso/lookup?email=' + encodeURIComponent(email)).catch(() => ({ sso: false }));
    if (found.sso) location.href = '/api/auth/sso/start?email=' + encodeURIComponent(email);
    else toast('Single sign-on is not set up for that email domain. Sign in with your password.');
  };
  const done = data => { applyMe(data); ctx.navigate(next, { replace: true }); };
  if ($('#signin')) handleSubmit($('#signin'), async data => {
    try { done(await api('POST', '/api/auth/login', data)); }
    catch (failure) {
      if (failure.code === 'sso_required') { location.href = '/api/auth/sso/start?email=' + encodeURIComponent(data.email); return; }
      throw failure;
    }
  });
  if ($('#signup')) handleSubmit($('#signup'), async data => done(await api('POST', '/api/auth/signup', data)));
}

export async function billing(ctx) {
  setTitle('Plans and billing · Schedora');
  const catalog = await api('GET', '/api/billing/plans');
  const prices = (amount, currency = 'INR', exact = false) => new Intl.NumberFormat('en-IN', { style: 'currency', currency, minimumFractionDigits: exact ? 2 : 0, maximumFractionDigits: exact ? 2 : 0 }).format(amount / 100);
  const billingTermControl = html`<div class="plans-billing-control"><div class="plans-term-switch" role="group" aria-label="Billing frequency"><button type="button" data-billing-term="monthly" aria-pressed="true">Monthly</button><button type="button" data-billing-term="annual" aria-pressed="false">Annual</button></div><span class="plans-saving-note">Save 12% with annual billing</span></div>`;
  const details = {
    meet: { eyebrow: 'Scheduling', description: 'Make it easy for people to book time with you.', features: ['Booking pages and event types', 'Appointment and meeting management'] },
    forms: { eyebrow: 'Forms', description: 'Create forms and keep every response organized.', features: ['Form builder and JSON import', 'Conditional questions and logic', 'Response inbox and exports'] },
    flow: { eyebrow: 'Automation', description: 'Keep follow-ups and everyday work moving.', features: ['Automated follow-up workflows', 'Tasks and team handoffs', 'Connect your Schedora workspace'] },
    suite: { eyebrow: 'All-in-one', description: 'Bring scheduling, forms and follow-up together.', features: ['Everything in Meet, Forms and Flow', 'One shared Schedora workspace'] }
  };
  const planCard = (plan, action = '') => {
    const info = details[plan.id];
    return html`<article class="plans-card plans-card--${plan.id} ${plan.id === 'suite' ? 'plans-card--featured' : ''}">
      <div class="plans-card__top"><div class="plans-card__identity">${mark(plan.id, 'small')}<span class="plans-card__eyebrow">${info.eyebrow}</span></div></div>
      <h3>${plan.name}</h3><p class="plans-card__description">${info.description}</p>
      <div class="plans-card__price" data-monthly-price><strong>${prices(plan.price.amount_cents, plan.price.currency)}</strong><span> / month</span></div>
      <div class="plans-card__price" data-annual-price hidden><strong>${prices(plan.annual_price.monthly_equivalent_cents, plan.annual_price.currency, true)}</strong><span> / month</span></div>
      <p class="plans-card__unit" data-monthly-detail>Per workspace, billed monthly</p>
      <p class="plans-card__unit plans-card__annual-detail" data-annual-detail hidden>${prices(plan.annual_price.amount_cents, plan.annual_price.currency, true)} billed yearly <span>Save ${prices(plan.annual_price.savings_cents, plan.annual_price.currency, true)} / year</span></p>
      <ul class="plans-card__features">${[...info.features, ...(plan.included_video_credits ? [`${plan.included_video_credits} Meet credits each month`] : [])].map(feature => html`<li>${icon('Check')}<span>${feature}</span></li>`)}</ul>
      ${action}
    </article>`;
  };
  const bindBillingTerm = (root, { checkout = false } = {}) => {
    root.querySelectorAll('[data-billing-term]').forEach(button => button.addEventListener('click', () => {
      const term = button.dataset.billingTerm;
      root.querySelectorAll('[data-billing-term]').forEach(option => option.setAttribute('aria-pressed', String(option.dataset.billingTerm === term)));
      root.querySelectorAll('[data-monthly-price], [data-monthly-detail]').forEach(item => { item.hidden = term !== 'monthly'; });
      root.querySelectorAll('[data-annual-price], [data-annual-detail]').forEach(item => { item.hidden = term !== 'annual'; });
      const annualNote = root.querySelector('[data-annual-checkout-note]');
      if (annualNote) annualNote.hidden = term !== 'annual';
      if (checkout) root.querySelectorAll('[data-subscribe]').forEach(subscribe => {
        const monthlyAvailable = subscribe.dataset.monthlyAvailable === 'true';
        subscribe.disabled = term === 'annual' || !monthlyAvailable;
        subscribe.textContent = term === 'annual' ? 'Annual checkout unavailable' : monthlyAvailable ? 'Subscribe' : 'Not available yet';
      });
    }));
  };
  const publicCards = html`<div class="plans-grid">${catalog.map(plan => planCard(plan, html`<a class="btn btn-primary plans-card__action" href="/account?mode=signup&next=/billing">Create account</a>`))}</div>`;
  const comparison = html`<section class="plans-compare" aria-labelledby="plans-compare-title"><div class="plans-section-heading"><div><span class="plans-card__eyebrow">Plan comparison</span><h2 id="plans-compare-title">One workspace. The tools you need.</h2><p>See how each Schedora plan fits your work.</p></div><span class="plans-compare-caption">All plans are per workspace</span></div>
    <div class="table-wrap"><table class="plan-table"><caption class="visually-hidden">Features included in each Schedora plan</caption>
      <thead><tr><th scope="col">What’s included</th>${catalog.map(plan => html`<th scope="col"><span class="plans-compare-plan plans-compare-plan--${plan.id}">${plan.name}</span></th>`)}</tr></thead><tbody>
        ${[['Scheduling and booking pages', 'meet'], ['Forms and responses', 'forms'], ['Workflow automation', 'flow']].map(([label, product]) => html`<tr><th scope="row">${label}</th>${catalog.map(plan => html`<td>${plan.products.includes(product) ? html`<span class="plans-check" role="img" aria-label="Included">✓</span>` : html`<span class="plans-dash" aria-label="Not included">—</span>`}</td>`)}</tr>`)}
        <tr><th scope="row">Meet credits each month</th>${catalog.map(plan => html`<td>${plan.included_video_credits ? html`<span class="plans-credit-pill">${plan.included_video_credits} credits</span>` : html`<span class="plans-dash" aria-label="Not included">—</span>`}</td>`)}</tr>
      </tbody></table></div>
    <div class="plans-footnote"><strong>Meet credits</strong><span>Monthly included credits renew with your plan. Purchased credits carry forward without automatic expiry.</span></div></section>`;
  if (!session.user || !workspace()) {
    const product = ctx.product || 'suite'; const info = PRODUCT_INFO[product] || PRODUCT_INFO.suite;
    mount(ctx.main, html`<div id="plans-page" class="container page plans-page"><span class="tag">${product === 'suite' ? 'Schedora plans' : `${info.name} plans`}</span><div class="plans-hero"><div><h1>Find the plan that fits your work.</h1><p class="lead">Choose one Schedora product or bring all three together. Every price is per workspace.</p></div>${billingTermControl}</div>
      ${publicCards}${comparison}<p class="plans-evaluation" data-annual-checkout-note hidden>Annual prices are billed once per year. Annual checkout is not available yet.</p>${boot.billingMode === 'open' ? html`<p class="plans-evaluation">All products are available during evaluation. No payment is taken during evaluation.</p>` : ''}</div>`);
    bindBillingTerm($('#plans-page'));
    return;
  }
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let data;
  try { data = await api('GET', wsPath('/billing')); }
  catch (error) {
    if (error.status === 403) {
      mount(ctx.main, html`<div id="plans-page" class="container page plans-page billing-dashboard"><header class="billing-page__header"><div><span class="tag">Billing · ${workspace().name}</span><h1>Plans and billing</h1><p class="lead">Review your plan, workspace usage and payment history.</p></div></header>${notice('info', html`<p>Only workspace owners and administrators can see billing for ${workspace().name}.</p>`)}${billingTermControl}${publicCards}${comparison}<p class="plans-evaluation" data-annual-checkout-note hidden>Annual prices are billed once per year. Annual checkout is not available yet.</p></div>`);
      bindBillingTerm($('#plans-page'));
      return;
    }
    throw error;
  }
  if (!ctx.alive()) return;
  const owner = data.role === 'owner';
  const testMode = data.provider === 'test';
  mount(ctx.main, html`<div id="plans-page" class="container page plans-page billing-dashboard"><header class="plans-hero billing-page__header"><div><span class="tag">Billing · ${workspace().name}</span><h1>Plans and billing</h1><p class="lead">Manage your subscription, track usage and review Meet credits.</p></div>${data.provider === 'razorpay' ? billingTermControl : ''}</header>
    ${data.mode === 'open' && Object.values(data.entitlements).every(entitlement => entitlement.active && entitlement.source === 'evaluation')
      // Evaluation: one plain statement instead of three identical cards.
      ? notice('info', html`<p><strong>Evaluation mode.</strong> ${Object.keys(data.entitlements).map(product => PRODUCT_NAMES[product]).join(', ').replace(/, ([^,]*)$/, ' and $1')} are all available to this workspace, and nothing is charged. Usage is still measured so allowances can be tested.</p>`)
      : html`${data.mode === 'open' ? notice('info', html`<p><strong>Evaluation mode.</strong> Every product is available to this workspace and nothing is charged. Usage is still measured so allowances can be tested.</p>`) : ''}
    <section class="grid-3 billing-entitlements" aria-label="Product access">${Object.entries(data.entitlements).map(([product, entitlement]) => html`<div class="card card-plain"><h2>${PRODUCT_NAMES[product]}</h2>
      ${entitlement.active ? badge('active', entitlement.source === 'evaluation' ? 'Evaluation access' : `Active via ${entitlement.source}`) : badge('canceled', 'No access')}
      ${entitlement.status === 'past_due' ? html`<p class="muted">Payment failed. Access continues until ${fmtDateTime(entitlement.grace_until)} while payment is retried.</p>` : ''}</div>`)}</section>`}
    <section class="card card-plain billing-usage"><div class="billing-section-heading"><div><span class="account-panel__eyebrow">Workspace activity</span><h2>Usage this month</h2></div><span class="billing-reset-note">Resets monthly · UTC</span></div>${Object.entries(data.usage).map(([metric, usage]) => html`<div class="billing-usage__metric"><div class="row-between"><span>${metric.replace('_', ' ')}</span><strong>${usage.used}${usage.limit ? ` of ${usage.limit}` : ''}</strong></div>
      ${usage.limit ? html`<div class="meter" role="meter" aria-label="${metric.replace('_', ' ')} used" aria-valuemin="0" aria-valuemax="${usage.limit}" aria-valuenow="${usage.used}"><span data-width="${Math.min(100, Math.round(usage.used / usage.limit * 100))}"></span></div>` : ''}</div>`)}
      <p class="hint">Allowances reset on the first day of each month (UTC). Allowances shown are proposed fair-use limits.</p></section>
    ${['meet', 'suite'].includes(ctx.product || 'suite') && (workspace()?.video?.enabled ?? boot.video?.enabled) ? html`<div id="video-credits"></div>` : ''}
    <section class="card card-plain billing-subscriptions"><div class="billing-section-heading"><div><span class="account-panel__eyebrow">Workspace billing</span><h2>Your subscriptions</h2><p>Check what’s active and when each plan renews.</p></div></div>
      ${data.subscriptions.length ? html`<ul class="billing-subscription-list">${data.subscriptions.map(subscription => html`<li class="billing-subscription billing-subscription--${subscription.plan || 'suite'}">
        <div class="billing-subscription__plan">${mark(subscription.plan in PRODUCT_NAMES ? subscription.plan : 'suite', 'small')}<div><strong>${PRODUCT_NAMES[subscription.plan] || 'Suite'}</strong><span>Workspace plan</span></div></div>
        <div class="billing-subscription__renewal">${subscription.current_period_end ? html`${icon('CalendarDays')}<span><strong>${subscription.cancel_at_period_end ? 'Ends' : 'Renews'}</strong><small>${fmtDateTime(subscription.current_period_end)}</small></span>` : html`<span class="muted">Renewal date not available</span>`}${subscription.grace_until ? html`<small class="billing-subscription__grace">Payment retry until ${fmtDateTime(subscription.grace_until)}</small>` : ''}</div>
        <div class="billing-subscription__status">${badge(subscription.status, subscription.status.replace('_', ' '))}</div>
        ${owner && ((testMode && subscription.status !== 'canceled') || (subscription.provider === 'razorpay' && subscription.status !== 'canceled')) ? html`<details class="billing-subscription__actions"><summary class="btn btn-small" aria-label="Manage ${PRODUCT_NAMES[subscription.plan] || 'Suite'} subscription">Manage</summary><div class="billing-subscription__menu">
          ${owner && testMode && subscription.status !== 'canceled' ? html`<p>Test subscription actions</p><button class="btn btn-small" data-action="renew" data-sub="${subscription.id}">Simulate renewal</button><button class="btn btn-small" data-action="payment_failed" data-sub="${subscription.id}">Simulate failed payment</button>${subscription.cancel_at_period_end ? '' : html`<button class="btn btn-small" data-action="cancel" data-sub="${subscription.id}">Cancel at period end</button>`}<button class="btn btn-small btn-danger" data-action="end" data-sub="${subscription.id}">End now</button>` : ''}
          ${owner && subscription.provider === 'razorpay' ? html`<p>Payment provider</p><button class="btn btn-small" data-billing-refresh="${subscription.id}">Refresh payment status</button>${!subscription.cancel_at_period_end && subscription.status !== 'canceled' ? html`<button class="btn btn-small" data-billing-cancel="${subscription.id}">Cancel renewal</button>` : ''}` : ''}
        </div></details>` : ''}
      </li>`)}</ul>` : html`<div class="billing-subscriptions__empty">${icon('History')}<div><strong>No subscriptions yet</strong><p>Choose a plan below to get started.</p></div></div>`}
      ${!owner ? html`<p class="hint">Only the workspace owner can change subscriptions.</p>` : ''}
    </section>
    ${owner && (data.provider === 'razorpay' || testMode) ? html`<section class="card card-plain billing-plan-picker"><div class="billing-section-heading"><div><span class="account-panel__eyebrow">Plans</span><h2>Choose a plan</h2><p>${testMode ? 'Compare the options for this workspace.' : 'Review the price and billing terms before continuing to Razorpay.'}</p></div></div>
      ${testMode ? notice('warn', html`<div class="billing-test-notice">${icon('Info')}<p><strong>Test mode</strong><span>No payment provider is connected. Starting a test subscription moves no money; it sends a signed test event through the same verification path used by a real provider.</span></p></div>`) : ''}
      ${data.provider === 'razorpay' ? html`<div class="plans-grid">${data.plans.map(plan => planCard(plan, html`<div class="plans-card__checkout">${plan.price?.cycles ? html`<p class="hint">Up to ${plan.price.cycles} monthly payments.</p>` : ''}<button class="btn plans-card__action ${plan.checkout_available ? 'btn-primary' : ''}" data-subscribe="${plan.id}" data-monthly-available="${plan.checkout_available}" ${!plan.checkout_available ? raw('disabled') : ''}>${plan.checkout_available ? 'Subscribe' : 'Not available yet'}</button></div>`))}</div>
        <p class="plans-evaluation" data-annual-checkout-note hidden>Annual prices are billed once per year. Annual checkout is not available yet.</p>
        ${data.plans.some(plan => plan.checkout_available) ? '' : notice('info', html`<p>Subscription checkout is being configured. No payment can be taken yet.</p>`)}
        ${(data.checkouts || []).map(checkout => html`<p>${checkout.plan} checkout: ${checkout.status}. ${checkout.status === 'open' && checkout.checkout_url ? html`<a class="btn" href="${checkout.checkout_url}">Continue authorization at Razorpay</a><button class="btn" data-checkout-refresh="${checkout.id}">Refresh checkout status</button>` : 'Payment setup is pending review. Contact support before starting another checkout.'}</p>`)}` : ''}
      ${testMode ? html`<div class="billing-test-plans"><div class="plans-grid">${data.plans.map(plan => planCard(plan, html`<button class="btn plans-card__action" data-action="checkout" data-plan="${plan.id}">Start test subscription</button>`))}</div></div>` : ''}
    </section>` : !owner && !testMode && data.provider !== 'razorpay' ? html`<p class="hint">Online checkout opens once a payment provider is connected.</p>` : ''}
    ${comparison}</div>`);
  bindBillingTerm($('#plans-page'), { checkout: true });
  $$('[data-width]').forEach(bar => { bar.style.width = bar.dataset.width + '%'; });
  if ($('#video-credits')) creditsSection(ctx, $('#video-credits'));
  $$('[data-action]').forEach(button => button.onclick = async () => {
    try {
      const result = await api('POST', wsPath('/billing/test-events'), { action: button.dataset.action, plan: button.dataset.plan, subscription: button.dataset.sub });
      toast(`Test event ${result.result}.`);
      await loadMe();
      ctx.render();
    } catch (error) { toast(error.message); }
  });
  $$('[data-subscribe]').forEach(button => {
    const key = crypto.randomUUID();
    button.onclick = async () => {
      button.disabled = true;
      try { const result = await api('POST', wsPath('/billing/checkout'), { plan: button.dataset.subscribe }, { 'Idempotency-Key': key }); location.href = result.url; }
      catch (error) { toast(error.message); button.disabled = false; }
    };
  });
  $$('[data-billing-refresh]').forEach(button => button.onclick = async () => {
    try { await api('POST', wsPath(`/billing/subscriptions/${button.dataset.billingRefresh}/refresh`)); await loadMe(); ctx.render(); } catch (error) { toast(error.message); }
  });
  $$('[data-checkout-refresh]').forEach(button => button.onclick = async () => {
    try { await api('POST', wsPath(`/billing/checkouts/${button.dataset.checkoutRefresh}/refresh`)); await loadMe(); ctx.render(); } catch (error) { toast(error.message); }
  });
  $$('[data-billing-cancel]').forEach(button => button.onclick = async () => {
    if (!(await ask({ title: 'Cancel renewal?', body: 'Automatic renewal will stop. Your paid access continues until the current period ends.', confirm: 'Cancel renewal' }))) return;
    try { await api('POST', wsPath(`/billing/subscriptions/${button.dataset.billingCancel}/cancel`)); await loadMe(); ctx.render(); } catch (error) { toast(error.message); }
  });
}
