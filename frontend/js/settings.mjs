import { $, $$, api, ask, badge, copy, errorBlock, fmtDateTime, handleSubmit, html, loadMe, loading, mount, notice, raw, toast, workspace, wsPath } from './core.mjs';

const EVENTS = { 'meet.booking.created': 'Meeting booked', 'meet.booking.canceled': 'Meeting canceled', 'meet.booking.rescheduled': 'Meeting rescheduled', 'forms.response.created': 'Form response' };

// Account settings are grouped by what the customer came here to manage.
export async function render(ctx, container) {
  const ws = workspace();
  const role = ws.role;
  const admin = ['owner', 'admin'].includes(role);
  mount(container, loading());
  const [keys, hooks, sso, audit] = await Promise.all([
    api('GET', wsPath('/api-keys')),
    admin ? api('GET', wsPath('/webhooks')) : null,
    role === 'owner' ? api('GET', wsPath('/sso')) : null,
    admin ? api('GET', wsPath('/audit')) : null
  ]).catch(error => { mount(container, errorBlock(error)); return []; });
  if (!keys || !ctx.alive()) return;
  const full = await api('GET', wsPath(''));
  mount(container, html`
    <div class="account-settings-category" data-settings-panel="booking">
    ${admin ? html`<section class="card card-plain"><h2>Booking page and branding</h2>
      <form id="brand-form" novalidate>
        <p class="hint">This is the page invitees see when they choose a meeting time.</p><label for="b-slug">Booking page address</label><span class="hint">${location.origin}/meet/<strong id="slug-show">${full.slug}</strong></span>
        <input id="b-slug" name="slug" value="${full.slug}" maxlength="60" pattern="[a-z0-9]+(-[a-z0-9]+)*">
        <label for="b-welcome">Message shown at the top</label><textarea id="b-welcome" name="welcome_message" maxlength="500" placeholder="A short welcome for people booking with you">${full.welcome_message || ''}</textarea>
        <label for="b-logo">Your logo <span class="hint">PNG, JPEG or WebP · under 200 KB</span></label><input id="b-logo" type="file" accept="image/png,image/jpeg,image/webp">
        ${full.logo ? html`<div class="row"><img class="brand-logo" src="${full.logo}" alt="Current logo"><label class="check"><input type="checkbox" name="remove_logo"> Remove logo</label></div>` : ''}
        <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn btn-primary" type="submit">Save branding</button><a class="btn" href="/meet/${full.slug}" target="_blank" rel="noopener">View booking page</a></div>
      </form></section>` : html`<p class="hint">Only workspace owners and administrators can change the public booking page.</p>`}
    </div>

    <div class="account-settings-category" data-settings-panel="developer"><section class="card card-plain"><h2>Connect another app</h2><p class="hint">Developer tools are for connecting Schedora to your website, CRM or other software. You can ignore this section if you use Schedora on its own.</p><h3>API keys</h3><p class="hint">An API key lets another app access this workspace as you. Keep it private. Use it for the REST API, MCP (<code>${location.origin}/api/mcp</code>) or the browser extension.</p>
      ${keys.length ? html`<ul class="list">${keys.map(key => html`<li class="row-between"><div><div class="list-title">${key.name}</div><div class="meta"><span>${key.prefix}…</span><span>Created ${fmtDateTime(key.created_at)}</span><span>${key.last_used_at ? 'Last used ' + fmtDateTime(key.last_used_at) : 'Never used'}</span></div></div>
        <div>${key.revoked_at ? badge('canceled', 'Revoked') : html`<button class="btn btn-small btn-danger" data-revoke="${key.id}">Revoke</button>`}</div></li>`)}</ul>` : ''}
      <form id="key-form" class="row section-gap" novalidate><label for="k-name" class="visually-hidden">Key name</label><input id="k-name" name="name" required maxlength="80" placeholder="Name, e.g. CRM sync"><button class="btn" type="submit">Create key</button></form><div id="new-key"></div>

    ${admin ? html`<hr><h3>Webhooks</h3><p class="hint">Send an automatic update to your app when a meeting is booked, changed, canceled or a form is submitted. This is for developers with a web address that can receive updates.</p>
      ${hooks.length ? html`<ul class="list">${hooks.map(hook => html`<li><div class="row-between"><div><div class="list-title">${hook.url}</div><div class="meta"><span>${hook.events.map(event => EVENTS[event]).join(', ')}</span></div></div>
        <div class="row">${badge(hook.active ? 'active' : 'paused', hook.active ? 'On' : 'Off')}<button class="btn btn-small" data-toggle-hook="${hook.id}" data-active="${hook.active}">${hook.active ? 'Pause' : 'Resume'}</button><button class="btn btn-small btn-danger" data-delete-hook="${hook.id}">Delete</button></div></div>
        ${hook.recent.length ? html`<details><summary>Recent deliveries</summary><ul class="plain-list">${hook.recent.map(delivery => html`<li>${badge(delivery.status === 'delivered' ? 'sent' : delivery.status)} ${delivery.event_type} · ${fmtDateTime(delivery.created_at)}${delivery.last_error ? html` · <span class="muted">${delivery.last_error}</span>` : ''}${delivery.status === 'failed' ? html` <button class="btn-link" data-redeliver="${delivery.id}">Resend</button>` : ''}</li>`)}</ul></details>` : ''}</li>`)}</ul>` : ''}
      <form id="hook-form" class="section-gap" novalidate><label for="h-url">Endpoint URL</label><input id="h-url" name="url" type="url" required placeholder="https://example.com/webhooks/schedora">
        <fieldset><legend class="label">Send updates for</legend><div class="check-grid">${Object.entries(EVENTS).map(([key, label]) => html`<label class="check"><input type="checkbox" name="ev_${key}" checked> ${label}</label>`)}</div></fieldset>
        <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn" type="submit">Add webhook</button></div></form><div id="new-hook"></div>` : ''}</section></div>

    <div class="account-settings-category" data-settings-panel="security">${sso ? html`<section class="card card-plain"><h2>Sign-in for your organization</h2><p class="hint">Connect your company’s sign-in system so members use their work account. This is optional and usually needs help from your IT administrator. Supported providers include Google Workspace, Microsoft Entra ID and Okta.</p><details><summary>Technical setup details</summary><p>Register this address with your identity provider: <code>${sso.redirect_uri}</code></p></details>
      ${sso.issuer ? notice(sso.enabled ? 'ok' : 'info', html`<p>${sso.enabled ? 'Enabled' : 'Disabled'} for @${sso.email_domain}${sso.enforced ? '; password sign-in is blocked for that domain' : ''}.</p>`) : ''}
      <form id="sso-form" novalidate>
        <label for="s-issuer">Issuer URL</label><input id="s-issuer" name="issuer" type="url" required value="${sso.issuer || ''}" placeholder="https://your-org.okta.com">
        <div class="inline-fields"><div><label for="s-client">Client ID</label><input id="s-client" name="client_id" required value="${sso.client_id || ''}"></div>
          <div><label for="s-secret">Client secret</label><input id="s-secret" name="client_secret" type="password" autocomplete="off" placeholder="${sso.issuer ? 'Leave blank to keep the current secret' : ''}"></div></div>
        <div class="inline-fields"><div><label for="s-domain">Email domain</label><input id="s-domain" name="email_domain" required value="${sso.email_domain || ''}" placeholder="example.com"></div>
          <div><label for="s-role">New members join as</label><select id="s-role" name="default_role"><option value="member" ${sso.default_role !== 'admin' ? raw('selected') : ''}>Member</option><option value="admin" ${sso.default_role === 'admin' ? raw('selected') : ''}>Administrator</option></select></div></div>
        <label class="check"><input type="checkbox" name="enabled" ${sso.enabled !== false ? raw('checked') : ''}> Allow members to sign in with this provider</label>
        <label class="check"><input type="checkbox" name="enforced" ${sso.enforced ? raw('checked') : ''}> Require this sign-in method for this email domain</label>
        <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn" type="submit">Save sign-in settings</button></div></form></section>` : ''}</div>

    <div class="account-settings-category" data-settings-panel="activity">${audit ? html`<section class="card card-plain"><h2>Workspace activity</h2><p class="hint">Recent changes made by workspace members.</p>${audit.length ? html`<ul class="plain-list">${audit.map(entry => html`<li>${fmtDateTime(entry.created_at)} · ${entry.actor_name || 'System'} · ${entry.action}${entry.target ? html` <span class="muted">${entry.target}</span>` : ''}</li>`)}</ul>` : html`<p class="muted">No activity yet.</p>`}</section>` : ''}</div>`);

  if ($('#brand-form')) {
    $('#b-slug').addEventListener('input', () => { $('#slug-show').textContent = $('#b-slug').value; });
    handleSubmit($('#brand-form'), async data => {
      const body = { slug: data.slug, welcome_message: data.welcome_message };
      const file = $('#b-logo').files[0];
      if (file) {
        if (file.size > 200 * 1024) throw Object.assign(new Error('Use an image under 200 KB.'), { details: {} });
        body.logo = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
      } else if (data.remove_logo) body.logo = null;
      await api('PATCH', wsPath(''), body);
      await loadMe();
      toast('Branding saved.');
      ctx.render();
    });
  }
  handleSubmit($('#key-form'), async data => {
    const key = await api('POST', wsPath('/api-keys'), data);
    mount($('#new-key'), notice('warn', html`<p>${key.note}</p><div class="row"><input readonly value="${key.token}" aria-label="New API key"><button class="btn btn-small" id="copy-key">Copy</button></div>`));
    $('#copy-key').onclick = () => copy(key.token, 'API key');
  });
  $$('[data-revoke]', container).forEach(button => button.onclick = async () => {
    if (!(await ask({ title: 'Revoke this key?', body: 'Anything using it stops working immediately.', confirm: 'Revoke', danger: true }))) return;
    await api('DELETE', wsPath('/api-keys/' + button.dataset.revoke));
    ctx.render();
  });
  if ($('#hook-form')) handleSubmit($('#hook-form'), async data => {
    const events = Object.keys(EVENTS).filter(event => data['ev_' + event]);
    const hook = await api('POST', wsPath('/webhooks'), { url: data.url, events });
    await ask({ title: 'Webhook added', body: 'Copy the signing secret now; it is not shown again.', fields: html`<input readonly value="${hook.secret}" aria-label="Signing secret">`, confirm: 'Done' });
    ctx.render();
  });
  $$('[data-toggle-hook]', container).forEach(button => button.onclick = async () => { await api('PATCH', wsPath('/webhooks/' + button.dataset.toggleHook), { active: button.dataset.active !== 'true' }); ctx.render(); });
  $$('[data-delete-hook]', container).forEach(button => button.onclick = async () => { if (await ask({ title: 'Delete this webhook?', confirm: 'Delete', danger: true })) { await api('DELETE', wsPath('/webhooks/' + button.dataset.deleteHook)); ctx.render(); } });
  $$('[data-redeliver]', container).forEach(button => button.onclick = async () => { await api('POST', wsPath(`/webhooks/deliveries/${button.dataset.redeliver}/redeliver`)); toast('Queued for redelivery.'); });
  if ($('#sso-form')) handleSubmit($('#sso-form'), async data => {
    const body = { issuer: data.issuer, client_id: data.client_id, email_domain: data.email_domain, default_role: data.default_role, enabled: data.enabled, enforced: data.enforced };
    if (data.client_secret) body.client_secret = data.client_secret;
    await api('PUT', wsPath('/sso'), body);
    toast('SSO settings saved.');
    ctx.render();
  });
}
