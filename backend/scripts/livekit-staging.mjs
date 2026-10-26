import http from 'node:http';
import { createInterface } from 'node:readline';
import { createApp } from '../src/app.mjs';
import { loadConfig } from '../src/config.mjs';
import { readBody } from '../src/http.mjs';
import { reconcileWallet } from '../src/video/credits.mjs';

if (process.env.RUN_LIVEKIT_STAGING !== 'true') throw new Error('Set RUN_LIVEKIT_STAGING=true to contact the real staging provider.');
if (!process.env.LIVEKIT_URL || !process.env.LIVEKIT_API_KEY || !process.env.LIVEKIT_API_SECRET) throw new Error('Load the ignored staging environment file first.');
if (process.env.NODE_ENV === 'production') throw new Error('This runner cannot use production mode.');

const config = loadConfig({ ...process.env,
  NODE_ENV: 'development', RELEASE_MODE: 'evaluation', DATABASE_URL: '', DATABASE_PATH: ':memory:',
  HOST: '127.0.0.1', PORT: '3100', BASE_URL: 'http://localhost:3100', SERVE_FRONTEND: 'true',
  EMAIL_PROVIDER: 'outbox', SMS_PROVIDER: 'outbox', BILLING_PROVIDER: 'test', BILLING_MODE: 'open',
  MEET_VIDEO_PROVIDER: 'livekit', MEET_VIDEO_ENABLED: 'true', MEET_VIDEO_DEPLOYMENT: 'livekit-staging',
  LIVEKIT_HOSTING: 'cloud', MEET_VIDEO_RECHARGE_ENABLED: 'false',
  MEET_VIDEO_RESERVATION_BLOCK_SECONDS: '120', MEET_VIDEO_RENEW_BEFORE_SECONDS: '30',
  MEET_VIDEO_FINALIZE_DELAY_SECONDS: '30', MEET_VIDEO_RECONCILE_SECONDS: '5',
  MEET_VIDEO_MAX_ROOM_MINUTES: '15', MEET_VIDEO_MAX_GLOBAL_PARTICIPANTS: '4',
  MEET_VIDEO_MAX_PARTICIPANTS: '4', MEET_VIDEO_ALLOWANCES: '{"evaluation":120}',
  GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: '', GOOGLE_SIGNIN_CLIENT_ID: '', GOOGLE_SIGNIN_CLIENT_SECRET: '',
  MICROSOFT_CLIENT_ID: '', MICROSOFT_CLIENT_SECRET: '', ZOOM_CLIENT_ID: '', ZOOM_CLIENT_SECRET: '',
  ANTHROPIC_API_KEY: '', COOKIE_DOMAIN: '', TRUST_PROXY: 'false'
}, { workerIntervalMs: 500 });
const app = createApp({ config, databasePath: ':memory:', log: (level, message) => {
  if (level === 'error') process.stderr.write(JSON.stringify({ level, message }) + '\n');
} });
const webhookPath = '/api/meet-video/webhooks/livekit-staging';
const relay = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== webhookPath) {
    response.writeHead(404); response.end(); return;
  }
  try {
    const raw = await readBody(request, 256 * 1024);
    const upstream = await fetch('http://127.0.0.1:3100' + webhookPath, {
      method: 'POST', signal: AbortSignal.timeout(10000),
      headers: { 'Content-Type': 'application/webhook+json', Authorization: String(request.headers.authorization || '') },
      body: raw
    });
    response.writeHead(upstream.status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(await upstream.text());
  } catch (error) {
    response.writeHead(error.status === 413 ? 413 : 502); response.end();
  }
});
relay.requestTimeout = 15000;
relay.headersTimeout = 10000;
let stopped = false;
async function stop() {
  if (stopped) return;
  stopped = true;
  for (const room of app.db.all("SELECT deployment, room_name FROM video_rooms WHERE provisioned_at IS NOT NULL")) {
    try { await app.video.providers.get(room.deployment)?.deleteRoom(room.room_name); }
    catch { process.stderr.write('Staging room cleanup failed; inspect the Cloud project before exiting.\n'); }
  }
  await new Promise(resolve => relay.close(resolve));
  await app.stop();
  process.exitCode = 0;
}
await app.start();
await new Promise((resolve, reject) => { relay.once('error', reject); relay.listen(3101, '127.0.0.1', resolve); });
process.stdout.write('Isolated staging UI: http://localhost:3100; webhook-only relay: http://127.0.0.1:3101' + webhookPath + '\n');
const commands = createInterface({ input: process.stdin });
commands.on('line', async command => {
  if (command.trim() === 'stop') { commands.close(); await stop(); return; }
  if (command.trim() !== 'status' || stopped) return;
  const status = {
    events: app.db.all('SELECT type, result, COUNT(*) AS count FROM video_provider_events GROUP BY type, result'),
    rooms: app.db.all('SELECT status, COUNT(*) AS count FROM video_rooms GROUP BY status'),
    participants: app.db.all('SELECT status, COUNT(*) AS count FROM video_participants GROUP BY status'),
    intervals: app.db.all('SELECT joined_at, left_at, last_seen_at FROM video_usage_intervals'),
    reservations: app.db.all('SELECT status, COUNT(*) AS count FROM credit_reservations GROUP BY status'),
    usage: app.db.all('SELECT connected_ms, units_charged, units_unfunded FROM video_usage_records'),
    integrityIssues: app.db.all('SELECT id FROM workspaces').flatMap(workspace => reconcileWallet(app, workspace.id))
  };
  process.stdout.write(JSON.stringify(status) + '\n');
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { commands.close(); await stop(); });
