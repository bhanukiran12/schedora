import { boot, html, mount } from './core.mjs';
import { setTitle } from './pages.mjs';

const products = {
  meet: {
    name: 'Meet', eyebrow: 'Appointments, without the back-and-forth',
    title: 'Make room for your next appointment.',
    lead: 'Share your availability. Let people choose a time. Keep the details, reminders and changes in one place.',
    features: [
      ['Your time, your availability', 'Set appointment durations, working hours and buffers. Share one booking link instead of exchanging messages.'],
      ['Keep calendars connected', 'Connect Google Calendar to check busy times and add Google Meet details to your appointments.'],
      ['Make changes easier', 'Give invitees a way to reschedule or cancel, with confirmations and reminders that keep everyone informed.']
    ],
    steps: ['Set your availability and connect your calendar.', 'Share your booking link wherever people find you.', 'Manage upcoming appointments from your Meet workspace.'],
    preview: ['30-minute appointment', 'Choose a time that works for you.', '09:00', '10:30', '14:00'],
    question: 'Can I connect Google Calendar?', answer: 'Yes. Connect your Google account from Meet’s calendar settings to check availability and create calendar events.'
  },
  forms: {
    name: 'Forms', eyebrow: 'A better way to ask',
    title: 'Good questions. Clear answers.',
    lead: 'Turn a request, an intake or a bit of curiosity into a form people can follow. Keep every response ready for what comes next.',
    features: [
      ['Choose how you ask', 'Build a classic form or a conversational experience that guides people through one question at a time.'],
      ['Keep questions relevant', 'Use conditional logic to show the questions that matter, with validation to help people submit complete answers.'],
      ['Put answers to work', 'Publish a link, embed your form on your website, review responses and export them when you need to.']
    ],
    steps: ['Add your questions and choose a form style.', 'Publish your form and share or embed it.', 'Review responses and connect the next step with Flow.'],
    preview: ['What brings you here?', '01 / 03 · A little about you', 'I’d like to work together', 'I have a question', 'I’m exploring an idea'],
    question: 'Can I put a form on my website?', answer: 'Yes. Use the published form link or its embed option to collect responses from your own website.'
  },
  flow: {
    name: 'Flow', eyebrow: 'From an event to a next step',
    title: 'Keep the next step moving.',
    lead: 'A new appointment. A new response. Give it a useful next step with an email or a task, and see how the run went.',
    features: [
      ['Start with something happening', 'Use a Meet booking or a Forms response as the starting point for your automation.'],
      ['Give it a useful next step', 'Configure a follow-up email or create a task using the details from the event.'],
      ['See what happened', 'Review run history and statuses, find failures and retry eligible runs from your workspace.']
    ],
    steps: ['Choose the event that starts your flow.', 'Configure the email or task that follows.', 'Enable your flow and follow its run history.'],
    preview: ['Your follow-up, connected', 'A small flow for the next step.', 'New form response', 'Send a follow-up email', 'Review run history'],
    question: 'How do I know whether a flow worked?', answer: 'Flow keeps a history of runs and their statuses, so you can review completed actions and investigate failures.'
  }
};

export function productLanding(ctx) {
  const key = ctx.params[0];
  const product = products[key];
  setTitle(`${product.name} by Schedora · ${product.eyebrow}`);
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = product.lead;
  for (const [property, content] of [['og:title', document.title], ['og:description', product.lead]]) {
    const meta = document.querySelector(`meta[property="${property}"]`);
    if (meta) meta.content = content;
  }
  mount(ctx.main, html`<div class="container product-landing">
    <section class="landing-hero">
      <div>${ctx.lockup(key, true)}<p class="landing-eyebrow">${product.eyebrow}</p>
        <h1>${product.title}</h1><p class="lead">${product.lead}</p>
        <div class="actions"><a class="btn btn-primary" href="${boot.links[key]}">Open ${product.name} →</a><a class="btn" href="#how-it-works">How it works</a></div>
        <p class="muted landing-note">One Schedora account. Your own ${product.name} workspace.</p>
      </div>
      <div class="landing-preview" aria-label="Illustrative ${product.name} preview">
        <div class="landing-preview-bar"><span>${product.name} by Schedora</span><span class="tag">Example</span></div>
        <p class="landing-eyebrow">${product.preview[1]}</p><h2>${product.preview[0]}</h2>
        <div class="landing-example ${key}">${product.preview.slice(2).map((text, index) => html`<div><span class="landing-step">${key === 'forms' ? String.fromCharCode(65 + index) : String(index + 1).padStart(2, '0')}</span><strong>${text}</strong></div>`)}</div>
        <p class="muted landing-note">${key === 'meet' ? 'Times shown in your invitee’s time zone.' : key === 'forms' ? 'A few good questions can start something.' : 'From a new response to a useful next step.'}</p>
      </div>
    </section>
    <section class="landing-section"><p class="landing-eyebrow">Made for your everyday</p><h2>A little less busywork. A clearer next step.</h2>
      <div class="landing-features">${product.features.map(([title, text]) => html`<article><h3>${title}</h3><p>${text}</p></article>`)}</div>
    </section>
    <section class="landing-section" id="how-it-works"><p class="landing-eyebrow">Simple from the start</p><h2>Make your first ${key === 'meet' ? 'appointment' : key === 'forms' ? 'form' : 'flow'} happen.</h2>
      <ol class="landing-steps">${product.steps.map(text => html`<li>${text}</li>`)}</ol>
    </section>
    <section class="landing-section landing-connected"><div><p class="landing-eyebrow">Part of Schedora</p><h2>Better together, whenever you’re ready.</h2><p>Meet handles appointments. Forms collects answers. Flow takes care of the follow-up. Connect them under one account.</p></div>
      <div class="landing-related">${Object.entries(products).filter(([id]) => id !== key).map(([id, item]) => html`<a href="${boot.landings[id]}">${ctx.lockup(id)}<span>Explore ${item.name} →</span></a>`)}</div>
    </section>
    <section class="landing-section landing-faq"><h2>A few things to know</h2><details><summary>${product.question}</summary><p>${product.answer}</p></details><details><summary>Do I need a separate Schedora account?</summary><p>No. Your Schedora account works across Meet, Forms and Flow. <a href="/billing">See plans and availability</a>.</p></details></section>
    <section class="landing-final"><h2>Make space for what comes next.</h2><p>Start with ${product.name}. Connect the rest when you need them.</p><div class="actions"><a class="btn btn-primary" href="${boot.links[key]}">Open ${product.name} →</a><a class="btn" href="${boot.links.suite}">Explore the suite</a></div></section>
  </div>`);
}
