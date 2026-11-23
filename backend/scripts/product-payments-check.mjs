// Browser journeys for Forms payments, WhatsApp receipts, Google Sheets sync and reviewed AI follow-ups
// (docs/FORMS.md, docs/MEET_VIDEO.md). Runs inside sheets-check.mjs with fake providers only: no money
// moves, no message is sent and no Google account is used.
import { encryptJson } from '../src/platform/crypto.mjs';

export async function checkProductPayments({ alice, visitor, app, step }) {
  const me = () => alice.evaluate("(async()=>{const me=await(await fetch('/api/me')).json();return {user:me.user,ws:me.workspaces[0]}})()");
  const api = async (method, path, body) => alice.evaluate(`(async()=>{const me=await(await fetch('/api/me')).json();const r=await fetch('/api/workspaces/'+me.workspaces[0].id+${JSON.stringify(path)},{method:${JSON.stringify(method)},headers:{'Content-Type':'application/json','X-CSRF-Token':me.csrf_token},${body === undefined ? '' : 'body:' + JSON.stringify(JSON.stringify(body)) + ','}});const text=await r.text();const result=text?JSON.parse(text):null;if(!r.ok)throw Error(text);return result})()`);
  const fill = async (page, selector, value) => page.evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.value=${JSON.stringify(value)};el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  const confirm = page => page.evaluate("document.querySelector('dialog[open] button[value=ok]').click()");
  let paid;

  await step('paid form: builder explains the simulated checkout, payment waits for server confirmation, decline then retry completes it', async () => {
    paid = await api('POST', '/forms', { definition: { title: 'Paid workshop check', presentation: 'classic', fields: [{ id: 'name', type: 'short_text', label: 'Name', required: true }, { id: 'email', type: 'email', label: 'Email', required: true }] } });
    await alice.open('/forms/' + paid.id, "document.querySelector('.builder')");
    await alice.evaluate("document.querySelector('[data-section=settings]').click()");
    await alice.waitFor("document.querySelector('[data-payment-setting=enabled]')", 'payment settings card');
    await alice.evaluate("document.querySelector('[data-payment-setting=enabled]').click()");
    await alice.waitFor("document.querySelector('#pay-amount') && document.querySelector('.payment-controls').textContent.includes('Simulated checkout')", 'amount field and simulated-checkout notice');
    await fill(alice, '#pay-amount', '499');
    await alice.evaluate("document.querySelector('#save').click()");
    let saved;
    for (let attempt = 0; attempt < 50 && saved?.draft.payment?.amount_cents !== 49900; attempt++) { await new Promise(resolve => setTimeout(resolve, 200)); saved = await api('GET', '/forms/' + paid.id); }
    if (saved.draft.payment?.amount_cents !== 49900) throw new Error('payment amount not saved in the draft: ' + JSON.stringify(saved.draft.payment));
    await api('POST', '/forms/' + paid.id + '/publish', { base_revision: saved.revision });
    await visitor.open('/f/' + paid.slug, "document.querySelector('[data-payment-note]')");
    if (!await visitor.evaluate("document.querySelector('[data-payment-note]').textContent.includes('₹499.00')")) throw new Error('amount not shown before submitting');
    await fill(visitor, '#q-name', 'Paying guest'); await fill(visitor, '#q-email', 'paying@example.com');
    await visitor.evaluate("document.querySelector('#form-root [type=submit]').click()");
    await visitor.waitFor("document.querySelector('.receipt h1')?.textContent.includes('payment needed') && document.querySelector('[data-pay]')", 'receipt asks for payment');
    const outbox = () => app.db.get("SELECT COUNT(*) AS n FROM outbox WHERE type = 'forms.response.created' AND source_id = ?", paid.id).n;
    if (outbox() !== 0) throw new Error('downstream event emitted before payment');
    await visitor.evaluate("document.querySelector('[data-pay]').click()");
    await visitor.waitFor("location.pathname.startsWith('/forms/pay/') && document.querySelector('[data-test-pay=fail]')", 'test checkout page');
    await visitor.evaluate("document.querySelector('[data-test-pay=fail]').click()");
    await visitor.waitFor("document.querySelector('.receipt')?.textContent.includes('Payment failed') && document.querySelector('[data-pay]')", 'declined payment can be retried');
    await visitor.evaluate("document.querySelector('[data-pay]').click()");
    await visitor.waitFor("document.querySelector('[data-test-pay=pay]')", 'retry checkout');
    await visitor.evaluate("document.querySelector('[data-test-pay=pay]').click()");
    await visitor.waitFor("document.querySelector('.receipt h1')?.textContent.includes('Payment confirmed')", 'payment confirmed by the server');
    await visitor.shot('forms-payment-confirmed');
    if (outbox() !== 1) throw new Error('downstream event should run once after payment, saw ' + outbox());
    await alice.open('/forms/' + paid.id + '/responses', "document.querySelector('.response-payment')");
    if (!await alice.evaluate("document.querySelector('.response-payment').textContent.includes('Paid')")) throw new Error('Responses does not show the payment');
  });

  await step('WhatsApp receipt: unchecked opt-in, one queued receipt with provider evidence, and the private stop link', async () => {
    Object.assign(app.config, { whatsappProvider: 'twilio', twilioWhatsappReceiptContentSid: 'HX' + 'c'.repeat(32) });
    const sent = [];
    const previous = app.whatsappProvider;
    app.whatsappProvider = { name: 'twilio', async send(message) { sent.push(message); return { id: 'SM' + String(sent.length).padStart(32, '0') }; } };
    try {
      const form = await api('POST', '/forms', { definition: { title: 'Receipt check', presentation: 'classic', fields: [{ id: 'name', type: 'short_text', label: 'Name', required: true }, { id: 'phone', type: 'phone', label: 'WhatsApp number' }], receipts: { whatsapp: { phone_field: 'phone' } } } });
      await api('POST', '/forms/' + form.id + '/publish');
      await visitor.open('/f/' + form.slug, "document.querySelector('[data-whatsapp-receipt]')");
      if (await visitor.evaluate("document.querySelector('[data-whatsapp-receipt]').checked")) throw new Error('opt-in must start unchecked');
      await fill(visitor, '#q-name', 'Receipt guest'); await fill(visitor, '#q-phone', '+91 91234 56789');
      await visitor.evaluate("document.querySelector('[data-whatsapp-receipt]').click();document.querySelector('#form-root [type=submit]').click()");
      await visitor.waitFor("document.querySelector('[data-whatsapp-status]')", 'receipt status line');
      // The worker hands the queued receipt to the (fake) provider; Responses then shows provider acceptance.
      for (let attempt = 0; attempt < 50 && !sent.length; attempt++) await new Promise(resolve => setTimeout(resolve, 200));
      await alice.open('/forms/' + form.id + '/responses', "document.querySelector('.response-receipt')?.textContent.includes('Accepted by WhatsApp provider')");
      if (sent.length !== 1) throw new Error('expected exactly one WhatsApp receipt, saw ' + sent.length);
      const stop = JSON.parse(sent[0].body).variables[4];
      await visitor.open(new URL(stop).pathname, "document.querySelector('#stop-messages')");
      await visitor.evaluate("document.querySelector('#stop-messages').click()");
      await visitor.waitFor("document.querySelector('main')?.textContent.includes('will not get further WhatsApp messages')", 'withdrawal confirmed');
    } finally { app.whatsappProvider = previous; Object.assign(app.config, { whatsappProvider: 'outbox', twilioWhatsappReceiptContentSid: '' }); }
  });

  await step('Google Sheets sync: unavailable until enabled, then a separate connection backfills to a new tab', async () => {
    await alice.open('/forms/' + paid.id + '/responses', "document.querySelector('#google-sheets-sync')?.textContent.includes('Not available on this server')");
    const { user, ws } = await me();
    app.config.googleSheets = { enabled: true, clientId: 'sheets-client', clientSecret: 'sheets-secret' };
    const credentials = encryptJson(app.config, { access_token: 'ya29.fake', refresh_token: 'refresh-fake', expires_at: Date.now() + 3600000 });
    app.db.run("INSERT INTO integrations (id, workspace_id, user_id, provider, account, credentials, status, created_at, updated_at) VALUES ('sheets-check-integration', ?, ?, 'google_sheets', 'owner@gmail.com', ?, 'active', ?, ?)", ws.id, user.id, credentials, Date.now(), Date.now());
    const rows = [];
    const previous = app.fetchProvider;
    app.fetchProvider = async (url, init = {}) => {
      const json = value => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (url === 'https://sheets.googleapis.com/v4/spreadsheets' && init.method === 'POST') return json({ spreadsheetId: 'browsercheck' + 'x'.repeat(12), spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/browsercheck/edit', properties: { title: 'Check' }, sheets: [{ properties: { sheetId: 0, title: 'Paid workshop check responses' } }] });
      if (url.includes(':append')) { const body = JSON.parse(init.body); if (!url.includes('valueInputOption=RAW')) throw new Error('not RAW'); rows.push(...body.values); return json({}); }
      if (url.includes('values:batchUpdate')) { const body = JSON.parse(init.body); for (const item of body.data) { const row = Number(/A(\d+)$/.exec(item.range)[1]); rows[row - 1] = item.values[0]; } return json({}); }
      if (url.includes('/values/')) return json({ values: [rows.map(row => row?.[0] ?? '')] });
      return previous(url, init);
    };
    try {
      await alice.open('/forms/' + paid.id + '/responses?sheets=connected', "document.querySelector('[data-sheets=create]')");
      await alice.evaluate("document.querySelector('[data-sheets=create]').click()");
      await alice.waitFor("document.querySelector('#google-sheets-body')?.textContent.includes('Paid workshop check responses')", 'sync set up');
      app.worker?.nudge?.();
      for (let attempt = 0; attempt < 40 && rows.length < 2; attempt++) await new Promise(resolve => setTimeout(resolve, 250));
      if (rows[0]?.[0] !== 'Schedora response ID' || rows.length !== 2) throw new Error('backfill did not write the header and the paid response: ' + rows.length);
      await alice.open('/forms/' + paid.id + '/responses', "document.querySelector('#google-sheets-summary')?.textContent.includes('Syncing')");
      await alice.evaluate("document.querySelector('#google-sheets-sync').open=true");
      await alice.shot('forms-google-sheets-sync');
    } finally { app.fetchProvider = previous; }
  });

  await step('reviewed AI follow-up: drafted from the transcript, edited, and sent only after explicit confirmation', async () => {
    app.config.anthropicApiKey = 'browser-check-fake';
    app.anthropic = { beta: { messages: { create: async () => ({ stop_reason: 'end_turn', usage: { input_tokens: 50, output_tokens: 40 }, content: [{ type: 'text', text: JSON.stringify({ subject: 'Next steps', body: 'Thanks for the call. I will send the plan on Friday.', tasks: [{ title: 'Send the plan', owner: 'Host', due: 'Friday', quote: 'I will send the plan on Friday' }], sources: [{ quote: 'I will send the plan on Friday', supports: 'Plan timing' }] }) }] }) } } };
    try {
      const transcript = await api('POST', '/transcripts', { title: 'Browser follow-up check', content: 'Host: Thanks for joining today.\nHost: I will send the plan on Friday.' });
      await alice.open('/meet?tab=insights', `document.querySelector('[data-view="${transcript.id}"]')`);
      await alice.evaluate(`document.querySelector('[data-view="${transcript.id}"]').click()`);
      await alice.waitFor("document.querySelector('[data-followup-create]')", 'follow-up draft button');
      await alice.evaluate("document.querySelector('[data-followup-create]').click()");
      await alice.waitFor("document.querySelector('[data-followup-form]')", 'editable follow-up draft');
      if (app.db.get("SELECT COUNT(*) AS n FROM emails WHERE kind = 'meeting_followup'").n) throw new Error('a draft sent email');
      await alice.evaluate("const to=document.querySelector('[data-followup-form] [name=recipients]');to.value='client@example.com';document.querySelector('[data-followup-send]').click()");
      await alice.waitFor("document.querySelector('dialog[open]')?.textContent.includes('Send this follow-up?')", 'send confirmation');
      await confirm(alice);
      await alice.waitFor("document.querySelector('.followup .badge')?.textContent.includes('Sent')", 'sent state');
      const emails = app.db.all("SELECT to_address FROM emails WHERE kind = 'meeting_followup'");
      if (emails.length !== 1 || emails[0].to_address !== 'client@example.com') throw new Error('follow-up email not queued once to the confirmed recipient');
    } finally { app.anthropic = null; app.config.anthropicApiKey = ''; }
  });
}
