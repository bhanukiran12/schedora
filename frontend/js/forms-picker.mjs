// "Choose a starting point": Blank form, Import JSON and the goal templates. `/forms` and the guided
// setup at `/setup` mounts this same picker when it reaches Forms, so both create the same unpublished draft through the
// same server routes. The workspace is fixed when the picker is mounted: switching workspace in another
// tab never moves a draft that is being created here.
import { $, $$, api, html, mount, notice, session } from './core.mjs';
import { formIcon } from './forms-icons.mjs';
import { openImportDialog } from './forms-import.mjs';

export const BLANK_TEMPLATE = { id: 'blank', name: 'Simple contact form', purpose: 'Start with name, email, what they need, and a follow-up question. Change or remove any question.',
  definition: { presentation: 'classic', fields: [{ label: 'What is your name?' }, { label: 'Email address' }, { label: 'What can we help with?' }, { label: 'Tell us a little more' }] } };
const presentationName = definition => definition.presentation === 'conversational' ? 'one question at a time' : 'classic layout';

/** What the builder's "Draft created …" notice says for a `?created=` source. */
export function createdSource(created) {
  if (created === 'import') return 'from your JSON file';
  if (created === 'duplicate') return 'as a copy';
  if (created === 'blank') return 'from a blank form';
  return '';
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

const importCard = () => html`<li class="template-card template-card-import">
  <div class="template-import-preview" aria-hidden="true"><span class="template-import-file">${formIcon('file_code')}</span><span class="template-import-lines"><i></i><i></i><i></i></span><span class="template-import-check">${formIcon('check')}</span></div>
  <div class="template-card-title"><span class="template-card-icon template-card-icon--import" aria-hidden="true">${formIcon('file_code')}</span><h3>Import JSON</h3></div><p>Bring in a form definition from a file or pasted JSON. Review it before creating a private draft.</p>
  <p class="template-meta">Questions, pages, logic and design are included. Responses and credentials are not.</p>
  <div class="template-actions"><button class="btn btn-small btn-primary" type="button" data-import>${formIcon('file_code')}Import JSON<span class="visually-hidden"> file as a new draft</span></button></div></li>`;

/**
 * Mounts the picker into `container`.
 * - onCreated(form, created) runs once the server has created the draft; `created` is 'blank',
 *   'import' or a template id.
 * - cancel: { label, onCancel } adds a way out beside the heading; nothing is created by it.
 * - heading and lead replace the default heading and add a sentence before the standard one.
 * Returns { focus() } to move focus to the heading.
 */
export function mountStartingPoints(container, { onCreated, cancel = null, heading = 'Create a form', lead = '' } = {}) {
  const workspaceId = session.workspaceId;
  const workspaceName = session.workspaces.find(item => item.id === workspaceId)?.name || 'this workspace';
  mount(container, html`<section class="form-templates" aria-labelledby="templates-heading">
      <div class="row-between form-templates-head"><h2 id="templates-heading" tabindex="-1">${heading}</h2>
        ${cancel ? html`<button class="btn btn-small" type="button" data-picker-cancel>${cancel.label}</button>` : ''}</div>
      <p class="muted">${lead ? lead + ' ' : ''}Start with a simple form or import a definition. Your form stays private until you publish it in <strong>${workspaceName}</strong>.</p>
      <h3 class="template-group">Choose how to begin</h3>
      <ul class="template-grid template-grid--starting">${html`<li class="template-card template-card--blank"><div class="template-sketch" aria-hidden="true">${BLANK_TEMPLATE.definition.fields.slice(0, 3).map(field => html`<span>${field.label}</span>`)}</div>
        <div class="template-card-title"><span class="template-card-icon" aria-hidden="true">${formIcon('contact_info')}</span><h3>${BLANK_TEMPLATE.name}</h3></div><p>${BLANK_TEMPLATE.purpose}</p>
        <p class="template-meta">${BLANK_TEMPLATE.definition.fields.length} questions · ${presentationName(BLANK_TEMPLATE.definition)}</p><div class="template-actions"><button class="btn btn-small btn-primary" type="button" data-template="blank">Start with this form</button></div></li>`}${importCard()}</ul>
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
    const template = id === 'blank' ? BLANK_TEMPLATE : null;
    busy = true;
    $$('[data-template], [data-import]', container).forEach(item => item.setAttribute('aria-disabled', 'true'));
    mount(status, html`<p class="muted">Creating your form…</p>`);
    let form = null;
    try { form = await api('POST', `/api/workspaces/${encodeURIComponent(workspaceId)}/forms`, template ? { definition: template.definition } : { title: 'Untitled form' }); }
    catch (error) { fail(`Your form was not created. ${error.message}`); }
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
  });
  return { focus: () => $('#templates-heading', container).focus() };
}
