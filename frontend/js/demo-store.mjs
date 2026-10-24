// The design preview has its own local data boundary. It never calls a service or stores credentials.
export const DEMO_KEY = 'schedora.design-preview.v1';
export const makeDemo = () => ({
  version: 1, profile: { name: 'Alex Morgan', email: 'alex@example.com', workspace: 'Northstar Studio' },
  products: ['meet'], calendar: false, timezone: 'Asia/Kolkata',
  hours: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, i) => ({ day, enabled: i < 5, start: '09:00', end: '17:00' })),
  events: [
    { id: 'discovery', title: 'Discovery call', duration: 30, location: 'Google Meet', description: 'A quick conversation about your goals and how we can help.', published: true, buffer: 15, notice: 2 },
    { id: 'consultation', title: 'Project consultation', duration: 45, location: 'Google Meet', description: 'Let’s talk through your next project.', published: true, buffer: 15, notice: 2 },
    { id: 'check-in', title: 'Quick check-in', duration: 15, location: 'Phone', description: 'A little time to catch up.', published: true, buffer: 5, notice: 2 }
  ],
  bookings: [
    { id: 'sample-maya', name: 'Maya Chen', email: 'maya@example.com', event: 'discovery', date: '2026-10-26', time: '10:00', status: 'confirmed' },
    { id: 'sample-daniel', name: 'Daniel Ross', email: 'daniel@example.com', event: 'consultation', date: '2026-10-26', time: '11:30', status: 'confirmed' },
    { id: 'sample-priya', name: 'Priya Shah', email: 'priya@example.com', event: 'discovery', date: '2026-10-26', time: '14:00', status: 'confirmed' }
  ],
  forms: [
    { id: 'client-intake', title: 'Client intake', description: 'Connected to Discovery call', status: 'published', presentation: 'classic', fields: [{ id: 'name', label: 'Your name', type: 'text', required: true }, { id: 'email', label: 'Email address', type: 'email', required: true }, { id: 'goals', label: 'What would you like to work on?', type: 'textarea', required: true }] },
    { id: 'project-feedback', title: 'Project feedback', description: 'After every finished project', status: 'published', presentation: 'conversational', fields: [{ id: 'name', label: 'Your name', type: 'text', required: true }, { id: 'feedback', label: 'How was your experience?', type: 'textarea', required: true }] },
    { id: 'workshop-signup', title: 'Workshop signup', description: 'Community workshop · November', status: 'published', presentation: 'classic', fields: [{ id: 'name', label: 'Your name', type: 'text', required: true }, { id: 'email', label: 'Email address', type: 'email', required: true }] },
    { id: 'brand-discovery', title: 'Brand discovery', description: 'A new project questionnaire', status: 'draft', presentation: 'classic', fields: [{ id: 'name', label: 'Your name', type: 'text', required: true }] }
  ],
  responses: [
    { id: 'r1', form: 'client-intake', name: 'Maya Chen', answers: { name: 'Maya Chen', email: 'maya@example.com', goals: 'Brand identity · New launch · November' }, received: '2026-10-26T09:42:00+05:30' },
    { id: 'r2', form: 'project-feedback', name: 'Isabel Torres', answers: { name: 'Isabel Torres', feedback: 'Clear process and a thoughtful result.' }, received: '2026-10-25T16:12:00+05:30' },
    { id: 'r3', form: 'workshop-signup', name: 'Jamie Kim', answers: { name: 'Jamie Kim', email: 'jamie@example.com' }, received: '2026-10-24T11:05:00+05:30' }
  ],
  workflows: [
    { id: 'client-welcome', title: 'Client welcome', trigger: 'booking', action: 'email', status: 'active', subject: 'A little context before we meet', message: 'Thanks for booking. Please share your goals before our conversation.' },
    { id: 'project-wrap-up', title: 'Project wrap-up', trigger: 'response', action: 'task', status: 'active', subject: 'Review project feedback', message: 'Review the latest response and prepare the next step.' },
    { id: 'workshop-follow-up', title: 'Workshop follow-up', trigger: 'response', action: 'email', status: 'active', subject: 'Thanks for joining', message: 'Here is your next step.' },
    { id: 'new-lead', title: 'New lead handoff', trigger: 'response', action: 'task', status: 'draft', subject: 'Follow up with your new lead', message: '' }
  ],
  runs: [
    { id: '1048', workflow: 'client-welcome', name: 'Maya Chen', status: 'success', detail: 'Meeting brief ready · Sample run' },
    { id: '1047', workflow: 'client-welcome', name: 'Daniel Ross', status: 'success', detail: 'Meeting brief ready · Sample run' },
    { id: '1046', workflow: 'workshop-follow-up', name: 'Workshop attendee', status: 'failed', detail: 'Required field missing: email' },
    { id: '1045', workflow: 'workshop-follow-up', name: 'Workshop attendee', status: 'failed', detail: 'Required field missing: email' }
  ], tasks: [], people: [{ name: 'Alex Morgan', email: 'alex@example.com', role: 'Owner' }]
});

export function loadDemo(storage) {
  try {
    const value = JSON.parse(storage.getItem(DEMO_KEY));
    if (value?.version === 1 && ['events', 'bookings', 'forms', 'responses', 'workflows', 'runs', 'hours', 'people', 'tasks'].every(key => Array.isArray(value[key])) && value.profile) return value;
  } catch { /* Corrupt or unavailable storage starts a clean in-memory preview. */ }
  return makeDemo();
}
export function saveDemo(storage, value) {
  try { storage.setItem(DEMO_KEY, JSON.stringify(value)); return true; } catch { return false; }
}
export function validateHours(hours) {
  return hours.every(day => !day.enabled || (/^\d{2}:\d{2}$/.test(day.start) && /^\d{2}:\d{2}$/.test(day.end) && day.start < day.end));
}
export function demoSlots(data, event, date, excludeBooking = null) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return [];
  const weekday = new Date(date + 'T12:00:00Z').getUTCDay();
  const day = data.hours[(weekday + 6) % 7];
  if (!day?.enabled) return [];
  const minutes = time => { const [hours, mins] = time.split(':').map(Number); return hours * 60 + mins; };
  const slots = [];
  for (let minute = minutes(day.start); minute + event.duration <= minutes(day.end); minute += 30) {
    const taken = data.bookings.some(booking => {
      if (booking.id === excludeBooking || booking.date !== date || booking.status !== 'confirmed') return false;
      const booked = data.events.find(item => item.id === booking.event);
      const at = minutes(booking.time);
      return minute < at + (booked?.duration || 30) + (booked?.buffer || 0) && minute + event.duration + (event.buffer || 0) > at;
    });
    if (!taken) slots.push(`${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`);
  }
  return slots;
}
export function csvCell(value) { return '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"'; }
export function simulateWorkflow(data, workflow, payload = {}) {
  const failed = workflow.action === 'email' && !payload.email;
  const run = { id: crypto.randomUUID(), workflow: workflow.id, name: payload.name || 'Demo contact', status: failed ? 'failed' : 'success', detail: failed ? 'Required field missing: email' : `${workflow.action === 'email' ? 'Email preview prepared; nothing sent' : 'Local task created'} · Simulation` };
  data.runs.unshift(run);
  if (!failed && workflow.action === 'task') data.tasks.unshift({ id: run.id, title: workflow.subject, done: false });
  return run;
}
