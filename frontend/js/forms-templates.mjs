// Goal-based starting points for Forms. Plain data using only the supported field schema
// (short/long text, email, phone, single/multiple choice, date, page break, show_if), so the
// server validates them like any draft. Choosing one creates an unpublished draft to edit.
// Questions are kept short and ask only for what the next step needs.

const option = (id, label) => ({ id, label });

export const FORM_TEMPLATES = [
  {
    id: 'consultation',
    name: 'Consultation request',
    audience: 'Consultants and coaches',
    purpose: 'Learn what someone needs before a first call.',
    logic: 'Asks for more detail only when “Something else” is chosen.',
    definition: {
      title: 'Consultation request',
      description: 'Tell us a little about what you need so the first conversation is useful. It takes about two minutes.',
      presentation: 'classic', submit_label: 'Send request',
      fields: [
        { id: 'name', type: 'short_text', label: 'Your name', required: true },
        { id: 'email', type: 'email', label: 'Email address', help: 'We reply here.', required: true },
        { id: 'topic', type: 'single_choice', label: 'What would you like help with?', required: true,
          options: [option('strategy', 'Planning or strategy'), option('delivery', 'Doing the work'), option('review', 'A second opinion'), option('other', 'Something else')] },
        { id: 'topic_other', type: 'short_text', label: 'What would you like help with?', help: 'A few words are enough.', required: true, show_if: { field: 'topic', op: 'equals', value: 'other' } },
        { id: 'goal', type: 'long_text', label: 'What would a good outcome look like for you?', required: false },
        { id: 'timing', type: 'single_choice', label: 'When would you like to start?', required: false,
          options: [option('now', 'As soon as possible'), option('month', 'Within a month'), option('later', 'Later or not sure')] }
      ]
    }
  },
  {
    id: 'project-brief',
    name: 'Project brief',
    audience: 'Small agencies and studios',
    purpose: 'Collect scope, budget and timing before you quote.',
    logic: 'Skips the website question when there is no existing site.',
    definition: {
      title: 'Project brief',
      description: 'Share the essentials of your project. We review every brief and reply with next steps.',
      presentation: 'classic', submit_label: 'Send brief',
      fields: [
        { id: 'name', type: 'short_text', label: 'Your name', required: true },
        { id: 'email', type: 'email', label: 'Work email', required: true },
        { id: 'company', type: 'short_text', label: 'Company or organisation', required: false },
        { id: 'project_type', type: 'single_choice', label: 'What kind of project is it?', required: true,
          options: [option('brand', 'Brand or identity'), option('website', 'Website'), option('campaign', 'Campaign or content'), option('other', 'Something else')] },
        { id: 'has_site', type: 'single_choice', label: 'Do you have an existing website?', required: true, options: [option('yes', 'Yes'), option('no', 'No')] },
        { id: 'site_url', type: 'short_text', label: 'Website address', required: false, show_if: { field: 'has_site', op: 'equals', value: 'yes' } },
        { id: 'details', type: 'page_break', label: '' },
        { id: 'brief', type: 'long_text', label: 'Describe the project and what success looks like', required: true },
        { id: 'budget', type: 'single_choice', label: 'Approximate budget', help: 'A range helps us suggest a realistic scope.', required: false,
          options: [option('small', 'Under ₹50,000'), option('medium', '₹50,000–₹2,00,000'), option('large', 'Over ₹2,00,000'), option('unsure', 'Not sure yet')] },
        { id: 'deadline', type: 'date', label: 'Any fixed deadline?', required: false }
      ]
    }
  },
  {
    id: 'programme-interest',
    name: 'Programme enquiry',
    audience: 'Training and consultation teams',
    purpose: 'Record interest in a course or programme and the preferred format.',
    logic: 'Registering interest does not reserve a seat; say so in your reply.',
    definition: {
      title: 'Programme enquiry',
      description: 'Register your interest and we will contact you with dates and next steps. This does not reserve a place.',
      presentation: 'classic', submit_label: 'Register interest',
      fields: [
        { id: 'name', type: 'short_text', label: 'Full name', required: true },
        { id: 'email', type: 'email', label: 'Email address', required: true },
        { id: 'phone', type: 'phone', label: 'Phone number', help: 'Optional, if you prefer a call.', required: false },
        { id: 'programme', type: 'single_choice', label: 'Which programme are you interested in?', required: true,
          options: [option('programme_a', 'Programme A'), option('programme_b', 'Programme B'), option('not_sure', 'Not sure yet')] },
        { id: 'format', type: 'multiple_choice', label: 'Which formats would work for you?', required: false,
          options: [option('online', 'Online'), option('in_person', 'In person'), option('weekend', 'Weekends')] },
        { id: 'questions', type: 'long_text', label: 'Any questions for us?', required: false }
      ]
    }
  },
  {
    id: 'session-feedback',
    name: 'Session feedback',
    audience: 'Coaches and educators',
    purpose: 'Hear how a session went and who wants a follow-up.',
    logic: 'Asks for an email address only when someone wants a reply.',
    definition: {
      title: 'Session feedback',
      description: 'Thank you for your time. Your feedback helps us improve the next session.',
      presentation: 'conversational', submit_label: 'Send feedback',
      fields: [
        { id: 'rating', type: 'single_choice', label: 'How useful was the session?', required: true,
          options: [option('very', 'Very useful'), option('somewhat', 'Somewhat useful'), option('not', 'Not useful')] },
        { id: 'worked', type: 'long_text', label: 'What worked well?', required: false },
        { id: 'improve', type: 'long_text', label: 'What should we change?', required: false },
        { id: 'follow_up', type: 'single_choice', label: 'Would you like us to follow up with you?', required: true, options: [option('yes', 'Yes, please'), option('no', 'No, thanks')] },
        { id: 'email', type: 'email', label: 'Where should we reply?', required: true, show_if: { field: 'follow_up', op: 'equals', value: 'yes' } }
      ]
    }
  }
];

export const questionCount = definition => definition.fields.filter(field => field.type !== 'page_break').length;
