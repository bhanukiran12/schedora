import { $, $$, api, ask, badge, boot, errorBlock, fmtDateTime, html, isAdmin, loading, mount, notice, raw, session, toast, uid, workspace, wsPath } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';
import { buildTrail, responseTrailContext, STATE_LABELS } from './enquiry-trail.mjs';
import { assessFormReadiness, conditionSentence } from './forms-readiness.mjs';
import { readinessAreas } from './readiness-view.mjs';
import { hostInfo, productOrigin } from './context.mjs';
import { planTypeChange, replacementQuestion, typeChoices } from './forms-type-change.mjs';
import { dropSlot, moveMessage } from './forms-reorder.mjs';
import { exportDefinition } from './forms-import.mjs';
import { createdSource, draftAddress, mountStartingPoints } from './forms-picker.mjs';
import { openPrefillBuilder } from './forms-prefill.mjs';
import { copyTitle, filterForms, formStatus, STATUS_FILTERS, statusCounts } from './forms-list.mjs';

export const trailList = (trail, headingId = 'trail-heading') => html`<section class="trail" aria-labelledby="${headingId}"><h3 id="${headingId}">What happened next</h3>
  <ol class="trail-steps">${trail.steps.map(step => html`<li class="trail-step" data-state="${step.state}"><span class="trail-state">${STATE_LABELS[step.state]}</span><div>
    <strong>${step.title}</strong>${step.reference ? html` <span class="muted">· ${step.key === 'received' ? 'Receipt' : 'Ref'} ${step.reference}</span>` : ''}${step.at ? html` <span class="muted">· ${fmtDateTime(step.at)}</span>` : ''}
    ${step.key === 'run' ? html`<span class="muted"> · from the ${step.source}</span>` : ''}${step.due ? html` <span class="muted">· due ${fmtDateTime(step.due)}</span>` : ''}
    ${step.text ? html`<p>${step.text}</p>` : ''}
    ${step.key === 'run' ? html`<p class="trail-links"><a href="/flow/runs">Run history</a>${step.taskId ? html` · <a href="/flow/tasks">Tasks</a>` : ''}</p>`
      : step.key === 'booking' && step.reference ? html`<p class="trail-links"><a href="/meet?tab=meetings">Meetings</a></p>` : ''}</div></li>`)}</ol>
  ${trail.notes.map(note => html`<p class="hint">${note}</p>`)}</section>`;
import { blockEnd, canMove, contactInfoBlock, dropIsNoop, dropItem, duplicateBlock, isHead, moveItem, outlineMarks } from './forms-groups.mjs';
import { CLIENT_EVALUATOR, CONDITION_OPS, DESCRIPTION_LIMITS, FIELD_TYPES, VIDEO_PROVIDERS, URL_PARAM_LIMITS, answerText, attributionColumns, checkAnswer, choiceRuleConflicts, definitionProblems, dropHiddenChoices, formEnding, withEvaluationPolicy, formScreens, screenPage, parseVideoUrl, pipe, prefillAnswers, prefillProblem, pruneLogic, urlParamKeyProblem, urlParamValues, videoEmbedUrl, videoWatchUrl, visibleFields, visiblePages } from '/shared/forms-logic.mjs';
import { TYPE_KIND, formIcon } from './forms-icons.mjs';
import { designPanel } from './forms-design.mjs';
import { logicMapModel } from './forms-logicmap.mjs';
import { applyTheme } from './forms-themes.mjs';
import { addUrlParam, declaredParams, exampleLink, paramSourceValue, parseParamSource, removeUrlParam, setUrlParamRecorded, urlParamUses } from './forms-url-params.mjs';
import { defaultCondition, jumpSentence, jumpTargets, paramCondition, parseTarget, renameInLogic, rulesFor, setRules, targetValue } from './forms-jumps.mjs';
import { canHideChoices, choiceRuleSentence, choiceRuleSources, choiceRulesFor, dropChoiceRulesFor, dropOrphanChoiceRules, newChoiceRule, renameInChoiceRules, setChoiceRules } from './forms-choice-rules.mjs';

// The respondent link: the Forms host on the product domain, otherwise the address this page uses.
const formsOrigin = () => hostInfo(location.hostname, boot.productDomain).production ? productOrigin('forms', location, boot.productDomain) : location.origin;
const publicUrl = (form, mode) => `${formsOrigin()}/f/${form.slug}${mode ? '?mode=' + mode : ''}`;
// Loopback and private-network addresses only open on this computer or network.
const LOCAL_HOST = /^(localhost|127(\.\d+){3}|\[::1\]|0\.0\.0\.0|10(\.\d+){3}|192\.168(\.\d+){2}|172\.(1[6-9]|2\d|3[01])(\.\d+){2})$|\.(localhost|local)$/;
const isLocalLink = url => LOCAL_HOST.test(new URL(url).hostname);
const SUBMIT_TIMEOUT_MS = 20000;

// ---------------------------------------------------------------------------------------------
// Renderer shared by the builder preview and the public page.

// ---------------------------------------------------------------------------------------------
// Media shown with a question. Images come from this service only; a video is a click-to-load
// placeholder until the respondent chooses to load it, so nothing contacts the provider before then.

const publicAssetUrl = id => `/api/public/form-assets/${id}`;

function mediaFor(field, assetUrl, loadedVideos, labelText = field.label, embedVideo = true) {
  const media = field.media;
  if (media?.type === 'image') return html`<figure class="q-media" data-media-image><img src="${assetUrl(media.asset)}" alt="${media.decorative ? '' : media.alt}" loading="lazy" decoding="async">
    <figcaption class="q-media-failed" hidden>${media.decorative ? 'This image could not be loaded.' : `Image could not be loaded: ${media.alt}`}</figcaption></figure>`;
  if (media?.type !== 'video') return '';
  const provider = VIDEO_PROVIDERS[media.provider];
  const title = media.title || labelText;
  // Meeting pages keep a stricter content policy without third-party frames: link only.
  if (!embedVideo) return html`<div class="q-video" data-video="${field.id}"><p><strong>${provider} video</strong>: ${title}</p>
    <p class="hint"><a href="${videoWatchUrl(media)}" target="_blank" rel="noopener noreferrer" data-external>Open the video on ${provider}<span class="visually-hidden"> (opens in a new tab)</span></a>. During a meeting, videos open in a new tab. You can answer without watching it.</p></div>`;
  return html`<div class="q-video" data-video="${field.id}">${loadedVideos.has(field.id) ? videoFrame(media, title)
    : html`<div class="q-video-placeholder"><p><strong>${provider} video</strong>: ${title}</p><p class="hint">Loading it connects to ${provider}, which may set cookies and collect data under its own terms. Nothing is loaded until you choose.</p>
      <button class="btn btn-small" type="button" data-load-video="${field.id}">Load video from ${provider}<span class="visually-hidden">: ${title}</span></button></div>`}
    <p class="hint"><a href="${videoWatchUrl(media)}" target="_blank" rel="noopener noreferrer" data-external>Open the video on ${provider}<span class="visually-hidden"> (opens in a new tab)</span></a>. You can answer without watching it.</p></div>`;
}
const videoFrame = (media, title) => html`<iframe class="q-video-frame" src="${videoEmbedUrl(media)}" title="${VIDEO_PROVIDERS[media.provider]} video: ${title}" allow="encrypted-media; picture-in-picture; fullscreen" allowfullscreen referrerpolicy="strict-origin-when-cross-origin" sandbox="allow-scripts allow-same-origin allow-presentation allow-popups"></iframe>`;

// Swaps a failed image for its text fallback. Runs after every render, including images that
// failed before the listener was attached.
function watchImages(root) {
  for (const image of $$('img[data-option-image], [data-media-image] img', root)) {
    const fail = () => {
      image.hidden = true;
      image.closest('[data-media-image]')?.querySelector('.q-media-failed')?.removeAttribute('hidden');
      image.closest('label')?.classList.add('picture-failed');
    };
    if (image.complete && image.naturalWidth === 0 && image.getAttribute('src')) fail(); else image.addEventListener('error', fail, { once: true });
  }
}

function inputFor(field, value, labelText, assetUrl = publicAssetUrl) {
  const id = `q-${field.id}`;
  const describedBy = field.help ? `${id}-help` : '';
  const common = raw(`id="${id}" name="${field.id}" ${field.required ? 'aria-required="true"' : ''} ${describedBy ? `aria-describedby="${describedBy}"` : ''}`);
  const label = html`<label for="${id}" class="q-label">${labelText}${field.required ? html` <span class="required-mark" aria-hidden="true">*</span><span class="visually-hidden">(required)</span>` : ''}</label>`;
  const help = field.help ? html`<div class="hint q-help" id="${id}-help" data-desc="q:${field.id}">${field.help}</div>` : '';
  const hint = field.placeholder ? html`placeholder="${field.placeholder}"` : '';
  switch (field.type) {
    case 'long_text': return html`${label}${help}<textarea ${common} ${hint} maxlength="5000">${value || ''}</textarea>`;
    case 'email': return html`${label}${help}<input ${common} ${hint} type="email" maxlength="254" autocomplete="email" value="${value || ''}">`;
    case 'date': return html`${label}${help}<input ${common} type="date" value="${value || ''}">`;
    case 'phone': return html`${label}${help}<input ${common} ${hint} type="tel" maxlength="30" autocomplete="tel" value="${value || ''}">`;
    case 'single_choice':
    case 'multiple_choice': {
      const type = field.type === 'single_choice' ? 'radio' : 'checkbox';
      const selected = Array.isArray(value) ? value : value ? [value] : [];
      return html`<fieldset ${raw(describedBy ? `aria-describedby="${describedBy}"` : '')}><legend class="q-label">${labelText}${field.required ? html` <span class="required-mark" aria-hidden="true">*</span><span class="visually-hidden">(required)</span>` : ''}</legend>${help}
        <div class="choice-list${field.options.some(option => option.image) ? ' picture-choices' : ''}">${field.options.map((option, index) => html`<label class="check${option.image ? ' picture-choice' : ''}"><input type="${type}" name="${field.id}" value="${option.id}" id="${id}-${index}" ${selected.includes(option.id) ? raw('checked') : ''}>
          ${option.image ? html`<img src="${assetUrl(option.image.asset)}" alt="" loading="lazy" decoding="async" data-option-image>` : ''}<span class="choice-text">${option.label}</span></label>`)}</div></fieldset>`;
    }
    default: return html`${label}${help}<input ${common} ${hint} type="text" maxlength="300" value="${value || ''}">`;
  }
}

// A description's character count, from the shared limit. It is linked to its field, and only speaks
// up near the limit, so typing is not interrupted by a running count.
const countText = (length, limit) => `${length.toLocaleString('en-US')} / ${limit.toLocaleString('en-US')} characters`;
const limitAttributes = (id, limit) => raw(`maxlength="${limit}" data-limit="${limit}" aria-describedby="${id}-count"`);
const characterCount = (id, value, limit, always = false) => html`<span class="char-count${always ? ' is-always' : ''}${(value || '').length >= limit * 0.9 ? ' is-near' : ''}" id="${id}-count">${countText((value || '').length, limit)}</span>`;
function refreshCount(area) {
  const node = document.getElementById(`${area.id}-count`);
  if (!node) return;
  const limit = Number(area.dataset.limit);
  const near = area.value.length >= limit * 0.9;
  node.textContent = countText(area.value.length, limit);
  node.classList.toggle('is-near', near);
  node.setAttribute('aria-live', near ? 'polite' : 'off');
}
if (typeof document !== 'undefined') document.addEventListener('input', event => { if (event.target?.dataset?.limit) refreshCount(event.target); });

// Long descriptions open folded to a few lines with a button to read the rest, so the answer and the
// button stay near the question. The whole text stays in the page, and is what assistive technology
// reads. A description that turns out to fit is left as it is.
const FORM_DESCRIPTION = 'form';
const FOLD_CHARACTERS = 280;
const FOLD_BREAKS = 3;
const isLong = text => text.length > FOLD_CHARACTERS || (text.match(/\n/g) || []).length > FOLD_BREAKS;
function foldDescriptions(root, expanded) {
  for (const text of $$('[data-desc]', root)) {
    if (!isLong(text.textContent)) continue;
    const key = text.dataset.desc;
    const open = expanded.has(key);
    text.classList.toggle('is-folded', !open);
    // Measured only when laid out: a hidden preview keeps the button rather than guessing.
    if (!open && text.clientHeight && text.scrollHeight <= text.clientHeight + 1) { text.classList.remove('is-folded'); continue; }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn-link desc-toggle';
    button.dataset.descToggle = key;
    button.setAttribute('aria-controls', text.id);
    text.after(button);
    showFold(text, button, open);
  }
}
function showFold(text, button, open) {
  text.classList.toggle('is-folded', !open);
  button.setAttribute('aria-expanded', String(open));
  button.textContent = open ? 'Show less' : 'Show full description';
}
function toggleDescription(root, button, expanded) {
  const key = button.dataset.descToggle;
  const text = root.querySelector(`#${CSS.escape(button.getAttribute('aria-controls'))}`);
  if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
  showFold(text, button, expanded.has(key));
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
export function renderForm(container, definition, { mode = definition.presentation, preview = false, onSubmit, describeError, answers: initial = {}, banner = '', assetUrl = publicAssetUrl, embedVideo = true, urlParams = null } = {}) {
  applyTheme(container.closest('.form-page') || container, definition.theme);
  // Text sizes follow the width the form is given, not the window, so a phone-sized preview in the
  // builder shows exactly what a phone shows.
  container.classList.add('form-scope');
  const loadedVideos = new Set(); // videos the respondent chose to load stay loaded across redraws
  const expanded = new Set(); // long descriptions the respondent opened stay open across redraws
  const answers = { ...initial };
  let position = 0; // page index (classic) or question index (conversational)
  let errors = {};
  let finished = false;
  let failure = null; // { message, retry } shown after a submission that did not complete
  let message = banner;
  let moved = null; // 'forward' or 'back' for the draw straight after a page change
  let pointerPick = false; // the last choice came from a pointer, not the keyboard
  let drawing = false; // true while the form's markup is being replaced

  // A server on another version can want a question this path skipped, as during a rollback. It is shown
  // at the end, so the person can answer it instead of being stuck behind an error with nowhere to go.
  let serverAsked = [];
  const pagesNow = () => {
    const screens = formScreens(definition, answers, mode, urlParams);
    const onPath = new Set(screens.flat().map(field => field.id));
    const extra = definition.fields.filter(field => serverAsked.includes(field.id) && !onPath.has(field.id));
    return extra.length ? [...screens, extra] : screens;
  };
  const signature = () => JSON.stringify(pagesNow().map(page => page.map(item => [item.id, pipe(item.label, definition, answers), item.options?.map(option => option.id)])));
  const screenKey = screen => JSON.stringify((screen || []).map(item => [item.id, item.options?.map(option => option.id)]));

  function draw(focusId) {
    if (finished) return;
    dropHiddenChoices(definition, answers, urlParams);
    const pages = pagesNow();
    position = Math.min(position, pages.length - 1);
    const fields = pages[position] || [];
    const last = position === pages.length - 1;
    const total = pages.length;
    const progress = total > 1 ? Math.round((position / total) * 100) : 0;
    const conversational = mode === 'conversational';
    const pageErrors = fields.filter(field => errors[field.id]);
    const entered = moved;
    moved = null;
    const page = screenPage(definition, fields);
    const choosing = conversational && fields.length === 1 && fields[0].type.endsWith('_choice');
    // Replacing a focused input that was just edited fires its change event during the replacement.
    drawing = true;
    mount(container, html`<form class="public-form ${conversational ? 'conversational' : ''}" novalidate>
      ${position === 0 || !conversational ? html`<h1 ${raw(preview ? 'aria-level="2" role="heading"' : '')}>${definition.title}</h1>${definition.description && position === 0 ? html`<p class="form-description" id="form-description" data-desc="${FORM_DESCRIPTION}">${definition.description}</p>` : ''}` : ''}
      ${message ? html`<div data-form-banner>${message}</div>` : ''}
      ${total > 1 ? html`<div class="progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style-width="${progress}"></span></div>
        <p class="muted">${conversational ? `Question ${position + 1} of ${total}` : `Page ${position + 1} of ${total}`}</p>` : ''}
      ${pageErrors.length > 1 ? html`<div class="notice notice-bad error-summary" tabindex="-1" data-error-summary><p><strong>Check ${pageErrors.length} answers before continuing:</strong></p>
        <ul>${pageErrors.map(field => html`<li><a href="#q-${field.id}" data-jump="${field.id}">${pipe(field.label, definition, answers) || 'Question'}: ${errors[field.id]}</a></li>`)}</ul></div>` : ''}
      ${!conversational && fields.some(field => field.required) ? html`<p class="muted"><span class="required-mark" aria-hidden="true">*</span> Required</p>` : ''}
      ${page ? html`<div class="form-page-head${entered ? ` q-enter-${entered}` : ''}">${conversational ? html`<span class="question-number">${position + 1} →</span>` : ''}<h2 class="form-page-title">${pipe(page.label, definition, answers)}</h2>${page.help ? html`<p class="form-page-help" id="page-${page.id}-help" data-desc="page:${page.id}">${pipe(page.help, definition, answers)}</p>` : ''}</div>` : ''}
      ${fields.length ? fields.map(field => html`<div class="question${entered ? ` q-enter-${entered}` : ''}" data-field="${field.id}">${conversational && !page ? html`<span class="question-number">${position + 1} →</span>` : ''}
        ${mediaFor(field, assetUrl, loadedVideos, pipe(field.label, definition, answers), embedVideo)}${inputFor(field, answers[field.id], pipe(field.label, definition, answers), assetUrl)}
        ${errors[field.id] ? html`<div class="field-error" id="q-${field.id}-error">${errors[field.id]}</div>` : ''}</div>`) : html`<p class="muted">This form has no questions yet.</p>`}
      <div data-form-status tabindex="-1">${failure ? notice('bad', failure.message) : ''}</div>
      <div class="actions">
        ${position > 0 ? html`<button type="button" class="btn" data-back>Back</button>` : ''}
        <button type="submit" class="btn btn-primary">${last ? (preview ? 'Submit (preview)' : failure?.retry ? 'Submit again' : definition.submit_label || 'Submit') : conversational ? 'OK' : 'Next'}</button>
        ${conversational && !last ? html`<span class="kbd-hint">or press Enter ↵${fields[0]?.type === 'long_text' ? ' · Shift + Enter for a new line' : ''}${choosing ? ' · press a letter to choose' : ''}</span>` : ''}
      </div>
      ${preview ? html`<p class="muted">Preview only. Nothing is saved or sent from here, and it does not count toward your allowance.</p>` : ''}
    </form>`);
    drawing = false;
    // Width set through the CSSOM: the page's style policy disallows inline style attributes.
    $$('[style-width]', container).forEach(bar => { bar.style.width = bar.getAttribute('style-width') + '%'; bar.removeAttribute('style-width'); });
    watchImages(container);
    const form = $('form', container);
    foldDescriptions(form, expanded);
    for (const field of fields) {
      if (errors[field.id]) $$(`[name="${field.id}"]`, form).forEach(input => { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), `q-${field.id}-error`].filter(Boolean).join(' ')); });
    }
    // A page change brings the new question into view on phones, then focus moves to it.
    if (entered && !preview) container.scrollIntoView({ block: 'start' });
    const target = focusId ? form.querySelector(`#${CSS.escape(focusId)}`) : null;
    if (target) target.focus();
    else if (focusId === 'status') $('[data-form-status]', form).focus();
    else if (pageErrors.length > 1 && !conversational) $('[data-error-summary]', form).focus();
    else if (focusId !== null && (conversational || pageErrors.length || entered)) (form.querySelector('[aria-invalid="true"]') || form.querySelector('input, textarea'))?.focus();

    form.addEventListener('click', event => {
      const fold = event.target.closest('[data-desc-toggle]');
      if (fold) { toggleDescription(form, fold, expanded); return; }
      const load = event.target.closest('[data-load-video]');
      if (load) {
        const field = definition.fields.find(item => item.id === load.dataset.loadVideo);
        loadedVideos.add(field.id);
        const slot = load.closest('[data-video]');
        mount(slot.firstElementChild, videoFrame(field.media, field.media.title || pipe(field.label, definition, answers)));
        slot.querySelector('iframe').focus();
        return;
      }
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
      dropHiddenChoices(definition, answers, urlParams);
      if (drawing) return; // the redraw under way already uses this answer
      // Re-render when this answer changes which questions are visible or what labels say.
      if (signature() !== form.dataset.signature) { delete errors[name]; draw(event.target.id); }
      // A click on one choice moves on, after a moment to see it selected. Arrow keys only browse the
      // options, so the keyboard moves on with Enter; the last question always waits for Submit.
      if (conversational && pointerPick && field.type === 'single_choice' && answers[name] && position < pagesNow().length - 1) advanceSoon();
    });
    form.addEventListener('pointerdown', () => { pointerPick = true; });
    form.addEventListener('keydown', event => {
      pointerPick = false;
      if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
      const element = event.target;
      if (event.key === 'Enter') {
        if (element.matches('button, a, summary, iframe') || (element.tagName === 'TEXTAREA' && (!conversational || event.shiftKey))) return;
        // Submitted directly: an answer that redraws the form would otherwise cancel the browser's own submit.
        event.preventDefault();
        return form.requestSubmit();
      }
      if (!choosing || element.matches('input:not([type="radio"], [type="checkbox"]), textarea') || !/^[a-z]$/i.test(event.key)) return;
      const option = fields[0].options[event.key.toUpperCase().charCodeAt(0) - 65];
      if (!option) return;
      event.preventDefault();
      const input = form.querySelector(`[name="${CSS.escape(fields[0].id)}"][value="${CSS.escape(option.id)}"]`);
      input.click();
      const current = container.querySelector(`#${CSS.escape(input.id)}`);
      current?.focus();
      if (fields[0].type === 'single_choice' && position < pagesNow().length - 1) advanceSoon();
    });
    form.dataset.signature = signature();
    form.addEventListener('input', event => {
      const field = definition.fields.find(candidate => candidate.id === event.target.name);
      if (field && !field.type.endsWith('choice')) answers[field.id] = event.target.value;
    });
    form.querySelector('[data-back]')?.addEventListener('click', () => { errors = {}; position--; moved = 'back'; draw(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (form.dataset.busy) return;
      for (const field of fields) answers[field.id] = readAnswer(form, field);
      dropHiddenChoices(definition, answers, urlParams);
      errors = {};
      // Enter can commit a typed answer that changes the choices on this very screen: show that first.
      if (definition.choice_rules?.length && screenKey(pagesNow()[position]) !== screenKey(fields)) return draw(document.activeElement?.id || undefined);
      for (const field of fields) { const result = checkAnswer(field, answers[field.id]); if (result.error) errors[field.id] = result.error; }
      if (Object.keys(errors).length) return draw();
      // The answers just read can change the path, so this page's place in it is worked out again.
      if (position < pagesNow().length - 1) { position++; moved = 'forward'; return draw(); }
      if (preview) {
        const ending = formEnding(definition, answers, urlParams);
        mount(container, notice('ok', html`${ending ? html`<p><strong>${pipe(ending.title, definition, answers)}</strong></p>${ending.message ? html`<p>${pipe(ending.message, definition, answers)}</p>` : ''}` : ''}<p><strong>Preview complete.</strong> Nothing was saved. In the published form, the response is saved when the server confirms it.</p><button class="btn" type="button" id="restart-preview">Restart preview</button>`));
        $('#restart-preview', container).onclick = () => renderForm(container, definition, { mode, preview, assetUrl, embedVideo, urlParams });
        return;
      }
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
          serverAsked = [...new Set([...serverAsked, ...Object.keys(errors).filter(id => definition.fields.some(field => field.id === id && field.type !== 'page_break'))])];
          const firstPage = pagesNow().findIndex(page => page.some(field => errors[field.id]));
          if (firstPage >= 0) position = firstPage;
          else failure = { message: html`<p><strong>This form could not accept these answers.</strong> Your response was not saved. Reload the page and try again.</p>` };
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
  function advanceSoon() {
    const from = position;
    setTimeout(() => { if (!finished && position === from) $('form', container)?.requestSubmit(); }, 300);
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

const pendingKey = slug => `schedora.pending-answers.${slug}`;
const unavailablePage = (title, body) => html`<div class="container page"><div class="card public-form-card"><div class="public-form"><h1>${title}</h1>${body}</div></div></div>`;

export async function publicForm(ctx) {
  mount(ctx.main, html`<div class="container page">${loading('Loading form…')}</div>`);
  const slug = ctx.params[0];
  let form;
  const signinUrl = `/api/public/forms/${encodeURIComponent(slug)}/signin?return=${encodeURIComponent(location.search)}`;
  try { form = await api('GET', `/api/public/forms/${slug}`); }
  catch (error) {
    // Inside another site's frame, sign-in cannot work: identity providers refuse to load in frames and the
    // respondent cookie is not sent there. Say so, and offer the same form in a tab of its own.
    if (error.code === 'signin_required' && document.body.dataset.embed === '1') {
      setTitle('Open this form in a new tab · Forms by Schedora');
      const own = new URLSearchParams(location.search);
      own.delete('embed');
      const owner = error.details.workspace_name;
      return mount(ctx.main, unavailablePage('Open this form in a new tab', html`<p><strong>${owner || 'The form owner'}</strong> asks respondents to sign in with their organisation account, and that can't happen inside another website.</p>
        <p><a class="btn btn-primary" id="respondent-open-tab" data-external href="/f/${encodeURIComponent(slug)}${own.size ? '?' + own : ''}" target="_blank" rel="noopener">Open the form in a new tab</a></p>
        <p class="hint">You sign in there, then answer. Nothing is sent from this page.</p>`));
    }
    if (error.code === 'signin_required') {
      setTitle('Sign in to answer · Forms by Schedora');
      const problem = ctx.query.get('signin_error');
      const owner = error.details.workspace_name;
      return mount(ctx.main, unavailablePage('Sign in to answer this form', html`<p><strong>${owner || 'The form owner'}</strong> asks respondents to sign in with their organisation account before answering.</p>
        ${problem ? notice('bad', html`<p><strong>Sign-in did not complete.</strong> ${problem}</p>`) : ''}
        <p class="hint">Signing in confirms who you are for this form only. It does not create a Schedora account or give you access to ${owner ? `${owner}'s` : 'their'} workspace. Your sign-in lasts up to two hours on this device.</p>
        <p><a class="btn btn-primary" id="respondent-signin" data-external href="${signinUrl}">Sign in to continue</a></p>`));
    }
    if (error.code === 'signin_unavailable') return mount(ctx.main, unavailablePage('Sign-in is not available', html`<p>${error.message}</p>`));
    if (error.status === 404) return mount(ctx.main, unavailablePage('This form is not available', html`<p>The link may be mistyped, or the form has not been published.</p>`));
    if (error.status === 410) return mount(ctx.main, unavailablePage('This form is closed', html`<p>It is no longer accepting responses. Responses sent before it closed are not affected.</p>`));
    return mount(ctx.main, unavailablePage('We could not load this form', html`${notice('bad', html`<p>${error.status ? 'The form service had a problem.' : 'Schedora could not be reached.'} Nothing has been submitted from this page.</p>`)}<a class="btn" data-external href="${location.pathname + location.search}">Try again</a>`));
  }
  if (!ctx.alive()) return;
  setTitle(form.definition.title + ' · Forms by Schedora');
  const mode = ['classic', 'conversational'].includes(ctx.query.get('mode')) ? ctx.query.get('mode') : form.definition.presentation;
  mount(ctx.main, html`<div class="form-page"><div class="container page">${form.respondent ? html`<p class="respondent-bar public-form">Signed in as <strong>${form.respondent.email}</strong> · <button class="btn btn-link btn-small" type="button" id="respondent-signout">Sign out</button></p>` : ''}<div class="card public-form-card" id="form-root"></div><p class="muted public-form">${form.workspace_name} · Powered by Forms by Schedora</p></div></div>`);
  $('#respondent-signout')?.addEventListener('click', async () => {
    try { await api('POST', `/api/public/forms/${slug}/signout`); } catch { /* the reload shows the result either way */ }
    location.reload();
  });
  applyTheme($('.form-page', ctx.main), form.definition.theme);
  const root = $('#form-root');
  if (form.availability === 'capacity_reached') return mount(root, html`<div class="public-form"><h1>${form.definition.title}</h1>${notice('warn', html`<p>This form has reached its response limit for now and is not accepting new responses. Please try again later or contact ${form.workspace_name}.</p>`)}</div>`);
  if (!form.accepting) return mount(root, html`<div class="public-form"><h1>${form.definition.title}</h1>${notice('warn', html`<p>This form is not accepting responses right now.</p>`)}</div>`);

  // Starting answers from a prefilled link: only questions this version allows, only valid values.
  const { answers: prefill } = prefillAnswers(form.definition, ctx.query);
  // Answers kept on this tab when a sign-in expired at submit, restored once after signing in again.
  let restored = null;
  try { restored = JSON.parse(sessionStorage.getItem(pendingKey(slug)) || 'null'); sessionStorage.removeItem(pendingKey(slug)); } catch { restored = null; }
  respondTo(root, form, { mode, urlParams: ctx.query, prefill, restored: restored && typeof restored === 'object' && !Array.isArray(restored) ? restored : null, signinUrl });
}

/**
 * Shows a published form and submits it with retry-safe idempotency. Used by the public form page
 * and by meeting rooms (docs/MEET_SESSION_OFFERS.md), which pass a session ticket in `extra`, their
 * own storage key, link-only videos and `onAccepted`, called only after the server confirms.
 */
export function respondTo(root, form, { mode = form.definition.presentation, storeKey = form.slug, extra = {}, embedVideo = true, onAccepted, pageTitle = true, urlParams = null, prefill = {}, restored = null, signinUrl = null } = {}) {
  const slug = form.slug;
  let submissionId = submissionStore.get(storeKey);
  // An id kept from before a reload may belong to an attempt that reached the server.
  let uncertain = Boolean(submissionId);
  if (!submissionId) { submissionId = uid() + uid(); submissionStore.set(storeKey, submissionId); }
  const embedded = document.body.dataset.embed === '1';

  // Every message states only what is known about whether the response was saved.
  const describeError = error => {
    if (error.status === 0 || error.status >= 500) {
      uncertain = true;
      return { retry: true, message: html`<p><strong>We could not confirm that your response was received.</strong> Your answers are still here. Submit again: if the first attempt got through, it will not be counted twice.</p>` };
    }
    if (error.code === 'form_version_changed') { reloadVersion(); return { replaced: true }; }
    if (error.code === 'signin_required' && signinUrl) {
      try { sessionStorage.setItem(pendingKey(slug), JSON.stringify(start.answers())); } catch { /* answers stay on the page */ }
      return { message: html`<p><strong>Your sign-in expired, so nothing was submitted.</strong> Sign in again and your answers on this tab come back.</p><p><a class="btn btn-small" data-external href="${signinUrl}">Sign in again</a></p>` };
    }
    if (error.code === 'rate_limited') return { retry: true, message: html`<p>Too many attempts from this connection. Wait a minute, then submit again. ${uncertain ? 'We still cannot confirm whether an earlier attempt was received; submitting again will not create a duplicate.' : 'Nothing has been saved yet.'}</p>` };
    const known = { form_closed: 'This form stopped accepting responses before your answers arrived.', quota_exceeded: 'This form has reached its response limit for now.', entitlement_required: 'This form is not accepting responses right now.',
      session_already_submitted: 'You already answered this form in this meeting.', not_in_meeting: 'You are no longer in this meeting.', session_invalid: 'This meeting form is no longer valid. Close it and open it again from the meeting card.' }[error.code];
    if (known) return { message: html`<p><strong>${known}</strong> Your response was not saved. Your answers are still on this page if you want to copy them.</p>` };
    return { message: html`<p>${error.message} Your response was not saved.</p>` };
  };

  async function reloadVersion() {
    let next;
    try { next = await api('GET', `/api/public/forms/${slug}`); }
    catch (error) {
      mount(root, html`<div class="public-form">${notice('bad', html`<p>This form changed or closed while you were answering, and the new version could not be loaded. Your response was not saved.</p>`)}<button class="btn" type="button" data-reload-form>Load the form again</button></div>`);
      return $('[data-reload-form]', root).addEventListener('click', reloadVersion);
    }
    const kept = {};
    const current = start.answers();
    for (const field of next.definition.fields) if (current[field.id] !== undefined) kept[field.id] = current[field.id];
    form = next;
    start = begin(kept, notice('warn', html`<p><strong>This form was updated while you were answering.</strong> Nothing was submitted. Answers to questions that are still in the form were kept; please review them and submit again.</p>`));
  }

  function begin(initial = {}, banner = '') {
    let latest = { ...initial };
    renderForm(root, form.definition, {
      mode, answers: initial, banner, describeError, embedVideo, urlParams,
      onSubmit: async answers => {
        latest = answers;
        // Only what this version declares leaves the page; the server cleans it again regardless.
        const params = Object.fromEntries(Object.entries(urlParamValues(form.definition, urlParams)));
        const result = await api('POST', `/api/public/forms/${form.slug}/responses`, { answers, evaluator: CLIENT_EVALUATOR, submission_id: submissionId, version: form.version, ...(Object.keys(params).length ? { url_params: params } : {}), ...extra }, {}, { timeout: SUBMIT_TIMEOUT_MS });
        submissionStore.clear(storeKey);
        showReceipt(result);
      }
    });
    return { answers: () => latest };
  }
  let start = restored ? begin({ ...prefill, ...restored }, notice('info', html`<p>Your answers from before you signed in again are back. Check them, then submit.</p>`))
    : Object.keys(prefill).length ? begin(prefill, notice('info', html`<p>Some answers are already filled in from your link. Check them before you submit; you can change any of them.</p>`))
    : begin();

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
    if (pageTitle) setTitle('Response received · Forms by Schedora');
    const ending = result.ending;
    const answered = start.answers();
    const endingTitle = ending && pipe(ending.title, form.definition, answered);
    const offered = booking && next.status === 'offered';
    mount(root, html`<div role="status" class="public-form receipt"><h1 tabindex="-1">${offered ? 'Response received — choose a time' : endingTitle || 'Response received'}</h1>
      ${offered && endingTitle ? html`<p><strong>${endingTitle}</strong></p>` : ''}${ending?.message ? html`<p class="ending-message">${pipe(ending.message, form.definition, answered)}</p>` : ''}
      <p>${result.answers_changed ? 'Your response from your first attempt was saved. Changes you made after that attempt were not saved.' : 'Your answers were saved.'}</p>
      <dl class="confirm-facts"><dt>Receipt</dt><dd>${result.reference}</dd><dt>Received</dt><dd>${fmtDateTime(result.created_at)}</dd></dl>
      ${step}</div>`);
    $('h1', root).focus();
    onAccepted?.(result);
  }
}

// ---------------------------------------------------------------------------------------------
// Dashboard

export async function dashboard(ctx) {
  setTitle('Forms by Schedora');
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'forms', title: 'Every good conversation starts with a question.', lead: 'Build classic or one-question-at-a-time forms with logic and answer piping. Responses are saved to your workspace and can be exported.' }));
  if (!needsSession(ctx)) return;
  mount(ctx.main, html`<div class="container page forms-page"><div class="page-head forms-head"><div class="page-head-text"><p class="page-eyebrow" title="${workspace().name}">Forms · ${workspace().name}</p><h1>Forms</h1></div>
    <button class="btn btn-primary" id="new-form" aria-expanded="false" aria-controls="form-templates">Create form</button></div>
    ${workspace().entitlements.forms.active ? '' : notice('warn', html`<p>This workspace has no active Forms or Suite plan, so forms cannot be published or collect responses. <a href="/billing">Review plans</a>.</p>`)}
    <div id="form-templates" hidden></div>
    <div id="form-list">${loading()}</div></div>`);
  const picker = $('#form-templates');
  const starting = mountStartingPoints(picker, {
    onCreated: (form, created, workspaceId) => ctx.navigate(draftAddress(form, { created, workspaceId })),
    cancel: { label: 'Cancel', onCancel: () => { showPicker(false); $('#new-form').focus(); } }
  });
  const showPicker = (open, focus = true) => {
    picker.hidden = !open;
    $('#new-form').setAttribute('aria-expanded', String(open));
    if (open && focus) starting.focus();
  };
  $('#new-form').onclick = () => showPicker(picker.hidden);
  try {
    const forms = await api('GET', wsPath('/forms'));
    if (!ctx.alive()) return;
    if (!forms.length) {
      mount($('#form-list'), html`<div class="empty"><h2>No forms yet</h2><p>Pick a starting point above, start blank or import a JSON file. You can change every question later.</p><div class="actions"><a class="btn" href="/setup/forms">Guided setup</a></div></div>`);
      return showPicker(true, false);
    }
    renderFormList(ctx, forms);
  } catch (error) { mount($('#form-list'), errorBlock(error)); }
}

// The workspace's forms: search, status filter and row actions. Filters live in the address, so a
// reload or a shared link keeps them; nothing here changes a form except Duplicate, which creates a draft.
const STATUS_TEXT = { live: 'Live', draft: 'Draft', closed: 'Closed' };
const shortDate = at => new Date(at).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
function renderFormList(ctx, forms) {
  const params = new URLSearchParams(location.search);
  let query = params.get('q') || '';
  let status = STATUS_FILTERS.some(([key]) => key === params.get('status')) ? params.get('status') : 'all';
  const counts = statusCounts(forms);
  mount($('#form-list'), html`<div class="forms-toolbar">
      <div class="forms-search"><label class="visually-hidden" for="form-search">Search forms</label><input type="search" id="form-search" placeholder="Search forms" value="${query}" autocomplete="off"></div>
      <div class="segmented forms-filter" role="radiogroup" aria-label="Show forms">${STATUS_FILTERS.map(([key, label]) => html`<label><input type="radio" name="form-status" value="${key}" ${key === status ? raw('checked') : ''}> ${label} <span class="count">${counts[key]}</span></label>`)}</div>
    </div>
    <p class="visually-hidden" id="form-count" role="status"></p>
    <table class="forms-table" id="forms-table"><caption class="visually-hidden">Forms in ${workspace().name}</caption>
      <thead><tr><th scope="col">Form</th><th scope="col">Status</th><th scope="col">Responses</th><th scope="col">Updated</th><th scope="col"><span class="visually-hidden">Actions</span></th></tr></thead>
      <tbody id="forms-rows"></tbody></table><div id="forms-empty"></div><p class="copy-status" id="forms-status" role="status"></p>`);
  const remember = () => {
    const next = new URLSearchParams(location.search);
    if (query) next.set('q', query); else next.delete('q');
    if (status !== 'all') next.set('status', status); else next.delete('status');
    const search = next.toString();
    history.replaceState(history.state, '', location.pathname + (search ? '?' + search : ''));
  };
  const row = form => {
    const state = formStatus(form);
    const live = state === 'live';
    const title = form.draft.title;
    return html`<tr class="form-row" data-form-row="${form.id}" data-status="${state}">
      <th scope="row" class="form-cell-title"><a class="form-row-title" href="/forms/${form.id}">${title}</a>${form.access === 'signin' ? html`<span class="form-row-note">Sign-in required</span>` : ''}</th>
      <td class="form-cell-status" data-label="Status"><span class="form-status" data-state="${state}">${STATUS_TEXT[state]}</span>${live && form.has_unpublished_changes ? html`<span class="form-row-pending">Unpublished edits</span>` : ''}</td>
      <td class="form-cell-responses" data-label="Responses"><a href="/forms/${form.id}/responses" class="form-row-responses">${form.response_count.toLocaleString()}<span class="responses-word"> ${form.response_count === 1 ? 'response' : 'responses'}</span><span class="visually-hidden"> to ${title}</span></a></td>
      <td class="form-cell-updated" data-label="Updated"><time datetime="${new Date(form.updated_at).toISOString()}" title="${fmtDateTime(form.updated_at)}">${shortDate(form.updated_at)}</time></td>
      <td class="form-cell-actions"><details class="overflow-menu"><summary class="btn btn-icon btn-small" aria-label="More actions for ${title}" title="More actions">${formIcon('more')}</summary>
        <div class="overflow-panel"><a class="btn" href="/forms/${form.id}">Edit<span class="visually-hidden"> ${title}</span></a><a class="btn" href="/forms/${form.id}/responses">View responses</a>${live ? html`<button class="btn" type="button" data-row-copy="${form.id}">Copy respondent link</button><a class="btn" href="${publicUrl(form)}" target="_blank" rel="noopener">Open live form<span class="visually-hidden"> (opens in a new tab)</span></a>` : ''}
          <button class="btn" type="button" data-row-duplicate="${form.id}">Duplicate as draft</button><button class="btn" type="button" data-row-export="${form.id}">Export form definition</button></div></details></td></tr>`;
  };
  const draw = () => {
    const shown = filterForms(forms, { query, status });
    mount($('#forms-rows'), html`${shown.map(row)}`);
    $('#forms-table').hidden = !shown.length;
    const filtered = query || status !== 'all';
    mount($('#forms-empty'), shown.length ? '' : html`<div class="empty"><h2>No forms match</h2><p>${query ? html`Nothing ${status === 'all' ? '' : `${STATUS_FILTERS.find(([key]) => key === status)[1].toLowerCase()} `}matches “${query}”.` : `There are no ${STATUS_FILTERS.find(([key]) => key === status)[1].toLowerCase()} forms.`}</p><div class="actions"><button class="btn" type="button" data-clear-filters>Show all forms</button></div></div>`);
    $('#form-count').textContent = filtered ? `Showing ${shown.length} of ${forms.length} forms.` : `${forms.length} forms.`;
  };
  draw();
  $('#form-search').addEventListener('input', event => { query = event.target.value; remember(); draw(); });
  $('#form-list').addEventListener('change', event => { if (event.target.name === 'form-status') { status = event.target.value; remember(); draw(); } });
  $('#form-list').addEventListener('click', async event => {
    const target = event.target.closest('button');
    if (!target) return;
    const status$ = $('#forms-status');
    const form = forms.find(item => item.id === (target.dataset.rowCopy || target.dataset.rowDuplicate || target.dataset.rowExport));
    target.closest('details')?.removeAttribute('open');
    if (target.dataset.clearFilters !== undefined) { query = ''; status = 'all'; $('#form-search').value = ''; $('input[name="form-status"][value="all"]').checked = true; remember(); draw(); return $('#form-search').focus(); }
    if (!form) return;
    if (target.dataset.rowCopy) {
      try { await navigator.clipboard.writeText(publicUrl(form)); status$.textContent = `Respondent link for “${form.draft.title}” copied. Nothing has been sent.`; }
      catch { status$.textContent = `Copy failed. The link is ${publicUrl(form)}`; }
    } else if (target.dataset.rowExport) {
      try { await exportDefinition(form); status$.textContent = `Downloaded the saved draft of “${form.draft.title}”. No responses are included.`; }
      catch (error) { status$.textContent = error.message; }
    } else if (target.dataset.rowDuplicate) {
      // A duplicate is an export imported again: same checks, always a new unpublished draft, no responses.
      target.disabled = true;
      status$.textContent = `Duplicating “${form.draft.title}”…`;
      try {
        const file = await api('GET', wsPath(`/forms/${form.id}/definition.json`));
        file.definition.title = copyTitle(file.definition.title);
        const { form: copy } = await api('POST', wsPath('/forms/import'), { source: JSON.stringify(file) }, {}, { timeout: 30000 });
        ctx.navigate(draftAddress(copy, { created: 'duplicate', workspaceId: session.workspaceId }));
      } catch (error) { target.disabled = false; status$.textContent = `The copy was not created. ${error.message}`; }
    }
  });
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

// The add-content picker, by what the creator wants to ask rather than by input control.
const CONTENT_GROUPS = [['Contact', ['contact_info', 'email', 'phone']], ['Text', ['short_text', 'long_text']], ['Choice', ['single_choice', 'multiple_choice']], ['Other', ['date']], ['Layout', ['question_page', 'page_break']]];
const CONTENT_LABELS = { ...FIELD_TYPES, contact_info: 'Contact Info', question_page: 'Page of questions' };

const SAVE_TEXT = { saved: 'All changes saved', dirty: 'Unsaved edits', saving: 'Saving…', failed: 'Not saved', conflict: 'Not saved: changed elsewhere' };
// What the answer area looks like on the question canvas. Choice questions show their options instead.
const ANSWER_SAMPLES = { short_text: 'Short answer', long_text: 'Longer answer, several lines', email: 'name@example.com', phone: '+91 98765 43210', date: 'dd / mm / yyyy' };

// Images are re-encoded in the browser before upload: this applies the photo's orientation, drops
// camera and location metadata and keeps files small. The server still checks every byte.
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_UPLOAD = 2 * 1024 * 1024;
async function prepareImage(file) {
  if (!IMAGE_TYPES.includes(file.type)) throw new Error('Choose a JPEG, PNG or WebP image. SVG, GIF and other files are not accepted.');
  if (file.size > 15 * 1024 * 1024) throw new Error('That file is over 15 MB. Choose a smaller image.');
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('That file could not be read as an image.'); }
  const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
  const canvas = Object.assign(document.createElement('canvas'), { width: Math.max(1, Math.round(bitmap.width * scale)), height: Math.max(1, Math.round(bitmap.height * scale)) });
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  const encode = type => new Promise(resolve => canvas.toBlob(resolve, type, 0.86));
  let blob = file.type === 'image/png' ? await encode('image/png') : null;
  if (!blob || blob.size > MAX_UPLOAD) { blob = await encode('image/webp'); if (!blob || blob.type !== 'image/webp') blob = await encode('image/jpeg'); }
  if (!blob || blob.size > MAX_UPLOAD) throw new Error('Even after resizing, the image is over 2 MB. Try a simpler image.');
  return blob;
}
async function blobBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

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
  let selectedQuestion = 0;
  let selectedEnding = null; // an ending's position when one is open on the canvas instead of a question

  document.body.classList.add('form-editor');
  mount(ctx.main, html`<div class="container builder-page" data-surface="content">
    <header class="builder-topbar">
      <div class="builder-crumbs"><a href="/forms">${formIcon('forms')}Forms</a><span class="builder-crumb-sep" aria-hidden="true">›</span><h1 id="builder-title">${draft.title}</h1></div>
      <nav class="builder-index" id="builder-index" aria-label="Form builder sections"><ul>
        <li><a href="#questions" data-section="questions" aria-current="location">Content</a></li><li><a href="#workflow-map" data-section="workflow">Workflow</a></li><li><a href="#settings" data-section="settings">Settings</a></li>
        <li><a href="#share-panel" data-section="share">Share</a></li><li><a href="/forms/${form.id}/responses" id="responses-link">Responses</a></li></ul></nav>
      <div class="builder-publish"><div id="builder-status"></div><button class="btn btn-ghost" type="button" id="topbar-preview" data-builder-view="preview" title="See the form as respondents do. Nothing is saved or sent.">${formIcon('play')}<span>Preview</span></button><button class="btn" id="save">Save draft</button><button class="btn btn-primary" id="publish">Publish form</button></div>
    </header>
    <div id="builder-notice" tabindex="-1"></div>
    <div class="visually-hidden" aria-live="polite" id="builder-live"></div>
    <div class="builder-surface surface-content">
      <div class="builder-toolbar" aria-label="Editor tools" role="group">
        <div class="add-content"><button class="btn btn-primary" type="button" id="add-field" aria-expanded="false" aria-controls="add-menu" aria-label="Add content">${formIcon('plus')}<span class="tool-text">Add content</span></button>
          <div class="add-menu" id="add-menu" role="group" aria-label="Add content" hidden>${CONTENT_GROUPS.map(([heading, types]) => html`<p class="add-menu-heading">${heading}</p>${types.map(type => html`<button type="button" class="add-menu-item" data-add-type="${type}"><span class="q-badge" data-kind="${TYPE_KIND[type] || 'contact'}">${formIcon(type === 'question_page' ? 'page' : type)}</span>${CONTENT_LABELS[type]}</button>`)}`)}</div></div>
        <span class="toolbar-divider" aria-hidden="true"></span><button class="btn btn-ghost" type="button" id="open-design" aria-expanded="false" aria-controls="design-panel" title="Typography and themes for this form">${formIcon('design')}<span class="tool-text">Design</span></button>
        <span class="toolbar-divider" aria-hidden="true"></span><div class="preview-devices" role="group" aria-label="Device size"><button type="button" class="btn btn-icon" data-device="desktop" aria-label="Desktop size" title="Desktop size">${formIcon('desktop')}</button><button type="button" class="btn btn-icon" data-device="mobile" aria-label="Mobile size" title="Mobile size">${formIcon('mobile')}</button></div>

        <details class="overflow-menu toolbar-end"><summary class="btn btn-icon" aria-label="More actions" title="More actions">${formIcon('more')}</summary>
          <div class="overflow-panel"><button class="btn" type="button" id="export-form">Export form definition</button><p class="hint overflow-hint">A .json file of the saved draft: questions, logic and theme. No responses.</p><button class="btn btn-danger" id="delete-form">Delete form</button></div></details>
      </div>
      <div class="builder" data-view="edit" data-device="desktop">
        <section class="builder-edit" id="builder-edit" aria-label="Form editor"><div id="questions" class="question-workspace">
          <aside class="question-sidebar" aria-labelledby="questions-heading">
            <div class="outline-bar" id="outline-bar"><button class="btn btn-icon" type="button" id="outline-prev" aria-label="Previous item in the outline" title="Previous">${formIcon('up')}</button>
              <button class="outline-toggle" type="button" id="outline-toggle" aria-expanded="false" aria-controls="outline-panel"><span class="outline-current" id="outline-current"></span><span class="outline-toggle-label"><span class="outline-word">Outline</span>${formIcon('chevron')}</span></button>
              <button class="btn btn-icon" type="button" id="outline-next" aria-label="Next item in the outline" title="Next">${formIcon('down')}</button></div>
            <div class="outline-panel" id="outline-panel">
            <div class="rail-card rail-card-questions"><div class="rail-card-head"><h2 id="questions-heading" tabindex="-1">Questions</h2></div><div id="question-list"></div></div>
            <div class="rail-card rail-card-endings"><div class="rail-card-head"><h2 class="endings-heading">Endings</h2><button class="btn btn-small rail-add" type="button" id="add-ending" aria-label="Add ending" title="Add ending">${formIcon('plus')}</button></div><div id="ending-list"></div></div>
            </div>
          </aside><div id="fields" class="question-panes"></div></div></section>
        <section class="builder-preview card" id="builder-preview" aria-label="Live preview"><div class="row-between"><h2 id="preview-heading" tabindex="-1">Preview</h2><select id="preview-mode" aria-label="Preview presentation"><option value="classic">Classic</option><option value="conversational">Conversational</option></select></div><div id="preview-params"></div><div id="preview"></div></section>
      </div>
      <aside class="design-panel" id="design-panel" aria-labelledby="design-heading" hidden></aside>
    </div>
    <div class="builder-surface surface-workflow">
      <section class="workflow-map" id="workflow-map" aria-labelledby="workflow-heading"><h2 id="workflow-heading" tabindex="-1">Logic</h2><p class="hint" id="workflow-summary"></p>
        <div class="workflow-canvas"><ol class="workflow-nodes" id="workflow-nodes"></ol><svg class="workflow-arcs" id="workflow-arcs" aria-hidden="true"></svg></div></section>
      <aside class="workflow-editor" id="workflow-editor" aria-label="Jump rules"></aside>
      <section class="url-params" id="url-params" aria-labelledby="url-params-heading"></section>
    </div>
    <div class="builder-surface surface-settings"><div id="settings"></div><div id="access"></div><div id="routing"></div></div>
    <div class="builder-surface surface-share">
      <p class="hint" id="save-hint">Changes are kept on this page until you select Save draft. The live form changes only when you publish.</p>
      <section class="card card-plain share-panel" id="share-panel" aria-labelledby="share-heading"></section>
      <section class="card card-plain readiness" id="readiness" aria-labelledby="readiness-heading">
        <div class="row-between"><h2 id="readiness-heading" tabindex="-1">Ready to share?</h2><button class="btn btn-small" type="button" data-recheck>Check again</button></div>
        <p class="hint" id="readiness-checked">What respondents see now and what your saved draft would publish. Unsaved edits are not included.</p>
        <div id="readiness-unsaved"></div><div id="readiness-body"></div><p class="visually-hidden" id="readiness-status" role="status"></p></section>
    </div></div>`);

  // One surface at a time: content, form-wide settings, or sharing. Switching changes neither the
  // address nor the draft, so unsaved edits stay on the page.
  const showSurface = key => {
    $('.builder-page').dataset.surface = key;
    const link = { content: 'questions', workflow: 'workflow', settings: 'settings', share: 'share' }[key];
    $$('[data-section]', $('#builder-index')).forEach(item => { if (item.dataset.section === link) item.setAttribute('aria-current', 'location'); else item.removeAttribute('aria-current'); });
    if (key === 'workflow') renderWorkflow();
  };

  const announce = text => { $('#builder-live').textContent = ''; setTimeout(() => { $('#builder-live').textContent = text; }, 30); };
  const setState = value => {
    saveState = value;
    if (value === 'saved') delete document.body.dataset.dirty; else document.body.dataset.dirty = '1';
    renderStatus();
    readiness?.unsaved(value !== 'saved');
  };
  // One quiet line beside the actions, only when the author has something to act on. A live form whose
  // saved draft matches it shows nothing; the live version number is in Share. Failures stay prominent.
  const statusLine = () => {
    if (saveState === 'failed' || saveState === 'conflict') return { tone: 'bad', text: SAVE_TEXT[saveState] };
    if (saveState === 'saving') return { tone: 'quiet', text: SAVE_TEXT.saving };
    if (saveState === 'dirty') return { tone: 'pending', text: SAVE_TEXT.dirty };
    if (form.published_version) return form.has_unpublished_changes ? { tone: 'pending', text: 'Draft saved · not published' } : null;
    return { tone: 'quiet', text: form.locked_ids?.length ? 'Closed · not collecting' : 'Not published' };
  };
  const renderStatus = () => {
    const line = statusLine();
    const status = $('#builder-status');
    status.dataset.save = saveState;
    status.dataset.publish = form.published_version ? (form.has_unpublished_changes ? 'ahead' : 'live') : form.locked_ids?.length ? 'closed' : 'draft';
    status.dataset.liveVersion = form.published_version || '';
    status.setAttribute('role', line?.tone === 'bad' ? 'alert' : 'status');
    mount(status, line ? html`<span class="builder-status-text" data-tone="${line.tone}">${line.text}</span>` : '');
    // Publish is the main action only while there is something to publish.
    const publish = $('#publish');
    publish.textContent = form.published_version ? 'Publish changes' : form.locked_ids?.length ? 'Publish again' : 'Publish form';
    publish.classList.toggle('btn-primary', !form.published_version || form.has_unpublished_changes || saveState !== 'saved');
    mount($('#responses-link'), html`Responses<span class="tab-count"> (${form.response_count ?? 0})</span>`);
  };
  // The one link to give respondents, kept apart from the editor and preview. Nothing here publishes
  // or sends anything: copying, sharing and the email draft all stay on the creator's device.
  const renderShare = () => {
    const url = publicUrl(form);
    const closed = !form.published_version && form.locked_ids?.length;
    const heading = html`<h2 id="share-heading" tabindex="-1">Share with respondents</h2>`;
    if (!form.published_version) return mount($('#share-panel'), html`${heading}
      <p><strong>${closed ? 'Closed: not collecting responses.' : 'Not public yet.'}</strong> ${closed ? 'Anyone opening the link is told the form is closed. Responses already received are kept. Publishing again reopens the same link.' : 'Respondents cannot open this form until you publish it. The respondent link appears here once it is live.'}</p>
      <div class="actions"><button class="btn" type="button" data-share-publish>${closed ? 'Publish again' : 'Publish form'}</button><button class="btn" type="button" data-share-preview>Preview first</button></div>`);
    const email = `mailto:?subject=${encodeURIComponent(form.draft.title)}&body=${encodeURIComponent(`Please fill in this form: ${url}`)}`;
    const attribute = value => value.replace(/[&"<>]/g, char => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[char]);
    const embedCode = mode => `<iframe src="${url}?embed=1${mode ? '&mode=' + mode : ''}" title="${attribute(form.draft.title)}" width="100%" height="680" style="border:0;max-width:100%"></iframe>`;
    mount($('#share-panel'), html`${heading}
      <p class="share-live" data-share-live><span class="badge badge-published">Live · version ${form.published_version}</span>${form.has_unpublished_changes ? html` <span class="muted">Your saved draft has edits that are not published yet.</span>` : ''}</p>
      <p class="hint">${form.access === 'signin' && !boot.respondentSignin ? 'Nobody can respond right now: this form requires sign-in, and sign-in for respondents is switched off on this deployment. Change Settings → Who can respond to reopen it.' : form.access === 'signin' ? `Respondents must sign in with ${form.signin?.issuer_host || 'your identity provider'} before they see any question. Change this under Settings → Who can respond.` : 'Anyone with this link can open the live form and respond without signing in.'}</p>
      <label for="share-link">Respondent link</label>
      <div class="share-row"><input id="share-link" readonly value="${url}"><button class="btn btn-primary btn-small" type="button" data-copy-target="share-link">Copy link</button><a class="btn btn-small" id="open-live" href="${url}" target="_blank" rel="noopener">Open live form<span class="visually-hidden"> (opens in a new tab)</span></a></div>
      <p class="copy-status" id="share-status" role="status"></p>
      ${isLocalLink(url) ? notice('warn', html`<p><strong>This is a local address.</strong> It opens only on this computer or network, so respondents elsewhere cannot use it. Share the link from your deployed Schedora address instead.</p>`) : ''}
      <div class="share-row"><a class="btn btn-small" id="share-email" href="${email}" data-external>Email the link</a>${navigator.share ? html`<button class="btn btn-small" type="button" id="share-native">Share…</button>` : ''}</div>
      <p class="hint">Email the link opens a new message in your own email app; Schedora does not send it. Copying or sharing does not show that anyone has responded. Accepted responses appear under <a href="/forms/${form.id}/responses">Responses</a>.</p>
      <details class="share-embed"><summary>Conversational link and embed code</summary>
        <label for="share-conv">Conversational link (one question at a time)</label><div class="share-row"><input id="share-conv" readonly value="${publicUrl(form, 'conversational')}"><button class="btn btn-small" type="button" data-copy-target="share-conv">Copy</button></div>
        ${form.access === 'signin' ? html`<p class="hint" id="embed-signin-note"><strong>No embed code for this form.</strong> It asks respondents to sign in, which can't happen inside another website. An embedded copy would only show a button to open the form in a new tab. Share the link instead.</p>`
          : html`<label for="embed-mode">Embed layout</label><select id="embed-mode"><option value="">Form default (${form.draft.presentation === 'conversational' ? 'one question at a time' : 'classic'})</option><option value="classic">Classic</option><option value="conversational">One question at a time</option></select>
        <label for="embed">Embed code for your website</label><textarea id="embed" class="embed-code" readonly>${embedCode('')}</textarea>
        <p class="hint">The frame is 680 pixels tall and as wide as the space you place it in; longer forms scroll inside it. Links to booking pages and next steps open in the full window.</p>
        <button class="btn btn-small" type="button" data-copy-target="embed">Copy embed code</button>`}</details>
      <section class="share-prefill" aria-labelledby="prefill-heading"><h3 id="prefill-heading">Prefilled link</h3>
        <p class="hint">Start respondents with answers you already know, such as their programme. They can change them, and a link never proves who someone is. Separate from URL parameters, which record where a response came from.</p>
        <button class="btn btn-small" type="button" data-build-prefill>Build prefilled link</button></section>
      <p class="hint">Not for respondents: this editor page needs a workspace sign-in, and Preview runs only in your browser and saves nothing.</p>
      <div class="actions"><button class="btn btn-danger btn-small" type="button" id="unpublish">Stop collecting responses</button></div>`);
  };
  const workspaceAssetUrl = id => wsPath(`/form-assets/${id}`);
  // Sample link values stay on this page: never saved, sent or counted.
  const previewSamples = new Map();
  // The draft with the policy its next publish will carry, whatever the live version does.
  const renderPreview = () => renderForm($('#preview'), withEvaluationPolicy(draft), { mode: $('#preview-mode').value, preview: true, assetUrl: workspaceAssetUrl, urlParams: Object.fromEntries(previewSamples) });
  const renderPreviewParams = () => {
    const keys = declaredParams(draft).map(param => param.key);
    for (const key of previewSamples.keys()) if (!keys.includes(key)) previewSamples.delete(key);
    mount($('#preview-params'), html`${form.legacy_text_comparison ? html`<p class="hint" data-preview-policy>This preview shows what the next publish will do. Live version ${form.published_version} compares typed answers exactly as typed until then.</p>` : ''}${keys.length ? html`<div class="preview-params"><p class="hint">Sample link values for this preview. Nothing is recorded.</p>${keys.map(key => html`<label for="pp-${key}">${key}</label><input id="pp-${key}" data-preview-param="${key}" maxlength="${URL_PARAM_LIMITS.value}" autocomplete="off" value="${previewSamples.get(key) || ''}">`)}</div>` : ''}`);
  };

  const renderSettings = () => mount($('#settings'), html`<div class="card card-plain"><h2 id="settings-heading" tabindex="-1">Form details</h2>
    <div class="form-details"><div>
    <label for="f-title">Form title</label><input id="f-title" data-setting="title" maxlength="150" value="${draft.title}">
    <label for="f-description">Description</label><textarea id="f-description" data-setting="description" ${limitAttributes('f-description', DESCRIPTION_LIMITS.form)}>${draft.description || ''}</textarea>${characterCount('f-description', draft.description, DESCRIPTION_LIMITS.form, true)}</div><div>
    <fieldset><legend class="label" id="presentation-legend" tabindex="-1">Presentation</legend>
      <label class="check"><input type="radio" name="presentation" value="classic" data-setting="presentation" ${draft.presentation === 'classic' ? raw('checked') : ''}> Classic: questions grouped into pages</label>
      <label class="check"><input type="radio" name="presentation" value="conversational" data-setting="presentation" ${draft.presentation === 'conversational' ? raw('checked') : ''}> Conversational: one question at a time</label></fieldset>
    <label for="f-submit">Submit button text</label><input id="f-submit" data-setting="submit_label" maxlength="40" value="${draft.submit_label || 'Submit'}"></div></div></div>`);

  // Who can respond (docs/FORMS.md, "Respondent sign-in"). It belongs to the form, not the draft, so it applies
  // to the live form at once and is confirmed first.
  const renderAccess = () => {
    const signin = form.signin;
    const protectedForm = form.access === 'signin';
    // Respondent sign-in can be switched off for the whole deployment (FORMS_RESPONDENT_SIGNIN).
    if (!boot.respondentSignin) {
      return mount($('#access'), html`<div class="card card-plain access-card"><h2 id="access-heading" tabindex="-1">Who can respond</h2>
        <fieldset><legend class="visually-hidden">Who can respond</legend>
          <label class="check"><input type="radio" name="form-access" value="public" ${protectedForm ? '' : raw('checked')}> Anyone with the link</label>
          <label class="check"><input type="radio" name="form-access" value="signin" ${protectedForm ? raw('checked') : ''} disabled aria-describedby="access-off-hint"> Only people who sign in</label></fieldset>
        ${protectedForm ? notice('bad', html`<p id="access-off-hint"><strong>This form refuses every respondent.</strong> It requires sign-in, and sign-in for respondents is switched off on this Schedora deployment, so nobody can open or submit it and it cannot be published. Choose <strong>Anyone with the link</strong> to reopen it to everyone with the link.</p>`)
          : html`<p class="hint" id="access-off-hint">Requiring respondents to sign in is switched off on this Schedora deployment. Workspace single sign-on for members is not affected.</p>`}
        <p class="copy-status" id="access-status" role="status"></p></div>`);
    }
    mount($('#access'), html`<div class="card card-plain access-card"><h2 id="access-heading" tabindex="-1">Who can respond</h2>
      <fieldset><legend class="visually-hidden">Who can respond</legend>
        <label class="check"><input type="radio" name="form-access" value="public" ${protectedForm ? '' : raw('checked')}> Anyone with the link</label>
        <label class="check"><input type="radio" name="form-access" value="signin" ${protectedForm ? raw('checked') : ''} ${signin || protectedForm ? '' : raw('disabled')} aria-describedby="access-signin-hint"> Only people who sign in${signin ? html` with <strong>${signin.issuer_host}</strong> (@${signin.email_domain} accounts)` : ''}</label></fieldset>
      ${signin ? '' : notice('info', html`<p id="access-signin-hint">Sign-in uses this workspace's single sign-on, which is not set up. A workspace owner can connect your identity provider in <a href="/account">Account &amp; settings</a>.</p>`)}
      <p class="hint">Changes apply to the live form straight away, without publishing. People who sign in are not added to this workspace and cannot see or edit anything in it. Their verified email is stored with each response, separate from their answers, and prefilled links never stand in for it.</p>
      <p class="copy-status" id="access-status" role="status"></p></div>`);
  };

  // ---- Media editor: one image or one video per question, and pictures on choice options ----
  const mediaEditor = (field, index) => {
    const media = field.media;
    const status = html`<p class="copy-status" data-media-status role="status"></p>`;
    if (!media) return html`<div class="field-media" role="group" aria-labelledby="fm-${index}"><span class="visually-hidden" id="fm-${index}">Media (optional)</span>
      <div class="row"><label class="btn btn-small file-button">Add image<input type="file" accept="${IMAGE_TYPES.join(',')}" data-media-file class="visually-hidden"></label><button class="btn btn-small" type="button" data-media-video>Add video</button></div>
      <div data-video-entry hidden><label for="fvu-${index}">YouTube or Vimeo link</label><span class="hint" id="fvu-${index}-hint">Paste the video's address, for example https://www.youtube.com/watch?v=… or https://vimeo.com/…</span>
        <div class="share-row"><input id="fvu-${index}" data-video-url inputmode="url" aria-describedby="fvu-${index}-hint"><button class="btn btn-small" type="button" data-video-add>Add video</button><button class="btn btn-small" type="button" data-video-cancel>Cancel</button></div></div>
      <p class="hint">JPEG, PNG or WebP images up to 2 MB; larger photos are resized before upload.</p>${status}</div>`;
    if (media.type === 'image') return html`<div class="field-media" role="group" aria-labelledby="fm-${index}"><span class="label" id="fm-${index}">Image</span>
      <div class="media-edit"><img class="media-thumb" src="${workspaceAssetUrl(media.asset)}" alt="">
        <div><label for="fa-${index}">Image description (alt text)</label><span class="hint" id="fa-${index}-hint">What the image shows, for people who cannot see it. Up to 250 characters.</span>
          <input id="fa-${index}" data-media-alt maxlength="250" value="${media.alt || ''}" aria-describedby="fa-${index}-hint" ${media.decorative ? raw('disabled') : ''}>
          <label class="check"><input type="checkbox" data-media-decorative ${media.decorative ? raw('checked') : ''}> Decorative: it adds nothing a screen-reader user needs</label>
          <div class="row"><label class="btn btn-small file-button">Replace image<input type="file" accept="${IMAGE_TYPES.join(',')}" data-media-file class="visually-hidden"></label><button class="btn btn-small" type="button" data-media-remove>Remove image</button></div></div></div>${status}</div>`;
    return html`<div class="field-media" role="group" aria-labelledby="fm-${index}"><span class="label" id="fm-${index}">${VIDEO_PROVIDERS[media.provider]} video</span>
      <p class="hint">Respondents see a placeholder and load the video only if they choose; nothing contacts ${VIDEO_PROVIDERS[media.provider]} before that. <a href="${videoWatchUrl(media)}" target="_blank" rel="noopener noreferrer" data-external>Check the video<span class="visually-hidden"> (opens in a new tab)</span></a></p>
      <label for="fv-${index}">Player title <span class="muted">(optional)</span></label><span class="hint" id="fv-${index}-hint">Read by screen readers. Without one, the question is used.</span>
      <input id="fv-${index}" data-media-title maxlength="150" value="${media.title || ''}" aria-describedby="fv-${index}-hint">
      <div class="row"><button class="btn btn-small" type="button" data-media-remove>Remove video</button></div>${status}</div>`;
  };
  // Keyed by the question, not its position: only the selected question is on screen, and it can
  // be moved or deselected while an upload runs. The outcome is still reported if it is off screen.
  const pendingUploads = new Map(); // question → { blob, apply } kept for "Try again"
  const uploadImage = async (field, file, apply) => {
    const editor = () => `[data-index="${draft.fields.indexOf(field)}"]`;
    const say = (text, { retry = false, outcome = false } = {}) => {
      const node = $(`${editor()} [data-media-status]`);
      if (node) mount(node, html`${text}${retry ? html` <button class="btn-link" type="button" data-media-retry>Try again</button>` : ''}`);
      else if (outcome) toast(`“${field.label || 'Untitled question'}”: ${text}`);
    };
    let blob = pendingUploads.get(field)?.blob;
    try {
      if (!blob) { say('Preparing image…'); blob = await prepareImage(file); }
      pendingUploads.set(field, { blob, apply });
      say('Uploading image…');
      const asset = await api('POST', wsPath('/form-assets'), { data: await blobBase64(blob) }, {}, { timeout: 60000 });
      pendingUploads.delete(field);
      apply(asset);
      refresh({ fields: true });
      say(`Image uploaded (${asset.width} × ${asset.height}). Save the draft to keep it.`, { outcome: true });
      ($(`${editor()} [data-media-alt]:not([disabled])`) || $(`${editor()} [data-media-status]`))?.focus();
    } catch (error) {
      if (!blob) pendingUploads.delete(field);
      say(`Not uploaded. ${error.message}`, { retry: Boolean(pendingUploads.get(field)), outcome: true });
    }
  };
  $('#fields').addEventListener('change', event => {
    const editor = event.target.closest('[data-index]');
    if (!editor) return;
    const index = Number(editor.dataset.index);
    const field = draft.fields[index];
    if (event.target.matches('[data-media-file], [data-option-file]') && event.target.files[0]) {
      pendingUploads.delete(field);
      const option = event.target.dataset.optionFile;
      return uploadImage(field, event.target.files[0], asset => {
        if (option !== undefined) field.options[Number(option)].image = { asset: asset.id };
        else field.media = { type: 'image', asset: asset.id, ...(field.media?.type === 'image' ? { alt: field.media.alt, decorative: field.media.decorative } : { alt: '' }) };
      });
    }
    if (event.target.matches('[data-media-decorative]')) {
      field.media.decorative = event.target.checked;
      refresh({ fields: true });
      return $(`[data-index="${index}"] [data-media-decorative]`)?.focus();
    }
  });
  $('#fields').addEventListener('input', event => {
    const editor = event.target.closest('[data-index]');
    if (!editor || !event.target.matches('[data-media-alt], [data-media-title]')) return;
    draft.fields[Number(editor.dataset.index)].media[event.target.matches('[data-media-alt]') ? 'alt' : 'title'] = event.target.value;
    refresh();
  });
  $('#fields').addEventListener('click', event => {
    const button = event.target.closest('button');
    const editor = event.target.closest('[data-index]');
    if (!button || !editor) return;
    const index = Number(editor.dataset.index);
    const field = draft.fields[index];
    const entry = $('[data-video-entry]', editor);
    const say = text => { const node = $('[data-media-status]', editor); if (node) node.textContent = text; };
    if (button.matches('[data-media-video]')) { entry.hidden = false; return $('[data-video-url]', entry).focus(); }
    if (button.matches('[data-video-cancel]')) { entry.hidden = true; return $('[data-media-video]', editor).focus(); }
    if (button.matches('[data-video-add]')) {
      const video = parseVideoUrl($('[data-video-url]', entry).value);
      if (!video) { say('That is not a YouTube or Vimeo video address. Copy the link from the video page and try again.'); return $('[data-video-url]', entry).focus(); }
      field.media = { type: 'video', ...video };
      refresh({ fields: true });
      announce(`${VIDEO_PROVIDERS[video.provider]} video added. Save the draft to keep it.`);
      return $(`[data-index="${index}"] [data-media-title]`)?.focus();
    }
    if (button.matches('[data-media-remove]')) {
      const kind = field.media.type;
      delete field.media;
      refresh({ fields: true });
      announce(`${kind === 'image' ? 'Image' : 'Video'} removed from the draft. The live form keeps it until you publish.`);
      return $(`[data-index="${index}"] [data-media-file]`)?.closest('label')?.querySelector('input')?.focus();
    }
    if (button.matches('[data-option-image-remove]')) {
      const option = Number(button.dataset.optionImageRemove);
      delete field.options[option].image;
      refresh({ fields: true });
      announce('Picture removed from the option. The live form keeps it until you publish.');
      return $(`[data-index="${index}"] [data-option-file="${option}"]`)?.focus();
    }
    if (button.matches('[data-media-retry]')) { const pending = pendingUploads.get(field); if (pending) uploadImage(field, null, pending.apply); }
  });

  const collapsedPages = new Set();
  let fieldsTarget = null; // set while the panes are drawn off-screen
  const renderQuestionList = () => {
    const marks = outlineMarks(draft.fields);
    mount($('#question-list'), html`${draft.fields.map((field, index) => {
      if (field.group != null && collapsedPages.has(field.group)) return '';
      const pageBreak = field.type === 'page_break';
      const head = isHead(field);
      const open = head && !collapsedPages.has(field.id);
      const title = head ? field.label || 'Untitled page' : pageBreak ? FIELD_TYPES.page_break : field.label || FIELD_TYPES[field.type];
      return html`<div class="question-row${field.group != null ? ' is-member' : ''}${head ? ' is-page' : ''}" data-question-row="${index}" data-question-key="${field.id}" data-question-type="${field.type}">
        <span class="question-grip" data-drag-handle aria-hidden="true" title="Drag to reorder">⋮⋮</span>
        <button type="button" class="question-select" data-question-index="${index}" aria-pressed="${String(selectedEnding === null && index === selectedQuestion)}">
          <span class="q-badge" data-kind="${TYPE_KIND[field.type]}">${formIcon(head ? 'page' : field.type)}${marks[index] ? html`<span class="question-row-number">${marks[index]}</span>` : ''}</span><span class="question-row-label">${title}</span>${field.show_if || rulesFor(draft, field.id).length || choiceRulesFor(draft, field.id).length ? html`<span class="question-row-logic">Logic</span>` : ''}</button>
        ${head ? html`<button type="button" class="question-toggle" data-page-toggle="${field.id}" aria-expanded="${String(open)}" aria-label="${open ? 'Collapse' : 'Expand'} page ${title}" title="${open ? 'Collapse' : 'Expand'} page">${formIcon('chevron')}</button>` : ''}</div>`;
    })}`);
    mount($('#ending-list'), html`${(draft.endings || []).map((ending, index) => html`<div class="question-row ending-row"><button type="button" class="question-select" data-ending-index="${index}" aria-pressed="${String(index === selectedEnding)}"><span class="q-badge" data-kind="layout">${formIcon('ending')}</span><span class="question-row-label">${ending.title || 'Untitled ending'}</span>${index === 0 ? html`<span class="question-row-logic">Default</span>` : ''}</button></div>`)}`);
    renderOutlineBar(marks);
  };
  // Phones and narrow tablets: the outline folds into a bar naming the selection, with previous/next.
  // "Outline" opens the full list (names, pages and their questions, the selection) above the canvas.
  const outlineItems = () => [...$$('#question-list .question-select, #ending-list .question-select')];
  const renderOutlineBar = (marks = outlineMarks(draft.fields)) => {
    const questions = draft.fields.filter((field, index) => marks[index]).length;
    let badge, title, where;
    if (selectedEnding !== null) {
      const ending = draft.endings?.[selectedEnding];
      badge = html`<span class="q-badge" data-kind="layout">${formIcon('ending')}</span>`;
      title = ending?.title || 'Untitled ending';
      where = `Ending ${selectedEnding + 1} of ${draft.endings.length}`;
    } else {
      const field = draft.fields[selectedQuestion];
      if (!field) { mount($('#outline-current'), html`<span class="outline-text"><span class="outline-title">No questions yet</span></span>`); return; }
      const head = isHead(field);
      const pageBreak = field.type === 'page_break';
      badge = html`<span class="q-badge" data-kind="${TYPE_KIND[field.type]}">${formIcon(head ? 'page' : field.type)}${marks[selectedQuestion] ? html`<span class="question-row-number">${marks[selectedQuestion]}</span>` : ''}</span>`;
      title = head ? field.label || 'Untitled page' : pageBreak ? FIELD_TYPES.page_break : field.label || FIELD_TYPES[field.type];
      const page = draft.fields.slice(0, selectedQuestion + 1).filter(item => item.type === 'page_break' && !item.grouped).length + 1;
      const owner = field.group != null ? draft.fields.find(item => item.id === field.group) : null;
      const number = draft.fields.slice(0, selectedQuestion + 1).filter((item, index) => marks[index]).length;
      where = [owner ? `In “${owner.label || 'Untitled page'}”` : head ? 'Multi-question page' : `Page ${page}`, marks[selectedQuestion] ? `${number} of ${questions}` : null].filter(Boolean).join(' · ');
    }
    mount($('#outline-current'), html`${badge}<span class="outline-text"><span class="outline-title">${title}</span><span class="outline-where">${where}</span></span>`);
    const items = outlineItems();
    const at = items.findIndex(item => item.getAttribute('aria-pressed') === 'true');
    $('#outline-prev').disabled = at <= 0;
    $('#outline-next').disabled = at < 0 || at >= items.length - 1;
  };
  const paramOptions = selected => declaredParams(draft).length ? html`<optgroup label="URL parameters">${declaredParams(draft).map(({ key }) => html`<option value="${paramSourceValue(key)}" ${key === selected ? raw('selected') : ''}>${key}</option>`)}</optgroup>` : '';
  // Jump rules for one question, in the settings pane. The first matching rule decides.
  const jumpEditor = (field, index, prefix = '') => {
    const rules = rulesFor(draft, field.id);
    const groups = jumpTargets(draft, index);
    const askable = draft.fields.slice(0, index + 1).filter(candidate => candidate.type !== 'page_break');
    const closed = rules.at(-1) && rules.at(-1).when == null;
    const ruleRow = (rule, position) => {
      const compound = rule.when?.all || rule.when?.any;
      const asked = !compound && rule.when && askable.find(candidate => candidate.id === rule.when.field);
      const name = `Jump ${position + 1}`;
      return html`<li class="jump-rule" data-jump="${position}">
        ${compound ? html`<p class="hint">This rule combines conditions, and is kept as written.</p>` : html`
          <label for="${prefix}jf-${position}">If</label><select id="${prefix}jf-${position}" data-jump-field aria-label="${name}: question">${position === rules.length - 1 ? html`<option value="" ${rule.when ? '' : raw('selected')}>Always</option>` : ''}${askable.map(candidate => html`<option value="${candidate.id}" ${candidate.id === rule.when?.field ? raw('selected') : ''}>${candidate.label.slice(0, 50)}</option>`)}${paramOptions(rule.when?.param)}</select>
          ${rule.when ? html`<select data-jump-op aria-label="${name}: rule">${Object.entries(CONDITION_OPS).map(([op, label]) => html`<option value="${op}" ${op === rule.when.op ? raw('selected') : ''}>${label}</option>`)}</select>
            ${['answered', 'not_answered'].includes(rule.when.op) ? '' : asked?.type.endsWith('_choice')
              ? html`<select data-jump-value aria-label="${name}: value">${asked.options.map(option => html`<option value="${option.id}" ${option.id === rule.when.value ? raw('selected') : ''}>${option.label}</option>`)}</select>`
              : html`<input data-jump-value aria-label="${name}: value" value="${rule.when.value || ''}">`}` : ''}`}
        <label for="${prefix}jt-${position}">Go to</label><select id="${prefix}jt-${position}" data-jump-to>${groups.map(group => html`<optgroup label="${group.label}">${group.items.map(item => html`<option value="${item.value}" ${item.value === targetValue(rule.to) ? raw('selected') : ''}>${item.label}</option>`)}</optgroup>`)}</select>
        <div class="row"><button class="btn btn-small" type="button" data-jump-move="-1" aria-label="Move jump ${position + 1} up" ${position === 0 || !rule.when ? raw('disabled') : ''}>↑</button><button class="btn btn-small" type="button" data-jump-move="1" aria-label="Move jump ${position + 1} down" ${position === rules.length - 1 || !rules[position + 1].when ? raw('disabled') : ''}>↓</button><button class="btn btn-small" type="button" data-jump-remove aria-label="Remove jump ${position + 1}">Remove</button></div>
        <p class="logic-sentence" data-jump-sentence>${jumpSentence(rule, draft, position === 0)}</p></li>`;
    };
    return html`<div class="jump-editor"><h4 class="jump-heading">After this question</h4>
      ${rules.length ? html`<ol class="jump-rules">${rules.map(ruleRow)}</ol><p class="hint">Checked in order; the first match decides. If none match, the next question follows. Answers on a skipped path are not saved.</p>`
        : html`<p class="hint">Goes to the next question.</p>`}
      ${groups.length ? (closed ? html`<p class="hint">The last rule always matches, so a new one could never run. Change it to add another.</p>` : html`<button class="btn btn-small" type="button" data-jump-add ${rules.length >= 20 ? raw('disabled') : ''}>Add jump</button>`) : html`<p class="hint">Nothing comes after this question yet. Add a question or an ending to jump to.</p>`}</div>`;
  };
  // Hide-choice rules for one question, in Workflow. Every rule that holds adds to what is hidden.
  const choiceConflict = (field, position) => choiceRuleConflicts(draft).find(conflict => conflict.field === field.id && conflict.rule === position)?.message || '';
  const choiceRuleEditor = (field, index) => {
    const rules = choiceRulesFor(draft, field.id);
    const isChoice = field.type.endsWith('_choice');
    if (!isChoice && !rules.length) return '';
    const sources = choiceRuleSources(draft, index);
    const ruleRow = (rule, position) => {
      const asked = sources.find(candidate => candidate.id === rule.when.field);
      const name = `Hide rule ${position + 1}`;
      const conflict = choiceConflict(field, position);
      const removed = rule.hide.filter(id => !field.options?.some(option => option.id === id));
      return html`<li class="jump-rule choice-rule" data-choice-rule="${position}">
        <label for="wf-crf-${position}">If</label><select id="wf-crf-${position}" data-cr-field aria-label="${name}: question">${asked || declaredParams(draft).some(param => param.key === rule.when.param) ? '' : html`<option value="" selected>${rule.when.param != null ? 'A URL parameter no longer declared' : 'A question no longer before this one'}</option>`}${sources.map(candidate => html`<option value="${candidate.id}" ${candidate === asked ? raw('selected') : ''}>${candidate.label.slice(0, 50)}</option>`)}${paramOptions(rule.when.param)}</select>
        <select data-cr-op aria-label="${name}: rule">${Object.entries(CONDITION_OPS).map(([op, label]) => html`<option value="${op}" ${op === rule.when.op ? raw('selected') : ''}>${label}</option>`)}</select>
        ${['answered', 'not_answered'].includes(rule.when.op) ? '' : asked?.type.endsWith('_choice')
          ? html`<select data-cr-value aria-label="${name}: value">${asked.options.some(option => option.id === rule.when.value) ? '' : html`<option value="" selected>An option that was removed</option>`}${asked.options.map(option => html`<option value="${option.id}" ${option.id === rule.when.value ? raw('selected') : ''}>${option.label}</option>`)}</select>`
          : html`<input data-cr-value aria-label="${name}: value" value="${rule.when.value || ''}">`}
        ${isChoice ? html`<fieldset class="choice-rule-hide"><legend>Hide these choices</legend>${field.options.map(option => html`<label class="check"><input type="checkbox" data-cr-hide="${option.id}" ${rule.hide.includes(option.id) ? raw('checked') : ''}> ${option.label}</label>`)}${removed.map(id => html`<label class="check"><input type="checkbox" data-cr-hide="${id}" checked> A choice that was removed (${id})</label>`)}</fieldset>` : ''}
        <div class="row"><button class="btn btn-small" type="button" data-cr-remove aria-label="Remove hide rule ${position + 1}">Remove</button></div>
        <p class="logic-sentence" data-cr-sentence>${choiceRuleSentence(rule, field, draft.fields)}</p>
        <p class="choice-rule-conflict" data-cr-conflict ${conflict ? '' : raw('hidden')}>${conflict}</p></li>`;
    };
    return html`<div class="choice-rule-editor"><h4 class="jump-heading">Hide choices</h4>
      ${rules.length ? html`<ol class="jump-rules">${rules.map(ruleRow)}</ol><p class="hint">Every rule that matches hides its choices. A selected choice that becomes hidden is removed from the answer. If every choice is hidden, the question is skipped, even when required.</p>` : ''}
      ${!canHideChoices(field) ? (isChoice ? html`<p class="hint">Hiding choices is not supported on a question inside a multi-question page. Move it off the page to use this.</p>` : '')
        : !sources.length && !declaredParams(draft).length ? html`<p class="hint">Hiding choices uses an earlier answer or a URL parameter, and this form has neither yet.</p>`
        : html`${rules.length ? '' : html`<p class="hint">All choices are shown.</p>`}<button class="btn btn-small" type="button" data-cr-add ${rules.length >= 20 ? raw('disabled') : ''}>Add hide rule</button>`}</div>`;
  };
  // The same rules in words on the Content inspector; they are edited in Workflow.
  const choiceRuleSummary = field => {
    const rules = choiceRulesFor(draft, field.id);
    if (!rules.length) return '';
    return html`<div class="choice-rule-summary"><h4 class="jump-heading">Hide choices</h4>
      <ul class="jump-rules">${rules.map((rule, position) => { const conflict = choiceConflict(field, position); return html`<li data-choice-rule="${position}"><p class="logic-sentence" data-cr-sentence>${choiceRuleSentence(rule, field, draft.fields)}</p><p class="choice-rule-conflict" data-cr-conflict ${conflict ? '' : raw('hidden')}>${conflict}</p></li>`; })}</ul>
      <button class="btn btn-small" type="button" data-open-workflow>Edit in Workflow</button></div>`;
  };
  const paintCanvas = () => { const frame = $('#fields .canvas-frame'); if (frame) applyTheme(frame, draft.theme); };
  const renderEnding = index => {
    const ending = draft.endings[index];
    mount($('#fields'), html`<section class="field-editor question-canvas" data-ending="${index}" aria-label="Edit ending ${index + 1}">
        <div class="field-editor-head"><strong class="visually-hidden">Ending ${index + 1}</strong></div>
        <div class="canvas-tools"><button class="btn btn-icon btn-danger" type="button" data-ending-remove aria-label="Remove ending ${index + 1}" title="Remove ending">${formIcon('trash')}</button></div>
        <div class="canvas-frame"><div class="canvas-body"><label for="et-${index}">Title</label><input id="et-${index}" class="canvas-question" data-ending-prop="title" maxlength="150" value="${ending.title}">
        <label for="em-${index}">Message <span class="muted">(optional)</span></label><textarea id="em-${index}" data-ending-prop="message" maxlength="2000">${ending.message || ''}</textarea>
        <p class="hint">Earlier answers can be inserted with {{question_key}}. Line breaks are kept.</p>
        <div class="ending-fixed" aria-label="Always shown below the ending"><p>Your answers were saved.</p><dl class="confirm-facts"><dt>Receipt</dt><dd>A1B2C3D4</dd><dt>Received</dt><dd>Date and time</dd></dl><p class="hint">Always shown below your ending, with each respondent's own receipt. A routing step, such as choosing a time, follows when one applies.</p></div></div></div></section>
      <aside class="question-settings" data-ending="${index}" aria-label="Ending settings"><div class="inspector-section"><h3 class="inspector-title">When respondents see it</h3>${endingRoutes(ending, index)}${index === 0 ? '' : html`<button class="btn btn-small" type="button" data-ending-default>Make default</button>`}</div></aside>`);
  };
  // Which jumps lead to an ending, in words; the default also closes every path no jump ends early.
  const endingRoutes = (ending, index) => {
    const routes = [];
    draft.fields.forEach((field, fieldIndex) => rulesFor(draft, field.id).forEach((rule, position) => {
      if (rule.to?.type === 'ending' && rule.to.id === ending.id) routes.push(html`<li><strong>After ${itemName(fieldIndex)}</strong>: ${jumpSentence(rule, draft, position === 0)}</li>`);
    }));
    return html`<p class="hint">${index === 0 ? 'The default: shown at the end of the form unless a jump chooses another ending.' : routes.length ? 'Shown only when one of these jumps applies.' : 'No jump leads here yet, so nobody sees it. Add a jump to it in Workflow, or make it the default.'}</p>
      ${routes.length ? html`<ul class="ending-routes">${routes}</ul>` : ''}`;
  };
  // Workflow: the map of what leads where, and the same jump editor as the inspector beside it, so one
  // set of rules is edited and drawn. Selecting here selects in Content too.
  const workflowActive = () => $('.builder-page').dataset.surface === 'workflow';
  const renderWorkflowMap = () => {
    if (!workflowActive()) return;
    const map = logicMapModel(draft);
    const sentences = key => map.jumps.filter(jump => jump.from === key);
    const hides = key => map.choices.filter(rule => rule.field === key);
    const conflictsOf = key => map.conflicts.filter(conflict => conflict.field === key);
    const orphans = map.conflicts.filter(conflict => conflict.rule === null);
    mount($('#workflow-nodes'), html`${map.nodes.map(node => html`<li class="workflow-node${node.member ? ' is-member' : ''}${node.reached ? '' : ' is-unreached'}" data-map-node="${node.key}">
        ${node.kind === 'ending' || node.kind === 'end' ? html`<div class="workflow-end"><span class="q-badge" data-kind="layout">${formIcon('ending')}</span><span>${node.label}${node.defaultEnding ? html` <span class="muted">· default</span>` : ''}</span></div>`
          : html`<button type="button" class="workflow-select" data-map-select="${node.index}" aria-pressed="${String(node.index === selectedQuestion)}"><span class="q-badge" data-kind="${TYPE_KIND[node.type]}">${formIcon(node.kind === 'page' ? 'page' : node.type)}${node.mark ? html`<span class="question-row-number">${node.mark}</span>` : ''}</span><span>${node.label}</span></button>`}
        ${node.reached ? '' : html`<p class="workflow-note">No path leads here.</p>`}
        ${sentences(node.key).length ? html`<ul class="workflow-rules">${sentences(node.key).map(jump => html`<li>${jump.sentence}</li>`)}</ul>` : ''}
        ${hides(node.key).length ? html`<ul class="workflow-rules" data-map-hides>${hides(node.key).map(rule => html`<li>${rule.sentence}</li>`)}</ul>` : ''}
        ${conflictsOf(node.key).map(conflict => html`<p class="workflow-note" data-map-conflict>${conflict.message}</p>`)}</li>`)}`);
    mount($('#workflow-summary'), html`${map.jumps.length} jump rule${map.jumps.length === 1 ? '' : 's'}.${map.choices.length ? ` ${map.choices.length} hide-choice rule${map.choices.length === 1 ? '' : 's'}.` : ''}${map.unreached.length ? ` ${map.unreached.length} item${map.unreached.length === 1 ? '' : 's'} no path leads to.` : ' Every item can be reached.'}${map.conflicts.length ? html` <strong data-conflict-count>${map.conflicts.length} hide-choice conflict${map.conflicts.length === 1 ? '' : 's'} to fix before publishing.</strong>` : ''}${orphans.length ? html` ${orphans[0].message} <button class="btn btn-small" type="button" data-cr-orphans>Remove</button>` : ''}`);
    drawWorkflowArcs(map);
  };
  // The jumps as arcs beside the list. Decorative: every jump is also written under its question.
  const drawWorkflowArcs = map => {
    const svg = $('#workflow-arcs');
    const list = $('#workflow-nodes');
    while (svg.firstChild) svg.firstChild.remove();
    const box = list.getBoundingClientRect();
    if (!box.width) return;
    svg.setAttribute('width', 96);
    svg.setAttribute('height', list.scrollHeight);
    const rowOf = key => { const node = $(`[data-map-node="${CSS.escape(key)}"]`, list); if (!node) return null; const row = node.getBoundingClientRect(); return row.top - box.top + Math.min(row.height / 2, 22); };
    map.jumps.forEach((jump, position) => {
      const from = rowOf(jump.from);
      const to = rowOf(jump.to);
      if (from === null || to === null) return;
      const lane = 14 + (position % 5) * 15;
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', `M0 ${from} H${lane - 6} Q${lane} ${from} ${lane} ${from + 6} V${to - 6} Q${lane} ${to} ${lane - 6} ${to} H6 M11 ${to - 4} L6 ${to} L11 ${to + 4}`);
      path.setAttribute('class', jump.conditional ? 'workflow-arc' : 'workflow-arc is-always');
      path.dataset.arc = `${jump.from}>${jump.to}`;
      svg.append(path);
    });
  };
  const renderWorkflowEditor = () => {
    if (!workflowActive()) return;
    const field = draft.fields[selectedQuestion];
    const root = $('#workflow-editor');
    if (!field) return mount(root, html`<p class="hint">Add a question to start building logic.</p>`);
    if (field.type === 'page_break') return mount(root, html`<h3 id="workflow-editor-heading" tabindex="-1">${isHead(field) ? field.label || 'Untitled page' : 'Page break'}</h3><p class="hint">A page can be jumped to, and its rules live on the questions on it. Choose a question to add a jump.</p>`);
    mount(root, html`<div data-index="${selectedQuestion}"><h3 id="workflow-editor-heading" tabindex="-1">${outlineMarks(draft.fields)[selectedQuestion]}. ${field.label || 'Untitled question'}</h3>${jumpEditor(field, selectedQuestion, 'wf-')}${choiceRuleEditor(field, selectedQuestion)}</div>`);
  };
  const renderUrlParams = (message = '') => {
    if (!workflowActive()) return;
    const params = declaredParams(draft);
    mount($('#url-params'), html`<h2 id="url-params-heading" tabindex="-1">URL parameters</h2>
      <p class="hint">Named values a link can carry, such as utm_source. They can drive jumps and hide choices, and are not answers. Anyone can edit a link, so never rely on one to decide who someone is or what they are allowed to see. Other names in a link are ignored.</p>
      ${params.length ? html`<ul class="url-param-list">${params.map(({ key, record }) => html`<li class="url-param-row" data-url-param="${key}"><code>${key}</code>
        <label class="check"><input type="checkbox" data-url-record="${key}" ${record ? raw('checked') : ''}> Record with each response</label>
        <button class="btn btn-small" type="button" data-url-remove="${key}" aria-label="Remove ${key}">Remove</button></li>`)}</ul>
        <p class="hint">Recorded values appear in the inbox and CSV as attribution, separate from answers. Others are used for rules, then discarded. A value that is empty or over ${URL_PARAM_LIMITS.value} characters counts as missing, and if a name repeats, the first one counts.</p>` : ''}
      <div class="url-param-add"><div><label for="url-param-key">New parameter name</label><input id="url-param-key" maxlength="40" autocomplete="off" spellcheck="false" placeholder="utm_source"></div><button class="btn btn-small" type="button" data-url-add>Add parameter</button></div>
      <div id="url-param-message" role="status">${message}</div>
      ${params.length ? html`<label for="url-param-link">Example link</label><div class="share-row"><input id="url-param-link" readonly value="${exampleLink(publicUrl(form), draft)}"><button class="btn btn-small" type="button" data-url-copy>Copy example link</button></div>
        <p class="hint">Replace the sample values with your own. The link works once this form is published, and new parameters take effect when you publish.</p><p class="copy-status" id="url-param-copied" role="status"></p>` : ''}`);
  };
  const renderWorkflow = () => { renderWorkflowMap(); renderWorkflowEditor(); renderUrlParams(); };
  $('#workflow-nodes').addEventListener('click', event => {
    const button = event.target.closest('[data-map-select]');
    if (!button) return;
    selectedQuestion = Number(button.dataset.mapSelect);
    selectedEnding = null;
    renderFields();
    renderWorkflow();
    $(`[data-map-select="${selectedQuestion}"]`)?.focus();
  });
  window.addEventListener('resize', () => { if ($('#workflow-nodes')?.isConnected && workflowActive()) drawWorkflowArcs(logicMapModel(draft)); });
  const fitCanvasText = () => { if (!CSS.supports('field-sizing', 'content')) $$('#fields .canvas-question, #fields .canvas-description, #fields .canvas-member-label').forEach(area => { area.style.height = 'auto'; area.style.height = area.scrollHeight + 'px'; }); };
  // Question and Answer start open; Media and Logic stay one line until they hold something. A section
  // the author opened or closed stays that way while moving between questions.
  const sectionChoice = new Map();
  const inspectorSection = (key, title, body, used = true) => html`<details class="inspector-section" data-inspector="${key}" ${sectionChoice.get(key) ?? used ? raw('open') : ''}><summary>${title}</summary>${body}</details>`;
  // The answer area of a question, the same on its own canvas and inside a page.
  const answerArea = (field, index, name) => field.type.endsWith('_choice') ? html`<fieldset class="canvas-options"><legend class="visually-hidden">Options</legend>${field.options.map((option, optionIndex) => html`<div class="canvas-option-row"><span class="canvas-option-key" aria-hidden="true">${String.fromCharCode(65 + optionIndex % 26)}</span><input class="canvas-option" aria-label="Option ${optionIndex + 1} of ${name}" data-option="${optionIndex}" maxlength="200" value="${option.label}">${option.image ? html`<span class="row"><img class="option-thumb" src="${workspaceAssetUrl(option.image.asset)}" alt=""><button class="btn btn-small" type="button" data-option-image-remove="${optionIndex}" aria-label="Remove the picture from option ${optionIndex + 1}">Remove picture</button></span>`
      : html`<label class="btn btn-small file-button">Picture<span class="visually-hidden"> for option ${optionIndex + 1}</span><input type="file" accept="${IMAGE_TYPES.join(',')}" data-option-file="${optionIndex}" class="visually-hidden"></label>`}
      <button class="btn btn-icon" data-remove-option="${optionIndex}" aria-label="Remove option ${optionIndex + 1}" title="Remove option" ${field.options.length === 1 ? raw('disabled') : ''}>${formIcon('trash')}</button></div>`)}
    ${field.options.some(option => option.image) ? html`<p class="hint">Pictures appear above each option's text. Answers, logic and exports use the option text, not the picture.</p>` : ''}
    <button class="btn-link" data-add-option>Add option</button></fieldset>` : html`<div class="canvas-answer" aria-hidden="true">${field.placeholder || ANSWER_SAMPLES[field.type] || 'Answer'}</div>`;
  const itemName = index => {
    const field = draft.fields[index];
    if (field.grouped) return `page “${field.label || 'Untitled page'}”`;
    if (field.type === 'page_break') return `page break ${index + 1}`;
    return `question ${outlineMarks(draft.fields)[index]}`;
  };
  // Move, duplicate and remove act on the selected item, so they are drawn apart from the canvas wording.
  const canvasTools = (field, index) => { const name = itemName(index); return html`<div class="canvas-tools" data-index="${index}"><button class="btn btn-icon" data-move="-1" ${canMove(draft.fields, index, -1) ? '' : raw('disabled')} aria-label="Move ${name} up" title="Move up">${formIcon('up')}</button><button class="btn btn-icon" data-move="1" ${canMove(draft.fields, index, 1) ? '' : raw('disabled')} aria-label="Move ${name} down" title="Move down">${formIcon('down')}</button>${field.type === 'page_break' && !field.grouped ? '' : html`<button class="btn btn-icon" data-duplicate aria-label="Duplicate ${name}" title="Duplicate">${formIcon('copy')}</button>`}<button class="btn btn-icon btn-danger" data-remove aria-label="Remove ${name}" title="Remove">${formIcon('trash')}</button></div>`; };
  // A page on the canvas: its title and description, then every question on it, each editable in place.
  const pageCanvas = (head, selected) => {
    const headAt = draft.fields.indexOf(head);
    const marks = outlineMarks(draft.fields);
    const members = draft.fields.map((field, index) => [field, index]).filter(([field]) => field.group === head.id);
    return html`<section class="field-editor question-canvas" data-page-canvas="${head.id}" aria-label="Edit page ${head.label || 'Untitled page'}">${canvasTools(draft.fields[selected], selected)}
      <div class="canvas-frame"><div class="canvas-body canvas-page">
        <div class="canvas-question-row${selected === headAt ? ' is-selected' : ''}" data-index="${headAt}" data-member="${headAt}">
          <span class="canvas-number">${marks[headAt]}</span>
          <div><label class="visually-hidden" for="fl-${headAt}">Page title</label><textarea id="fl-${headAt}" class="canvas-question" data-prop="label" rows="1" maxlength="150" placeholder="Page title">${head.label}</textarea>
            <label class="visually-hidden" for="fh-${headAt}">Page description (optional)</label><textarea id="fh-${headAt}" class="canvas-description" data-prop="help" rows="1" ${limitAttributes(`fh-${headAt}`, DESCRIPTION_LIMITS.page)} placeholder="Description (optional)">${head.help || ''}</textarea>${characterCount(`fh-${headAt}`, head.help, DESCRIPTION_LIMITS.page)}</div></div>
        ${members.map(([field, index]) => html`<div class="canvas-member${selected === index ? ' is-selected' : ''}" data-index="${index}" data-member="${index}">
          <div class="canvas-member-head"><label class="visually-hidden" for="fl-${index}">Question ${marks[index]}</label><textarea id="fl-${index}" class="canvas-member-label" data-prop="label" rows="1" maxlength="300" placeholder="Your question here">${field.label}</textarea>${field.required ? html`<span class="required-mark" aria-hidden="true">*</span>` : ''}</div>
          ${answerArea(field, index, `question ${marks[index]}`)}</div>`)}
        ${members.length ? '' : html`<p class="hint canvas-member">No questions on this page yet. Use Add content while the page is selected.</p>`}
        <span class="canvas-button canvas-page-button" aria-hidden="true">OK</span></div></div></section>`;
  };
  const renderFields = () => {
    selectedQuestion = Math.max(0, Math.min(selectedQuestion, draft.fields.length - 1));
    if (draft.fields[selectedQuestion]?.group != null) collapsedPages.delete(draft.fields[selectedQuestion].group);
    if (!draft.endings?.[selectedEnding]) selectedEnding = null;
    renderQuestionList();
    if (selectedEnding !== null) { renderEnding(selectedEnding); return paintCanvas(); }
    const locked = new Set(form.locked_ids || []);
    mount(fieldsTarget || $('#fields'), html`${draft.fields.map((field, index) => {
      if (index !== selectedQuestion) return '';
      const earlier = draft.fields.slice(0, index).filter(candidate => candidate.type !== 'page_break');
      const source = field.show_if && draft.fields.find(candidate => candidate.id === field.show_if.field);
      const number = draft.fields.slice(0, index + 1).filter(candidate => candidate.type !== 'page_break').length;
      const name = field.type === 'page_break' ? `page break ${index + 1}` : `question ${number}`;
      const pageBreak = field.type === 'page_break';
      // The canvas looks like the respondent's question; wording is edited in place. Two panes share
      // one data-index, so every editing control is handled the same way in either.
      const page = field.grouped ? field : field.group != null ? draft.fields.find(candidate => candidate.id === field.group) : null;
      const canvas = page ? pageCanvas(page, index) : html`<section class="field-editor question-canvas ${pageBreak ? 'page-break' : ''}" data-index="${index}" aria-label="Edit ${name}">${canvasTools(field, index)}
        <div class="canvas-frame"><div class="canvas-body">${pageBreak ? html`<p class="canvas-page-break">Page break</p><p class="hint">Questions after this start a new page in classic presentation, and a jump can go to it.</p>` : html`
          <div class="canvas-question-row">
            <span class="canvas-number">${number}</span>
            <div><label class="visually-hidden" for="fl-${index}">Question</label><textarea id="fl-${index}" class="canvas-question" data-prop="label" rows="1" maxlength="300" placeholder="Your question here" aria-describedby="fl-${index}-hint">${field.label}</textarea>
              <label class="visually-hidden" for="fh-${index}">Description (optional)</label><textarea id="fh-${index}" class="canvas-description" data-prop="help" rows="1" ${limitAttributes(`fh-${index}`, DESCRIPTION_LIMITS.question)} placeholder="Description (optional)">${field.help || ''}</textarea>${characterCount(`fh-${index}`, field.help, DESCRIPTION_LIMITS.question)}</div>
            ${field.media?.type === 'image' ? html`<img class="canvas-media" src="${workspaceAssetUrl(field.media.asset)}" alt="">` : field.media?.type === 'video' ? html`<p class="canvas-note">${VIDEO_PROVIDERS[field.media.provider]} video placeholder</p>` : ''}
            <div class="canvas-answer-area">${answerArea(field, index, name)}<span class="canvas-button" aria-hidden="true">OK</span></div>
          </div>`}</div></div>
      </section>`;
      return html`${canvas}<aside class="question-settings" data-index="${index}" aria-labelledby="question-settings-heading">
        <h3 class="visually-hidden" id="question-settings-heading">${pageBreak ? 'Page settings' : 'Question settings'}</h3>
        ${field.grouped ? html`<div class="inspector-section inspector-note"><p class="hint">Edit this page's title and description on the canvas. Choose a question on it to change that question's settings.</p></div>` : ''}
        ${pageBreak ? '' : inspectorSection('question', 'Question', html`
          <label for="ft-${index}">Type</label><select id="ft-${index}" data-type aria-describedby="ft-${index}-note">${typeChoices(field).map(type => html`<option value="${type}" ${type === field.type ? raw('selected') : ''}>${FIELD_TYPES[type]}</option>`)}</select>
          <div id="ft-${index}-note" data-type-note></div>
          <details class="field-advanced"><summary>Question key <span class="muted">· ${field.id}</span></summary>
            <p class="hint" id="fl-${index}-hint">Insert an earlier answer with {{question_key}}${earlier.length ? `, for example {{${earlier[0].id}}}` : ''}.</p>
            <span class="hint" id="key-hint-${index}">Used in exports, logic and {{${field.id}}} insertions. Lowercase letters, numbers and underscores.</span>
            <input data-prop="id" value="${field.id}" maxlength="40" pattern="[a-z0-9_]+" aria-label="Question key" aria-describedby="key-hint-${index}${locked.has(field.id) ? ' key-locked-' + index : ''}" class="key-input" ${locked.has(field.id) ? raw('readonly') : ''}>
            <p class="hint">${prefillProblem(field) ? html`Prefilled links: not available. ${prefillProblem(field)}` : html`Prefilled links fill this question with <code>answer.${field.id}=…</code>. Build one under Share.`}</p>
            ${locked.has(field.id) ? html`<p class="hint" id="key-locked-${index}">The key is fixed because a published version uses it, so earlier answers stay matched to this question.</p>` : ''}</details>`)}
        ${pageBreak ? '' : inspectorSection('answer', 'Answer', html`<label class="check"><input type="checkbox" data-prop="required" ${field.required ? raw('checked') : ''}> Required</label>${['short_text', 'long_text', 'email', 'phone'].includes(field.type) ? html`<label for="fp-${index}">Placeholder <span class="muted">(optional)</span></label><input id="fp-${index}" data-prop="placeholder" maxlength="100" value="${field.placeholder || ''}">` : ''}`)}
        ${pageBreak ? '' : inspectorSection('media', 'Media', mediaEditor(field, index), Boolean(field.media))}
        ${inspectorSection('logic', 'Logic', html`
          <label class="check"><input type="checkbox" data-logic ${field.show_if ? raw('checked') : ''} ${earlier.length ? '' : raw('disabled')}> ${pageBreak ? 'Show this page only when…' : 'Show only when…'}</label>
          ${field.show_if ? html`<div class="row">
            <select data-cond="field" aria-label="Earlier question">${earlier.map(candidate => html`<option value="${candidate.id}" ${candidate.id === field.show_if.field ? raw('selected') : ''}>${candidate.label.slice(0, 50)}</option>`)}</select>
            <select data-cond="op" aria-label="Rule">${Object.entries(CONDITION_OPS).map(([op, label]) => html`<option value="${op}" ${op === field.show_if.op ? raw('selected') : ''}>${label}</option>`)}</select>
            ${['answered', 'not_answered'].includes(field.show_if.op) ? '' : source?.type?.endsWith('_choice')
              ? html`<select data-cond="value" aria-label="Value">${source.options.map(option => html`<option value="${option.id}" ${option.id === field.show_if.value ? raw('selected') : ''}>${option.label}</option>`)}</select>`
              : html`<input data-cond="value" aria-label="Value" value="${field.show_if.value || ''}">`}</div>
            <p class="logic-sentence" data-logic-sentence>${logicSentence(field)}</p>
            <p class="hint">Hidden questions are skipped, and any answer to them is discarded when the response is saved. Preview lets you try each path without saving a response.</p>` : ''}
          ${pageBreak ? '' : jumpEditor(field, index)}${pageBreak ? '' : choiceRuleSummary(field)}`, Boolean(field.show_if || rulesFor(draft, field.id).length || choiceRulesFor(draft, field.id).length))}
      </aside>`;
    })}${draft.fields.length ? '' : html`<p class="hint">Add a question to start building your form.</p>`}`);
    paintCanvas();
  };

  const selectMember = index => {
    selectedQuestion = index;
    // The inspector and the tools are drawn off-screen and swapped in; the canvas is only re-marked.
    const holder = document.createElement('div');
    fieldsTarget = holder;
    renderFields();
    fieldsTarget = null;
    const live = $('#fields');
    $('.question-settings', live).replaceWith($('.question-settings', holder));
    $('.canvas-tools', live).replaceWith($('.canvas-tools', holder));
    $$('[data-member]', live).forEach(node => node.classList.toggle('is-selected', Number(node.dataset.member) === index));
  };
  $('#fields').addEventListener('focusin', event => {
    const member = event.target.closest('[data-member]');
    if (member && Number(member.dataset.member) !== selectedQuestion) selectMember(Number(member.dataset.member));
  });
  $('#fields').addEventListener('click', event => {
    const member = event.target.closest('[data-member]');
    if (member && !event.target.closest('button, input, textarea, select, label, a')) $('[data-prop="label"]', member)?.focus();
  });
  const questionList = $('#question-list');
  // Set after a drag so the click a mouse fires on release does not also select. Keyboard activation
  // (event.detail 0) is never swallowed, and the next press clears it if no click followed.
  let suppressClick = false;
  questionList.onclick = event => {
    const swallow = suppressClick && event.detail > 0;
    suppressClick = false;
    if (swallow) return;
    const toggle = event.target.closest('[data-page-toggle]');
    if (toggle) {
      const id = toggle.dataset.pageToggle;
      if (collapsedPages.has(id)) collapsedPages.delete(id); else {
        collapsedPages.add(id);
        // A question hidden by collapsing hands the selection to its page.
        if (draft.fields[selectedQuestion]?.group === id) selectedQuestion = draft.fields.findIndex(field => field.id === id);
      }
      renderFields();
      return $(`[data-page-toggle="${id}"]`)?.focus();
    }
    const button = event.target.closest('[data-question-index]');
    if (!button) return;
    selectedQuestion = Number(button.dataset.questionIndex);
    selectedEnding = null;
    renderFields();
    if (narrowOutline() && outlineOpen()) { showOutline(false); announce(`Selected ${itemName(selectedQuestion)}.`); return $('#outline-toggle').focus(); }
    $(`[data-question-index="${selectedQuestion}"]`)?.focus();
  };
  const narrowOutline = () => matchMedia('(max-width: 900px)').matches;
  const outlineOpen = () => $('.question-sidebar').classList.contains('outline-open');
  const showOutline = open => {
    $('.question-sidebar').classList.toggle('outline-open', open);
    $('#outline-toggle').setAttribute('aria-expanded', String(open));
    if (open) ($('#outline-panel [aria-pressed="true"]') || $('#outline-panel .question-select'))?.scrollIntoView({ block: 'nearest' });
  };
  $('#outline-toggle').onclick = () => {
    showOutline(!outlineOpen());
    if (outlineOpen()) ($('#outline-panel [aria-pressed="true"]') || $('#outline-panel .question-select'))?.focus();
  };
  // Previous/next walk the outline in order (pages, their questions, then endings); focus stays on the arrow.
  const stepOutline = step => {
    const items = outlineItems();
    const target = items[items.findIndex(item => item.getAttribute('aria-pressed') === 'true') + step];
    if (!target) return;
    if (target.dataset.endingIndex != null) selectEnding(Number(target.dataset.endingIndex));
    else { selectedQuestion = Number(target.dataset.questionIndex); selectedEnding = null; renderFields(); }
    announce(`Selected ${selectedEnding !== null ? `ending ${selectedEnding + 1}` : itemName(selectedQuestion)}.`);
    const arrow = $(step < 0 ? '#outline-prev' : '#outline-next');
    (arrow.disabled ? $('#outline-toggle') : arrow).focus();
  };
  $('#outline-prev').onclick = () => stepOutline(-1);
  $('#outline-next').onclick = () => stepOutline(1);
  // Arrow keys, Home and End move through the outline at any width; Escape folds it on narrow screens.
  $('#outline-panel').addEventListener('keydown', event => {
    if (event.key === 'Escape' && narrowOutline() && outlineOpen()) { event.preventDefault(); showOutline(false); return $('#outline-toggle').focus(); }
    if (!event.target.matches('.question-select') || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const items = outlineItems();
    const at = items.indexOf(event.target);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : Math.min(items.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)));
    event.preventDefault();
    items[next]?.focus();
  });

  // Both the ↑/↓ buttons and drag: the moved question stays selected.
  const reportMove = moved => {
    selectedQuestion = moved.to;
    const message = `${moved.left ? 'Moved off the page. ' : ''}${moveMessage(moved.to, draft.fields.length, moved.dropped.length)}`;
    announce(message);
    // A removed rule changes how the form behaves, so it is also shown, not only announced.
    if (moved.dropped.length) toast(message);
  };

  // Drag to reorder, with pointer events so mouse, touch and pen behave alike. A mouse can drag from
  // anywhere on a row; touch and pen use the grip so the list still scrolls. Nothing moves until
  // the drop, and Escape cancels. The ↑/↓ buttons remain the keyboard and assistive-technology route.
  const DRAG_THRESHOLD = 6;
  let drag = null;
  const clearDropMarks = () => $$('.drop-before, .drop-after', questionList).forEach(row => row.classList.remove('drop-before', 'drop-after'));
  const endDrag = () => {
    if (drag?.active) {
      window.removeEventListener('keydown', onDragKey, true);
      if (questionList.hasPointerCapture(drag.pointerId)) questionList.releasePointerCapture(drag.pointerId);
      questionList.classList.remove('is-dragging');
      $$('.dragging', questionList).forEach(row => row.classList.remove('dragging'));
      clearDropMarks();
    }
    drag = null;
  };
  const onDragKey = event => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    endDrag();
    suppressClick = true;
    announce('Move cancelled. The order has not changed.');
  };
  questionList.addEventListener('pointerdown', event => {
    suppressClick = false;
    if (event.button !== 0 || draft.fields.length < 2 || matchMedia('(max-width: 900px)').matches) return;
    const row = event.target.closest('[data-question-row]');
    if (!row || event.target.closest('[data-page-toggle]') || (event.pointerType !== 'mouse' && !event.target.closest('[data-drag-handle]'))) return;
    drag = { from: Number(row.dataset.questionRow), pointerId: event.pointerId, startY: event.clientY, active: false, gap: null };
  });
  questionList.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    if (!event.buttons) return endDrag(); // released outside the list before the drag began
    if (!drag.active) {
      if (Math.abs(event.clientY - drag.startY) < DRAG_THRESHOLD) return;
      drag.active = true;
      questionList.setPointerCapture(drag.pointerId);
      questionList.classList.add('is-dragging');
      $(`[data-question-row="${drag.from}"]`, questionList)?.classList.add('dragging');
      window.addEventListener('keydown', onDragKey, true);
    }
    event.preventDefault();
    const box = questionList.getBoundingClientRect();
    if (event.clientY < box.top + 24) questionList.scrollTop -= 12;
    else if (event.clientY > box.bottom - 24) questionList.scrollTop += 12;
    const rows = $$('[data-question-row]', questionList);
    const slot = dropSlot(rows.map(row => { const rect = row.getBoundingClientRect(); return rect.top + rect.height / 2; }), event.clientY);
    // Rows of a collapsed page are not drawn, so the gap is read from the row itself.
    drag.gap = slot < rows.length ? Number(rows[slot].dataset.questionRow) : draft.fields.length;
    clearDropMarks();
    if (dropIsNoop(draft.fields, drag.from, drag.gap)) return;
    if (slot < rows.length) rows[slot].classList.add('drop-before');
    else rows[rows.length - 1].classList.add('drop-after');
  });
  questionList.addEventListener('pointerup', event => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    const { active, from, gap } = drag;
    endDrag();
    if (!active) return;
    suppressClick = true;
    if (gap === null) return;
    const moved = dropItem(draft.fields, from, gap);
    if (!moved) return;
    reportMove(moved);
    refresh({ fields: true });
    $(`[data-question-index="${moved.to}"]`, questionList)?.focus();
  });
  questionList.addEventListener('pointercancel', endDrag);

  // Plain-language versions of the display rules, kept current as labels and values are typed.
  const logicSentence = field => `${field.type === 'page_break' ? 'This page is shown' : 'Shown'} only ${conditionSentence(field.show_if, draft.fields)}.`;
  const updateSentences = () => {
    $$('#fields [data-logic-sentence]').forEach(node => { node.textContent = logicSentence(draft.fields[Number(node.closest('[data-index]').dataset.index)]); });
    $$('.builder-page [data-jump-sentence]').forEach(node => { const position = Number(node.closest('[data-jump]').dataset.jump); node.textContent = jumpSentence(rulesFor(draft, draft.fields[selectedQuestion].id)[position], draft, position === 0); });
    const selected = draft.fields[selectedQuestion];
    $$('.builder-page [data-cr-sentence]').forEach(node => { const rule = selected && choiceRulesFor(draft, selected.id)[Number(node.closest('[data-choice-rule]').dataset.choiceRule)]; if (rule) node.textContent = choiceRuleSentence(rule, selected, draft.fields); });
    $$('.builder-page [data-cr-conflict]').forEach(node => { const message = selected ? choiceConflict(selected, Number(node.closest('[data-choice-rule]').dataset.choiceRule)) : ''; node.textContent = message; node.hidden = !message; });
  };
  // An edit elsewhere that breaks a hide-choice rule leaves the rule in place and says so, also as a
  // toast: moving a question onto a page, or removing a choice a rule uses. Publishing is refused until fixed.
  const conflictMessages = () => choiceRuleConflicts(draft).map(conflict => conflict.message);
  let knownConflicts = new Set();
  const reportNewConflicts = () => {
    const messages = conflictMessages();
    const fresh = messages.filter(message => !knownConflicts.has(message));
    knownConflicts = new Set(messages);
    if (!fresh.length) return;
    const text = `${fresh[0]}${fresh.length > 1 ? ` ${fresh.length - 1} more rule${fresh.length > 2 ? 's have' : ' has'} a conflict too.` : ''} This form cannot be published until that is fixed in Workflow.`;
    announce(text);
    toast(text);
  };
  const refresh = ({ fields = false, preview = true } = {}) => {
    // A moved or deleted question, option or ending can leave a jump with nowhere valid to go.
    const removed = fields ? pruneLogic(draft) : 0;
    if (removed) { const text = `${removed} jump rule${removed > 1 ? 's were' : ' was'} removed because ${removed > 1 ? 'they' : 'it'} no longer pointed to a later question, option or ending.`; announce(text); toast(text); }
    // Typing changes wording, not structure, so it is never news here; its own row stays current.
    if (fields) reportNewConflicts(); else knownConflicts = new Set(conflictMessages());
    if (fields) renderFields(); else updateSentences();
    fitCanvasText();
    if (fields) renderWorkflow(); else renderWorkflowMap();
    if (preview) renderPreview();
    setState('dirty');
  };

  const renderAll = () => {
    $('#builder-title').textContent = draft.title || 'Untitled form';
    knownConflicts = new Set(conflictMessages());
    renderStatus(); renderShare(); readiness?.check(); renderSettings(); renderAccess(); renderFields();
    renderPreviewParams();
    $('#preview-mode').value = draft.presentation;
    renderPreview();
  };

  $('#access').addEventListener('change', async event => {
    if (event.target.name !== 'form-access') return;
    const access = event.target.value;
    const ok = await ask(access === 'signin'
      ? { title: 'Require sign-in to respond?', body: `From now on, people must sign in with ${form.signin?.issuer_host || 'your identity provider'} before they can see the questions. Anyone using the link without signing in is asked to sign in first. This applies to the live form immediately.`, confirm: 'Require sign-in' }
      : { title: 'Let anyone with the link respond?', body: 'People will no longer need to sign in, and new responses will have no verified email. This applies to the live form immediately.', confirm: 'Allow anyone' });
    if (!ok) return renderAccess();
    try {
      form = await api('PUT', wsPath(`/forms/${form.id}/access`), { access });
      renderAccess(); renderShare();
      $('#access-status').textContent = access === 'signin' ? 'Saved. Respondents now sign in before answering.' : 'Saved. Anyone with the link can respond.';
    } catch (error) { renderAccess(); $('#access-status').textContent = `Not changed. ${error.message}`; }
  });
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
    if (prop === 'placeholder') { if (event.target.value) field.placeholder = event.target.value; else delete field.placeholder; return refresh(); }
    if (prop === 'label' || prop === 'help') {
      field[prop] = event.target.value;
      if (prop === 'label') renderQuestionList();
    }
    else if (prop === 'id') {
      if (event.target.readOnly) return;
      const next = event.target.value.trim();
      if (!/^[a-z0-9_]{1,40}$/.test(next) || draft.fields.some(other => other !== field && other.id === next)) { event.target.setAttribute('aria-invalid', 'true'); return; }
      event.target.removeAttribute('aria-invalid');
      for (const other of draft.fields) if (other.show_if?.field === field.id) other.show_if.field = next;
      renameInLogic(draft, field.id, next);
      renameInChoiceRules(draft, field.id, next);
      field.id = next;
      renderQuestionList();
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
    if (event.target.dataset.type !== undefined) return changeType(index, event.target);
    if (prop === 'required') {
      field.required = event.target.checked;
      refresh({ fields: true });
      return $(`#fields .question-settings [data-prop="required"]`)?.focus();
    }
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
      const step = Number(button.dataset.move);
      const moved = moveItem(draft.fields, index, step);
      reportMove(moved);
      // Keep focus on the same control of the moved item, falling back to the other direction at an end.
      refresh({ fields: true });
      return ($(`.canvas-tools [data-move="${step}"]:not([disabled])`) || $(`.canvas-tools [data-move="${-step}"]`))?.focus();
    } else if (button.dataset.duplicate !== undefined && field.grouped) {
      const made = [...draft.fields];
      const at = duplicateBlock(draft.fields, index, prefix => { const key = randomKey(prefix, made); made.push({ id: key }); return key; });
      selectedQuestion = at;
      focus = `[data-index="${at}"] [data-prop="label"]`;
      announce('Page duplicated with all its questions. Save the draft to keep this change.');
    } else if (button.dataset.duplicate !== undefined) {
      // A copy gets new question and option keys, so its answers never mix with the original's.
      const copy = structuredClone(field);
      copy.id = randomKey('q', draft.fields);
      copy.label = `${field.label} (copy)`;
      if (copy.options) { const taken = []; copy.options = copy.options.map(option => { const fresh = { ...option, id: randomKey('opt', taken) }; taken.push(fresh); return fresh; }); }
      draft.fields.splice(index + 1, 0, copy);
      selectedQuestion = index + 1;
      focus = `[data-index="${index + 1}"] [data-prop="label"]`;
      announce(`Question duplicated as question ${index + 2}. Save the draft to keep this change.`);
    } else if (button.dataset.remove !== undefined && field.grouped) {
      const count = blockEnd(draft.fields, index) - index - 1;
      ask({ title: `Remove the page “${field.label || 'Untitled page'}”?`, body: `This removes the page and its ${count} question${count === 1 ? '' : 's'} from this draft. Earlier versions, their responses and exports keep them.`, confirm: 'Remove page', danger: true }).then(confirmed => {
        if (!confirmed) return $('.canvas-tools [data-remove]')?.focus();
        const removed = draft.fields.splice(index, count + 1).map(item => item.id);
        const dependent = draft.fields.filter(item => removed.includes(item.show_if?.field));
        dependent.forEach(item => delete item.show_if);
        dropChoiceRulesFor(draft, removed);
        selectedQuestion = Math.min(index, draft.fields.length - 1);
        announce(`Page removed.${dependent.length ? ` ${dependent.length} display rule${dependent.length > 1 ? 's that depended on it were' : ' that depended on it was'} removed too.` : ''} Save the draft to keep this change.`);
        refresh({ fields: true });
        ($('.canvas-tools [data-remove]') || $('#add-field'))?.focus();
      });
      return;
    } else if (button.dataset.remove !== undefined) {
      draft.fields.splice(index, 1);
      const dependent = draft.fields.filter(item => item.show_if?.field === field.id);
      dependent.forEach(item => delete item.show_if);
      dropChoiceRulesFor(draft, [field.id]);
      selectedQuestion = Math.min(index, draft.fields.length - 1);
      focus = draft.fields.length ? '.canvas-tools [data-remove]' : '#add-field';
      announce(`Item removed.${dependent.length ? ` ${dependent.length} display rule${dependent.length > 1 ? 's that depended on it were' : ' that depended on it was'} removed too.` : ''} Save the draft to keep this change.`);
    } else if (button.dataset.addOption !== undefined) {
      field.options.push({ id: randomKey('opt', field.options), label: 'Option ' + (field.options.length + 1) });
      focus = `[data-index="${index}"] [data-option="${field.options.length - 1}"]`;
    } else if (button.dataset.removeOption !== undefined) {
      field.options.splice(Number(button.dataset.removeOption), 1);
      focus = `[data-index="${index}"] [data-add-option]`;
    } else if (button.dataset.openWorkflow !== undefined) {
      showSurface('workflow');
      return $('#workflow-editor-heading')?.focus();
    } else return;
    refresh({ fields: true });
    if (focus) $(focus)?.focus();
  });
  // Type changes follow forms-type-change.mjs: safe ones apply at once, changed settings or rule
  // meanings are confirmed first, incompatible rules block, and a published key is replaced rather
  // than retyped. The select shows the current type again until a change is actually applied.
  const changeType = async (index, select) => {
    const field = draft.fields[index];
    const to = select.value;
    select.value = field.type;
    const note = $(`[data-index="${index}"] [data-type-note]`);
    mount(note, '');
    const made = [];
    const newKey = prefix => { const key = randomKey(prefix, [...draft.fields, ...(field.options || []), ...made]); made.push({ id: key }); return key; };
    const plan = planTypeChange({ field, to, fields: draft.fields, routing: form.routing, choiceRules: draft.choice_rules, locked: new Set(form.locked_ids || []), newKey });
    const label = `“${field.label || 'Untitled question'}”`;
    const type = FIELD_TYPES[to].toLowerCase();
    const list = items => html`<ul>${items.map(item => html`<li>${item}</li>`)}</ul>`;
    const apply = (next, message) => {
      if (field.group != null) next.group = field.group;
      draft.fields[index] = next;
      if (next.id !== field.id) renameInChoiceRules(draft, field.id, next.id);
      refresh({ fields: true });
      $(`[data-index="${index}"] [data-type]`)?.focus();
      announce(`${message} Save the draft to keep this change.`);
    };
    if (plan.kind === 'none') return;
    if (plan.kind === 'apply') return apply(plan.next, `${label} is now ${type}.${plan.effects.length ? ' ' + plan.effects.join(' ') : ''}`);
    if (plan.kind === 'blocked' || !plan.canReplace && plan.kind === 'replace') {
      return mount(note, notice('warn', html`<p><strong>Type not changed.</strong> ${plan.reason}${plan.kind === 'replace' ? ' These rules depend on it, so change or remove them first:' : ''}</p>${list(plan.rules)}`));
    }
    if (plan.kind === 'confirm') {
      if (!(await ask({ title: `Change ${label} to ${type}?`, body: 'Nothing is saved until you select Save draft, and the live form changes only when you publish.', fields: list(plan.effects), confirm: 'Change type' }))) return announce('Type not changed.');
      return apply(plan.next, `${label} is now ${type}.`);
    }
    const effects = ['The new question keeps the wording, help text, required setting and display rule, with a new question key.', 'The old question is removed from this draft only. Earlier versions, their responses and exports keep it with its answers.', 'Nothing is saved until you select Save draft; the live form changes only when you publish.'];
    if (!(await ask({ title: `Replace ${label} with a new ${type} question?`, body: plan.reason, fields: list(effects), confirm: 'Replace question' }))) return announce('Question not replaced.');
    apply(replacementQuestion(field, to, newKey), `${label} was replaced by a new ${type} question.`);
  };
  // Jump rules. Each change redraws the pane, then returns focus to the control that made it.
  const jumpRulesOf = element => {
    const row = element.closest('[data-jump]');
    const field = draft.fields[Number(element.closest('[data-index]').dataset.index)];
    return { field, rules: rulesFor(draft, field.id), position: row ? Number(row.dataset.jump) : null };
  };
  const jumpRoot = () => workflowActive() ? $('#workflow-editor') : fieldsRoot;
  const jumpFocus = selector => { refresh({ fields: true }); $(selector, jumpRoot())?.focus(); };
  const jumpHost = $('.builder-page');
  jumpHost.addEventListener('change', event => {
    const { jumpField, jumpOp, jumpValue, jumpTo } = event.target.dataset;
    if (![jumpField, jumpOp, jumpValue, jumpTo].some(value => value !== undefined) || !event.target.closest('[data-jump]')) return;
    const { position, rules } = jumpRulesOf(event.target);
    const rule = rules[position];
    const row = `[data-jump="${position}"]`;
    if (jumpTo !== undefined) { rule.to = parseTarget(event.target.value); return jumpFocus(`${row} [data-jump-to]`); }
    if (jumpField !== undefined) {
      const param = parseParamSource(event.target.value);
      if (param != null) rule.when = paramCondition(param);
      else if (event.target.value) rule.when = defaultCondition(draft.fields.find(candidate => candidate.id === event.target.value)); else delete rule.when;
      return jumpFocus(`${row} [data-jump-field]`);
    }
    if (jumpOp !== undefined) {
      rule.when.op = event.target.value;
      const asked = draft.fields.find(candidate => candidate.id === rule.when.field);
      if (['answered', 'not_answered'].includes(rule.when.op)) delete rule.when.value;
      else if (asked?.type.endsWith('_choice')) rule.when.value ??= asked.options[0].id;
      else rule.when.value ??= '';
      return jumpFocus(`${row} [data-jump-op]`);
    }
    if (event.target.tagName === 'SELECT') { rule.when.value = event.target.value; jumpFocus(`${row} [data-jump-value]`); }
  });
  jumpHost.addEventListener('input', event => {
    if (event.target.dataset.jumpValue === undefined || event.target.tagName !== 'INPUT') return;
    const { position, rules } = jumpRulesOf(event.target);
    rules[position].when.value = event.target.value;
    refresh();
  });
  jumpHost.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button || !button.closest('.jump-editor')) return;
    const { field, rules, position } = jumpRulesOf(button);
    const index = draft.fields.indexOf(field);
    if (button.dataset.jumpAdd !== undefined) {
      const first = jumpTargets(draft, index)[0].items[0];
      setRules(draft, field.id, [...rules, { when: defaultCondition(field), to: parseTarget(first.value) }]);
      announce(`Jump ${rules.length + 1} added. Save the draft to keep this change.`);
      return jumpFocus(`[data-jump="${rules.length}"] [data-jump-field]`);
    }
    if (button.dataset.jumpRemove !== undefined) {
      setRules(draft, field.id, rules.filter((rule, ruleIndex) => ruleIndex !== position));
      announce(`Jump ${position + 1} removed. Save the draft to keep this change.`);
      const left = rulesFor(draft, field.id).length;
      return jumpFocus(left ? `[data-jump="${Math.min(position, left - 1)}"] [data-jump-remove]` : '[data-jump-add]');
    }
    if (button.dataset.jumpMove) {
      const step = Number(button.dataset.jumpMove);
      [rules[position], rules[position + step]] = [rules[position + step], rules[position]];
      announce(`Jump moved to position ${position + step + 1} of ${rules.length}.`);
      refresh({ fields: true });
      const row = `[data-jump="${position + step}"]`;
      ($(`${row} [data-jump-move="${step}"]:not([disabled])`, jumpRoot()) || $(`${row} [data-jump-remove]`, jumpRoot()))?.focus();
    }
  });

  // Hide-choice rules, edited in Workflow. The change just made is not news, so only its row says what
  // is wrong; each change redraws the pane, then returns focus to the control that made it.
  const choiceRoot = $('#workflow-editor');
  const choiceRefresh = () => { knownConflicts = new Set(conflictMessages()); refresh({ fields: true }); };
  const choiceFocus = selector => { choiceRefresh(); $(selector, choiceRoot)?.focus(); };
  const choiceRowOf = element => {
    const field = draft.fields[selectedQuestion];
    const rules = choiceRulesFor(draft, field.id);
    const position = Number(element.closest('[data-choice-rule]')?.dataset.choiceRule);
    return { field, rules, position, rule: rules[position], row: `[data-choice-rule="${position}"]` };
  };
  choiceRoot.addEventListener('change', event => {
    const { crField, crOp, crValue, crHide } = event.target.dataset;
    if (![crField, crOp, crValue, crHide].some(value => value !== undefined)) return;
    const { rule, row } = choiceRowOf(event.target);
    if (crField !== undefined) {
      const param = parseParamSource(event.target.value);
      const source = draft.fields.find(candidate => candidate.id === event.target.value);
      if (param == null && !source) return;
      rule.when = param != null ? paramCondition(param) : defaultCondition(source);
      return choiceFocus(`${row} [data-cr-field]`);
    }
    if (crOp !== undefined) {
      rule.when.op = event.target.value;
      const asked = draft.fields.find(candidate => candidate.id === rule.when.field);
      if (['answered', 'not_answered'].includes(rule.when.op)) delete rule.when.value;
      else if (asked?.type.endsWith('_choice')) rule.when.value ??= asked.options[0].id;
      else rule.when.value ??= '';
      return choiceFocus(`${row} [data-cr-op]`);
    }
    if (crHide !== undefined) {
      rule.hide = event.target.checked ? [...rule.hide, crHide] : rule.hide.filter(id => id !== crHide);
      const present = draft.fields[selectedQuestion].options?.some(option => option.id === crHide);
      return choiceFocus(present ? `${row} [data-cr-hide="${CSS.escape(crHide)}"]` : `${row} [data-cr-remove]`);
    }
    if (event.target.tagName === 'SELECT' && event.target.value) { rule.when.value = event.target.value; choiceFocus(`${row} [data-cr-value]`); }
  });
  choiceRoot.addEventListener('input', event => {
    if (event.target.dataset.crValue === undefined || event.target.tagName !== 'INPUT') return;
    choiceRowOf(event.target).rule.when.value = event.target.value;
    refresh();
  });
  choiceRoot.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button?.closest('.choice-rule-editor')) return;
    const { field, rules, position } = choiceRowOf(button);
    if (button.dataset.crAdd !== undefined) {
      setChoiceRules(draft, field.id, [...rules, newChoiceRule(draft, selectedQuestion)]);
      announce(`Hide rule ${rules.length + 1} added. Save the draft to keep this change.`);
      return choiceFocus(`[data-choice-rule="${rules.length}"] [data-cr-field]`);
    }
    if (button.dataset.crRemove !== undefined) {
      setChoiceRules(draft, field.id, rules.filter((rule, index) => index !== position));
      announce(`Hide rule ${position + 1} removed. Save the draft to keep this change.`);
      const left = choiceRulesFor(draft, field.id).length;
      choiceRefresh();
      return ($(left ? `[data-choice-rule="${Math.min(position, left - 1)}"] [data-cr-remove]` : '[data-cr-add]', choiceRoot) || $('#workflow-editor-heading'))?.focus();
    }
  });
  $('#workflow-summary').addEventListener('click', event => {
    if (!event.target.closest('[data-cr-orphans]')) return;
    const removed = dropOrphanChoiceRules(draft);
    announce(`${removed} hide-choice rule${removed === 1 ? '' : 's'} removed. Save the draft to keep this change.`);
    refresh({ fields: true });
    $('#workflow-heading').focus();
  });

  // URL parameters: declared in Workflow, tried with sample values in Preview. A parameter a rule reads
  // cannot be removed until that rule changes, so no jump or rule disappears as a side effect.
  const urlParamsRoot = $('#url-params');
  const urlParamsChanged = (focus, message = '') => { renderPreviewParams(); refresh({ fields: true }); if (message) renderUrlParams(message); $(focus, urlParamsRoot)?.focus(); };
  const addParamFromInput = () => {
    const input = $('#url-param-key', urlParamsRoot);
    const key = input.value.trim();
    const problem = urlParamKeyProblem(key, declaredParams(draft).map(param => param.key)) || (declaredParams(draft).length >= URL_PARAM_LIMITS.count ? `A form can declare up to ${URL_PARAM_LIMITS.count} URL parameters.` : null);
    if (problem) { mount($('#url-param-message', urlParamsRoot), notice('warn', html`<p>${problem}</p>`)); input.setAttribute('aria-invalid', 'true'); return input.focus(); }
    addUrlParam(draft, key);
    announce(`URL parameter ${key} added. Save the draft to keep this change.`);
    urlParamsChanged('#url-param-key');
  };
  urlParamsRoot.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.id === 'url-param-key') { event.preventDefault(); addParamFromInput(); } });
  urlParamsRoot.addEventListener('change', event => {
    const key = event.target.dataset.urlRecord;
    if (key === undefined) return;
    setUrlParamRecorded(draft, key, event.target.checked);
    announce(`${key} will ${event.target.checked ? '' : 'not '}be recorded with each response once you publish. Save the draft to keep this change.`);
    urlParamsChanged(`[data-url-record="${CSS.escape(key)}"]`);
  });
  urlParamsRoot.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    if (button.dataset.urlAdd !== undefined) return addParamFromInput();
    if (button.dataset.urlRemove !== undefined) {
      const key = button.dataset.urlRemove;
      const uses = urlParamUses(draft, key);
      if (uses.length) return mount($('#url-param-message', urlParamsRoot), notice('warn', html`<p><strong>${key} is still in use.</strong> Change or remove these rules first:</p><ul>${uses.map(use => html`<li>${use}</li>`)}</ul>`));
      removeUrlParam(draft, key);
      announce(`URL parameter ${key} removed. Save the draft to keep this change.`);
      return urlParamsChanged('#url-param-key');
    }
    if (button.dataset.urlCopy !== undefined) {
      const field = $('#url-param-link', urlParamsRoot);
      try { await navigator.clipboard.writeText(field.value); $('#url-param-copied', urlParamsRoot).textContent = 'Example link copied. Nothing has been sent.'; }
      catch { field.focus(); field.select(); $('#url-param-copied', urlParamsRoot).textContent = 'Copy failed. The link is selected: press Ctrl+C (⌘C on a Mac) to copy it.'; }
    }
  });
  $('#preview-params').addEventListener('input', event => {
    const key = event.target.dataset.previewParam;
    if (key === undefined) return;
    if (event.target.value) previewSamples.set(key, event.target.value); else previewSamples.delete(key);
    renderPreview();
  });

  // Endings: the first is the default, and a jump can choose any of them.
  const selectEnding = position => {
    selectedEnding = position;
    renderFields();
    $(`[data-ending-index="${position}"]`)?.focus();
  };
  $('#ending-list').onclick = event => {
    const button = event.target.closest('[data-ending-index]');
    if (!button) return;
    selectEnding(Number(button.dataset.endingIndex));
    if (narrowOutline() && outlineOpen()) { showOutline(false); $('#outline-toggle').focus(); }
  };
  $('#add-ending').onclick = () => {
    draft.endings = [...(draft.endings || []), { id: randomKey('end', draft.endings || []), title: 'Thanks for responding' }];
    selectedEnding = draft.endings.length - 1;
    announce(`Ending ${draft.endings.length} added. Save the draft to keep this change.`);
    refresh({ fields: true });
    const title = $('#fields [data-ending-prop="title"]');
    title?.focus();
    title?.select();
  };
  fieldsRoot.addEventListener('input', event => {
    const prop = event.target.dataset.endingProp;
    if (!prop) return;
    const ending = draft.endings[selectedEnding];
    if (prop === 'message' && !event.target.value) delete ending.message; else ending[prop] = event.target.value;
    if (prop === 'title') renderQuestionList();
    refresh();
  });
  fieldsRoot.addEventListener('click', event => {
    const button = event.target.closest('button');
    if (!button?.closest('[data-ending]')) return;
    if (button.dataset.endingDefault !== undefined) {
      const [ending] = draft.endings.splice(selectedEnding, 1);
      draft.endings.unshift(ending);
      selectedEnding = 0;
      announce('This is now the default ending. Save the draft to keep this change.');
      refresh({ fields: true });
      $('[data-ending-index="0"]')?.focus();
    } else if (button.dataset.endingRemove !== undefined) {
      draft.endings.splice(selectedEnding, 1);
      if (!draft.endings.length) delete draft.endings;
      const left = draft.endings?.length || 0;
      selectedEnding = left ? Math.min(selectedEnding, left - 1) : null;
      announce('Ending removed. Save the draft to keep this change.');
      refresh({ fields: true });
      (left ? $(`[data-ending-index="${selectedEnding}"]`) : $('#add-ending'))?.focus();
    }
  });

  // Add content: a picker that adds below the selected question, then puts the cursor in the new one.
  const addButton = $('#add-field');
  const addMenu = $('#add-menu');
  const showAddMenu = open => {
    addMenu.hidden = !open;
    addButton.setAttribute('aria-expanded', String(open));
    if (open) $('[data-add-type]', addMenu).focus();
  };
  addButton.onclick = () => showAddMenu(addMenu.hidden);
  addMenu.addEventListener('keydown', event => {
    const items = $$('[data-add-type]', addMenu);
    const at = items.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); showAddMenu(false); addButton.focus(); }
    else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); items[(at + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus(); }
  });
  addMenu.addEventListener('focusout', event => { if (!addMenu.hidden && event.relatedTarget && event.relatedTarget !== addButton && !addMenu.contains(event.relatedTarget)) showAddMenu(false); });
  addMenu.onclick = event => {
    const type = event.target.closest('[data-add-type]')?.dataset.addType;
    if (!type) return;
    const current = draft.fields[selectedQuestion];
    const afterCurrent = draft.fields.length ? blockEnd(draft.fields, selectedQuestion) : 0;
    if (type === 'contact_info' || type === 'question_page') {
      // Pages sit beside other pages: after the selected page, even when one of its questions is selected.
      const owner = current?.group != null ? draft.fields.findIndex(candidate => candidate.id === current.group) : selectedQuestion;
      const position = draft.fields.length ? blockEnd(draft.fields, owner) : 0;
      const id = randomKey('page', draft.fields);
      const block = type === 'contact_info' ? contactInfoBlock([...draft.fields.map(item => item.id), ...(form.locked_ids || [])])
        : [{ id, type: 'page_break', label: 'New page', grouped: true }, { id: randomKey('q', draft.fields), type: 'short_text', label: 'New question', required: false, group: id }];
      draft.fields.splice(position, 0, ...block);
      selectedQuestion = position;
      selectedEnding = null;
      showAddMenu(false);
      announce(`${CONTENT_LABELS[type]} page added with ${block.length - 1} question${block.length === 2 ? '' : 's'}. Save the draft to keep this change.`);
      refresh({ fields: true });
      const title = $(`#fields [data-index="${position}"] [data-prop="label"]`);
      title?.focus();
      title?.select();
      return;
    }
    const field = { id: randomKey(type === 'page_break' ? 'page' : 'q', draft.fields), type, label: type === 'page_break' ? '' : 'New question', required: false };
    if (type === 'page_break') delete field.required;
    if (type.endsWith('_choice')) field.options = [{ id: randomKey('opt', []), label: 'Option 1' }, { id: randomKey('opt', []), label: 'Option 2' }];
    // A question added while a page or one of its questions is selected joins that page.
    // A page break never splits a page, so it lands after the whole page.
    const owner = isHead(current) ? current.id : current?.group ?? null;
    let position = draft.fields.length ? selectedQuestion + 1 : 0;
    if (type === 'page_break') position = current?.group != null ? blockEnd(draft.fields, draft.fields.findIndex(candidate => candidate.id === current.group)) : afterCurrent;
    else if (owner !== null) field.group = owner;
    draft.fields.splice(position, 0, field);
    selectedQuestion = draft.fields.indexOf(field);
    selectedEnding = null;
    showAddMenu(false);
    announce(`${FIELD_TYPES[type]} added at position ${selectedQuestion + 1}. Save the draft to keep this change.`);
    refresh({ fields: true });
    const label = $(`#fields [data-index="${selectedQuestion}"] [data-prop="label"]`);
    if (label) { label.focus(); label.select(); } else $(`[data-question-index="${selectedQuestion}"]`)?.focus();
  };

  // Device size: shapes the canvas and the preview alike.
  const showDevice = device => {
    $('.builder').dataset.device = device;
    $$('[data-device]', $('.preview-devices')).forEach(button => button.setAttribute('aria-pressed', String(button.dataset.device === device)));
  };
  $('.preview-devices').addEventListener('click', event => {
    const device = event.target.closest('button')?.dataset.device;
    if (device) showDevice(device);
  });
  showDevice('desktop');
  // Enter finishes editing a title rather than breaking it across lines; the respondent sees one line of wording.
  // Titles stay on one line; descriptions keep the line breaks the author types.
  fieldsRoot.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.matches('.canvas-question, .canvas-member-label')) event.preventDefault(); });
  fieldsRoot.addEventListener('click', event => {
    const section = event.target.closest('[data-inspector]');
    if (!section) return;
    // Working inside a section keeps it open; its heading toggles it.
    const heading = event.target.closest('summary')?.parentElement === section;
    sectionChoice.set(section.dataset.inspector, heading ? !section.open : true);
    if (!heading) section.open = true;
  }, true);
  // Design: reusable themes and presets. A change shows at once and belongs to this draft alone.
  let themeBaseline = saveState;
  const design = designPanel({
    root: $('#design-panel'), opener: $('#open-design'), announce, getTheme: () => draft.theme,
    setTheme: (theme, restoring = false) => {
      if (saveState === 'saved' && !restoring) themeBaseline = 'saved';
      if (theme) draft.theme = theme; else delete draft.theme;
      paintCanvas();
      renderPreview();
      setState(restoring && themeBaseline === 'saved' && JSON.stringify(draft) === JSON.stringify(form.draft) ? 'saved' : 'dirty');
    }
  });
  $('#open-design').onclick = () => design.toggle();
  document.addEventListener('pointerdown', event => { const menu = $('.overflow-menu'); if (menu?.open && !menu.contains(event.target)) menu.open = false; });
  // The header's one Preview control switches between editing and the respondent's view.
  const selectView = next => {
    view = next;
    $('.builder').dataset.view = view;
    const toggle = $('#topbar-preview');
    const previewing = view === 'preview';
    toggle.dataset.builderView = previewing ? 'edit' : 'preview';
    toggle.title = previewing ? 'Back to editing the questions' : 'See the form as respondents do. Nothing is saved or sent.';
    mount(toggle, html`${formIcon(previewing ? 'edit' : 'play')}<span>${previewing ? 'Back to editing' : 'Preview'}</span>`);
  };

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
    $('#conflict-load').onclick = () => { form = current; draft = structuredClone(form.draft); design.refresh(); $('#builder-notice').innerHTML = ''; setState('saved'); renderAll(); renderWorkflow(); renderRouting(); announce('Loaded the latest saved version.'); };
    $('#conflict-keep').onclick = async () => { if (await save({ force: current.revision })) { toast('Your version was saved.'); renderRouting(); } };
  };

  $('#save').onclick = async () => { if (await save()) toast(form.published_version ? 'Draft saved. The live form is unchanged until you publish.' : 'Draft saved.'); };
  $('#publish').onclick = async () => {
    if (saveState !== 'saved' && !(await save())) return;
    if (form.published_version && !form.has_unpublished_changes && !form.legacy_text_comparison) { mount($('#builder-notice'), notice('info', html`<p>Version ${form.published_version} is already live with these questions and routing.</p>`)); return $('#builder-notice').focus(); }
    if (form.published_version && !(await ask({ title: `Publish version ${form.published_version + 1}?`, body: 'New visitors see the updated questions and routing right away. Responses already received stay linked to the version they answered. People who opened the current version can still submit it for 24 hours.', confirm: 'Publish' }))) return;
    try {
      form = await api('POST', wsPath(`/forms/${form.id}/publish`), { base_revision: form.revision });
      renderStatus(); renderShare(); readiness.check(); renderFields(); renderPreviewParams();
      mount($('#builder-notice'), notice('ok', html`<p>Version ${form.published_version} is live. New responses use this version. Share the respondent link below.</p>`));
      showSurface('share');
      $('#share-panel').scrollIntoView({ block: 'nearest' });
      $('#share-heading').focus({ preventScroll: true });
    } catch (error) {
      if (error.code === 'draft_conflict') { setState('conflict'); return showConflict(error.details.current); }
      reportError(error, 'Not published. ');
    }
  };
  // Copy reports what actually happened; when the clipboard is unavailable the text is selected instead.
  // The embed layout only changes the code shown; nothing is saved.
  $('#share-panel').addEventListener('change', event => {
    if (event.target.id !== 'embed-mode') return;
    const code = $('#embed');
    code.value = code.value.replace(/\?embed=1(&mode=\w+)?/, `?embed=1${event.target.value ? '&mode=' + event.target.value : ''}`);
  });
  $('#share-panel').addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    const status = $('#share-status');
    if (button.dataset.copyTarget) {
      const field = $('#' + button.dataset.copyTarget);
      const what = { 'share-link': 'Respondent link', 'share-conv': 'Conversational link', embed: 'Embed code' }[field.id];
      try { await navigator.clipboard.writeText(field.value); status.textContent = `${what} copied. Paste it wherever you share it; nothing has been sent.`; }
      catch { field.focus(); field.select(); status.textContent = `Copy failed. The ${what.toLowerCase()} is selected: press Ctrl+C (⌘C on a Mac) to copy it.`; }
    } else if (button.id === 'share-native') {
      try { await navigator.share({ title: form.draft.title, url: publicUrl(form) }); status.textContent = 'Passed to your device’s share menu. Schedora cannot see whether it was sent.'; }
      catch (error) { status.textContent = error.name === 'AbortError' ? 'Sharing cancelled. Nothing was sent.' : 'Your device could not open its share menu. Copy the link instead.'; }
    } else if (button.dataset.buildPrefill !== undefined) {
      // Links are built against what respondents get: the live version, not the draft.
      let live;
      try { live = await api('GET', `/api/public/forms/${form.slug}`); }
      catch (error) { status.textContent = `The live form could not be loaded, so no link was built. ${error.message}`; return; }
      const copy = async (field, what) => {
        try { await navigator.clipboard.writeText(field.value); return `${what} copied. Nothing has been sent.`; }
        catch { if (field.select) { field.focus(); field.select(); } return `Copy failed. ${field.select ? 'The text is selected: press Ctrl+C (⌘C on a Mac).' : `Copy it by hand: ${field.value}`}`; }
      };
      openPrefillBuilder({ live: live.definition, version: live.version, draftDiffers: form.has_unpublished_changes, baseUrl: publicUrl(form), renderForm, copy });
    } else if (button.dataset.sharePublish !== undefined) $('#publish').click();
    else if (button.dataset.sharePreview !== undefined) goTo('preview-' + draft.presentation);
    else if (button.id === 'unpublish') {
      if (!(await ask({ title: 'Stop collecting responses?', body: 'The public link will say the form is closed. Existing responses are kept. You can publish again later.', confirm: 'Stop collecting', danger: true }))) return;
      try { form = await api('POST', wsPath(`/forms/${form.id}/unpublish`)); renderStatus(); renderShare(); readiness.check(); toast('The form is closed to new responses.'); $('#share-heading').focus(); }
      catch (error) { reportError(error); }
    }
  });
  // "Ready to share?": the saved form and the live public form, assessed with the shared validator.
  // Re-checked after every save, publish, unpublish and routing save. It never publishes.
  function goTo(section) {
    if (section === 'publish') return $('#publish').focus();
    if (section === 'workflow') { showSurface('workflow'); return $('#workflow-heading').focus(); }
    if (section === 'share') { showSurface('share'); $('#share-panel').scrollIntoView({ block: 'start' }); return $('#share-heading').focus({ preventScroll: true }); }
    if (section === 'routing') { showSurface('settings'); const routing = $('#routing details'); if (routing) { routing.open = true; routing.scrollIntoView({ block: 'start' }); routing.querySelector('summary').focus({ preventScroll: true }); } return; }
    if (section === 'details' || section === 'settings') { showSurface('settings'); return $('#settings-heading').focus(); }
    showSurface('content');
    if (section.startsWith('preview-')) {
      $('#preview-mode').value = section.slice(8);
      renderPreview();
      selectView('preview');
      $('#builder-preview').scrollIntoView({ block: 'start' });
      return $('#preview-heading').focus({ preventScroll: true });
    }
    selectView('edit');
    $('#fields').scrollIntoView({ block: 'start' });
    ($('#fields [data-prop="label"]') || $('#add-field')).focus({ preventScroll: true });
  }
  readiness = formReadiness(ctx, () => form, { goTo });
  // Top navigation: shows a surface and moves focus to its heading, without changing the address, so
  // the router never re-renders the builder and unsaved edits stay on the page.
  const sections = { workflow: ['workflow', '#workflow-heading'], share: ['share', '#share-heading'], settings: ['settings', '#settings-heading'], questions: ['content', '#questions-heading'] };
  $('#builder-index').addEventListener('click', event => {
    const link = event.target.closest('[data-section]');
    if (!link) return;
    event.preventDefault();
    const [surface, heading] = sections[link.dataset.section];
    showSurface(surface);
    if (surface === 'content') selectView('edit');
    // On narrow screens the outline is folded into its bar, which names the selected question.
    (surface === 'content' && narrowOutline() && !outlineOpen() ? $('#outline-toggle') : $(heading))?.focus();
  });
  renderAll();
  renderRouting();
  // The server refuses these anyway; this says so before anyone spends time on an edit.
  const showFreeze = () => {
    if (!boot.formsAuthoringFrozen) return;
    for (const id of ['#save', '#publish']) { $(id).disabled = true; $(id).setAttribute('aria-disabled', 'true'); }
    mount($('#builder-notice'), notice('warn', html`<p data-authoring-frozen><strong>Editing forms is paused while a release is in progress.</strong> Your form is safe and live forms keep working, but changes here cannot be saved or published right now.</p>`));
  };
  showFreeze();
  // Arriving from the starting-point picker or guided setup: say plainly what exists and what does
  // not yet, and how to get back to setup.
  const created = ctx.query.get('created');
  const fromSetup = ctx.query.get('from') === 'setup';
  const backToSetup = fromSetup ? html` <a href="/setup/forms" data-back-setup>Back to setup</a>` : '';
  if (created && !form.published_version) {
    const source = createdSource(created);
    mount($('#builder-notice'), notice('info', html`<p><strong>Draft created${source ? ' ' + source : ''} in ${workspace().name}.</strong> It is saved but not published, so nobody can open it yet. Review the questions, check the preview, then publish.${backToSetup}</p>`));
  } else if (fromSetup && !boot.formsAuthoringFrozen) {
    mount($('#builder-notice'), notice('info', html`<p>Opened from guided setup. Changes here are saved to the same draft.${backToSetup}</p>`));
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
    const actionText = action => action?.type === 'event' ? `offer the booking page “${eventTypes.find(type => type.id === action.event_type_id)?.title || 'not chosen'}” (nothing is booked until they pick a time)`
      : action?.type === 'url' ? `show a Continue link to ${action.url || '(no link yet)'}` : `show the message “${action?.message || '(empty)'}”`;
    const ruleSentence = index => `Rule ${index + 1}: ${conditionSentence(rules[index].condition, questions())}, ${actionText(rules[index].action)}.${index ? ' Checked only if no earlier rule matched.' : ''}`;
    const fallbackSentence = () => `If no rule matches: ${fallback ? actionText(fallback) : 'show the receipt only'}.`;
    const sentences = () => { $$('#routing [data-rule-sentence]').forEach(node => { node.textContent = ruleSentence(Number(node.dataset.ruleSentence)); }); const last = $('#routing [data-fallback-sentence]'); if (last) last.textContent = fallbackSentence(); };
    const draw = () => mount($('#routing'), html`<details class="card card-plain" ${form.routing ? raw('open') : ''}><summary><strong>Next step after submitting</strong> <span class="muted">(optional)</span></summary>
      <p class="hint">Rules are checked in order and the first match decides. The response is always saved first; a booking page is offered as a next step, and booking is optional for the respondent.${meetActive ? '' : ' Booking pages need an active Meet or Suite plan.'}</p>
      <ol class="rule-list">${rules.map((rule, index) => html`<li class="range"><span>If</span> <select data-rfield="${index}" aria-label="Rule ${index + 1}: question">${questions().map(field => html`<option value="${field.id}" ${field.id === rule.condition.field ? raw('selected') : ''}>${field.label.slice(0, 40)}</option>`)}</select>
        <select data-rop="${index}" aria-label="Rule ${index + 1}: condition">${Object.entries(CONDITION_OPS).map(([op, label]) => html`<option value="${op}" ${rule.condition.op === op ? raw('selected') : ''}>${label}</option>`)}</select>
        ${valueEditor(rule, index)} <span>then</span> ${actionEditor(rule.action, index)}
        <span class="row"><button class="btn btn-small" type="button" data-rmove="${index}:-1" aria-label="Move rule ${index + 1} up" ${index === 0 ? raw('disabled') : ''}>↑</button><button class="btn btn-small" type="button" data-rmove="${index}:1" aria-label="Move rule ${index + 1} down" ${index === rules.length - 1 ? raw('disabled') : ''}>↓</button><button class="btn btn-small" type="button" data-rremove="${index}" aria-label="Remove rule ${index + 1}">Remove</button></span>
        <p class="logic-sentence" data-rule-sentence="${index}">${ruleSentence(index)}</p></li>`)}</ol>
      <div class="range"><span>If no rule matches:</span> ${fallback ? actionEditor(fallback, 'fallback') : html`<span class="muted">show the receipt only</span>`} <button class="btn-link" type="button" id="toggle-fallback">${fallback ? 'Remove' : 'Set a next step'}</button></div>
      ${rules.length ? html`<p class="logic-sentence" data-fallback-sentence>${fallbackSentence()}</p>` : ''}
      ${rules.length ? html`<p class="hint">First match wins: each respondent gets the step of the first rule their answers match, and later rules are not checked. Answers to questions that were hidden from them count as unanswered. Test a path in Preview; it stores nothing and does not show the step.</p>` : ''}
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
      sentences();
    };
    root.oninput = event => {
      const { rvalue, avalue } = event.target.dataset;
      if (rvalue !== undefined && event.target.tagName === 'INPUT') rules[Number(rvalue)].condition.value = event.target.value;
      if (avalue !== undefined) { const action = actionAt(avalue); if (action.type === 'url') action.url = event.target.value; else action.message = event.target.value; }
      sentences();
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
  // Preview is its own step in the header: it shows the draft as respondents would see it and saves nothing.
  $('#topbar-preview').onclick = () => {
    // Keeps the layout last chosen under Preview presentation; the form's own layout otherwise.
    if (view !== 'preview') return goTo('preview-' + ($('#preview-mode').value || draft.presentation || 'classic'));
    selectView('edit');
    $('#topbar-preview').focus();
  };
  // Exports what is saved, so the file always matches a revision the server accepted.
  $('#export-form').onclick = async () => {
    $('.overflow-menu').open = false;
    try {
      await exportDefinition(form);
      toast(saveState === 'saved' ? 'Form definition downloaded.' : 'Downloaded the last saved draft. Your unsaved edits are not in the file; save, then export again to include them.');
    } catch (error) { toast(error.message); }
  };
  $('#delete-form').onclick = async () => {
    if (!(await ask({ title: 'Delete this form?', body: 'The form and all of its responses are permanently deleted. This does not restore your monthly response allowance.', confirm: 'Delete form and responses', danger: true }))) return;
    try { await api('DELETE', wsPath('/forms/' + form.id)); setState('saved'); toast('Form deleted.'); ctx.navigate('/forms', { replace: true }); }
    catch (error) { reportError(error); }
  };
}

function formReadiness(ctx, currentForm, { goTo }) {
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
      form, live: settle(live), eventTypes: settle(eventTypes), publishCheck: settle(publishCheck), viewer: { admin: isAdmin() }, baseUrl: formsOrigin(),
      flags: { formsActive: Boolean(workspace().entitlements?.forms?.active), meetActive: Boolean(workspace().entitlements?.meet?.active) },
      logic: { definitionProblems, visibleFields }
    });
    $('#readiness-checked', root).textContent = `Based on the draft saved ${fmtDateTime(form.updated_at)}${form.published_version ? ` and live version ${form.published_version}` : ''}. Unsaved edits are not included.`;
    mount(body, readinessAreas(result));
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

// Submitted-date choices are kept in the address as a relative window and turned into a start time
// when the filter is applied, so paging and export use the same start.
const SINCE = [['', 'Any time'], ['1d', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']];
const SINCE_DAYS = { '1d': 1, '7d': 7, '30d': 30 };
const SIGNIN_FILTERS = [['', 'Anyone'], ['verified', 'Verified sign-in'], ['anonymous', 'Not signed in']];
const wideResponses = () => window.matchMedia('(min-width: 1200px)').matches;

export async function responses(ctx) {
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'forms', title: 'Sign in to see responses', lead: 'Responses are visible only to members of the form\'s workspace.' }));
  if (!needsSession(ctx)) return;
  // Search and filters live in the address, so a reload or a shared link keeps them. The server
  // applies them to every response, not only the loaded page (backend/src/forms/response-filter.mjs).
  const filters = {
    q: (ctx.query.get('q') || '').slice(0, 200),
    since: SINCE_DAYS[ctx.query.get('since')] ? ctx.query.get('since') : '',
    version: /^\d{1,6}$/.test(ctx.query.get('version') || '') ? ctx.query.get('version') : '',
    signin: ['verified', 'anonymous'].includes(ctx.query.get('signin')) ? ctx.query.get('signin') : ''
  };
  let sinceAt = filters.since ? Date.now() - SINCE_DAYS[filters.since] * 86400000 : null;
  const active = () => Boolean(filters.q.trim() || filters.since || filters.version || filters.signin);
  const serverQuery = () => {
    const query = new URLSearchParams();
    if (filters.q.trim()) query.set('q', filters.q.trim());
    if (sinceAt != null) query.set('from', String(sinceAt));
    if (filters.version) query.set('version', filters.version);
    if (filters.signin) query.set('signin', filters.signin);
    return query;
  };
  const listPath = before => {
    const query = serverQuery();
    if (before) query.set('before', before);
    return wsPath(`/forms/${ctx.params[0]}/responses${query.size ? '?' + query : ''}`);
  };

  mount(ctx.main, html`<div class="container page">${loading('Loading responses…')}</div>`);
  let data;
  try { data = await api('GET', listPath()); }
  catch (error) {
    const message = error.status === 404 ? 'This form was not found in the selected workspace, or you do not have access to it.' : error.status === 403 ? 'Your role in this workspace cannot view these responses.' : error.status === 400 ? `That search could not be run. ${error.message}` : error.message;
    return mount(ctx.main, html`<div class="container page">${notice('bad', html`<p>${message}</p>`)}<div class="actions"><a class="btn" href="${error.status === 400 ? ctx.path : ctx.path + location.search}">${error.status === 400 ? 'Show all responses' : 'Try again'}</a><a class="btn" href="/forms">Back to Forms</a></div></div>`);
  }
  if (!ctx.alive()) return;
  const { form, versions } = data;
  let rows = data.responses;
  let matched = data.matched ?? null;
  let total = form.response_count;
  // Keep older server responses usable during a staggered frontend/backend deployment.
  const pageCursor = page => 'next' in page ? page.next : (page.responses.length === 50 ? String(page.responses.at(-1).created_at) : null);
  let cursor = pageCursor(data);
  let more = Boolean(cursor);
  let trailPages = [data];
  let context = responseTrailContext(trailPages);
  let filter = 'all'; // 'attention' narrows the loaded responses to those whose follow-up needs attention
  let listState = 'ready'; // 'loading' while a new search runs, 'error' when it failed
  let listError = null;
  const trailOf = row => context ? buildTrail(row, context) : null;
  setTitle(`Responses: ${form.draft.title} · Forms by Schedora`);
  // Every question any version asked, latest version first; each answer is shown with the labels
  // of the version it was given in.
  const columns = [];
  for (const definition of [...Object.keys(versions).sort((a, b) => b - a).map(key => versions[key]), form.draft]) {
    for (const field of definition.fields) if (field.type !== 'page_break' && !columns.some(column => column.id === field.id)) columns.push(field);
  }
  const versionNumbers = Object.keys(versions).map(Number).sort((a, b) => b - a);
  const fieldIn = (row, id) => versions[row.form_version]?.fields.find(candidate => candidate.id === id);
  const cell = (row, column) => answerText(fieldIn(row, column.id) || column, row.answers[column.id]);
  const shortLabel = label => label.replace(/\{\{.*?\}\}/g, '…').slice(0, 60);
  // Attribution comes from the link and is shown apart from answers, labelled as such.
  // A verified sign-in is identity from the workspace's provider, shown apart from answers and attribution.
  const offersSignin = form.access === 'signin' || data.has_verified || rows.some(row => row.respondent);
  const verifiedColumn = () => rows.some(row => row.respondent);
  const attributionKeys = () => attributionColumns(Object.keys(versions).sort((a, b) => b - a).map(key => versions[key]), rows);
  const shownRows = () => filter === 'attention' && context ? rows.filter(row => trailOf(row).attention.length) : rows;
  const plural = (count, one, many = one + 's') => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;
  const filterWords = () => [
    filters.q.trim() ? `search “${filters.q.trim()}”` : null,
    filters.since ? SINCE.find(([key]) => key === filters.since)[1].toLowerCase() : null,
    filters.version ? `version ${filters.version}` : null,
    filters.signin ? SIGNIN_FILTERS.find(([key]) => key === filters.signin)[1].toLowerCase() : null
  ].filter(Boolean).join(', ');

  const summary = () => {
    if (listState === 'loading') return 'Searching responses…';
    if (listState === 'error') return 'The search did not finish.';
    const loaded = rows.length < (matched ?? total) ? ` · ${rows.length.toLocaleString('en-US')} loaded` : '';
    return active()
      ? `${plural(matched ?? rows.length, 'response')} of ${total.toLocaleString('en-US')} match ${filterWords()}${loaded}`
      : `${plural(total, 'response')}${loaded}`;
  };

  // Export always says which responses the file holds. With filters, the matching ones are the
  // first choice and all responses stay one click away.
  const drawExport = () => {
    mount($('#export-actions'), active()
      ? html`<button class="btn btn-primary" id="export" data-scope="filtered">Export ${matched == null ? 'matching' : plural(matched, 'matching response')}<span class="visually-hidden"> as CSV</span></button>
        <button class="btn" id="export-all" data-scope="all">Export all ${total.toLocaleString('en-US')}<span class="visually-hidden"> responses as CSV</span></button>`
      : html`<button class="btn btn-primary" id="export" data-scope="all">Export CSV<span class="export-scope"> · all ${total.toLocaleString('en-US')}</span></button>`);
    $('#responses-summary').textContent = summary();
    $('#clear-filters').hidden = !active();
  };

  const draw = () => {
    drawExport();
    const list = $('#responses');
    list.setAttribute('aria-busy', String(listState === 'loading'));
    if (listState === 'loading') return mount(list, loading('Searching responses…'));
    if (listState === 'error') return mount(list, html`<div class="notice notice-bad" role="alert"><p>The responses could not be searched. ${listError} Your filters are kept.</p><div class="actions"><button class="btn btn-small" type="button" data-retry-filters>Try again</button><button class="btn btn-small" type="button" data-clear-filters>Clear filters</button></div></div>`);
    if (!rows.length && active()) {
      return mount(list, html`<div class="empty"><h2>No responses match</h2><p>None of the ${plural(total, 'response')} match ${filterWords()}.${filters.q.trim() ? ' Search looks at answers, receipt codes, link attribution and verified sign-in emails.' : ''}</p><div class="actions"><button class="btn" type="button" data-clear-filters>Clear filters</button></div></div>`);
    }
    const attentionRows = context ? rows.filter(row => trailOf(row).attention.length) : [];
    const shown = shownRows();
    mount(list, rows.length ? html`<div class="trail-filter" role="group" aria-label="Show responses">
        <button class="btn btn-small" type="button" data-filter="all" aria-pressed="${filter === 'all'}">All loaded (${rows.length})</button>
        <button class="btn btn-small" type="button" data-filter="attention" aria-pressed="${filter === 'attention'}" ${context ? '' : raw('aria-disabled="true"')}>Needs attention${context ? ` (${attentionRows.length})` : ''}</button>
        <span class="muted">${context.runsAvailable && context.tasksAvailable ? html`Needs attention means a booking problem, a failed or retrying follow-up, an undelivered email, an overdue task, or an open task without a deadline. It checks the loaded responses.` : 'Follow-up history is unavailable. Reload to check it; missing history is not proof that nothing happened.'}</span></div>
      ${shown.length ? html`<div class="table-wrap"><table class="responses-table"><caption class="visually-hidden">Responses to ${form.draft.title}${active() ? `, matching ${filterWords()}` : ''}</caption>
      <thead><tr><th scope="col">Submitted</th><th scope="col">Next step</th>${verifiedColumn() ? html`<th scope="col" class="col-verified" data-verified-column>Verified sign-in <span class="col-note">identity, not an answer</span></th>` : ''}${columns.map(column => html`<th scope="col">${shortLabel(column.label)}</th>`)}${attributionKeys().map(key => html`<th scope="col" data-attribution-column>Attribution: ${key}</th>`)}</tr></thead>
      <tbody>${shown.map(row => html`<tr data-row="${row.id}" class="${row.id === openRow ? 'is-open' : ''}" ${row.id === openRow ? raw('aria-current="true"') : ''}><td class="submitted-cell">${fmtDateTime(row.created_at)}<div class="muted">Version ${row.form_version}</div>
          <button class="btn btn-small" data-view-response="${row.id}" aria-expanded="${row.id === openRow}" aria-controls="response-detail">View<span class="visually-hidden"> response from ${fmtDateTime(row.created_at)}</span></button></td>
        <td>${stepBadge(row.next_step)}${trailOf(row)?.attention.length ? html`<div class="attention-note">Needs attention: ${trailOf(row).attention.join('; ')}</div>` : ''}</td>${verifiedColumn() ? html`<td class="answer-cell col-verified">${row.respondent?.email ?? html`<span class="muted">Not signed in</span>`}</td>` : ''}${columns.map(column => html`<td class="answer-cell">${cell(row, column) || html`<span class="muted">—</span>`}</td>`)}${attributionKeys().map(key => html`<td class="answer-cell">${row.attribution?.[key] ?? html`<span class="muted">—</span>`}</td>`)}</tr>`)}</tbody></table></div>
      `
      : html`<div class="empty"><h2>Nothing needs attention</h2><p>None of the loaded responses has a booking problem, a failed follow-up or an open follow-up task.</p></div>`}
      ${more ? html`<div class="actions"><button class="btn" id="more">Load older responses</button></div>` : ''}`
    : html`<div class="empty"><h2>No responses yet</h2>${form.published_version
      ? html`<p>The form is live. Responses appear here once the server accepts them. Share this respondent link:</p>
        <div class="share-row"><input id="empty-link" readonly aria-label="Respondent link" value="${publicUrl(form)}"><button class="btn btn-small" type="button" id="copy-empty-link">Copy link</button></div><p class="copy-status" id="empty-copy-status" role="status"></p>`
      : html`<p>${form.locked_ids?.length ? 'The form is closed, so it is not collecting responses.' : 'The form is not published yet, so nobody can respond.'}</p><p><a class="btn" href="/forms/${form.id}">Open the form to publish it</a></p>`}</div>`);
  };

  // The detail is a panel beside the list on wide screens and a full-screen sheet on narrow ones. The
  // list is never redrawn or scrolled by opening, stepping through or closing it, so its position stays.
  let openRow = null;
  const panel = () => $('#response-detail');
  const markOpen = () => $$('#responses tr[data-row]').forEach(tr => {
    const open = tr.dataset.row === openRow;
    tr.classList.toggle('is-open', open);
    if (open) tr.setAttribute('aria-current', 'true'); else tr.removeAttribute('aria-current');
    $('[data-view-response]', tr)?.setAttribute('aria-expanded', String(open));
  });
  // Opening or closing the panel changes the list's width, so the response's row is kept where it was
  // on screen rather than letting the reflow move it.
  const keepRowInPlace = (id, change) => {
    const top = () => $(`#responses tr[data-row="${id}"]`)?.getBoundingClientRect().top;
    const before = top();
    change();
    const after = top();
    if (before != null && after != null && Math.abs(after - before) > 1) window.scrollBy(0, after - before);
  };
  const showDetail = (row, { focus = true } = {}) => {
    // A panel opened beside the list on a wide window becomes a sheet when reopened on a narrow one.
    if (panel().open && panel().matches(':modal') === wideResponses()) { reopening = true; panel().close(); }
    openRow = row.id;
    const definition = versions[row.form_version];
    const fields = (definition?.fields || []).filter(field => field.type !== 'page_break');
    const answered = new Set(Object.keys(row.answers));
    const extra = columns.filter(column => answered.has(column.id) && !fields.some(field => field.id === column.id));
    const shown = shownRows();
    const index = shown.findIndex(item => item.id === row.id);
    mount(panel(), html`<section aria-labelledby="detail-title"><div class="detail-head"><h2 id="detail-title" tabindex="-1">Response from ${fmtDateTime(row.created_at)}</h2><button class="btn btn-small" type="button" id="close-detail">Close<span class="visually-hidden"> response</span></button></div>
      ${index >= 0 ? html`<div class="detail-nav" role="group" aria-label="Move between responses"><button class="btn btn-small" type="button" data-step-detail="-1" ${index > 0 ? '' : raw('disabled')}>← Newer</button><span class="muted">${index + 1} of ${shown.length} shown</span><button class="btn btn-small" type="button" data-step-detail="1" ${index < shown.length - 1 ? '' : raw('disabled')}>Older →</button></div>` : ''}
      <p class="muted">Receipt ${row.id.replace(/-/g, '').slice(0, 8).toUpperCase()} · Answered version ${row.form_version}${form.published_version && form.published_version !== row.form_version ? ` (live version is ${form.published_version})` : ''}</p>
      ${row.respondent ? html`<section class="detail-identity" aria-labelledby="detail-identity-title"><h3 id="detail-identity-title">Verified sign-in</h3><p class="hint">Confirmed by your workspace's identity provider when this response was submitted. It is not an answer: the respondent could not type or change it.</p>
        <dl class="response-answers" data-verified><dt>Email</dt><dd>${row.respondent.email}</dd>${row.respondent.name ? html`<dt>Name</dt><dd>${row.respondent.name}</dd>` : ''}<dt>Account ID</dt><dd><code>${row.respondent.subject}</code></dd><dt>Signed in</dt><dd>${fmtDateTime(row.respondent.verified_at)}</dd></dl></section>`
        : ''}
      <h3>Answers</h3><p class="hint">What the respondent entered${row.respondent ? ', separate from the verified sign-in above' : ''}.</p>
      <dl class="response-answers" data-answers>${[...fields, ...extra].map(field => html`<dt>${pipe(field.label, definition || { fields: [] }, row.answers)}</dt><dd>${answerText(field, row.answers[field.id]) || html`<span class="muted">Not answered or not shown</span>`}</dd>`)}</dl>
      ${row.attribution ? html`<h3>Attribution</h3><p class="hint">From the link this person used. Anyone can edit a link, so treat these as unverified.</p><dl class="response-answers" data-attribution>${Object.entries(row.attribution).map(([key, value]) => html`<dt>${key}</dt><dd>${value}</dd>`)}</dl>` : ''}
      ${context ? trailList(trailOf(row)) : html`<p class="muted" role="status">Checking what happened next…</p>`}
      ${isAdmin() ? html`<div class="actions"><button class="btn btn-danger btn-small" data-delete="${row.id}">Delete this response</button></div>` : ''}</section>`);
    const dialog = panel();
    keepRowInPlace(row.id, () => {
      if (!dialog.open) { if (wideResponses()) dialog.show(); else dialog.showModal(); }
      $('#responses-layout').classList.toggle('has-detail', !dialog.matches(':modal'));
      markOpen();
    });
    dialog.scrollTop = 0;
    // Stepping to a row outside the visible part of the list brings it into view.
    const rect = $(`#responses tr[data-row="${row.id}"]`)?.getBoundingClientRect();
    if (rect && !dialog.matches(':modal') && (rect.top < 0 || rect.bottom > innerHeight)) $(`#responses tr[data-row="${row.id}"]`).scrollIntoView({ block: 'nearest' });
    if (focus) $('#detail-title').focus({ preventScroll: true });
  };
  // Close, Escape and View again return focus to the response's row; closing because the list changed
  // (a new search, a filter, a deletion) leaves focus where the person is working.
  let restoreFocus = true;
  let reopening = false; // closed only to reopen in the other layout: keep the content
  const closeDetail = ({ restore = true } = {}) => { if (!panel().open) return; restoreFocus = restore; panel().close(); };

  mount(ctx.main, html`<div class="container page responses-page" id="responses-page"><a href="/forms/${form.id}">← Back to form</a>
    <div class="row-between responses-head"><h1>Responses</h1><div class="row export-actions" id="export-actions"></div></div>
    <p class="muted">${form.draft.title} · ${total} total in ${workspace().name} · ${form.published_version ? `live version ${form.published_version}` : form.locked_ids?.length ? 'closed' : 'not published'} · kept for ${workspace().retention_days || 365} days under your workspace retention setting. <a href="/enquiries?from=response">See enquiries across all forms and bookings</a>.</p>
    <form class="responses-filters" id="responses-filters" role="search" aria-label="Search and filter responses">
      <div class="filter-search"><label for="response-search">Search responses</label><input type="search" id="response-search" maxlength="200" autocomplete="off" value="${filters.q}" placeholder="Answer, receipt or verified email" aria-describedby="responses-summary"></div>
      <div><label for="response-since">Submitted</label><select id="response-since">${SINCE.map(([key, label]) => html`<option value="${key}" ${filters.since === key ? raw('selected') : ''}>${label}</option>`)}</select></div>
      ${versionNumbers.length > 1 ? html`<div><label for="response-version">Version</label><select id="response-version"><option value="">All versions</option>${versionNumbers.map(number => html`<option value="${number}" ${filters.version === String(number) ? raw('selected') : ''}>Version ${number}${number === form.published_version ? ' (live)' : ''}</option>`)}</select></div>` : ''}
      ${offersSignin ? html`<div><label for="response-signin">Sign-in</label><select id="response-signin">${SIGNIN_FILTERS.map(([key, label]) => html`<option value="${key}" ${filters.signin === key ? raw('selected') : ''}>${label}</option>`)}</select></div>` : ''}
      <button class="btn btn-small" type="button" id="clear-filters" data-clear-filters hidden>Clear filters</button>
    </form>
    <p class="responses-summary" id="responses-summary"></p>
    <div id="export-status" tabindex="-1"></div>
    <p id="responses-status" class="visually-hidden" role="status"></p>
    <div class="responses-layout" id="responses-layout">
      <div id="responses"></div>
      <dialog class="response-panel" id="response-detail" aria-labelledby="detail-title"></dialog>
    </div></div>`);
  draw();

  panel().addEventListener('close', () => {
    if (reopening || panel().open) { reopening = false; return; }
    const id = openRow;
    openRow = null;
    keepRowInPlace(id, () => { $('#responses-layout').classList.remove('has-detail'); markOpen(); });
    mount(panel(), '');
    if (restoreFocus) $(`[data-view-response="${id}"]`)?.focus({ preventScroll: true });
    restoreFocus = true;
  });
  // A panel shown beside the list is not modal, so Escape is handled here.
  panel().addEventListener('keydown', event => { if (event.key === 'Escape' && !panel().matches(':modal')) { event.preventDefault(); closeDetail(); } });

  // A new search replaces the loaded responses; an older request finishing late is ignored.
  let searchToken = 0;
  const applyFilters = async ({ announce = true } = {}) => {
    const token = ++searchToken;
    sinceAt = filters.since ? Date.now() - SINCE_DAYS[filters.since] * 86400000 : null;
    const address = new URLSearchParams();
    for (const key of ['q', 'since', 'version', 'signin']) if (String(filters[key]).trim()) address.set(key, String(filters[key]).trim());
    history.replaceState(history.state, '', ctx.path + (address.size ? '?' + address : ''));
    closeDetail({ restore: false });
    listState = 'loading';
    draw();
    try {
      const page = await api('GET', listPath());
      if (token !== searchToken || !ctx.alive()) return;
      rows = page.responses;
      matched = page.matched ?? null;
      total = page.form?.response_count ?? total;
      cursor = pageCursor(page);
      more = Boolean(cursor);
      trailPages = [page];
      context = responseTrailContext(trailPages);
      listState = 'ready';
      draw();
      if (announce) $('#responses-status').textContent = summary();
    } catch (error) {
      if (token !== searchToken || !ctx.alive()) return;
      listState = 'error';
      listError = error.status === 400 ? error.message : error.name === 'TimeoutError' || error instanceof TypeError ? 'Schedora could not be reached.' : error.message;
      draw();
      $('#responses-status').textContent = 'The search did not finish. Your filters are kept.';
    }
  };
  let typing;
  $('#response-search').addEventListener('input', event => {
    clearTimeout(typing);
    typing = setTimeout(() => { if (filters.q !== event.target.value) { filters.q = event.target.value; applyFilters(); } }, 300);
  });
  $('#responses-filters').addEventListener('submit', event => { event.preventDefault(); clearTimeout(typing); filters.q = $('#response-search').value; applyFilters(); });
  $('#responses-filters').addEventListener('change', event => {
    const key = { 'response-since': 'since', 'response-version': 'version', 'response-signin': 'signin' }[event.target.id];
    if (!key) return;
    filters[key] = event.target.value;
    applyFilters();
  });

  // The export is fetched here so a failure is shown with a retry instead of downloading an error page.
  const exportCsv = async scope => {
    const button = scope === 'all' && active() ? $('#export-all') : $('#export');
    button.setAttribute('aria-disabled', 'true');
    mount($('#export-status'), html`<p class="muted" role="status">Preparing export…</p>`);
    try {
      const query = scope === 'filtered' ? serverQuery() : new URLSearchParams();
      const response = await fetch(wsPath(`/forms/${form.id}/responses.csv${query.size ? '?' + query : ''}`), { credentials: 'same-origin', signal: AbortSignal.timeout(60000) });
      if (!response.ok) throw new Error(response.status === 404 || response.status === 403 ? 'You no longer have access to export these responses.' : 'The export could not be created.');
      const count = Number(response.headers.get('x-response-count'));
      const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || `${form.slug}-responses.csv`;
      const url = URL.createObjectURL(await response.blob());
      const link = Object.assign(document.createElement('a'), { href: url, download: name });
      document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      const counted = Number.isFinite(count) && response.headers.has('x-response-count') ? plural(count, 'response') : null;
      mount($('#export-status'), html`<p class="muted" role="status">${scope === 'filtered'
        ? `Export downloaded: ${counted ? `the ${counted}` : 'the responses'} matching ${filterWords()}. Other responses are not in this file.`
        : `Export downloaded: ${counted ? `all ${counted}` : 'every response'}, whatever the filters, with the form version each one answered.`}</p>`);
    } catch (error) {
      mount($('#export-status'), notice('bad', html`<p>${error.name === 'TimeoutError' || error instanceof TypeError ? 'The export did not finish. Check your connection.' : error.message}</p><button class="btn btn-small" type="button" id="retry-export">Try again</button>`));
      $('#retry-export').onclick = () => exportCsv(scope);
      $('#export-status').focus();
    } finally { button?.removeAttribute('aria-disabled'); }
  };

  $('#responses-page').addEventListener('click', async event => {
    const target = event.target.closest('button');
    if (!target || target.closest('#responses-filters') && target.id !== 'clear-filters') return;
    if (target.dataset.scope) return exportCsv(target.dataset.scope);
    if (target.dataset.clearFilters !== undefined) {
      Object.assign(filters, { q: '', since: '', version: '', signin: '' });
      $('#response-search').value = '';
      for (const id of ['#response-since', '#response-version', '#response-signin']) if ($(id)) $(id).value = '';
      await applyFilters();
      return $('#response-search').focus();
    }
    if (target.dataset.retryFilters !== undefined) return applyFilters();
    if (target.id === 'more') {
      if (!cursor || target.disabled) return;
      target.disabled = true;
      mount($('#responses-status'), 'Loading older responses…');
      const token = searchToken;
      try {
        const older = await api('GET', listPath(cursor));
        if (!ctx.alive() || token !== searchToken) return;
        rows = [...new Map(rows.concat(older.responses).map(row => [row.id, row])).values()];
        trailPages.push(older);
        context = responseTrailContext(trailPages);
        cursor = pageCursor(older);
        more = Boolean(cursor);
        draw();
        mount($('#responses-status'), `Loaded ${older.responses.length} older responses. ${rows.length} responses loaded${more ? '; more are available.' : '; all responses are loaded.'}`);
        if (openRow) { const row = rows.find(item => item.id === openRow); if (row) showDetail(row, { focus: false }); }
        ($('#more') || $('[data-filter="all"]'))?.focus();
      } catch (error) { mount($('#responses-status'), `Older responses could not be loaded. ${error.message}`); target.disabled = false; }
      return;
    }
    if (target.dataset.filter) {
      if (target.getAttribute('aria-disabled') === 'true') return;
      filter = target.dataset.filter;
      closeDetail({ restore: false });
      draw();
      return $(`[data-filter="${filter}"]`)?.focus();
    }
    if (target.id === 'copy-empty-link') {
      try { await navigator.clipboard.writeText(publicUrl(form)); $('#empty-copy-status').textContent = 'Respondent link copied. Nothing has been sent.'; }
      catch { $('#empty-link').select(); $('#empty-copy-status').textContent = 'Copy failed. The link is selected: press Ctrl+C (⌘C on a Mac) to copy it.'; }
      return;
    }
    if (target.id === 'close-detail') return closeDetail();
    if (target.dataset.stepDetail) {
      const shown = shownRows();
      const next = shown[shown.findIndex(row => row.id === openRow) + Number(target.dataset.stepDetail)];
      if (next) { showDetail(next, { focus: false }); $(`[data-step-detail="${target.dataset.stepDetail}"]`)?.focus(); if ($(`[data-step-detail="${target.dataset.stepDetail}"]`)?.disabled) $('#detail-title').focus(); }
      return;
    }
    if (target.dataset.viewResponse) {
      if (openRow === target.dataset.viewResponse && panel().open) return closeDetail();
      return showDetail(rows.find(row => row.id === target.dataset.viewResponse));
    }
    const id = target.dataset.delete;
    if (!id || !(await ask({ title: 'Delete this response?', body: 'It is removed permanently from this inbox and from future exports. Exports already downloaded are not changed. Deleting does not restore your monthly response allowance, and it does not cancel a booking made from this response.', confirm: 'Delete response', danger: true }))) return;
    try {
      await api('DELETE', wsPath(`/forms/${form.id}/responses/${id}`));
      rows = rows.filter(row => row.id !== id);
      total = Math.max(0, total - 1);
      if (matched != null) matched = Math.max(0, matched - 1);
      closeDetail({ restore: false });
      draw();
      toast('Response deleted.');
      $('#export')?.focus();
    } catch (error) { toast(error.message); }
  });
}
