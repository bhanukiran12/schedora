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
  },
  // Sales and client meetings (docs/MVS_SALES_CLIENT_MEETINGS.md). Shown first in the gallery;
  // appended here so existing ids and the onboarding default keep their place.
  {
    id: 'sales-discovery',
    group: 'meetings',
    name: 'Sales discovery',
    audience: 'Sales and account teams',
    purpose: 'Understand goals, the current approach and timing before or during a first conversation.',
    logic: 'Asks what else matters only when “Something else” is ticked.',
    definition: {
      title: 'Before we talk',
      description: 'A few questions so our conversation focuses on what matters to you. It takes about three minutes.',
      presentation: 'classic', submit_label: 'Send answers',
      fields: [
        { id: 'name', type: 'short_text', label: 'Your name', required: true },
        { id: 'email', type: 'email', label: 'Work email', required: true },
        { id: 'company', type: 'short_text', label: 'Company or organisation', required: false },
        { id: 'goal', type: 'long_text', label: 'What are you hoping to achieve?', required: true },
        { id: 'current', type: 'long_text', label: 'How do you handle this today?', help: 'Tools, people or workarounds. A sentence or two is enough.', required: false },
        { id: 'priorities', type: 'multiple_choice', label: 'What matters most in a solution?', required: false,
          options: [option('ease', 'Easy for the team to use'), option('integrations', 'Works with tools we already use'), option('cost', 'Cost'), option('support', 'Support and onboarding'), option('other', 'Something else')] },
        { id: 'priorities_other', type: 'short_text', label: 'What else matters to you?', required: false, show_if: { field: 'priorities', op: 'contains', value: 'other' } },
        { id: 'timing', type: 'single_choice', label: 'When do you need something in place?', required: true,
          options: [option('month', 'Within a month'), option('quarter', 'Within three months'), option('exploring', 'Later, or just exploring')] }
      ]
    }
  },
  {
    id: 'demo-request',
    group: 'meetings',
    name: 'Demo request',
    audience: 'Teams that run product demos',
    purpose: 'Learn what someone wants to see so the demo covers it.',
    logic: 'Asks for detail only when “Something else” is chosen.',
    definition: {
      title: 'Request a demo',
      description: 'Tell us what you would like to see. We will reply to arrange a time; nothing is booked by sending this form.',
      presentation: 'classic', submit_label: 'Request demo',
      fields: [
        { id: 'name', type: 'short_text', label: 'Your name', required: true },
        { id: 'email', type: 'email', label: 'Work email', required: true },
        { id: 'company', type: 'short_text', label: 'Company or organisation', required: false },
        { id: 'team_size', type: 'single_choice', label: 'How many people would use it?', required: false,
          options: [option('solo', 'Just me'), option('small', '2–10'), option('medium', '11–50'), option('large', 'More than 50')] },
        { id: 'reason', type: 'single_choice', label: 'What best describes your situation?', required: true,
          options: [option('replace', 'Replacing a current tool'), option('new', 'Starting something new'), option('compare', 'Comparing options'), option('other', 'Something else')] },
        { id: 'reason_other', type: 'short_text', label: 'Tell us a little more', required: true, show_if: { field: 'reason', op: 'equals', value: 'other' } },
        { id: 'focus', type: 'long_text', label: 'What would you most like to see in the demo?', required: true }
      ]
    }
  },
  {
    id: 'client-onboarding',
    group: 'meetings',
    name: 'Client onboarding',
    audience: 'Agencies, consultants and service teams',
    purpose: 'Collect the project brief, contacts and preferences before a kickoff meeting.',
    logic: 'Asks for a phone number only when someone prefers phone calls.',
    definition: {
      title: 'Project kickoff brief',
      description: 'Help us prepare for kickoff. Share what you can now; we will go through the rest together.',
      presentation: 'classic', submit_label: 'Send brief',
      fields: [
        { id: 'name', type: 'short_text', label: 'Your name', required: true },
        { id: 'email', type: 'email', label: 'Email address', required: true },
        { id: 'company', type: 'short_text', label: 'Company or organisation', required: false },
        { id: 'contact_pref', type: 'single_choice', label: 'How should we keep in touch?', required: true,
          options: [option('email', 'Email'), option('phone', 'Phone calls'), option('video', 'Video calls')] },
        { id: 'phone', type: 'phone', label: 'Phone number', required: true, show_if: { field: 'contact_pref', op: 'equals', value: 'phone' } },
        { id: 'project', type: 'page_break', label: '' },
        { id: 'goals', type: 'long_text', label: 'What are the main goals for this project?', required: true },
        { id: 'stakeholders', type: 'long_text', label: 'Who else should we involve?', help: 'Names and roles are enough.', required: false },
        { id: 'materials', type: 'long_text', label: 'What should we have before we start?', help: 'For example brand files, documents or access we need to request. Please do not paste passwords here.', required: false },
        { id: 'start', type: 'date', label: 'Preferred start date', required: false }
      ]
    }
  },
  {
    id: 'client-review',
    group: 'meetings',
    name: 'Client review',
    audience: 'Account and delivery teams',
    purpose: 'Check progress, blockers and satisfaction before a review or renewal conversation.',
    logic: 'Asks what to improve unless someone is very satisfied, and asks for an email only when they want a call.',
    definition: {
      title: 'How are we doing?',
      description: 'Your answers help us prepare for our next review. It takes about two minutes.',
      presentation: 'conversational', submit_label: 'Send feedback',
      fields: [
        { id: 'name', type: 'short_text', label: 'Your name', required: true },
        { id: 'satisfaction', type: 'single_choice', label: 'Overall, how satisfied are you with our work so far?', required: true,
          options: [option('very', 'Very satisfied'), option('satisfied', 'Satisfied'), option('neutral', 'Neither satisfied nor dissatisfied'), option('dissatisfied', 'Dissatisfied')] },
        { id: 'going_well', type: 'long_text', label: 'What is going well?', required: false },
        { id: 'improve', type: 'long_text', label: 'What should we do differently?', required: false, show_if: { field: 'satisfaction', op: 'not_equals', value: 'very' } },
        { id: 'blockers', type: 'long_text', label: 'Is anything blocking progress, on your side or ours?', required: false },
        { id: 'call', type: 'single_choice', label: 'Would you like a call to talk this through?', required: true, options: [option('yes', 'Yes, please'), option('no', 'No, thanks')] },
        { id: 'email', type: 'email', label: 'Where should we contact you?', required: true, show_if: { field: 'call', op: 'equals', value: 'yes' } }
      ]
    }
  }
];

export const questionCount = definition => definition.fields.filter(field => field.type !== 'page_break').length;
