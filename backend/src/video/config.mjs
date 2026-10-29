// Schedora Meet video configuration. Everything here is server-side; publicVideoConfig() is the
// only part sent to browsers. Commercial values (allowances, pack prices) are configuration, not
// code: production starts with none, and checkout stays disabled until real values are supplied.

export const UNITS_PER_CREDIT = 60; // 1 credit = 1 participant-minute = 60 participant-seconds

const json = (value, fallback, name) => {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { throw new Error(`${name} must be valid JSON.`); }
};
const int = (value, fallback, min, max, name) => {
  const number = value === undefined || value === '' ? fallback : Number(value);
  if (!Number.isInteger(number) || number < min || number > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return number;
};

// Clearly labeled fixtures for local development and tests only. They never enable a real checkout.
const DEVELOPMENT_PACKS = [
  { id: 'small', name: 'Small pack (development fixture)', credits: 500, amount_minor: 50000, currency: 'INR', enabled: true, fixture: true },
  { id: 'medium', name: 'Medium pack (development fixture)', credits: 2000, amount_minor: 180000, currency: 'INR', enabled: true, fixture: true },
  { id: 'large', name: 'Large pack (development fixture)', credits: 10000, amount_minor: 800000, currency: 'INR', enabled: true, fixture: true }
];
const DEVELOPMENT_ALLOWANCES = { evaluation: 300, meet: 1000, suite: 3000, trial: 0 };

export function validateLiveKitUrl(value, { production, hosting }) {
  let url;
  try { url = new URL(value); } catch { throw new Error('LIVEKIT_URL must be a URL such as wss://your-project.livekit.cloud.'); }
  const local = ['localhost', '127.0.0.1'].includes(url.hostname);
  if (url.protocol !== 'wss:' && !(url.protocol === 'ws:' && local && !production)) throw new Error('LIVEKIT_URL must use wss:// (ws:// is allowed only for a local development server).');
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('LIVEKIT_URL must be a bare origin without credentials, path or query.');
  if (hosting === 'cloud' && !url.hostname.endsWith('.livekit.cloud')) throw new Error('LIVEKIT_HOSTING=cloud requires a *.livekit.cloud LIVEKIT_URL.');
  return { ws: `${url.protocol}//${url.host}`, http: `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`, host: url.hostname };
}

function deploymentFrom(raw, production) {
  const hosting = raw.hosting || 'cloud';
  if (!['cloud', 'self_hosted'].includes(hosting)) throw new Error('LIVEKIT_HOSTING must be cloud or self_hosted.');
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(raw.id || '')) throw new Error('Video deployment ids use 2-41 lowercase letters, numbers and hyphens.');
  if (!raw.apiKey || !raw.apiSecret || String(raw.apiSecret).length < 32) throw new Error(`LiveKit deployment ${raw.id} needs an API key and an API secret of at least 32 characters.`);
  return { id: raw.id, provider: 'livekit', hosting, apiKey: raw.apiKey, apiSecret: raw.apiSecret, endpoints: validateLiveKitUrl(raw.url, { production, hosting }) };
}

export function loadVideoConfig(env, production) {
  const provider = env.MEET_VIDEO_PROVIDER || (production ? 'none' : 'fake');
  if (!['livekit', 'fake', 'none'].includes(provider)) throw new Error('MEET_VIDEO_PROVIDER must be livekit, fake or none.');
  if (production && provider === 'fake') throw new Error('MEET_VIDEO_PROVIDER=fake is for development and tests only.');
  const requested = provider !== 'none' && (env.MEET_VIDEO_ENABLED ? env.MEET_VIDEO_ENABLED === 'true' : !production);
  // Production gate: real usage stays off until metering, enforcement and the provider have been
  // verified end to end. Each confirmation is an explicit operator decision (docs/MEET_VIDEO.md).
  const blocked = [];
  if (production && requested) {
    if (!env.APP_ENCRYPTION_KEY || env.APP_ENCRYPTION_KEY.length < 32) blocked.push('APP_ENCRYPTION_KEY (32+ characters) is required for meeting links.');
    if (env.MEET_VIDEO_WEBHOOK_CONFIRMED !== 'true') blocked.push('Configure the LiveKit webhook and confirm verified delivery with MEET_VIDEO_WEBHOOK_CONFIRMED=true.');
    if (env.MEET_VIDEO_SMOKE_CONFIRMED !== 'true') blocked.push('Run the real-provider smoke test (docs/MEET_VIDEO.md) and set MEET_VIDEO_SMOKE_CONFIRMED=true.');
    if (env.MONITORING_CONFIRMED !== 'true') blocked.push('Configure alerts for video health signals and set MONITORING_CONFIRMED=true.');
    if (env.LIVEKIT_HOSTING === 'self_hosted' && env.MEET_VIDEO_SELF_HOSTED_REVIEWED !== 'true') blocked.push('Self-hosted LiveKit: complete the revocation and auto-create review, then set MEET_VIDEO_SELF_HOSTED_REVIEWED=true.');
  }
  const enabled = requested && !blocked.length;
  // A single-workspace validation pilot is separate from general production enablement.
  // It permits real-provider acceptance before a broad launch; it never confirms smoke results.
  const pilotRequested = env.MEET_VIDEO_PILOT_ENABLED === 'true';
  const pilotWorkspaces = json(env.MEET_VIDEO_PILOT_WORKSPACES, [], 'MEET_VIDEO_PILOT_WORKSPACES');
  if (!Array.isArray(pilotWorkspaces) || pilotWorkspaces.length > 1 || pilotWorkspaces.some(id => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))) throw new Error('MEET_VIDEO_PILOT_WORKSPACES must contain at most one workspace UUID.');
  if (pilotRequested && requested) throw new Error('Use either the workspace validation pilot or general video enablement, not both.');
  const pilotBlocked = [];
  if (pilotRequested) {
    if (pilotWorkspaces.length !== 1) pilotBlocked.push('Select one pilot workspace.');
    if (production) {
      if (provider !== 'livekit' || (env.LIVEKIT_HOSTING || 'cloud') !== 'cloud') pilotBlocked.push('The production pilot requires LiveKit Cloud.');
      if (!env.LIVEKIT_URL || !env.LIVEKIT_API_KEY || !env.LIVEKIT_API_SECRET) pilotBlocked.push('Configure the LiveKit Cloud credentials.');
      if (!env.APP_ENCRYPTION_KEY || env.APP_ENCRYPTION_KEY.length < 32) pilotBlocked.push('Configure the meeting-link encryption key.');
      if (env.MEET_VIDEO_WEBHOOK_CONFIRMED !== 'true') pilotBlocked.push('Verify the permanent provider webhook first.');
      if (env.MONITORING_CONFIRMED !== 'true') pilotBlocked.push('Verify operator and external monitoring first.');
    }
  }
  const pilot = { enabled: pilotRequested && !pilotBlocked.length, workspaceIds: pilotWorkspaces, monthlyCredits: 60, blocked: pilotBlocked };
  const deployments = [];
  if (provider === 'livekit' && (enabled || env.LIVEKIT_URL)) {
    deployments.push(deploymentFrom({ id: env.MEET_VIDEO_DEPLOYMENT || 'livekit-cloud', url: env.LIVEKIT_URL, apiKey: env.LIVEKIT_API_KEY, apiSecret: env.LIVEKIT_API_SECRET, hosting: env.LIVEKIT_HOSTING }, production));
  } else if (provider === 'fake') {
    deployments.push({ id: env.MEET_VIDEO_DEPLOYMENT || 'fake-local', provider: 'fake', hosting: 'fake', apiKey: 'fake', apiSecret: env.MEET_VIDEO_FAKE_SECRET || 'fake-video-webhook-secret-for-development-only',
      endpoints: { ws: 'ws://127.0.0.1:7880', http: 'http://127.0.0.1:7880', host: '127.0.0.1' } });
  }
  // Older deployments kept so existing rooms drain on the provider they were created on.
  for (const raw of json(env.MEET_VIDEO_DRAINING_DEPLOYMENTS, [], 'MEET_VIDEO_DRAINING_DEPLOYMENTS')) {
    const deployment = deploymentFrom(raw, production);
    if (deployments.some(item => item.id === deployment.id)) throw new Error('Duplicate video deployment id ' + deployment.id + '.');
    deployments.push({ ...deployment, draining: true });
  }
  const killSwitch = env.MEET_VIDEO_KILL_SWITCH || 'off';
  if (!['off', 'admissions', 'terminate'].includes(killSwitch)) throw new Error('MEET_VIDEO_KILL_SWITCH must be off, admissions or terminate.');
  const allowances = json(env.MEET_VIDEO_ALLOWANCES, production ? {} : DEVELOPMENT_ALLOWANCES, 'MEET_VIDEO_ALLOWANCES');
  for (const [plan, credits] of Object.entries(allowances)) {
    if (!['evaluation', 'trial', 'meet', 'suite'].includes(plan) || !Number.isInteger(credits) || credits < 0 || credits > 1000000) throw new Error('MEET_VIDEO_ALLOWANCES maps evaluation, trial, meet or suite to whole credits.');
  }
  const packs = json(env.MEET_VIDEO_PACKS, production ? [] : DEVELOPMENT_PACKS, 'MEET_VIDEO_PACKS');
  if (!Array.isArray(packs)) throw new Error('MEET_VIDEO_PACKS must be a JSON array.');
  for (const pack of packs) {
    if (!/^[a-z0-9-]{2,30}$/.test(pack.id || '') || !Number.isInteger(pack.credits) || pack.credits < 1 || pack.credits > 10000000
      || !Number.isSafeInteger(pack.amount_minor) || pack.amount_minor < 100 || pack.currency !== 'INR' || typeof pack.name !== 'string') {
      throw new Error('Each MEET_VIDEO_PACKS entry needs id, name, credits, amount_minor (paise, at least 100) and currency INR.');
    }
  }
  if (new Set(packs.map(pack => pack.id)).size !== packs.length) throw new Error('MEET_VIDEO_PACKS ids must be unique.');
  if (production && packs.some(pack => pack.fixture)) throw new Error('Development fixture packs cannot be used in production.');
  const tokenTtlSeconds = int(env.MEET_VIDEO_TOKEN_TTL_SECONDS, 120, 30, 600, 'MEET_VIDEO_TOKEN_TTL_SECONDS');
  const blockSeconds = int(env.MEET_VIDEO_RESERVATION_BLOCK_SECONDS, 600, 120, 3600, 'MEET_VIDEO_RESERVATION_BLOCK_SECONDS');
  return {
    enabled, blocked, provider, deployments, pilot,
    deployment: deployments.find(item => !item.draining)?.id || null,
    killSwitch,
    tokenTtlSeconds,
    blockSeconds,
    // Renew a participant's funding when less than this remains; must leave time for worker delay.
    renewBeforeSeconds: int(env.MEET_VIDEO_RENEW_BEFORE_SECONDS, Math.min(240, Math.floor(blockSeconds / 2)), 30, blockSeconds - 30, 'MEET_VIDEO_RENEW_BEFORE_SECONDS'),
    // Usage settles only after this delay past a reservation window, so late provider events still count.
    finalizeDelaySeconds: int(env.MEET_VIDEO_FINALIZE_DELAY_SECONDS, 300, 30, 86400, 'MEET_VIDEO_FINALIZE_DELAY_SECONDS'),
    reconcileIntervalSeconds: int(env.MEET_VIDEO_RECONCILE_SECONDS, 30, 5, 3600, 'MEET_VIDEO_RECONCILE_SECONDS'),
    joinEarlyMinutes: int(env.MEET_VIDEO_JOIN_EARLY_MINUTES, 10, 0, 120, 'MEET_VIDEO_JOIN_EARLY_MINUTES'),
    overtimeMinutes: int(env.MEET_VIDEO_OVERTIME_MINUTES, 30, 0, 240, 'MEET_VIDEO_OVERTIME_MINUTES'),
    maxRoomMinutes: pilot.enabled ? 15 : int(env.MEET_VIDEO_MAX_ROOM_MINUTES, 180, 15, 1440, 'MEET_VIDEO_MAX_ROOM_MINUTES'),
    maxParticipants: pilot.enabled ? 2 : int(env.MEET_VIDEO_MAX_PARTICIPANTS, 10, 2, 100, 'MEET_VIDEO_MAX_PARTICIPANTS'),
    maxConcurrentRooms: pilot.enabled ? 1 : int(env.MEET_VIDEO_MAX_CONCURRENT_ROOMS, 3, 1, 1000, 'MEET_VIDEO_MAX_CONCURRENT_ROOMS'),
    maxWorkspaceParticipants: pilot.enabled ? 2 : int(env.MEET_VIDEO_MAX_WORKSPACE_PARTICIPANTS, 25, 2, 10000, 'MEET_VIDEO_MAX_WORKSPACE_PARTICIPANTS'),
    maxGlobalParticipants: pilot.enabled ? 2 : int(env.MEET_VIDEO_MAX_GLOBAL_PARTICIPANTS, 200, 2, 1000000, 'MEET_VIDEO_MAX_GLOBAL_PARTICIPANTS'),
    guestPolicy: ['open', 'host_first'].includes(env.MEET_VIDEO_GUEST_POLICY) ? env.MEET_VIDEO_GUEST_POLICY : 'host_first',
    // Highest video layer the browser publishes; the client and room settings never exceed it.
    maxVideoHeight: int(env.MEET_VIDEO_MAX_VIDEO_HEIGHT, 720, 180, 1080, 'MEET_VIDEO_MAX_VIDEO_HEIGHT'),
    lowBalanceCredits: int(env.MEET_VIDEO_LOW_BALANCE_CREDITS, 30, 0, 1000000, 'MEET_VIDEO_LOW_BALANCE_CREDITS'),
    allowances,
    packs,
    catalogVersion: env.MEET_VIDEO_CATALOG_VERSION || (production ? 'unset' : 'development-fixture-1'),
    rechargeEnabled: env.MEET_VIDEO_RECHARGE_ENABLED === 'true',
    // Operational estimates only (not provider invoices): micro-units of costCurrency per participant-minute.
    costPerParticipantMinuteMicros: int(env.MEET_VIDEO_COST_PER_PARTICIPANT_MINUTE_MICROS, 0, 0, 100000000, 'MEET_VIDEO_COST_PER_PARTICIPANT_MINUTE_MICROS'),
    costCurrency: env.MEET_VIDEO_COST_CURRENCY || 'USD',
    monthlyCostBudgetMicros: int(env.MEET_VIDEO_MONTHLY_COST_BUDGET_MICROS, 0, 0, Number.MAX_SAFE_INTEGER, 'MEET_VIDEO_MONTHLY_COST_BUDGET_MICROS'),
    extraConnectSrc: String(env.MEET_VIDEO_CONNECT_SRC || '').split(/\s+/).filter(Boolean).map(source => {
      if (!/^(https|wss):\/\/(\*\.)?[a-z0-9.-]+(:\d+)?$/i.test(source)) throw new Error('MEET_VIDEO_CONNECT_SRC entries must be https:// or wss:// origins.');
      return source;
    })
  };
}

export function currentDeployment(config) {
  return config.video.deployments.find(item => item.id === config.video.deployment) || null;
}

// Content Security Policy for the meeting pages only: media, blob previews and the provider's
// HTTPS/WebSocket endpoints. Other pages keep the strict default.
export function meetingCsp(config, baseCsp) {
  const sources = new Set();
  for (const deployment of config.video.deployments) {
    if (deployment.provider === 'fake') continue;
    sources.add(deployment.endpoints.http); sources.add(deployment.endpoints.ws);
    // LiveKit Cloud selects a regional edge after fetching /settings/regions from the project URL.
    if (deployment.hosting === 'cloud') { sources.add('https://*.livekit.cloud'); sources.add('wss://*.livekit.cloud'); }
  }
  for (const source of config.video.extraConnectSrc) sources.add(source);
  return baseCsp
    .replace("connect-src 'self'", ["connect-src 'self'", ...sources].join(' '))
    .replace("img-src 'self' data:", "img-src 'self' data: blob:")
    .replace("default-src 'self';", "default-src 'self'; media-src 'self' blob: mediastream:; worker-src 'self' blob:;");
}

export const MEETING_PERMISSIONS = 'camera=(self), microphone=(self), display-capture=(self), autoplay=(self), geolocation=(), payment=()';
export const MEETING_PAGE = /^\/meet\/(room|join)\//;

export function publicVideoConfig(config) {
  return { enabled: config.video.enabled && Boolean(config.video.deployment), units_per_credit: UNITS_PER_CREDIT, max_video_height: config.video.maxVideoHeight };
}

export function workspaceVideoConfig(config, workspaceId) {
  const pilot = Boolean(config.video.pilot?.enabled && config.video.pilot.workspaceIds.includes(workspaceId));
  return { enabled: Boolean(config.video.deployment && (config.video.enabled || pilot)), pilot,
    ...(pilot ? { instant_only: true, monthly_credits: config.video.pilot.monthlyCredits, max_participants: 2, max_minutes: 15 } : {}) };
}
