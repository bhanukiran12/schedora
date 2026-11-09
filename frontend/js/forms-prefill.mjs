// Share → Build prefilled link (docs/FORMS.md, "Prefilled links"). The author picks questions of the LIVE
// version, enters sample values, sees each value checked by the same rule as a typed answer, previews
// what a respondent would see and copies the link. Links use question keys, so renaming a label never
// breaks one. A prefilled answer is only a starting value the respondent can change: never identity.
import { $, $$, html, mount, notice } from './core.mjs';
import { FIELD_TYPES, prefillAnswers, prefilledLink, prefillProblem, prefillValue } from '/shared/forms-logic.mjs';
import { conditionSentence } from './forms-readiness.mjs';

const plural = (count, one, many = one + 's') => `${count} ${count === 1 ? one : many}`;

function valueControl(field, value) {
  const id = `pf-${field.id}`;
  const label = `Sample answer for ${field.label}`;
  if (field.type === 'single_choice') return html`<select id="${id}" data-prefill-value="${field.id}" aria-label="${label}"><option value="">Choose…</option>${field.options.map(option => html`<option value="${option.id}" ${value === option.id ? 'selected' : ''}>${option.label}</option>`)}</select>`;
  if (field.type === 'multiple_choice') return html`<fieldset class="prefill-choices" aria-label="${label}">${field.options.map(option => html`<label class="check"><input type="checkbox" data-prefill-value="${field.id}" value="${option.id}" ${Array.isArray(value) && value.includes(option.id) ? 'checked' : ''}> ${option.label}</label>`)}</fieldset>`;
  return html`<input id="${id}" data-prefill-value="${field.id}" type="${field.type === 'date' ? 'date' : 'text'}" maxlength="300" aria-label="${label}" value="${value || ''}" placeholder="${field.type === 'date' ? '' : 'Sample answer'}">`;
}

/**
 * Opens the builder. live: the published definition; draftDiffers: whether the saved draft has changes the
 * live form does not; baseUrl: the respondent link; renderForm: the shared renderer, for the preview.
 */
export function openPrefillBuilder({ live, version, draftDiffers, baseUrl, renderForm, copy }) {
  const values = Object.create(null); // question key -> sample value, for questions the author included
  const dialog = document.createElement('dialog');
  dialog.className = 'card prefill-dialog';
  dialog.setAttribute('aria-labelledby', 'prefill-title');
  const questions = live.fields.filter(field => field.type !== 'page_break');
  const page = Object.fromEntries(live.fields.filter(field => field.type === 'page_break' && field.grouped).map(field => [field.id, field.label]));
  const row = field => {
    const problem = prefillProblem(field);
    const when = field.show_if ? conditionSentence(field.show_if, live.fields) : '';
    const facts = html`<span class="prefill-key"><code>${field.id}</code><button class="btn btn-link btn-small" type="button" data-copy-key="${field.id}">Copy ID<span class="visually-hidden"> of ${field.label}</span></button></span>
      <span class="muted">${FIELD_TYPES[field.type]}${field.group ? ` · on the page “${page[field.group] || 'Untitled page'}”` : ''}${when ? ` · shown only ${when}` : ''}</span>`;
    if (problem) return html`<li class="prefill-row is-blocked" data-prefill-row="${field.id}"><div class="prefill-head"><span class="prefill-label">${field.label}</span>${facts}</div><p class="hint prefill-reason">Not available: ${problem}</p></li>`;
    return html`<li class="prefill-row" data-prefill-row="${field.id}"><div class="prefill-head"><label class="check prefill-label"><input type="checkbox" data-prefill-include="${field.id}"> ${field.label}</label>${facts}</div>
      <div class="prefill-value" hidden>${valueControl(field)}<p class="field-error" id="pf-${field.id}-error" hidden></p></div></li>`;
  };
  const allowed = questions.filter(field => !prefillProblem(field)).length;
  mount(dialog, html`<div class="row-between"><h2 id="prefill-title" tabindex="-1">Build a prefilled link</h2><button class="btn btn-small" type="button" data-close>Close</button></div>
    <p class="hint">Pick questions and enter answers respondents start with, such as their programme or batch. They can change every answer before submitting. Anyone can edit a link, so a prefilled value never proves who someone is. Respondents always see the form's questions; nothing is hidden.</p>
    ${draftDiffers ? notice('warn', html`<p>This link uses the <strong>live version ${version}</strong>. Your draft has changes that are not published; questions that exist only in the draft cannot be prefilled until you publish.</p>`) : ''}
    <p class="hint">${plural(allowed, 'question')} of ${questions.length} can be prefilled. Contact details, long answers and personal identifiers such as student IDs are never put in links.</p>
    <ol class="prefill-list">${questions.map(row)}</ol>
    <section class="prefill-output" aria-labelledby="prefill-link-label">
      <label id="prefill-link-label" for="prefill-link">Prefilled link</label>
      <p class="hint" id="prefill-summary" role="status">Pick a question to start.</p>
      <textarea id="prefill-link" class="embed-code" rows="3" readonly>${baseUrl}</textarea>
      <div class="actions"><button class="btn btn-primary" type="button" data-copy-link>Copy link</button><button class="btn" type="button" data-preview>Preview as a respondent</button><a class="btn" id="prefill-open" href="${baseUrl}" target="_blank" rel="noopener">Open in a new tab<span class="visually-hidden"> (opens in a new tab)</span></a></div>
      <p class="copy-status" id="prefill-status" role="status"></p>
    </section>
    <section class="prefill-preview" id="prefill-preview" aria-label="Respondent preview" hidden></section>`);
  const opener = document.activeElement;
  document.body.append(dialog);

  const readValue = id => {
    const inputs = $$(`[data-prefill-value="${id}"]`, dialog);
    return inputs[0]?.type === 'checkbox' ? inputs.filter(input => input.checked).map(input => input.value) : inputs[0]?.value ?? '';
  };
  const link = () => prefilledLink(baseUrl, live, values);
  const refresh = () => {
    let valid = 0, invalid = 0;
    for (const field of questions) {
      if (!Object.hasOwn(values, field.id)) continue;
      const result = prefillValue(field, values[field.id]);
      const error = $(`#pf-${field.id}-error`, dialog);
      const empty = (Array.isArray(values[field.id]) ? values[field.id].length : String(values[field.id]).trim()) === 0;
      error.hidden = !result.error || empty;
      error.textContent = result.error && !empty ? `Not included: ${result.error}` : '';
      $$(`[data-prefill-value="${field.id}"]`, dialog).forEach(input => input.setAttribute('aria-invalid', String(Boolean(result.error) && !empty)));
      if (result.error) { if (!empty) invalid++; } else valid++;
    }
    const url = link();
    $('#prefill-link', dialog).value = url;
    $('#prefill-open', dialog).href = url;
    $('#prefill-summary', dialog).textContent = valid || invalid ? `${valid ? `${plural(valid, 'answer')} will be filled in.` : 'No answers are filled in yet.'}${invalid ? ` ${plural(invalid, 'value')} not valid and left out.` : ''}` : 'Pick a question to start.';
    if (!$('#prefill-preview', dialog).hidden) preview();
  };
  // The preview reads the link exactly as the respondent page does, so it shows what they will get.
  const preview = () => {
    const section = $('#prefill-preview', dialog);
    section.hidden = false;
    const { answers } = prefillAnswers(live, new URL(link()).searchParams);
    mount(section, html`<h3>Respondent preview</h3><p class="hint">Filled from the link above, the way a respondent opens it. Nothing is saved or sent.</p><div class="prefill-preview-form"></div>`);
    renderForm($('.prefill-preview-form', section), live, { preview: true, answers });
  };

  dialog.addEventListener('change', event => {
    const include = event.target.dataset.prefillInclude;
    if (include) {
      const box = event.target.closest('.prefill-row').querySelector('.prefill-value');
      box.hidden = !event.target.checked;
      if (event.target.checked) { values[include] = readValue(include); box.querySelector('input, select')?.focus(); }
      else delete values[include];
      return refresh();
    }
    const id = event.target.dataset.prefillValue;
    if (id && Object.hasOwn(values, id)) { values[id] = readValue(id); refresh(); }
  });
  dialog.addEventListener('input', event => {
    const id = event.target.dataset.prefillValue;
    if (id && Object.hasOwn(values, id) && event.target.type !== 'checkbox') { values[id] = readValue(id); refresh(); }
  });
  dialog.addEventListener('click', async event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.dataset.close !== undefined) dialog.close();
    else if (target.dataset.preview !== undefined) { preview(); $('#prefill-preview h3', dialog).scrollIntoView({ block: 'nearest' }); }
    else if (target.dataset.copyLink !== undefined) $('#prefill-status', dialog).textContent = await copy($('#prefill-link', dialog), 'Prefilled link');
    else if (target.dataset.copyKey) $('#prefill-status', dialog).textContent = await copy({ value: target.dataset.copyKey }, `Question ID “${target.dataset.copyKey}”`);
  });
  dialog.addEventListener('close', () => { dialog.remove(); opener?.focus?.(); });
  dialog.showModal();
  $('#prefill-title', dialog).focus();
  return dialog;
}

