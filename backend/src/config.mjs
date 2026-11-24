import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadVideoConfig, publicVideoConfig } from './video/config.mjs';
import { validWebhookSecret } from './platform/email-events.mjs';

function bundledDatabaseCa(connectionString) {
  let host;
  try { host = new URL(connectionString).hostname.toLowerCase(); } catch { return ''; }
  const certificate = host.endsWith('.pooler.supabase.com') ? 'supabase-ca.crt'
    : host.endsWith('.ap-south-1.rds.amazonaws.com') ? 'rds-ap-south-1.pem' : null;
  return certificate ? readFileSync(new URL(`../certs/${certificate}`, import.meta.url), 'utf8') : '';
}

// All configuration comes from the server environment. No secret is ever sent to the browser.
export function loadConfig(env = process.env, overrides = {}) {
  const production = env.NODE_ENV === 'production';
  const productDomain = env.PRODUCT_DOMAIN || 'schedora.in';
  const localDomain = 'schedora.localhost';
  const localBaseHost = env.NODE_ENV === 'test' ? 'localhost' : localDomain;
  const baseUrl = (env.BASE_URL || (production ? `https://${productDomain}` : `http://${localBaseHost}:${env.PORT || 3000}`)).replace(/\/$/, '');
  let billingProvider = env.BILLING_PROVIDER || (production ? 'none' : 'test');
  if (production && billingProvider === 'test' && env.ALLOW_TEST_BILLING !== 'true') billingProvider = 'none';
  const config = {
    production,
    releaseMode: env.RELEASE_MODE || 'evaluation',
    persistentStorageConfirmed: env.PERSISTENT_STORAGE_CONFIRMED === 'true',
    backupsConfirmed: env.BACKUPS_CONFIRMED === 'true',
    emailDomainVerified: env.EMAIL_DOMAIN_VERIFIED === 'true',
    providerSmokeConfirmed: env.PROVIDER_SMOKE_CONFIRMED === 'true',
    monitoringConfirmed: env.MONITORING_CONFIRMED === 'true',
    commercialBillingConfirmed: env.COMMERCIAL_BILLING_CONFIRMED === 'true',
    host: env.HOST || '127.0.0.1',
    port: Number(env.PORT || 3000),
    baseUrl,
    productDomain,
    databasePath: env.DATABASE_PATH || './data/schedora.db',
    databaseUrl: env.DATABASE_URL || '',
    databaseCa: env.DATABASE_CA_CERT || bundledDatabaseCa(env.DATABASE_URL),
    trustProxy: env.TRUST_PROXY === 'true',
    // Requests per minute per client address, across the whole site.
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE || 600),
    // Database space form images may take across the service (docs/FORMS.md, "Media").
    formImageStorageBytes: Number(env.FORM_IMAGE_STORAGE_MB || 60) * 1024 * 1024,
    formUploadDirectory: env.FORM_UPLOAD_DIRECTORY || '',
    formUploadScanner: env.FORM_UPLOAD_SCANNER || '',
    formUploadWorkspaceBytes: Number(env.FORM_UPLOAD_WORKSPACE_MB || 10) * 1024 * 1024,
    formUploadStorageBytes: Number(env.FORM_UPLOAD_STORAGE_MB || 100) * 1024 * 1024,
    // Proxies in front of the app that append to X-Forwarded-For (Render = 1; Vercel rewrite + Render = 2).
    trustProxyHops: Math.max(1, Number(env.TRUST_PROXY_HOPS || 1)),
    // Local development serves the static frontend from ../frontend; on Render the API runs alone.
    // Set before a rollback, so authors stop while this backend is still running.
    formsAuthoringFrozen: env.FORMS_AUTHORING_FREEZE ? env.FORMS_AUTHORING_FREEZE === 'true' : false,
    // Respondent sign-in for Forms (docs/FORMS.md, "Respondent sign-in"). Off unless set to exactly
    // "enabled". While off, sign-in-only forms refuse everyone and cannot be set or published; workspace
    // member single sign-on is not affected.
    respondentSignin: env.FORMS_RESPONDENT_SIGNIN === 'enabled',
    // Names a non-production deployment, so a check can see where a frontend really sends its requests.
    deployment: env.RELEASE_ENVIRONMENT || '',
    serveFrontend: env.SERVE_FRONTEND ? env.SERVE_FRONTEND === 'true' : !production,
    frontendDir: env.FRONTEND_DIR || fileURLToPath(new URL('../../frontend/', import.meta.url)),
    cookieDomain: production ? (env.COOKIE_DOMAIN || '') : env.NODE_ENV === 'test' ? (env.COOKIE_DOMAIN || '') : (env.COOKIE_DOMAIN || `.${localDomain}`),
    analytics: env.ANALYTICS_ENABLED === 'true',
    billingMode: env.BILLING_MODE || (production ? 'enforced' : 'open'),
    billingProvider,
    billingWebhookSecret: env.BILLING_WEBHOOK_SECRET || (billingProvider === 'test' ? randomBytes(32).toString('hex') : ''),
    razorpayBilling: {
      keyId: env.BILLING_RAZORPAY_KEY_ID || '', keySecret: env.BILLING_RAZORPAY_KEY_SECRET || '',
      checkoutEnabled: env.BILLING_CHECKOUT_ENABLED === 'true',
      plans: JSON.parse(env.BILLING_RAZORPAY_PLANS || '{}')
    },
    emailProvider: env.EMAIL_PROVIDER || 'outbox',
    emailHttpUrl: env.EMAIL_HTTP_URL || '',
    emailHttpToken: env.EMAIL_HTTP_TOKEN || '',
    emailFrom: env.EMAIL_FROM || `Schedora <no-reply@${productDomain}>`,
    // Signing secret (whsec_...) of the provider's delivery-report webhook; empty means reports are not connected.
    emailWebhookSecret: env.EMAIL_WEBHOOK_SECRET || '',
    smsProvider: env.SMS_PROVIDER || 'outbox',
    whatsappProvider: env.WHATSAPP_PROVIDER || 'outbox',
    twilioWhatsappFrom: env.TWILIO_WHATSAPP_FROM || '',
    twilioWhatsappContentSid: env.TWILIO_WHATSAPP_CONTENT_SID || '',
    // Separate approved template for Forms receipts (1 name, 2 form title, 3 receipt code, 4 private stop link).
    twilioWhatsappReceiptContentSid: env.TWILIO_WHATSAPP_RECEIPT_CONTENT_SID || '',
    twilioInboundUrl: env.TWILIO_INBOUND_URL || '',
    // Approved WhatsApp templates Flow may send: {"name": {"sid": "HX…", "variables": ["Label", …]}}.
    twilioWhatsappFlowTemplates: JSON.parse(env.TWILIO_WHATSAPP_FLOW_TEMPLATES || '{}'),
    twilioStatusCallback: env.TWILIO_STATUS_CALLBACK_URL || '',
    twilioAccountSid: env.TWILIO_ACCOUNT_SID || '',
    twilioAuthToken: env.TWILIO_AUTH_TOKEN || '',
    twilioFrom: env.TWILIO_FROM || '',
    encryptionKey: env.APP_ENCRYPTION_KEY || '',
    allowTestPayments: env.ALLOW_TEST_PAYMENTS === 'true',
    // Public address of this API, for webhook URLs given to providers (defaults to BASE_URL, which proxies /api).
    apiBaseUrl: (env.API_BASE_URL || '').replace(/\/$/, ''),
    google: { clientId: env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_CLIENT_SECRET || '' },
    googleSignIn: { clientId: env.GOOGLE_SIGNIN_CLIENT_ID || '', clientSecret: env.GOOGLE_SIGNIN_CLIENT_SECRET || '' },
    microsoft: { clientId: env.MICROSOFT_CLIENT_ID || '', clientSecret: env.MICROSOFT_CLIENT_SECRET || '' },
    // One-way Google Sheets sync for Forms. Off unless GOOGLE_SHEETS_SYNC=enabled; may reuse the Google OAuth
    // client once drive.file is added to its consent screen, or use a client of its own.
    googleSheets: { enabled: env.GOOGLE_SHEETS_SYNC === 'enabled', clientId: env.GOOGLE_SHEETS_CLIENT_ID || env.GOOGLE_CLIENT_ID || '', clientSecret: env.GOOGLE_SHEETS_CLIENT_SECRET || env.GOOGLE_CLIENT_SECRET || '' },
    zoom: { clientId: env.ZOOM_CLIENT_ID || '', clientSecret: env.ZOOM_CLIENT_SECRET || '' },
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
    // Flow AI cost guards (docs/FLOW_V1_IMPLEMENTATION.md). They do not change plan prices or entitlements.
    flowAiDescribeDaily: Number.isFinite(Number(env.FLOW_AI_DESCRIBE_DAILY)) && env.FLOW_AI_DESCRIBE_DAILY !== '' && env.FLOW_AI_DESCRIBE_DAILY != null ? Math.min(1000, Math.max(0, Math.floor(Number(env.FLOW_AI_DESCRIBE_DAILY)))) : 10,
    // 'held' blocks turning on Flow v1 workflows (release package §4). Anything other than empty or 'on' holds.
    flowV1Activation: ['', 'on'].includes(String(env.FLOW_V1_ACTIVATION ?? '').trim().toLowerCase()) ? 'on' : 'held',
    flowAiInputChars:Math.min(50000, Math.max(1000, Math.floor(Number(env.FLOW_AI_INPUT_CHARS) || 8000))),
    aiModel: env.AI_MODEL || 'claude-opus-5-5',
    inboundEmailSecret: env.INBOUND_EMAIL_SECRET || '',
    assistAddress: env.ASSIST_ADDRESS || `assist@${productDomain}`,
    operator: {
      name: env.OPERATOR_NAME || 'VEMULA BHANU KIRAN',
      contact: env.OPERATOR_CONTACT || 'support@schedora.in',
      jurisdiction: env.OPERATOR_JURISDICTION || ''
    },
    workerIntervalMs: Number(env.WORKER_INTERVAL_MS || 2000),
    // Operator alerts (codes and counts only). Either channel may be empty; health still reports firing alerts.
    alerts: { webhookUrl: env.ALERT_WEBHOOK_URL || '', email: env.ALERT_EMAIL || '', emailProvider: env.ALERT_EMAIL_PROVIDER || 'inherit' },
    video: loadVideoConfig(env, production),
    ...overrides
  };
  // Origins allowed to send state-changing requests. ALLOWED_ORIGINS adds comma-separated entries;
  // a '*' matches one DNS label, e.g. https://schedora-*-team.vercel.app for Vercel previews.
  const origins = [new URL(config.baseUrl).origin, ...['', 'meet.', 'forms.', 'flow.', 'book.'].map(sub => `https://${sub}${productDomain}`),
    ...String(env.ALLOWED_ORIGINS || '').split(',').map(value => value.trim().replace(/\/$/, '')).filter(Boolean)];
  config.allowedOrigins = new Set(origins.filter(origin => !origin.includes('*')));
  config.allowedOriginPatterns = origins.filter(origin => origin.includes('*'))
    .map(origin => new RegExp('^' + origin.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[a-z0-9-]+') + '$', 'i'));
  if (!['open', 'enforced'].includes(config.billingMode)) throw new Error('BILLING_MODE must be open or enforced.');
  if (!['none', 'test', 'razorpay'].includes(config.billingProvider)) throw new Error('Unsupported BILLING_PROVIDER.');
  if (!['evaluation', 'production'].includes(config.releaseMode)) throw new Error('RELEASE_MODE must be evaluation or production.');
  if (!['outbox', 'http'].includes(config.emailProvider)) throw new Error('EMAIL_PROVIDER must be outbox or http.');
  for (const budget of [config.formUploadWorkspaceBytes, config.formUploadStorageBytes]) if (!Number.isSafeInteger(budget) || budget < 0) throw new Error('Form upload storage budgets must be finite nonnegative MB amounts.');
  if (config.formUploadDirectory && (!config.formUploadScanner || (production && !config.persistentStorageConfirmed))) throw new Error('FORM_UPLOAD_DIRECTORY needs FORM_UPLOAD_SCANNER and confirmed persistent storage in production.');
  if (!Number.isSafeInteger(config.formImageStorageBytes) || config.formImageStorageBytes < 0) throw new Error('FORM_IMAGE_STORAGE_MB must specify a finite non-negative storage budget.');
  if (config.emailProvider === 'http' && (!config.emailHttpUrl || !config.emailHttpToken)) throw new Error('EMAIL_PROVIDER=http needs EMAIL_HTTP_URL and EMAIL_HTTP_TOKEN.');
  if (config.emailWebhookSecret && !validWebhookSecret(config.emailWebhookSecret)) throw new Error('EMAIL_WEBHOOK_SECRET must be the provider\'s whsec_ signing secret.');
  if (config.alerts.webhookUrl) {
    let url;
    try { url = new URL(config.alerts.webhookUrl); } catch { throw new Error('ALERT_WEBHOOK_URL must be a URL.'); }
    if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) throw new Error('ALERT_WEBHOOK_URL must use HTTPS.');
  }
  if (config.alerts.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.alerts.email)) throw new Error('ALERT_EMAIL must be one email address.');
  if (!['inherit', 'http'].includes(config.alerts.emailProvider || 'inherit')) throw new Error('ALERT_EMAIL_PROVIDER must be inherit or http.');
  if (config.alerts.emailProvider === 'http') {
    if (!config.emailHttpUrl || !config.emailHttpToken) throw new Error('ALERT_EMAIL_PROVIDER=http needs EMAIL_HTTP_URL and EMAIL_HTTP_TOKEN.');
    let url;
    try { url = new URL(config.emailHttpUrl); } catch { throw new Error('EMAIL_HTTP_URL must be a URL.'); }
    if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) throw new Error('Alert email HTTP provider must use HTTPS.');
  }
  if (config.smsProvider === 'twilio' && (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioFrom)) throw new Error('SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM.');
  if (!['outbox','twilio'].includes(config.smsProvider) || !['outbox','twilio'].includes(config.whatsappProvider)) throw new Error('Messaging providers must be outbox or twilio.');
  if (config.whatsappProvider === 'twilio' && (!/^AC[a-f0-9]{32}$/i.test(config.twilioAccountSid) || !config.twilioAuthToken || !/^whatsapp:\+[1-9][0-9]{7,14}$/.test(config.twilioWhatsappFrom) || !/^HX[a-f0-9]{32}$/i.test(config.twilioWhatsappContentSid))) throw new Error('Twilio WhatsApp needs account credentials, a WhatsApp sender and an approved Content SID.');
  if (config.twilioWhatsappReceiptContentSid && !/^HX[a-f0-9]{32}$/i.test(config.twilioWhatsappReceiptContentSid)) throw new Error('TWILIO_WHATSAPP_RECEIPT_CONTENT_SID must be an approved Content SID (HX...).');
  for (const [name, template] of Object.entries(config.twilioWhatsappFlowTemplates || {})) {
    if (!/^[a-z0-9_]{1,40}$/.test(name) || !/^HX[a-f0-9]{32}$/i.test(template?.sid || '') || !Array.isArray(template.variables) || template.variables.length > 10 || template.variables.some(label => typeof label !== 'string' || !label || label.length > 60)) throw new Error('TWILIO_WHATSAPP_FLOW_TEMPLATES maps lowercase names to {sid: HX…, variables: [labels]}.');
  }
  if (config.twilioInboundUrl) {
    const url = new URL(config.twilioInboundUrl);
    if (url.protocol !== 'https:' || url.pathname !== '/api/messaging/twilio/inbound' || url.search || url.hash || url.username || url.password) throw new Error('TWILIO_INBOUND_URL must be the public HTTPS /api/messaging/twilio/inbound URL.');
  }
  if (config.twilioStatusCallback) {
    const url = new URL(config.twilioStatusCallback);
    if (url.protocol !== 'https:' || url.pathname !== '/api/messaging/twilio/status' || url.search || url.hash || url.username || url.password) throw new Error('Twilio status callback must be the public HTTPS /api/messaging/twilio/status URL.');
  }
  return config;
}

export function isAllowedOrigin(config, origin) {
  return config.allowedOrigins.has(origin) || config.allowedOriginPatterns.some(pattern => pattern.test(origin));
}

// Settings the browser needs; nothing secret.
export function publicConfig(config) {
  return {
    productDomain: config.productDomain,
    ...(config.deployment ? { deployment: config.deployment } : {}),
    ...(config.formsAuthoringFrozen ? { formsAuthoringFrozen: true } : {}),
    ...(config.flowV1Activation === 'held' ? { flowActivationHeld: true } : {}),
    respondentSignin: Boolean(config.respondentSignin),
    formUploads: Boolean(config.formUploadDirectory && config.formUploadScanner),
    analytics: config.analytics,
    googleSignIn: Boolean((config.googleSignIn?.clientId ? config.googleSignIn.clientId && config.googleSignIn.clientSecret : config.google.clientId && config.google.clientSecret) && (!config.production || config.encryptionKey)),
    billingMode: config.billingMode,
    operator: config.operator,
    providers: { email: config.emailProvider, email_reports: config.emailProvider === 'http' && Boolean(config.emailWebhookSecret), sms: config.smsProvider, whatsapp: config.whatsappProvider, messaging_reports: Boolean(config.twilioStatusCallback), calendar: 'ICS feed', billing: config.billingProvider },
    integrations: {
      google: Boolean(config.google.clientId), microsoft: Boolean(config.microsoft.clientId), zoom: Boolean(config.zoom.clientId),
      ai: Boolean(config.anthropicApiKey), testPayments: !config.production || config.allowTestPayments
    },
    assistAddress: config.assistAddress,
    video: publicVideoConfig(config)
  };
}

// Conditions that block a commercial release; surfaced in logs and /api/health.
export function releaseWarnings(config) {
  const warnings = [];
  if (!config.operator.name || !config.operator.contact) warnings.push('Legal operator name and privacy contact are not configured.');
  if (config.emailProvider === 'outbox') warnings.push('Customer email provider is the local outbox; no customer email leaves the server.');
  if (config.billingProvider !== 'test' && !config.billingWebhookSecret) warnings.push('No payment provider webhook secret is configured.');
  if (config.billingMode === 'open') warnings.push('Billing mode is open: every workspace has evaluation access to all products.');
  if (config.production && !config.encryptionKey) warnings.push('APP_ENCRYPTION_KEY is not set: integrations (calendars, Stripe, SSO) cannot be connected.');
  if (config.video?.enabled && config.video.provider === 'fake') warnings.push('Schedora Meet video uses the fake provider; no real meeting can connect.');
  for (const reason of config.video?.blocked || []) warnings.push('Schedora Meet video is off: ' + reason);
  for (const reason of config.video?.pilot?.blocked || []) warnings.push('Schedora Meet validation pilot is off: ' + reason);
  if (!config.alerts?.webhookUrl && !(config.alerts?.email && (config.alerts.emailProvider === 'http' || config.emailProvider === 'http'))) warnings.push('No operator alert channel: set ALERT_WEBHOOK_URL or ALERT_EMAIL with the HTTP email provider.');
  if (config.video?.killSwitch !== 'off') warnings.push(`Schedora Meet video kill switch is ${config.video?.killSwitch}.`);
  return warnings;
}
