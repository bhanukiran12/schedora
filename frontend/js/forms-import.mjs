// Import JSON and Export form definition (docs/FORMS.md, "Import and export"). The browser only reads the
// file and shows what the server says: every check runs on the server, first to preview and again when
// the draft is created. Nothing is created until the author confirms the preview.
import { $, $$, api, html, mount, notice, workspace, wsPath } from './core.mjs';
import { EXAMPLE_DEFINITION_FILE, EXAMPLE_FILENAME } from './forms-definition-example.mjs';

const MAX_BYTES = 1024 * 1024;
const plural = (count, one, many = one + 's') => `${count.toLocaleString('en-US')} ${count === 1 ? one : many}`;

/** Saves text as a file on this device. */
export function saveFile(name, text, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const downloadExample = () => saveFile(EXAMPLE_FILENAME, JSON.stringify(EXAMPLE_DEFINITION_FILE, null, 2) + '\n');

/** Downloads a form's saved draft as a definition file. Throws with a message the page can show. */
export async function exportDefinition(form) {
  let response;
  try { response = await fetch(wsPath(`/forms/${form.id}/definition.json`), { credentials: 'same-origin', signal: AbortSignal.timeout(30000) }); }
  catch { throw new Error('Schedora could not be reached. Nothing was downloaded.'); }
  if (!response.ok) throw new Error(response.status === 404 || response.status === 403 ? 'You no longer have access to this form.' : 'The file could not be created. Nothing was downloaded.');
  const name = /filename="([^"]+)"/.exec(response.headers.get('content-disposition') || '')?.[1] || 'form.schedora-form.json';
  saveFile(name, await response.text());
}

const summaryFacts = summary => [
  plural(summary.question_count, 'question'),
  plural(summary.page_count, 'page'),
  `${summary.required_count.toLocaleString('en-US')} required`,
  summary.conditional_count ? plural(summary.conditional_count, 'conditional question') : null,
  summary.jump_count ? plural(summary.jump_count, 'jump rule') : null,
  summary.hide_rule_count ? plural(summary.hide_rule_count, 'hide-choice rule') : null,
  summary.ending_count ? plural(summary.ending_count, 'ending') : null,
  summary.url_param_count ? plural(summary.url_param_count, 'URL parameter') : null
].filter(Boolean);

const problemList = error => {
  const problems = error.details?.problems?.length ? error.details.problems : [error.message];
  const more = (error.details?.problem_count || problems.length) - problems.length;
  return html`<ol class="import-problems">${problems.map(problem => html`<li>${problem}</li>`)}</ol>${more > 0 ? html`<p class="hint">and ${plural(more, 'more problem')}. Fix these first, then check again.</p>` : ''}`;
};

/**
 * Opens the import dialog. onCreated(form) runs after the server creates the draft; the dialog closes
 * itself first. Focus returns to the opener when the dialog is dismissed.
 */
export function openImportDialog({ onCreated }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'card import-dialog';
  dialog.setAttribute('aria-labelledby', 'import-title');
  mount(dialog, html`<div class="row-between"><h2 id="import-title" tabindex="-1">Import JSON</h2><button class="btn btn-small" type="button" data-close>Close</button></div>
    <p class="hint">Creates an <strong>unpublished draft</strong> in <strong>${workspace()?.name || 'this workspace'}</strong>. Nothing is public until you publish. Files hold questions, pages, choices, ids, logic, descriptions and theme only; never responses, credentials or integrations.</p>
    <fieldset class="import-source"><legend class="visually-hidden">How to provide the file</legend>
      <div class="segmented" role="radiogroup" aria-label="Source">
        <label><input type="radio" name="import-source" value="file" checked> Upload a file</label>
        <label><input type="radio" name="import-source" value="paste"> Paste JSON</label>
      </div>
      <div data-source="file"><label class="import-drop" for="import-file"><strong class="btn btn-small">Choose a .json file</strong><span class="hint" id="import-file-hint">Or drop it here. Up to 1 MB.</span></label>
        <input type="file" id="import-file" class="visually-hidden" accept=".json,application/json" aria-describedby="import-file-hint import-file-name"><p class="import-file-name muted" id="import-file-name" aria-live="polite"></p></div>
      <div data-source="paste" hidden><label for="import-text">Form definition JSON</label>
        <textarea id="import-text" rows="10" spellcheck="false" autocomplete="off" placeholder='{ "title": "…", "fields": [ … ] }'></textarea></div>
    </fieldset>
    <p class="import-example"><button class="btn btn-link" type="button" data-example>Download an example file</button> <span class="muted">to see the supported format.</span></p>
    <div id="import-result" tabindex="-1"></div>
    <div class="actions"><button class="btn btn-primary" type="button" data-check>Check file</button><button class="btn" type="button" data-close>Cancel</button></div>`);
  const opener = document.activeElement;
  document.body.append(dialog);
  let source = '';
  let checked = null; // the text the current preview describes
  let busy = false;
  const result = $('#import-result', dialog);
  const actions = $('.actions', dialog);
  const mode = () => $('input[name="import-source"]:checked', dialog).value;

  const resetPreview = () => {
    checked = null;
    mount(result, '');
    mount(actions, html`<button class="btn btn-primary" type="button" data-check>Check file</button><button class="btn" type="button" data-close>Cancel</button>`);
  };
  const readFile = async file => {
    resetPreview();
    if (!file) { source = ''; $('#import-file-name', dialog).textContent = ''; return; }
    $('#import-file-name', dialog).textContent = `${file.name} · ${(file.size / 1024).toFixed(file.size < 10240 ? 1 : 0)} KB`;
    if (file.size > MAX_BYTES) { source = ''; mount(result, notice('bad', html`<p>${file.name} is over 1 MB. A form definition is much smaller; check that you chose the right file.</p>`)); return; }
    source = await file.text();
  };

  const check = async () => {
    if (busy) return;
    const text = mode() === 'paste' ? $('#import-text', dialog).value : source;
    if (!text.trim()) { mount(result, notice('bad', html`<p>${mode() === 'paste' ? 'Paste the JSON text first.' : 'Choose a .json file first.'}</p>`)); result.focus(); return; }
    busy = true;
    mount(result, html`<p class="muted" role="status">Checking the file…</p>`);
    try {
      const preview = await api('POST', wsPath('/forms/import-check'), { source: text }, {}, { timeout: 30000 });
      checked = text;
      const { summary, warnings } = preview;
      mount(result, html`<section class="import-preview" aria-labelledby="import-preview-title">
        <p class="tag">Ready to import</p><h3 id="import-preview-title">${summary.title}</h3>
        <p class="import-facts">${summaryFacts(summary).join(' · ')}</p>
        <p class="hint">${summary.presentation === 'conversational' ? 'One question at a time' : 'Classic layout'}${summary.theme ? ` · Theme: ${summary.theme}` : ''}</p>
        ${warnings.length ? html`<div class="notice notice-warn"><p><strong>${plural(warnings.length, 'thing')} to know</strong></p><ul>${warnings.map(warning => html`<li>${warning}</li>`)}</ul></div>` : ''}
      </section>`);
      mount(actions, html`<button class="btn btn-primary" type="button" data-create>Create draft</button><button class="btn" type="button" data-close>Cancel</button>`);
      result.focus();
    } catch (error) {
      mount(result, error.status === 400
        ? html`<div class="notice notice-bad" role="alert"><p><strong>This file can't be imported yet.</strong> Nothing was created.</p>${problemList(error)}</div>`
        : notice('bad', html`<p>${error.message} Nothing was created.</p>`));
      result.focus();
    } finally { busy = false; }
  };

  const create = async () => {
    if (busy || checked == null) return;
    busy = true;
    $$('[data-create]', dialog).forEach(button => { button.disabled = true; button.textContent = 'Creating draft…'; });
    try {
      const { form } = await api('POST', wsPath('/forms/import'), { source: checked }, {}, { timeout: 30000 });
      dialog.returnValue = 'created';
      dialog.close();
      onCreated(form);
    } catch (error) {
      mount(result, html`<div class="notice notice-bad" role="alert"><p><strong>The draft was not created.</strong></p>${error.status === 400 ? problemList(error) : html`<p>${error.message}</p>`}</div>`);
      $$('[data-create]', dialog).forEach(button => { button.disabled = false; button.textContent = 'Create draft'; });
      result.focus();
    } finally { busy = false; }
  };

  dialog.addEventListener('click', event => {
    if (event.target.closest('[data-close]')) dialog.close();
    else if (event.target.closest('[data-check]')) check();
    else if (event.target.closest('[data-create]')) create();
    else if (event.target.closest('[data-example]')) downloadExample();
  });
  dialog.addEventListener('change', event => {
    if (event.target.name === 'import-source') {
      $$('[data-source]', dialog).forEach(panel => { panel.hidden = panel.dataset.source !== event.target.value; });
      resetPreview();
      (event.target.value === 'paste' ? $('#import-text', dialog) : $('#import-file', dialog)).focus();
    } else if (event.target.id === 'import-file') readFile(event.target.files[0]);
  });
  $('#import-text', dialog).addEventListener('input', () => { if (checked != null) resetPreview(); });
  // A file dropped anywhere on the dialog is taken, so a near miss never makes the browser open the file
  // in place of the page. Dropping switches to the upload view first.
  const drop = $('.import-drop', dialog);
  const hasFiles = event => [...(event.dataTransfer?.types || [])].includes('Files');
  dialog.addEventListener('dragover', event => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; drop.classList.add('is-over'); });
  dialog.addEventListener('dragleave', event => { if (!dialog.contains(event.relatedTarget)) drop.classList.remove('is-over'); });
  dialog.addEventListener('drop', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    drop.classList.remove('is-over');
    const upload = $('input[name="import-source"][value="file"]', dialog);
    if (!upload.checked) { upload.checked = true; $$('[data-source]', dialog).forEach(panel => { panel.hidden = panel.dataset.source !== 'file'; }); }
    readFile(event.dataTransfer.files[0]);
  });
  dialog.addEventListener('close', () => { dialog.remove(); if (dialog.returnValue !== 'created') opener?.focus?.(); });
  dialog.showModal();
  $('#import-title', dialog).focus();
  return dialog;
}
