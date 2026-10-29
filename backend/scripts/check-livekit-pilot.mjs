import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RoomServiceClient } from 'livekit-server-sdk';
import { loadConfig } from '../src/config.mjs';

// Provider control-plane check only. No database, media, participant tokens or paid features.
// Creates and immediately deletes one empty, uniquely named diagnostic room.
export async function checkLiveKitPilot(config, createClient = deployment => new RoomServiceClient(deployment.endpoints.http, deployment.apiKey, deployment.apiSecret, { requestTimeout: 10, failover: true })) {
  const deployment = config.video.deployments.find(item => item.id === config.video.deployment);
  if (!config.video.pilot?.enabled || config.video.enabled || deployment?.hosting !== 'cloud' || deployment?.provider !== 'livekit') return { passed: false, reason: 'A scoped LiveKit Cloud validation pilot is required.' };
  const name = 'schedora-pilot-check-' + randomUUID();
  let client, found = false, empty = false, created = false, cleaned = false;
  try {
    client = createClient(deployment);
    await client.createRoom({ name, maxParticipants: 2, emptyTimeout: 15, departureTimeout: 5, metadata: '{"purpose":"operator-control-plane-check"}' });
    created = true;
    found = (await client.listRooms([name])).some(room => room.name === name);
    empty = (await client.listParticipants(name)).length === 0;
  } catch { /* Never log credentials, provider payloads or merchant/user data. */ }
  finally {
    if (client) { try { await client.deleteRoom(name); cleaned = true; } catch {} }
  }
  return { passed: created && found && empty && cleaned, created, found, empty, cleaned,
    scope: 'Empty-room control plane only; media, webhook processing and credit settlement are not verified.' };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await checkLiveKitPilot(loadConfig());
    console.log(JSON.stringify(result)); process.exitCode = result.passed ? 0 : 1;
  } catch { console.log(JSON.stringify({ passed: false, reason: 'Pilot configuration is invalid; inspect private settings.' })); process.exitCode = 1; }
}
