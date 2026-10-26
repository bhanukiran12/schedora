import { boot, html, mount, session } from './core.mjs';

export function setTitle(title) {
  document.title = title;
  const description = document.querySelector('meta[name="description"]');
  if (description) description.content = 'Schedora brings appointment scheduling, forms and follow-up automation together with Meet, Forms and Flow.';
  const socialTitle = document.querySelector('meta[property="og:title"]');
  const socialDescription = document.querySelector('meta[property="og:description"]');
  if (socialTitle) socialTitle.content = title;
  if (socialDescription && description) socialDescription.content = description.content;
}

// Shown in place of private product screens for signed-out visitors.
export function signInPrompt(ctx, { title, lead, product }) {
  const next = encodeURIComponent(ctx.path + (ctx.query.toString() ? '?' + ctx.query : ''));
  return html`<div class="container page">
    <div class="hero"><div>${ctx.lockup(product, true)}</div><h1>${title}</h1><p class="lead">${lead}</p>
    <div class="actions"><a class="btn btn-primary" href="/account?mode=signup&next=${next}">Create your account</a><a class="btn" href="/account?next=${next}">Sign in</a></div></div>
  </div>`;
}

export function noWorkspace(ctx) {
  mount(ctx.main, html`<div class="container page"><h1>Choose a workspace</h1><p>You are not a member of any workspace yet.</p><a class="btn btn-primary" href="/account">Create a workspace</a></div>`);
}

export const needsSession = ctx => {
  if (session.user && !session.workspaceId) { noWorkspace(ctx); return false; }
  return Boolean(session.user);
};

export async function home(ctx) {
  setTitle('Schedora · Meet, Forms & Flow');
  const cards = [
    ['meet', 'Share your availability once. Invitees pick a time in their own time zone, and you both get a confirmation.', 'Open Meet'],
    ['forms', 'Build classic or conversational forms with logic, collect responses securely and export them.', 'Open Forms'],
    ['flow', 'When someone books or responds, send the follow-up email or create the task automatically.', 'Open Flow']
  ];
  mount(ctx.main, html`<div class="container page">
    <section class="hero">
      <span class="tag">MEET · FORMS · FLOW</span>
      <h1>Good things happen when you make time.</h1>
      <p class="lead">Three focused tools for scheduling, intake and follow-up. Use one, or connect all three under one account.</p>
      <div class="actions"><a class="btn btn-primary" href="${boot.landings.meet}">Explore Meet</a>${session.user ? '' : html`<a class="btn" href="/account?mode=signup">Create a free evaluation account</a>`}</div>
    </section>
    <section class="product-grid" aria-label="Schedora products">
      ${cards.map(([key, text]) => html`<a class="product-card ${key}" href="${boot.landings[key]}"><h2>${ctx.lockup(key, true)}</h2><p>${text}</p><span class="go">Explore ${key === 'meet' ? 'Meet' : key === 'forms' ? 'Forms' : 'Flow'} →</span></a>`)}
    </section>
    <section class="card card-plain home-connect">
      <h2>How they connect</h2>
      <p>A Meet booking or a Forms response creates an event. Flow picks it up once, runs your action, and shows every run with its status, so you can see what was sent and retry anything that failed.</p>
      ${boot.billingMode === 'open' ? html`<p class="muted">Evaluation build: all products are available and nothing is charged. Prices will be published once approved.</p>` : ''}
    </section>
  </div>`);
}

const operatorText = () => boot.operator.name
  ? html`${boot.operator.name}${boot.operator.jurisdiction ? `, ${boot.operator.jurisdiction}` : ''}. Contact: ${boot.operator.contact || 'not yet provided'}.`
  : html`<strong>Legal operator details are awaiting confirmation.</strong> Privacy and support contact: <a href="mailto:${boot.operator.contact || 'support@schedora.in'}">${boot.operator.contact || 'support@schedora.in'}</a>. The operator's legal name and jurisdiction must be published before Schedora is offered commercially.`;

export async function privacy(ctx) {
  setTitle('Privacy policy · Schedora');
  const emailProvider = boot.providers.email === 'outbox' ? 'No external email provider is connected; messages are kept in the server outbox and not delivered.' : 'A transactional email provider delivers booking and automation emails.';
  mount(ctx.main, html`<div class="container page legal">
    <h1>Privacy policy</h1><p class="muted">Draft for the current build · updated 24 October 2026</p>
    <h2>Who is responsible</h2><p>${operatorText()}</p>
    <h2>What we collect and why</h2>
    <ul>
      <li><strong>Accounts:</strong> name, email address and a salted password hash, to sign you in and identify you to your workspace.</li>
      <li><strong>Google sign-in:</strong> if you choose Google, we verify your Google account identifier, verified email and display name to create or access your Schedora account. We store the identifier to recognize the same Google account. Sign-in requests only OpenID, email and profile permissions; it does not connect your calendar or store Google sign-in access tokens. Existing accounts must explicitly link Google while signed in.</li>
      <li><strong>Appointments (Meet):</strong> the invitee's name, email address, time zone and optional notes, so the host can hold the appointment and both sides receive confirmations, reminders and cancellation notices.</li>
      <li><strong>Calendar connections:</strong> if a host connects a calendar feed, we store the feed address and only the start and end times of busy periods, to hide times that are not free. Event titles and attendees are not stored.</li>
      <li><strong>Google Calendar:</strong> a separate optional Google connection checks calendar busy periods and creates, updates or cancels the calendar events associated with Schedora bookings. Its access and refresh tokens are encrypted on the server. Disconnect the connection in Meet to remove its stored credentials.</li>
      <li><strong>Form responses (Forms):</strong> the answers a respondent submits, stored in the form owner's workspace. Answers to questions hidden by the form's logic are discarded.</li>
      <li><strong>Automations (Flow):</strong> run records referencing the booking or response that triggered them, and any task or email the workspace configured.</li>
      <li><strong>Security logs:</strong> request method, route, status and timing. Connection addresses are held in memory for rate limiting only.</li>
    </ul>
    <h2>Storage in your browser</h2><p>A sign-in cookie (essential, 30 days). Your theme, selected workspace and privacy choice are kept in browser storage. Optional analytics runs only if you accept it and your browser does not send Global Privacy Control; it counts page views in server memory for up to 24 hours without identifiers.</p>
    <h2>Service providers</h2><ul><li>Email: ${emailProvider}</li><li>Calendar: ${boot.providers.calendar}, read-only.</li><li>Payments: ${boot.providers.billing === 'test' ? 'no payment provider is connected; the test provider simulates billing events and no money moves.' : boot.providers.billing === 'none' ? 'not connected yet.' : 'a payment provider processes card details; Schedora never receives full card numbers.'}</li><li>Hosting: to be confirmed with the deployment.</li></ul>
    <h2>Retention</h2><p>Each workspace sets a retention period (default 365 days). Form responses older than that are deleted and past appointments are anonymized. Copies of sent emails are deleted after 30 days. Deleting a workspace or your account deletes the related records immediately; backups age out under the deployment's backup schedule.</p>
    <h2>Your choices</h2><p>You can export form responses, delete responses, delete a workspace, or delete your account from the Account page. Invitees can cancel appointments from the link in their confirmation email. For other requests, contact the operator above.</p>
  </div>`);
}

export async function terms(ctx) {
  setTitle('Terms · Schedora');
  mount(ctx.main, html`<div class="container page legal">
    <h1>Terms of use</h1><p class="muted">Draft for the current build · updated 24 October 2026</p>
    <h2>Operator</h2><p>${operatorText()}</p>
    <h2>The service</h2><p>Schedora provides Meet (appointment scheduling), Forms (forms and responses) and Flow (automations). ${boot.billingMode === 'open' ? 'This build runs in evaluation mode: nothing is charged and the service may change or be reset.' : 'Paid access is granted per product or as a Suite according to your active subscription.'}</p>
    <h2>Acceptable use</h2><p>Use Schedora lawfully. Do not send spam, impersonate others, collect data you are not entitled to collect, disrupt the service, or try to access workspaces that are not yours. Workspace owners are responsible for the forms they publish and the people they contact.</p>
    <h2>Your content</h2><p>You keep ownership of the data in your workspace. We process it only to provide the service, as described in the privacy policy.</p>
    <h2>Billing</h2><p>Prices, taxes, renewal, failed-payment grace periods and cancellation terms will be published before paid plans open. Cancelling keeps access until the end of the paid period. If a payment fails, access continues during a grace period while payment is retried.</p>
    <h2>Limits</h2><p>Mandatory consumer rights under applicable law are not affected. Commercial terms, liability limits and governing law will be completed with the legal operator details before commercial release.</p>
  </div>`);
}

export async function notFound(ctx) {
  setTitle('Page not found · Schedora');
  mount(ctx.main, html`<div class="container page"><h1>This page took a wrong turn.</h1><p>We could not find that page. The link may be mistyped, or the booking page or form may no longer be published.</p><div class="actions"><a class="btn btn-primary" href="/">Go to Schedora</a></div></div>`);
}
