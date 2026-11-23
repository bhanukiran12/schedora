import { randomUUID } from 'node:crypto';
import { fail } from '../http.mjs';
import { decryptJson, encryptJson } from '../platform/crypto.mjs';
import { razorpayCredentials } from '../meet/razorpay.mjs';
import { ACTIONS, flatten } from '../shared/flow-logic.mjs';

// Flow integrations, honestly labelled (docs/FLOW_V1_IMPLEMENTATION.md, "Integrations").
//   not_configured — the server or workspace lacks the connection; steps can be simulated only.
//   connected      — configured but not yet proven; steps can be simulated and tested, not switched on.
//   tested         — a person confirmed a test (provider accepted it); available for live workflows.
//   local          — non-production server recording messages in its local outbox; nothing leaves it.
//   native         — part of Schedora (tasks, contacts, sheets, webhooks); always available.

const SLACK = /^https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/_-]{20,200}$/;

export function slackConnection(app, workspaceId) {
  const row = app.db.get("SELECT credentials, account FROM integrations WHERE workspace_id = ? AND user_id IS NULL AND provider = 'slack' AND status = 'active'", workspaceId);
  if (!row) return null;
  try { return { ...decryptJson(app.config, row.credentials), channel: row.account }; } catch { return null; }
}

export function connectSlack(app, workspaceId, body) {
  const url = String(body.webhook_url || '').trim();
  if (!SLACK.test(url)) fail(400, 'validation_failed', 'Paste the Slack incoming webhook address (https://hooks.slack.com/services/…).', { field: 'webhook_url' });
  const channel = String(body.channel || '').trim().slice(0, 80) || 'Slack channel';
  const now = app.now();
  app.db.transaction(() => {
    app.db.run("DELETE FROM integrations WHERE workspace_id = ? AND user_id IS NULL AND provider = 'slack'", workspaceId);
    app.db.run("INSERT INTO integrations (id, workspace_id, user_id, provider, account, credentials, status, created_at, updated_at) VALUES (?, ?, NULL, 'slack', ?, ?, 'active', ?, ?)",
      randomUUID(), workspaceId, channel, encryptJson(app.config, { webhook_url: url }), now, now);
    // A new address has not been proven yet.
    app.db.run("DELETE FROM flow_provider_checks WHERE workspace_id = ? AND provider = 'slack'", workspaceId);
  });
  return providerStatus(app, workspaceId).slack;
}

export function disconnectSlack(app, workspaceId) {
  app.db.run("DELETE FROM integrations WHERE workspace_id = ? AND user_id IS NULL AND provider = 'slack'", workspaceId);
  app.db.run("DELETE FROM flow_provider_checks WHERE workspace_id = ? AND provider = 'slack'", workspaceId);
}

/** Approved WhatsApp templates for Flow (TWILIO_WHATSAPP_FLOW_TEMPLATES), by name. */
export function flowWhatsappTemplates(app) {
  if (app.config.whatsappProvider !== 'twilio') return {};
  return app.config.twilioWhatsappFlowTemplates || {};
}

const check = (app, workspaceId, provider) => app.db.get("SELECT status, checked_at FROM flow_provider_checks WHERE workspace_id = ? AND provider = ? AND status IN ('accepted', 'delivered')", workspaceId, provider);

export function recordProviderCheck(app, workspaceId, provider, status, userId, detail = null) {
  app.db.run(`INSERT INTO flow_provider_checks (workspace_id, provider, status, detail, checked_by, checked_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (workspace_id, provider) DO UPDATE SET status = excluded.status, detail = excluded.detail, checked_by = excluded.checked_by, checked_at = excluded.checked_at`,
  workspaceId, provider, status, detail, userId, app.now());
}

export function providerStatus(app, workspaceId) {
  const local = !app.config.production;
  const tested = provider => check(app, workspaceId, provider);
  const state = (configured, provider, label, extra = {}) => {
    const proven = configured && tested(provider);
    return { label, state: !configured ? 'not_configured' : proven ? 'tested' : 'connected', ...(proven ? { tested_at: proven.checked_at } : {}), ...extra };
  };
  const emailConfigured = app.config.emailProvider === 'http';
  const email = emailConfigured ? state(true, 'email', 'Email') : { label: 'Email', state: local ? 'local' : 'not_configured', note: local ? 'This server records email in its local outbox; nothing is delivered.' : 'No email provider is configured.' };
  const twilio = app.config.whatsappProvider === 'twilio';
  const templates = Object.entries(flowWhatsappTemplates(app)).map(([name, template]) => ({ name, variables: template.variables }));
  return {
    email,
    whatsapp: state(twilio && templates.length > 0, 'whatsapp', 'WhatsApp (Twilio)', { templates, ...(twilio && !templates.length ? { note: 'Add approved Flow templates (TWILIO_WHATSAPP_FLOW_TEMPLATES).' } : {}) }),
    sms: state(app.config.smsProvider === 'twilio', 'sms', 'SMS (Twilio)'),
    slack: state(Boolean(slackConnection(app, workspaceId)), 'slack', 'Slack', { channel: slackConnection(app, workspaceId)?.channel || null }),
    razorpay: { label: 'Razorpay', state: razorpayCredentials(app, workspaceId) ? 'tested' : 'not_configured', note: 'Payments are confirmed by Razorpay webhooks and API reads; Flow starts from those confirmations.' },
    google_calendar: { label: 'Google Calendar', state: app.db.get("SELECT 1 FROM integrations WHERE workspace_id = ? AND provider = 'google' AND status = 'active'", workspaceId) ? 'connected' : 'not_configured', note: 'Used by Meet for availability and events; Flow reacts to the bookings it creates.' },
    google_sheets: { label: 'Google Sheets', state: app.db.get("SELECT 1 FROM form_google_syncs WHERE workspace_id = ? AND status = 'active'", workspaceId) ? 'tested' : app.config.googleSheets?.enabled ? 'connected' : 'not_configured', note: 'Responses sync one way from Forms; Flow rows in Schedora Sheets follow that sync.' },
    webhook: { label: 'Webhooks', state: 'native' },
    ai: { label: 'AI (Claude)', state: app.anthropic ? 'native' : 'not_configured' },
    api: { label: 'REST API and MCP', state: 'native' }
  };
}

/** Providers a definition needs that are not yet available for live use (simulation stays possible). */
export function activationProblems(app, workspaceId, definition) {
  const status = providerStatus(app, workspaceId);
  const problems = [];
  for (const step of flatten(definition.steps)) {
    if (step.type !== 'action') continue;
    const provider = ACTIONS[step.action]?.provider;
    if (!provider || ['webhook'].includes(provider)) continue;
    const entry = status[provider];
    if (!entry) continue;
    if (entry.state === 'not_configured') problems.push(`${entry.label} is not configured, so “${ACTIONS[step.action].label}” can only be simulated.`);
    else if (entry.state === 'connected') problems.push(`${entry.label} is connected but not tested yet. Use “Send test to me” once to confirm it, then turn the workflow on.`);
    if (step.action === 'send_whatsapp' && entry.state !== 'not_configured' && !entry.templates?.some(template => template.name === step.config?.template)) problems.push(`WhatsApp template “${step.config?.template}” is not approved on this server.`);
  }
  return [...new Set(problems)];
}
