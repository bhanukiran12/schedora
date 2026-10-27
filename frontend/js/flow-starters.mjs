// Starter drafts use only the trigger/action contract supported by Flow today.
export const FLOW_STARTERS = [
  { id: 'prepare-call', name: 'Prepare for a booked call', description: 'Create a preparation task when someone books.', trigger_type: 'meet.booking.created', action_type: 'task', action_config: { title: 'Prepare for {{invitee.name}}', details: '{{event.title}} · {{booking.start_host}} · Reference {{booking.reference}}' } },
  { id: 'review-intake', name: 'Review a new enquiry', description: 'Create a review task when a form is submitted.', trigger_type: 'forms.response.created', action_type: 'task', action_config: { title: 'Review {{form.title}} response', details: 'Review response {{response.id}} and decide the next step.' } },
  { id: 'notify-host', name: 'Notify the host of a booking', description: 'Send the host the booking details by email.', trigger_type: 'meet.booking.created', action_type: 'email', action_config: { to: 'host', subject: 'New booking: {{event.title}}', body: '{{invitee.name}} booked {{event.title}} for {{booking.start_host}}. Reference: {{booking.reference}}.' } }
];
