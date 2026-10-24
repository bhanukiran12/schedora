import { $, $$, api, ask, badge, copy, errorBlock, fmtDateTime, html, isAdmin, loading, mount, notice, raw, session, showErrors, toast, uid, workspace, wsPath } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';
import { CONDITION_OPS, FIELD_TYPES, answerText, checkAnswer, pipe, visibleFields, visiblePages } from '/shared/forms-logic.mjs';

const publicUrl = (form, mode) => `${location.origin}/f/${form.slug}${mode ? '?mode=' + mode : ''}`;

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

// Renders a form definition. In preview mode nothing is submitted.
export { inputFor, readAnswer };
export function renderForm(container, definition, { mode = definition.presentation, preview = false, onSubmit } = {}) {
  const answers = {};
  let position = 0; // page index (classic) or question index (conversational)
  let errors = {};
  let finished = false;

  const pagesNow = () => mode === 'conversational' ? visibleFields(definition, answers).map(field => [field]) : visiblePages(definition, answers);

  function draw(focusId) {
    if (finished) return;
    const pages = pagesNow();
    position = Math.min(position, pages.length - 1);
    const fields = pages[position] || [];
    const last = position === pages.length - 1;
    const total = pages.length;
    const progress = total > 1 ? Math.round((position / total) * 100) : 0;
    const conversational = mode === 'conversational';
    mount(container, html`<form class="public-form ${conversational ? 'conversational' : ''}" novalidate>
      ${position === 0 || !conversational ? html`<h1 ${raw(preview ? 'aria-level="2" role="heading"' : '')}>${definition.title}</h1>${definition.description && position === 0 ? html`<p>${definition.description}</p>` : ''}` : ''}
      ${total > 1 ? html`<div class="progress" role="progressbar" aria-label="Progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${progress}"><span style-width="${progress}"></span></div>
        <p class="muted">${conversational ? `Question ${position + 1} of ${total}` : `Page ${position + 1} of ${total}`}</p>` : ''}
      ${!conversational && fields.some(field => field.required) ? html`<p class="muted"><span class="required-mark" aria-hidden="true">*</span> Required</p>` : ''}
      ${fields.length ? fields.map(field => html`<div class="question" data-field="${field.id}">${conversational ? html`<span class="question-number">${position + 1} →</span>` : ''}
        ${inputFor(field, answers[field.id], pipe(field.label, definition, answers))}
        ${errors[field.id] ? html`<div class="field-error" id="q-${field.id}-error">${errors[field.id]}</div>` : ''}</div>`) : html`<p class="muted">This form has no questions yet.</p>`}
      <div data-form-status tabindex="-1"></div>
      <div class="actions">
        ${position > 0 ? html`<button type="button" class="btn" data-back>Back</button>` : ''}
        <button type="submit" class="btn btn-primary">${last ? (preview ? 'Submit (preview)' : definition.submit_label || 'Submit') : conversational ? 'OK' : 'Next'}</button>
        ${conversational && !last ? html`<span class="kbd-hint">or press Enter ↵</span>` : ''}
      </div>
      ${preview ? html`<p class="muted">Preview only. Publish the form to collect responses.</p>` : ''}
    </form>`);
    // Width set through the CSSOM: the page's style policy disallows inline style attributes.
    $$('[style-width]', container).forEach(bar => { bar.style.width = bar.getAttribute('style-width') + '%'; bar.removeAttribute('style-width'); });
    const form = $('form', container);
    for (const field of fields) {
      if (errors[field.id]) $$(`[name="${field.id}"]`, form).forEach(input => { input.setAttribute('aria-invalid', 'true'); input.setAttribute('aria-describedby', [input.getAttribute('aria-describedby'), `q-${field.id}-error`].filter(Boolean).join(' ')); });
    }
    const target = focusId ? form.querySelector(`#${CSS.escape(focusId)}`) : null;
    if (target) target.focus();
    else if (focusId !== null && (conversational || Object.keys(errors).length)) (form.querySelector('[aria-invalid="true"]') || form.querySelector('input, textarea'))?.focus();

    form.addEventListener('change', event => {
      const name = event.target.name;
      const field = definition.fields.find(candidate => candidate.id === name);
      if (!field) return;
      answers[name] = readAnswer(form, field);
      delete errors[name];
      // Re-render when this answer changes which questions are visible or what labels say.
      const signature = JSON.stringify(pagesNow().map(page => page.map(item => [item.id, pipe(item.label, definition, answers)])));
      if (signature !== form.dataset.signature) draw(event.target.id);
    });
    form.dataset.signature = JSON.stringify(pagesNow().map(page => page.map(item => [item.id, pipe(item.label, definition, answers)])));
    form.addEventListener('input', event => {
      const field = definition.fields.find(candidate => candidate.id === event.target.name);
      if (field && !field.type.endsWith('choice')) answers[field.id] = event.target.value;
    });
    form.querySelector('[data-back]')?.addEventListener('click', () => { errors = {}; position--; draw(); });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      for (const field of fields) answers[field.id] = readAnswer(form, field);
      errors = {};
      for (const field of fields) { const result = checkAnswer(field, answers[field.id]); if (result.error) errors[field.id] = result.error; }
      if (Object.keys(errors).length) return draw();
      if (!last) { position++; return draw(); }
      if (preview) { mount(container, notice('ok', html`<p><strong>Preview complete.</strong> In the published form, this response would be saved now.</p><button class="btn" type="button" id="restart-preview">Restart preview</button>`)); $('#restart-preview', container).onclick = () => renderForm(container, definition, { mode, preview }); return; }
      const button = form.querySelector('[type="submit"]');
      button.setAttribute('aria-disabled', 'true');
      button.textContent = 'Sending…';
      try {
        await onSubmit(answers);
        finished = true;
      } catch (error) {
        if (error.details?.errors) {
          errors = error.details.errors;
          const firstPage = pagesNow().findIndex(page => page.some(field => errors[field.id]));
          if (firstPage >= 0) position = firstPage;
          draw();
        } else {
          button.removeAttribute('aria-disabled');
          button.textContent = definition.submit_label || 'Submit';
          showErrors(form, error);
        }
      }
    });
  }
  draw(null);
}

// ---------------------------------------------------------------------------------------------
// Public form page

export async function publicForm(ctx) {
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let form;
  try { form = await api('GET', `/api/public/forms/${ctx.params[0]}`); }
  catch (error) {
    if (error.status === 404) return mount(ctx.main, html`<div class="container page"><h1>This form is not available</h1><p>It may have been unpublished or the link is mistyped.</p></div>`);
    throw error;
  }
  if (!ctx.alive()) return;
  setTitle(form.definition.title + ' · Forms by Schedora');
  const mode = ['classic', 'conversational'].includes(ctx.query.get('mode')) ? ctx.query.get('mode') : form.definition.presentation;
  mount(ctx.main, html`<div class="container page"><div class="card public-form-card" id="form-root"></div><p class="muted public-form">${form.workspace_name} · Powered by Forms by Schedora</p></div>`);
  const root = $('#form-root');
  if (!form.accepting) return mount(root, notice('warn', html`<p>This form is not accepting responses right now.</p>`));
  const submissionId = uid() + uid();
  renderForm(root, form.definition, {
    mode,
    onSubmit: async answers => {
      const result = await api('POST', `/api/public/forms/${form.slug}/responses`, { answers, submission_id: submissionId });
      // Routing forms send respondents on to a booking page, a link or a message.
      if (result.route?.type === 'event' || result.route?.type === 'url') { (window.top === window ? location : window.top.location).href = result.route.url; return; }
      mount(root, html`<div role="status" class="public-form"><h1 tabindex="-1">Thank you</h1><p>${result.route?.type === 'message' ? result.route.message : 'Your response was received and saved.'}</p></div>`);
      $('h1', root).focus();
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Dashboard

export async function dashboard(ctx) {
  setTitle('Forms by Schedora');
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'forms', title: 'Every good conversation starts with a question.', lead: 'Build classic or one-question-at-a-time forms with logic and answer piping. Responses are saved to your workspace and can be exported.' }));
  if (!needsSession(ctx)) return;
  mount(ctx.main, html`<div class="container page"><div class="row-between"><div><span class="tag">Forms · ${workspace().name}</span><h1>Forms</h1></div>
    <button class="btn btn-primary" id="new-form">Create form</button></div>
    ${workspace().entitlements.forms.active ? '' : notice('warn', html`<p>This workspace has no active Forms or Suite plan, so forms cannot be published or collect responses. <a href="/billing">Review plans</a>.</p>`)}
    <div id="form-list">${loading()}</div></div>`);
  $('#new-form').onclick = async () => {
    try { const form = await api('POST', wsPath('/forms'), { title: 'Untitled form' }); ctx.navigate('/forms/' + form.id); }
    catch (error) { toast(error.message); }
  };
  try {
    const forms = await api('GET', wsPath('/forms'));
    if (!ctx.alive()) return;
    mount($('#form-list'), forms.length ? html`<ul class="list">${forms.map(form => html`<li class="row-between"><div>
        <div class="list-title">${form.draft.title}</div>
        <div class="meta"><span>${form.response_count} ${form.response_count === 1 ? 'response' : 'responses'}</span><span>Updated ${fmtDateTime(form.updated_at)}</span>${form.published_version && form.has_unpublished_changes ? html`<span>Unpublished changes</span>` : ''}</div></div>
      <div class="row">${form.published_version ? badge('published', 'Published v' + form.published_version) : badge('draft')}
        <a class="btn btn-small" href="/forms/${form.id}">Edit</a><a class="btn btn-small" href="/forms/${form.id}/responses">Responses</a></div></li>`)}</ul>`
      : html`<div class="empty"><h2>No forms yet</h2><p>Start with a short intake form; you can change everything later.</p></div>`);
  } catch (error) { mount($('#form-list'), errorBlock(error)); }
}

// ---------------------------------------------------------------------------------------------
// Builder

const newId = (definition, base) => {
  const clean = base.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'q';
  let id = clean;
  for (let index = 2; definition.fields.some(field => field.id === id); index++) id = `${clean}_${index}`;
  return id;
};

export async function builder(ctx) {
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'forms', title: 'Sign in to edit this form', lead: 'Forms belong to your workspace.' }));
  if (!needsSession(ctx)) return;
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let form;
  try { form = await api('GET', wsPath('/forms/' + ctx.params[0])); }
  catch (error) { return mount(ctx.main, html`<div class="container page">${errorBlock(error)}<a href="/forms">Back to Forms</a></div>`); }
  if (!ctx.alive()) return;
  const draft = structuredClone(form.draft);
  setTitle(`${draft.title} · Forms by Schedora`);
  let dirty = false;
  let view = 'edit';

  mount(ctx.main, html`<div class="container page">
    <a href="/forms">← All forms</a>
    <div class="row-between"><h1 id="builder-title">${draft.title}</h1><div class="row" id="builder-status"></div></div>
    <div class="actions"><button class="btn" id="save">Save draft</button><button class="btn btn-primary" id="publish">Publish form</button>
      <a class="btn" href="/forms/${form.id}/responses">Responses</a><button class="btn btn-danger" id="delete-form">Delete</button></div>
    <div id="builder-notice" tabindex="-1"></div>
    <div id="share"></div>
    <div id="routing"></div>
    <div class="tabs mobile-switch" role="tablist" aria-label="Builder view"><button role="tab" data-view="edit" aria-selected="true">Edit</button><button role="tab" data-view="preview" aria-selected="false">Preview</button></div>
    <div class="builder" data-view="edit">
      <section class="builder-edit" aria-label="Form editor"><div id="settings"></div><div id="fields"></div>
        <div class="card card-plain"><label for="new-type">Add an item</label><div class="row"><select id="new-type">${Object.entries(FIELD_TYPES).map(([key, label]) => html`<option value="${key}">${label}</option>`)}</select><button class="btn" id="add-field">Add</button></div></div></section>
      <section class="builder-preview card" aria-label="Live preview"><div class="row-between"><h2>Preview</h2><select id="preview-mode" aria-label="Preview presentation"><option value="classic">Classic</option><option value="conversational">Conversational</option></select></div><div id="preview"></div></section>
    </div></div>`);

  const setDirty = value => {
    dirty = value;
    if (value) document.body.dataset.dirty = '1'; else delete document.body.dataset.dirty;
    renderStatus();
  };
  const renderStatus = () => mount($('#builder-status'), html`${form.published_version ? badge('published', 'Published v' + form.published_version) : badge('draft')}${dirty ? badge('pending', 'Unsaved changes') : form.has_unpublished_changes && form.published_version ? badge('pending', 'Draft differs from published') : ''}`);
  const renderShare = () => mount($('#share'), form.published_version ? html`<details class="card card-plain"><summary><strong>Share and embed</strong></summary>
    <label for="share-link">Public link</label><div class="row"><input id="share-link" readonly value="${publicUrl(form)}"><button class="btn btn-small" data-copy="${publicUrl(form)}">Copy</button><a class="btn btn-small" href="/f/${form.slug}" target="_blank" rel="noopener">Open</a></div>
    <label for="share-conv">Conversational link</label><div class="row"><input id="share-conv" readonly value="${publicUrl(form, 'conversational')}"><button class="btn btn-small" data-copy="${publicUrl(form, 'conversational')}">Copy</button></div>
    <label for="embed">Embed on your site</label><textarea id="embed" class="embed-code" readonly>&lt;iframe src="${publicUrl(form)}${publicUrl(form).includes('?') ? '&amp;' : '?'}embed=1" title="${draft.title}" width="100%" height="680" style="border:0"&gt;&lt;/iframe&gt;</textarea>
    <button class="btn btn-small" data-copy-embed>Copy embed code</button>
    <div class="actions"><button class="btn btn-danger btn-small" id="unpublish">Stop collecting responses</button></div></details>` : '');
  const renderPreview = () => renderForm($('#preview'), draft, { mode: $('#preview-mode').value, preview: true });

  const renderSettings = () => mount($('#settings'), html`<div class="card card-plain">
    <label for="f-title">Form title</label><input id="f-title" data-setting="title" maxlength="150" value="${draft.title}">
    <label for="f-description">Description</label><textarea id="f-description" data-setting="description" maxlength="2000">${draft.description || ''}</textarea>
    <fieldset><legend class="label">Presentation</legend>
      <label class="check"><input type="radio" name="presentation" value="classic" data-setting="presentation" ${draft.presentation === 'classic' ? raw('checked') : ''}> Classic: questions grouped into pages</label>
      <label class="check"><input type="radio" name="presentation" value="conversational" data-setting="presentation" ${draft.presentation === 'conversational' ? raw('checked') : ''}> Conversational: one question at a time</label></fieldset>
    <label for="f-submit">Submit button text</label><input id="f-submit" data-setting="submit_label" maxlength="40" value="${draft.submit_label || 'Submit'}"></div>`);

  const renderFields = () => {
    mount($('#fields'), html`${draft.fields.map((field, index) => {
      const earlier = draft.fields.slice(0, index).filter(candidate => candidate.type !== 'page_break');
      const source = field.show_if && draft.fields.find(candidate => candidate.id === field.show_if.field);
      const number = draft.fields.slice(0, index + 1).filter(candidate => candidate.type !== 'page_break').length;
      return html`<div class="field-editor ${field.type === 'page_break' ? 'page-break' : ''}" data-index="${index}">
        <div class="field-editor-head"><strong>${field.type === 'page_break' ? 'Page break' : `${number}. ${FIELD_TYPES[field.type]}`}</strong>
          <div class="row"><button class="btn btn-small" data-move="-1" ${index === 0 ? raw('disabled') : ''} aria-label="Move up">↑</button><button class="btn btn-small" data-move="1" ${index === draft.fields.length - 1 ? raw('disabled') : ''} aria-label="Move down">↓</button><button class="btn btn-small btn-danger" data-remove aria-label="Remove item ${index + 1}">Remove</button></div></div>
        ${field.type === 'page_break' ? html`<p class="hint">Questions after this start a new page in classic presentation.</p>` : html`
          <label for="fl-${index}">Question</label><span class="hint">Insert an earlier answer with {{question_key}}${earlier.length ? `, for example {{${earlier[0].id}}}` : ''}.</span>
          <input id="fl-${index}" data-prop="label" maxlength="300" value="${field.label}">
          <label for="fh-${index}">Help text</label><input id="fh-${index}" data-prop="help" maxlength="500" value="${field.help || ''}">
          <div class="row"><label class="check"><input type="checkbox" data-prop="required" ${field.required ? raw('checked') : ''}> Required</label>
            <label class="check">Key <input data-prop="id" value="${field.id}" maxlength="40" pattern="[a-z0-9_]+" aria-label="Question key" class="key-input"></label></div>
          ${field.type.endsWith('_choice') ? html`<fieldset><legend class="label">Options</legend>${field.options.map((option, optionIndex) => html`<div class="range"><input aria-label="Option ${optionIndex + 1}" data-option="${optionIndex}" maxlength="200" value="${option.label}"><button class="btn btn-small" data-remove-option="${optionIndex}" ${field.options.length === 1 ? raw('disabled') : ''}>Remove</button></div>`)}
            <button class="btn-link" data-add-option>Add option</button></fieldset>` : ''}`}
        <label class="check"><input type="checkbox" data-logic ${field.show_if ? raw('checked') : ''} ${earlier.length ? '' : raw('disabled')}> ${field.type === 'page_break' ? 'Show this page only when…' : 'Show only when…'}</label>
        ${field.show_if ? html`<div class="row">
          <select data-cond="field" aria-label="Earlier question">${earlier.map(candidate => html`<option value="${candidate.id}" ${candidate.id === field.show_if.field ? raw('selected') : ''}>${candidate.label.slice(0, 50)}</option>`)}</select>
          <select data-cond="op" aria-label="Rule">${Object.entries(CONDITION_OPS).map(([op, label]) => html`<option value="${op}" ${op === field.show_if.op ? raw('selected') : ''}>${label}</option>`)}</select>
          ${['answered', 'not_answered'].includes(field.show_if.op) ? '' : source?.type?.endsWith('_choice')
            ? html`<select data-cond="value" aria-label="Value">${source.options.map(option => html`<option value="${option.id}" ${option.id === field.show_if.value ? raw('selected') : ''}>${option.label}</option>`)}</select>`
            : html`<input data-cond="value" aria-label="Value" value="${field.show_if.value || ''}">`}</div>` : ''}
      </div>`;
    })}`);
  };

  const refresh = ({ fields = false, preview = true } = {}) => {
    if (fields) renderFields();
    if (preview) renderPreview();
    setDirty(true);
  };

  renderStatus(); renderShare(); renderSettings(); renderFields();
  $('#preview-mode').value = draft.presentation;
  renderPreview();

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
      return refresh({ fields: true });
    }
    if (cond === 'field' || cond === 'op' || (cond === 'value' && event.target.tagName === 'SELECT')) {
      field.show_if[cond] = event.target.value;
      const source = draft.fields.find(candidate => candidate.id === field.show_if.field);
      if (['answered', 'not_answered'].includes(field.show_if.op)) delete field.show_if.value;
      else if (source?.type.endsWith('_choice') && !source.options.some(option => option.id === field.show_if.value)) field.show_if.value = source.options[0].id;
      else field.show_if.value ??= '';
      return refresh({ fields: true });
    }
  });
  fieldsRoot.addEventListener('click', event => {
    const button = event.target.closest('button');
    const editor = event.target.closest('[data-index]');
    if (!button || !editor) return;
    event.preventDefault();
    const index = Number(editor.dataset.index);
    const field = draft.fields[index];
    if (button.dataset.move) {
      const target = index + Number(button.dataset.move);
      [draft.fields[index], draft.fields[target]] = [draft.fields[target], draft.fields[index]];
      // Logic may only refer to earlier questions; drop rules that no longer do.
      draft.fields.forEach((item, position) => { if (item.show_if && !draft.fields.slice(0, position).some(candidate => candidate.id === item.show_if.field)) delete item.show_if; });
    } else if (button.dataset.remove !== undefined) {
      draft.fields.splice(index, 1);
      draft.fields.forEach(item => { if (item.show_if?.field === field.id) delete item.show_if; });
    } else if (button.dataset.addOption !== undefined) {
      field.options.push({ id: newId({ fields: field.options }, 'option_' + (field.options.length + 1)), label: 'Option ' + (field.options.length + 1) });
    } else if (button.dataset.removeOption !== undefined) {
      field.options.splice(Number(button.dataset.removeOption), 1);
    } else return;
    refresh({ fields: true });
  });
  $('#add-field').onclick = () => {
    const type = $('#new-type').value;
    const field = { id: newId(draft, type === 'page_break' ? 'page' : 'question'), type, label: type === 'page_break' ? '' : 'New question', required: false };
    if (type === 'page_break') delete field.required;
    if (type.endsWith('_choice')) field.options = [{ id: 'option_1', label: 'Option 1' }, { id: 'option_2', label: 'Option 2' }];
    draft.fields.push(field);
    refresh({ fields: true });
    $$('#fields [data-prop="label"]').pop()?.focus();
  };
  $$('.mobile-switch [data-view]').forEach(tab => tab.onclick = () => {
    view = tab.dataset.view;
    $('.builder').dataset.view = view;
    $$('.mobile-switch [data-view]').forEach(item => item.setAttribute('aria-selected', String(item.dataset.view === view)));
  });

  const reportError = error => { mount($('#builder-notice'), notice('bad', html`<p>${error.message}</p>${error.details?.problems?.length > 1 ? html`<ul>${error.details.problems.slice(1, 8).map(problem => html`<li>${problem}</li>`)}</ul>` : ''}`)); $('#builder-notice').focus(); };
  const save = async () => {
    $('#builder-notice').innerHTML = '';
    form = await api('PATCH', wsPath('/forms/' + form.id), { definition: draft });
    setDirty(false);
  };
  $('#save').onclick = async () => { try { await save(); toast(form.published_version ? 'Draft saved. Publish to update the live form.' : 'Draft saved.'); } catch (error) { reportError(error); } };
  $('#publish').onclick = async () => {
    try {
      await save();
      form = await api('POST', wsPath(`/forms/${form.id}/publish`));
      renderStatus(); renderShare(); bindShare();
      mount($('#builder-notice'), notice('ok', html`<p>Published version ${form.published_version}. New responses use this version.</p>`));
    } catch (error) { reportError(error); }
  };
  const bindShare = () => {
    $$('#share [data-copy]').forEach(button => button.onclick = () => copy(button.dataset.copy));
    $('#share [data-copy-embed]')?.addEventListener('click', () => copy($('#embed').value, 'Embed code'));
    $('#unpublish')?.addEventListener('click', async () => {
      if (!(await ask({ title: 'Stop collecting responses?', body: 'The public link will show that the form is unavailable. Existing responses are kept.', confirm: 'Unpublish', danger: true }))) return;
      form = await api('POST', wsPath(`/forms/${form.id}/unpublish`));
      renderStatus(); renderShare();
    });
  };
  bindShare();
  renderRouting();
  async function renderRouting() {
    const eventTypes = await api('GET', wsPath('/event-types')).catch(() => []);
    const rules = (form.routing?.rules || []).map(rule => ({ ...rule, condition: { ...rule.condition }, action: { ...rule.action } }));
    let fallback = form.routing?.fallback ? { ...form.routing.fallback } : null;
    const actionEditor = (action, key) => html`<select data-akind="${key}" aria-label="Then">${[['event', 'Go to a booking page'], ['url', 'Go to a link'], ['message', 'Show a message']].map(([value, label]) => html`<option value="${value}" ${action?.type === value ? raw('selected') : ''}>${label}</option>`)}</select>
      ${action?.type === 'event' ? html`<select data-aevent="${key}" aria-label="Booking page">${eventTypes.filter(type => !type.managed_template).map(type => html`<option value="${type.id}" ${action.event_type_id === type.id ? raw('selected') : ''}>${type.title}</option>`)}</select>`
        : html`<input data-avalue="${key}" aria-label="${action?.type === 'url' ? 'Link' : 'Message'}" value="${action?.type === 'url' ? action.url || '' : action?.message || ''}" placeholder="${action?.type === 'url' ? 'https://…' : 'Thanks! We will be in touch.'}">`}`;
    const questions = draft.fields.filter(field => field.type !== 'page_break');
    const draw = () => mount($('#routing'), html`<details class="card card-plain" ${form.routing ? raw('open') : ''}><summary><strong>Route respondents</strong> <span class="muted">(lead routing)</span></summary>
      <p class="hint">After someone submits, send them to the right booking page based on their answers. Name and email answers pre-fill the booking form.</p>
      ${rules.map((rule, index) => html`<div class="range">If <select data-rfield="${index}" aria-label="Question">${questions.map(field => html`<option value="${field.id}" ${field.id === rule.condition.field ? raw('selected') : ''}>${field.label.slice(0, 40)}</option>`)}</select>
        <select data-rop="${index}" aria-label="Rule"><option value="equals" ${rule.condition.op === 'equals' ? raw('selected') : ''}>is</option><option value="not_equals" ${rule.condition.op === 'not_equals' ? raw('selected') : ''}>is not</option><option value="contains" ${rule.condition.op === 'contains' ? raw('selected') : ''}>includes</option></select>
        <input data-rvalue="${index}" aria-label="Value (option key)" value="${rule.condition.value || ''}" placeholder="option key"> then ${actionEditor(rule.action, index)}
        <button class="btn btn-small" type="button" data-rremove="${index}">Remove</button></div>`)}
      <div class="range">Otherwise ${fallback ? actionEditor(fallback, 'fallback') : html`<span class="muted">show the thank-you message</span>`} <button class="btn-link" type="button" id="toggle-fallback">${fallback ? 'Remove' : 'Set a default'}</button></div>
      <div class="actions"><button class="btn btn-small" type="button" id="add-rule">Add rule</button><button class="btn btn-small btn-primary" type="button" id="save-routing">Save routing</button>${form.routing ? html`<button class="btn btn-small" type="button" id="clear-routing">Turn off routing</button>` : ''}</div></details>`);
    const actionAt = key => key === 'fallback' ? fallback : rules[Number(key)].action;
    const setAction = (key, value) => { if (key === 'fallback') fallback = value; else rules[Number(key)].action = value; };
    draw();
    $('#routing').addEventListener('change', event => {
      const { rfield, rop, akind, aevent } = event.target.dataset;
      if (rfield !== undefined) rules[Number(rfield)].condition.field = event.target.value;
      if (rop !== undefined) rules[Number(rop)].condition.op = event.target.value;
      if (akind !== undefined) { setAction(akind, { type: event.target.value, event_type_id: eventTypes[0]?.id }); draw(); }
      if (aevent !== undefined) actionAt(aevent).event_type_id = event.target.value;
    });
    $('#routing').addEventListener('input', event => {
      const { rvalue, avalue } = event.target.dataset;
      if (rvalue !== undefined) rules[Number(rvalue)].condition.value = event.target.value;
      if (avalue !== undefined) { const action = actionAt(avalue); if (action.type === 'url') action.url = event.target.value; else action.message = event.target.value; }
    });
    $('#routing').addEventListener('click', async event => {
      if (event.target.dataset.rremove !== undefined) { rules.splice(Number(event.target.dataset.rremove), 1); draw(); }
      if (event.target.id === 'add-rule' && questions.length) { rules.push({ condition: { field: questions[0].id, op: 'equals', value: '' }, action: { type: 'event', event_type_id: eventTypes[0]?.id } }); draw(); }
      if (event.target.id === 'toggle-fallback') { fallback = fallback ? null : { type: 'message', message: '' }; draw(); }
      if (event.target.id === 'save-routing' || event.target.id === 'clear-routing') {
        try {
          form = await api('PUT', wsPath(`/forms/${form.id}/routing`), { routing: event.target.id === 'clear-routing' ? null : { rules, fallback } });
          toast(event.target.id === 'clear-routing' ? 'Routing turned off.' : 'Routing saved.');
          draw();
        } catch (error) { reportError(error); }
      }
    });
  }
  $('#delete-form').onclick = async () => {
    if (!(await ask({ title: 'Delete this form?', body: 'The form and all of its responses are permanently deleted.', confirm: 'Delete form and responses', danger: true }))) return;
    try { await api('DELETE', wsPath('/forms/' + form.id)); setDirty(false); toast('Form deleted.'); ctx.navigate('/forms', { replace: true }); }
    catch (error) { reportError(error); }
  };
}

// ---------------------------------------------------------------------------------------------
// Responses

export async function responses(ctx) {
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'forms', title: 'Sign in to see responses', lead: 'Responses are visible only to members of the form\'s workspace.' }));
  if (!needsSession(ctx)) return;
  mount(ctx.main, html`<div class="container page">${loading()}</div>`);
  let data;
  try { data = await api('GET', wsPath(`/forms/${ctx.params[0]}/responses`)); }
  catch (error) { return mount(ctx.main, html`<div class="container page">${errorBlock(error)}<a href="/forms">Back to Forms</a></div>`); }
  if (!ctx.alive()) return;
  const { form, versions } = data;
  let rows = data.responses;
  setTitle(`Responses: ${form.draft.title} · Forms by Schedora`);
  const latest = versions[form.published_version] || form.draft;
  const columns = latest.fields.filter(field => field.type !== 'page_break');
  const cell = (row, column) => {
    const definition = versions[row.form_version] || latest;
    const field = definition.fields.find(candidate => candidate.id === column.id) || column;
    return answerText(field, row.answers[column.id]);
  };
  const draw = () => mount($('#responses'), rows.length ? html`<div class="table-wrap"><table><caption class="visually-hidden">Responses to ${form.draft.title}</caption>
      <thead><tr><th scope="col">Submitted</th>${columns.map(column => html`<th scope="col">${column.label.replace(/\{\{.*?\}\}/g, '…').slice(0, 60)}</th>`)}${isAdmin() ? html`<th scope="col"><span class="visually-hidden">Actions</span></th>` : ''}</tr></thead>
      <tbody>${rows.map(row => html`<tr><td>${fmtDateTime(row.created_at)}<div class="muted">v${row.form_version}</div></td>${columns.map(column => html`<td>${cell(row, column) || html`<span class="muted">—</span>`}</td>`)}
        ${isAdmin() ? html`<td><button class="btn btn-small btn-danger" data-delete="${row.id}">Delete</button></td>` : ''}</tr>`)}</tbody></table></div>
      ${rows.length % 50 === 0 ? html`<div class="actions"><button class="btn" id="more">Load older responses</button></div>` : ''}`
    : html`<div class="empty"><h2>No responses yet</h2><p>${form.published_version ? 'Share the form link to start collecting responses.' : 'Publish the form to start collecting responses.'}</p></div>`);
  mount(ctx.main, html`<div class="container page"><a href="/forms/${form.id}">← Back to form</a>
    <div class="row-between"><h1>Responses</h1><a class="btn btn-primary" href="${wsPath(`/forms/${form.id}/responses.csv`)}" download>Export CSV</a></div>
    <p class="muted">${form.draft.title} · ${form.response_count} total · kept for ${workspace().retention_days || 365} days under your workspace retention setting.</p>
    <div id="responses"></div></div>`);
  draw();
  $('#responses').addEventListener('click', async event => {
    if (event.target.id === 'more') {
      const more = await api('GET', wsPath(`/forms/${form.id}/responses?before=${rows[rows.length - 1].created_at}`));
      rows = rows.concat(more.responses);
      return draw();
    }
    const id = event.target.dataset.delete;
    if (!id || !(await ask({ title: 'Delete this response?', body: 'It is removed permanently and will not appear in exports.', confirm: 'Delete response', danger: true }))) return;
    try { await api('DELETE', wsPath(`/forms/${form.id}/responses/${id}`)); rows = rows.filter(row => row.id !== id); draw(); toast('Response deleted.'); }
    catch (error) { toast(error.message); }
  });
}
