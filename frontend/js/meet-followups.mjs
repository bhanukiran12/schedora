import { $, api, ask, fmtDateTime, html, loading, mount, notice, raw, toast, wsPath } from './core.mjs';

// Reviewed AI follow-up for a transcript (backend/src/ai/followups.mjs). The draft is editable text; the
// only way an email is sent or a task created is the explicit "Review and send" step below.

const newRequestId = () => crypto.randomUUID();

export async function mountFollowups(target, transcriptId, { aiAvailable }) {
  const base = wsPath(`/transcripts/${transcriptId}/followups`);
  const render = async focus => {
    let data;
    try { data = await api('GET', base); } catch (error) { return mount(target, notice('bad', html`<p>${error.message}</p>`)); }
    const current = data.followups.find(item => item.status === 'draft') || data.followups[0];
    const usage = data.usage;
    const create = aiAvailable ? html`<button class="btn btn-small" type="button" data-followup-create ${usage.remaining ? '' : raw('disabled')}>${current ? 'Draft a new follow-up' : 'Draft follow-up with AI'}</button><span class="hint">${usage.remaining} of ${usage.limit} AI follow-up drafts left today.</span>` : html`<p class="hint">AI is not connected on this server, so follow-up drafts are unavailable.</p>`;
    if (!current) return void (mount(target, html`<section class="followup" aria-labelledby="followup-${transcriptId}"><h3 id="followup-${transcriptId}">Follow-up</h3><p class="hint">Drafts an email and tasks from this transcript. Nothing is sent until you review it.</p><div class="actions">${create}</div></section>`), bindCreate());
    const sent = current.status === 'sent';
    mount(target, html`<section class="followup" aria-labelledby="followup-${transcriptId}"><h3 id="followup-${transcriptId}" tabindex="-1">Follow-up ${sent ? html`<span class="badge badge-ok">Sent ${fmtDateTime(current.sent_at)}</span>` : current.status === 'failed' ? html`<span class="badge badge-bad">Draft failed</span>` : html`<span class="badge badge-warn">Draft — not sent</span>`}</h3>
      ${current.status === 'failed' ? notice('bad', html`<p>${current.error || 'The draft could not be written.'} Nothing was sent.</p>`) : ''}
      ${current.removed_unsupported ? notice('warn', html`<p>${current.removed_unsupported} suggestion${current.removed_unsupported === 1 ? ' was' : 's were'} removed because ${current.removed_unsupported === 1 ? 'its quote is' : 'their quotes are'} not in the transcript.</p>`) : ''}
      ${current.status === 'draft' || sent ? html`<form class="followup-form" data-followup-form novalidate>
        <label for="fu-to-${current.id}">To <span class="muted">(one email per line; suggested from the meeting's attendees)</span></label><textarea id="fu-to-${current.id}" name="recipients" rows="2" ${sent ? raw('readonly') : ''}>${current.recipients.join('\n')}</textarea>
        <label for="fu-subject-${current.id}">Subject</label><input id="fu-subject-${current.id}" name="subject" maxlength="200" value="${current.subject}" ${sent ? raw('readonly') : ''}>
        <label for="fu-body-${current.id}">Message</label><textarea id="fu-body-${current.id}" name="body" rows="9" maxlength="8000" ${sent ? raw('readonly') : ''}>${current.body}</textarea>
        ${current.tasks.length ? html`<fieldset><legend class="label">Tasks</legend>${current.tasks.map((task, index) => html`<div class="followup-task"><label class="check"><input type="checkbox" name="keep-${index}" checked ${sent ? raw('disabled') : ''}> Keep</label>
          <label class="visually-hidden" for="fu-task-${current.id}-${index}">Task ${index + 1}</label><input id="fu-task-${current.id}-${index}" name="task-${index}" maxlength="300" value="${task.title}" ${sent ? raw('readonly') : ''}>
          <p class="hint">${task.owner} · ${task.due} · Source: “${task.quote}”</p></div>`)}</fieldset>` : ''}
        ${current.sources.length ? html`<details><summary>Sources from the transcript (${current.sources.length})</summary><ul>${current.sources.map(source => html`<li>“${source.quote}” <span class="muted">— ${source.supports}</span></li>`)}</ul></details>` : ''}
        <p class="hint">AI drafted this from the transcript${current.edited ? ' and you edited it' : ''}. Check names, dates and promises before sending. Usage: ${current.usage.input_tokens + current.usage.output_tokens} tokens.</p>
        <div data-followup-status role="status"></div>
        ${sent ? html`<p class="hint">${current.sent_emails ? `Emailed to ${current.sent_emails} recipient${current.sent_emails === 1 ? '' : 's'}. ` : ''}${current.created_tasks ? `${current.created_tasks} task${current.created_tasks === 1 ? '' : 's'} added to Flow → Tasks.` : ''}</p>`
          : html`<div class="actions"><button class="btn btn-small" type="submit">Save draft</button><button class="btn btn-small btn-primary" type="button" data-followup-send>Review and send…</button><button class="btn btn-small btn-link" type="button" data-followup-discard>Discard draft</button></div>`}
      </form>` : ''}
      <div class="actions">${create}</div></section>`);
    if (focus) $(focus, target)?.focus();
    const form = $('[data-followup-form]', target);
    const values = () => {
      const data = new FormData(form);
      return {
        revision: current.revision, subject: String(data.get('subject') || ''), body: String(data.get('body') || ''),
        recipients: String(data.get('recipients') || '').split(/[\n,;]+/).map(item => item.trim()).filter(Boolean),
        tasks: current.tasks.filter((_, index) => data.get('keep-' + index)).map(task => ({ ...task, title: String(data.get('task-' + current.tasks.indexOf(task)) || task.title) }))
      };
    };
    const save = async () => {
      const updated = await api('PATCH', wsPath(`/followups/${current.id}`), values());
      current.revision = updated.revision;
      return updated;
    };
    form?.addEventListener('submit', async event => {
      event.preventDefault();
      try { await save(); toast('Follow-up draft saved. Nothing was sent.'); await render(); }
      catch (error) { mount($('[data-followup-status]', target), notice('bad', html`<p>${error.message}</p>`)); }
    });
    $('[data-followup-send]', target)?.addEventListener('click', async () => {
      let saved;
      try { saved = await save(); } catch (error) { return mount($('[data-followup-status]', target), notice('bad', html`<p>${error.message}</p>`)); }
      const choice = await ask({
        title: 'Send this follow-up?',
        body: html`You reviewed revision ${saved.revision}. Only what you tick below happens.`,
        fields: html`<p><strong>To:</strong> ${saved.recipients.join(', ') || 'no recipients'}</p><p><strong>Subject:</strong> ${saved.subject}</p><label class="check"><input type="checkbox" name="send_email" ${saved.recipients.length ? raw('checked') : raw('disabled')}> Email the message to these recipients</label>
          <label class="check"><input type="checkbox" name="create_tasks" ${saved.tasks.length ? '' : raw('disabled')}> Create ${saved.tasks.length} task${saved.tasks.length === 1 ? '' : 's'} in Flow → Tasks</label>`,
        confirm: 'Send now'
      });
      if (!choice) return render();
      try {
        await api('POST', wsPath(`/followups/${current.id}/send`), { revision: saved.revision, confirm: true, send_email: Boolean(choice.send_email), create_tasks: Boolean(choice.create_tasks) });
        toast('Follow-up sent.');
        await render(`#followup-${transcriptId}`);
      } catch (error) { await render(); toast(error.message); }
    });
    $('[data-followup-discard]', target)?.addEventListener('click', async () => {
      if (!(await ask({ title: 'Discard this draft?', body: 'Nothing has been sent. The draft is removed from this transcript.', confirm: 'Discard', danger: true }))) return;
      try { await api('DELETE', wsPath(`/followups/${current.id}`)); await render(); } catch (error) { toast(error.message); }
    });
    bindCreate();
  };
  // Shared by the empty state and the draft view.
  const bindCreate = () => $('[data-followup-create]', target)?.addEventListener('click', async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Writing draft…';
    try { await api('POST', base, { request_id: newRequestId() }); await render(`#followup-${transcriptId}`); }
    catch (error) { toast(error.message); await render(); }
  });
  mount(target, loading('Loading follow-up…'));
  await render();
}
