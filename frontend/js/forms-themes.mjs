// Form appearance: Schedora's preset gallery, and how a theme reaches the page. Pure, apart from setting
// custom properties on the element it is given. A form holds its own copy of a theme, so nothing here
// looks a theme up at render time, and only values the shared validator accepts reach the page.
import { THEME_COLORS, THEME_FONTS, THEME_TOKENS, themeProblems } from '../shared/forms-logic.mjs';

export const THEME_PRESETS = [
  { id: 'schedora', name: 'Schedora', font: 'system', background: '#ffffff', question: '#2a1a4f', answer: '#4b3d6b', button: '#5b3aa0', button_text: '#ffffff' },
  { id: 'paper', name: 'Paper', font: 'serif', background: '#faf6ee', question: '#2b2419', answer: '#4c4231', button: '#2b2419', button_text: '#faf6ee' },
  { id: 'harbour', name: 'Harbour', font: 'system', background: '#10243a', question: '#ffffff', answer: '#d7e6f5', button: '#f4b942', button_text: '#1a1200' },
  { id: 'meadow', name: 'Meadow', font: 'rounded', background: '#eef6ec', question: '#17391f', answer: '#2f5a39', button: '#1f6b3a', button_text: '#ffffff' },
  { id: 'ember', name: 'Ember', font: 'serif', background: '#2a1512', question: '#fff1e6', answer: '#f3d2bd', button: '#f0703a', button_text: '#1e0d05' },
  { id: 'slate', name: 'Slate', font: 'mono', background: '#eceff3', question: '#1b2430', answer: '#3a4656', button: '#1b2430', button_text: '#ffffff' },
  { id: 'lagoon', name: 'Lagoon', font: 'rounded', background: '#e4f5f7', question: '#0b3b45', answer: '#17525e', button: '#0b6577', button_text: '#ffffff' },
  { id: 'blossom', name: 'Blossom', font: 'system', background: '#fdf0f3', question: '#4a1630', answer: '#6d2a49', button: '#a3265f', button_text: '#ffffff' }
];
export const presetById = id => THEME_PRESETS.find(preset => preset.id === id);

// A new theme starts from something readable that is clearly not yet the author's own.
export const STARTER_TOKENS = { font: 'system', background: '#ffffff', question: '#1f1f1f', answer: '#3d3d3d', button: '#5b3aa0', button_text: '#ffffff' };

export const tokensOf = theme => Object.fromEntries(THEME_TOKENS.map(key => [key, theme[key]]));

/** The draft's own copy of a theme. `source` records where it came from, for the Design panel only. */
export const themeCopy = (theme, source) => ({ name: theme.name, ...(source ? { source } : {}), ...tokensOf(theme) });

const CSS_NAMES = { background: '--t-background', question: '--t-question', answer: '--t-answer', button: '--t-button', button_text: '--t-button-text' };

/** Shows a theme on an element, or clears it. Anything the validator would refuse is not applied. */
export function applyTheme(element, theme) {
  for (const name of [...Object.values(CSS_NAMES), '--t-font']) element.style.removeProperty(name);
  delete element.dataset.themed;
  if (!theme || themeProblems(theme).length) return;
  for (const key of THEME_COLORS) element.style.setProperty(CSS_NAMES[key], theme[key]);
  element.style.setProperty('--t-font', THEME_FONTS[theme.font].stack);
  element.dataset.themed = '1';
}
