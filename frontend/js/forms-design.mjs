// The builder's Design panel: My themes (reusable workspace themes) and a Gallery of Schedora presets.
// Choosing or editing a theme changes only this draft's own copy, at once, on the canvas and preview;
// nothing reaches respondents until the form is published, and saving a reusable theme changes no
// other form. Form templates, which hold questions, are a separate thing and are not touched here.
import { $, $$, api, ask, html, mount, raw, toast, wsPath } from './core.mjs';
import { THEME_COLORS, THEME_FONTS, THEME_SIZES, THEME_SIZE_TOKENS, isTypographyOnly, themeWarnings } from '../shared/forms-logic.mjs';
import { DEFAULT_TYPOGRAPHY, STARTER_TOKENS, THEME_PRESETS, applyTheme, defaultStyleWith, themeCopy, tokensOf } from './forms-themes.mjs';

const COLOR_LABELS = { background: 'Background', question: 'Question text', answer: 'Answer text', button: 'Button', button_text: 'Button text' };
const SIZE_LABELS = { question_size: 'Question size', description_size: 'Description size', answer_size: 'Answer size' };
const sameLook = (a, b) => JSON.stringify(tokensOf(a)) === JSON.stringify(tokensOf(b));

// Font and text sizes. The same controls appear in the theme editor and, for this draft's own copy,
// on the Design panel itself; `prefix` keeps their ids apart.
const typographyControls = (tokens, prefix, { heading = null } = {}) => html`<div class="theme-typography" role="group" aria-labelledby="${prefix}-typography-heading">
  ${heading || html`<p class="theme-group-heading" id="${prefix}-typography-heading">Typography</p>`}
  <label for="${prefix}-font">Font family</label><select id="${prefix}-font" data-token="font">${Object.entries(THEME_FONTS).map(([key, font]) => html`<option value="${key}" ${key === tokens.font ? raw('selected') : ''}>${font.label}</option>`)}</select>
  ${THEME_SIZE_TOKENS.map(key => html`<label for="${prefix}-${key}">${SIZE_LABELS[key]}</label><select id="${prefix}-${key}" data-token="${key}">${Object.entries(THEME_SIZES).map(([size, label]) => html`<option value="${size}" ${size === (tokens[key] || 'medium') ? raw('selected') : ''}>${label}</option>`)}</select>`)}
</div>`;

export function designPanel({ root, opener, getTheme, setTheme, announce }) {
  let tab = 'mine';
  let themes = null; // null until loaded
  let loadError = null;
  let editing = null; // { id, name, tokens, revision, before, error }

  const miniature = theme => html`<div class="theme-mini" data-mini="${JSON.stringify(tokensOf(theme))}" aria-hidden="true"><span class="theme-mini-question">Question</span><span class="theme-mini-answer">Answer</span><span class="theme-mini-button">OK</span></div>`;
  const paintMiniatures = () => $$('[data-mini]', root).forEach(node => applyTheme(node, { name: 'Sample', ...JSON.parse(node.dataset.mini) }));

  const currentLine = () => {
    const theme = getTheme();
    if (!theme) return html`<p class="design-current" data-design-current>This draft uses the default style.</p>`;
    if (isTypographyOnly(theme)) return html`<p class="design-current" data-design-current>This draft uses the default style with its own typography. <button class="btn-link" type="button" data-theme-clear>Reset typography</button></p>`;
    return html`<p class="design-current" data-design-current>This draft uses <strong>${theme.name}</strong>. <button class="btn-link" type="button" data-theme-clear>Remove theme</button></p>`;
  };
  // The type a reset returns to: the applied theme's own typography, or the default style.
  const TYPE_KEYS = ['font', ...THEME_SIZE_TOKENS];
  const typographyOf = theme => Object.fromEntries(TYPE_KEYS.map(key => [key, key === 'font' ? theme?.font || DEFAULT_TYPOGRAPHY.font : theme?.[key] || 'medium']));
  const sourceTheme = () => {
    const source = getTheme()?.source || '';
    if (source.startsWith('preset:')) return THEME_PRESETS.find(preset => `preset:${preset.id}` === source) || null;
    if (source.startsWith('workspace:')) return (themes || []).find(theme => `workspace:${theme.id}` === source) || null;
    return null;
  };
  const resetTarget = () => {
    const theme = getTheme();
    if (!theme) return null;
    const target = isTypographyOnly(theme) ? null : sourceTheme();
    const wanted = typographyOf(target || DEFAULT_TYPOGRAPHY);
    return JSON.stringify(typographyOf(theme)) === JSON.stringify(wanted) ? null : { wanted, name: target?.name || null };
  };
  // Typography for this draft alone. With a theme it changes the draft's own copy, never the saved theme;
  // without one it starts from the default style and keeps the change on this draft only.
  const draftTypography = () => {
    const theme = getTheme();
    const reset = resetTarget();
    const note = theme && !isTypographyOnly(theme)
      ? 'Changes apply to this draft only. The saved theme, other forms and the published form are not changed until you publish.'
      : 'Starts from the default style. Changes apply to this draft only: no workspace theme is created, and the published form is not changed until you publish.';
    const heading = html`<div class="design-section-head"><h3 id="draft-typography-heading">Typography</h3>${reset ? html`<button class="btn btn-small" type="button" data-typography-reset title="${reset.name ? `Back to ${reset.name}'s typography` : 'Back to the default style'}">Reset<span class="visually-hidden"> typography to ${reset.name ? `${reset.name}'s` : 'the default style'}</span></button>` : ''}</div>`;
    return html`<section class="design-typography" data-draft-typography>${typographyControls(theme || DEFAULT_TYPOGRAPHY, 'draft', { heading })}<p class="hint">${note}</p></section>`;
  };

  const themeCard = theme => {
    const applied = getTheme()?.source === `workspace:${theme.id}`;
    const current = applied && sameLook(getTheme(), theme);
    return html`<li class="theme-card" data-theme-id="${theme.id}">${miniature(theme)}<p class="theme-card-name">${theme.name}${current ? html` <span class="theme-card-state">In use</span>` : ''}</p>
      ${applied && !current ? html`<p class="hint">This draft's copy differs from this theme. Apply again to use the theme as saved.</p>` : ''}
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
      ${typographyControls(editing.tokens, 'theme')}
      <p class="theme-group-heading">Colours</p>
      <div class="theme-colors">${THEME_COLORS.map(key => html`<div class="theme-color"><label for="theme-${key}">${COLOR_LABELS[key]}</label><input id="theme-${key}" type="color" data-token="${key}" value="${editing.tokens[key]}"></div>`)}</div>
      <div data-theme-warnings role="status">${warnings.map(warning => html`<p class="hint theme-warning">${warning.text}</p>`)}</div>
      ${editing.error ? html`<p class="field-error" role="alert">${editing.error}</p>` : ''}
      <p class="hint">Changes show on this draft straight away. Saving keeps the theme for this workspace; other forms and anything already published keep their current look.</p>
      <div class="theme-card-actions"><button class="btn btn-primary btn-small" type="submit">Save theme</button><button class="btn btn-small" type="button" data-theme-cancel>Cancel</button></div></form>`;
  };

  const draw = focus => {
    mount(root, html`<div class="design-head"><h2 id="design-heading" tabindex="-1">Design</h2><button class="btn btn-small" type="button" data-design-close>Close<span class="visually-hidden"> Design</span></button></div>
      ${editing ? editor() : html`${draftTypography()}
        <section class="design-themes" aria-labelledby="design-themes-heading"><h3 id="design-themes-heading">Themes</h3>${currentLine()}
        <p class="hint">Themes are saved in this workspace for any form. Applying one copies it into this draft; editing a saved theme changes the theme, not forms that already use a copy.</p>
        <div class="design-tabs" role="tablist" aria-label="Themes"><button role="tab" type="button" id="design-tab-mine" data-design-tab="mine" aria-selected="${String(tab === 'mine')}" aria-controls="design-tabpanel" ${tab === 'mine' ? '' : raw('tabindex="-1"')}>My themes</button><button role="tab" type="button" id="design-tab-gallery" data-design-tab="gallery" aria-selected="${String(tab === 'gallery')}" aria-controls="design-tabpanel" ${tab === 'gallery' ? '' : raw('tabindex="-1"')}>Gallery</button></div>
        <div id="design-tabpanel" role="tabpanel" aria-labelledby="design-tab-${tab}">${tab === 'gallery' ? html`<ul class="theme-grid">${THEME_PRESETS.map(presetCard)}</ul>`
          : html`<button class="btn btn-small theme-create" type="button" data-theme-create>Create theme</button>
            ${loadError ? html`<p class="field-error" role="alert">Your themes could not be loaded. ${loadError} <button class="btn-link" type="button" data-theme-retry>Try again</button></p>`
            : !themes ? html`<p class="hint">Loading your themes…</p>`
            : themes.length ? html`<ul class="theme-grid">${themes.map(themeCard)}</ul>` : html`<p class="hint">No themes yet. Create one, or copy one from the Gallery. Themes are shared across this workspace.</p>`}`}</div></section>`}`);
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

  // Selects report through change; both events land here so every browser updates at once.
  const draftToken = event => {
    if (editing || !event.target.closest('[data-draft-typography]') || !event.target.dataset.token) return false;
    const { token } = event.target.dataset;
    const current = getTheme() || DEFAULT_TYPOGRAPHY;
    if ((current[token] || 'medium') === event.target.value) return true; // the second of input and change
    const next = { ...current, [token]: event.target.value };
    for (const key of THEME_SIZE_TOKENS) if (!next[key] || next[key] === 'medium') delete next[key];
    // The default style holds typography only, and back at its own values it leaves the draft as it was.
    const theme = !getTheme() || isTypographyOnly(getTheme()) ? defaultStyleWith(next) : next;
    setTheme(theme);
    draw(`#${event.target.id}`); // the note, the current line and Reset follow the change
    announce('Typography changed on this draft. Save the draft to keep this change.');
    return true;
  };
  root.addEventListener('change', draftToken);
  root.addEventListener('input', event => {
    if (draftToken(event)) return;
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
    if (dataset.typographyReset !== undefined) {
      const reset = resetTarget();
      if (!reset) return draw('#draft-font');
      const theme = getTheme();
      if (isTypographyOnly(theme)) setTheme(null);
      else {
        const next = { ...theme, font: reset.wanted.font };
        for (const key of THEME_SIZE_TOKENS) { if (reset.wanted[key] === 'medium') delete next[key]; else next[key] = reset.wanted[key]; }
        setTheme(next);
      }
      announce(`Typography reset to ${reset.name ? `${reset.name}'s` : 'the default style'}. Save the draft to keep this change.`);
      return draw('#draft-font');
    }
    if (dataset.themeClear !== undefined) { const typography = isTypographyOnly(getTheme()); setTheme(null); announce(typography ? 'Typography reset to the default style. Save the draft to keep this change.' : 'Theme removed from this draft. Save the draft to keep this change.'); return draw('#draft-font'); }
    // A new theme keeps the draft's typography; colours come from the starter when the draft has none.
    if (dataset.themeCreate !== undefined) return startEditing({ id: null, name: 'My theme', tokens: { ...tokensOf(STARTER_TOKENS), ...Object.fromEntries(Object.entries(tokensOf(getTheme() || STARTER_TOKENS)).filter(([, value]) => value != null)) }, revision: null });
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
