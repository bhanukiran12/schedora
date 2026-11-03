// Session card, in-room form panel and host session controls for Schedora meeting rooms
// (docs/MEET_SESSION_OFFERS.md). State comes from the server on join and every 10 seconds, so late
// joiners see the current offer and note. The form opens beside the call on the same page, so audio
// and the connection continue; it is submitted through the ordinary Forms path with a session ticket.
import { $, api, ask, html, mount, notice, raw, toast } from './core.mjs';

const POLL_MS = 10000;
const STATE_TEXT = { closed: 'This form is closed.', capacity_reached: 'This form is not accepting responses right now.', not_accepting: 'This form is not accepting responses right now.' };
const STATUS_TEXT = { submitted: 'Submitted', opened: 'Opened, not submitted', prompted: 'Shown the prompt', not_yet: 'Not opened yet' };

export function startSession({ flow, host }) {
  const card = $('#session-card');
  const panel = $('#session-form-panel');
  const hostPanel = $('#session-panel');
  const state = { view: null, disposed: false, timer: null, mounted: null, submitted: new Set(), promptedHere: new Set(), dismissed: new Set(), opened: new Set(), picking: false };

  // Keep the form panel above the controls and the card, whatever their wrapped height.
  const room = $('#video-room');
  const measure = () => { const controls = $('.video-controls'); if (room && controls) room.style.setProperty('--room-bottom', `${controls.offsetHeight + (card.hidden ? 0 : card.offsetHeight)}px`); };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
  resize?.observe($('.video-controls')); resize?.observe(card);

  const mark = (offer, event) => flow.session.mark({ offer_id: offer.id, event }).catch(() => {});

  // ---- Card ----
  function drawCard() {
    const { view } = state;
    const offer = view?.offer;
    const note = view?.note;
    card.hidden = !offer && !note;
    if (card.hidden) { mount(card, ''); measure(); return; }
    const you = offer?.you;
    const done = you?.submitted || state.submitted.has(offer?.id);
    // Shown once per offer: a reconnect reads the server's record and does not prompt again, while
    // the tab that showed it keeps it until the attendee opens the form or chooses Not now.
    const prompt = offer && offer.launched && you && !done && (!you.prompted || state.promptedHere.has(offer.id)) && offer.form.state === 'open' && !state.dismissed.has(offer.id);
    if (prompt && !state.promptedHere.has(offer.id)) { state.promptedHere.add(offer.id); mark(offer, 'prompted'); }
    const reference = you?.reference || state.mounted?.reference;
    const offerLine = !offer ? '' : html`<div class="session-offer">
      <p><span class="session-label">Form</span> <strong>${offer.form.title}</strong>
        ${!offer.launched ? html` <span class="session-state">Not offered to attendees yet</span>` : ''}
        ${done ? html` <span class="session-state session-done">Completed${reference ? html` · Receipt ${reference}` : ''}</span>` : STATE_TEXT[offer.form.state] ? html` <span class="session-state">${STATE_TEXT[offer.form.state]}</span>` : ''}</p>
      ${prompt ? html`<div class="session-prompt" role="group" aria-labelledby="session-prompt-text"><p id="session-prompt-text">The host shared a form for this meeting. It opens beside the call; you stay connected.</p>
        <div class="row"><button class="btn btn-small btn-primary" type="button" data-open-form>Open form</button><button class="btn btn-small" type="button" data-dismiss-prompt>Not now</button></div></div>`
      : (you || host) && (offer.form.state === 'open' || done) && (offer.launched || host) ? html`<button class="btn btn-small" type="button" data-open-form aria-expanded="${String(!panel.hidden)}" aria-controls="session-form-panel">${done ? 'View receipt' : state.mounted?.offerId === offer.id ? 'Continue form' : 'Open form'}<span class="visually-hidden">: ${offer.form.title}</span></button>` : ''}
    </div>`;
    const noteBlock = !note ? '' : html`<div class="session-note"><p><span class="session-label">Pinned by the host</span></p><p class="session-note-body">${note.body}</p>
      ${note.link_url ? html`<p><a href="${note.link_url}" target="_blank" rel="noopener noreferrer" data-external>${note.link_label}<span class="visually-hidden"> (opens in a new tab)</span></a></p>` : ''}</div>`;
    const focusedOpen = document.activeElement?.matches?.('#session-card [data-open-form]');
    mount(card, html`<h2 class="visually-hidden">Session</h2>${noteBlock}${offerLine}`);
    if (focusedOpen) $('[data-open-form]', card)?.focus();
    measure();
  }

  card.addEventListener('click', event => {
    if (event.target.closest('[data-dismiss-prompt]')) {
      state.dismissed.add(state.view.offer.id);
      drawCard();
      return $('[data-open-form]', card)?.focus();
    }
    if (event.target.closest('[data-open-form]')) openForm();
  });

  // ---- Form panel: opened on request, minimised to the card, answers kept on this page ----
  async function openForm() {
    const offer = state.view?.offer;
    if (!offer) return;
    state.dismissed.add(offer.id); // opening answers the prompt
    panel.hidden = false;
    measure();
    if (state.mounted?.offerId !== offer.id) {
      state.mounted = { offerId: offer.id, reference: null };
      mount(panel, html`<div class="row-between session-form-head"><h2 id="session-form-heading" tabindex="-1">${offer.form.title}</h2><button class="btn btn-small" type="button" data-minimise>Minimise</button></div>
        <p class="hint session-form-hint">You are still in the meeting and can hear it while you answer. Minimise to see the video; your answers stay on this page.</p>
        <div id="session-form-changed"></div><div id="session-form-body" class="session-form-body" role="status">Loading form…</div>`);
      if (offer.you && !offer.you.opened && !state.opened.has(offer.id)) { state.opened.add(offer.id); mark(offer, 'opened'); }
      const body = $('#session-form-body');
      let form;
      try { form = await api('GET', `/api/public/forms/${encodeURIComponent(offer.form.slug)}`); }
      catch (error) {
        state.mounted = null;
        return mount(body, notice(error.status === 410 ? 'warn' : 'bad', html`<p>${error.status === 410 ? 'This form is closed. Nothing was submitted.' : error.status ? 'The form could not be loaded. Nothing was submitted.' : 'Schedora could not be reached. Nothing was submitted.'}</p>`));
      }
      if (state.disposed) return;
      body.removeAttribute('role');
      const done = offer.you?.submitted || state.submitted.has(offer.id);
      if (done) mount(body, html`<div class="public-form receipt"><p><strong>You already answered this form.</strong></p>${offer.you?.reference ? html`<dl class="confirm-facts"><dt>Receipt</dt><dd>${offer.you.reference}</dd></dl>` : ''}</div>`);
      else if (!offer.ticket && offer.you) mount(body, notice('warn', html`<p>${STATE_TEXT[offer.form.state] || 'This form cannot be answered from the meeting right now.'} Nothing was submitted.</p>`));
      else {
        const { respondTo } = await import('./forms.mjs');
        respondTo(body, form, {
          storeKey: `session.${offer.id}`, embedVideo: false, pageTitle: false,
          // Hosts who are not admitted attendees answer like any respondent, without a seat link.
          extra: offer.ticket ? { session_ticket: offer.ticket } : {},
          onAccepted: result => {
            state.submitted.add(offer.id);
            if (state.mounted?.offerId === offer.id) state.mounted.reference = result.reference;
            drawCard();
            load();
          }
        });
      }
    }
    drawCard();
    $('#session-form-heading', panel)?.focus();
  }
  function minimise() {
    if (panel.hidden) return;
    panel.hidden = true;
    measure();
    drawCard();
    $('[data-open-form]', card)?.focus();
  }
  panel.addEventListener('click', event => { if (event.target.closest('[data-minimise]')) minimise(); });
  panel.addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); minimise(); } });

  // ---- Host controls ----
  const formPicker = (forms, current) => html`<div class="session-picker">
    ${forms.length ? html`<label for="session-form-choice">Published form</label>
      <select id="session-form-choice">${forms.map(form => html`<option value="${form.id}" ${form.id === current ? raw('selected') : ''}>${form.title}${form.state === 'open' ? '' : ' (not accepting responses)'}</option>`)}</select>
      <fieldset class="session-modes"><legend>When attendees see it</legend>
        <label class="check"><input type="radio" name="session-mode" value="auto" checked> Now, and to everyone who joins later</label>
        <label class="check"><input type="radio" name="session-mode" value="manual"> Later, when I select <em>Offer now</em></label></fieldset>
      <div class="row"><button class="btn btn-small btn-primary" type="button" data-attach>${current ? 'Use this form instead' : 'Attach form'}</button>${current ? html`<button class="btn btn-small" type="button" data-cancel-pick>Cancel</button>` : ''}</div>`
      : html`<p class="hint">No published forms yet. <a href="/forms" target="_blank" rel="noopener" data-external>Open Forms in a new tab<span class="visually-hidden"> (opens in a new tab)</span></a>, publish one, then come back.</p>`}
  </div>`;

  function drawHost({ force = false } = {}) {
    if (!host || !hostPanel) return;
    const { view } = state;
    const offer = view?.offer;
    const note = view?.note;
    const evidence = offer?.evidence;
    const focused = document.activeElement && hostPanel.contains(document.activeElement) ? document.activeElement.id || document.activeElement.dataset?.focusKey : null;
    // Do not redraw over a note being typed.
    const typing = hostPanel.contains(document.activeElement) && document.activeElement.matches('textarea, input[type="url"], input[type="text"]');
    if (typing && !force) return;
    mount(hostPanel, html`<div class="row-between"><h2 id="session-heading">Session</h2><button class="btn btn-small" type="button" data-close-panel>Close</button></div>
      <section class="session-section" aria-labelledby="session-form-title"><h3 id="session-form-title">Form for this meeting</h3>
        ${!offer ? html`<p class="hint">Everyone in the meeting, including people who join later, sees it on a card and can open it beside the call.</p>${formPicker(view?.forms || [], null)}`
        : html`<p><strong>${offer.form.title}</strong><br><span class="hint">${STATE_TEXT[offer.form.state] || (offer.launched ? 'Offered to attendees, including late joiners.' : 'Attached, not offered yet. Attendees cannot see it.')}</span></p>
          <div class="row">${!offer.launched ? html`<button class="btn btn-small btn-primary" type="button" data-launch data-focus-key="launch">Offer now</button>` : ''}
            <button class="btn btn-small" type="button" data-pick data-focus-key="pick">Replace form</button><button class="btn btn-small" type="button" data-remove-offer data-focus-key="remove">Remove</button></div>
          ${state.picking ? formPicker(view.forms || [], offer.form.id) : ''}
          <h4 class="session-subhead">Who has answered <span class="muted">(${evidence.submitted} of ${evidence.attendees.length})</span></h4>
          <p class="hint">Status only. Answers are never shown in the meeting.${evidence.can_read_responses ? '' : ' Your role cannot open responses.'}</p>
          ${evidence.attendees.length ? html`<ul class="list session-evidence">${evidence.attendees.map(row => html`<li><span>${row.name}${row.in_meeting ? '' : html` <span class="muted">(left)</span>`}</span>
            <span class="session-status" data-status="${row.status}">${STATUS_TEXT[row.status]}${row.response_id ? html` · <a href="/forms/${offer.form.id}/responses" target="_blank" rel="noopener" data-external>Responses<span class="visually-hidden"> for ${offer.form.title} (opens in a new tab)</span></a>` : ''}</span></li>`)}</ul>`
          : html`<p class="hint">Nobody has joined yet.</p>`}`}
      </section>
      <section class="session-section" aria-labelledby="session-note-title"><h3 id="session-note-title">Pinned note</h3>
        <p class="hint">Plain text that everyone in the meeting sees, including late joiners.</p>
        <label for="session-note-body">Note</label><textarea id="session-note-body" maxlength="500" rows="3">${note?.body || ''}</textarea>
        <label for="session-note-url">Link <span class="muted">(optional, https only)</span></label><input id="session-note-url" type="url" inputmode="url" value="${note?.link_url || ''}" placeholder="https://">
        <label for="session-note-label">Link text <span class="muted">(optional)</span></label><input id="session-note-label" type="text" maxlength="60" value="${note?.link_label || ''}">
        <div id="session-note-status" role="status"></div>
        <div class="row"><button class="btn btn-small btn-primary" type="button" data-save-note>${note ? 'Replace note' : 'Pin note'}</button>${note ? html`<button class="btn btn-small" type="button" data-remove-note>Remove note</button>` : ''}</div>
      </section>`);
    if (focused) (hostPanel.querySelector('#' + CSS.escape(focused)) || hostPanel.querySelector(`[data-focus-key="${focused}"]`))?.focus();
  }

  async function hostAction(run, done) {
    try { state.view = await run(); state.picking = false; drawCard(); drawHost({ force: true }); if (done) toast(done); }
    catch (error) {
      if (error.code === 'offer_changed') { toast('This form offer changed. The panel has been refreshed.'); return load(); }
      const status = $('#session-note-status');
      const field = error.details?.field;
      if (status && ['body', 'link_url', 'link_label'].includes(field)) { mount(status, notice('bad', html`<p>${error.message}</p>`)); $({ body: '#session-note-body', link_url: '#session-note-url', link_label: '#session-note-label' }[field], hostPanel)?.focus(); }
      else toast(error.message);
    }
  }
  hostPanel?.addEventListener('click', async event => {
    const offer = state.view?.offer;
    if (event.target.closest('[data-pick]')) { state.picking = true; drawHost(); return $('#session-form-choice')?.focus(); }
    if (event.target.closest('[data-cancel-pick]')) { state.picking = false; drawHost(); return $('[data-pick]', hostPanel)?.focus(); }
    if (event.target.closest('[data-attach]')) {
      const formId = $('#session-form-choice').value;
      const mode = $('input[name="session-mode"]:checked', hostPanel).value;
      if (offer && !(await ask({ title: 'Replace the meeting form?', body: 'Attendees see the new form instead. Answers already submitted stay with the earlier form; people still answering it can finish.', confirm: 'Replace' }))) return;
      return hostAction(() => flow.session.offer({ form_id: formId, mode }), mode === 'auto' ? 'Form offered to everyone in the meeting.' : 'Form attached. Select Offer now when you are ready.');
    }
    if (event.target.closest('[data-launch]')) return hostAction(() => flow.session.launch({ offer_id: offer.id }), 'Form offered to everyone in the meeting.');
    if (event.target.closest('[data-remove-offer]')) {
      if (!(await ask({ title: 'Remove the meeting form?', body: 'Attendees and late joiners stop seeing it. Responses already submitted are kept in Forms.', confirm: 'Remove', danger: true }))) return;
      return hostAction(() => flow.session.removeOffer({ offer_id: offer.id }), 'Form removed from the meeting.');
    }
    if (event.target.closest('[data-save-note]')) {
      return hostAction(() => flow.session.note({ body: $('#session-note-body').value, link_url: $('#session-note-url').value.trim() || null, link_label: $('#session-note-label').value }), 'Note pinned for everyone in the meeting.');
    }
    if (event.target.closest('[data-remove-note]')) {
      if (!(await ask({ title: 'Remove the pinned note?', body: 'Everyone in the meeting stops seeing it.', confirm: 'Remove', danger: true }))) return;
      return hostAction(() => flow.session.removeNote(), 'Note removed.');
    }
  });

  // ---- Server state ----
  async function load() {
    if (state.disposed) return;
    try {
      const view = await flow.session.load();
      if (state.disposed) return;
      const previous = state.view?.offer?.id;
      state.view = view;
      if (state.mounted && view.offer?.id !== state.mounted.offerId && !state.submitted.has(state.mounted.offerId)) {
        const changed = $('#session-form-changed');
        if (changed && !changed.childElementCount) mount(changed, notice('warn', html`<p>The host ${view.offer ? 'replaced' : 'removed'} this form. You can still submit what you have written here.</p>`));
      }
      if (view.offer && view.offer.id !== previous && view.offer.launched && !host) { const live = $('#session-live'); if (live) live.textContent = 'The host shared a form for this meeting.'; }
      drawCard();
      if (!hostPanel?.hidden) drawHost();
    } catch (error) {
      // Lost access (removed, link revoked, meeting ended): the room's own checks explain why.
      if (error.status === 404 || error.status === 410) { state.view = null; drawCard(); }
    }
  }
  load().then(drawHost);
  state.timer = setInterval(load, POLL_MS);
  return {
    openHostPanel: drawHost,
    dispose() { state.disposed = true; clearInterval(state.timer); resize?.disconnect(); }
  };
}
