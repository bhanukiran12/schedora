// Schedora's outline icons for the form editor: one 24-unit grid and one stroke, coloured by the text
// around them. Inline so a question type's badge can set the colour. Always decorative: the control
// or label beside an icon carries its accessible name.
import { raw } from './core.mjs';

const PATHS = {
  short_text: 'M4 7h16M4 12h10M4 17h7',
  long_text: 'M4 5h16M4 9.5h16M4 14h16M4 18.5h11',
  plus_circle: 'M12 8v8M8 12h8M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z',
  email: 'M3.5 6h17v12h-17zM4 7l8 6 8-6',
  phone: 'M7 3.5h3.5l1.3 4.2-2.1 1.6a12 12 0 0 0 6 6l1.6-2.1 4.2 1.3V18a2 2 0 0 1-2.2 2A16 16 0 0 1 4 6a2 2 0 0 1 3-2.5z',
  file_upload: 'M14 2H6v20h12V6zM14 2v5h5M9 13l3-3 3 3M12 10v8',
  single_grid: 'M3 5h18v14H3zM3 10h18M9 5v14M15 5v14',
  multiple_grid: 'M3 5h18v14H3zM3 10h18M9 5v14M15 5v14M10.5 14l1 1 2-2',
  single_choice: 'M7 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 8h8M7 16a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 18h8',
  multiple_choice: 'M4 5h5v5H4zM12 7.5h8M4 14h5v5H4zM12 16.5h8',
  date: 'M4 5.5h16v15H4zM4 10h16M8 3v5M16 3v5M8 13.5h2M13 13.5h3',
  time: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0zM12 7v5l3 2',
  number: 'M9 4 7 20M17 4l-2 16M4 9h16M3.5 15h16',
  scale: 'M3 17h18M5 17v-3M9.5 17v-5M14.5 17v-7M19 17V7',
  page_break: 'M4 5h16M4 19h16M4 12h5M15 12h5',
  ending: 'M6 21V4h12l-3 4 3 4H6',
  plus: 'M12 5v14M5 12h14',
  undo: 'M9 14L4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  design: 'M4 6h5m4 0h7M9 3v6M4 12h2m4 0h10M6 9v6M4 18h9m4 0h3M13 15v6',
  settings: 'M5 6h14M5 12h14M5 18h14M9 4v4M15 10v4M11 16v4',
  desktop: 'M3 5h18v11H3zM9 20h6M12 16v4',
  mobile: 'M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2',
  more: 'M4.500 12h1M11.500 12h1M18.500 12h1',
  up: 'M12 19V5M6 11l6-6 6 6',
  down: 'M12 5v14M6 13l6 6 6-6',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
  trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
  logic: 'M6 4v8a4 4 0 0 0 4 4h8M14 12l4 4-4 4',
  back: 'M15 5l-7 7 7 7',
  next: 'M5 12h14M13 6l6 6-6 6',
  page: 'M6 3.5h8l4 4V21H6zM14 3.5V8h4M9 12h6M9 16h6',
  contact_info: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.500-6 8-6s8 2 8 6',
  chevron: 'M6 9l6 6 6-6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.500 6.500l4 4',
  play: 'M7 4l13 8-13 8z',
  forms: 'M4 5h16v14H4zM8 9h8M8 13h5',
  file_code: 'M6 3.5h8l4 4V21H6zM14 3.5V8h4M10 12l-2 2 2 2M14 12l2 2-2 2',
  check: 'M5 12.5l4.2 4.2L19 7',
  mode_universal: 'M4 5h16M4 12h16M4 19h16',
  mode_lead: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 11v2',
  mode_knowledge: 'M5 5h14v14H5zM8 9l1.5 1.5L12 8M13.5 9H16M8 15l1.5 1.5L12 14M13.5 15H16',
  mode_match: 'M4 7h7l3 5h6M4 17h7l3-5M17 9l3 3-3 3'
};

export const formIcon = name => raw(`<svg class="f-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${Object.hasOwn(PATHS, name) ? PATHS[name] : PATHS.forms}"/></svg>`);

// Question families share a pastel badge, so a form's shape can be read down the outline.
export const TYPE_KIND = { short_text: 'text', long_text: 'text', email: 'contact', phone: 'contact', single_choice: 'choice', multiple_choice: 'choice', file_upload: 'layout', single_grid: 'choice', multiple_grid: 'choice', date: 'date', time: 'date', number: 'text', scale: 'choice', page_break: 'layout' };
