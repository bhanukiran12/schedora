// Schedora's outline icons for the form editor: one 24-unit grid and one stroke, coloured by the text
// around them. Inline so a question type's badge can set the colour. Always decorative: the control
// or label beside an icon carries its accessible name.
import { raw } from './core.mjs';

const PATHS = {
  short_text: 'M4 8h16M4 14h10',
  long_text: 'M4 6h16M4 11h16M4 16h16M4 21h9',
  email: 'M3 6h18v12H3zM3 7l9 6 9-6',
  phone: 'M7 3h4l1.5 5-2.5 1.5a11 11 0 0 0 5.5 5.5L17 12.5l5 1.5v4a2 2 0 0 1-2 2A17 17 0 0 1 4 5a2 2 0 0 1 2-2z',
  single_choice: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6z',
  multiple_choice: 'M4 4h16v16H4zM8 12l3 3 5-6',
  date: 'M4 6h16v15H4zM4 11h16M8 3v5M16 3v5',
  page_break: 'M4 5h16M4 19h16M4 12h3M10.5 12h3M17 12h3',
  ending: 'M6 21V4h12l-3 4 3 4H6',
  plus: 'M12 5v14M5 12h14',
  design: 'M12 3s7 7.5 7 12a7 7 0 0 1-14 0c0-4.500 7-12 7-12z',
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
  page: 'M4 5h16M4 10h16M4 15h10M4 20h10',
  contact_info: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.500-6 8-6s8 2 8 6',
  chevron: 'M6 9l6 6 6-6',
  edit: 'M4 20h4L19 9l-4-4L4 16zM13.500 6.500l4 4',
  play: 'M7 4l13 8-13 8z',
  forms: 'M4 5h16v14H4zM8 9h8M8 13h5'
};

export const formIcon = name => raw(`<svg class="f-icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${PATHS[name]}"/></svg>`);

// Question families share a pastel badge, so a form's shape can be read down the outline.
export const TYPE_KIND = { short_text: 'text', long_text: 'text', email: 'contact', phone: 'contact', single_choice: 'choice', multiple_choice: 'choice', date: 'date', page_break: 'layout' };
