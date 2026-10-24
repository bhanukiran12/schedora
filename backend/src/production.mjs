import { isAbsolute } from 'node:path';
import { subscriptionCatalog } from './billing/razorpay.mjs';

export function meetReadiness(config) {
  const failures = [];
  const require = (condition, message) => { if (!condition) failures.push(message); };
  require(config.production, 'NODE_ENV must be production.');
  require(new URL(config.baseUrl).protocol === 'https:', 'BASE_URL must use HTTPS.');
  require(Boolean(config.databaseUrl) || (isAbsolute(config.databasePath) && config.databasePath !== ':memory:'), 'Configure DATABASE_URL or an absolute persistent DATABASE_PATH.');
  require(config.persistentStorageConfirmed, 'Confirm the database is on a persistent volume with PERSISTENT_STORAGE_CONFIRMED=true.');
  require(config.backupsConfirmed, 'Complete an off-site backup and restore drill, then set BACKUPS_CONFIRMED=true.');
  require(config.emailProvider === 'http' && Boolean(config.emailHttpToken), 'Connect a real HTTP email provider.');
  let emailHttps = false;
  try { emailHttps = new URL(config.emailHttpUrl).protocol === 'https:'; } catch {}
  require(emailHttps, 'EMAIL_HTTP_URL must use HTTPS.');
  require(config.emailDomainVerified, 'Verify sender SPF, DKIM and DMARC, then set EMAIL_DOMAIN_VERIFIED=true.');
  require(Boolean(config.operator.name && config.operator.contact && config.operator.jurisdiction), 'Configure all legal operator details.');
  require(typeof config.encryptionKey === 'string' && config.encryptionKey.length >= 32, 'Configure a stable APP_ENCRYPTION_KEY of at least 32 characters.');
  require(!config.allowTestPayments && config.billingProvider !== 'test', 'Disable simulated payments and test billing.');
  require(Boolean(config.billingProvider && config.billingProvider !== 'none' && config.billingWebhookSecret), 'Connect a live subscription billing adapter and webhook secret.');
  require(config.billingProvider === 'razorpay' && /^rzp_live_[A-Za-z0-9]+$/.test(config.razorpayBilling?.keyId || '') && Boolean(config.razorpayBilling?.keySecret), 'Configure live Razorpay platform billing credentials.');
  require(subscriptionCatalog({ config }).every(plan => plan.checkout_available), 'Enable approved Razorpay subscription checkout and configure prices for Meet, Forms, Flow and Suite.');
  require(config.billingMode === 'enforced', 'BILLING_MODE must be enforced for a paid release.');
  require(config.providerSmokeConfirmed, 'Complete real calendar/email booking lifecycle tests, then set PROVIDER_SMOKE_CONFIRMED=true.');
  require(Boolean(config.google?.clientId && config.google?.clientSecret), 'Configure the selected Google Calendar/Meet OAuth app.');
  require(config.commercialBillingConfirmed, 'Approve pricing and complete live subscription-provider renewal/failure testing, then set COMMERCIAL_BILLING_CONFIRMED=true.');
  require(config.monitoringConfirmed, 'Configure uptime/error alerts, then set MONITORING_CONFIRMED=true.');
  return { ready: failures.length === 0, failures };
}

export function assertMeetProduction(config) {
  const result = meetReadiness(config);
  if (!result.ready) throw new Error('Meet production release blocked:\n' + result.failures.map(message => '- ' + message).join('\n'));
}
