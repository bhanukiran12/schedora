// The downloadable example for Import JSON. It uses every part of the file format once, so an author can
// copy the shape they need. backend/test/forms-definition-io.test.mjs imports it through the real
// importer, so the example can never drift from what the server accepts.
export const EXAMPLE_FILENAME = 'schedora-form-example.schedora-form.json';

export const EXAMPLE_DEFINITION_FILE = {
  format: 'schedora.form-definition',
  version: 1,
  definition: {
    title: 'Workshop registration',
    description: 'Tell us who you are and what you would like from the workshop. It takes about two minutes.',
    presentation: 'classic',
    submit_label: 'Register',
    fields: [
      { id: 'name', type: 'short_text', label: 'Your full name', required: true, placeholder: 'First and last name' },
      { id: 'email', type: 'email', label: 'Thanks, {{name}}. Which email should we use?', required: true, help: 'We send the joining details here. Nothing else.' },
      { id: 'role', type: 'single_choice', label: 'What describes you best?', required: true, options: [
        { id: 'student', label: 'Student' }, { id: 'working', label: 'Working professional' }, { id: 'other', label: 'Something else' }] },
      { id: 'role_other', type: 'short_text', label: 'Tell us your role', required: true, show_if: { field: 'role', op: 'equals', value: 'other' } },
      { id: 'page_topics', type: 'page_break', label: 'Topics', help: 'Pick what you want covered. The organisers plan the agenda from these answers.' },
      { id: 'topics', type: 'multiple_choice', label: 'Which topics interest you?', required: true, options: [
        { id: 'basics', label: 'The basics' }, { id: 'advanced', label: 'Advanced techniques' }, { id: 'career', label: 'Career guidance' }] },
      { id: 'experience', type: 'single_choice', label: 'Have you attended one of our workshops before?', required: false, options: [
        { id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
      { id: 'feedback', type: 'long_text', label: 'What should we do differently this time?', required: false },
      { id: 'page_contact', type: 'page_break', label: 'How to reach you', grouped: true },
      { id: 'phone', type: 'phone', label: 'Phone number', required: false, group: 'page_contact' },
      { id: 'date', type: 'date', label: 'Preferred start date', required: false, group: 'page_contact' }
    ],
    logic: [
      { field: 'experience', rules: [{ when: { field: 'experience', op: 'equals', value: 'no' }, to: { type: 'group', id: 'page_contact' } }] }
    ],
    endings: [
      { id: 'registered', title: 'You are registered', message: 'We will email the joining details a day before the workshop.' }
    ],
    theme: { name: 'Example theme', font: 'system', question_size: 'large' }
  }
};
