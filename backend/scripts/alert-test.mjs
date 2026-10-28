// Sends one message labelled [TEST] to each configured operator alert channel (ALERT_WEBHOOK_URL,
// ALERT_EMAIL with EMAIL_PROVIDER=http). Uses no database and changes no alert state.
// Usage: node --env-file=<private env file> scripts/alert-test.mjs
import { loadConfig } from '../src/config.mjs';
import { createEmailProvider } from '../src/platform/email.mjs';
import { alertChannels, sendTestAlert } from '../src/platform/monitoring.mjs';

const config = loadConfig();
const app = {
  config, now: () => Date.now(), emailProvider: createEmailProvider(config), fetchProvider: (url, init) => fetch(url, init),
  log: (level, message, fields = {}) => console.error(JSON.stringify({ level, message, ...fields }))
};
if (!alertChannels(app).length) {
  console.error('No alert channel configured. Set ALERT_WEBHOOK_URL, or ALERT_EMAIL with EMAIL_PROVIDER=http.');
  process.exit(1);
}
const results = await sendTestAlert(app);
console.log(JSON.stringify(results));
process.exitCode = Object.values(results).every(result => result === 'sent') ? 0 : 1;
