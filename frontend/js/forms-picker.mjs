// "Choose a starting point": Blank form, Import JSON and the goal templates. `/forms` and the guided
// setup at `/setup/forms` mount this same picker, so both create the same unpublished draft through the
// same server routes. The workspace is fixed when the picker is mounted: switching workspace in another
// tab never moves a draft that is being created here.
import { $, $$, api, html, mount, notice, session } from './core.mjs';
import { FORM_TEMPLATES, questionCount } from './forms-templates.mjs';
import { openImportDialog } from './forms-import.mjs';
import { withEvaluationPolicy } from '/shared/forms-logic.mjs';

export const BLANK_TEMPLATE = { id: 'blank', name: 'Blank form', purpose: 'Start from a short starter with name, email and one choice question to replace with your own.',
  definition: { presentation: 'classic', fields: [{ label: 'Your name' }, { label: 'Email address' }, { label: 'Your first question' }] } };
const presentationName = definition => definition.presentation === 'conversational' ? 'one question at a time' : 'classic layout';

/** What the builder's "Draft created …" notice says for a `?created=` source. */
export function createdSource(created) {
  if (created === 'import') return 'from your JSON file';
  if (created === 'duplicate') return 'as a copy';
  if (created === 'blank') return 'from a blank form';
  const template = FORM_TEMPLATES.find(item => item.id === created);
  return template ? `from the “${template.name}” template` : '';
}

/** The builder address for a new draft: carries where it came from and which workspace owns it. */
export function draftAddress(form, { created, workspaceId, from } = {}) {
  const query = new URLSearchParams();
  if (created) query.set('created', created);
  if (from) query.set('from', from);
  if (workspaceId) query.set('ws', workspaceId);
  const search = query.toString();
  return `/forms/${form.id}${search ? '?' + search : ''}`;
}

// A card shows who the template is for, what it collects and how its logic behaves; a small
// sketch of its first questions stands in for a thumbnail.
const templateCard = template => {
  const blank = template === BLANK_TEMPLATE;
  const sketch = template.definition.fields.filter(field => field.type !== 'page_break' && !field.show_if).slice(0, 3);
  return html`<li class="template-card"><div class="template-sketch" aria-hidden="true">${sketch.map(field => html`<span>${field.label}</span>`)}</div>
    ${template.audience ? html`<p class="template-audience">${template.audience}</p>` : ''}<h3>${template.name}</h3><p>${template.purpose}</p>
    <p class="template-meta">${blank ? 3 : questionCount(template.definition)} questions · ${presentationName(template.definition)}</p>${template.logic ? html`<p class="template-logic">${template.logic}</p>` : ''}
    <div class="template-actions">${blank ? '' : html`<button class="btn btn-small" type="button" data-preview-template="${template.id}">Preview<span class="visually-hidden"> ${template.name}</span></button>`}
      <button class="btn btn-small btn-primary" type="button" data-template="${template.id}">Create draft<span class="visually-hidden"> from ${blank ? 'a blank form' : template.name}</span></button></div></li>`;
};

// Import JSON sits beside Blank form: same outcome (an unpublished draft), different source.
const importCard = () => html`<li class="template-card template-card-import"><div class="template-icon" aria-hidden="true">{ … }</div>
  <h3>Import JSON</h3><p>Upload or paste a Schedora form definition, such as one exported from another form. You see what it contains before anything is created.</p>
  <p class="template-meta">Questions, pages, logic and theme · never responses</p>
  <div class="template-actions"><button class="btn btn-small btn-primary" type="button" data-import>Import JSON<span class="visually-hidden"> file as a new draft</span></button></div></li>`;

// Try a template's questions and logic before creating anything. The preview renderer never calls
// the server, so nothing is saved, sent or counted.
async function previewTemplate(template, create) {
  const { renderForm } = await import('./forms.mjs');
  const dialog = document.createElement('dialog');
  dialog.className = 'card template-preview';
  dialog.setAttribute('aria-labelledby', 'template-preview-title');
  mount(dialog, html`<div class="row-between"><h2 id="template-preview-title" tabindex="-1">Preview: ${template.name}</h2><button class="btn btn-small" type="button" data-close>Close</button></div>
    <p class="hint">Try the questions and logic. Nothing is saved or sent, and no draft exists until you create one.</p>
    <div class="template-preview-form"></div>
    <div class="actions"><button class="btn btn-primary" type="button" data-use>Create draft from this template</button><button class="btn" type="button" data-close>Close</button></div>`);
  const opener = document.activeElement;
  document.body.append(dialog);
  renderForm($('.template-preview-form', dialog), withEvaluationPolicy(template.definition), { preview: true });
  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-close]')) dialog.close();
    else if (event.target.closest('[data-use]')) { dialog.returnValue = 'use'; dialog.close(); }
  });
  dialog.addEventListener('close', () => { const use = dialog.returnValue === 'use'; dialog.remove(); opener?.focus?.(); if (use) create(template.id); });
  dialog.showModal();
  $('#template-preview-title', dialog).focus();
}

/**
 * Mounts the picker into `container`.
 * - onCreated(form, created) runs once the server has created the draft; `created` is 'blank',
 *   'import' or a template id.
 * - cancel: { label, onCancel } adds a way out beside the heading; nothing is created by it.
 * - heading and lead replace the default heading and add a sentence before the standard one.
 * Returns { focus() } to move focus to the heading.
 */
export function mountStartingPoints(container, { onCreated, cancel = null, heading = 'Choose a starting point', lead = '' } = {}) {
  const workspaceId = session.workspaceId;
  const workspaceName = session.workspaces.find(item => item.id === workspaceId)?.name || 'this workspace';
  mount(container, html`<section class="form-templates" aria-labelledby="templates-heading">
      <div class="row-between form-templates-head"><h2 id="templates-heading" tabindex="-1">${heading}</h2>
        ${cancel ? html`<button class="btn btn-small" type="button" data-picker-cancel>${cancel.label}</button>` : ''}</div>
      <p class="muted">${lead ? lead + ' ' : ''}Each option creates an <strong>unpublished draft</strong> in <strong>${workspaceName}</strong>. Edit any question, preview it, then publish when you are ready. Nothing is public until you publish.</p>
      <h3 class="template-group">Start your own</h3>
      <ul class="template-grid">${templateCard(BLANK_TEMPLATE)}${importCard()}</ul>
      <h3 class="template-group">For sales and client meetings</h3>
      <ul class="template-grid">${FORM_TEMPLATES.filter(template => template.group === 'meetings').map(templateCard)}</ul>
      <h3 class="template-group">More starting points</h3>
      <ul class="template-grid">${FORM_TEMPLATES.filter(template => template.group !== 'meetings').map(templateCard)}</ul>
      <div id="template-status" role="status"></div></section>`);
  const status = $('#template-status', container);
  let busy = false;
  const fail = message => { mount(status, notice('bad', html`<p>${message}</p>`)); status.scrollIntoView({ block: 'nearest' }); };
  // The draft exists once the server answers; a later failure (say, saving setup progress) must say so.
  const afterCreate = async (form, created) => {
    try { await onCreated(form, created, workspaceId); }
    catch (error) { fail(html`The draft “${form.draft?.title || 'Untitled form'}” was created, but ${error.message} <a href="${draftAddress(form, { workspaceId })}">Open the draft</a>`); }
  };
  // Creating a draft is the explicit action here; publishing stays a separate step in the builder.
  const create = async id => {
    if (busy) return;
    const template = FORM_TEMPLATES.find(item => item.id === id);
    busy = true;
    $$('[data-template], [data-import]', container).forEach(item => item.setAttribute('aria-disabled', 'true'));
    mount(status, html`<p class="muted">Creating draft…</p>`);
    let form = null;
    try { form = await api('POST', `/api/workspaces/${encodeURIComponent(workspaceId)}/forms`, template ? { definition: template.definition } : { title: 'Untitled form' }); }
    catch (error) { fail(`The draft was not created. ${error.message}`); }
    try { if (form) await afterCreate(form, template ? template.id : 'blank'); }
    finally {
      busy = false;
      $$('[data-template], [data-import]', container).forEach(item => item.removeAttribute('aria-disabled'));
    }
  };
  container.addEventListener('click', event => {
    if (event.target.closest('[data-picker-cancel]')) return cancel.onCancel();
    if (busy) return;
    if (event.target.closest('[data-import]')) return openImportDialog({ workspaceId, onCreated: form => afterCreate(form, 'import') });
    const use = event.target.closest('[data-template]');
    if (use) return create(use.dataset.template);
    const preview = event.target.closest('[data-preview-template]');
    if (preview) previewTemplate(FORM_TEMPLATES.find(item => item.id === preview.dataset.previewTemplate), create);
  });
  return { focus: () => $('#templates-heading', container).focus() };
}
