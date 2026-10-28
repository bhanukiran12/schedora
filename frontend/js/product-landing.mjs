import { boot, html, mount, session } from './core.mjs';
import { setTitle } from './pages.mjs';

const products = {
  meet: {
    name: 'Meet', eyebrow: 'Appointments, without the back-and-forth',
    title: 'Make room for your next appointment.',
    lead: 'For consultations, discovery calls and recurring sessions: publish your availability, let the client choose a time and keep changes understandable.',
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
    steps: ['Add relevant questions and choose classic or conversational presentation.', 'Preview the questions and logic before publishing.', 'Review responses; optionally offer a Meet booking or add a Flow action.'],
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
    question: 'How do I know whether a flow worked?', answer: 'Review run history for queued, completed or failed actions. A completed email action is separate from delivery: an outbox stores messages locally, while a connected email provider reports delivery separately.'
  }
};

export function productLanding(ctx) {
  const key = ctx.params[0];
  const product = products[key];
  const headline = { meet: html`Make room for your <em>next appointment.</em>`, forms: html`Good questions.<br><em>Clear answers.</em>`, flow: html`Keep the <em>next step</em> moving.` }[key];
  setTitle(`${product.name} by Schedora · ${product.eyebrow}`);
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = product.lead;
  for (const [property, content] of [['og:title', document.title], ['og:description', product.lead]]) {
    const meta = document.querySelector(`meta[property="${property}"]`);
    if (meta) meta.content = content;
  }
  mount(ctx.main, html`<div class="container product-landing">
    <section class="landing-hero">
      <div><p class="landing-eyebrow">${product.eyebrow}</p>
        <h1>${headline}</h1><p class="lead">${key === 'meet' ? 'For discovery calls, consultations and sessions: share availability, confirm the time and give clients a clear way to change it.' : key === 'forms' ? 'Collect the context for a useful next step. Choose a classic form or one question at a time to suit the task.' : 'Start with a booking or response. Create a task or queue an email, then check what actually happened.'}</p>
        <div class="actions"><a class="btn btn-primary" href="${session.user ? boot.links[key] : `/account?mode=signup&product=${key}&next=${encodeURIComponent('/' + key)}`}">${session.user ? 'Go to workspace' : 'Get started with ' + product.name} →</a><a class="landing-text-link" href="#product-demo">See it in action →</a></div>
        <p class="muted landing-note">${key === 'meet' ? 'Create a booking page and preview it before sharing.' : key === 'forms' ? 'Preview your questions before publishing.' : 'Simulate your saved flow before enabling it.'}</p>
      </div>
      <figure class="product-image"><a href="/demo/${key}" aria-label="Explore the ${product.name} demo"><img src="/images/${key}-workspace.webp" width="926" height="1400" alt="${product.name} workspace preview showing ${key === 'meet' ? 'appointments, booking links and availability' : key === 'forms' ? 'forms and collected responses' : 'workflows and sample run history'}" fetchpriority="high"></a><figcaption>${product.name} workspace · Sample data <a href="/demo/${key}">Explore demo →</a></figcaption></figure>
    </section>
    <section class="landing-section product-showcase" id="product-demo" aria-labelledby="showcase-title"><div class="row-between"><div><p class="landing-eyebrow">${product.name.toUpperCase()} IN ACTION · INTERACTIVE PREVIEW</p><h2 id="showcase-title">${key === 'meet' ? 'A booking page that makes time feel simple.' : key === 'forms' ? 'Ask in the format that fits the task.' : 'Watch an event become a useful next step.'}</h2></div><a class="btn" href="/demo/${key}">Explore the full workspace →</a></div><div id="product-showcase"></div></section>
    <section class="landing-section" id="features"><p class="landing-eyebrow">Made for your everyday</p><h2>${key === 'meet' ? 'Your availability. Your booking experience.' : key === 'forms' ? 'Your questions. A better way to answer.' : 'Your trigger. Your next step, handled.'}</h2>
      <div class="landing-features">${product.features.map(([title, text]) => html`<article><h3>${title}</h3><p>${text}</p></article>`)}</div>
    </section>
    <section class="landing-section" id="how-it-works"><p class="landing-eyebrow">Simple from the start</p><h2>Make your first ${key === 'meet' ? 'appointment' : key === 'forms' ? 'form' : 'flow'} happen.</h2>
      <ol class="landing-steps">${product.steps.map(text => html`<li>${text}</li>`)}</ol>
    </section>
    <section class="landing-section landing-faq"><h2>A few things to know</h2><details><summary>${product.question}</summary><p>${product.answer}</p></details><details><summary>Do I need a separate Schedora account?</summary><p>No. Your Schedora account works across Meet, Forms and Flow. <a href="/billing">See plans and availability</a>.</p></details></section>
    <section class="landing-final"><h2>Make space for what comes next.</h2><p>Start with ${product.name}. Connect the rest when you need them.</p><div class="actions"><a class="btn btn-primary" href="${session.user ? boot.links[key] : `/account?mode=signup&product=${key}&next=${encodeURIComponent('/' + key)}`}">${session.user ? 'Go to workspace' : 'Get started with ' + product.name} →</a><a class="btn" href="${boot.links.suite}">Explore the suite</a></div></section>
  </div>`);
  const stage = ctx.main.querySelector('#product-showcase');
  let chosenDay = 'Monday';
  const draw = (done = false) => {
    mount(stage, key === 'meet' ? html`<div class="showcase-layout"><aside><span class="showcase-kicker">YOUR BOOKING EXPERIENCE</span><h3>Discovery call</h3><p>A little time to explore what comes next.</p><span class="tag">30 minutes · Google Meet</span><p>Sample availability · Asia/Kolkata</p></aside><div><h3>Choose your day</h3><div class="showcase-days">${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map(day => html`<button class="btn ${day === chosenDay ? 'btn-primary' : ''}" data-day="${day}" aria-pressed="${day === chosenDay}">${day}</button>`)}</div><h3>Available times · ${chosenDay}</h3><div class="showcase-slots">${['09:00', '10:30', '14:00', '15:30'].map(time => html`<button class="btn" data-time="${time}">${time}</button>`)}</div><p class="showcase-feedback" role="status">Choose a time to see the next step. No real appointment is created.</p></div></div>` : key === 'forms' ? html`<div class="showcase-layout"><aside><span class="showcase-kicker">CLIENT INTAKE</span><h3>A few good questions.<br>A better starting point.</h3><p>One question at a time, with room for a thoughtful answer.</p><span class="tag">Conversational forms</span></aside><div><p class="landing-eyebrow">${done ? 'READY FOR YOUR NEXT STEP' : 'QUESTION 1 OF 3'}</p><h3>${done ? 'A good answer starts something.' : 'What would you like to work on?'}</h3>${done ? html`<p>Your sample selection is ready. Explore the builder to create your own questions.</p><a class="btn btn-primary" href="/demo/forms/edit/client-intake">Open the form builder →</a>` : html`<form id="showcase-form"><label>Project type<select name="project" required><option value="">Choose a project</option><option>Brand identity</option><option>Website design</option><option>A new idea</option></select></label><button class="btn btn-primary">Continue →</button></form>`}<p class="showcase-feedback">Local demonstration · No response is submitted.</p></div></div>` : html`<div class="showcase-layout"><aside><span class="showcase-kicker">CLIENT WELCOME</span><h3>One trigger.<br>Less manual follow-up.</h3><p>Connect a booking to the next useful action.</p><button class="btn btn-primary" id="showcase-run">${done ? 'Run again' : 'Run sample workflow'} →</button></aside><div class="showcase-flow">${[['Meet', 'Appointment booked'], ['Forms', 'Intake prepared'], ['Flow', 'Follow-up task created']].map(([name, title], index) => html`<div><span class="landing-step">${index + 1}</span><div><small>${name}</small><h3>${title}</h3></div><span class="tag">${done ? 'Simulated' : 'Ready'}</span></div>`)}<p class="showcase-feedback" role="status">${done ? 'Sample run complete. No email was sent or external action performed.' : 'Preview the sequence without connecting any services.'}</p></div></div>`);
    stage.querySelectorAll('[data-day]').forEach(button => button.onclick = () => { chosenDay = button.dataset.day; draw(); });
    stage.querySelectorAll('[data-time]').forEach(button => button.onclick = () => { stage.querySelector('.showcase-feedback').textContent = `${chosenDay} at ${button.dataset.time} selected. Open the full workspace to try the complete demo booking journey.`; });
    const form = stage.querySelector('#showcase-form');
    if (form) form.onsubmit = event => { event.preventDefault(); draw(true); };
    const run = stage.querySelector('#showcase-run');
    if (run) run.onclick = () => draw(true);
  };
  draw();
}
