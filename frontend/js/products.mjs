// One product configuration for the shell, sidebar, landing, sign-in and setup screens, so the
// products never drift into inconsistent copies. Navigation lists only destinations that exist.

export const PRODUCT_INFO = {
  suite: { name: 'Schedora', short: 'Schedora', logo: '/logo-schedora.png', dashboard: '/',
    job: 'Meet, Forms and Flow under one account: book appointments, collect enquiries and track the follow-up.' },
  meet: { name: 'Meet', short: 'Meet', logo: '/logo-meet.png', dashboard: '/meet',
    job: 'Share your availability and let people book a suitable time.' },
  forms: { name: 'Forms', short: 'Forms', logo: '/logo-forms.png', dashboard: '/forms',
    job: 'Collect useful information and make the next step clear.' },
  flow: { name: 'Flow', short: 'Flow', logo: '/logo-flow.png', dashboard: '/flow',
    job: 'Turn bookings and form responses into traceable follow-up emails and tasks.' }
};

// [key, label, href, icon]. Meet sections keep their existing ?tab= addresses.
const meetTab = (key, label, icon) => [key, label, `/meet?tab=${key}`, icon];
export const NAVIGATION = {
  meet: [
    ['Scheduling', [meetTab('types', 'Event types', 'CalendarDays'), meetTab('meetings', 'Meetings', 'CalendarCheck'), meetTab('video', 'Video', 'Video'), meetTab('polls', 'Polls', 'Clock')]],
    // "Meet reminders" are Meet's own emails around a meeting; Flow is the separate automation product.
    ['People & follow-up', [meetTab('contacts', 'Contacts', 'Users'), meetTab('workflows', 'Meet reminders', 'Bell')]],
    ['Insights', [meetTab('analytics', 'Analytics', 'Activity'), meetTab('insights', 'Notes & AI', 'FileText')]],
    ['Setup', [meetTab('integrations', 'Calendars & apps', 'Plug'), meetTab('emails', 'Email delivery', 'Inbox')]]
  ],
  forms: [
    ['Forms', [['forms', 'All forms', '/forms', 'Files']]],
    ['Responses', [['enquiries', 'Enquiries', '/enquiries', 'Inbox']]]
  ],
  flow: [
    ['Automations', [['flows', 'Flows', '/flow', 'Workflow'], ['runs', 'Run history', '/flow/runs', 'History'], ['tasks', 'Tasks', '/flow/tasks', 'CheckCircle2']]],
    ['Follow-up', [['enquiries', 'Enquiries', '/enquiries', 'Inbox']]]
  ],
  suite: [
    ['Across products', [['home', 'Overview', '/', 'LayoutDashboard'], ['enquiries', 'Enquiries', '/enquiries', 'Inbox']]]
  ]
};

const MEET_TABS = new Set(NAVIGATION.meet.flatMap(([, items]) => items.map(([key]) => key)));

// The sidebar item for the current page, or null.
export function currentSection(product, path, query) {
  if (path === '/setup' || path.startsWith('/setup/')) return 'setup';
  if (path === '/account') return 'account';
  if (path === '/billing') return 'billing';
  if (path === '/enquiries') return 'enquiries';
  if (product === 'meet') {
    if (path.startsWith('/meet/event-types/')) return 'types';
    if (path.startsWith('/meet/contacts/')) return 'contacts';
    const tab = query.get('tab') === 'calendar' ? 'integrations' : query.get('tab');
    return MEET_TABS.has(tab) ? tab : 'types';
  }
  if (product === 'forms') return 'forms';
  if (product === 'flow') return /^\/flow\/(runs|tasks)$/.exec(path)?.[1] || 'flows';
  return path === '/' ? 'home' : null;
}

export function sectionLabel(product, key) {
  if (key === 'setup') return 'Guided setup';
  if (key === 'account') return 'Account & settings';
  if (key === 'billing') return 'Plans & billing';
  for (const [, items] of NAVIGATION[product] || []) for (const [id, label] of items) if (id === key) return label;
  return PRODUCT_INFO[product].name;
}
