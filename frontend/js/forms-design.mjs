// The builder's Design panel: My themes (reusable workspace themes) and a Gallery of Schedora presets.
// Choosing or editing a theme changes only this draft's own copy, at once, on the canvas and preview;
// nothing reaches respondents until the form is published, and saving a reusable theme changes no
// other form. Form templates, which hold questions, are a separate thing and are not touched here.
import { $, $$, api, ask, html, mount, raw, toast, wsPath } from './core.mjs';
import { THEME_COLORS, THEME_FONTS, themeWarnings } from '../shared/forms-logic.mjs';
import { STARTER_TOKENS, THEME_PRESETS, applyTheme, themeCopy, tokensOf } from './forms-themes.mjs';

const COLOR_LABELS = { background: 'Background', question: 'Question text', answer: 'Answer text', button: 'Button', button_text: 'Button text' };
const sameLook = (a, b) => JSON.stringify(tokensOf(a)) === JSON.stringify(tokensOf(b));

export function designPanel({ root, opener, getTheme, setTheme, announce }) {
  let tab = 'mine';
  let themes = null; // null until loaded
  let loadError = null;
  let editing = null; // { id, name, tokens, revision, before, error }

  const miniature = theme => html`<div class="theme-mini" data-mini="${JSON.stringify(tokensOf(theme))}" aria-hidden="true"><span class="theme-mini-question">Question</span><span class="theme-mini-answer">Answer</span><span class="theme-mini-button">OK</span></div>`;
  const paintMiniatures = () => $$('[data-mini]', root).forEach(node => applyTheme(node, { name: 'Sample', ...JSON.parse(node.dataset.mini) }));

  const currentLine = () => {
    const theme = getTheme();
    return html`<p class="design-current" data-design-current>${theme ? html`This draft uses <strong>${theme.name}</strong>. <button class="btn-link" type="button" data-theme-clear>Remove theme</button>` : 'This draft uses the standard look.'}</p>`;
  };

  const themeCard = theme => {
    const applied = getTheme()?.source === `workspace:${theme.id}`;
    const current = applied && sameLook(getTheme(), theme);
    return html`<li class="theme-card" data-theme-id="${theme.id}">${miniature(theme)}<p class="theme-card-name">${theme.name}${current ? html` <span class="theme-card-state">In use</span>` : ''}</p>
      ${applied && !current ? html`<p class="hint">This draft keeps an earlier copy. Apply again to take these changes.</p>` : ''}
      <div class="theme-card-actions"><button class="btn btn-small" type="button" data-theme-apply ${current ? raw('disabled') : ''}>${applied ? 'Apply again' : 'Apply'}<span class="visually-hidden"> ${theme.name}</span></button>
        <button class="btn btn-small" type="button" data-theme-edit>Edit<span class="visually-hidden"> ${theme.name}</span></button>
        <button class="btn btn-small" type="button" data-theme-duplicate>Duplicate<span class="visually-hidden"> ${theme.name}</span></button>
        <button class="btn btn-small btn-danger" type="button" data-theme-delete>Delete<span class="visually-hidden"> ${theme.name}</span></button></div></li>`;
  };
  const presetCard = preset => {
    const current = getTheme()?.source === `preset:${preset.id}` && sameLook(getTheme(), preset);
    return html`<li class="theme-card" data-preset-id="${preset.id}">${miniature(preset)}<p class="theme-card-name">${preset.name}${current ? html` <span class="theme-card-state">In use</span>` : ''}</p>
      <div class="theme-card-actions"><button class="btn btn-small" type="button" data-preset-apply ${current ? raw('disabled') : ''}>Apply<span class="visually-hidden"> ${preset.name}</span></button>
        <button class="btn btn-small" type="button" data-preset-copy>Copy to My themes<span class="visually-hidden">: ${preset.name}</span></button></div></li>`;
  };

  const editor = () => {
    const warnings = themeWarnings(editing.tokens);
    return html`<form class="theme-editor" novalidate data-theme-form>
      <h3 id="theme-editor-heading" tabindex="-1">${editing.id ? 'Edit theme' : 'Create theme'}</h3>
      <label for="theme-name">Theme name</label><input id="theme-name" maxlength="60" value="${editing.name}">
      <label for="theme-font">Typography</label><select id="theme-font" data-token="font">${Object.entries(THEME_FONTS).map(([key, font]) => html`<option value="${key}" ${key === editing.tokens.font ? raw('selected') : ''}>${font.label}</option>`)}</select>
      <div class="theme-colors">${THEME_COLORS.map(key => html`<div class="theme-color"><label for="theme-${key}">${COLOR_LABELS[key]}</label><input id="theme-${key}" type="color" data-token="${key}" value="${editing.tokens[key]}"></div>`)}</div>
      <div data-theme-warnings role="status">${warnings.map(warning => html`<p class="hint theme-warning">${warning.text}</p>`)}</div>
      ${editing.error ? html`<p class="field-error" role="alert">${editing.error}</p>` : ''}
      <p class="hint">Changes show on this draft straight away. Saving keeps the theme for this workspace; other forms and anything already published keep their current look.</p>
      <div class="theme-card-actions"><button class="btn btn-primary btn-small" type="submit">Save theme</button><button class="btn btn-small" type="button" data-theme-cancel>Cancel</button></div></form>`;
  };

  const draw = focus => {
    mount(root, html`<div class="design-head"><h2 id="design-heading" tabindex="-1">Design</h2><button class="btn btn-small" type="button" data-design-close>Close<span class="visually-hidden"> Design</span></button></div>
      ${editing ? editor() : html`${currentLine()}
        <div class="design-tabs" role="tablist" aria-label="Themes"><button role="tab" type="button" id="design-tab-mine" data-design-tab="mine" aria-selected="${String(tab === 'mine')}" aria-controls="design-tabpanel" ${tab === 'mine' ? '' : raw('tabindex="-1"')}>My themes</button><button role="tab" type="button" id="design-tab-gallery" data-design-tab="gallery" aria-selected="${String(tab === 'gallery')}" aria-controls="design-tabpanel" ${tab === 'gallery' ? '' : raw('tabindex="-1"')}>Gallery</button></div>
        <div id="design-tabpanel" role="tabpanel" aria-labelledby="design-tab-${tab}">${tab === 'gallery' ? html`<ul class="theme-grid">${THEME_PRESETS.map(presetCard)}</ul>`
          : html`<button class="btn btn-small theme-create" type="button" data-theme-create>Create theme</button>
            ${loadError ? html`<p class="field-error" role="alert">Your themes could not be loaded. ${loadError} <button class="btn-link" type="button" data-theme-retry>Try again</button></p>`
            : !themes ? html`<p class="hint">Loading your themes…</p>`
            : themes.length ? html`<ul class="theme-grid">${themes.map(themeCard)}</ul>` : html`<p class="hint">No themes yet. Create one, or copy one from the Gallery. Themes are shared across this workspace.</p>`}`}</div>`}`);
    paintMiniatures();
    if (focus) $(focus, root)?.focus();
  };

  const load = async () => {
    loadError = null;
    try { themes = await api('GET', wsPath('/form-themes')); }
    catch (error) { loadError = error.message; }
    // The list arrives while the author may already be on a control; the redraw must not take focus from it.
    if (root.hidden || editing) return;
    const active = root.contains(document.activeElement) ? document.activeElement.id : '';
    draw(active ? `#${active}` : undefined);
  };

  // The copy on the draft follows the editor, so the canvas and preview change as the author works.
  const showEdits = () => setTheme({ name: editing.name.trim() || 'Untitled theme', ...(editing.id ? { source: `workspace:${editing.id}` } : {}), ...editing.tokens });
  const startEditing = (fields) => {
    editing = { before: getTheme() ? structuredClone(getTheme()) : null, error: null, ...fields };
    showEdits();
    draw('#theme-editor-heading');
  };
  const stopEditing = focus => { editing = null; draw(focus); };

  const saveCopy = async (name, tokens) => {
    const created = await api('POST', wsPath('/form-themes'), { name, ...tokens });
    themes = [created, ...(themes || [])];
    return created;
  };

  root.addEventListener('input', event => {
    if (!editing) return;
    if (event.target.id === 'theme-name') editing.name = event.target.value;
    else if (event.target.dataset.token) editing.tokens[event.target.dataset.token] = event.target.value;
    else return;
    showEdits();
    mount($('[data-theme-warnings]', root), html`${themeWarnings(editing.tokens).map(warning => html`<p class="hint theme-warning">${warning.text}</p>`)}`);
  });
  root.addEventListener('submit', async event => {
    event.preventDefault();
    if (!editing) return;
    const name = editing.name.trim();
    const say = text => { editing.error = text; draw('[role="alert"]'); };
    if (!name) return say('Give the theme a name.');
    try {
      const body = { name, ...editing.tokens };
      const saved = editing.id ? await api('PATCH', wsPath(`/form-themes/${editing.id}`), { ...body, base_revision: editing.revision }) : await api('POST', wsPath('/form-themes'), body);
      themes = [saved, ...(themes || []).filter(item => item.id !== saved.id)];
      setTheme(themeCopy(saved, `workspace:${saved.id}`));
      tab = 'mine';
      announce(`Theme ${saved.name} saved and applied to this draft. Save the draft to keep this change.`);
      stopEditing(`[data-theme-id="${saved.id}"] [data-theme-edit]`);
    } catch (error) {
      if (error.code === 'theme_conflict') { editing.revision = error.details.current.revision; return say('Someone changed this theme after you opened it. Saving again replaces their version.'); }
      say(`The theme was not saved. ${error.message}`);
    }
  });
  root.addEventListener('click', async event => {
    const button = event.target.closest('button');
    if (!button) return;
    const { dataset } = button;
    if (dataset.designClose !== undefined) return close();
    if (dataset.designTab) { tab = dataset.designTab; return draw(`#design-tab-${tab}`); }
    if (dataset.themeRetry !== undefined) return load();
    if (dataset.themeClear !== undefined) { setTheme(null); announce('Theme removed from this draft. Save the draft to keep this change.'); return draw('[data-design-current]'); }
    if (dataset.themeCreate !== undefined) return startEditing({ id: null, name: 'My theme', tokens: tokensOf(getTheme() || STARTER_TOKENS), revision: null });
    if (dataset.themeCancel !== undefined) { const back = editing.before; setTheme(back, true); return stopEditing('[data-theme-create]'); }
    const preset = THEME_PRESETS.find(item => item.id === button.closest('[data-preset-id]')?.dataset.presetId);
    if (dataset.presetApply !== undefined) {
      setTheme(themeCopy(preset, `preset:${preset.id}`));
      announce(`${preset.name} applied to this draft. Save the draft to keep this change.`);
      return draw(`[data-preset-id="${preset.id}"] [data-preset-copy]`);
    }
    const failed = error => toast(`The theme was not saved. ${error.message}`);
    if (dataset.presetCopy !== undefined) {
      try { await saveCopy(preset.name, tokensOf(preset)); announce(`${preset.name} copied to My themes.`); toast(`${preset.name} copied to My themes.`); return draw(`[data-preset-id="${preset.id}"] [data-preset-copy]`); }
      catch (error) { return failed(error); }
    }
    const theme = themes?.find(item => item.id === button.closest('[data-theme-id]')?.dataset.themeId);
    if (!theme) return;
    if (dataset.themeApply !== undefined) {
      setTheme(themeCopy(theme, `workspace:${theme.id}`));
      announce(`${theme.name} applied to this draft. Save the draft to keep this change.`);
      return draw(`[data-theme-id="${theme.id}"] [data-theme-edit]`);
    }
    if (dataset.themeEdit !== undefined) return startEditing({ id: theme.id, name: theme.name, tokens: tokensOf(theme), revision: theme.revision });
    if (dataset.themeDuplicate !== undefined) {
      try { const copy = await saveCopy(`${theme.name} copy`.slice(0, 60), tokensOf(theme)); announce(`${copy.name} created.`); return draw(`[data-theme-id="${copy.id}"] [data-theme-edit]`); }
      catch (error) { return failed(error); }
    }
    if (dataset.themeDelete !== undefined) {
      if (!(await ask({ title: `Delete the theme “${theme.name}”?`, body: 'It leaves My themes for everyone in this workspace. Forms that used it keep their current look, including published forms.', confirm: 'Delete theme', danger: true }))) return;
      try {
        await api('DELETE', wsPath(`/form-themes/${theme.id}`));
        themes = themes.filter(item => item !== theme);
        announce(`${theme.name} deleted. Forms that used it keep their current look.`);
        draw('[data-theme-create]');
      } catch (error) { failed(error); }
    }
  });
  root.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !editing) { event.preventDefault(); return close(); }
    if (!event.target.dataset.designTab || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    tab = tab === 'mine' ? 'gallery' : 'mine';
    draw(`#design-tab-${tab}`);
  });

  function open() {
    root.hidden = false;
    opener.setAttribute('aria-expanded', 'true');
    root.parentElement.dataset.design = 'open';
    draw('#design-heading');
    if (!themes) load();
  }
  function close() {
    // Leaving mid-edit keeps nothing half-done on the draft.
    if (editing) { setTheme(editing.before, true); editing = null; }
    root.hidden = true;
    opener.setAttribute('aria-expanded', 'false');
    delete root.parentElement.dataset.design;
    opener.focus();
  }
  return { open, close, toggle: () => root.hidden ? open() : close(), refresh: () => { editing = null; if (!root.hidden) draw(); } };
}
