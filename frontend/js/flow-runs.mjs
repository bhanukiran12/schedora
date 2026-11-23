import { $, api, ask, fmtDateTime, html, isAdmin, loading, mount, notice, raw, session, toast, wsPath } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';

// Flow v1 run timeline and approvals (docs/FLOW_V1_IMPLEMENTATION.md, "Run history"). Both work on phones.

export const RUN_CHIP = { succeeded: ['ok', 'Succeeded'], waiting: ['warn', 'Waiting'], needs_approval: ['warn', 'Needs approval'], skipped: ['neutral', 'Skipped'], failed: ['bad', 'Failed'], canceled: ['neutral', 'Canceled'], queued: ['warn', 'Queued'], running: ['warn', 'Running'], retrying: ['warn', 'Retrying'] };
const STEP_CHIP = { succeeded: ['ok', 'Done'], skipped: ['neutral', 'Skipped'], failed: ['bad', 'Failed'], uncertain: ['bad', 'Uncertain'], waiting: ['warn', 'Waiting'], running: ['warn', 'Running'], canceled: ['neutral', 'Canceled'], not_reached: ['neutral', 'Not reached'] };
export const chip = ([kind, label]) => html`<span class="badge badge-${kind}">${label}</span>`;

function delivery(step) {
  if (!step.delivery) return '';
  const report = step.delivery.report;
  return html`<p class="hint">${step.delivery.accepted ? `Accepted by the provider${step.delivery.accepted_at ? ' ' + fmtDateTime(step.delivery.accepted_at) : ''}${step.delivery.transport === 'outbox' ? ' (local outbox: not delivered to anyone)' : ''}.` : 'Not yet accepted by the provider.'}
    ${report ? ` Delivery report: ${report}.` : step.delivery.accepted && step.delivery.transport !== 'outbox' ? ' No delivery report yet; acceptance does not prove it arrived.' : ''}</p>`;
}

export async function runDetail(ctx) {
  setTitle('Run · Flow by Schedora');
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'flow', title: 'Sign in to see this run', lead: 'Runs belong to your workspace.' }));
  if (!needsSession(ctx)) return;
  const id = ctx.params[0];
  const draw = async () => {
    let run;
    try { run = await api('GET', wsPath(`/flow/runs/${id}`)); } catch (error) { return mount(ctx.main, html`<div class="container page">${notice('bad', html`<p>${error.message}</p>`)}<a class="btn" href="/flow/runs">Run history</a></div>`); }
    if (!ctx.alive()) return;
    const active = ['queued', 'running', 'retrying', 'waiting', 'needs_approval'].includes(run.status);
    mount(ctx.main, html`<div class="container page flow-run"><a href="/flow/runs">← Run history</a>
      <div class="page-head"><div class="page-head-text"><p class="page-eyebrow">${run.trigger} · version ${run.version}</p><h1>${run.flow_name}</h1></div></div>
      <p>${chip(RUN_CHIP[run.status] || ['neutral', run.status])} <span class="muted">Started ${fmtDateTime(run.created_at)}${run.finished_at ? ` · finished ${fmtDateTime(run.finished_at)}` : ''}${run.next_at ? ` · next ${fmtDateTime(run.next_at)}` : ''}</span></p>
      ${run.reason ? notice(run.status === 'failed' ? 'bad' : 'info', html`<p>${run.reason}</p>`) : ''}
      ${run.status === 'needs_approval' ? html`<p><a class="btn btn-primary" href="/flow/approvals">Open approvals</a></p>` : ''}
      <ol class="flow-timeline">${run.steps.map(step => html`<li class="flow-timeline-step" data-status="${step.status}"><div class="row-between"><strong>${step.title}</strong>${chip(STEP_CHIP[step.status] || ['neutral', step.status])}</div>
        ${step.started_at ? html`<p class="muted">${fmtDateTime(step.started_at)}${step.finished_at && step.finished_at !== step.started_at ? ` → ${fmtDateTime(step.finished_at)}` : ''}${step.attempts > 1 ? ` · ${step.attempts} attempts` : ''}</p>` : ''}
        ${step.reason ? html`<p>${step.reason}</p>` : ''}
        ${step.output ? html`<dl class="flow-preview">${Object.entries(step.output).filter(([key, value]) => value != null && !['usage', 'ai'].includes(key) && typeof value !== 'object').map(([key, value]) => html`<dt>${key.replace(/_/g, ' ')}</dt><dd>${String(value)}</dd>`)}${step.output.usage ? html`<dt>AI usage</dt><dd>${step.output.usage.input_tokens + step.output.usage.output_tokens} tokens</dd>` : ''}</dl>` : ''}
        ${delivery(step)}</li>`)}</ol>
      ${isAdmin() ? html`<div class="actions">${run.status === 'failed' ? html`<button class="btn btn-primary" type="button" id="run-retry">Retry…</button>` : ''}${active ? html`<button class="btn btn-danger" type="button" id="run-cancel">Cancel run</button>` : ''}<a class="btn" href="/flow/build/${run.flow_id}">Open workflow</a></div>` : ''}
    </div>`);
    $('#run-cancel')?.addEventListener('click', async () => {
      if (!(await ask({ title: 'Cancel this run?', body: 'Nothing further happens for this run. Steps already done are not undone.', confirm: 'Cancel run', danger: true }))) return;
      try { await api('POST', wsPath(`/flow/runs/${id}/cancel`)); toast('Run canceled.'); draw(); } catch (error) { toast(error.message); }
    });
    $('#run-retry')?.addEventListener('click', async () => {
      let preview;
      try { preview = await api('GET', wsPath(`/flow/runs/${id}/retry`)); } catch (error) { return toast(error.message); }
      const choice = await ask({ title: 'Retry this run?', body: preview.note,
        fields: html`${preview.already_done.length ? html`<p><strong>Already done, not repeated:</strong></p><ul>${preview.already_done.map(item => html`<li>${item}</li>`)}</ul>` : ''}
          ${preview.will_run_again.length ? html`<p><strong>Will run again:</strong></p><ul>${preview.will_run_again.map(item => html`<li>${item}</li>`)}</ul>` : ''}
          ${preview.uncertain.length ? html`<p><strong>May already have happened:</strong></p><ul>${preview.uncertain.map(item => html`<li>${item.title}: ${item.reason}</li>`)}</ul>
            <fieldset><legend class="label">For those steps</legend><label class="check"><input type="radio" name="uncertain" value="done" checked> Treat as done (check the other app first)</label><label class="check"><input type="radio" name="uncertain" value="resend"> Send again with the same idempotency key</label></fieldset>` : ''}`,
        confirm: 'Retry' });
      if (!choice) return;
      try { await api('POST', wsPath(`/flow/runs/${id}/retry`), preview.uncertain.length ? { uncertain: choice.uncertain } : {}); toast('Retry queued. Retries do not count toward usage.'); draw(); } catch (error) { toast(error.message); }
    });
  };
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  await draw();
}

export async function approvals(ctx) {
  setTitle('Approvals · Flow by Schedora');
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'flow', title: 'Sign in to review approvals', lead: 'Approvals belong to your workspace.' }));
  if (!needsSession(ctx)) return;
  const showAll = ctx.query.get('status') === 'all';
  mount(ctx.main, html`<div class="container page flow-approvals"><a href="/flow">← Flow</a><div class="page-head"><div class="page-head-text"><h1>Approvals</h1><p class="lead">Steps waiting for a person. Nothing after an approval runs until it is approved.</p></div></div>
    <div class="row"><a class="btn btn-small" href="/flow/approvals" aria-current="${showAll ? 'false' : 'page'}">Waiting</a><a class="btn btn-small" href="/flow/approvals?status=all" aria-current="${showAll ? 'page' : 'false'}">All recent</a></div>
    <div id="approval-list">${loading()}</div></div>`);
  const list = $('#approval-list');
  const draw = async () => {
    let items;
    try { items = await api('GET', wsPath('/flow/approvals' + (showAll ? '?status=all' : ''))); } catch (error) { return mount(list, notice('bad', html`<p>${error.message}</p>`)); }
    if (!ctx.alive()) return;
    if (!items.length) return mount(list, html`<div class="empty"><h2>Nothing waiting</h2><p>Approval requests appear here and are emailed to the approvers.</p></div>`);
    mount(list, html`<ul class="flow-approval-list">${items.map(item => html`<li class="card card-plain flow-approval" data-approval="${item.id}">
      <p class="page-eyebrow">${item.flow_name}</p><h2>${item.title}</h2>
      <p class="muted">${item.about ? `About ${item.about} · ` : ''}${item.status === 'pending' ? `Expires ${fmtDateTime(item.expires_at)}` : `${item.status[0].toUpperCase() + item.status.slice(1)}${item.decided_at ? ' ' + fmtDateTime(item.decided_at) : ''}`}</p>
      ${item.draft != null ? html`<label for="draft-${item.id}">Message to approve${item.can_decide ? ' (you can edit it)' : ''}</label><textarea id="draft-${item.id}" rows="6" maxlength="3000" ${item.can_decide ? '' : raw('readonly')}>${item.draft}</textarea><p class="hint">Written by AI from this record. Check names, dates and promises before approving.</p>` : ''}
      ${item.note ? html`<p>Note: ${item.note}</p>` : ''}
      ${item.can_decide ? html`<div class="actions">${item.draft != null ? html`<button class="btn" type="button" data-save-draft="${item.id}" data-revision="${item.revision}">Save edits</button>` : ''}<button class="btn btn-primary" type="button" data-decide="approve" data-id="${item.id}" data-revision="${item.revision}">Approve</button><button class="btn btn-danger" type="button" data-decide="reject" data-id="${item.id}" data-revision="${item.revision}">Reject</button><a class="btn btn-link" href="/flow/runs/${item.run_id}">View run</a></div>`
        : item.status === 'pending' ? html`<p class="hint">You are not an approver for this step.</p>` : ''}</li>`)}</ul>`);
  };
  list.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    const revision = Number(button.dataset.revision);
    try {
      if (button.dataset.saveDraft) {
        await api('POST', wsPath(`/flow/approvals/${button.dataset.saveDraft}`), { decision: 'edit', revision, draft: $('#draft-' + button.dataset.saveDraft).value });
        toast('Edits saved. Approve when ready.');
        return draw();
      }
      const id = button.dataset.id;
      const draft = $('#draft-' + id);
      if (draft && draft.value !== draft.defaultValue) {
        const saved = await api('POST', wsPath(`/flow/approvals/${id}`), { decision: 'edit', revision, draft: draft.value });
        return decide(id, button.dataset.decide, saved.revision);
      }
      return decide(id, button.dataset.decide, revision);
    } catch (error) { toast(error.message); draw(); }
  });
  async function decide(id, decision, revision) {
    let note;
    if (decision === 'reject') {
      const choice = await ask({ title: 'Reject this step?', body: 'The run stops here and shows as Skipped.', fields: html`<label for="reject-note">Reason (optional)</label><input id="reject-note" name="note" maxlength="300">`, confirm: 'Reject', danger: true });
      if (!choice) return;
      note = choice.note;
    }
    await api('POST', wsPath(`/flow/approvals/${id}`), { decision, revision, ...(note ? { note } : {}) });
    toast(decision === 'approve' ? 'Approved. The run continues.' : 'Rejected.');
    await draw();
  }
  await draw();
}
