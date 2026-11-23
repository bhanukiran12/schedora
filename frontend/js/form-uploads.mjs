import { $, $$, api, html, mount, boot, ApiError } from './core.mjs';
import { FILE_LIMITS } from '/shared/forms-logic.mjs';

// Files and grant secrets stay in this page's memory. The form's saved answers hold file ids only.
export function formUploads(form, submissionId, { editKey = null, existing = {} } = {}) {
  const entries = new Map(Object.entries(existing).filter(([field, value]) => form.definition.fields.some(item => item.id === field && item.type === 'file_upload') && Array.isArray(value)).map(([field, value]) => [field, value.map(file => ({ value: file, file: null, status: 'ready', existing: true, grant: null }))]));
  const base = `/api/public/forms/${encodeURIComponent(form.slug)}/uploads`;
  let notify = () => {};
  let root;
  const list = field => entries.get(field) || [];
  const values = field => list(field).filter(item => item.status === 'ready').map(item => item.value);
  const busy = () => [...entries.values()].some(items => items.some(item => item.status === 'uploading' || item.status === 'removing'));
  const headers = item => ({ Authorization: 'Bearer ' + item.grant.token });
  const blocked = () => busy() || [...entries.values()].some(items => items.some(item => item.status === 'failed'));
  const changed = field => notify(field, values(field));

  async function remove(field, item) {
    item.status = 'removing';
    changed(field);
    try {
      if (item.grant) await api('DELETE', `${base}/${item.grant.id}`, undefined, headers(item));
      entries.set(field, list(field).filter(other => other !== item));
    } catch (error) {
      if (error.status === 404) entries.set(field, list(field).filter(other => other !== item));
      else { item.status = 'failed'; item.error = error.message; }
    }
    changed(field);
  }

  async function send(field, item) {
    item.status = 'uploading';
    item.error = '';
    changed(field);
    try {
      // A lost upload reply may still have stored the file. Recover that object before issuing another.
      if (item.grant) {
        let state;
        try { state = await api('POST', `${base}/${item.grant.id}/status`, undefined, headers(item)); }
        catch (error) { if (error.status !== 404) throw error; item.grant = null; }
        if (state) {
          if (state.file) { item.value = state.file; item.status = 'ready'; return; }
          if (state.status === 'receiving') throw new ApiError(409, { message: 'This file is still being processed. Wait, then retry.' });
          if (state.status !== 'issued' || item.grant.expires_at <= Date.now()) {
            await api('DELETE', `${base}/${item.grant.id}`, undefined, headers(item));
            item.grant = null;
          }
        }
      }
      if (!item.grant) item.grant = await api('POST', base, {
        version: form.version, submission_id: submissionId, field_id: field, filename: item.file.name, bytes: item.file.size, ...(editKey ? { edit_key: editKey } : {})
      });
      let response;
      try {
        response = await fetch(`${base}/${item.grant.id}`, {
          method: 'PUT', credentials: 'same-origin', headers: { ...headers(item), 'Content-Type': 'application/octet-stream' },
          body: item.file, signal: AbortSignal.timeout(30000)
        });
      } catch { throw new ApiError(0, { message: 'The upload could not be confirmed. Retry to check its status.' }); }
      const result = await response.json();
      if (!response.ok) throw new ApiError(response.status, result.error);
      if (!result.file) throw new ApiError(0, { message: 'The upload could not be confirmed. Retry to check its status.' });
      item.value = result.file;
      item.status = 'ready';
    } catch (error) {
      item.status = 'failed';
      item.error = error.message || 'The upload could not be confirmed. Retry or remove this file.';
      if (error.status === 404) item.grant = null;
    } finally { changed(field); }
  }

  function mountControls(formRoot, answers, onChange) {
    root = formRoot;
    notify = onChange;
    root.querySelector('[type=submit]').disabled = blocked();
    for (const question of $$('[data-file-question]', root)) {
      const field = question.dataset.fileQuestion;
      const input = $('[data-file-input]', question);
      const status = $('[data-file-status]', question);
      const items = list(field);
      if (!items.length && answers[field]?.length) {
        answers[field] = [];
        question.querySelector('input[type=hidden]').value = '[]';
      }
      input.disabled = !boot.formUploads || items.length >= FILE_LIMITS.count || busy();
      status.textContent = !boot.formUploads ? 'File uploads are not connected on this server.'
        : busy() ? 'Uploading and checking files. Wait before submitting.'
          : 'Uploaded files are sent with your response when you submit.';
      status.setAttribute('role', 'status');
      mount($('[data-file-list]', question), html`<ul class="form-file-list">${items.map((item, index) => html`<li data-file-state="${item.status}">
        <span>${item.value?.name || item.file.name}<small>${item.status === 'ready' ? 'Uploaded' : item.status === 'failed' ? item.error : item.status === 'removing' ? 'Removing…' : 'Uploading and checking…'}</small></span>
        ${item.status === 'failed' ? html`<button type="button" class="btn btn-small" data-file-retry="${index}">Retry</button>` : ''}
        <button type="button" class="btn btn-small" data-file-remove="${index}" ${item.status === 'uploading' || item.status === 'removing' ? 'disabled' : ''}>Remove<span class="visually-hidden"> ${item.value?.name || item.file.name}</span></button>
      </li>`)}</ul>`);
      input.onchange = async () => {
        const files = [...input.files];
        if (files.length + list(field).length > FILE_LIMITS.count) {
          status.textContent = 'Choose up to two files. Remove an existing file to replace it.';
          input.value = '';
          return;
        }
        if (files.some(file => file.size < 1 || file.size > FILE_LIMITS.bytes)) {
          status.textContent = 'Each file must be between 1 byte and 2 MB.';
          input.value = '';
          return;
        }
        const added = files.map(file => ({ file, status: 'uploading', grant: null }));
        entries.set(field, [...list(field), ...added]);
        for (const item of added) await send(field, item);
      };
      question.onclick = event => {
        const button = event.target.closest('[data-file-retry], [data-file-remove]');
        if (!button) return;
        const retry = button.dataset.fileRetry;
        const item = list(field)[Number(retry ?? button.dataset.fileRemove)];
        if (!item || busy()) return;
        if (retry != null) send(field, item); else remove(field, item);
      };
    }
  }
  return { mount: mountControls, busy, blocked };
}
