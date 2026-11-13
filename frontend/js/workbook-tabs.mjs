import { $, api, ask, html, mount, storage, toast, uid } from './core.mjs';
import { SHEET_COLUMNS, SHEET_ROWS, sheetAddress, sheetValue } from './sheet-formulas.mjs';
import { mergeWorkbook } from './workbook-merge.mjs';

export function mountWorkbookTabs(root, { storageKey, endpoint, alive, responseCells }) {
  const tabs = $('.workbook-tabs', root);
  const editor = $('.workbook-editor', root);
  const responses = $('.workbook-responses', root);
  let saved;
  try {
    saved = JSON.parse(storage.get(storageKey));
  } catch { /* Start with the linked response tab. */ }
  let sheets = [];
  let baseSheets = [];
  let revision = 0;
  let ready = false;
  let pending = false;
  let saving = false;
  let conflicted = false;
  let checking = false;
  let syncText = 'Loading workbook…';
  let selectedSheet = null;
  let selectedCell = 'A1';
  const undo = [];
  const redo = [];
  const remember = () => {
    undo.push({ id: selectedSheet.id, cells: { ...selectedSheet.cells } });
    if (undo.length > 30) undo.shift();
    redo.length = 0;
  };
  const restore = (from, to) => {
    const previous = from.pop();
    if (!previous) return;
    const sheet = sheets.find(item => item.id === previous.id);
    to.push({ id: sheet.id, cells: sheet.cells });
    sheet.cells = previous.cells;
    save();
    updateValues();
    selectCell(selectedCell, true);
  };
  const updateStatus = message => {
    syncText = message;
    const status = $('[data-workbook-status]', tabs);
    if (status) status.textContent = message;
    const retry = $('[data-retry-workbook]', tabs);
    if (retry) retry.hidden = !ready || !pending || saving || conflicted;
  };
  const cache = () => storage.set(storageKey, JSON.stringify({ revision, pending: pending || saving, sheets, baseSheets }));
  const flush = async (attempt = 0) => {
    if (!ready || saving || conflicted || !pending) return;
    saving = true;
    pending = false;
    const snapshot = structuredClone(sheets);
    updateStatus('Saving workbook…');
    try {
      const result = await api('PUT', endpoint, { revision, sheets: snapshot });
      revision = result.revision;
      baseSheets = result.sheets;
      saving = false;
      cache();
      updateStatus(pending ? 'Saving workbook…' : 'Saved to workspace');
    } catch (error) {
      pending = true;
      conflicted = error.status === 409;
      if (conflicted && attempt < 3) {
        try {
          const remote = await api('GET', endpoint);
          const merged = mergeWorkbook(baseSheets, sheets, remote.sheets);
          if (merged) {
            adopt(remote, structuredClone(merged));
            conflicted = false;
            saving = false;
            cache();
            return flush(attempt + 1);
          }
        } catch { /* Keep the local draft available when reconciliation fails. */ }
      }
      cache();
      saving = false;
      updateStatus(conflicted ? 'Another session saved first. This browser kept your unsynced changes.' : 'Workbook could not sync. Changes kept in this browser.');
      if (conflicted && alive()) draw();
      return;
    }
    if (pending) void flush();
  };
  const save = () => {
    pending = true;
    cache();
    void flush();
  };

  const selectCell = (address, focus = false) => {
    selectedCell = address;
    const previous = $('[data-cell][tabindex="0"]', editor);
    if (previous) previous.tabIndex = -1;
    const next = $(`[data-cell="${address}"]`, editor);
    next.tabIndex = 0;
    const value = $('#sheet-input', editor);
    value.value = selectedSheet.cells[address] || '';
    $('#sheet-address', editor).textContent = address;
    if (focus) next.focus();
  };

  const updateValues = () => {
    if (!selectedSheet) return;
    const linked = responseCells();
    const sources = linked ? [...sheets, { name: 'Form Responses', cells: linked, literal: true }] : sheets;
    for (const cell of editor.querySelectorAll('[data-cell]')) {
      try { cell.textContent = sheetValue(selectedSheet.cells, cell.dataset.cell, sources); }
      catch (error) { cell.textContent = error.message; }
    }
  };

  const draw = () => {
    root.classList.toggle('workbook-editing', Boolean(selectedSheet));
    responses.hidden = Boolean(selectedSheet);
    editor.hidden = !selectedSheet;
    mount(tabs, html`<button type="button" class="sheet-add" data-sheet-tab="new" aria-label="Add sheet" ${ready ? '' : 'disabled'}>+</button>
      <button type="button" data-sheet-tab="responses" aria-current="${selectedSheet ? 'false' : 'page'}">Form Responses</button>
      ${sheets.map(sheet => html`<button type="button" data-sheet-tab="${sheet.id}" aria-current="${sheet === selectedSheet ? 'page' : 'false'}">${sheet.name}</button>`)}
      ${selectedSheet ? html`<button type="button" data-rename-sheet>Rename sheet</button>` : ''}
      <span class="muted" role="status" data-workbook-status>${syncText}</span>
      <button type="button" data-retry-workbook>Retry save</button>
      ${conflicted ? html`<button type="button" data-recover-workbook>Download unsynced changes</button><button type="button" data-load-workbook>Load workspace version</button>` : ''}`);
    updateStatus(syncText);
    if (!selectedSheet) return;
    const columns = Array.from({ length: SHEET_COLUMNS }, (_, index) => index);
    mount(editor, html`<form class="workbook-cell-bar" id="sheet-cell-form">
      <span id="sheet-address">A1</span><label for="sheet-input" title="Cell value or formula">ƒx</label>
      <input id="sheet-input" maxlength="1000" aria-label="Cell value or formula" autocomplete="off" spellcheck="false">
      <button class="btn btn-small" type="submit">Apply</button>
    </form>
    <div class="table-wrap response-sheet"><table class="workbook-editable-table" aria-label="${selectedSheet.name}">
      <thead><tr class="workbook-letters"><th></th>${columns.map(column => html`<th scope="col">${sheetAddress(0, column)[0]}</th>`)}</tr></thead>
      <tbody>${Array.from({ length: SHEET_ROWS }, (_, row) => html`<tr><th scope="row">${row + 1}</th>
        ${columns.map(column => { const address = sheetAddress(row, column); return html`<td><button type="button" data-cell="${address}" tabindex="-1" aria-label="Cell ${address}"></button></td>`; })}</tr>`)}</tbody>
    </table></div>`);
    updateValues();
    selectCell(selectedCell);
  };

  function adopt(remote, nextSheets = remote.sheets) {
    const selectedId = selectedSheet?.id;
    const field = $('#sheet-input', editor);
    const draftValue = selectedSheet && field && field.value !== (selectedSheet.cells[selectedCell] ?? '') ? field.value : null;
    const focusedCell = document.activeElement?.matches('[data-cell]') && editor.contains(document.activeElement);
    const focusedInput = field && document.activeElement === field;
    revision = remote.revision;
    baseSheets = remote.sheets;
    sheets = nextSheets;
    selectedSheet = sheets.find(sheet => sheet.id === selectedId) || null;
    undo.length = 0;
    redo.length = 0;
    if (!alive()) return;
    draw();
    if (selectedSheet) {
      const nextField = $('#sheet-input', editor);
      if (draftValue !== null) nextField.value = draftValue;
      if (focusedInput) nextField.focus();
      if (focusedCell) $(`[data-cell="${selectedCell}"]`, editor)?.focus();
    }
  }

  root.addEventListener('click', async event => {
    const command = event.target.closest('[data-edit-sheet]')?.dataset.editSheet;
    if (command) {
      const menu = event.target.closest('details');
      if (menu) { menu.open = false; menu.querySelector('summary').focus(); }
      if (command === 'add') return $('[data-sheet-tab="new"]', tabs)?.click();
      if (!selectedSheet) return toast('Open an editable sheet first.');
      if (command === 'undo') return restore(undo, redo);
      if (command === 'redo') return restore(redo, undo);
      const sheet = selectedSheet;
      if (!await ask({ title: 'Delete sheet?', body: `“${sheet.name}” and its cells will be removed from this workbook.`, confirm: 'Delete sheet', danger: true })) return;
      if (!alive()) return;
      sheets = sheets.filter(item => item !== sheet);
      selectedSheet = null;
      undo.length = 0;
      redo.length = 0;
      save();
      draw();
      $('[data-sheet-tab="responses"]', tabs).focus();
      return;
    }
    if (event.target.closest('[data-retry-workbook]')) return flush();
    if (event.target.closest('[data-recover-workbook]')) {
      const url = URL.createObjectURL(new Blob([JSON.stringify(sheets, null, 2)], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: 'schedora-workbook-unsynced.json' }).click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
    if (event.target.closest('[data-load-workbook]')) {
      if (!await ask({ title: 'Load workspace version?', body: 'Download unsynced changes first if you want to keep a copy.', confirm: 'Load workspace version' })) return;
      return load(true);
    }
    if (event.target.closest('[data-rename-sheet]')) {
      const sheet = selectedSheet;
      const result = await ask({ title: 'Rename sheet', fields: html`<label for="sheet-name">Name</label><input id="sheet-name" name="name" value="${sheet.name}" maxlength="60" required>`, confirm: 'Rename' });
      const name = result?.name?.trim();
      if (!name) return;
      if (name.toLowerCase() === 'form responses' || sheets.some(item => item !== sheet && item.name.toLowerCase() === name.toLowerCase())) return toast('A sheet already uses that name.');
      const oldName = sheet.name.toUpperCase();
      for (const item of sheets) {
        for (const [address, value] of Object.entries(item.cells)) {
          if (value.startsWith('=')) item.cells[address] = value.replace(/'((?:[^']|'')*)'!(?=[A-Z]+[0-9]+)/gi, (reference, label) =>
            label.replaceAll("''", "'").toUpperCase() === oldName ? "'" + name.replaceAll("'", "''") + "'!" : reference);
        }
      }
      sheet.name = name;
      undo.length = 0;
      redo.length = 0;
      save();
      draw();
      $('[data-rename-sheet]', tabs)?.focus();
      return;
    }
    const tab = event.target.closest('[data-sheet-tab]');
    if (tab) {
      const key = tab.dataset.sheetTab;
      if (key === 'new') {
        if (sheets.length >= 12) return toast('This workbook already has 12 editable sheets.');
        let number = sheets.length + 1;
        while (sheets.some(sheet => sheet.name.toLowerCase() === 'sheet ' + number)) number++;
        selectedSheet = { id: uid(), name: 'Sheet ' + number, cells: {} };
        sheets.push(selectedSheet);
        save();
      } else selectedSheet = sheets.find(sheet => sheet.id === key) || null;
      selectedCell = 'A1';
      draw();
      const activeTab = selectedSheet?.id || 'responses';
      $(`[data-sheet-tab="${activeTab}"]`, tabs).focus();
      return;
    }
    const cell = event.target.closest('[data-cell]');
    if (cell && editor.contains(cell)) selectCell(cell.dataset.cell);
  });

  editor.addEventListener('dblclick', event => {
    if (event.target.closest('[data-cell]')) $('#sheet-input', editor).select();
  });
  editor.addEventListener('submit', event => {
    if (event.target.id !== 'sheet-cell-form') return;
    event.preventDefault();
    const value = $('#sheet-input', editor).value;
    if (value === (selectedSheet.cells[selectedCell] ?? '')) return selectCell(selectedCell, true);
    remember();
    if (value) selectedSheet.cells[selectedCell] = value;
    else delete selectedSheet.cells[selectedCell];
    save();
    updateValues();
    selectCell(selectedCell, true);
  });
  editor.addEventListener('keydown', event => {
    const cell = event.target.closest('[data-cell]');
    if (!cell) return;
    const address = cell.dataset.cell;
    const direction = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] }[event.key];
    if (direction) {
      event.preventDefault();
      const row = Math.min(SHEET_ROWS - 1, Math.max(0, Number(address.slice(1)) - 1 + direction[0]));
      const column = Math.min(SHEET_COLUMNS - 1, Math.max(0, address.charCodeAt(0) - 65 + direction[1]));
      selectCell(sheetAddress(row, column), true);
    } else if (event.key === 'Enter' || event.key === 'F2') {
      event.preventDefault();
      $('#sheet-input', editor).select();
    } else if (event.key === 'Delete') {
      $('#sheet-input', editor).value = '';
      $('#sheet-cell-form', editor).requestSubmit();
    } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c') {
      event.preventDefault();
      navigator.clipboard.writeText(cell.textContent).catch(() => toast('Could not copy the cell.'));
    } else if ((event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
      event.preventDefault();
      if (event.shiftKey || event.key.toLowerCase() === 'y') restore(redo, undo);
      else restore(undo, redo);
    }
  });
  editor.addEventListener('paste', event => {
    const cell = event.target.closest('[data-cell]');
    const text = event.clipboardData?.getData('text/plain');
    if (!cell || !text) return;
    event.preventDefault();
    remember();
    const firstRow = Number(cell.dataset.cell.slice(1)) - 1;
    const firstColumn = cell.dataset.cell.charCodeAt(0) - 65;
    const lines = text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n').slice(0, SHEET_ROWS - firstRow);
    lines.forEach((line, row) => line.split('\t').slice(0, SHEET_COLUMNS - firstColumn).forEach((value, column) => {
      const address = sheetAddress(firstRow + row, firstColumn + column);
      if (value) selectedSheet.cells[address] = value.slice(0, 1000);
      else delete selectedSheet.cells[address];
    }));
    save();
    updateValues();
    selectCell(cell.dataset.cell, true);
  });
  async function load(discardLocal = false) {
    try {
      const remote = await api('GET', endpoint);
      if (!alive()) return;
      const local = discardLocal ? null : saved;
      const legacy = Array.isArray(local) ? local : null;
      const draft = local?.pending && Array.isArray(local.sheets) ? local : null;
      revision = remote.revision;
      baseSheets = remote.sheets;
      const stale = draft && draft.revision !== revision;
      const merged = stale && Array.isArray(draft.baseSheets) ? mergeWorkbook(draft.baseSheets, draft.sheets, remote.sheets) : null;
      conflicted = Boolean(stale && !merged && JSON.stringify(draft.sheets) !== JSON.stringify(remote.sheets)) || Boolean(legacy?.length && revision);
      if (conflicted) {
        revision = draft?.revision ?? 0;
        baseSheets = draft?.baseSheets ?? [];
      }
      sheets = structuredClone(merged ?? draft?.sheets ?? (legacy?.length ? legacy : remote.sheets));
      pending = Boolean(draft || legacy?.length);
      ready = true;
      selectedSheet = null;
      undo.length = 0;
      redo.length = 0;
      if (!conflicted) cache();
      updateStatus(conflicted ? 'Workspace version changed. Unsynced changes are available for download.' : 'Saved to workspace');
      draw();
      if (pending && !conflicted) void flush();
    } catch {
      if (!alive()) return;
      updateStatus('Could not load editable sheets. Reload to try again.');
    }
  }
  root.addEventListener('click', event => {
    if (event.target.closest('[data-refresh-workbook]')) void refresh(true);
  });
  async function refresh(manual = false) {
    if (checking || !ready || saving || pending || conflicted) return;
    checking = true;
    try {
      const remote = await api('GET', endpoint);
      if (!alive() || saving || pending || conflicted || remote.revision <= revision) return;
      const input = $('#sheet-input', editor);
      if (selectedSheet && input?.value !== (selectedSheet.cells[selectedCell] ?? '')) {
        updateStatus('New workspace version available. Apply or clear the current cell edit before refreshing.');
        return;
      }
      adopt(remote, structuredClone(remote.sheets));
      cache();
      updateStatus('Workbook updated from workspace');
    } catch {
      if (manual && alive()) updateStatus('Could not refresh workbook.');
    } finally { checking = false; }
  }
  draw();
  void load();
  const timer = setInterval(() => {
    if (!alive() || !root.isConnected) return clearInterval(timer);
    if (!document.hidden && !root.querySelector('details[open]') && !document.querySelector('dialog[open]')) void refresh();
  }, 4000);
  return updateValues;
}
