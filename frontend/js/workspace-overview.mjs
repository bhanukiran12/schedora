import { api, badge, fmtDateTime, html, isAdmin, loading, mount, session, wsPath, workspace } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';

const firstName = name => String(name || '').trim().split(/\s+/)[0] || 'there';
const metric = (label, value, detail, href, tone) => html`<a class="workspace-metric workspace-metric--${tone}" href="${href}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></a>`;

export async function workspaceOverview(ctx) {
  setTitle('Overview · Schedora');
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'suite', title: 'Your workspace, at a glance.', lead: 'Sign in to see your meetings, forms and follow-up in one place.' }));
  if (!needsSession(ctx)) return;
  const ws = workspace();
  mount(ctx.main, html`<div class="container page workspace-overview"><header class="page-head"><div class="page-head-text"><p class="page-eyebrow">${ws.name} · WORKSPACE</p><h1>Good things ahead, ${firstName(session.user.name)}.</h1><p class="lead">A clear view of your meetings, responses and follow-up.</p></div><div class="row workspace-overview__actions">${isAdmin() ? html`<a class="btn" href="/meet/event-types/new">New event type</a><a class="btn" href="/forms?create=1">Create form</a><a class="btn btn-primary" href="/flow/new">New flow</a>` : ''}</div></header><div id="overview-content">${loading('Loading your workspace…')}</div></div>`);
  try {
    const results = await Promise.all([
      api('GET', wsPath('/event-types')).catch(() => null),
      api('GET', wsPath('/bookings?scope=upcoming')).catch(() => null),
      api('GET', wsPath('/forms')).catch(() => null),
      api('GET', wsPath('/flows')).catch(() => null),
      api('GET', wsPath('/runs')).catch(() => null)
    ]);
    if (!ctx.alive()) return;
    const [eventTypes, bookings, forms, flows, runs] = results;
    const activeFlows = flows?.filter(flow => flow.status === 'enabled') || [];
    const failedRuns = runs?.filter(run => run.status === 'failed') || [];
    const liveForms = forms?.filter(form => form.published_version) || [];
    const topBookings = bookings?.slice(0, 4) || [];
    const topRuns = runs?.slice(0, 5) || [];
    mount(document.querySelector('#overview-content'), html`
      <section class="workspace-metrics" aria-label="Workspace totals">
        ${metric('Upcoming meetings', bookings?.length ?? '—', bookings ? 'Your next appointments' : 'Meet access unavailable', '/meet?tab=meetings', 'meet')}
        ${metric('Published forms', forms ? liveForms.length : '—', forms ? `${forms.length} forms in this workspace` : 'Forms access unavailable', '/forms', 'forms')}
        ${metric('Active workflows', flows ? activeFlows.length : '—', flows ? `${flows.length} workflows total` : 'Flow access unavailable', '/flow', 'flow')}
        ${metric('Runs to review', runs ? failedRuns.length : '—', runs ? 'Failed workflow runs' : 'Run history unavailable', '/flow/runs?status=failed', 'attention')}
      </section>
      <div class="workspace-overview__grid">
        <section class="workspace-overview-panel"><header><div><p class="page-eyebrow">MEET</p><h2>Your next conversations</h2></div><a href="/meet?tab=meetings">All meetings →</a></header>
          ${bookings === null ? html`<p class="workspace-overview__empty">Meeting details aren’t available with your current access.</p>` : topBookings.length ? html`<ul class="workspace-overview-list">${topBookings.map(booking => html`<li><time>${fmtDateTime(booking.starts_at, booking.host_timezone)}</time><span><strong>${booking.event_title}</strong><small>${booking.invitee_name} · ${booking.invitee_email}</small></span>${badge(booking.status)}</li>`)}</ul>` : html`<div class="workspace-overview__empty"><strong>No upcoming meetings</strong><p>Share a booking link when you’re ready to meet.</p><a class="btn btn-small" href="/meet/event-types/new">Create an event type</a></div>`}
        </section>
        <section class="workspace-overview-panel"><header><div><p class="page-eyebrow">YOUR PRODUCTS</p><h2>Everything in one place</h2></div></header>
          <div class="workspace-product-cards">
            <a class="workspace-product-card workspace-product-card--meet" href="/meet"><strong>Meet</strong><span>${eventTypes ? `${eventTypes.filter(type => !type.managed_template).length} event types` : 'Open your booking tools'}</span><small>Appointments and booking pages →</small></a>
            <a class="workspace-product-card workspace-product-card--forms" href="/forms"><strong>Forms</strong><span>${forms ? `${forms.length} forms · ${forms.reduce((sum, form) => sum + (form.response_count || 0), 0)} responses` : 'Open your forms'}</span><small>Questions and responses →</small></a>
            <a class="workspace-product-card workspace-product-card--flow" href="/flow"><strong>Flow</strong><span>${flows ? `${activeFlows.length} active workflows` : 'Open your automations'}</span><small>Tasks and follow-ups →</small></a>
          </div>
        </section>
        <section class="workspace-overview-panel workspace-overview-panel--wide"><header><div><p class="page-eyebrow">FLOW</p><h2>Recent workflow activity</h2></div><a href="/flow/runs">Run history →</a></header>
          ${runs === null ? html`<p class="workspace-overview__empty">Run history isn’t available with your current access.</p>` : topRuns.length ? html`<ul class="workspace-overview-list workspace-overview-list--runs">${topRuns.map(run => html`<li><time>${fmtDateTime(run.created_at)}</time><span><strong>${run.flow_name}</strong><small>${run.last_error || (run.result?.task ? 'Follow-up task created' : run.result?.email ? 'Email action recorded' : 'Workflow run')}</small></span>${badge(run.status)}</li>`)}</ul>` : html`<div class="workspace-overview__empty"><strong>No workflow runs yet</strong><p>When a booking or form response starts a workflow, you can follow it here.</p><a href="/flow">View workflows →</a></div>`}
        </section>
      </div>
      ${failedRuns.length ? html`<p class="workspace-overview__attention"><strong>${failedRuns.length} workflow ${failedRuns.length === 1 ? 'run needs' : 'runs need'} attention.</strong> <a href="/flow/runs?status=failed">Review failed runs →</a></p>` : ''}
    `);
  } catch (error) {
    if (ctx.alive()) mount(document.querySelector('#overview-content'), html`<div class="notice notice-bad" role="alert"><p>${error.message}</p></div>`);
  }
}
