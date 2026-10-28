import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadVideoConfig, publicVideoConfig } from './video/config.mjs';
import { validWebhookSecret } from './platform/email-events.mjs';

// All configuration comes from the server environment. No secret is ever sent to the browser.
export function loadConfig(env = process.env, overrides = {}) {
  const production = env.NODE_ENV === 'production';
  const productDomain = env.PRODUCT_DOMAIN || 'schedora.in';
  const baseUrl = (env.BASE_URL || (production ? `https://${productDomain}` : `http://localhost:${env.PORT || 3000}`)).replace(/\/$/, '');
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
    databaseCa: env.DATABASE_CA_CERT || (env.DATABASE_URL?.includes('.pooler.supabase.com') ? readFileSync(new URL('../certs/supabase-ca.crt', import.meta.url), 'utf8') : ''),
    trustProxy: env.TRUST_PROXY === 'true',
    // Requests per minute per client address, across the whole site.
    rateLimitPerMinute: Number(env.RATE_LIMIT_PER_MINUTE || 600),
    // Proxies in front of the app that append to X-Forwarded-For (Render = 1; Vercel rewrite + Render = 2).
    trustProxyHops: Math.max(1, Number(env.TRUST_PROXY_HOPS || 1)),
    // Local development serves the static frontend from ../frontend; on Render the API runs alone.
    serveFrontend: env.SERVE_FRONTEND ? env.SERVE_FRONTEND === 'true' : !production,
    frontendDir: env.FRONTEND_DIR || fileURLToPath(new URL('../../frontend/', import.meta.url)),
    cookieDomain: env.COOKIE_DOMAIN || '',
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
    zoom: { clientId: env.ZOOM_CLIENT_ID || '', clientSecret: env.ZOOM_CLIENT_SECRET || '' },
    anthropicApiKey: env.ANTHROPIC_API_KEY || '',
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
    alerts: { webhookUrl: env.ALERT_WEBHOOK_URL || '', email: env.ALERT_EMAIL || '' },
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
  if (config.emailProvider === 'http' && (!config.emailHttpUrl || !config.emailHttpToken)) throw new Error('EMAIL_PROVIDER=http needs EMAIL_HTTP_URL and EMAIL_HTTP_TOKEN.');
  if (config.emailWebhookSecret && !validWebhookSecret(config.emailWebhookSecret)) throw new Error('EMAIL_WEBHOOK_SECRET must be the provider\'s whsec_ signing secret.');
  if (config.alerts.webhookUrl) {
    let url;
    try { url = new URL(config.alerts.webhookUrl); } catch { throw new Error('ALERT_WEBHOOK_URL must be a URL.'); }
    if (url.protocol !== 'https:' && (production || url.protocol !== 'http:')) throw new Error('ALERT_WEBHOOK_URL must use HTTPS.');
  }
  if (config.alerts.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(config.alerts.email)) throw new Error('ALERT_EMAIL must be one email address.');
  if (config.smsProvider === 'twilio' && (!config.twilioAccountSid || !config.twilioAuthToken || !config.twilioFrom)) throw new Error('SMS_PROVIDER=twilio needs TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM.');
  return config;
}

export function isAllowedOrigin(config, origin) {
  return config.allowedOrigins.has(origin) || config.allowedOriginPatterns.some(pattern => pattern.test(origin));
}

// Settings the browser needs; nothing secret.
export function publicConfig(config) {
  return {
    productDomain: config.productDomain,
    analytics: config.analytics,
    googleSignIn: Boolean((config.googleSignIn?.clientId ? config.googleSignIn.clientId && config.googleSignIn.clientSecret : config.google.clientId && config.google.clientSecret) && (!config.production || config.encryptionKey)),
    billingMode: config.billingMode,
    operator: config.operator,
    providers: { email: config.emailProvider, email_reports: config.emailProvider === 'http' && Boolean(config.emailWebhookSecret), sms: config.smsProvider, calendar: 'ICS feed', billing: config.billingProvider },
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
  if (config.emailProvider === 'outbox') warnings.push('Email provider is the local outbox; no email leaves the server.');
  if (config.billingProvider !== 'test' && !config.billingWebhookSecret) warnings.push('No payment provider webhook secret is configured.');
  if (config.billingMode === 'open') warnings.push('Billing mode is open: every workspace has evaluation access to all products.');
  if (config.production && !config.encryptionKey) warnings.push('APP_ENCRYPTION_KEY is not set: integrations (calendars, Stripe, SSO) cannot be connected.');
  if (config.video?.enabled && config.video.provider === 'fake') warnings.push('Schedora Meet video uses the fake provider; no real meeting can connect.');
  for (const reason of config.video?.blocked || []) warnings.push('Schedora Meet video is off: ' + reason);
  if (!config.alerts?.webhookUrl && !(config.alerts?.email && config.emailProvider === 'http')) warnings.push('No operator alert channel: set ALERT_WEBHOOK_URL or ALERT_EMAIL with the HTTP email provider.');
  if (config.video?.killSwitch !== 'off') warnings.push(`Schedora Meet video kill switch is ${config.video?.killSwitch}.`);
  return warnings;
}
