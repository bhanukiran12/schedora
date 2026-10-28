// Persisted LIVE workspace onboarding for Meet, Forms and Flow.
// Uses real authenticated workspace APIs, preserves progress across refresh and sign-in, and
// derives readiness strictly from actual saved database records. Never auto-publishes events or
// forms, never auto-enables flows, never grants entitlements, and never calls skipped optional
// integrations verified.
import { $, $$, api, badge, boot, errorBlock, handleSubmit, html, isAdmin, loading, mount, notice, raw, session, toast, workspace, wsPath, zoneOptions } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';
import { PRODUCT_INFO } from './products.mjs';
import { assessReadiness } from './meet-readiness.mjs';
import { assessFormReadiness } from './forms-readiness.mjs';
import { readinessAreas } from './readiness-view.mjs';
import { FORM_TEMPLATES } from './forms-templates.mjs';
import { FLOW_STARTERS } from './flow-starters.mjs';
import { definitionProblems, visibleFields } from '/shared/forms-logic.mjs';

const DAYS = [['1', 'Mon'], ['2', 'Tue'], ['3', 'Wed'], ['4', 'Thu'], ['5', 'Fri'], ['6', 'Sat'], ['0', 'Sun']];
const minToClock = minutes => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
const clockToMin = value => { const [h, m] = String(value || '09:00').split(':').map(Number); return (h * 60) + (m || 0); };

function firstStepFor(product) {
  if (product === 'meet') return 'calendar';
  if (product === 'forms') return 'form';
  if (product === 'flow') return 'flow';
  return 'products';
}

function orderedSteps(selectedProducts, includeProductsStep) {
  const steps = [];
  if (includeProductsStep) steps.push({ key: 'products', product: 'suite', label: 'Choose products' });
  if (selectedProducts.includes('meet')) {
    steps.push({ key: 'calendar', product: 'meet', label: 'Meet · Calendar (optional)' });
    steps.push({ key: 'availability', product: 'meet', label: 'Meet · Availability & draft event' });
  }
  if (selectedProducts.includes('forms')) {
    steps.push({ key: 'form', product: 'forms', label: 'Forms · Draft form' });
  }
  if (selectedProducts.includes('flow')) {
    steps.push({ key: 'flow', product: 'flow', label: 'Flow · Draft workflow' });
  }
  steps.push({ key: 'review', product: 'suite', label: 'Readiness & next steps' });
  return steps;
}

function nextStepAfter(currentStep, selectedProducts) {
  const list = orderedSteps(selectedProducts, false).map(item => item.key);
  const index = list.indexOf(currentStep);
  return index >= 0 && index + 1 < list.length ? list[index + 1] : 'review';
}

function stepStatusSummary(stepKey, state) {
  const { records } = state;
  if (stepKey === 'products') return `${state.selected_products.map(key => PRODUCT_INFO[key].name).join(', ')}`;
  if (stepKey === 'calendar') {
    if (records.meet.connections.length) return records.meet.connections.every(c => c.status === 'active' && c.last_success_at) ? 'Busy times checked' : 'Calendar check needed';
    if (state.meet_calendar_skipped) return 'Skipped · not verified';
    return 'Optional';
  }
  if (stepKey === 'availability') {
    if (!records.meet.event_type) return 'No event type yet';
    return records.meet.event_type.published ? 'Published' : 'Draft saved';
  }
  if (stepKey === 'form') {
    if (!records.forms.form) return 'No form yet';
    return records.forms.form.published_version != null ? 'Published' : 'Draft saved';
  }
  if (stepKey === 'flow') {
    if (!records.flow.flow) return 'No workflow yet';
    return records.flow.flow.status === 'enabled' ? 'Enabled' : records.flow.flow.status === 'paused' ? 'Paused' : 'Draft saved';
  }
  if (stepKey === 'review') return state.completed_at ? 'Reviewed' : 'Check readiness';
  return '';
}

export async function liveOnboarding(ctx) {
  const routeProd = ctx.params[0] || (ctx.product !== 'suite' ? ctx.product : null);
  const effectiveProduct = routeProd || ctx.product || 'suite';
  const info = PRODUCT_INFO[effectiveProduct] || PRODUCT_INFO.suite;
  setTitle(`Guided setup · ${info.name}${effectiveProduct === 'suite' ? '' : ' by Schedora'}`);

  if (!session.user) {
    return mount(ctx.main, signInPrompt(ctx, {
      product: effectiveProduct,
      title: `Set up ${info.name}`,
      lead: 'Sign in or create an account to save your live workspace setup. Progress is saved to your workspace across refreshes and devices.'
    }));
  }
  if (!needsSession(ctx)) return;
  const ws = workspace();
  mount(ctx.main, html`<div class="container page">${loading('Loading your saved workspace setup…')}</div>`);

  let state;
  try {
    state = await api('GET', wsPath('/onboarding'));
    const requestedStep = ctx.query.get('step');
    if (!state.started && routeProd) {
      state = await api('PATCH', wsPath('/onboarding'), {
        selected_products: [routeProd],
        active_product: routeProd,
        active_step: requestedStep || firstStepFor(routeProd)
      });
    } else if (routeProd && (!state.selected_products.includes(routeProd) || state.active_product !== routeProd || requestedStep)) {
      const merged = ['meet', 'forms', 'flow'].filter(key => state.selected_products.includes(key) || key === routeProd);
      state = await api('PATCH', wsPath('/onboarding'), {
        selected_products: merged,
        active_product: routeProd,
        active_step: requestedStep || (state.active_product === routeProd ? state.active_step : firstStepFor(routeProd))
      });
    } else if (requestedStep) {
      state = await api('PATCH', wsPath('/onboarding'), { active_step: requestedStep });
    }
  } catch (error) {
    if (ctx.alive()) mount(ctx.main, html`<div class="container page">${errorBlock(error)}</div>`);
    return;
  }
  if (!ctx.alive()) return;

  const isSuiteView = !routeProd && effectiveProduct === 'suite';
  let simulationNote = null;

  const saveState = async patch => {
    state = await api('PATCH', wsPath('/onboarding'), patch);
    draw();
  };

  const draw = () => {
    const steps = orderedSteps(state.selected_products, isSuiteView || state.selected_products.length > 1);
    const validKeys = steps.map(item => item.key);
    const currentStep = validKeys.includes(state.active_step)
      ? state.active_step
      : (isSuiteView && !state.started ? 'products' : validKeys[0]);

    mount(ctx.main, html`<div class="container page live-onboarding" id="live-onboarding">
      <div class="row-between">
        <div>
          <span class="tag" id="live-setup-badge">${info.name} · Live workspace setup</span>
          <h1>Set up ${isSuiteView ? ws.name : info.name}</h1>
          <p class="lead">Saved directly to <strong>${ws.name}</strong>. Refresh or sign in from another browser to pick up where you left off. Draft event types, forms and workflows stay unpublished or disabled until you choose to make them live.</p>
        </div>
        <div class="actions">
          <a class="btn btn-small" href="${effectiveProduct === 'suite' ? '/enquiries' : PRODUCT_INFO[effectiveProduct].dashboard}">Go to ${effectiveProduct === 'suite' ? 'workspace' : info.name}</a>
          <a class="btn btn-small btn-quiet" href="${effectiveProduct === 'suite' ? '/start' : '/start/' + effectiveProduct}">Browser-only demo setup</a>
        </div>
      </div>

      <nav class="tabs section-gap" aria-label="Live setup steps">
        ${steps.map(step => html`<button type="button" data-setup-step="${step.key}" ${step.key === currentStep ? raw('aria-current="step"') : ''}>
          <span>${step.label}</span>
          <small class="step-pill-meta"> · ${stepStatusSummary(step.key, state)}</small>
        </button>`)}
      </nav>

      <div id="live-setup-panel" class="section-gap">
        ${renderStep(currentStep)}
      </div>
    </div>`);

    bindEvents(currentStep);
  };

  function renderStep(step) {
    if (step === 'products') return renderProductsStep();
    if (step === 'calendar') return renderCalendarStep();
    if (step === 'availability') return renderAvailabilityStep();
    if (step === 'form') return renderFormStep();
    if (step === 'flow') return renderFlowStep();
    return renderReviewStep();
  }

  function renderProductsStep() {
    const cards = [
      ['meet', 'Meet · Scheduling', 'Set your working hours, optional calendar conflict checking and a draft event type.', state.records.meet.event_type ? `Saved: “${state.records.meet.event_type.title}” (${state.records.meet.event_type.published ? 'Published' : 'Draft'})` : 'No event type saved yet'],
      ['forms', 'Forms · Intake & routing', 'Create an unpublished draft form from a goal template or blank starting point.', state.records.forms.form ? `Saved: “${state.records.forms.form.draft.title}” (${state.records.forms.form.published_version != null ? 'Published' : 'Draft'})` : 'No form saved yet'],
      ['flow', 'Flow · Follow-up automation', 'Create a draft follow-up task or email rule and test it with a safe simulation.', state.records.flow.flow ? `Saved: “${state.records.flow.flow.name}” (${state.records.flow.flow.status})` : 'No workflow saved yet']
    ];
    return html`<form class="card card-plain" id="live-product-selection" novalidate>
      <h2>Choose which products to set up in ${ws.name}</h2>
      <p class="muted">Select one, two or all three products. Choosing products here organises your setup steps; it does not purchase a plan or change workspace entitlements.</p>
      <fieldset class="choice-list">
        <legend class="visually-hidden">Products to set up</legend>
        ${cards.map(([key, title, desc, savedNote]) => html`<label class="check" for="setup-prod-${key}">
          <input id="setup-prod-${key}" type="checkbox" name="product_${key}" value="${key}" ${state.selected_products.includes(key) ? raw('checked') : ''}>
          <span><strong>${title}</strong><span class="hint">${desc}</span><small class="muted">${savedNote}</small></span>
        </label>`)}
      </fieldset>
      <div data-form-status tabindex="-1"></div>
      <div class="actions">
        <button class="btn btn-primary" type="submit">Save product selection & continue</button>
        <button class="btn" type="button" id="select-all-live-products">Select all three</button>
      </div>
    </form>`;
  }

  function renderCalendarStep() {
    const { connections, integrations } = state.records.meet;
    const google = integrations.find(item => item.provider === 'google' && item.user_id === session.user.id);
    const microsoft = integrations.find(item => item.provider === 'microsoft' && item.user_id === session.user.id);
    return html`<div class="grid-2">
      <section class="card card-plain">
        <h2>Connect a calendar (optional)</h2>
        <p class="muted">Connecting a calendar lets Meet check your busy times before offering slots. This step is optional: you can skip it now and connect a calendar later.</p>
        ${connections.length ? html`<div class="notice ${connections.every(c => c.status === 'active' && c.last_success_at) ? 'notice-ok' : 'notice-warn'}"><p><strong>Calendar connections (${connections.length}):</strong> ${connections.map(c => `${c.label || c.provider} (${c.status}${c.last_success_at ? '; successful check recorded' : '; successful check not verified'})`).join(', ')}.</p></div>`
          : state.meet_calendar_skipped ? notice('warn', html`<p><strong>Calendar connection skipped (not verified):</strong> No external calendar is connected. External conflicts are not checked; only Schedora bookings in ${ws.name} are checked.</p>`)
          : notice('info', html`<p><strong>No external calendar connected yet.</strong> Connect an ICS feed or OAuth calendar below, or skip this optional step.</p>`)}

        <form id="live-calendar-form" novalidate>
          <label for="live-ics-url">Calendar feed address (ICS URL or webcal://)</label>
          <span class="hint" id="live-ics-hint">Read-only busy-time check from Google, Outlook or Apple Calendar.</span>
          <input id="live-ics-url" name="url" required placeholder="https://calendar.google.com/calendar/ical/.../basic.ics" aria-describedby="live-ics-hint">
          <label for="live-ics-label">Calendar label (optional)</label>
          <input id="live-ics-label" name="label" maxlength="80" placeholder="Work calendar">
          <div data-form-status tabindex="-1"></div>
          <div class="actions">
            <button class="btn" type="submit">Connect ICS feed</button>
            ${connections.length ? html`<button class="btn btn-danger" type="button" id="disconnect-live-calendar">Disconnect calendar</button>` : ''}
          </div>
        </form>
        <hr>
        <h3>OAuth calendar accounts</h3>
        <p class="hint">Google Calendar: ${google ? badge(google.status === 'active' ? 'ok' : 'warn', google.status) : badge('neutral', 'not connected')} · Microsoft Outlook: ${microsoft ? badge(microsoft.status === 'active' ? 'ok' : 'warn', microsoft.status) : badge('neutral', 'not connected')}</p>
        <div class="actions">
          <a class="btn btn-small" href="/meet?tab=integrations">Open full Calendars & apps settings</a>
        </div>
      </section>

      <section class="card card-plain">
        <h2>Continue setup</h2>
        <p class="muted">Whether you connect a calendar now or skip this step, your choice is saved to ${ws.name} and reflected honestly in your readiness summary.</p>
        <div class="actions">
          ${connections.length
            ? html`<button class="btn btn-primary" type="button" id="continue-from-calendar">Continue to availability →</button>`
            : html`<button class="btn btn-primary" type="button" id="skip-live-calendar">Skip calendar for now (not verified) →</button>
                   <button class="btn" type="button" id="continue-from-calendar">Continue to availability →</button>`}
        </div>
      </section>
    </div>`;
  }

  function renderAvailabilityStep() {
    const existingEvent = state.records.meet.event_type;
    const schedule = state.records.meet.schedule;
    const rules = existingEvent?.rules?.length ? existingEvent.rules : schedule?.rules?.length ? schedule.rules : [1, 2, 3, 4, 5].map(weekday => ({ weekday, start_min: 540, end_min: 1020 }));
    const tz = existingEvent?.timezone || schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
    const currentLocation = existingEvent?.locations?.[0]?.type || 'phone_host_calls';
    const byDay = new Map(rules.map(rule => [String(rule.weekday), rule]));

    return html`<form class="card card-plain" id="live-meet-form" novalidate>
      <h2>Availability & first draft event type</h2>
      <p class="muted">${existingEvent
        ? `Updating saved event type “${existingEvent.title}” (${existingEvent.published ? 'currently Published' : 'Saved as Draft — not published'}).`
        : 'Saves your weekly working hours and creates a real draft event type in your workspace. It stays unpublished until you publish it.'}</p>

      <div class="grid-2">
        <fieldset>
          <legend>Weekly working hours</legend>
          <label for="live-timezone">Time zone</label>
          <select id="live-timezone" name="timezone">${zoneOptions(tz)}</select>
          <div class="stack section-gap">
            ${DAYS.map(([day, label]) => {
              const rule = byDay.get(day);
              return html`<div class="row">
                <label class="check" for="live-day-${day}"><input id="live-day-${day}" type="checkbox" name="day_${day}" ${rule ? raw('checked') : ''}> ${label}</label>
                <label class="visually-hidden" for="live-start-${day}">${label} start time</label>
                <input id="live-start-${day}" type="time" name="start_${day}" value="${rule ? minToClock(rule.start_min) : '09:00'}">
                <span aria-hidden="true">to</span>
                <label class="visually-hidden" for="live-end-${day}">${label} end time</label>
                <input id="live-end-${day}" type="time" name="end_${day}" value="${rule ? minToClock(rule.end_min) : '17:00'}">
              </div>`;
            })}
          </div>
        </fieldset>

        <fieldset>
          <legend>First event type (saved as draft)</legend>
          <label for="live-event-title">Event title</label>
          <input id="live-event-title" name="title" required maxlength="120" value="${existingEvent?.title || 'Introductory call'}">
          <label for="live-event-duration">Duration (minutes)</label>
          <select id="live-event-duration" name="duration_min">
            ${[15, 30, 45, 60].map(min => html`<option value="${min}" ${(existingEvent?.duration_min || 30) === min ? raw('selected') : ''}>${min} minutes</option>`)}
          </select>
          <label for="live-event-location">Location</label>
          <select id="live-event-location" name="location_type">
            ${[['phone_host_calls', 'Phone call (you call the invitee)'], ['custom', 'Meeting link or details shared after booking'], ['in_person', 'In person'], ['google_meet', 'Google Meet (requires Google connection)']].map(([val, text]) => html`<option value="${val}" ${currentLocation === val ? raw('selected') : ''}>${text}</option>`)}
          </select>
          <label for="live-event-description">Description (optional)</label>
          <textarea id="live-event-description" name="description" maxlength="1000">${existingEvent?.description || 'A short conversation to understand your goals and agree on next steps.'}</textarea>
        </fieldset>
      </div>
      <div data-form-status tabindex="-1"></div>
      <div class="actions">
        <button class="btn btn-primary" type="submit">${existingEvent ? 'Save availability & event type →' : 'Save hours & create draft event type →'}</button>
        <button class="btn" type="button" data-setup-step="calendar">← Back to calendar</button>
      </div>
    </form>`;
  }

  function renderFormStep() {
    const existingForm = state.records.forms.form;
    return html`<form class="card card-plain" id="live-forms-form" novalidate>
      <h2>${existingForm ? `Update draft form “${existingForm.draft.title}”` : 'Create your first draft form'}</h2>
      <p class="muted">${existingForm
        ? `Saved revision ${existingForm.revision} (${existingForm.published_version != null ? `Live version ${existingForm.published_version}` : 'Unpublished draft — not publicly reachable'}). Saving here updates the draft only and never publishes automatically.`
        : 'Choose a goal template or start with a simple intake form. This creates a real unpublished draft in your workspace.'}</p>

      ${existingForm ? '' : html`<label for="live-form-template">Starting point</label>
        <select id="live-form-template" name="template_id">
          ${FORM_TEMPLATES.map(tpl => html`<option value="${tpl.id}">${tpl.name} — ${tpl.purpose}</option>`)}
          <option value="blank">Simple contact & enquiry form (3 questions)</option>
        </select>`}

      <label for="live-form-title">Form title</label>
      <input id="live-form-title" name="title" required maxlength="120" value="${existingForm?.draft?.title || FORM_TEMPLATES[0].definition.title}">

      <label for="live-form-description">Description</label>
      <textarea id="live-form-description" name="description" maxlength="500">${existingForm?.draft?.description || FORM_TEMPLATES[0].definition.description}</textarea>

      <label for="live-form-presentation">Presentation style</label>
      <select id="live-form-presentation" name="presentation">
        <option value="classic" ${(existingForm?.draft?.presentation || 'classic') === 'classic' ? raw('selected') : ''}>Classic (questions grouped on a page)</option>
        <option value="conversational" ${existingForm?.draft?.presentation === 'conversational' ? raw('selected') : ''}>Conversational (one question at a time)</option>
      </select>

      <div data-form-status tabindex="-1"></div>
      <div class="actions">
        <button class="btn btn-primary" type="submit">${existingForm ? 'Save draft form & continue →' : 'Create unpublished draft form →'}</button>
        ${existingForm ? html`<a class="btn" href="/forms/${existingForm.id}">Open in Form Builder</a>` : ''}
      </div>
    </form>`;
  }

  function renderFlowStep() {
    const existingFlow = state.records.flow.flow;
    if (!isAdmin()) {
      return html`<section class="card card-plain">
        <h2>Flow · Follow-up automation</h2>
        ${notice('info', html`<p>Only workspace owners and administrators can create or edit workflows. Your role in ${ws.name} is <strong>${state.role}</strong>.</p>`)}
        <div class="actions"><button class="btn btn-primary" type="button" data-setup-step="review">Continue to readiness review →</button></div>
      </section>`;
    }
    const starter = FLOW_STARTERS[0];
    return html`<form class="card card-plain" id="live-flow-form" novalidate>
      <h2>${existingFlow ? `Update workflow “${existingFlow.name}”` : 'Create a draft follow-up workflow'}</h2>
      <p class="muted">${existingFlow
        ? `Current status: ${existingFlow.status} (${existingFlow.status === 'draft' ? 'ignores live events until enabled in the Flow Editor' : existingFlow.status}). Saving here never enables a draft workflow automatically.`
        : 'Choose a supported trigger and follow-up action. The workflow is saved as a Draft (status: draft) and will not run until you enable it.'}</p>

      ${existingFlow ? '' : html`<label for="live-flow-starter">Starter template</label>
        <select id="live-flow-starter" name="starter_id">
          ${FLOW_STARTERS.map(item => html`<option value="${item.id}">${item.name} — ${item.description}</option>`)}
        </select>`}

      <label for="live-flow-name">Workflow name</label>
      <input id="live-flow-name" name="name" required maxlength="120" value="${existingFlow?.name || starter.name}">

      <div class="grid-2">
        <div>
          <label for="live-flow-trigger">When this happens (trigger)</label>
          <select id="live-flow-trigger" name="trigger_type">
            <option value="meet.booking.created" ${(existingFlow?.trigger_type || starter.trigger_type) === 'meet.booking.created' ? raw('selected') : ''}>A Meet booking is confirmed (meet.booking.created)</option>
            <option value="forms.response.created" ${existingFlow?.trigger_type === 'forms.response.created' ? raw('selected') : ''}>A Form response is submitted (forms.response.created)</option>
          </select>
        </div>
        <div>
          <label for="live-flow-action">Do this (action)</label>
          <select id="live-flow-action" name="action_type">
            <option value="task" ${(existingFlow?.action_type || starter.action_type) === 'task' ? raw('selected') : ''}>Create a follow-up task</option>
            <option value="email" ${existingFlow?.action_type === 'email' ? raw('selected') : ''}>Send an email</option>
          </select>
        </div>
      </div>

      <label for="live-flow-title">Task title or email subject</label>
      <input id="live-flow-title" name="title_or_subject" required maxlength="200" value="${existingFlow ? (existingFlow.action_config.title || existingFlow.action_config.subject || '') : starter.action_config.title}">

      <label for="live-flow-details">Task details or email body</label>
      <textarea id="live-flow-details" name="details_or_body" required maxlength="2000">${existingFlow ? (existingFlow.action_config.details || existingFlow.action_config.body || '') : starter.action_config.details}</textarea>

      <div data-form-status tabindex="-1"></div>
      <div class="actions">
        <button class="btn btn-primary" type="submit">${existingFlow ? 'Save workflow & continue →' : 'Create draft workflow & continue →'}</button>
        ${existingFlow ? html`<a class="btn" href="/flow/${existingFlow.id}">Open in Flow Editor</a>` : ''}
      </div>
    </form>`;
  }

  function renderReviewStep() {
    const { meet, forms, flow } = state.records;
    const entitlements = state.entitlements;

    let meetSection = '';
    if (state.selected_products.includes('meet')) {
      if (meet.event_type) {
        const readiness = assessReadiness({
          type: meet.event_type,
          viewer: { id: session.user.id, admin: isAdmin() },
          flags: {
            videoEnabled: Boolean(boot.video?.enabled),
            emailProvider: boot.providers?.email || 'outbox',
            testPayments: Boolean(boot.allowTestPayments),
            meetActive: Boolean(entitlements?.meet?.active)
          },
          slots: meet.slots ? { ok: true, value: meet.slots } : { ok: false, error: new Error('Slots not loaded') },
          calendar: { ok: true, value: { connections: meet.connections } },
          integrations: { ok: true, value: meet.integrations }
        });
        meetSection = html`<section class="card card-plain" id="live-ready-meet">
          <div class="row-between">
            <div>
              <span class="tag">Meet readiness · Saved record</span>
              <h2>${meet.event_type.title} ${badge(meet.event_type.published ? 'ok' : 'neutral', meet.event_type.published ? 'Published' : 'Draft (not published)')}</h2>
            </div>
            <div class="row">
              <a class="btn btn-small btn-primary" href="/meet/event-types/${meet.event_type.id}">Open in Event Type Editor</a>
              <a class="btn btn-small" href="/meet/${ws.slug}/${meet.event_type.slug}">Preview booking page</a>
              <button class="btn btn-small" type="button" data-setup-step="availability">Edit Meet setup</button>
            </div>
          </div>
          ${!meet.connections.length && state.meet_calendar_skipped
            ? notice('warn', html`<p><strong>Optional calendar step skipped (not verified):</strong> You skipped connecting an external calendar. External busy times are not checked; only Schedora meetings in ${ws.name} are checked.</p>`)
            : ''}
          ${readinessAreas(readiness)}
        </section>`;
      } else {
        meetSection = html`<section class="card card-plain" id="live-ready-meet">
          <span class="tag">Meet readiness</span>
          <h2>No event type saved yet</h2>
          <p class="muted">Create your first draft event type and working hours to see live Meet readiness.</p>
          <div class="actions"><button class="btn btn-primary" type="button" data-setup-step="availability">Set up Meet availability & event</button></div>
        </section>`;
      }
    }

    let formsSection = '';
    if (state.selected_products.includes('forms')) {
      if (forms.form) {
        const formReadiness = assessFormReadiness({
          form: forms.form,
          live: null,
          eventTypes: { ok: true, value: meet.event_types },
          publishCheck: forms.publish_check ? { ok: true, value: forms.publish_check } : null,
          viewer: { admin: isAdmin() },
          flags: { formsActive: Boolean(entitlements?.forms?.active), meetActive: Boolean(entitlements?.meet?.active) },
          baseUrl: location.origin,
          logic: { definitionProblems, visibleFields }
        });
        formsSection = html`<section class="card card-plain section-gap" id="live-ready-forms">
          <div class="row-between">
            <div>
              <span class="tag">Forms readiness · Saved record</span>
              <h2>${forms.form.draft.title} ${badge(forms.form.published_version != null ? 'ok' : 'neutral', forms.form.published_version != null ? `Published v${forms.form.published_version}` : 'Draft (not published)')}</h2>
            </div>
            <div class="row">
              <a class="btn btn-small btn-primary" href="/forms/${forms.form.id}">Open in Form Builder</a>
              <button class="btn btn-small" type="button" data-setup-step="form">Edit Forms setup</button>
            </div>
          </div>
          ${readinessAreas(formReadiness)}
        </section>`;
      } else {
        formsSection = html`<section class="card card-plain section-gap" id="live-ready-forms">
          <span class="tag">Forms readiness</span>
          <h2>No form saved yet</h2>
          <p class="muted">Create an unpublished draft form to see live Forms readiness and server publish checks.</p>
          <div class="actions"><button class="btn btn-primary" type="button" data-setup-step="form">Create a draft form</button></div>
        </section>`;
      }
    }

    let flowSection = '';
    if (state.selected_products.includes('flow')) {
      if (flow.flow) {
        const publishedEvents = meet.event_types.filter(item => item.published).length;
        const publishedForms = forms.forms.filter(item => item.published_version != null).length;
        const triggerSourceReady = flow.flow.trigger_type === 'meet.booking.created' ? publishedEvents > 0 : publishedForms > 0;
        flowSection = html`<section class="card card-plain section-gap" id="live-ready-flow">
          <div class="row-between">
            <div>
              <span class="tag">Flow readiness · Saved record</span>
              <h2>${flow.flow.name} ${badge(flow.flow.status === 'enabled' ? 'ok' : 'neutral', flow.flow.status === 'enabled' ? 'Enabled' : `${flow.flow.status} (not enabled)`)}</h2>
            </div>
            <div class="row">
              <a class="btn btn-small btn-primary" href="/flow/${flow.flow.id}">Open in Flow Editor</a>
              <button class="btn btn-small" type="button" id="live-simulate-flow">Run safe simulation</button>
              ${isAdmin() ? html`<button class="btn btn-small" type="button" data-setup-step="flow">Edit Flow setup</button>` : ''}
            </div>
          </div>
          <ul class="readiness-items section-gap">
            <li data-state="${flow.flow.status === 'enabled' ? 'ready' : 'attention'}">
              <span class="readiness-icon" aria-hidden="true">${flow.flow.status === 'enabled' ? '✓' : '!'}</span>
              <div><p><strong>Status (${flow.flow.status}):</strong> ${flow.flow.status === 'enabled'
                ? 'This workflow is enabled and runs when its trigger fires.'
                : 'Saved as a draft. Draft workflows ignore live events until you explicitly enable them in the Flow Editor.'}</p></div>
            </li>
            <li data-state="${triggerSourceReady ? 'ready' : 'attention'}">
              <span class="readiness-icon" aria-hidden="true">${triggerSourceReady ? '✓' : '!'}</span>
              <div><p><strong>Trigger source (${flow.flow.trigger_type}):</strong> ${flow.flow.trigger_type === 'meet.booking.created'
                ? `${publishedEvents} published event type(s), ${meet.event_types.length - publishedEvents} draft(s) in ${ws.name}.`
                : `${publishedForms} published form(s), ${forms.forms.length - publishedForms} draft(s) in ${ws.name}.`}</p></div>
            </li>
            <li data-state="${flow.flow.action_type === 'email' && boot.providers?.email === 'outbox' ? 'attention' : 'ready'}">
              <span class="readiness-icon" aria-hidden="true">${flow.flow.action_type === 'email' && boot.providers?.email === 'outbox' ? '!' : '✓'}</span>
              <div><p><strong>Action (${flow.flow.action_type}):</strong> ${flow.flow.action_type === 'task'
                ? `Creates a follow-up task “${flow.flow.action_config.title}”.`
                : `Queues an email “${flow.flow.action_config.subject}” (${boot.providers?.email === 'outbox' ? 'recorded in the local server outbox; not delivered to an inbox' : 'accepted by the configured email provider; acceptance does not prove inbox delivery'}).`}</p></div>
            </li>
          </ul>
          ${simulationNote ? notice('info', html`<p id="live-simulation-result"><strong>Safe simulation result (no email sent, no live task created):</strong> ${simulationNote}</p>`) : ''}
        </section>`;
      } else {
        flowSection = html`<section class="card card-plain section-gap" id="live-ready-flow">
          <span class="tag">Flow readiness</span>
          <h2>No workflow saved yet</h2>
          <p class="muted">Create a draft workflow to review its trigger, action and safe simulation.</p>
          <div class="actions"><button class="btn btn-primary" type="button" data-setup-step="flow">Create a draft workflow</button></div>
        </section>`;
      }
    }

    return html`${meetSection}${formsSection}${flowSection}
      <div class="card card-plain section-gap">
        <div class="row-between">
          <div>
            <h2>Finish or continue later</h2>
            <p class="muted">Your setup progress and draft records are saved in <strong>${ws.name}</strong>. Finishing setup never publishes events or forms, never enables workflows and never changes billing plans.</p>
          </div>
          <div class="actions">
            <button class="btn btn-primary" type="button" id="finish-live-setup">Save setup & go to ${effectiveProduct === 'suite' ? 'workspace' : info.name} →</button>
          </div>
        </div>
      </div>`;
  }

  function bindEvents(currentStep) {
    $$('[data-setup-step]').forEach(button => {
      button.onclick = () => saveState({ active_step: button.dataset.setupStep }).catch(err => toast(err.message));
    });

    if (currentStep === 'products' && $('#live-product-selection')) {
      $('#select-all-live-products').onclick = () => {
        $$('#live-product-selection input[type="checkbox"]').forEach(box => { box.checked = true; });
      };
      handleSubmit($('#live-product-selection'), async values => {
        const chosen = ['meet', 'forms', 'flow'].filter(key => values[`product_${key}`]);
        if (!chosen.length) throw new Error('Choose at least one product to set up.');
        await saveState({
          selected_products: chosen,
          active_product: chosen[0],
          active_step: firstStepFor(chosen[0])
        });
        toast('Product selection saved.');
      });
    }

    if (currentStep === 'calendar') {
      if ($('#live-calendar-form')) {
        handleSubmit($('#live-calendar-form'), async values => {
          const result = await api('POST', wsPath('/calendar'), { feed_url: values.url.trim(), label: values.label?.trim() || 'Work calendar' });
          const checked = result.connection?.status === 'active' && result.connection?.last_success_at;
          await saveState({ meet_calendar_skipped: false, active_step: checked ? 'availability' : 'calendar' });
          toast(checked ? 'Calendar connected and busy times checked.' : 'Calendar saved, but its busy-time check failed. Review it here or skip this optional step.');
        });
      }
      if ($('#disconnect-live-calendar')) {
        $('#disconnect-live-calendar').onclick = async () => {
          await api('DELETE', wsPath('/calendar'));
          state = await api('GET', wsPath('/onboarding'));
          draw();
          toast('Calendar disconnected.');
        };
      }
      if ($('#skip-live-calendar')) {
        $('#skip-live-calendar').onclick = () => saveState({ meet_calendar_skipped: true, active_step: 'availability' }).catch(err => toast(err.message));
      }
      if ($('#continue-from-calendar')) {
        $('#continue-from-calendar').onclick = () => saveState({ active_step: 'availability' }).catch(err => toast(err.message));
      }
    }

    if (currentStep === 'availability' && $('#live-meet-form')) {
      handleSubmit($('#live-meet-form'), async values => {
        const rules = [];
        for (const [day] of DAYS) {
          if (values[`day_${day}`]) {
            const startMin = clockToMin(values[`start_${day}`]);
            const endMin = clockToMin(values[`end_${day}`]);
            if (endMin <= startMin) throw new Error('End time must be after start time on each selected day.');
            rules.push({ weekday: Number(day), start_min: startMin, end_min: endMin });
          }
        }
        if (!rules.length) throw new Error('Select at least one working day.');
        const timezone = values.timezone || 'UTC';
        await api('PUT', wsPath('/schedule'), {
          timezone,
          rules,
          overrides: state.records.meet.schedule?.overrides || []
        });
        const locType = values.location_type || 'phone_host_calls';
        const locItem = locType === 'custom'
          ? { type: 'custom', value: 'Meeting details shared in confirmation.' }
          : locType === 'in_person'
            ? { type: 'in_person', value: 'In-person meeting (address shared in confirmation).' }
            : { type: locType };
        const payload = {
          title: values.title.trim(),
          duration_min: Number(values.duration_min) || 30,
          timezone,
          rules,
          locations: [locItem],
          description: values.description || ''
        };
        const existing = state.records.meet.event_type;
        const savedEvent = existing
          ? await api('PATCH', wsPath(`/event-types/${existing.id}`), payload)
          : await api('POST', wsPath('/event-types'), { ...payload, published: false });
        await saveState({
          meet_event_type_id: savedEvent.id,
          active_step: nextStepAfter('availability', state.selected_products)
        });
        toast(existing ? 'Availability and event type updated.' : 'Draft event type saved (unpublished).');
      });
    }

    if (currentStep === 'form' && $('#live-forms-form')) {
      const tplSelect = $('#live-form-template');
      if (tplSelect) {
        tplSelect.onchange = () => {
          const tpl = FORM_TEMPLATES.find(item => item.id === tplSelect.value);
          if (tpl) {
            $('#live-form-title').value = tpl.definition.title;
            $('#live-form-description').value = tpl.definition.description;
          } else {
            $('#live-form-title').value = 'Client enquiry';
            $('#live-form-description').value = 'Share a few details so we can help.';
          }
        };
      }
      handleSubmit($('#live-forms-form'), async values => {
        const existing = state.records.forms.form;
        let savedForm;
        if (existing) {
          const nextDraft = {
            ...existing.draft,
            title: values.title.trim(),
            description: values.description || '',
            presentation: values.presentation || 'classic'
          };
          savedForm = await api('PATCH', wsPath(`/forms/${existing.id}`), {
            title: nextDraft.title,
            definition: nextDraft,
            expected_revision: existing.revision
          });
        } else {
          const tpl = FORM_TEMPLATES.find(item => item.id === values.template_id);
          const baseDef = tpl ? structuredClone(tpl.definition) : {
            title: values.title.trim(),
            description: values.description || '',
            presentation: values.presentation || 'classic',
            submit_label: 'Send',
            fields: [
              { id: 'name', type: 'short_text', label: 'Your name', required: true },
              { id: 'email', type: 'email', label: 'Email address', required: true },
              { id: 'topic', type: 'long_text', label: 'How can we help?', required: true }
            ]
          };
          baseDef.title = values.title.trim();
          baseDef.description = values.description || '';
          baseDef.presentation = values.presentation || 'classic';
          savedForm = await api('POST', wsPath('/forms'), { title: baseDef.title, definition: baseDef });
        }
        await saveState({
          forms_form_id: savedForm.id,
          active_step: nextStepAfter('form', state.selected_products)
        });
        toast(existing ? 'Draft form updated (unpublished).' : 'Unpublished draft form created.');
      });
    }

    if (currentStep === 'flow' && $('#live-flow-form')) {
      const starterSelect = $('#live-flow-starter');
      if (starterSelect) {
        starterSelect.onchange = () => {
          const chosen = FLOW_STARTERS.find(item => item.id === starterSelect.value);
          if (!chosen) return;
          $('#live-flow-name').value = chosen.name;
          $('#live-flow-trigger').value = chosen.trigger_type;
          $('#live-flow-action').value = chosen.action_type;
          $('#live-flow-title').value = chosen.action_config.title || chosen.action_config.subject || '';
          $('#live-flow-details').value = chosen.action_config.details || chosen.action_config.body || '';
        };
      }
      handleSubmit($('#live-flow-form'), async values => {
        const actionType = values.action_type === 'email' ? 'email' : 'task';
        const actionConfig = actionType === 'email'
          ? { to: 'host', subject: values.title_or_subject.trim(), body: values.details_or_body.trim() }
          : { title: values.title_or_subject.trim(), details: values.details_or_body.trim() };
        const existing = state.records.flow.flow;
        const savedFlow = existing
          ? await api('PATCH', wsPath(`/flows/${existing.id}`), {
              name: values.name.trim(),
              trigger_type: values.trigger_type,
              action_type: actionType,
              action_config: actionConfig
            })
          : await api('POST', wsPath('/flows'), {
              name: values.name.trim(),
              trigger_type: values.trigger_type,
              action_type: actionType,
              action_config: actionConfig,
              status: 'draft'
            });
        await saveState({
          flow_id: savedFlow.id,
          active_step: 'review'
        });
        toast(existing ? 'Workflow updated.' : 'Draft workflow created (status: draft).');
      });
    }

    if (currentStep === 'review') {
      if ($('#live-simulate-flow') && state.records.flow.flow) {
        $('#live-simulate-flow').onclick = async () => {
          try {
            const sim = await api('POST', wsPath(`/flows/${state.records.flow.flow.id}/simulate`), {});
            simulationNote = sim.would_create_task
              ? `Would create task “${sim.would_create_task.title}” (${sim.sample_source === 'workspace' ? 'using latest workspace record' : 'using sample data'}).`
              : sim.would_send_email
                ? `Would queue email to ${sim.would_send_email.to || '(missing recipient)'}: “${sim.would_send_email.subject}”.`
                : 'Simulation completed.';
            draw();
          } catch (error) {
            toast(error.message);
          }
        };
      }
      if ($('#finish-live-setup')) {
        $('#finish-live-setup').onclick = async () => {
          await saveState({ completed: true });
          const dest = effectiveProduct !== 'suite'
            ? PRODUCT_INFO[effectiveProduct].dashboard
            : state.selected_products.length === 1
              ? PRODUCT_INFO[state.selected_products[0]].dashboard
              : '/enquiries';
          ctx.navigate(dest);
        };
      }
    }
  }

  draw();
}
