import { fail } from '../http.mjs';
import { createDraft } from './manage.mjs';

// The eight job templates (docs/FLOW_V1_IMPLEMENTATION.md, "Templates"). Each creates an editable,
// unpublished, inactive draft. Bindings (form, event type, workbook, people) fill in what the author
// chooses; anything missing is reported by publish validation, never guessed.

const TEMPLATES = [
  {
    id: 'speed_to_lead', job: 'leads', name: 'Speed-to-lead',
    summary: 'When an enquiry arrives, send a booking link at once. If they have not booked a day later, give the owner a call task.',
    needs: ['form', 'event_type'],
    build: b => ({
      trigger: { type: 'forms.response.created', ...(b.form ? { source: b.form } : {}) },
      steps: [
        { id: 'link', type: 'action', action: 'send_booking_link', config: { to: 'contact', event_type: b.event_type || '', subject: 'Thanks, {{contact.name}}: choose a time to talk', body: 'Hi {{contact.name}},\n\nThanks for getting in touch. Pick a time that suits you and we will be ready for the call.' } },
        { id: 'booked', type: 'wait_for', event: 'meet.booking.created', timeout_minutes: 1440 },
        { id: 'check', type: 'branch', paths: [
          { id: 'yes', label: 'Booked', match: 'all', rules: [{ field: 'steps.booked.happened', op: 'equals', value: 'yes' }], steps: [] },
          { id: 'no', label: 'Not booked', rules: [], steps: [{ id: 'call', type: 'action', action: 'create_task', config: { title: 'Call {{contact.name}}: enquiry not booked', details: 'Email: {{contact.email}}\nPhone: {{contact.phone}}\nThey had a booking link for a day and have not booked.', assign_to: 'owner', due_in_hours: 4 } }] }
        ] }
      ]
    })
  },
  {
    id: 'reminders_no_show', job: 'meetings', name: 'Reminders and no-show recovery',
    summary: 'Remind the guest an hour before. A day after the meeting, if the host marked a no-show, send a rebooking link and give the host a task.',
    needs: ['event_type'],
    note: 'Meet’s own reminder emails keep their schedule; this adds one an hour before. Leave “Email a rebooking link” unticked when marking a no-show, so the guest gets only this workflow’s link.',
    build: b => ({
      trigger: { type: 'meet.booking.before_start', ...(b.event_type ? { source: b.event_type } : {}), config: { minutes: 60 } },
      steps: [
        { id: 'remind', type: 'action', action: 'send_email', config: { to: 'contact', subject: 'Reminder: {{event.title}} at {{booking.start}}', body: 'Hi {{contact.name}},\n\nA reminder that {{event.title}} with {{host.name}} starts at {{booking.start}}.' } },
        { id: 'after', type: 'wait', mode: 'duration', minutes: 1500 },
        { id: 'attended', type: 'branch', paths: [
          { id: 'missed', label: 'Marked no-show', match: 'all', rules: [{ field: 'attendance', op: 'equals', value: 'no_show' }], steps: [
            { id: 'rebook', type: 'action', action: 'send_booking_link', config: { to: 'contact', event_type: b.event_type || '', subject: 'Sorry we missed you: book another time', body: 'Hi {{contact.name}},\n\nWe missed you at {{event.title}}. Choose another time that works for you.' } },
            { id: 'followup', type: 'action', action: 'create_task', config: { title: 'Follow up on no-show: {{contact.name}}', details: 'Missed {{event.title}} at {{booking.start}}. A rebooking link was sent.', assign_to: 'host', due_in_hours: 24 } }
          ] },
          { id: 'fine', label: 'Otherwise', rules: [], steps: [] }
        ] }
      ]
    })
  },
  {
    id: 'meeting_prep', job: 'meetings', name: 'Meeting preparation',
    summary: 'When someone books, give the host a preparation task with their form answers and private lead score.',
    needs: ['event_type'],
    build: b => ({
      trigger: { type: 'meet.booking.created', ...(b.event_type ? { source: b.event_type } : {}) },
      steps: [{ id: 'prep', type: 'action', action: 'create_task', config: { title: 'Prepare for {{contact.name}} ({{booking.start}})', details: 'Lead priority: {{lead.band}} ({{lead.score}} points)\n\nTheir answers:\n{{form.answers}}', assign_to: 'host', due_in_hours: 2 } }]
    })
  },
  {
    id: 'after_meeting', job: 'meetings', name: 'After-meeting follow-up',
    summary: 'When a meeting’s scheduled end time passes, AI drafts a follow-up from the meeting recap. The host reviews and approves it before it is emailed, then a next-step task is created.',
    needs: ['event_type'],
    build: b => ({
      trigger: { type: 'meet.booking.ended', ...(b.event_type ? { source: b.event_type } : {}) },
      steps: [
        { id: 'draft', type: 'action', action: 'ai_draft', config: { instruction: 'Write a short follow-up email to {{contact.name}} after {{event.title}}. Use only the meeting recap below; if there is no recap, write a brief thank-you without details.\n\nRecap: {{meeting.recap}}' } },
        { id: 'review', type: 'approval', approver: 'host', expires_hours: 72, title: 'Follow-up email to the guest' },
        { id: 'send', type: 'action', action: 'send_email', config: { to: 'contact', subject: 'Following up on {{event.title}}', body: '{{steps.draft.text}}' } },
        { id: 'next', type: 'action', action: 'create_task', config: { title: 'Next step with {{contact.name}}', details: 'Follow-up sent after {{event.title}}.', assign_to: 'host', due_in_hours: 72 } }
      ]
    })
  },
  {
    id: 'routing', job: 'leads', name: 'Routing and ownership',
    summary: 'When a Hot lead arrives, assign an owner in turn and email them straight away.',
    needs: ['form', 'members'],
    build: b => ({
      trigger: { type: 'forms.response.created', ...(b.form ? { source: b.form } : {}) },
      steps: [
        { id: 'hot', type: 'condition', match: 'all', rules: [{ field: 'lead.band', op: 'equals', value: 'Hot' }] },
        { id: 'assign', type: 'action', action: 'assign_owner', config: { mode: 'round_robin', members: b.members?.length ? b.members : [] } },
        { id: 'notify', type: 'action', action: 'send_email', config: { to: 'owner', subject: 'New hot lead for you: {{contact.name}}', body: '{{contact.name}} ({{contact.email}}) is a Hot lead ({{lead.score}} points). You are now their owner.' } }
      ]
    })
  },
  {
    id: 'sheets_status', job: 'sheets', name: 'Status change in Sheets',
    summary: 'When a row’s Status becomes Enrolled, send a welcome email and the onboarding form, then mark the row.',
    needs: ['workbook', 'sheet', 'onboarding_form'],
    note: 'Row 1 of the sheet needs the columns Status, Email and Welcome sent.',
    build: b => ({
      trigger: { type: 'sheets.cell.changed', ...(b.workbook ? { source: b.workbook } : {}), config: { sheet: b.sheet || '', column: 'Status', value: 'Enrolled' } },
      steps: [
        { id: 'welcome', type: 'action', action: 'send_email', config: { to: 'contact', subject: 'Welcome, {{contact.name}}', body: 'Hi {{contact.name}},\n\nWelcome aboard. We will be in touch with your next steps.' } },
        { id: 'onboard', type: 'action', action: 'send_form', config: { to: 'contact', form: b.onboarding_form || '', prefill: {}, subject: 'Your onboarding form', body: 'Please fill in this short form so we can get you started.' } },
        { id: 'mark', type: 'action', action: 'sheet_row', config: { workbook: b.workbook || '', sheet: b.sheet || '', mode: 'update', match_column: 'Email', match_value: '{{contact.email}}', values: { 'Welcome sent': 'Yes' } } }
      ]
    })
  },
  {
    id: 'payment_received', job: 'payments', name: 'Payment received',
    summary: 'When Razorpay confirms a form payment, mark the person as Paid in your sheet and email them a payment confirmation.',
    needs: ['form', 'workbook', 'sheet'],
    note: 'Forms already sends the WhatsApp receipt for paid responses; this workflow adds the sheet status and one email per confirmed payment, and does not resend the receipt.',
    build: b => ({
      trigger: { type: 'payments.captured', ...(b.form ? { source: b.form } : {}) },
      steps: [
        { id: 'mark', type: 'action', action: 'sheet_row', config: { workbook: b.workbook || '', sheet: b.sheet || '', mode: 'upsert', match_column: 'Email', match_value: '{{contact.email}}', values: { Email: '{{contact.email}}', Name: '{{contact.name}}', Status: 'Paid', Amount: '{{payment.amount}}' } } },
        { id: 'confirm', type: 'action', action: 'send_email', config: { to: 'contact', subject: 'Payment received: {{form.title}}', body: 'Hi {{contact.name}},\n\nWe have received your payment of ₹{{payment.amount}} for {{form.title}} (receipt {{response.reference}}). Thank you.' } }
      ]
    })
  },
  {
    id: 'feedback', job: 'meetings', name: 'Feedback loop',
    summary: 'Two days after a meeting, send the feedback form. If the rating is low, give a manager a task.',
    needs: ['event_type', 'feedback_form', 'manager'],
    note: 'The feedback form needs a rating question with the id “rating” (1–5).',
    build: b => ({
      trigger: { type: 'meet.booking.after_end', ...(b.event_type ? { source: b.event_type } : {}), config: { minutes: 2880 } },
      steps: [
        { id: 'ask', type: 'action', action: 'send_form', config: { to: 'contact', form: b.feedback_form || '', prefill: {}, subject: 'How was {{event.title}}?', body: 'Hi {{contact.name}},\n\nCould you tell us how it went? It takes a minute.' } },
        { id: 'answered', type: 'wait_for', event: 'forms.response.created', timeout_minutes: 10080, ...(b.feedback_form ? { source: b.feedback_form } : {}) },
        { id: 'score', type: 'branch', paths: [
          { id: 'low', label: 'Low rating', match: 'all', rules: [{ field: 'steps.answered.answer.rating', op: 'less_than', value: '3' }], steps: [
            { id: 'manager', type: 'action', action: 'create_task', config: { title: 'Low feedback from {{contact.name}}', details: 'Rating: {{steps.answered.answer.rating}} after {{event.title}} with {{host.name}}.', assign_to: b.manager ? 'member:' + b.manager : 'none', due_in_hours: 24 } }
          ] },
          { id: 'ok', label: 'Otherwise', rules: [], steps: [] }
        ] }
      ]
    })
  }
];

export const JOBS = { leads: 'Leads and enquiries', meetings: 'Meetings', sheets: 'Sheets', payments: 'Payments' };

export const listTemplates = () => TEMPLATES.map(({ build, ...template }) => ({ ...template, job_label: JOBS[template.job], definition: build({}) }));

export const templateDefinition = (id, bindings = {}) => {
  const template = TEMPLATES.find(item => item.id === id);
  if (!template) fail(404, 'not_found', 'Template not found.');
  return { template, definition: template.build(bindings) };
};

const BINDING = /^[A-Za-z0-9_-]{1,64}$/;
export function createFromTemplate(app, actor, body) {
  const raw = body.bindings && typeof body.bindings === 'object' ? body.bindings : {};
  const bindings = Object.fromEntries(Object.entries(raw).filter(([name, value]) => ['form', 'event_type', 'workbook', 'sheet', 'onboarding_form', 'feedback_form', 'manager'].includes(name) && typeof value === 'string' && BINDING.test(value)));
  if (Array.isArray(raw.members)) bindings.members = raw.members.filter(value => typeof value === 'string' && BINDING.test(value)).slice(0, 20);
  const { template, definition } = templateDefinition(body.template, bindings);
  return createDraft(app, actor, { name: typeof body.name === 'string' && body.name.trim() ? body.name : template.name, definition, template: template.id });
}
