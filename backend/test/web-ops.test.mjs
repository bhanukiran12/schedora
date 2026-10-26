// Sprints 1, 10: web serving, security headers, deployment configuration, retention and backup/restore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { idem, publishedEventType, setup, signUp } from './helpers.mjs';
import { loadConfig, isAllowedOrigin } from '../src/config.mjs';
import { clientAddress } from '../src/http.mjs';
import { applyRetention } from '../src/worker.mjs';
import { openDatabase } from '../src/db.mjs';
import { backup } from '../scripts/backup.mjs';
import { restore } from '../scripts/restore.mjs';

test('pages, assets, headers and legacy routes', async () => {
  const env = await setup();
  try {
    for (const path of ['/', '/meet', '/forms', '/flow', '/account', '/billing', '/privacy', '/terms', '/robots.txt', '/sitemap.xml', '/app.js', '/app.css', '/js/meet.mjs', '/shared/forms-logic.mjs', '/favicon.svg', '/logo-meet.png']) {
      assert.equal((await fetch(env.base + path)).status, 200, path);
    }
    const home = await fetch(env.base + '/', { headers: { 'Accept-Encoding': 'gzip' } });
    assert.match(home.headers.get('content-security-policy'), /script-src 'self'; style-src 'self'/);
    assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal(home.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(home.headers.get('content-encoding'), 'gzip');
    assert.match(await home.text(), /<script type="module" src="\/app\.js(?:\?[^"<>]*)?">/);
    const unknown = await fetch(env.base + '/missing-page');
    assert.equal(unknown.status, 404);
    assert.equal(unknown.headers.get('x-robots-tag'), 'noindex');
    assert.equal((await fetch(env.base + '/meet/nobody/nothing')).status, 404);
    assert.equal((await fetch(env.base + '/book', { redirect: 'manual' })).headers.get('location'), '/meet');
    assert.equal((await fetch(env.base + '/form', { redirect: 'manual' })).headers.get('location'), '/forms');
    assert.equal((await fetch(env.base + '/meet', { method: 'POST' })).status, 405);
    assert.equal((await fetch(env.base + '/../package.json')).status, 404);
    assert.equal((await fetch(env.base + '/api/nothing')).status, 404);
    const health = await (await fetch(env.base + '/api/health')).json();
    assert.equal(health.status, 'ok');
    const config = await (await fetch(env.base + '/api/config')).json();
    assert.equal(config.productDomain, 'schedora.in');
    assert.ok(!JSON.stringify(config).includes('whsec'), 'no secrets in public config');

    // Published forms may be embedded; nothing else may be framed.
    const owner = env.client();
    const { ws } = await signUp(owner, 'Embed');
    const form = (await owner.post(`/api/workspaces/${ws.id}/forms`, {})).body;
    await owner.post(`/api/workspaces/${ws.id}/forms/${form.id}/publish`);
    assert.match((await fetch(`${env.base}/f/${form.slug}`)).headers.get('content-security-policy'), /frame-ancestors \*/);
    const type = await publishedEventType(owner, ws);
    assert.equal((await fetch(`${env.base}/meet/${ws.slug}/${type.slug}`)).status, 200);
  } finally { await env.close(); }
});

test('split deployment: API-only mode, HTTPS redirect, proxies and origins', async () => {
  const env = await setup({ config: { serveFrontend: false, production: true, trustProxy: true, trustProxyHops: 2 } });
  try {
    const apiOnly = await new Promise((resolve, reject) => http.get(env.base + '/meet', { headers: { Host: 'schedora-api.onrender.com', 'X-Forwarded-Proto': 'https' } }, resolve).on('error', reject));
    apiOnly.resume();
    assert.equal(apiOnly.statusCode, 404, 'the API host does not serve the web app');
    assert.equal(apiOnly.headers['strict-transport-security'], 'max-age=31536000; includeSubDomains');
    const insecure = await new Promise((resolve, reject) => http.get(env.base + '/api/me', { headers: { Host: 'meet.schedora.in' } }, resolve).on('error', reject));
    insecure.resume();
    assert.equal(insecure.statusCode, 308);
    assert.equal(insecure.headers.location, 'https://meet.schedora.in/api/me');
  } finally { await env.close(); }

  const config = loadConfig({ NODE_ENV: 'production', ALLOWED_ORIGINS: 'https://schedora.vercel.app, https://schedora-*-team.vercel.app' });
  assert.equal(config.billingProvider, 'none', 'test billing is never on in production by default');
  assert.equal(config.billingMode, 'enforced');
  assert.equal(config.serveFrontend, false);
  for (const origin of ['https://schedora.in', 'https://forms.schedora.in', 'https://schedora.vercel.app', 'https://schedora-git-feature-team.vercel.app']) assert.ok(isAllowedOrigin(config, origin), origin);
  for (const origin of ['https://evil.vercel.app', 'https://schedora-a.b-team.vercel.app', 'http://schedora.in']) assert.ok(!isAllowedOrigin(config, origin), origin);
  const request = { headers: { 'x-forwarded-for': 'spoofed, 203.0.113.9, 76.76.21.1' }, socket: { remoteAddress: '10.0.0.1' } };
  assert.equal(clientAddress(request, true, 2), '203.0.113.9', 'Vercel + Render hops');
  assert.equal(clientAddress(request, false, 2), '10.0.0.1');
});

test('retention removes old responses and anonymizes old appointments', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Keeper');
    const type = await publishedEventType(owner, ws);
    const { slots } = (await env.client().get(`/api/public/meet/${ws.slug}/${type.slug}/slots`)).body;
    await env.client().post(`/api/public/meet/${ws.slug}/${type.slug}/bookings`, { name: 'Old', email: 'old@example.com', timezone: 'UTC', start: slots[0], notes: 'private' }, idem());
    const form = (await owner.post(`/api/workspaces/${ws.id}/forms`, {})).body;
    await owner.post(`/api/workspaces/${ws.id}/forms/${form.id}/publish`);
    await env.client().post(`/api/public/forms/${form.slug}/responses`, { answers: { name: 'Old', email: 'old@example.com', topic: 'support' } });
    assert.equal((await owner.patch(`/api/workspaces/${ws.id}`, { retention_days: 5 })).body.error.field, 'retention_days');
    await owner.patch(`/api/workspaces/${ws.id}`, { retention_days: 30 });
    env.clock.now += 29 * 86400000;
    applyRetention(env.app);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM responses').count, 1);
    env.clock.now += 3 * 86400000;
    const removed = applyRetention(env.app);
    assert.equal(removed.responses, 1);
    assert.equal(removed.bookings, 1);
    const booking = env.app.db.get('SELECT invitee_email, notes, anonymized_at FROM bookings');
    assert.equal(booking.invitee_email, 'removed@invalid');
    assert.equal(booking.notes, '');
    assert.ok(booking.anonymized_at);
  } finally { await env.close(); }
});

test('backup and restore round-trip (recovery drill)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'schedora-backup-'));
  try {
    const path = join(dir, 'live.db');
    const db = openDatabase(path);
    db.run("INSERT INTO workspaces (id, name, slug, created_at) VALUES ('w1', 'Before', 'before', 1)");
    const file = backup(path, join(dir, 'backups'));
    db.run("UPDATE workspaces SET name = 'Corrupted' WHERE id = 'w1'");
    db.close();
    restore(file, path);
    const restored = new DatabaseSync(path);
    assert.equal(restored.prepare("SELECT name FROM workspaces WHERE id = 'w1'").get().name, 'Before');
    const migrations = restored.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count;
    restored.close();
    assert.ok(migrations >= 2, 'all migrations present after restore');
    assert.ok(readFileSync(file).length > 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
