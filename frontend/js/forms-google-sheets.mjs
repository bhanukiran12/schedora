import { $, api, ask, fmtDateTime, html, loading, mount, notice, raw, toast, wsPath } from './core.mjs';

// One-way Google Sheets sync panel on a form's Responses page (backend/src/forms/google-sheets.mjs).
// Every state shown here comes from the server; nothing is written to Google from the browser.

const STATUS = {
  backfilling: ['warn', 'Copying existing responses'], active: ['ok', 'Syncing'], paused: ['neutral', 'Paused'],
  error: ['bad', 'Stopped: needs attention'], reconnect_required: ['bad', 'Reconnect needed'], disconnected: ['neutral', 'Disconnected']
};
const pill = ([kind, label]) => html`<span class="badge badge-${kind}">${label}</span>`;

export function sheetsSyncSection(open) {
  return html`<details class="card card-plain google-sheets-sync" id="google-sheets-sync" ${open ? raw('open') : ''}><summary><strong>Google Sheets sync</strong> <span class="muted" id="google-sheets-summary"></span></summary><div id="google-sheets-body">${loading('Checking Google Sheets…')}</div></details>`;
}

export async function mountSheetsSync(ctx, form) {
  const body = $('#google-sheets-body');
  const summary = $('#google-sheets-summary');
  if (!body) return;
  const base = wsPath(`/forms/${form.id}/google-sheets`);
  const returned = ctx.query.get('sheets');
  const returnMessage = ctx.query.get('message');
  let flash = returned === 'connected' ? notice('ok', html`<p>Google Sheets connected. Choose where responses go.</p>`)
    : returned === 'not_connected' ? notice('bad', html`<p>${returnMessage || 'Google Sheets was not connected.'}</p>`) : '';

  const render = async () => {
    let state;
    try { state = await api('GET', base); }
    catch (error) { return mount(body, notice('bad', html`<p>${error.message}</p>`)); }
    if (!ctx.alive()) return;
    const { sync, connection } = state;
    summary.textContent = sync ? `· ${STATUS[sync.status]?.[1] || sync.status}` : !state.available ? '· not available on this server' : connection ? '· connected, not syncing' : '· off';
    const intro = html`<p class="hint">Copies every response to a tab in Google Sheets and keeps it updated: edited answers and payment changes update their row; deleted responses are blanked. It is one-way: changes made in Google are not read back and are overwritten when that response next changes.</p>`;
    if (!state.available) return mount(body, html`${intro}${notice('info', html`<p><strong>Not available on this server.</strong> An administrator must enable Google Sheets sync and its Google sign-in before anyone can connect.</p>`)}`);
    if (sync) {
      mount(body, html`${flash}${intro}<p>${pill(STATUS[sync.status] || ['neutral', sync.status])}</p>
        <dl class="confirm-facts"><dt>Spreadsheet</dt><dd><a href="${sync.spreadsheet.url}" target="_blank" rel="noopener noreferrer" data-external>${sync.spreadsheet.title}</a> · tab “${sync.tab}”</dd>
          <dt>Rows synced</dt><dd>${sync.synced_rows}${sync.pending_rows ? ` · ${sync.pending_rows} waiting` : ''}</dd>
          <dt>Last synced</dt><dd>${sync.last_synced_at ? fmtDateTime(sync.last_synced_at) : 'Not yet'}</dd>
          <dt>Set up by</dt><dd>${sync.owner.yours ? 'You' : sync.owner.name}</dd></dl>
        ${sync.last_error ? notice(sync.status === 'active' || sync.status === 'backfilling' ? 'warn' : 'bad', html`<p>${sync.last_error}${sync.status === 'active' || sync.status === 'backfilling' ? ` Next try ${fmtDateTime(sync.next_attempt_at)}.` : ''}</p>`) : ''}
        <div class="actions">
          ${sync.status === 'reconnect_required' || sync.status === 'disconnected' ? (sync.owner.yours ? html`<button class="btn btn-primary btn-small" type="button" data-sheets="connect">Reconnect Google Sheets</button>` : html`<p class="hint">Only ${sync.owner.name} can reconnect this sync. Otherwise stop it and set up your own.</p>`) : ''}
          ${['active', 'backfilling'].includes(sync.status) ? html`<button class="btn btn-small" type="button" data-sheets="retry">Sync now</button><button class="btn btn-small" type="button" data-sheets="pause">Pause</button>` : ''}
          ${sync.status === 'paused' || sync.status === 'error' ? html`<button class="btn btn-small" type="button" data-sheets="resume">${sync.status === 'error' ? 'Try again' : 'Resume'}</button>` : ''}
          ${sync.can_stop ? html`<button class="btn btn-danger btn-small" type="button" data-sheets="stop">Stop syncing</button>` : ''}
        </div>
        ${connection && sync.owner.yours ? html`<p class="hint">Connected as ${connection.account || 'your Google account'} with access only to files Schedora creates or you choose. <button class="btn btn-link btn-small" type="button" data-sheets="disconnect">Disconnect Google Sheets</button></p>` : ''}`);
    } else if (!connection || connection.status === 'revoked') {
      mount(body, html`${flash}${intro}<p class="hint">Connecting asks Google for permission to create and edit only the spreadsheets Schedora makes or you choose for it. It does not change your calendar connection or give access to your other Drive files.</p>
        <div class="actions"><button class="btn btn-primary btn-small" type="button" data-sheets="connect">${connection ? 'Reconnect Google Sheets' : 'Connect Google Sheets'}</button></div>`);
    } else {
      mount(body, html`${flash}${intro}<p>Connected as <strong>${connection.account || 'your Google account'}</strong>.</p>
        <fieldset><legend class="label">Send responses to</legend>
          <label class="check"><input type="radio" name="sheets-destination" value="new" checked> A new spreadsheet</label>
          <label class="check"><input type="radio" name="sheets-destination" value="existing"> A new tab in a spreadsheet Schedora can open</label></fieldset>
        <div id="sheets-existing" hidden></div>
        <div class="actions"><button class="btn btn-primary btn-small" type="button" data-sheets="create">Start syncing</button><button class="btn btn-link btn-small" type="button" data-sheets="disconnect">Disconnect Google Sheets</button></div>
        <p class="hint">Existing responses are copied first, then new and changed responses follow within about a minute.</p>`);
    }
    flash = '';
  };

  const loadExisting = async () => {
    const area = $('#sheets-existing');
    area.hidden = false;
    mount(area, loading('Finding spreadsheets…'));
    try {
      const { spreadsheets } = await api('GET', wsPath('/google-sheets/destinations'));
      mount(area, spreadsheets.length ? html`<label for="sheets-spreadsheet">Spreadsheet</label><select id="sheets-spreadsheet">${spreadsheets.map(item => html`<option value="${item.id}">${item.title}</option>`)}</select><p class="hint">Only spreadsheets Schedora created with this connection appear. Schedora adds a new tab and never changes your other tabs.</p>`
        : html`<p class="hint">No spreadsheets are available to this connection yet. Choose “A new spreadsheet”.</p>`);
    } catch (error) { mount(area, notice('bad', html`<p>${error.message}</p>`)); }
  };

  body.addEventListener('change', event => {
    if (event.target.name !== 'sheets-destination') return;
    if (event.target.value === 'existing') loadExisting(); else { const area = $('#sheets-existing'); area.hidden = true; }
  });
  body.addEventListener('click', async event => {
    const button = event.target.closest('[data-sheets]');
    if (!button) return;
    const action = button.dataset.sheets;
    button.disabled = true;
    try {
      if (action === 'connect') { const { url } = await api('POST', base + '/connect'); location.assign(url); return; }
      if (action === 'create') {
        const existing = body.querySelector('input[name="sheets-destination"]:checked')?.value === 'existing';
        const spreadsheet = $('#sheets-spreadsheet')?.value;
        if (existing && !spreadsheet) { toast('Choose a spreadsheet, or a new one.'); return; }
        await api('POST', base, existing ? { spreadsheet_id: spreadsheet } : { destination: 'new' });
        toast('Sync set up. Existing responses are being copied.');
      } else if (action === 'stop') {
        if (!(await ask({ title: 'Stop syncing to Google Sheets?', body: 'Schedora stops writing to the tab. Rows already in Google Sheets stay there; delete the spreadsheet in Google if you no longer need it.', confirm: 'Stop syncing', danger: true }))) return;
        await api('DELETE', base);
      } else if (action === 'disconnect') {
        if (!(await ask({ title: 'Disconnect Google Sheets?', body: 'Your syncs stop and Google is asked to revoke Schedora’s access. Spreadsheets already in your Drive are not changed.', confirm: 'Disconnect', danger: true }))) return;
        await api('DELETE', wsPath('/google-sheets/connection'));
      } else await api('POST', `${base}/${action}`);
      await render();
    } catch (error) { toast(error.message); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  await render();
}
