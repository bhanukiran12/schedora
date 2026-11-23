import twilio from 'twilio';

export const callbackUrl = config => config.twilioStatusCallback || '';
const address = value => /^\+[1-9][0-9]{7,14}$/.test(value);

export function createWhatsappProvider(config, fetchImpl = fetch) {
  if (config.whatsappProvider !== 'twilio') return { name: 'outbox', async send() { throw Object.assign(new Error('WhatsApp sending is not connected.'), { permanent: true }); } };
  return {
    name: 'twilio',
    async send(message) {
      // Booking reminders carry the four variables directly; other messages name their approved template.
      const parsed = JSON.parse(message.body);
      const template = parsed && typeof parsed.template === 'string' ? parsed.template : 'booking';
      const variables = template === 'booking' ? parsed : parsed.variables;
      // Flow templates (TWILIO_WHATSAPP_FLOW_TEMPLATES) declare their own number of variables.
      const flowTemplate = template.startsWith('flow:') ? (config.twilioWhatsappFlowTemplates || {})[template.slice(5)] : null;
      const contentSid = flowTemplate ? flowTemplate.sid : { booking: config.twilioWhatsappContentSid, form_receipt: config.twilioWhatsappReceiptContentSid }[template];
      if (!contentSid) throw Object.assign(new Error('No approved WhatsApp template is configured for this message.'), { permanent: true });
      const expected = flowTemplate ? Array.from({ length: flowTemplate.variables.length }, (_, index) => String(index + 1)).sort().join(',') : '1,2,3,4';
      if (!address(message.to) || !variables || Object.keys(variables).sort().join(',') !== expected || Object.values(variables).some(value => typeof value !== 'string' || !value || /[\r\n]/.test(value))) throw Object.assign(new Error('Invalid WhatsApp template recipient or variables.'), { permanent: true });
      const response = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(config.twilioAccountSid)}/Messages.json`, {
        method: 'POST', headers: { Authorization: 'Basic ' + Buffer.from(`${config.twilioAccountSid}:${config.twilioAuthToken}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ To: 'whatsapp:' + message.to, From: config.twilioWhatsappFrom, ContentSid: contentSid, ContentVariables: JSON.stringify(variables), ...(callbackUrl(config) ? { StatusCallback: callbackUrl(config) } : {}) }), signal: AbortSignal.timeout(10000)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(`WhatsApp provider returned ${response.status} (${result.code || 'unknown'}).`), { permanent: response.status >= 400 && response.status < 500 && response.status !== 429 });
      if (!result.sid) throw new Error('WhatsApp provider did not return a message ID.');
      return { id: result.sid };
    }
  };
}

/** Signed inbound WhatsApp replies (TWILIO_INBOUND_URL). Only opt-out words act; nothing is stored otherwise. */
export function verifyTwilioInbound(app, headers, raw) {
  const url = app.config.twilioInboundUrl;
  if (!url || !app.config.twilioAuthToken) return { error: 404 };
  const params = new URLSearchParams(raw);
  const body = {};
  for (const key of new Set(params.keys())) { const values = params.getAll(key); body[key] = values.length > 1 ? values : values[0]; }
  if (!twilio.validateRequest(app.config.twilioAuthToken, String(headers['x-twilio-signature'] || ''), url, body)) return { error: 401 };
  if (body.AccountSid !== app.config.twilioAccountSid) return { error: 401 };
  return { body };
}

export function recordTwilioStatus(app, headers, raw) {
  const url = callbackUrl(app.config);
  if (!url || !app.config.twilioAuthToken) return { error: 404 };
  const params = new URLSearchParams(raw);
  // Preserve all received form parameters, including future provider additions.
  const body = {};
  for (const key of new Set(params.keys())) { const values = params.getAll(key); body[key] = values.length > 1 ? values : values[0]; }
  if (!twilio.validateRequest(app.config.twilioAuthToken, String(headers['x-twilio-signature'] || ''), url, body)) return { error: 401 };
  if (body.AccountSid !== app.config.twilioAccountSid) return { error: 401 };
  const ranks = { accepted: 1, queued: 1, sending: 2, sent: 3, failed: 4, undelivered: 4, delivered: 5, read: 6 };
  const status = String(body.MessageStatus || '');
  if (!ranks[status]) return { result: 'ignored' };
  return app.db.transaction(() => {
    const row = app.db.get("SELECT id,delivery_status FROM emails WHERE provider_message_id=? AND accepted_transport='twilio' AND channel IN ('sms','whatsapp')", String(body.MessageSid || ''));
    if (!row) return { result: 'unknown_message' };
    if ((ranks[row.delivery_status] || 0) >= ranks[status]) return { result: 'duplicate' };
    app.db.run('UPDATE emails SET delivery_status=?,delivery_event_at=? WHERE id=?', status, app.now(), row.id);
    return { result: 'recorded' };
  });
}
