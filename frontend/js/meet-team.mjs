import { $, $$, api, ask, badge, boot, browserZone, copy, dateKey, errorBlock, fmtDateTime, fmtFull, handleSubmit, html, isAdmin, loading, minutesToTime, mount, notice, raw, session, timeToMinutes, toast, workspace, wsPath, zoneOptions } from './core.mjs';
import { setTitle } from './pages.mjs';

// ---------------------------------------------------------------------------------------------
// Polls

export async function pollsTab(ctx, panel) {
  const polls = await api('GET', wsPath('/polls'));
  if (!ctx.alive()) return;
  mount(panel, html`<div class="row-between"><p class="muted">Propose times, let people vote without an account, then book the winner for everyone.</p><button class="btn btn-primary" id="new-poll">New poll</button></div>
    <div id="poll-form"></div>
    ${polls.length ? html`<ul class="list section-gap">${polls.map(poll => html`<li class="row-between"><div><div class="list-title">${poll.title}</div>
      <div class="meta"><span>${poll.vote_count} ${poll.vote_count === 1 ? 'vote' : 'votes'}</span><span>${fmtDateTime(poll.created_at)}</span>${isAdmin() ? html`<span>${poll.host_name}</span>` : ''}</div></div>
      <div class="row">${badge(poll.status === 'open' ? 'pending' : poll.status === 'booked' ? 'confirmed' : 'canceled', poll.status)}<button class="btn btn-small" data-copy="${location.origin}/meet/poll/${poll.slug}">Copy link</button><button class="btn btn-small" data-open="${poll.id}">Results</button></div></li>
      <li id="poll-${poll.id}" hidden></li>`)}</ul>` : html`<div class="empty section-gap">No polls yet.</div>`}`);
  $$('[data-copy]', panel).forEach(button => button.onclick = () => copy(button.dataset.copy, 'Poll link'));
  $$('[data-open]', panel).forEach(button => button.onclick = () => pollResults(ctx, button.dataset.open));
  $('#new-poll').onclick = () => {
    const options = [''];
    mount($('#poll-form'), html`<form class="card card-plain section-gap" id="create-poll" novalidate><h2>New poll</h2>
      <label for="poll-title">Title</label><input id="poll-title" name="title" required maxlength="120" placeholder="Quarterly planning">
      <div class="inline-fields"><div><label for="poll-duration">Duration (minutes)</label><input id="poll-duration" name="duration_min" type="number" min="5" max="720" value="30"></div>
        <div><label for="poll-zone">Time zone</label><select id="poll-zone" name="timezone">${zoneOptions(browserZone())}</select></div></div>
      <label for="poll-location">Location</label><input id="poll-location" name="location" maxlength="300">
      <label for="poll-description">Description</label><textarea id="poll-description" name="description" maxlength="2000"></textarea>
      <fieldset><legend class="label">Proposed times (your browser's time zone)</legend><div id="poll-options"></div><button class="btn btn-small" type="button" id="add-option">Add a time</button></fieldset>
      <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn btn-primary" type="submit">Create poll</button></div></form>`);
    const draw = () => mount($('#poll-options'), html`${options.map((value, index) => html`<div class="range"><input type="datetime-local" data-option="${index}" value="${value}" aria-label="Proposed time ${index + 1}"></div>`)}`);
    draw();
    $('#add-option').onclick = () => { options.push(''); draw(); };
    $('#poll-options').addEventListener('change', event => { options[Number(event.target.dataset.option)] = event.target.value; });
    handleSubmit($('#create-poll'), async data => {
      const times = options.filter(Boolean).map(value => new Date(value).toISOString());
      const poll = await api('POST', wsPath('/polls'), { title: data.title, duration_min: data.duration_min, timezone: data.timezone, location: data.location, description: data.description, options: times });
      await copy(`${location.origin}/meet/poll/${poll.slug}`, 'Poll link');
      ctx.render();
    });
  };
}

async function pollResults(ctx, id) {
  const target = $('#poll-' + id);
  target.hidden = false;
  mount(target, loading());
  const poll = await api('GET', wsPath('/polls/' + id));
  const top = Math.max(1, ...poll.options.map(option => option.votes));
  mount(target, html`<table><caption class="visually-hidden">Votes for ${poll.title}</caption><thead><tr><th scope="col">Time (${poll.timezone})</th><th scope="col">Votes</th><th scope="col">Voters</th>${poll.status === 'open' ? html`<th scope="col"><span class="visually-hidden">Action</span></th>` : ''}</tr></thead>
    <tbody>${poll.options.map(option => html`<tr><td>${fmtFull(option.starts_at, poll.timezone)}${option.id === poll.booked_option_id ? ' ✓ booked' : ''}</td>
      <td><span class="inline-bar" data-width="${Math.round(option.votes / top * 100)}"></span> ${option.votes}</td>
      <td>${poll.votes.filter(vote => vote.option_ids.includes(option.id)).map(vote => vote.name).join(', ') || '—'}</td>
      ${poll.status === 'open' ? html`<td><button class="btn btn-small" data-confirm="${option.id}">Book this time</button></td>` : ''}</tr>`)}</tbody></table>
    ${poll.status === 'open' ? html`<div class="actions"><button class="btn btn-small" data-close>Close without booking</button><button class="btn btn-small btn-danger" data-delete>Delete</button></div>` : ''}`);
  $$('[data-width]', target).forEach(bar => { bar.style.width = (bar.dataset.width * 0.6) + 'px'; });
  $$('[data-confirm]', target).forEach(button => button.onclick = async () => {
    if (!(await ask({ title: 'Book this time?', body: `Every voter (${poll.votes.length}) receives a confirmation for this time.`, confirm: 'Book for everyone' }))) return;
    try { await api('POST', wsPath(`/polls/${id}/confirm`), { option_id: button.dataset.confirm }); toast('Booked. Invitations are on their way.'); ctx.render(); } catch (error) { toast(error.message); }
  });
  target.querySelector('[data-close]')?.addEventListener('click', async () => { await api('POST', wsPath(`/polls/${id}/close`)); ctx.render(); });
  target.querySelector('[data-delete]')?.addEventListener('click', async () => { if (await ask({ title: 'Delete this poll?', confirm: 'Delete', danger: true })) { await api('DELETE', wsPath('/polls/' + id)); ctx.render(); } });
}

export async function publicPoll(ctx) {
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let poll;
  try { poll = await api('GET', `/api/public/polls/${ctx.params[0]}`); }
  catch (error) { return mount(ctx.main, html`<div class="container page"><h1>This poll is not available</h1>${errorBlock(error)}</div>`); }
  setTitle(`${poll.title} · Meet by Schedora`);
  const zone = browserZone();
  mount(ctx.main, html`<div class="container page narrow"><div class="card">
    <span class="tag">Meeting poll</span><h1>${poll.title}</h1><p class="muted">${poll.host_name} · ${poll.workspace_name} · ${poll.duration_min} minutes${poll.location ? ' · ' + poll.location : ''}</p>
    ${poll.description ? html`<p>${poll.description}</p>` : ''}
    ${poll.status === 'booked' ? notice('ok', html`<p>The host chose ${fmtFull(poll.options.find(option => option.id === poll.booked_option_id).starts_at, zone)}. Voters received an invitation.</p>`)
      : poll.status === 'closed' ? notice('info', html`<p>Voting has closed.</p>`)
        : html`<form id="vote" novalidate><fieldset><legend class="label">Which times work for you? (${zone.replace(/_/g, ' ')})</legend><div class="choice-list">${poll.options.map(option => html`<label class="check"><input type="checkbox" name="opt_${option.id}"> ${fmtFull(option.starts_at, zone)} <span class="muted">· ${option.votes} ${option.votes === 1 ? 'vote' : 'votes'}</span></label>`)}</div></fieldset>
          <div class="inline-fields"><div><label for="v-name">Your name</label><input id="v-name" name="name" required maxlength="100" autocomplete="name"></div><div><label for="v-email">Email</label><input id="v-email" name="email" type="email" required autocomplete="email"></div></div>
          <p class="hint">Voting again with the same email updates your choices. If the host books a time, you get an invitation at this address.</p>
          <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn btn-primary" type="submit">Submit my availability</button></div></form>`}
    ${poll.voters.length ? html`<p class="muted">Responded: ${poll.voters.join(', ')}</p>` : ''}</div></div>`);
  if (!$('#vote')) return;
  handleSubmit($('#vote'), async data => {
    const optionIds = Object.entries(data).filter(([key, value]) => key.startsWith('opt_') && value).map(([key]) => key.slice(4));
    await api('POST', `/api/public/polls/${poll.slug}/votes`, { name: data.name, email: data.email, option_ids: optionIds });
    toast('Thanks, your availability was saved.');
    ctx.render();
  });
}

// ---------------------------------------------------------------------------------------------
// Contacts

export async function contactsTab(ctx, panel) {
  const search = ctx.query.get('q') || '';
  const contacts = await api('GET', wsPath('/contacts' + (search ? '?q=' + encodeURIComponent(search) : '')));
  if (!ctx.alive()) return;
  mount(panel, html`<form class="row" id="contact-search" role="search"><label class="visually-hidden" for="cq">Search contacts</label><input id="cq" name="q" value="${search}" placeholder="Search name, email or company"><button class="btn" type="submit">Search</button><button class="btn" type="button" id="new-contact">Add contact</button></form>
    <p class="hint">Contacts are created automatically from bookings and form responses.</p>
    ${contacts.length ? html`<div class="table-wrap"><table><thead><tr><th>Name</th><th>Email</th><th>Company</th><th>Owner</th><th>Meetings</th><th>Last activity</th></tr></thead><tbody>
      ${contacts.map(contact => html`<tr><td><a href="/meet/contacts/${contact.id}">${contact.name || '(no name)'}</a>${contact.tags.length ? html`<div class="muted">${contact.tags.join(', ')}</div>` : ''}</td><td>${contact.email}</td><td>${contact.company || '—'}</td><td>${contact.owner_name || '—'}</td><td>${contact.meeting_count}</td><td>${fmtDateTime(contact.last_activity_at || contact.created_at)}</td></tr>`)}
    </tbody></table></div>` : html`<div class="empty">${search ? 'No contacts match.' : 'No contacts yet.'}</div>`}`);
  $('#contact-search').onsubmit = event => { event.preventDefault(); ctx.navigate('/meet?tab=contacts&q=' + encodeURIComponent($('#cq').value), { replace: true }); };
  $('#new-contact').onclick = async () => {
    const result = await ask({ title: 'Add a contact', fields: html`<label for="nc-name">Name</label><input id="nc-name" name="name" maxlength="100"><label for="nc-email">Email</label><input id="nc-email" name="email" type="email" required>`, confirm: 'Add contact' });
    if (!result) return;
    try { const contact = await api('POST', wsPath('/contacts'), result); ctx.navigate('/meet/contacts/' + contact.id); } catch (error) { toast(error.message); }
  };
}

export async function contactPage(ctx) {
  if (!session.user || !workspace()) return ctx.navigate('/account?next=' + encodeURIComponent(ctx.path), { replace: true });
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let contact, members;
  try { [contact, members] = await Promise.all([api('GET', wsPath('/contacts/' + ctx.params[0])), api('GET', wsPath('/members'))]); }
  catch (error) { return mount(ctx.main, html`<div class="container page">${errorBlock(error)}<a href="/meet?tab=contacts">Back to contacts</a></div>`); }
  if (!ctx.alive()) return;
  setTitle(`${contact.name || contact.email} · Meet by Schedora`);
  mount(ctx.main, html`<div class="container page"><a href="/meet?tab=contacts">← Contacts</a>
    <div class="row-between"><div><h1>${contact.name || contact.email}</h1><p class="muted">${contact.email}${contact.phone ? ' · ' + contact.phone : ''}</p></div>
      <div class="row"><a class="btn btn-primary" href="/meet?tab=meetings#schedule" id="book-contact">Schedule a follow-up</a></div></div>
    <div class="grid-2">
      <form class="card card-plain" id="contact-form" novalidate><h2>Details</h2>
        <label for="c-name">Name</label><input id="c-name" name="name" maxlength="100" value="${contact.name}">
        <label for="c-company">Company</label><input id="c-company" name="company" maxlength="150" value="${contact.company}">
        <label for="c-phone">Phone</label><input id="c-phone" name="phone" type="tel" maxlength="30" value="${contact.phone || ''}">
        <label for="c-owner">Owner</label><span class="hint">Round-robin events send this contact to their owner when the owner is free.</span>
        <select id="c-owner" name="owner_id"><option value="">No owner</option>${members.map(member => html`<option value="${member.id}" ${member.id === contact.owner_id ? raw('selected') : ''}>${member.name}</option>`)}</select>
        <label for="c-tags">Tags (comma separated)</label><input id="c-tags" name="tags" value="${contact.tags.join(', ')}">
        <label for="c-custom">Custom fields (one "key: value" per line)</label><textarea id="c-custom" name="custom">${Object.entries(contact.custom).map(([key, value]) => `${key}: ${value}`).join('\n')}</textarea>
        <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn" type="submit">Save</button>${isAdmin() ? html`<button class="btn btn-danger" type="button" id="delete-contact">Delete contact</button>` : ''}</div></form>
      <div class="stack">
        <section class="card card-plain"><h2>Notes</h2><form id="note-form" novalidate><label for="note" class="visually-hidden">New note</label><textarea id="note" name="body" required maxlength="5000" placeholder="Add a private note"></textarea><div class="actions"><button class="btn btn-small" type="submit">Add note</button></div></form>
          ${contact.notes.length ? html`<ul class="plain-list">${contact.notes.map(note => html`<li><p>${note.body}</p><p class="muted">${note.author_name || 'Someone'} · ${fmtDateTime(note.created_at)}</p></li>`)}</ul>` : ''}</section>
        <section class="card card-plain"><h2>Follow-ups</h2><form id="follow-form" class="row" novalidate><label for="fu-title" class="visually-hidden">Follow-up</label><input id="fu-title" name="title" required maxlength="200" placeholder="Send proposal"><label for="fu-due" class="visually-hidden">Due</label><input id="fu-due" name="due" type="datetime-local"><button class="btn btn-small" type="submit">Add</button></form>
          ${contact.tasks.length ? html`<ul class="plain-list">${contact.tasks.map(task => html`<li>${badge(task.status)} ${task.title}${task.due_at ? html` <span class="muted">due ${fmtDateTime(task.due_at)}</span>` : ''}</li>`)}</ul>` : ''}</section>
      </div></div>
    <section class="card card-plain section-gap"><h2>History</h2>
      ${contact.meetings.length || contact.responses.length ? html`<ul class="plain-list">${[
        ...contact.meetings.map(meeting => ({ at: meeting.starts_at, node: html`<li>${badge(meeting.status)} <strong>${meeting.event_title}</strong> with ${meeting.host_name} · ${fmtDateTime(meeting.starts_at)} · Ref ${meeting.reference}</li>` })),
        ...contact.responses.map(response => ({ at: response.created_at, node: html`<li>${badge('neutral', 'Form')} <a href="/forms/${response.form_id}/responses">${response.form_title}</a> · ${fmtDateTime(response.created_at)}</li>` }))
      ].sort((a, b) => b.at - a.at).map(item => item.node)}</ul>` : html`<p class="muted">No meetings or responses yet.</p>`}</section></div>`);
  $('#book-contact').onclick = event => {
    event.preventDefault();
    try { sessionStorage.setItem('schedora.bookFor', JSON.stringify({ name: contact.name, email: contact.email })); } catch { /* storage blocked: the form opens empty */ }
    ctx.navigate('/meet?tab=meetings');
  };
  handleSubmit($('#contact-form'), async data => {
    const custom = Object.fromEntries(String(data.custom || '').split('\n').map(line => line.split(':')).filter(parts => parts.length >= 2 && parts[0].trim()).map(([key, ...rest]) => [key.trim(), rest.join(':').trim()]));
    await api('PATCH', wsPath('/contacts/' + contact.id), { name: data.name, company: data.company, phone: data.phone, owner_id: data.owner_id || null, tags: String(data.tags || '').split(',').map(tag => tag.trim()).filter(Boolean), custom });
    toast('Contact saved.');
  });
  handleSubmit($('#note-form'), async data => { await api('POST', wsPath(`/contacts/${contact.id}/notes`), data); ctx.render(); });
  handleSubmit($('#follow-form'), async data => { await api('POST', wsPath(`/contacts/${contact.id}/follow-ups`), { title: data.title, due_at: data.due ? new Date(data.due).toISOString() : null }); ctx.render(); });
  $('#delete-contact')?.addEventListener('click', async () => {
    if (!(await ask({ title: 'Delete this contact?', body: 'Meetings and responses are kept but no longer linked.', confirm: 'Delete', danger: true }))) return;
    await api('DELETE', wsPath('/contacts/' + contact.id));
    ctx.navigate('/meet?tab=contacts', { replace: true });
  });
}

// ---------------------------------------------------------------------------------------------
// Workflows

const TRIGGER_LABELS = { booked: 'When a meeting is booked', before_start: 'Before the meeting', after_end: 'After the meeting', canceled: 'When canceled', rescheduled: 'When rescheduled' };

export async function workflowsTab(ctx, panel) {
  const [workflows, types, options] = await Promise.all([api('GET', wsPath('/workflows')), api('GET', wsPath('/event-types')), api('GET', wsPath('/meet/options'))]);
  if (!ctx.alive()) return;
  const admin = isAdmin();
  mount(panel, html`<div class="row-between"><p class="muted">Automatic emails and text messages around each meeting: reminders, follow-ups, thank-you notes.</p><button class="btn btn-primary" id="new-workflow">New workflow</button></div>
    <div id="workflow-form"></div>
    ${workflows.length ? html`<ul class="list section-gap">${workflows.map(workflow => html`<li class="row-between"><div><div class="list-title">${workflow.name}</div>
      <div class="meta"><span>${TRIGGER_LABELS[workflow.trigger_type]}${workflow.offset_min ? ` (${workflow.offset_min >= 60 ? workflow.offset_min / 60 + ' h' : workflow.offset_min + ' min'})` : ''}</span><span>${workflow.channel === 'sms' ? 'Text message' : 'Email'} to ${workflow.recipient}</span>
        <span>${workflow.event_title || 'All event types'}</span>${workflow.condition ? html`<span>Only if ${workflow.condition.question} ${workflow.condition.op.replace('_', ' ')} ${workflow.condition.value ?? ''}</span>` : ''}</div></div>
      <div class="row">${badge(workflow.active ? 'active' : 'paused', workflow.active ? 'On' : 'Off')}<button class="btn btn-small" data-toggle="${workflow.id}" data-active="${workflow.active}">${workflow.active ? 'Turn off' : 'Turn on'}</button><button class="btn btn-small btn-danger" data-delete="${workflow.id}">Delete</button></div></li>`)}</ul>`
      : html`<div class="empty section-gap">No workflows yet. A good first one: a text reminder an hour before each meeting.</div>`}`);
  $$('[data-toggle]', panel).forEach(button => button.onclick = async () => { try { await api('PATCH', wsPath('/workflows/' + button.dataset.toggle), { active: button.dataset.active !== 'true' }); ctx.render(); } catch (error) { toast(error.message); } });
  $$('[data-delete]', panel).forEach(button => button.onclick = async () => { if (await ask({ title: 'Delete this workflow?', body: 'Messages already scheduled still send.', confirm: 'Delete', danger: true })) { try { await api('DELETE', wsPath('/workflows/' + button.dataset.delete)); ctx.render(); } catch (error) { toast(error.message); } } });
  $('#new-workflow').onclick = () => {
    mount($('#workflow-form'), html`<form class="card card-plain section-gap" id="wf" novalidate><h2>New workflow</h2>
      <label for="wf-name">Name</label><input id="wf-name" name="name" required maxlength="120" placeholder="Text reminder">
      <div class="inline-fields">
        <div><label for="wf-event">Event type</label><select id="wf-event" name="event_type_id">${admin ? html`<option value="">All event types</option>` : ''}${types.filter(type => !type.managed_template).map(type => html`<option value="${type.id}">${type.title}</option>`)}</select></div>
        <div><label for="wf-trigger">When</label><select id="wf-trigger" name="trigger_type">${Object.entries(TRIGGER_LABELS).map(([key, label]) => html`<option value="${key}">${label}</option>`)}</select></div>
        <div><label for="wf-offset">Minutes before/after</label><input id="wf-offset" name="offset_min" type="number" min="0" max="43200" value="60"></div>
        <div><label for="wf-channel">Send</label><select id="wf-channel" name="channel"><option value="email">Email</option><option value="sms">Text message (SMS)</option></select></div>
        <div><label for="wf-to">To</label><select id="wf-to" name="recipient"><option value="invitee">Invitee</option><option value="host">Host(s)</option></select></div>
      </div>
      <label for="wf-subject">Email subject</label><input id="wf-subject" name="subject" maxlength="200" value="Reminder: {{event.title}}">
      <label for="wf-body">Message</label><textarea id="wf-body" name="body" required maxlength="5000">Hi {{invitee.name}}, see you {{booking.start}}. Join or change: {{manage_url}}</textarea>
      <p class="hint">Placeholders: ${options.placeholders.map(item => html`<code>{{${item}}}</code> `)} and <code>{{answer.question_key}}</code>. Text messages go to the phone number the invitee gives.</p>
      <details><summary>Only send when an answer matches (optional)</summary><div class="inline-fields"><div><label for="wf-q">Question key</label><input id="wf-q" name="cq" placeholder="budget"></div>
        <div><label for="wf-op">Rule</label><select id="wf-op" name="cop"><option value="equals">is</option><option value="not_equals">is not</option><option value="contains">includes</option><option value="answered">is answered</option></select></div>
        <div><label for="wf-v">Value (option key)</label><input id="wf-v" name="cv"></div></div></details>
      <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn btn-primary" type="submit">Create workflow</button></div></form>`);
    handleSubmit($('#wf'), async data => {
      await api('POST', wsPath('/workflows'), {
        name: data.name, event_type_id: data.event_type_id || null, trigger_type: data.trigger_type, offset_min: data.offset_min ?? 0, channel: data.channel, recipient: data.recipient,
        subject: data.channel === 'sms' ? '' : data.subject, body: data.body, condition: data.cq ? { question: data.cq, op: data.cop, value: data.cv || undefined } : null
      });
      toast('Workflow created. It applies to meetings booked from now on.');
      ctx.render();
    });
  };
}

// ---------------------------------------------------------------------------------------------
// Analytics: single-series charts in the accent color; heatmap is one hue, light to dark.

export async function analyticsTab(ctx, panel) {
  const zone = browserZone();
  // Default: the last 30 days and the next 30, so upcoming bookings show too.
  const to = ctx.query.get('to') || dateKey(Date.now() + 30 * 86400000, zone);
  const from = ctx.query.get('from') || dateKey(Date.now() - 30 * 86400000, zone);
  const data = await api('GET', wsPath(`/analytics?from=${from}&to=${to}&tz=${encodeURIComponent(zone)}`));
  if (!ctx.alive()) return;
  const { totals } = data;
  // One column per day in the range (empty days included) so the time axis is even.
  const counts = Object.fromEntries(data.daily.map(day => [day.date, day.count]));
  const allDays = [];
  for (let day = new Date(from + 'T00:00:00Z'); day <= new Date(to + 'T00:00:00Z') && allDays.length < 400; day = new Date(day.getTime() + 86400000)) {
    const key = day.toISOString().slice(0, 10);
    allDays.push({ date: key, count: counts[key] || 0 });
  }
  const maxDaily = Math.max(1, ...data.daily.map(day => day.count));
  const maxType = Math.max(1, ...data.by_event_type.map(row => row.booked));
  const maxHost = Math.max(1, ...data.by_host.map(row => row.booked));
  const maxCell = Math.max(1, ...data.heatmap.flat());
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const hours = [...Array(24).keys()];
  const bars = (rows, max, caption) => rows.length ? html`<ul class="hbars" aria-label="${caption}">${rows.slice(0, 10).map(row => html`<li><span class="hbar-label">${row.label}</span>
    <span class="hbar-track"><span class="hbar" data-width="${Math.round(row.booked / max * 100)}" title="${row.label}: ${row.booked} booked, ${row.canceled} canceled"></span></span><span class="hbar-value">${row.booked}${row.canceled ? html` <span class="muted">(${row.canceled} canceled)</span>` : ''}</span></li>`)}</ul>` : html`<p class="muted">No data.</p>`;
  mount(panel, html`<form class="row" id="range"><label for="a-from">From</label><input id="a-from" name="from" type="date" value="${from}"><label for="a-to">To</label><input id="a-to" name="to" type="date" value="${to}"><button class="btn btn-small" type="submit">Update</button><span class="muted">Times in ${zone.replace(/_/g, ' ')}</span></form>
    <div class="stat-grid section-gap">${[['Scheduled', totals.scheduled], ['Confirmed', totals.confirmed], ['Canceled', totals.canceled], ['Cancellation rate', totals.cancellation_rate + '%'], ['Median lead time', totals.median_lead_hours == null ? '—' : totals.median_lead_hours >= 48 ? Math.round(totals.median_lead_hours / 24) + ' days' : totals.median_lead_hours + ' h'], ['Rescheduled', totals.rescheduled]]
      .map(([label, value]) => html`<div class="stat"><span class="stat-value">${value}</span><span class="stat-label">${label}</span></div>`)}</div>
    ${data.revenue.length ? html`<p>Revenue from paid bookings: ${data.revenue.map(item => new Intl.NumberFormat(undefined, { style: 'currency', currency: item.currency.toUpperCase() }).format(item.cents / 100)).join(', ')}</p>` : ''}
    <section class="card card-plain section-gap"><h2>Meetings per day</h2>
      ${data.daily.length ? html`<div class="columns" role="img" aria-label="Confirmed meetings per day from ${from} to ${to}, highest ${maxDaily}">${allDays.map(day => html`<span class="column" data-height="${Math.round(day.count / maxDaily * 100)}" title="${day.date}: ${day.count}"></span>`)}</div>
        <div class="row-between muted axis"><span>${from}</span><span>${to}</span></div>` : html`<p class="muted">No confirmed meetings in this range.</p>`}</section>
    <div class="grid-2 section-gap"><section class="card card-plain"><h2>By event type</h2>${bars(data.by_event_type, maxType, 'Meetings by event type')}</section>
      <section class="card card-plain"><h2>By host</h2>${bars(data.by_host, maxHost, 'Meetings by host')}</section></div>
    <section class="card card-plain section-gap"><h2>Busiest times</h2>
      <div class="heatmap" role="img" aria-label="Meetings by weekday and hour; the darkest cell has ${maxCell}"><span></span>${hours.map(hour => html`<span class="heat-hour">${hour % 3 === 0 ? hour : ''}</span>`)}
        ${days.map((day, index) => html`<span class="heat-day">${day}</span>${hours.map(hour => html`<span class="heat-cell" data-level="${data.heatmap[index][hour] / maxCell}" title="${day} ${String(hour).padStart(2, '0')}:00 — ${data.heatmap[index][hour]}"></span>`)}`)}</div>
      <details><summary>Show as a table</summary><div class="table-wrap"><table><thead><tr><th>Day</th>${hours.map(hour => html`<th>${hour}</th>`)}</tr></thead><tbody>${days.map((day, index) => html`<tr><th scope="row">${day}</th>${hours.map(hour => html`<td>${data.heatmap[index][hour] || ''}</td>`)}</tr>`)}</tbody></table></div></details></section>`);
  $$('[data-width]', panel).forEach(bar => { bar.style.width = Math.max(1, bar.dataset.width) + '%'; });
  $$('[data-height]', panel).forEach(column => { column.style.height = Number(column.dataset.height) ? column.dataset.height + '%' : '0'; });
  $$('[data-level]', panel).forEach(cell => { const level = Number(cell.dataset.level); if (level > 0) cell.style.background = `color-mix(in oklab, var(--accent) ${Math.round(15 + level * 85)}%, var(--surface))`; });
  $('#range').onsubmit = event => { event.preventDefault(); ctx.navigate(`/meet?tab=analytics&from=${$('#a-from').value}&to=${$('#a-to').value}`, { replace: true }); };
}

// ---------------------------------------------------------------------------------------------
// Calendars, video apps, payments and personal working hours

const PROVIDERS = [['google', 'Google Calendar and Meet', 'Busy times, events added to your calendar, Google Meet links.'], ['microsoft', 'Microsoft 365 / Outlook', 'Busy times, events in Outlook, Teams links.'], ['zoom', 'Zoom', 'A unique Zoom link for each meeting.']];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function integrationsTab(ctx, panel) {
  const [calendar, integrations, schedule] = await Promise.all([api('GET', wsPath('/calendar')), api('GET', wsPath('/integrations')), api('GET', wsPath('/schedule'))]);
  if (!ctx.alive()) return;
  const connected = provider => integrations.find(item => item.provider === provider && item.user_id === session.user.id);
  const stripe = integrations.find(item => item.provider === 'stripe' && !item.user_id);
  const error = ctx.query.get('error');
  const statusNote = connection => ({
    active: badge('active', `Connected · ${connection.busy_count} busy periods`), revoked: badge('canceled', 'Access revoked: reconnect'), error: badge('pending', 'Last check failed'), pending: badge('pending', 'Checking')
  })[connection.status];
  mount(panel, html`${ctx.query.get('connected') ? notice('ok', html`<p>Connected. Busy times and new meetings will sync within a minute.</p>`) : ''}${error ? notice('bad', html`<p>${error}</p>`) : ''}
    <section class="card card-plain"><h2>Calendar and video apps</h2><ul class="list">${PROVIDERS.map(([key, label, help]) => {
      const integration = connected(key);
      return html`<li class="row-between"><div><div class="list-title">${label}</div><div class="meta"><span>${help}</span>${integration ? html`<span>${integration.account}</span>` : ''}</div>${integration?.last_error ? html`<p class="muted">${integration.last_error}</p>` : ''}</div>
        <div class="row">${integration ? html`${badge(integration.status)}<button class="btn btn-small" data-disconnect="${key}">Disconnect</button>` : boot.integrations?.[key] ? html`<button class="btn btn-small btn-primary" data-connect="${key}">Connect</button>` : html`<span class="muted">Not available on this server yet</span>`}</div></li>`;
    })}</ul></section>
    <section class="card card-plain section-gap"><h2>Calendars checked for conflicts</h2>
      ${calendar.connections.length ? html`<ul class="list">${calendar.connections.map(connection => html`<li class="row-between"><div><div class="list-title">${connection.label || connection.provider}</div><div class="meta"><span>${connection.provider === 'ics' ? 'Calendar address (ICS)' : connection.provider}</span>${connection.last_synced_at ? html`<span>Checked ${fmtDateTime(connection.last_synced_at)}</span>` : ''}</div>${connection.last_error && connection.status !== 'active' ? html`<p class="muted">${connection.last_error}</p>` : ''}</div>
        <div class="row">${statusNote(connection)}${connection.provider === 'ics' ? html`<button class="btn btn-small btn-danger" data-remove-calendar="${connection.id}">Remove</button>` : ''}</div></li>`)}</ul>
        <div class="actions"><button class="btn btn-small" id="sync-now">Check now</button></div>` : html`<p class="muted">No calendars connected. Connect an app above, or add a calendar address below.</p>`}
      <details class="section-gap"><summary>Add a calendar by its private address (ICS)</summary>
        <ul><li>Google Calendar: Settings → your calendar → <em>Secret address in iCal format</em>.</li><li>Outlook: Settings → Calendar → Shared calendars → <em>Publish a calendar</em> → ICS link.</li><li>Apple iCloud: Calendar → share → <em>Public Calendar</em> link.</li></ul>
        <form id="calendar-form" novalidate><label for="feed_url">Private calendar address</label><input id="feed_url" name="feed_url" type="url" required placeholder="https://… or webcal://…" autocomplete="off">
          <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn" type="submit">Add calendar</button></div></form></details>
    </section>
    <section class="card card-plain section-gap"><h2>My working hours</h2><p class="hint">Used by team event types that are set to follow each host's working hours.</p>
      <form id="hours-form" novalidate><label for="h-zone">Time zone</label><select id="h-zone" name="timezone">${zoneOptions(schedule?.timezone || browserZone())}</select><div id="hours"></div>
        <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn" type="submit">Save working hours</button></div></form></section>
    ${isAdmin() ? html`<section class="card card-plain section-gap"><h2>Payments (Stripe)</h2>
      ${stripe ? html`<p>${badge('active', `Connected (${stripe.account} mode)`)}</p><button class="btn btn-small btn-danger" id="stripe-disconnect">Disconnect Stripe</button>`
        : html`<p class="hint">Invitees pay through your own Stripe account. Create a restricted key with Checkout Sessions write access and a webhook for <code>checkout.session.completed</code>.</p>
        <form id="stripe-form" novalidate><label for="sk">Restricted or secret key</label><input id="sk" name="secret_key" required autocomplete="off" placeholder="rk_live_…">
          <label for="whsec">Webhook signing secret</label><input id="whsec" name="webhook_secret" required autocomplete="off" placeholder="whsec_…">
          <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn" type="submit">Connect Stripe</button></div></form>`}
      ${!stripe && boot.integrations?.testPayments ? html`<p class="muted">Until Stripe is connected, paid event types use a test checkout (no money moves).</p>` : ''}</section>` : ''}`);

  $$('[data-connect]', panel).forEach(button => button.onclick = async () => { try { location.href = (await api('GET', wsPath(`/integrations/${button.dataset.connect}/start`))).url; } catch (failure) { toast(failure.message); } });
  $$('[data-disconnect]', panel).forEach(button => button.onclick = async () => { if (await ask({ title: 'Disconnect?', body: 'Busy times and calendar events from this app stop syncing.', confirm: 'Disconnect', danger: true })) { await api('DELETE', wsPath('/integrations/' + button.dataset.disconnect)); ctx.render(); } });
  $$('[data-remove-calendar]', panel).forEach(button => button.onclick = async () => { await api('DELETE', wsPath('/calendar/' + button.dataset.removeCalendar)); ctx.render(); });
  $('#sync-now')?.addEventListener('click', async () => { try { await api('POST', wsPath('/calendar/sync')); ctx.render(); } catch (failure) { toast(failure.message); } });
  handleSubmit($('#calendar-form'), async data => { const result = await api('POST', wsPath('/calendar'), data); toast(result.connection.status === 'active' ? 'Calendar added.' : 'Calendar saved, but the first check failed.'); ctx.render(); });

  const rules = (schedule?.rules || [1, 2, 3, 4, 5].map(weekday => ({ weekday, start_min: 540, end_min: 1020 }))).map(rule => ({ ...rule }));
  const drawHours = () => mount($('#hours'), html`${[1, 2, 3, 4, 5, 6, 0].map(day => {
    const rule = rules.find(item => item.weekday === day);
    return html`<div class="range"><label class="check day-label"><input type="checkbox" data-hday="${day}" ${rule ? raw('checked') : ''}> ${WEEKDAYS[day]}</label>
      ${rule ? html`<input type="time" aria-label="${WEEKDAYS[day]} start" data-hstart="${day}" value="${minutesToTime(rule.start_min)}"><span aria-hidden="true">–</span><input type="time" aria-label="${WEEKDAYS[day]} end" data-hend="${day}" value="${minutesToTime(rule.end_min)}">` : html`<span class="muted">Off</span>`}</div>`;
  })}`);
  drawHours();
  $('#hours').addEventListener('change', event => {
    const { hday, hstart, hend } = event.target.dataset;
    if (hday !== undefined) { if (event.target.checked) rules.push({ weekday: Number(hday), start_min: 540, end_min: 1020 }); else rules.splice(rules.findIndex(rule => rule.weekday === Number(hday)), 1); drawHours(); }
    if (hstart !== undefined) rules.find(rule => rule.weekday === Number(hstart)).start_min = timeToMinutes(event.target.value, false);
    if (hend !== undefined) rules.find(rule => rule.weekday === Number(hend)).end_min = timeToMinutes(event.target.value, true);
  });
  handleSubmit($('#hours-form'), async data => { await api('PUT', wsPath('/schedule'), { timezone: data.timezone, rules, overrides: schedule?.overrides || [] }); toast('Working hours saved.'); });
  if ($('#stripe-form')) handleSubmit($('#stripe-form'), async data => {
    const result = await api('POST', wsPath('/integrations/stripe'), data);
    await ask({ title: 'Stripe connected', body: 'Add this webhook endpoint in Stripe (Developers → Webhooks) for checkout.session.completed:', fields: html`<input readonly value="${result.webhook_url}" aria-label="Webhook URL">`, confirm: 'Done' });
    ctx.render();
  });
  $('#stripe-disconnect')?.addEventListener('click', async () => { if (await ask({ title: 'Disconnect Stripe?', body: 'Paid event types will stop accepting bookings.', confirm: 'Disconnect', danger: true })) { await api('DELETE', wsPath('/integrations/stripe')); ctx.render(); } });
}

// ---------------------------------------------------------------------------------------------
// Notes & AI: transcripts, recaps, sharing and chat

export async function insightsTab(ctx, panel) {
  const search = ctx.query.get('q') || '';
  const transcripts = await api('GET', wsPath('/transcripts' + (search ? '?q=' + encodeURIComponent(search) : '')));
  if (!ctx.alive()) return;
  const ai = boot.integrations?.ai;
  mount(panel, html`${ai ? '' : notice('info', html`<p>AI recaps, briefs and chat need an Anthropic API key on the server (ANTHROPIC_API_KEY). Transcripts can be stored and searched without it.</p>`)}
    ${ai ? html`<section class="card card-plain"><h2>Ask about your meetings</h2><div id="chat-log" class="chat-log" aria-live="polite"></div>
      <form id="chat-form" class="row" novalidate><label for="chat-input" class="visually-hidden">Question</label><input id="chat-input" name="q" required maxlength="2000" placeholder="Who am I meeting tomorrow, and what did they tell us?"><button class="btn btn-primary" type="submit">Ask</button></form>
      <p class="hint">The assistant reads your meetings, availability, contacts and transcripts. It cannot book or cancel.</p></section>` : ''}
    <section class="card card-plain section-gap"><div class="row-between"><h2>Meeting transcripts</h2><button class="btn" id="add-transcript">Add transcript</button></div>
      <form class="row" id="t-search" role="search"><label for="tq" class="visually-hidden">Search transcripts</label><input id="tq" value="${search}" placeholder="Search transcripts"><button class="btn btn-small" type="submit">Search</button></form>
      <div id="transcript-form"></div>
      ${transcripts.length ? html`<ul class="list section-gap">${transcripts.map(item => html`<li><div class="row-between"><div><div class="list-title">${item.title}</div><div class="meta"><span>${fmtDateTime(item.created_at)}</span><span>${item.source}</span><span>${item.recap_count} recap(s)</span></div><p class="muted">${item.snippet}…</p></div>
        <div class="row"><button class="btn btn-small" data-view="${item.id}">Open</button></div></div><div id="t-${item.id}"></div></li>`)}</ul>` : html`<div class="empty section-gap">${search ? 'No transcripts match.' : 'No transcripts yet. Paste one from your call recorder, or upload a .vtt, .srt or .txt file.'}</div>`}
      <p class="hint">Call-recording services can send transcripts automatically to <code>POST /api/workspaces/${workspace().id}/notetaker/transcripts</code> with an API key.</p></section>`);

  $('#t-search').onsubmit = event => { event.preventDefault(); ctx.navigate('/meet?tab=insights&q=' + encodeURIComponent($('#tq').value), { replace: true }); };
  $('#add-transcript').onclick = () => {
    mount($('#transcript-form'), html`<form class="section-gap" id="tf" novalidate><label for="tf-title">Title</label><input id="tf-title" name="title" required maxlength="200" placeholder="Kickoff with Acme">
      <label for="tf-ref">Booking reference (optional)</label><input id="tf-ref" name="booking_reference" placeholder="SCH-ABC123">
      <label for="tf-file">Upload a file</label><input id="tf-file" type="file" accept=".txt,.vtt,.srt,text/plain,text/vtt">
      <label for="tf-content">Or paste the transcript</label><textarea id="tf-content" name="content" required rows="8"></textarea>
      <div data-form-status tabindex="-1"></div><div class="actions"><button class="btn btn-primary" type="submit">Save transcript</button></div></form>`);
    $('#tf-file').onchange = async () => { const file = $('#tf-file').files[0]; if (file) { $('#tf-content').value = await file.text(); if (!$('#tf-title').value) $('#tf-title').value = file.name.replace(/\.[^.]+$/, ''); } };
    handleSubmit($('#tf'), async data => { await api('POST', wsPath('/transcripts'), { title: data.title, content: data.content, booking_reference: data.booking_reference || undefined }); ctx.render(); });
  };
  $$('[data-view]', panel).forEach(button => button.onclick = () => openTranscript(ctx, button.dataset.view));

  if (!ai) return;
  const history = [];
  const log = $('#chat-log');
  const draw = () => mount(log, html`${history.map(message => html`<div class="chat-message ${message.role}"><strong>${message.role === 'user' ? 'You' : 'Assistant'}</strong><p>${message.content}</p></div>`)}`);
  handleSubmit($('#chat-form'), async data => {
    history.push({ role: 'user', content: data.q });
    draw();
    $('#chat-input').value = '';
    log.insertAdjacentHTML('beforeend', '<div class="loading" role="status">Thinking…</div>');
    try {
      const answer = await api('POST', wsPath('/ai/chat'), { messages: history.slice(-20) });
      history.push({ role: 'assistant', content: answer.reply });
    } catch (failure) { history.pop(); draw(); throw failure; }
    draw();
  });
}

async function openTranscript(ctx, id) {
  const target = $('#t-' + id);
  mount(target, loading());
  const transcript = await api('GET', wsPath('/transcripts/' + id));
  const recap = transcript.recaps[0];
  mount(target, html`<div class="recap">
    ${recap ? html`<h3>Recap</h3><p>${recap.summary}</p>
      ${recap.decisions.length ? html`<h4>Decisions</h4><ul>${recap.decisions.map(item => html`<li>${item}</li>`)}</ul>` : ''}
      ${recap.action_items.length ? html`<h4>Action items</h4><ul>${recap.action_items.map(item => html`<li>${item.task} <span class="muted">· ${item.owner} · ${item.due}</span></li>`)}</ul>` : ''}
      ${recap.follow_up.subject ? html`<details><summary>Draft follow-up email</summary><p><strong>${recap.follow_up.subject}</strong></p><pre class="preview">${recap.follow_up.body}</pre><button class="btn btn-small" data-copy-email>Copy email</button></details>` : ''}
      <div class="actions"><button class="btn btn-small" data-share="${recap.id}">${recap.shared ? 'Create a new share link' : 'Share recap'}</button>${recap.shared ? html`<button class="btn btn-small" data-unshare="${recap.id}">Stop sharing</button>` : ''}</div>` : ''}
    <div class="actions">${boot.integrations?.ai ? html`<button class="btn btn-small btn-primary" data-recap>${recap ? 'Regenerate recap' : 'Generate recap'}</button>` : ''}
      <a class="btn btn-small" href="${wsPath(`/transcripts/${id}/download`)}" download>Download transcript</a><button class="btn btn-small btn-danger" data-delete-t>Delete</button></div>
    <details><summary>Full transcript</summary><pre class="preview">${transcript.content}</pre></details></div>`);
  target.querySelector('[data-copy-email]')?.addEventListener('click', () => copy(`${recap.follow_up.subject}\n\n${recap.follow_up.body}`, 'Email'));
  target.querySelector('[data-recap]')?.addEventListener('click', async event => {
    event.target.setAttribute('aria-disabled', 'true');
    event.target.textContent = 'Writing recap…';
    try { await api('POST', wsPath(`/transcripts/${id}/recap`)); openTranscript(ctx, id); } catch (failure) { toast(failure.message); event.target.removeAttribute('aria-disabled'); event.target.textContent = 'Generate recap'; }
  });
  target.querySelector('[data-share]')?.addEventListener('click', async () => {
    const result = await ask({ title: 'Share this recap', body: 'Anyone with the link can read the recap (not the full transcript).', fields: html`<label for="passcode">Passcode (optional, 4+ characters)</label><input id="passcode" name="passcode" minlength="4" maxlength="64" autocomplete="off">`, confirm: 'Create link' });
    if (!result) return;
    const shared = await api('POST', wsPath(`/recaps/${recap.id}/share`), { passcode: result.passcode || undefined });
    await copy(shared.url, 'Share link');
    openTranscript(ctx, id);
  });
  target.querySelector('[data-unshare]')?.addEventListener('click', async () => { await api('DELETE', wsPath(`/recaps/${recap.id}/share`)); openTranscript(ctx, id); });
  target.querySelector('[data-delete-t]')?.addEventListener('click', async () => { if (await ask({ title: 'Delete transcript and recaps?', confirm: 'Delete', danger: true })) { await api('DELETE', wsPath('/transcripts/' + id)); ctx.render(); } });
}

export async function publicRecap(ctx, passcode) {
  setTitle('Meeting recap · Meet by Schedora');
  mount(ctx.main, html`<div class="container page narrow">${loading()}</div>`);
  try {
    const recap = await api('GET', `/api/public/recaps/${ctx.params[0]}`, undefined, passcode ? { 'X-Recap-Passcode': passcode } : {});
    mount(ctx.main, html`<div class="container page narrow"><div class="card"><span class="tag">Meeting recap</span><h1>${recap.title}</h1><p>${recap.summary}</p>
      ${recap.decisions.length ? html`<h2>Decisions</h2><ul>${recap.decisions.map(item => html`<li>${item}</li>`)}</ul>` : ''}
      ${recap.action_items.length ? html`<h2>Action items</h2><ul>${recap.action_items.map(item => html`<li>${item.task} <span class="muted">· ${item.owner} · ${item.due}</span></li>`)}</ul>` : ''}
      <p class="muted">Shared from Meet by Schedora · ${fmtDateTime(recap.created_at)}</p></div></div>`);
  } catch (error) {
    if (error.code !== 'passcode_required' && error.status !== 401) return mount(ctx.main, html`<div class="container page narrow"><h1>This recap is not available</h1>${errorBlock(error)}</div>`);
    mount(ctx.main, html`<div class="container page narrow"><form class="card" id="passcode-form" novalidate><h1>Enter the passcode</h1>${passcode ? notice('bad', html`<p>That passcode is not correct.</p>`) : ''}
      <label for="pc">Passcode</label><input id="pc" name="passcode" required autocomplete="off"><div class="actions"><button class="btn btn-primary" type="submit">View recap</button></div></form></div>`);
    $('#passcode-form').onsubmit = event => { event.preventDefault(); publicRecap(ctx, $('#pc').value); };
  }
}
