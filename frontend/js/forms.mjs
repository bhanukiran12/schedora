import { $, $$, api, ask, badge, boot, copy, errorBlock, fmtDateTime, html, isAdmin, loading, mount, notice, raw, session, toast, uid, workspace, wsPath } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';
import { FORM_TEMPLATES, questionCount } from './forms-templates.mjs';
import { buildTrail, STATE_LABELS } from './enquiry-trail.mjs';
import { assessFormReadiness } from './forms-readiness.mjs';
import { readinessAreas } from './readiness-view.mjs';

// Linked records for the enquiry trail. Each source loads independently, so a role that cannot see
// one of them still gets the rest, with that part marked unavailable rather than guessed.
export async function loadTrailContext() {
  const [runs, tasks, ...scopes] = await Promise.allSettled([api('GET', wsPath('/runs')), api('GET', wsPath('/tasks')),
    ...['upcoming', 'past', 'canceled'].map(scope => api('GET', wsPath('/bookings?scope=' + scope)))]);
  const bookingsByReference = new Map();
  for (const scope of scopes) if (scope.status === 'fulfilled') for (const booking of scope.value) bookingsByReference.set(booking.reference, booking);
  return {
    runs: runs.value || [], runsAvailable: runs.status === 'fulfilled', tasks: tasks.value || [], tasksAvailable: tasks.status === 'fulfilled',
    bookingsByReference, bookingsAvailable: scopes.every(scope => scope.status === 'fulfilled'), provider: boot.providers?.email, now: Date.now(),
    capped: (runs.value?.length || 0) >= 200 || (tasks.value?.length || 0) >= 200
  };
}

export const trailList = (trail, headingId = 'trail-heading') => html`<section class="trail" aria-labelledby="${headingId}"><h3 id="${headingId}">What happened next</h3>
  <ol class="trail-steps">${trail.steps.map(step => html`<li class="trail-step" data-state="${step.state}"><span class="trail-state">${STATE_LABELS[step.state]}</span><div>
    <strong>${step.title}</strong>${step.reference ? html` <span class="muted">· ${step.key === 'received' ? 'Receipt' : 'Ref'} ${step.reference}</span>` : ''}${step.at ? html` <span class="muted">· ${fmtDateTime(step.at)}</span>` : ''}
    ${step.key === 'run' ? html`<span class="muted"> · from the ${step.source}</span>` : ''}${step.due ? html` <span class="muted">· due ${fmtDateTime(step.due)}</span>` : ''}
    ${step.text ? html`<p>${step.text}</p>` : ''}
    ${step.key === 'run' ? html`<p class="trail-links"><a href="/flow/runs">Run history</a>${step.taskId ? html` · <a href="/flow/tasks">Tasks</a>` : ''}</p>`
      : step.key === 'booking' && step.reference ? html`<p class="trail-links"><a href="/meet?tab=meetings">Meetings</a></p>` : ''}</div></li>`)}</ol>
  ${trail.notes.map(note => html`<p class="hint">${note}</p>`)}</section>`;
import { CONDITION_OPS, FIELD_TYPES, answerText, checkAnswer, definitionProblems, pipe, visibleFields, visiblePages } from '/shared/forms-logic.mjs';

const publicUrl = (form, mode) => `${location.origin}/f/${form.slug}${mode ? '?mode=' + mode : ''}`;
const SUBMIT_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------------------------
// Renderer shared by the builder preview and the public page.

function inputFor(field, value, labelText) {
  const id = `q-${field.id}`;
  const describedBy = field.help ? `${id}-help` : '';
  const common = raw(`id="${id}" name="${field.id}" ${field.required ? 'aria-required="true"' : ''} ${describedBy ? `aria-describedby="${describedBy}"` : ''}`);
  const label = html`<label for="${id}" class="q-label">${labelText}${field.required ? html` <span class="required-mark" aria-hidden="true">*</span><span class="visually-hidden">(required)</span>` : ''}</label>`;
  const help = field.help ? html`<span class="hint" id="${id}-help">${field.help}</span>` : '';
  switch (field.type) {
    case 'long_text': return html`${label}${help}<textarea ${common} maxlength="5000">${value || ''}</textarea>`;
    case 'email': return html`${label}${help}<input ${common} type="email" maxlength="254" autocomplete="email" value="${value || ''}">`;
    case 'date': return html`${label}${help}<input ${common} type="date" value="${value || ''}">`;
    case 'phone': return html`${label}${help}<input ${common} type="tel" maxlength="30" autocomplete="tel" value="${value || ''}">`;
    case 'single_choice':
    case 'multiple_choice': {
      const type = field.type === 'single_choice' ? 'radio' : 'checkbox';
      const selected = Array.isArray(value) ? value : value ? [value] : [];
      return html`<fieldset ${raw(describedBy ? `aria-describedby="${describedBy}"` : '')}><legend class="q-label">${labelText}${field.required ? html` <span class="required-mark" aria-hidden="true">*</span><span class="visually-hidden">(required)</span>` : ''}</legend>${help}
        <div class="choice-list">${field.options.map((option, index) => html`<label class="check"><input type="${type}" name="${field.id}" value="${option.id}" id="${id}-${index}" ${selected.includes(option.id) ? raw('checked') : ''}> ${option.label}</label>`)}</div></fieldset>`;
    }
    default: return html`${label}${help}<input ${common} type="text" maxlength="300" value="${value || ''}">`;
  }
}

function readAnswer(form, field) {
  if (field.type === 'multiple_choice') return $$(`[name="${field.id}"]:checked`, form).map(input => input.value);
  if (field.type === 'single_choice') return $(`[name="${field.id}"]:checked`, form)?.value || '';
  return form.elements[field.id]?.value ?? '';
}

// Renders a form definition. In preview mode nothing is sent anywhere. onSubmit(answers) resolves
// when the caller has shown the outcome; when it throws, describeError(error) returns the message
// to show (field errors from error.details.errors are placed next to their questions instead).
export { inputFor, readAnswer };
export function renderForm(container, definition, { mode = definition.presentation, preview = false, onSubmit, describeError, answers: initial = {}, banner = '' } = {}) {
  const answers = { ...initial };
  let position = 0; // page index (classic) or question index (conversational)
  let errors = {};
  let finished = false;
  let failure = null; // { message, retry } shown after a submission that did not complete
  let message = banner;

  const pagesNow = () => mode === 'conversational' ? visibleFields(definition, answers).map(field => [field]) : visiblePages(definition, answers);
  const signature = () => JSON.stringify(pagesNow().map(page => page.map(item => [item.id, pipe(item.label, definition, answers)])));

  function draw(focusId) {
    if (finished) return;
    const pages = pagesNow();
    position = Math.min(position, pages.length - 1);
    const fields = pages[position] || [];
    const last = position === pages.length - 1;
    const total = pages.length;
    const progress = total > 1 ? Math.round((position / total) * 100) : 0;
    const conversational = mode === 'conversational';
    const pageErrors = fields.filter(field => errors[field.id]);
    mount(container, html`<form class="public-form ${conversational ? 'conversational' : ''}" novalidate>
      ${position === 0 || !conversational ? html`<h1 ${raw(preview ? 'aria-level="2" role="heading"' : '')}>${definition.title}</h1>${definition.description && position === 0 ? html`<p>${definition.description}</p>` : ''}` : ''}
      ${message ? html`<div data-form-banner>${message}</div>` : ''}
      ${total > 1 ? html`<div class="progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style-width="${progress}"></span></div>
        <p class="muted">${conversational ? `Question ${position + 1} of ${total}` : `Page ${position + 1} of ${total}`}</p>` : ''}
      ${pageErrors.length > 1 ? html`<div class="notice notice-bad error-summary" tabindex="-1" data-error-summary><p><strong>Check ${pageErrors.length} answers before continuing:</strong></p>
        <ul>${pageErrors.map(field => html`<li><a href="#q-${field.id}" data-jump="${field.id}">${pipe(field.label, definition, answers) || 'Question'}: ${errors[field.id]}</a></li>`)}</ul></div>` : ''}
      ${!conversational && fields.some(field => field.required) ? html`<p class="muted"><span class="required-mark" aria-hidden="true">*</span> Required</p>` : ''}
      ${fields.length ? fields.map(field => html`<div class="question" data-field="${field.id}">${conversational ? html`<span class="question-number">${position + 1} →</span>` : ''}
        ${inputFor(field, answers[field.id], pipe(field.label, definition, answers))}
        ${errors[field.id] ? html`<div class="field-error" id="q-${field.id}-error">${errors[field.id]}</div>` : ''}</div>`) : html`<p class="muted">This form has no questions yet.</p>`}
      <div data-form-status tabindex="-1">${failure ? notice('bad', failure.message) : ''}</div>
      <div class="actions">
        ${position > 0 ? html`<button type="button" class="btn" data-back>Back</button>` : ''}
        <button type="submit" class="btn btn-primary">${last ? (preview ? 'Submit (preview)' : failure?.retry ? 'Submit again' : definition.submit_label || 'Submit') : conversational ? 'OK' : 'Next'}</button>
        ${conversational && !last ? html`<span class="kbd-hint">or press Enter ↵</span>` : ''}
      </div>
      ${preview ? html`<p class="muted">Preview only. Nothing is saved or sent from here, and it does not count toward your allowance.</p>` : ''}
    </form>`);
    // Width set through the CSSOM: the page's style policy disallows inline style attributes.
    $$('[style-width]', container).forEach(bar => { bar.style.width = bar.getAttribute('style-width') + '%'; bar.removeAttribute('style-width'); });
    const form = $('form', container);
    for (const field of fields) {
      if (errors[field.id]) $$(`[name="${field.id}"]`, form).forEach(input => { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), `q-${field.id}-error`].filter(Boolean).join(' ')); });
    }
    const target = focusId ? form.querySelector(`#${CSS.escape(focusId)}`) : null;
    if (target) target.focus();
    else if (focusId === 'status') $('[data-form-status]', form).focus();
    else if (pageErrors.length > 1) $('[data-error-summary]', form).focus();
    else if (focusId !== null && (conversational || pageErrors.length)) (form.querySelector('[aria-invalid="true"]') || form.querySelector('input, textarea'))?.focus();

    form.addEventListener('click', event => {
      const jump = event.target.closest('[data-jump]');
      if (!jump) return;
      event.preventDefault();
      form.querySelector(`[name="${CSS.escape(jump.dataset.jump)}"]`)?.focus();
    });
    form.addEventListener('change', event => {
      const name = event.target.name;
      const field = definition.fields.find(candidate => candidate.id === name);
      if (!field) return;
      answers[name] = readAnswer(form, field);
      // Re-render when this answer changes which questions are visible or what labels say.
      if (signature() !== form.dataset.signature) { delete errors[name]; draw(event.target.id); }
    });
    form.dataset.signature = signature();
    form.addEventListener('input', event => {
      const field = definition.fields.find(candidate => candidate.id === event.target.name);
      if (field && !field.type.endsWith('choice')) answers[field.id] = event.target.value;
    });
    form.querySelector('[data-back]')?.addEventListener('click', () => { errors = {}; position--; draw(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (form.dataset.busy) return;
      for (const field of fields) answers[field.id] = readAnswer(form, field);
      errors = {};
      for (const field of fields) { const result = checkAnswer(field, answers[field.id]); if (result.error) errors[field.id] = result.error; }
      if (Object.keys(errors).length) return draw();
      if (!last) { position++; return draw(); }
      if (preview) { mount(container, notice('ok', html`<p><strong>Preview complete.</strong> Nothing was saved. In the published form, the response is saved when the server confirms it.</p><button class="btn" type="button" id="restart-preview">Restart preview</button>`)); $('#restart-preview', container).onclick = () => renderForm(container, definition, { mode, preview }); return; }
      form.dataset.busy = '1';
      const button = form.querySelector('[type="submit"]');
      button.setAttribute('aria-disabled', 'true');
      button.textContent = 'Sending…';
      mount($('[data-form-status]', form), html`<p class="muted" role="status">Sending your response…</p>`);
      try {
        await onSubmit({ ...answers });
        finished = true;
      } catch (error) {
        if (error.details?.errors) {
          errors = error.details.errors;
          failure = null;
          const firstPage = pagesNow().findIndex(page => page.some(field => errors[field.id]));
          if (firstPage >= 0) position = firstPage;
          draw();
        } else {
          const described = describeError ? describeError(error) : { message: html`<p>${error.message}</p>` };
          if (described.replaced) return; // the caller rendered something else
          failure = described;
          draw('status');
        }
      }
    });
  }
  draw(null);
  return { setBanner(value) { message = value; draw(); } };
}

// ---------------------------------------------------------------------------------------------
// Public form page

// The submission id is kept for this tab until the server accepts the response, so a retry after
// an unknown outcome (even after a reload) can never create a second response.
const submissionStore = {
  key: slug => `schedora.form.${slug}.submission`,
  get(slug) { try { return sessionStorage.getItem(this.key(slug)); } catch { return null; } },
  set(slug, value) { try { sessionStorage.setItem(this.key(slug), value); } catch { /* storage blocked: identity lasts for this page */ } },
  clear(slug) { try { sessionStorage.removeItem(this.key(slug)); } catch { /* nothing to clear */ } }
};

const unavailablePage = (title, body) => html`<div class="container page"><div class="card public-form-card"><div class="public-form"><h1>${title}</h1>${body}</div></div></div>`;

export async function publicForm(ctx) {
  mount(ctx.main, html`<div class="container page">${loading('Loading form…')}</div>`);
  const slug = ctx.params[0];
  let form;
  try { form = await api('GET', `/api/public/forms/${slug}`); }
  catch (error) {
    if (error.status === 404) return mount(ctx.main, unavailablePage('This form is not available', html`<p>The link may be mistyped, or the form has not been published.</p>`));
    if (error.status === 410) return mount(ctx.main, unavailablePage('This form is closed', html`<p>It is no longer accepting responses. Responses sent before it closed are not affected.</p>`));
    return mount(ctx.main, unavailablePage('We could not load this form', html`${notice('bad', html`<p>${error.status ? 'The form service had a problem.' : 'Schedora could not be reached.'} Nothing has been submitted from this page.</p>`)}<a class="btn" data-external href="${location.pathname + location.search}">Try again</a>`));
  }
  if (!ctx.alive()) return;
  setTitle(form.definition.title + ' · Forms by Schedora');
  const mode = ['classic', 'conversational'].includes(ctx.query.get('mode')) ? ctx.query.get('mode') : form.definition.presentation;
  mount(ctx.main, html`<div class="container page"><div class="card public-form-card" id="form-root"></div><p class="muted public-form">${form.workspace_name} · Powered by Forms by Schedora</p></div>`);
  const root = $('#form-root');
  if (form.availability === 'capacity_reached') return mount(root, html`<div class="public-form"><h1>${form.definition.title}</h1>${notice('warn', html`<p>This form has reached its response limit for now and is not accepting new responses. Please try again later or contact ${form.workspace_name}.</p>`)}</div>`);
  if (!form.accepting) return mount(root, html`<div class="public-form"><h1>${form.definition.title}</h1>${notice('warn', html`<p>This form is not accepting responses right now.</p>`)}</div>`);

  let submissionId = submissionStore.get(slug);
  // An id kept from before a reload may belong to an attempt that reached the server.
  let uncertain = Boolean(submissionId);
  if (!submissionId) { submissionId = uid() + uid(); submissionStore.set(slug, submissionId); }
  const embedded = document.body.dataset.embed === '1';

  // Every message states only what is known about whether the response was saved.
  const describeError = error => {
    if (error.status === 0 || error.status >= 500) {
      uncertain = true;
      return { retry: true, message: html`<p><strong>We could not confirm that your response was received.</strong> Your answers are still here. Submit again: if the first attempt got through, it will not be counted twice.</p>` };
    }
    if (error.code === 'form_version_changed') { reloadVersion(); return { replaced: true }; }
    if (error.code === 'rate_limited') return { retry: true, message: html`<p>Too many attempts from this connection. Wait a minute, then submit again. ${uncertain ? 'We still cannot confirm whether an earlier attempt was received; submitting again will not create a duplicate.' : 'Nothing has been saved yet.'}</p>` };
    const known = { form_closed: 'This form stopped accepting responses before your answers arrived.', quota_exceeded: 'This form has reached its response limit for now.', entitlement_required: 'This form is not accepting responses right now.' }[error.code];
    if (known) return { message: html`<p><strong>${known}</strong> Your response was not saved. Your answers are still on this page if you want to copy them.</p>` };
    return { message: html`<p>${error.message} Your response was not saved.</p>` };
  };

  async function reloadVersion() {
    let next;
    try { next = await api('GET', `/api/public/forms/${slug}`); }
    catch (error) { return mount(root, html`<div class="public-form">${notice('bad', html`<p>This form changed or closed while you were answering, and the new version could not be loaded. Your response was not saved.</p>`)}<a class="btn" data-external href="${location.pathname + location.search}">Reload the form</a></div>`); }
    const kept = {};
    const current = start.answers();
    for (const field of next.definition.fields) if (current[field.id] !== undefined) kept[field.id] = current[field.id];
    form = next;
    start = begin(kept, notice('warn', html`<p><strong>This form was updated while you were answering.</strong> Nothing was submitted. Answers to questions that are still in the form were kept; please review them and submit again.</p>`));
  }

  function begin(initial = {}, banner = '') {
    let latest = { ...initial };
    renderForm(root, form.definition, {
      mode, answers: initial, banner, describeError,
      onSubmit: async answers => {
        latest = answers;
        const result = await api('POST', `/api/public/forms/${form.slug}/responses`, { answers, submission_id: submissionId, version: form.version }, {}, { timeout: SUBMIT_TIMEOUT_MS });
        submissionStore.clear(slug);
        showReceipt(result);
      }
    });
    return { answers: () => latest };
  }
  let start = begin();

  function showReceipt(result) {
    const next = result.next;
    const booking = next?.type === 'booking';
    const target = embedded ? raw('target="_top"') : '';
    const fallback = next?.fallback?.type === 'message' ? html`<p>${next.fallback.message}</p>`
      : next?.fallback?.type === 'url' ? html`<p><a class="btn" href="${next.fallback.url}" data-external rel="noopener" ${target}>Continue</a></p>` : html`<p>${form.workspace_name} has your answers and can follow up with you.</p>`;
    const step = !next ? ''
      : next.type === 'message' ? html`<p>${next.message}</p>`
      : next.type === 'url' ? html`<p><a class="btn btn-primary" href="${next.url}" data-external rel="noopener" ${target}>Continue</a></p>`
      : next.status === 'offered' ? html`<p>Next, choose a time for <strong>${next.title}</strong>. You have not booked yet.</p>
          <p><a class="btn btn-primary" href="${next.url}" ${embedded ? target : ''} id="choose-time">Choose a time</a></p>
          <p class="hint">This booking link works until ${fmtDateTime(next.expires_at)}. Your response is saved whether or not you book.</p>`
      : next.status === 'booked' ? html`<p>A time was already booked from this response. Your confirmation email has the details and links to change it.</p>`
      : html`<p>Booking a time is not available right now.</p>${fallback}`;
    setTitle('Response received · Forms by Schedora');
    mount(root, html`<div role="status" class="public-form receipt"><h1 tabindex="-1">${booking && next.status === 'offered' ? 'Response received — choose a time' : 'Response received'}</h1>
      <p>${result.answers_changed ? 'Your response from your first attempt was saved. Changes you made after that attempt were not saved.' : 'Your answers were saved.'}</p>
      <dl class="confirm-facts"><dt>Receipt</dt><dd>${result.reference}</dd><dt>Received</dt><dd>${fmtDateTime(result.created_at)}</dd></dl>
      ${step}</div>`);
    $('h1', root).focus();
  }
}

// ---------------------------------------------------------------------------------------------
// Dashboard

export async function dashboard(ctx) {
  setTitle('Forms by Schedora');
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'forms', title: 'Every good conversation starts with a question.', lead: 'Build classic or one-question-at-a-time forms with logic and answer piping. Responses are saved to your workspace and can be exported.' }));
  if (!needsSession(ctx)) return;
  const presentation = definition => definition.presentation === 'conversational' ? 'one question at a time' : 'classic layout';
  mount(ctx.main, html`<div class="container page"><div class="row-between"><div><span class="tag">Forms · ${workspace().name}</span><h1>Forms</h1></div>
    <div class="row"><a class="btn" href="/enquiries">Enquiries</a><button class="btn btn-primary" id="new-form" aria-expanded="false" aria-controls="form-templates">Create form</button></div></div>
    ${workspace().entitlements.forms.active ? '' : notice('warn', html`<p>This workspace has no active Forms or Suite plan, so forms cannot be published or collect responses. <a href="/billing">Review plans</a>.</p>`)}
    <section class="form-templates" id="form-templates" aria-labelledby="templates-heading" hidden>
      <h2 id="templates-heading" tabindex="-1">Choose a starting point</h2>
      <p class="muted">Each option creates an unpublished draft in this workspace. Edit any question, preview it, then publish when you are ready. Nothing is public until you publish.</p>
      <ul class="template-grid">
        <li class="template-card"><h3>Blank form</h3><p>A short starter with name, email and one choice question to replace with your own.</p><p class="template-meta">3 questions · classic layout</p>
          <button class="btn" type="button" data-template="blank">Create draft<span class="visually-hidden"> from a blank form</span></button></li>
        ${FORM_TEMPLATES.map(template => html`<li class="template-card"><p class="template-audience">${template.audience}</p><h3>${template.name}</h3><p>${template.purpose}</p>
          <p class="template-meta">${questionCount(template.definition)} questions · ${presentation(template.definition)}</p><p class="template-logic">${template.logic}</p>
          <button class="btn" type="button" data-template="${template.id}">Create draft<span class="visually-hidden"> from ${template.name}</span></button></li>`)}
      </ul>
      <div id="template-status" role="status"></div></section>
    <div id="form-list">${loading()}</div></div>`);
  const picker = $('#form-templates');
  const showPicker = (open, focus = true) => {
    picker.hidden = !open;
    $('#new-form').setAttribute('aria-expanded', String(open));
    if (open && focus) $('#templates-heading').focus();
  };
  $('#new-form').onclick = () => showPicker(picker.hidden);
  // Creating a draft is the explicit action here; publishing stays a separate step in the builder.
  picker.addEventListener('click', async event => {
    const button = event.target.closest('[data-template]');
    if (!button || picker.dataset.busy) return;
    const template = FORM_TEMPLATES.find(item => item.id === button.dataset.template);
    picker.dataset.busy = '1';
    $$('[data-template]', picker).forEach(item => item.setAttribute('aria-disabled', 'true'));
    mount($('#template-status'), html`<p class="muted">Creating draft…</p>`);
    try {
      const form = await api('POST', wsPath('/forms'), template ? { definition: template.definition } : { title: 'Untitled form' });
      ctx.navigate(`/forms/${form.id}?created=${template ? template.id : 'blank'}`);
    } catch (error) {
      mount($('#template-status'), notice('bad', html`<p>The draft was not created. ${error.message}</p>`));
      $$('[data-template]', picker).forEach(item => item.removeAttribute('aria-disabled'));
    } finally { delete picker.dataset.busy; }
  });
  try {
    const forms = await api('GET', wsPath('/forms'));
    if (!ctx.alive()) return;
    mount($('#form-list'), forms.length ? html`<ul class="list">${forms.map(form => html`<li class="row-between"><div>
        <div class="list-title">${form.draft.title}</div>
        <div class="meta"><span>${form.response_count} ${form.response_count === 1 ? 'response' : 'responses'}</span><span>Updated ${fmtDateTime(form.updated_at)}</span>${form.published_version && form.has_unpublished_changes ? html`<span>Unpublished changes</span>` : ''}</div></div>
      <div class="row">${form.published_version ? badge('published', 'Live · v' + form.published_version) : badge('draft', 'Not published')}
        <a class="btn btn-small" href="/forms/${form.id}">Edit</a><a class="btn btn-small" href="/forms/${form.id}/responses">Responses</a></div></li>`)}</ul>`
      : html`<div class="empty"><h2>No forms yet</h2><p>Pick a starting point above, or start blank. You can change every question later.</p><div class="actions"><a class="btn" href="/setup/forms">Guided setup</a></div></div>`);
    if (!forms.length) showPicker(true, false);
  } catch (error) { mount($('#form-list'), errorBlock(error)); }
}

// ---------------------------------------------------------------------------------------------
// Builder

// New questions and options get random keys, so a key is never reused for a different question
// and answers from older versions stay attached to the question they answered.
const randomKey = (prefix, taken) => {
  let key;
  do key = `${prefix}_${uid().slice(0, 8)}`; while (taken.some(item => item.id === key));
  return key;
};

const SAVE_TEXT = { saved: 'All changes saved', dirty: 'Unsaved changes', saving: 'Saving…', failed: 'Not saved', conflict: 'Not saved: changed elsewhere' };

export async function builder(ctx) {
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'forms', title: 'Sign in to edit this form', lead: 'Forms belong to your workspace.' }));
  if (!needsSession(ctx)) return;
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let form;
  try { form = await api('GET', wsPath('/forms/' + ctx.params[0])); }
  catch (error) { return mount(ctx.main, html`<div class="container page">${errorBlock(error)}<a href="/forms">Back to Forms</a></div>`); }
  if (!ctx.alive()) return;
  let draft = structuredClone(form.draft);
  setTitle(`${draft.title} · Forms by Schedora`);
  let saveState = 'saved';
  let readiness = null;
  let view = 'edit';

  mount(ctx.main, html`<div class="container page">
    <a href="/forms">← All forms</a>
    <div class="row-between"><h1 id="builder-title">${draft.title}</h1><div class="row" id="builder-status"></div></div>
    <div class="actions builder-actions"><button class="btn" id="save">Save draft</button><button class="btn btn-primary" id="publish">Publish form</button>
      <a class="btn" href="/forms/${form.id}/responses">Responses</a><button class="btn btn-danger" id="delete-form">Delete</button></div>
    <p class="hint" id="save-hint">Changes are kept on this page until you select Save draft. The live form changes only when you publish.</p>
    <div id="builder-notice" tabindex="-1"></div>
    <div class="visually-hidden" aria-live="polite" id="builder-live"></div>
    <section class="card card-plain readiness" id="readiness" aria-labelledby="readiness-heading">
      <div class="row-between"><h2 id="readiness-heading" tabindex="-1">Ready to share?</h2><button class="btn btn-small" type="button" data-recheck>Check again</button></div>
      <p class="hint" id="readiness-checked">What respondents see now and what your saved draft would publish. Unsaved edits are not included.</p>
      <div id="readiness-unsaved"></div><div id="readiness-body"></div><p class="visually-hidden" id="readiness-status" role="status"></p></section>
    <div id="routing"></div>
    <div class="tabs mobile-switch" role="tablist" aria-label="Builder view"><button role="tab" data-view="edit" aria-selected="true" aria-controls="builder-edit">Edit</button><button role="tab" data-view="preview" aria-selected="false" aria-controls="builder-preview" tabindex="-1">Preview</button></div>
    <div class="builder" data-view="edit">
      <section class="builder-edit" id="builder-edit" aria-label="Form editor"><div id="settings"></div><div id="fields"></div>
        <div class="card card-plain"><label for="new-type">Add an item</label><div class="row"><select id="new-type">${Object.entries(FIELD_TYPES).map(([key, label]) => html`<option value="${key}">${label}</option>`)}</select><button class="btn" id="add-field">Add</button></div></div></section>
      <section class="builder-preview card" id="builder-preview" aria-label="Live preview"><div class="row-between"><h2 id="preview-heading" tabindex="-1">Preview</h2><select id="preview-mode" aria-label="Preview presentation"><option value="classic">Classic</option><option value="conversational">Conversational</option></select></div><div id="preview"></div></section>
    </div></div>`);

  const announce = text => { $('#builder-live').textContent = ''; setTimeout(() => { $('#builder-live').textContent = text; }, 30); };
  const setState = value => {
    saveState = value;
    if (value === 'saved') delete document.body.dataset.dirty; else document.body.dataset.dirty = '1';
    renderStatus();
    readiness?.unsaved(value !== 'saved');
  };
  const liveBadge = () => form.published_version ? badge('published', `Live · version ${form.published_version}`) : form.locked_ids?.length ? badge('paused', 'Closed · not collecting') : badge('draft', 'Not published');
  const renderStatus = () => mount($('#builder-status'), html`${liveBadge()}
    <span class="badge badge-${saveState === 'saved' ? 'ok' : saveState === 'saving' || saveState === 'dirty' ? 'warn' : 'bad'}" role="status">${SAVE_TEXT[saveState]}</span>
    ${saveState === 'saved' && form.published_version && form.has_unpublished_changes ? badge('pending', 'Saved draft not yet published') : ''}`);
  // Share controls live in the readiness Sharing area; nothing here publishes.
  const renderShare = () => $('#share') && mount($('#share'), form.published_version ? html`<div class="share-block">
    <label for="share-link">Public link</label><div class="share-row"><input id="share-link" readonly value="${publicUrl(form)}"><button class="btn btn-small" type="button" data-copy="${publicUrl(form)}">Copy</button><a class="btn btn-small" href="/f/${form.slug}" target="_blank" rel="noopener">Open<span class="visually-hidden"> the live form in a new tab</span></a></div>
    <label for="share-conv">Conversational link</label><div class="share-row"><input id="share-conv" readonly value="${publicUrl(form, 'conversational')}"><button class="btn btn-small" type="button" data-copy="${publicUrl(form, 'conversational')}">Copy</button></div>
    <details class="share-embed"><summary>Embed on your site</summary><label for="embed">Embed code</label><textarea id="embed" class="embed-code" readonly>&lt;iframe src="${publicUrl(form)}${publicUrl(form).includes('?') ? '&amp;' : '?'}embed=1" title="${form.draft.title}" width="100%" height="680" style="border:0"&gt;&lt;/iframe&gt;</textarea>
      <button class="btn btn-small" type="button" data-copy-embed>Copy embed code</button></details>
    <div class="actions"><button class="btn btn-danger btn-small" type="button" id="unpublish">Stop collecting responses</button></div></div>`
    : html`<label for="share-future">Link once published</label><input id="share-future" readonly value="${publicUrl(form)}">`);
  const renderPreview = () => renderForm($('#preview'), draft, { mode: $('#preview-mode').value, preview: true });

  const renderSettings = () => mount($('#settings'), html`<div class="card card-plain">
    <label for="f-title">Form title</label><input id="f-title" data-setting="title" maxlength="150" value="${draft.title}">
    <label for="f-description">Description</label><textarea id="f-description" data-setting="description" maxlength="2000">${draft.description || ''}</textarea>
    <fieldset><legend class="label">Presentation</legend>
      <label class="check"><input type="radio" name="presentation" value="classic" data-setting="presentation" ${draft.presentation === 'classic' ? raw('checked') : ''}> Classic: questions grouped into pages</label>
      <label class="check"><input type="radio" name="presentation" value="conversational" data-setting="presentation" ${draft.presentation === 'conversational' ? raw('checked') : ''}> Conversational: one question at a time</label></fieldset>
    <label for="f-submit">Submit button text</label><input id="f-submit" data-setting="submit_label" maxlength="40" value="${draft.submit_label || 'Submit'}"></div>`);

  const renderFields = () => {
    const locked = new Set(form.locked_ids || []);
    mount($('#fields'), html`${draft.fields.map((field, index) => {
      const earlier = draft.fields.slice(0, index).filter(candidate => candidate.type !== 'page_break');
      const source = field.show_if && draft.fields.find(candidate => candidate.id === field.show_if.field);
      const number = draft.fields.slice(0, index + 1).filter(candidate => candidate.type !== 'page_break').length;
      const name = field.type === 'page_break' ? `page break ${index + 1}` : `question ${number}`;
      return html`<div class="field-editor ${field.type === 'page_break' ? 'page-break' : ''}" data-index="${index}">
        <div class="field-editor-head"><strong>${field.type === 'page_break' ? 'Page break' : `${number}. ${FIELD_TYPES[field.type]}`}</strong>
          <div class="row"><button class="btn btn-small" data-move="-1" ${index === 0 ? raw('disabled') : ''} aria-label="Move ${name} up">↑</button><button class="btn btn-small" data-move="1" ${index === draft.fields.length - 1 ? raw('disabled') : ''} aria-label="Move ${name} down">↓</button><button class="btn btn-small btn-danger" data-remove aria-label="Remove ${name}">Remove</button></div></div>
        ${field.type === 'page_break' ? html`<p class="hint">Questions after this start a new page in classic presentation.</p>` : html`
          <label for="fl-${index}">Question</label><span class="hint" id="fl-${index}-hint">Insert an earlier answer with {{question_key}}${earlier.length ? `, for example {{${earlier[0].id}}}` : ''}.</span>
          <input id="fl-${index}" data-prop="label" maxlength="300" aria-describedby="fl-${index}-hint" value="${field.label}">
          <label for="fh-${index}">Help text <span class="muted">(optional)</span></label><input id="fh-${index}" data-prop="help" maxlength="500" value="${field.help || ''}">
          <div class="row"><label class="check"><input type="checkbox" data-prop="required" ${field.required ? raw('checked') : ''}> Required</label>
            <label class="check">Key <input data-prop="id" value="${field.id}" maxlength="40" pattern="[a-z0-9_]+" aria-label="Question key" class="key-input" ${locked.has(field.id) ? raw('readonly aria-describedby="key-locked-' + index + '"') : ''}></label></div>
          ${locked.has(field.id) ? html`<p class="hint" id="key-locked-${index}">The key is fixed because a published version uses it, so earlier answers stay matched to this question.</p>` : ''}
          ${field.type.endsWith('_choice') ? html`<fieldset><legend class="label">Options</legend>${field.options.map((option, optionIndex) => html`<div class="range"><input aria-label="Option ${optionIndex + 1} of ${name}" data-option="${optionIndex}" maxlength="200" value="${option.label}"><button class="btn btn-small" data-remove-option="${optionIndex}" aria-label="Remove option ${optionIndex + 1}" ${field.options.length === 1 ? raw('disabled') : ''}>Remove</button></div>`)}
            <button class="btn-link" data-add-option>Add option</button></fieldset>` : ''}`}
        <label class="check"><input type="checkbox" data-logic ${field.show_if ? raw('checked') : ''} ${earlier.length ? '' : raw('disabled')}> ${field.type === 'page_break' ? 'Show this page only when…' : 'Show only when…'}</label>
        ${field.show_if ? html`<div class="row">
          <select data-cond="field" aria-label="Earlier question">${earlier.map(candidate => html`<option value="${candidate.id}" ${candidate.id === field.show_if.field ? raw('selected') : ''}>${candidate.label.slice(0, 50)}</option>`)}</select>
          <select data-cond="op" aria-label="Rule">${Object.entries(CONDITION_OPS).map(([op, label]) => html`<option value="${op}" ${op === field.show_if.op ? raw('selected') : ''}>${label}</option>`)}</select>
          ${['answered', 'not_answered'].includes(field.show_if.op) ? '' : source?.type?.endsWith('_choice')
            ? html`<select data-cond="value" aria-label="Value">${source.options.map(option => html`<option value="${option.id}" ${option.id === field.show_if.value ? raw('selected') : ''}>${option.label}</option>`)}</select>`
            : html`<input data-cond="value" aria-label="Value" value="${field.show_if.value || ''}">`}</div>
          <p class="hint">Hidden questions are skipped, and any answer to them is discarded when the response is saved.</p>` : ''}
      </div>`;
    })}`);
  };

  const refresh = ({ fields = false, preview = true } = {}) => {
    if (fields) renderFields();
    if (preview) renderPreview();
    setState('dirty');
  };

  const renderAll = () => {
    $('#builder-title').textContent = draft.title || 'Untitled form';
    renderStatus(); readiness?.check(); renderSettings(); renderFields();
    $('#preview-mode').value = draft.presentation;
    renderPreview();
  };

  $('#settings').addEventListener('input', event => {
    const key = event.target.dataset.setting;
    if (!key) return;
    draft[key] = event.target.value;
    if (key === 'title') $('#builder-title').textContent = draft.title || 'Untitled form';
    if (key === 'presentation') $('#preview-mode').value = draft.presentation;
    refresh();
  });
  $('#preview-mode').onchange = renderPreview;

  const fieldsRoot = $('#fields');
  fieldsRoot.addEventListener('input', event => {
    const editor = event.target.closest('[data-index]');
    if (!editor) return;
    const field = draft.fields[Number(editor.dataset.index)];
    const { prop, option, cond } = event.target.dataset;
    if (prop === 'label' || prop === 'help') field[prop] = event.target.value;
    else if (prop === 'id') {
      if (event.target.readOnly) return;
      const next = event.target.value.trim();
      if (!/^[a-z0-9_]{1,40}$/.test(next) || draft.fields.some(other => other !== field && other.id === next)) { event.target.setAttribute('aria-invalid', 'true'); return; }
      event.target.removeAttribute('aria-invalid');
      for (const other of draft.fields) if (other.show_if?.field === field.id) other.show_if.field = next;
      field.id = next;
    } else if (option !== undefined) field.options[Number(option)].label = event.target.value;
    else if (cond === 'value' && event.target.tagName === 'INPUT') field.show_if.value = event.target.value;
    else return;
    refresh();
  });
  fieldsRoot.addEventListener('change', event => {
    const editor = event.target.closest('[data-index]');
    if (!editor) return;
    const index = Number(editor.dataset.index);
    const field = draft.fields[index];
    const { prop, cond } = event.target.dataset;
    if (prop === 'required') { field.required = event.target.checked; return refresh(); }
    if (event.target.dataset.logic !== undefined) {
      if (event.target.checked) {
        const source = draft.fields.slice(0, index).filter(candidate => candidate.type !== 'page_break').pop();
        field.show_if = source.type.endsWith('_choice') ? { field: source.id, op: 'equals', value: source.options[0].id } : { field: source.id, op: 'answered' };
      } else delete field.show_if;
      refresh({ fields: true });
      return fieldsRoot.querySelector(`[data-index="${index}"] [data-logic]`)?.focus();
    }
    if (cond === 'field' || cond === 'op' || (cond === 'value' && event.target.tagName === 'SELECT')) {
      field.show_if[cond] = event.target.value;
      const source = draft.fields.find(candidate => candidate.id === field.show_if.field);
      if (['answered', 'not_answered'].includes(field.show_if.op)) delete field.show_if.value;
      else if (source?.type.endsWith('_choice') && !source.options.some(option => option.id === field.show_if.value)) field.show_if.value = source.options[0].id;
      else field.show_if.value ??= '';
      refresh({ fields: true });
      return fieldsRoot.querySelector(`[data-index="${index}"] [data-cond="${cond}"]`)?.focus();
    }
  });
  fieldsRoot.addEventListener('click', event => {
    const button = event.target.closest('button');
    const editor = event.target.closest('[data-index]');
    if (!button || !editor) return;
    event.preventDefault();
    const index = Number(editor.dataset.index);
    const field = draft.fields[index];
    let focus = null;
    if (button.dataset.move) {
      const target = index + Number(button.dataset.move);
      [draft.fields[index], draft.fields[target]] = [draft.fields[target], draft.fields[index]];
      // Logic may only refer to earlier questions; drop rules that no longer do.
      const dropped = draft.fields.filter((item, position) => item.show_if && !draft.fields.slice(0, position).some(candidate => candidate.id === item.show_if.field));
      dropped.forEach(item => delete item.show_if);
      // Keep focus on the same control of the moved item, falling back to the other direction at an end.
      const ends = target === 0 || target === draft.fields.length - 1;
      focus = `[data-index="${target}"] [data-move="${ends ? -Number(button.dataset.move) : button.dataset.move}"]`;
      announce(`Moved to position ${target + 1} of ${draft.fields.length}.${dropped.length ? ` ${dropped.length} display rule${dropped.length > 1 ? 's were' : ' was'} removed because ${dropped.length > 1 ? 'they' : 'it'} referred to a later question.` : ''}`);
    } else if (button.dataset.remove !== undefined) {
      draft.fields.splice(index, 1);
      draft.fields.forEach(item => { if (item.show_if?.field === field.id) delete item.show_if; });
      focus = draft.fields.length ? `[data-index="${Math.min(index, draft.fields.length - 1)}"] [data-remove]` : '#new-type';
      announce('Item removed. Save the draft to keep this change.');
    } else if (button.dataset.addOption !== undefined) {
      field.options.push({ id: randomKey('opt', field.options), label: 'Option ' + (field.options.length + 1) });
      focus = `[data-index="${index}"] [data-option="${field.options.length - 1}"]`;
    } else if (button.dataset.removeOption !== undefined) {
      field.options.splice(Number(button.dataset.removeOption), 1);
      focus = `[data-index="${index}"] [data-add-option]`;
    } else return;
    refresh({ fields: true });
    if (focus) $(focus)?.focus();
  });
  $('#add-field').onclick = () => {
    const type = $('#new-type').value;
    const field = { id: randomKey(type === 'page_break' ? 'page' : 'q', draft.fields), type, label: type === 'page_break' ? '' : 'New question', required: false };
    if (type === 'page_break') delete field.required;
    if (type.endsWith('_choice')) field.options = [{ id: randomKey('opt', []), label: 'Option 1' }, { id: randomKey('opt', []), label: 'Option 2' }];
    draft.fields.push(field);
    refresh({ fields: true });
    $$('#fields [data-prop="label"]').pop()?.focus();
  };
  const tabs = $$('.mobile-switch [data-view]');
  const selectView = tab => {
    view = tab.dataset.view;
    $('.builder').dataset.view = view;
    tabs.forEach(item => { item.setAttribute('aria-selected', String(item === tab)); item.tabIndex = item === tab ? 0 : -1; });
  };
  tabs.forEach(tab => {
    tab.onclick = () => selectView(tab);
    tab.onkeydown = event => {
      if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      const next = tabs[(tabs.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectView(next); next.focus();
    };
  });

  const reportError = (error, prefix = '') => {
    const problems = error.details?.problems || [];
    mount($('#builder-notice'), notice('bad', html`<p>${prefix}${error.message}</p>${problems.length > 1 ? html`<ul>${problems.slice(1, 8).map(problem => html`<li>${problem}</li>`)}</ul>` : ''}`));
    $('#builder-notice').focus();
  };

  // Explicit save. The server rejects a save based on an older revision, so two editors never
  // silently overwrite each other; this page's edits are kept until the person chooses.
  const save = async ({ force = false } = {}) => {
    const sent = JSON.stringify(draft);
    setState('saving');
    try {
      form = await api('PATCH', wsPath('/forms/' + form.id), { definition: draft, base_revision: force ? force : form.revision }, {}, { timeout: SUBMIT_TIMEOUT_MS });
      setState(JSON.stringify(draft) === sent ? 'saved' : 'dirty');
      $('#builder-notice').innerHTML = '';
      renderFields();
      readiness.check();
      return true;
    } catch (error) {
      if (error.code === 'draft_conflict') {
        // A retry of a save that already went through comes back as a conflict with our own draft.
        if (JSON.stringify(error.details.current?.draft) === sent) { form = error.details.current; setState(JSON.stringify(draft) === sent ? 'saved' : 'dirty'); return true; }
        setState('conflict');
        showConflict(error.details.current);
        return false;
      }
      setState('failed');
      reportError(error, error.status === 0 ? 'Your edits were not confirmed as saved and are still on this page. ' : 'Not saved. Your edits are still on this page. ');
      return false;
    }
  };
  const showConflict = current => {
    mount($('#builder-notice'), notice('bad', html`<p><strong>Someone saved this form after you opened it</strong> (last saved ${fmtDateTime(current.updated_at)}). Your edits have not been saved and are still on this page.</p>
      <div class="actions"><button class="btn" type="button" id="conflict-load">Discard my edits and load theirs</button><button class="btn btn-danger" type="button" id="conflict-keep">Save my version over theirs</button></div>`));
    $('#builder-notice').focus();
    $('#conflict-load').onclick = () => { form = current; draft = structuredClone(form.draft); $('#builder-notice').innerHTML = ''; setState('saved'); renderAll(); renderRouting(); announce('Loaded the latest saved version.'); };
    $('#conflict-keep').onclick = async () => { if (await save({ force: current.revision })) { toast('Your version was saved.'); renderRouting(); } };
  };

  $('#save').onclick = async () => { if (await save()) toast(form.published_version ? 'Draft saved. The live form is unchanged until you publish.' : 'Draft saved.'); };
  $('#publish').onclick = async () => {
    if (saveState !== 'saved' && !(await save())) return;
    if (form.published_version && !form.has_unpublished_changes) { mount($('#builder-notice'), notice('info', html`<p>Version ${form.published_version} is already live with these questions and routing.</p>`)); return $('#builder-notice').focus(); }
    if (form.published_version && !(await ask({ title: `Publish version ${form.published_version + 1}?`, body: 'New visitors see the updated questions and routing right away. Responses already received stay linked to the version they answered. People who opened the current version can still submit it for 24 hours.', confirm: 'Publish' }))) return;
    try {
      form = await api('POST', wsPath(`/forms/${form.id}/publish`), { base_revision: form.revision });
      renderStatus(); readiness.check(); renderFields();
      mount($('#builder-notice'), notice('ok', html`<p>Version ${form.published_version} is live. New responses use this version.</p>`));
      $('#builder-notice').focus();
    } catch (error) {
      if (error.code === 'draft_conflict') { setState('conflict'); return showConflict(error.details.current); }
      reportError(error, 'Not published. ');
    }
  };
  function bindShare() {
    $$('#share [data-copy]').forEach(button => button.onclick = () => copy(button.dataset.copy));
    $('#share [data-copy-embed]')?.addEventListener('click', () => copy($('#embed').value, 'Embed code'));
    $('#unpublish')?.addEventListener('click', async () => {
      if (!(await ask({ title: 'Stop collecting responses?', body: 'The public link will say the form is closed. Existing responses are kept. You can publish again later.', confirm: 'Stop collecting', danger: true }))) return;
      try { form = await api('POST', wsPath(`/forms/${form.id}/unpublish`)); renderStatus(); readiness.check(); toast('The form is closed to new responses.'); }
      catch (error) { reportError(error); }
    });
  }
  // "Ready to share?": the saved form and the live public form, assessed with the shared validator.
  // Re-checked after every save, publish, unpublish and routing save. It never publishes.
  readiness = formReadiness(ctx, () => form, { renderShare, bindShare, goTo: section => {
    if (section === 'publish') return $('#publish').focus();
    if (section === 'routing') { const routing = $('#routing details'); if (routing) { routing.open = true; routing.scrollIntoView({ block: 'start' }); routing.querySelector('summary').focus({ preventScroll: true }); } return; }
    if (section.startsWith('preview-')) {
      $('#preview-mode').value = section.slice(8);
      renderPreview();
      selectView(tabs.find(tab => tab.dataset.view === 'preview'));
      $('#builder-preview').scrollIntoView({ block: 'start' });
      return $('#preview-heading').focus({ preventScroll: true });
    }
    selectView(tabs.find(tab => tab.dataset.view === 'edit'));
    $('#fields').scrollIntoView({ block: 'start' });
    ($('#fields [data-prop="label"]') || $('#new-type')).focus({ preventScroll: true });
  } });
  renderAll();
  renderRouting();
  // Arriving from the template picker: say plainly what exists and what does not yet.
  const created = ctx.query.get('created');
  if (created && !form.published_version) {
    const template = FORM_TEMPLATES.find(item => item.id === created);
    mount($('#builder-notice'), notice('info', html`<p><strong>Draft created${template ? html` from the “${template.name}” template` : ''}.</strong> It is saved in this workspace but not published, so nobody can open it yet. Review the questions, check the preview, then publish.</p>`));
  }

  async function renderRouting() {
    const eventTypes = (await api('GET', wsPath('/event-types')).catch(() => [])).filter(type => !type.managed_template);
    const meetActive = workspace().entitlements?.meet?.active;
    const clone = action => action ? { ...action } : null;
    let rules = (form.routing?.rules || []).map(rule => ({ condition: { ...rule.condition }, action: clone(rule.action) }));
    let fallback = clone(form.routing?.fallback);
    const questions = () => draft.fields.filter(field => field.type !== 'page_break');
    const actionEditor = (action, key) => html`<select data-akind="${key}" aria-label="${key === 'fallback' ? 'Otherwise' : `Rule ${Number(key) + 1}: then`}">${[['event', 'Offer a booking page'], ['url', 'Show a link'], ['message', 'Show a message']].map(([value, label]) => html`<option value="${value}" ${action?.type === value ? raw('selected') : ''}>${label}</option>`)}</select>
      ${action?.type === 'event' ? html`<select data-aevent="${key}" aria-label="Booking page">${eventTypes.length ? '' : html`<option value="">No booking pages yet</option>`}${eventTypes.map(type => html`<option value="${type.id}" ${action.event_type_id === type.id ? raw('selected') : ''}>${type.title}${type.published ? '' : ' (not published)'}</option>`)}</select>`
        : html`<input data-avalue="${key}" aria-label="${action?.type === 'url' ? 'Link' : 'Message'}" value="${action?.type === 'url' ? action.url || '' : action?.message || ''}" placeholder="${action?.type === 'url' ? 'https://…' : 'Thanks! We will be in touch.'}">`}`;
    const valueEditor = (rule, index) => {
      if (['answered', 'not_answered'].includes(rule.condition.op)) return '';
      const field = questions().find(item => item.id === rule.condition.field);
      return field?.type.endsWith('_choice')
        ? html`<select data-rvalue="${index}" aria-label="Rule ${index + 1}: value">${field.options.map(option => html`<option value="${option.id}" ${option.id === rule.condition.value ? raw('selected') : ''}>${option.label}</option>`)}</select>`
        : html`<input data-rvalue="${index}" aria-label="Rule ${index + 1}: value" value="${rule.condition.value || ''}">`;
    };
    const live = form.published_version ? 'Routing is published with the form: saved changes apply after you publish.' : 'Routing goes live when you publish the form.';
    const draw = () => mount($('#routing'), html`<details class="card card-plain" ${form.routing ? raw('open') : ''}><summary><strong>Next step after submitting</strong> <span class="muted">(optional)</span></summary>
      <p class="hint">Rules are checked in order and the first match decides. The response is always saved first; a booking page is offered as a next step, and booking is optional for the respondent.${meetActive ? '' : ' Booking pages need an active Meet or Suite plan.'}</p>
      <ol class="rule-list">${rules.map((rule, index) => html`<li class="range"><span>If</span> <select data-rfield="${index}" aria-label="Rule ${index + 1}: question">${questions().map(field => html`<option value="${field.id}" ${field.id === rule.condition.field ? raw('selected') : ''}>${field.label.slice(0, 40)}</option>`)}</select>
        <select data-rop="${index}" aria-label="Rule ${index + 1}: condition">${Object.entries(CONDITION_OPS).map(([op, label]) => html`<option value="${op}" ${rule.condition.op === op ? raw('selected') : ''}>${label}</option>`)}</select>
        ${valueEditor(rule, index)} <span>then</span> ${actionEditor(rule.action, index)}
        <span class="row"><button class="btn btn-small" type="button" data-rmove="${index}:-1" aria-label="Move rule ${index + 1} up" ${index === 0 ? raw('disabled') : ''}>↑</button><button class="btn btn-small" type="button" data-rmove="${index}:1" aria-label="Move rule ${index + 1} down" ${index === rules.length - 1 ? raw('disabled') : ''}>↓</button><button class="btn btn-small" type="button" data-rremove="${index}" aria-label="Remove rule ${index + 1}">Remove</button></span></li>`)}</ol>
      <div class="range"><span>If no rule matches:</span> ${fallback ? actionEditor(fallback, 'fallback') : html`<span class="muted">show the receipt only</span>`} <button class="btn-link" type="button" id="toggle-fallback">${fallback ? 'Remove' : 'Set a next step'}</button></div>
      <p class="hint">${live} If a booking page is unavailable when someone submits, they see their receipt and the “If no rule matches” message or link instead.</p>
      <div class="actions"><button class="btn btn-small" type="button" id="add-rule" ${questions().length ? '' : raw('disabled')}>Add rule</button><button class="btn btn-small btn-primary" type="button" id="save-routing">Save routing</button>${form.routing ? html`<button class="btn btn-small" type="button" id="clear-routing">Remove all rules</button>` : ''}</div></details>`);
    const actionAt = key => key === 'fallback' ? fallback : rules[Number(key)].action;
    const setAction = (key, value) => { if (key === 'fallback') fallback = value; else rules[Number(key)].action = value; };
    const defaultValue = fieldId => { const field = questions().find(item => item.id === fieldId); return field?.type.endsWith('_choice') ? field.options[0].id : ''; };
    const redraw = selector => { const open = $('#routing details')?.open; draw(); if (open) $('#routing details').open = true; if (selector) $(selector)?.focus(); };
    draw();
    const root = $('#routing');
    root.onchange = event => {
      const { rfield, rop, rvalue, akind, aevent } = event.target.dataset;
      if (rfield !== undefined) { const rule = rules[Number(rfield)]; rule.condition.field = event.target.value; rule.condition.value = defaultValue(rule.condition.field); return redraw(`[data-rfield="${rfield}"]`); }
      if (rop !== undefined) { const rule = rules[Number(rop)]; rule.condition.op = event.target.value; if (!['answered', 'not_answered'].includes(rule.condition.op) && !rule.condition.value) rule.condition.value = defaultValue(rule.condition.field); return redraw(`[data-rop="${rop}"]`); }
      if (rvalue !== undefined && event.target.tagName === 'SELECT') rules[Number(rvalue)].condition.value = event.target.value;
      if (akind !== undefined) { setAction(akind, event.target.value === 'event' ? { type: 'event', event_type_id: eventTypes[0]?.id } : { type: event.target.value }); return redraw(`[data-akind="${akind}"]`); }
      if (aevent !== undefined) actionAt(aevent).event_type_id = event.target.value;
    };
    root.oninput = event => {
      const { rvalue, avalue } = event.target.dataset;
      if (rvalue !== undefined && event.target.tagName === 'INPUT') rules[Number(rvalue)].condition.value = event.target.value;
      if (avalue !== undefined) { const action = actionAt(avalue); if (action.type === 'url') action.url = event.target.value; else action.message = event.target.value; }
    };
    root.onclick = async event => {
      const target = event.target.closest('button');
      if (!target) return;
      if (target.dataset.rremove !== undefined) { rules.splice(Number(target.dataset.rremove), 1); return redraw('#add-rule'); }
      if (target.dataset.rmove) {
        const [index, step] = target.dataset.rmove.split(':').map(Number);
        [rules[index], rules[index + step]] = [rules[index + step], rules[index]];
        announce(`Rule moved to position ${index + step + 1} of ${rules.length}.`);
        return redraw(`[data-rmove="${index + step}:${step}"]:not([disabled])`);
      }
      if (target.id === 'add-rule') { const field = questions()[0]; rules.push({ condition: { field: field.id, op: 'equals', value: defaultValue(field.id) }, action: { type: eventTypes.length ? 'event' : 'message', event_type_id: eventTypes[0]?.id } }); return redraw(`[data-rfield="${rules.length - 1}"]`); }
      if (target.id === 'toggle-fallback') { fallback = fallback ? null : { type: 'message', message: '' }; return redraw('#toggle-fallback'); }
      if (target.id === 'save-routing' || target.id === 'clear-routing') {
        if (saveState !== 'saved') { mount($('#builder-notice'), notice('warn', html`<p>Save the question changes first, so routing is checked against the questions you see.</p>`)); return $('#builder-notice').focus(); }
        try {
          form = await api('PUT', wsPath(`/forms/${form.id}/routing`), { routing: target.id === 'clear-routing' ? null : { rules, fallback }, base_revision: form.revision });
          renderStatus();
          readiness.check();
          toast(target.id === 'clear-routing' ? 'Rules removed from the draft. Publish to apply.' : form.published_version ? 'Routing saved. Publish to apply it to the live form.' : 'Routing saved.');
          rules = (form.routing?.rules || []).map(rule => ({ condition: { ...rule.condition }, action: clone(rule.action) }));
          fallback = clone(form.routing?.fallback);
          redraw('#save-routing');
        } catch (error) {
          if (error.code === 'draft_conflict') { setState('conflict'); return showConflict(error.details.current); }
          reportError(error, 'Routing not saved. ');
        }
      }
    };
  }
  $('#delete-form').onclick = async () => {
    if (!(await ask({ title: 'Delete this form?', body: 'The form and all of its responses are permanently deleted. This does not restore your monthly response allowance.', confirm: 'Delete form and responses', danger: true }))) return;
    try { await api('DELETE', wsPath('/forms/' + form.id)); setState('saved'); toast('Form deleted.'); ctx.navigate('/forms', { replace: true }); }
    catch (error) { reportError(error); }
  };
}

function formReadiness(ctx, currentForm, { renderShare, bindShare, goTo }) {
  const root = $('#readiness');
  const body = $('#readiness-body', root);
  let announce = false;
  let generation = 0;
  const check = async refetch => {
    const requestGeneration = ++generation;
    body.setAttribute('aria-busy', 'true');
    if (!body.childElementCount) mount(body, loading('Checking the saved form…'));
    // "Check again" re-reads the saved form into its own copy; the builder's revision is untouched.
    const [saved] = await Promise.allSettled([refetch ? api('GET', wsPath('/forms/' + currentForm().id)) : currentForm()]);
    const [live, eventTypes, publishCheck] = saved.status === 'fulfilled' ? await Promise.allSettled([
      saved.value.published_version ? api('GET', `/api/public/forms/${encodeURIComponent(saved.value.slug)}`) : null,
      api('GET', wsPath('/event-types')),
      api('POST', wsPath(`/forms/${saved.value.id}/publish-check`), { base_revision: saved.value.revision })
    ]) : [];
    if (!ctx.alive() || !root.isConnected || generation !== requestGeneration) return;
    body.removeAttribute('aria-busy');
    if (saved.status === 'rejected') {
      $('#readiness-status', root).textContent = 'Readiness could not be checked.';
      return mount(body, html`${notice('bad', html`<p>Readiness could not be checked: ${saved.reason.message} Nothing is marked ready.</p>`)}<button class="btn btn-small" type="button" data-recheck>Check again</button>`);
    }
    const form = saved.value;
    const settle = result => result.status === 'fulfilled' ? (result.value === null ? null : { ok: true, value: result.value }) : { ok: false, error: result.reason };
    const result = assessFormReadiness({
      form, live: settle(live), eventTypes: settle(eventTypes), publishCheck: settle(publishCheck), viewer: { admin: isAdmin() }, baseUrl: location.origin,
      flags: { formsActive: Boolean(workspace().entitlements?.forms?.active), meetActive: Boolean(workspace().entitlements?.meet?.active) },
      logic: { definitionProblems, visibleFields }
    });
    $('#readiness-checked', root).textContent = `Based on the draft saved ${fmtDateTime(form.updated_at)}${form.published_version ? ` and live version ${form.published_version}` : ''}. Unsaved edits are not included.`;
    mount(body, readinessAreas(result, { extra: area => area.key === 'sharing' ? html`<div id="share"></div>` : '' }));
    renderShare(); bindShare();
    if (announce) $('#readiness-status', root).textContent = result.headline;
  };
  root.addEventListener('click', event => {
    const goto = event.target.closest('[data-goto]');
    if (goto) return goTo(goto.dataset.goto);
    if (event.target.closest('[data-recheck]')) { announce = true; check(true); }
  });
  return {
    check: () => check(false),
    unsaved(on) {
      const slot = $('#readiness-unsaved', root);
      if (!on) return mount(slot, '');
      if (!slot.childElementCount) mount(slot, notice('warn', html`<p><strong>You have unsaved changes.</strong> This summary describes the saved draft. Save to check your changes; Preview already shows them.</p>`));
    }
  };
}

// ---------------------------------------------------------------------------------------------
// Responses

const STEP_LABELS = {
  offered: ['pending', 'Booking offered'], unavailable: ['failed', 'Booking unavailable'], booked: ['confirmed', 'Booking confirmed'],
  booking_pending: ['pending', 'Booking pending payment'], booking_canceled: ['canceled', 'Booking canceled'], booking_removed: ['neutral', 'Booking removed']
};
const stepBadge = step => step ? badge(STEP_LABELS[step.status]?.[0] || 'neutral', [STEP_LABELS[step.status]?.[1] || step.status, step.reference].filter(Boolean).join(' · ')) : html`<span class="muted">—</span>`;

export async function responses(ctx) {
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'forms', title: 'Sign in to see responses', lead: 'Responses are visible only to members of the form\'s workspace.' }));
  if (!needsSession(ctx)) return;
  mount(ctx.main, html`<div class="container page">${loading('Loading responses…')}</div>`);
  let data;
  try { data = await api('GET', wsPath(`/forms/${ctx.params[0]}/responses`)); }
  catch (error) {
    const message = error.status === 404 ? 'This form was not found in the selected workspace, or you do not have access to it.' : error.status === 403 ? 'Your role in this workspace cannot view these responses.' : error.message;
    return mount(ctx.main, html`<div class="container page">${notice('bad', html`<p>${message}</p>`)}<div class="actions"><a class="btn" href="${ctx.path}">Try again</a><a class="btn" href="/forms">Back to Forms</a></div></div>`);
  }
  if (!ctx.alive()) return;
  const { form, versions } = data;
  let rows = data.responses;
  let more = rows.length === 50;
  let context = null; // linked follow-up records, loaded after the inbox renders
  let filter = 'all';
  const trailOf = row => context ? buildTrail(row, context) : null;
  setTitle(`Responses: ${form.draft.title} · Forms by Schedora`);
  // Every question any version asked, latest version first; each answer is shown with the labels
  // of the version it was given in.
  const columns = [];
  for (const definition of [...Object.keys(versions).sort((a, b) => b - a).map(key => versions[key]), form.draft]) {
    for (const field of definition.fields) if (field.type !== 'page_break' && !columns.some(column => column.id === field.id)) columns.push(field);
  }
  const fieldIn = (row, id) => versions[row.form_version]?.fields.find(candidate => candidate.id === id);
  const cell = (row, column) => answerText(fieldIn(row, column.id) || column, row.answers[column.id]);
  const shortLabel = label => label.replace(/\{\{.*?\}\}/g, '…').slice(0, 60);

  const draw = () => {
    const attentionRows = context ? rows.filter(row => trailOf(row).attention.length) : [];
    const shown = filter === 'attention' ? attentionRows : rows;
    mount($('#responses'), rows.length ? html`<div class="trail-filter" role="group" aria-label="Show responses">
        <button class="btn btn-small" type="button" data-filter="all" aria-pressed="${filter === 'all'}">All loaded (${rows.length})</button>
        <button class="btn btn-small" type="button" data-filter="attention" aria-pressed="${filter === 'attention'}" ${context ? '' : raw('aria-disabled="true"')}>Needs attention${context ? ` (${attentionRows.length})` : ''}</button>
        <span class="muted" role="status">${context ? html`Needs attention means a booking problem, a failed or retrying follow-up, an undelivered email, an overdue task, or an open task without a deadline.${context.capped ? ' Based on the latest 200 runs and tasks.' : ''}` : 'Checking follow-ups…'}</span></div>
      ${shown.length ? html`<div class="table-wrap"><table><caption class="visually-hidden">Responses to ${form.draft.title}</caption>
      <thead><tr><th scope="col">Submitted</th><th scope="col">Next step</th>${columns.map(column => html`<th scope="col">${shortLabel(column.label)}</th>`)}</tr></thead>
      <tbody>${shown.map(row => html`<tr><td class="submitted-cell">${fmtDateTime(row.created_at)}<div class="muted">Version ${row.form_version}</div>
          <button class="btn btn-small" data-view-response="${row.id}">View<span class="visually-hidden"> response from ${fmtDateTime(row.created_at)}</span></button></td>
        <td>${stepBadge(row.next_step)}${trailOf(row)?.attention.length ? html`<div class="attention-note">Needs attention: ${trailOf(row).attention.join('; ')}</div>` : ''}</td>${columns.map(column => html`<td class="answer-cell">${cell(row, column) || html`<span class="muted">—</span>`}</td>`)}</tr>`)}</tbody></table></div>
      ${more ? html`<div class="actions"><button class="btn" id="more">Load older responses</button></div>` : ''}`
      : html`<div class="empty"><h2>Nothing needs attention</h2><p>None of the loaded responses has a booking problem, a failed follow-up or an open follow-up task.</p></div>`}`
    : html`<div class="empty"><h2>No responses yet</h2><p>${form.published_version ? 'Share the form link to start collecting responses.' : 'Publish the form to start collecting responses.'}</p></div>`);
  };

  let openRow = null;
  const showDetail = (row, { focus = true } = {}) => {
    openRow = row.id;
    const definition = versions[row.form_version];
    const fields = (definition?.fields || []).filter(field => field.type !== 'page_break');
    const answered = new Set(Object.keys(row.answers));
    const extra = columns.filter(column => answered.has(column.id) && !fields.some(field => field.id === column.id));
    mount($('#response-detail'), html`<section class="card" aria-labelledby="detail-title"><div class="row-between"><h2 id="detail-title" tabindex="-1">Response from ${fmtDateTime(row.created_at)}</h2><button class="btn btn-small" id="close-detail">Close</button></div>
      <p class="muted">Receipt ${row.id.replace(/-/g, '').slice(0, 8).toUpperCase()} · Answered version ${row.form_version}${form.published_version && form.published_version !== row.form_version ? ` (live version is ${form.published_version})` : ''}</p>
      ${context ? trailList(trailOf(row)) : html`<p class="muted" role="status">Checking what happened next…</p>`}
      <dl class="response-answers">${[...fields, ...extra].map(field => html`<dt>${pipe(field.label, definition || { fields: [] }, row.answers)}</dt><dd>${answerText(field, row.answers[field.id]) || html`<span class="muted">Not answered or not shown</span>`}</dd>`)}</dl>
      ${isAdmin() ? html`<div class="actions"><button class="btn btn-danger btn-small" data-delete="${row.id}">Delete this response</button></div>` : ''}</section>`);
    if (focus) $('#detail-title').focus();
  };

  mount(ctx.main, html`<div class="container page" id="responses-page"><a href="/forms/${form.id}">← Back to form</a>
    <div class="row-between"><h1>Responses</h1><button class="btn btn-primary" id="export">Export CSV</button></div>
    <p class="muted">${form.draft.title} · ${form.response_count} total · kept for ${workspace().retention_days || 365} days under your workspace retention setting. <a href="/enquiries?from=response">See enquiries across all forms and bookings</a>.</p>
    <div id="export-status" tabindex="-1"></div>
    <div id="response-detail"></div>
    <div id="responses"></div></div>`);
  draw();
  loadTrailContext().then(loaded => {
    if (!ctx.alive()) return;
    context = loaded;
    draw();
    if (openRow && $('#detail-title')) { const row = rows.find(item => item.id === openRow); if (row) showDetail(row, { focus: false }); } // refresh without moving focus
  });

  // The export is fetched here so a failure is shown with a retry instead of downloading an error page.
  $('#export').onclick = async () => {
    const button = $('#export');
    button.setAttribute('aria-disabled', 'true');
    mount($('#export-status'), html`<p class="muted" role="status">Preparing export…</p>`);
    try {
      const response = await fetch(wsPath(`/forms/${form.id}/responses.csv`), { credentials: 'same-origin', signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(response.status === 404 || response.status === 403 ? 'You no longer have access to export these responses.' : 'The export could not be created.');
      const url = URL.createObjectURL(await response.blob());
      const link = Object.assign(document.createElement('a'), { href: url, download: `${form.slug}-responses.csv` });
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      mount($('#export-status'), html`<p class="muted" role="status">Export downloaded. It includes every response, with the form version each one answered.</p>`);
    } catch (error) {
      mount($('#export-status'), notice('bad', html`<p>${error.name === 'TimeoutError' || error instanceof TypeError ? 'The export did not finish. Check your connection.' : error.message}</p><button class="btn btn-small" type="button" id="retry-export">Try again</button>`));
      $('#retry-export').onclick = () => $('#export').click();
      $('#export-status').focus();
    } finally { button.removeAttribute('aria-disabled'); }
  };

  $('#responses-page').addEventListener('click', async event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.id === 'more') {
      try {
        const older = await api('GET', wsPath(`/forms/${form.id}/responses?before=${rows[rows.length - 1].created_at}`));
        rows = rows.concat(older.responses);
        more = older.responses.length === 50;
        draw();
      } catch (error) { toast(`Older responses could not be loaded. ${error.message}`); }
      return;
    }
    if (target.dataset.filter) {
      if (target.getAttribute('aria-disabled') === 'true') return;
      filter = target.dataset.filter;
      draw();
      return $(`[data-filter="${filter}"]`)?.focus();
    }
    if (target.id === 'close-detail') { $('#response-detail').innerHTML = ''; return $(`[data-view-response="${openRow}"]`)?.focus(); }
    if (target.dataset.viewResponse) return showDetail(rows.find(row => row.id === target.dataset.viewResponse));
    const id = target.dataset.delete;
    if (!id || !(await ask({ title: 'Delete this response?', body: 'It is removed permanently from this inbox and from future exports. Exports already downloaded are not changed. Deleting does not restore your monthly response allowance, and it does not cancel a booking made from this response.', confirm: 'Delete response', danger: true }))) return;
    try {
      await api('DELETE', wsPath(`/forms/${form.id}/responses/${id}`));
      rows = rows.filter(row => row.id !== id);
      $('#response-detail').innerHTML = '';
      draw();
      toast('Response deleted.');
      $('#export')?.focus();
    } catch (error) { toast(error.message); }
  });
}
