import { $, $$, api, applyMe, ask, badge, boot, errorBlock, fmtDateTime, handleSubmit, html, loadMe, loading, mount, notice, raw, selectWorkspace, session, toast, workspace, wsPath } from './core.mjs';
import { setTitle } from './pages.mjs';
import * as settings from './settings.mjs';

const safeNext = value => typeof value === 'string' && /^\/(?!\/)[^\s]*$/.test(value) ? value : '/meet';
const PRODUCT_NAMES = { meet: 'Meet', forms: 'Forms', flow: 'Flow' };

export async function account(ctx) {
  setTitle('Account · Schedora');
  if (!session.user) return signedOut(ctx);
  const ws = workspace();
  const owner = ws?.role === 'owner';
  const admin = ['owner', 'admin'].includes(ws?.role);
  const google = await api('GET', '/api/auth/google/status').catch(() => ({ enabled: false }));
  if (!ctx.alive()) return;
  mount(ctx.main, html`<div class="container page"><span class="tag">Schedora account</span><h1>Account</h1>
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
  const signup = ctx.query.get('mode') === 'signup';
  const next = safeNext(ctx.query.get('next'));
  const signInCard = html`<section class="card card-plain"><h2>Sign in</h2><form id="signin" novalidate>
      <label for="si-email">Email</label><input id="si-email" name="email" type="email" required autocomplete="email">
      <label for="si-password">Password</label><input id="si-password" name="password" type="password" required autocomplete="current-password">
      <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn btn-primary" type="submit">Sign in</button></div></form></section>`;
  const signUpCard = html`<section class="card card-plain"><h2>Create an account</h2><form id="signup" novalidate>
      <label for="su-name">Your name</label><input id="su-name" name="name" required maxlength="100" autocomplete="name">
      <label for="su-email">Email</label><input id="su-email" name="email" type="email" required autocomplete="email">
      <label for="su-password">Password</label><span class="hint" id="pw-hint">At least 10 characters.</span><input id="su-password" name="password" type="password" required minlength="10" autocomplete="new-password" aria-describedby="pw-hint">
      <label for="su-workspace">Workspace name</label><span class="hint">Usually your business or team. You can rename it later.</span><input id="su-workspace" name="workspace" maxlength="100">
      <p class="hint">By creating an account you agree to the <a href="/terms">terms</a> and acknowledge the <a href="/privacy">privacy policy</a>.</p>
      <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn btn-primary" type="submit">Create account</button></div></form></section>`;
  const error = ctx.query.get('error');
  mount(ctx.main, html`<div class="container page"><span class="tag">One account for Meet, Forms and Flow</span><h1>${signup ? 'Create your Schedora account' : 'Sign in to Schedora'}</h1>
    ${error ? notice('bad', html`<p>${error}</p>`) : ''}
    ${boot.googleSignIn ? html`<section class="google-signin-panel"><a class="btn google-signin-button" href="/api/auth/google/start?next=${encodeURIComponent(next)}" data-external>Continue with Google</a><p>One Google account for Meet, Forms and Flow. Calendar access is requested separately.</p>${signup ? html`<p>By continuing, you agree to the <a href="/terms">terms</a> and acknowledge the <a href="/privacy">privacy policy</a>.</p>` : ''}</section>` : ''}
    <div class="grid-2">${signup ? html`${signUpCard}${signInCard}` : html`${signInCard}${signUpCard}`}</div>
    <section class="card card-plain section-gap"><h2>Single sign-on</h2><form id="sso" class="row" novalidate><label for="sso-email" class="visually-hidden">Work email</label><input id="sso-email" name="email" type="email" required placeholder="Work email" autocomplete="email"><button class="btn" type="submit">Continue with SSO</button></form>
      <p class="hint">For organizations that have set up single sign-on.</p></section></div>`);
  $('#sso').onsubmit = async event => {
    event.preventDefault();
    const email = $('#sso-email').value.trim();
    const found = await api('GET', '/api/auth/sso/lookup?email=' + encodeURIComponent(email)).catch(() => ({ sso: false }));
    if (found.sso) location.href = '/api/auth/sso/start?email=' + encodeURIComponent(email);
    else toast('Single sign-on is not set up for that email domain. Sign in with your password.');
  };
  const done = data => { applyMe(data); ctx.navigate(next, { replace: true }); };
  handleSubmit($('#signin'), async data => {
    try { done(await api('POST', '/api/auth/login', data)); }
    catch (failure) {
      if (failure.code === 'sso_required') { location.href = '/api/auth/sso/start?email=' + encodeURIComponent(data.email); return; }
      throw failure;
    }
  });
  handleSubmit($('#signup'), async data => done(await api('POST', '/api/auth/signup', data)));
}

export async function billing(ctx) {
  setTitle('Plans and billing · Schedora');
  const catalog = await api('GET', '/api/billing/plans');
  const priceText = price => price ? `${new Intl.NumberFormat('en-IN', { style: 'currency', currency: price.currency }).format(price.amount_cents / 100)} / month` : 'Not yet published';
  const comparison = html`<div class="table-wrap"><table><caption class="visually-hidden">Product access by plan</caption>
    <thead><tr><th scope="col">Plan</th><th scope="col">Meet</th><th scope="col">Forms</th><th scope="col">Flow</th><th scope="col">Price</th></tr></thead><tbody>
    ${catalog.map(plan => html`<tr><th scope="row">${plan.name}</th>${['meet','forms','flow'].map(product => html`<td>${plan.products.includes(product) ? '✓ Included' : '—'}</td>`)}<td>${priceText(plan.price)}</td></tr>`)}
    </tbody></table></div>
    <p class="muted">Prices will be shown once they are approved. Our goal is a lower price than comparable paid plans elsewhere, measured against the same features and usage, without cutting reliability or privacy.</p>`;
  if (!session.user || !workspace()) {
    return mount(ctx.main, html`<div class="container page"><span class="tag">Plans</span><h1>One account. Your choice of tools.</h1><p class="lead">Subscribe to one product or to the Suite for all three. One workspace, one bill.</p>${comparison}
      <div class="actions"><a class="btn btn-primary" href="/account?mode=signup&next=/billing">Create an account</a></div></div>`);
  }
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let data;
  try { data = await api('GET', wsPath('/billing')); }
  catch (error) {
    if (error.status === 403) return mount(ctx.main, html`<div class="container page"><h1>Plans and billing</h1>${notice('info', html`<p>Only workspace owners and administrators can see billing for ${workspace().name}.</p>`)}${comparison}</div>`);
    throw error;
  }
  if (!ctx.alive()) return;
  const owner = data.role === 'owner';
  const testMode = data.provider === 'test';
  mount(ctx.main, html`<div class="container page"><span class="tag">Plans · ${workspace().name}</span><h1>Plans and billing</h1>
    ${data.mode === 'open' ? notice('info', html`<p><strong>Evaluation mode.</strong> Every product is available to this workspace and nothing is charged. Usage is still measured so allowances can be tested.</p>`) : ''}
    <section class="grid-3">${Object.entries(data.entitlements).map(([product, entitlement]) => html`<div class="card card-plain"><h2>${PRODUCT_NAMES[product]}</h2>
      ${entitlement.active ? badge('active', entitlement.source === 'evaluation' ? 'Evaluation access' : `Active via ${entitlement.source}`) : badge('canceled', 'No access')}
      ${entitlement.status === 'past_due' ? html`<p class="muted">Payment failed. Access continues until ${fmtDateTime(entitlement.grace_until)} while payment is retried.</p>` : ''}</div>`)}</section>
    <section class="card card-plain"><h2>Usage this month</h2>${Object.entries(data.usage).map(([metric, usage]) => html`<div><div class="row-between"><span>${metric.replace('_', ' ')}</span><span>${usage.used}${usage.limit ? ` of ${usage.limit}` : ''}</span></div>
      ${usage.limit ? html`<div class="meter" role="meter" aria-label="${metric.replace('_', ' ')} used" aria-valuemin="0" aria-valuemax="${usage.limit}" aria-valuenow="${usage.used}"><span data-width="${Math.min(100, Math.round(usage.used / usage.limit * 100))}"></span></div>` : ''}</div>`)}
      <p class="hint">Allowances reset on the first day of each month (UTC). Allowances shown are proposed fair-use limits.</p></section>
    <section class="card card-plain"><h2>Subscriptions</h2>
      ${data.subscriptions.length ? html`<ul class="list">${data.subscriptions.map(subscription => html`<li class="row-between"><div><div class="list-title">${PRODUCT_NAMES[subscription.plan] || 'Suite'} plan</div>
        <div class="meta">${subscription.current_period_end ? html`<span>${subscription.cancel_at_period_end ? 'Ends' : 'Renews'} ${fmtDateTime(subscription.current_period_end)}</span>` : ''}${subscription.grace_until ? html`<span>Grace until ${fmtDateTime(subscription.grace_until)}</span>` : ''}</div></div>
        <div class="row">${badge(subscription.status, subscription.status.replace('_', ' '))}${owner && testMode && subscription.status !== 'canceled' ? html`
          <button class="btn btn-small" data-action="renew" data-sub="${subscription.id}">Simulate renewal</button>
          <button class="btn btn-small" data-action="payment_failed" data-sub="${subscription.id}">Simulate failed payment</button>
          ${subscription.cancel_at_period_end ? '' : html`<button class="btn btn-small" data-action="cancel" data-sub="${subscription.id}">Cancel at period end</button>`}
          <button class="btn btn-small btn-danger" data-action="end" data-sub="${subscription.id}">End now</button>` : ''}
          ${owner && subscription.provider === 'razorpay' ? html`<button class="btn btn-small" data-billing-refresh="${subscription.id}">Refresh payment status</button>${!subscription.cancel_at_period_end && subscription.status !== 'canceled' ? html`<button class="btn btn-small" data-billing-cancel="${subscription.id}">Cancel renewal</button>` : ''}` : ''}</div></li>`)}</ul>` : html`<p class="muted">No subscriptions.</p>`}
      ${owner && data.provider === 'razorpay' ? html`<h3>Subscribe with Razorpay</h3><p>Review the recurring amount and billing schedule before authorizing payment at Razorpay.</p>
        <div class="grid-2">${data.plans.map(plan => html`<div class="card"><h3>${plan.name}</h3><p>${priceText(plan.price)}</p>${plan.price ? html`<p class="hint">Up to ${plan.price.cycles} monthly payments. Cancel renewal before your next billing date.</p>` : ''}<button class="btn" data-subscribe="${plan.id}" ${!plan.checkout_available ? raw('disabled') : ''}>Subscribe to ${plan.name}</button></div>`)}</div>
        ${data.plans.some(plan => plan.checkout_available) ? '' : notice('info', html`<p>Subscription checkout is being configured. No payment can be taken yet.</p>`)}
        ${(data.checkouts || []).map(checkout => html`<p>${checkout.plan} checkout: ${checkout.status}. ${checkout.status === 'open' && checkout.checkout_url ? html`<a class="btn" href="${checkout.checkout_url}">Continue authorization at Razorpay</a><button class="btn" data-checkout-refresh="${checkout.id}">Refresh checkout status</button>` : 'Payment setup is pending review. Contact support before starting another checkout.'}</p>`)}` : ''}
      ${owner && testMode ? html`<h3 class="label">Start a subscription (test provider)</h3>${notice('warn', html`<p>No payment provider is connected. These buttons send signed test events through the same verified webhook path a real provider will use. No money moves.</p>`)}
        <div class="row">${data.plans.map(plan => html`<button class="btn" data-action="checkout" data-plan="${plan.id}">Start ${plan.name}</button>`)}</div>` : ''}
      ${!owner ? html`<p class="hint">Only the workspace owner can change subscriptions.</p>` : !testMode && data.provider !== 'razorpay' ? html`<p class="hint">Online checkout opens once a payment provider is connected.</p>` : ''}
    </section>
    <section><h2>Compare plans</h2>${comparison}</section></div>`);
  $$('[data-width]').forEach(bar => { bar.style.width = bar.dataset.width + '%'; });
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
