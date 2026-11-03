// Form media: byte-level image validation and metadata removal, workspace-scoped storage and
// access, published-version retention, cleanup, media definitions, picture choices and video links.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32, deflateSync } from 'node:zlib';
import { randomUUID } from 'node:crypto';
import { setup, signUp } from './helpers.mjs';
import { openPostgres } from '../src/postgres.mjs';
import { loadConfig } from '../src/config.mjs';
import { inspectImage, IMAGE_LIMITS } from '../src/forms/images.mjs';
import { pruneAssets } from '../src/forms/assets.mjs';
import { applyRetention } from '../src/worker.mjs';
import { definitionAssets, definitionProblems, parseVideoUrl, validateSubmission, videoEmbedUrl, visibleFields } from '../src/shared/forms-logic.mjs';
import { planTypeChange } from '../../frontend/js/forms-type-change.mjs';

test('invalid image storage budgets cannot disable the service-wide guard', () => {
  for (const value of ['invalid', 'NaN', 'Infinity', '-1', '1e309']) {
    assert.throws(() => loadConfig({ FORM_IMAGE_STORAGE_MB: value }), /FORM_IMAGE_STORAGE_MB/, value);
  }
  assert.equal(loadConfig({ FORM_IMAGE_STORAGE_MB: '0' }).formImageStorageBytes, 0);
  assert.equal(loadConfig({ FORM_IMAGE_STORAGE_MB: '0.5' }).formImageStorageBytes, 512 * 1024);
});

// ---- Synthetic images built byte by byte ----
const chunk = (type, data = Buffer.alloc(0)) => {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(crc32(body), 8 + data.length);
  return out;
};
function png({ width = 2, height = 2, extra = [] } = {}) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rows = Buffer.alloc((width * 3 + 1) * Math.min(height, 4));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), ...extra, chunk('IDAT', deflateSync(rows)), chunk('IEND')]);
}
const segment = (marker, data) => { const head = Buffer.from([0xff, marker, 0, 0]); head.writeUInt16BE(data.length + 2, 2); return Buffer.concat([head, data]); };
function jpeg({ exif = true } = {}) {
  const sof = Buffer.from([8, 0, 2, 0, 3, 1, 1, 0x11, 0]); // 8-bit, height 2, width 3, one component
  return Buffer.concat([Buffer.from([0xff, 0xd8]), segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    ...(exif ? [segment(0xe1, Buffer.from('Exif\0\0GPS 12.97,77.59 camera-serial', 'latin1')), segment(0xfe, Buffer.from('a comment', 'latin1'))] : []),
    segment(0xc0, sof), segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])), Buffer.from([0x12, 0x34, 0x56]), Buffer.from([0xff, 0xd9])]);
}
const riffChunk = (type, data) => { const head = Buffer.alloc(8); head.write(type, 0, 'latin1'); head.writeUInt32LE(data.length, 4); return Buffer.concat([head, data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
function webp({ animated = false, exif = true } = {}) {
  const vp8x = Buffer.alloc(10); vp8x[0] = (exif ? 0x08 : 0) | (animated ? 0x02 : 0); vp8x.writeUIntLE(3, 4, 3); vp8x.writeUIntLE(1, 7, 3); // 4 × 2
  const vp8l = Buffer.alloc(6); vp8l[0] = 0x2f; vp8l.writeUInt32LE(3 | (1 << 14), 1);
  const body = Buffer.concat([riffChunk('VP8X', vp8x), ...(animated ? [riffChunk('ANIM', Buffer.alloc(6))] : []), riffChunk('VP8L', vp8l), ...(exif ? [riffChunk('EXIF', Buffer.from('camera-serial'))] : [])]);
  const head = Buffer.alloc(12); head.write('RIFF', 0, 'latin1'); head.writeUInt32LE(body.length + 4, 4); head.write('WEBP', 8, 'latin1');
  return Buffer.concat([head, body]);
}

test('images are identified from their bytes; metadata is removed without touching pixels', () => {
  const p = inspectImage(png({ extra: [chunk('tEXt', Buffer.from('Author\0Someone')), chunk('eXIf', Buffer.from('MM\0*')), chunk('pHYs', Buffer.alloc(9))] }));
  assert.deepEqual([p.mime, p.width, p.height], ['image/png', 2, 2]);
  assert.ok(!p.data.includes('Someone') && !p.data.includes('eXIf'), 'text and EXIF chunks removed');
  assert.ok(p.data.includes('pHYs') && p.data.includes('IDAT'), 'pixel and display chunks kept');
  assert.deepEqual(inspectImage(p.data).data, p.data, 'cleaning is idempotent');

  const j = inspectImage(jpeg());
  assert.deepEqual([j.mime, j.width, j.height], ['image/jpeg', 3, 2]);
  assert.ok(!j.data.includes('GPS') && !j.data.includes('a comment') && j.data.includes('JFIF'), 'EXIF and comments removed, JFIF kept');

  const w = inspectImage(webp());
  assert.deepEqual([w.mime, w.width, w.height], ['image/webp', 4, 2]);
  assert.ok(!w.data.includes('camera-serial'), 'EXIF chunk removed');
  assert.equal(w.data.readUInt32LE(4) + 8, w.data.length, 'RIFF size rewritten');
  assert.equal(w.data[20] & 0x08, 0, 'VP8X EXIF flag cleared');
});

test('unsupported, active, animated, damaged and oversized files are refused', () => {
  const refuse = (buffer, pattern) => assert.throws(() => inspectImage(buffer), pattern);
  refuse(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>'), /Only JPEG, PNG and WebP/);
  refuse(Buffer.from('<!doctype html><script>alert(1)</script>'), /Only JPEG, PNG and WebP/);
  refuse(Buffer.from('GIF89a\x01\0\x01\0\0\0\0;padding', 'latin1'), /Only JPEG, PNG and WebP/);
  refuse(Buffer.concat([png().subarray(0, 8), Buffer.from('<script>alert(1)</script>')]), /PNG/);
  const bad = png(); bad[bad.length - 20] ^= 0xff;
  refuse(bad, /damaged/);
  refuse(png().subarray(0, 40), /PNG/);
  refuse(png({ extra: [chunk('acTL', Buffer.alloc(8))] }), /Animated/);
  refuse(webp({ animated: true }), /Animated/);
  refuse(Buffer.concat([jpeg(), Buffer.from('trailing <html>')]), /truncated/);
  refuse(png({ width: 5000, height: 10 }), /at most 4000/);
  refuse(Buffer.alloc(IMAGE_LIMITS.maxBytes * 2 + 1, 1), /under 2 MB/);
});

test('media definitions: image description or decorative flag, allow-listed videos, option images', () => {
  const asset = 'a'.repeat(32);
  const base = media => ({ title: 'T', presentation: 'classic', fields: [{ id: 'q', type: 'short_text', label: 'Q', media }] });
  assert.deepEqual(definitionProblems(base({ type: 'image', asset, alt: 'A floor plan' })), []);
  assert.deepEqual(definitionProblems(base({ type: 'image', asset, decorative: true })), []);
  assert.match(definitionProblems(base({ type: 'image', asset }))[0], /needs a description, or mark it decorative/);
  assert.match(definitionProblems(base({ type: 'image', asset: '../../etc/passwd', alt: 'x' }))[0], /invalid image/);
  assert.match(definitionProblems(base({ type: 'iframe', html: '<iframe src="https://evil.example">' }))[0], /unsupported media type/);
  assert.match(definitionProblems(base({ type: 'video', provider: 'dailymotion', video: 'x1' }))[0], /YouTube or Vimeo/);
  assert.match(definitionProblems(base({ type: 'video', provider: 'youtube', video: '"><script>' }))[0], /YouTube or Vimeo/);
  assert.deepEqual(definitionProblems(base({ type: 'video', provider: 'vimeo', video: '76979871' })), []);
  assert.match(definitionProblems({ title: 'T', presentation: 'classic', fields: [{ id: 'p', type: 'page_break', label: '', media: { type: 'image', asset, alt: 'x' } }] })[0], /page break/);
  const choice = { title: 'T', presentation: 'classic', fields: [{ id: 'c', type: 'single_choice', label: 'C', options: [{ id: 'a', label: 'A', image: { asset } }, { id: 'b', label: 'B', image: { asset: 'nope' } }] }] };
  assert.match(definitionProblems(choice)[0], /option with an invalid image/);
  choice.fields[0].options[1].image = { asset: 'b'.repeat(32) };
  assert.deepEqual(definitionAssets({ fields: [base({ type: 'image', asset, alt: 'x' }).fields[0], ...choice.fields] }), [asset, 'b'.repeat(32)]);
});

test('video links: only exact YouTube and Vimeo addresses become controlled embeds', () => {
  const ok = [['https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10', 'youtube'], ['https://youtu.be/dQw4w9WgXcQ', 'youtube'], ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube'],
    ['https://www.youtube.com/embed/dQw4w9WgXcQ', 'youtube'], ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube'], ['https://vimeo.com/76979871', 'vimeo'], ['https://player.vimeo.com/video/76979871', 'vimeo']];
  for (const [url, provider] of ok) assert.equal(parseVideoUrl(url)?.provider, provider, url);
  assert.equal(videoEmbedUrl(parseVideoUrl('https://youtu.be/dQw4w9WgXcQ')), 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ?rel=0');
  assert.equal(videoEmbedUrl(parseVideoUrl('https://vimeo.com/76979871')), 'https://player.vimeo.com/video/76979871?dnt=1');
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', '<iframe src="https://www.youtube.com/embed/dQw4w9WgXcQ"></iframe>',
    'https://youtube.com.evil.example/watch?v=dQw4w9WgXcQ', 'https://evil.example/youtube.com/watch?v=dQw4w9WgXcQ', 'https://user@youtube.com/watch?v=dQw4w9WgXcQ',
    'https://youtube.com:8443/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=short', 'https://www.youtube.com/embed/dQw4w9WgXcQ/../../x', 'https://vimeo.com/abc', 'https://vimeo.com/76979871/abcdef12',
    'ftp://youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/watch?v=dQw4w9WgXc%22', 'http://127.0.0.1/watch?v=dQw4w9WgXcQ', '']) assert.equal(parseVideoUrl(url), null, url);
});

test('picture choices: answers, logic and type changes use option ids, never images', () => {
  const asset = 'c'.repeat(32);
  const definition = { title: 'T', presentation: 'classic', fields: [
    { id: 'style', type: 'single_choice', label: 'Style', required: true, options: [{ id: 'modern', label: 'Modern', image: { asset } }, { id: 'classic', label: 'Classic', image: { asset: 'd'.repeat(32) } }] },
    { id: 'why', type: 'short_text', label: 'Why modern?', required: true, show_if: { field: 'style', op: 'equals', value: 'modern' } }] };
  assert.deepEqual(validateSubmission(definition, { style: 'modern', why: 'Light' }).answers, { style: 'modern', why: 'Light' });
  assert.deepEqual(Object.keys(validateSubmission(definition, { style: `/api/public/form-assets/${asset}` }).errors), ['style'], 'an image address is not an answer');
  assert.deepEqual(visibleFields(definition, { style: 'classic' }).map(field => field.id), ['style']);
  const multiple = planTypeChange({ field: definition.fields[0], to: 'multiple_choice', fields: definition.fields, newKey: p => p + '_x' });
  assert.deepEqual(multiple.next.options, definition.fields[0].options, 'options keep their ids and images');
  const toText = planTypeChange({ field: { ...definition.fields[0] }, to: 'short_text', fields: [{ ...definition.fields[0] }], newKey: p => p + '_x' });
  assert.equal(toText.kind, 'confirm');
  assert.match(toText.effects.join(' '), /options and their pictures are removed/);
});

const tinyPng = () => png().toString('base64');

test('uploads: forms.manage only, deduplicated, quota-limited; reads are workspace-scoped', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Media');
    const stranger = env.client();
    const { ws: other } = await signUp(stranger, 'Other');
    const path = `/api/workspaces/${ws.id}/form-assets`;
    assert.equal((await env.client().post(path, { data: tinyPng() })).status, 401);
    assert.equal((await stranger.post(path, { data: tinyPng() })).status, 404, 'another workspace cannot upload here');
    const svg = await owner.post(path, { data: Buffer.from('<svg onload="alert(1)"/>').toString('base64') });
    assert.deepEqual([svg.status, svg.body.error.code], [400, 'invalid_image']);
    const first = await owner.post(path, { data: tinyPng() });
    assert.equal(first.status, 201);
    assert.match(first.body.id, /^[a-f0-9]{32}$/);
    assert.deepEqual([first.body.width, first.body.height, first.body.mime], [2, 2, 'image/png']);
    assert.equal((await owner.post(path, { data: tinyPng() })).body.id, first.body.id, 'same image reuses the stored copy');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM form_assets').count, 1);
    const read = await owner.get(`${path}/${first.body.id}`);
    assert.deepEqual([read.status, read.headers.get('content-type'), read.headers.get('x-content-type-options')], [200, 'image/png', 'nosniff']);
    assert.match(read.headers.get('content-security-policy'), /sandbox/);
    assert.equal((await stranger.get(`/api/workspaces/${other.id}/form-assets/${first.body.id}`)).status, 404, 'another workspace cannot read it');
    assert.equal((await owner.get(`${path}/${'f'.repeat(32)}`)).status, 404, 'a guessed id finds nothing');
    assert.equal((await env.client().get(`/api/public/form-assets/${first.body.id}`)).status, 404, 'not public while only uploaded');
    // Workspace quota: pretend earlier uploads used the allowance.
    env.app.db.run('INSERT INTO form_assets (id, workspace_id, mime, width, height, bytes, sha256, data, created_at) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?)', 'e'.repeat(32), ws.id, 'image/png', IMAGE_LIMITS.workspaceBytes, 'x', '', env.app.now());
    const full = await owner.post(path, { data: png({ width: 3, height: 3 }).toString('base64') });
    assert.deepEqual([full.status, full.body.error.code], [413, 'asset_quota']);
  } finally { await env.close(); }
});

test('uploads: concurrent requests cannot overrun the quota; the service budget counts database space; reuse restarts cleanup', async () => {
  const env = await setup({ config: { formImageStorageBytes: 4000 } });
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Quota');
    const path = `/api/workspaces/${ws.id}/form-assets`;
    const a = png({ width: 3, height: 3 }).toString('base64');
    const b = png({ width: 4, height: 4 }).toString('base64');
    const size = Buffer.from(a, 'base64').length;
    // Room for exactly one more image: two parallel uploads, one is accepted.
    env.app.db.run('INSERT INTO form_assets (id, workspace_id, mime, width, height, bytes, sha256, data, created_at) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?)', 'd'.repeat(32), ws.id, 'image/png', IMAGE_LIMITS.workspaceBytes - size - 10, 'filler', '', env.app.now());
    env.app.config.formImageStorageBytes = Number.MAX_SAFE_INTEGER;
    const results = await Promise.all([owner.post(path, { data: a }), owner.post(path, { data: b })]);
    assert.deepEqual(results.map(r => r.status).sort(), [201, 413], 'exactly one parallel upload fits');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM form_assets WHERE workspace_id = ?', ws.id).count, 2);
    env.app.db.run('DELETE FROM form_assets');
    // Service-wide budget counts stored base64 text, not image bytes.
    env.app.config.formImageStorageBytes = 4000;
    env.app.db.run('INSERT INTO form_assets (id, workspace_id, mime, width, height, bytes, sha256, data, created_at) VALUES (?, ?, ?, 1, 1, ?, ?, ?, ?)', 'c'.repeat(32), ws.id, 'image/png', 2950, 'filler', '', env.app.now());
    const full = await owner.post(path, { data: a });
    assert.deepEqual([full.status, full.body.error.code], [507, 'asset_storage_full'], '2950 image bytes take 3936 bytes of text, so the next image does not fit');
    env.app.db.run('DELETE FROM form_assets');
    // Reusing an old unused copy restarts its cleanup clock.
    const first = (await owner.post(path, { data: a })).body.id;
    env.clock.now += 3 * 86400000;
    assert.equal((await owner.post(path, { data: a })).body.id, first);
    assert.equal(pruneAssets(env.app), 0, 'the re-chosen image survives cleanup until the draft saves it');
  } finally { await env.close(); }
});

test('forms: only own images; published versions keep theirs; public access follows collection; cleanup spares references', async () => {
  const env = await setup();
  try {
    const owner = env.client();
    const { ws } = await signUp(owner, 'Versions');
    const stranger = env.client();
    const { ws: other } = await signUp(stranger, 'Elsewhere');
    const asset = (await owner.post(`/api/workspaces/${ws.id}/form-assets`, { data: tinyPng() })).body.id;
    const foreign = (await stranger.post(`/api/workspaces/${other.id}/form-assets`, { data: png({ width: 5, height: 5 }).toString('base64') })).body.id;
    const definition = image => ({ title: 'Media form', presentation: 'classic', fields: [{ id: 'q', type: 'short_text', label: 'Question', required: false, ...(image ? { media: { type: 'image', asset: image, alt: '  A room  ' } } : {}) }] });
    const base = `/api/workspaces/${ws.id}/forms`;
    assert.equal((await owner.post(base, { definition: definition(foreign) })).status, 400, 'another workspace image is refused');
    assert.equal((await owner.post(base, { definition: definition('a'.repeat(32)) })).status, 400, 'an unknown image is refused');
    const form = (await owner.post(base, { definition: definition(asset) })).body;
    assert.deepEqual(form.draft.fields[0].media, { type: 'image', asset, alt: 'A room' });
    assert.equal((await env.client().get(`/api/public/form-assets/${asset}`)).status, 404, 'draft images are not public');
    await owner.post(`${base}/${form.id}/publish`, {});
    const live = await env.client().get(`/api/public/form-assets/${asset}`);
    assert.deepEqual([live.status, live.headers.get('content-type'), live.headers.get('cross-origin-resource-policy')], [200, 'image/png', 'same-origin']);
    // Remove the image from the draft and publish version 2: version 1 still holds it.
    const saved = (await owner.patch(`${base}/${form.id}`, { definition: definition(null) })).body;
    assert.equal(saved.has_unpublished_changes, true);
    assert.equal((await env.client().get(`/api/public/forms/${form.slug}`)).body.definition.fields[0].media.asset, asset, 'the live form is unchanged until publish');
    await owner.post(`${base}/${form.id}/publish`, {});
    env.clock.now += 2 * 86400000;
    applyRetention(env.app);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM form_assets WHERE id = ?', asset).count, 1, 'an image a published version shows is kept');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM form_assets WHERE id = ?', foreign).count, 0, 'an old unreferenced upload in another workspace is cleared');
    assert.equal((await owner.get(`${base}/${form.id}/responses`)).body.versions[1].fields[0].media.asset, asset, 'version 1 still shows it');
    assert.equal((await env.client().get(`/api/public/form-assets/${asset}`)).status, 200, 'served while the form collects (in-flight respondents may hold version 1)');
    await owner.post(`${base}/${form.id}/unpublish`);
    assert.equal((await env.client().get(`/api/public/form-assets/${asset}`)).status, 404, 'closed forms stop serving images');
    // Unreferenced uploads are removed after a day; referenced ones and recent ones stay.
    const loose = (await owner.post(`/api/workspaces/${ws.id}/form-assets`, { data: png({ width: 7, height: 7 }).toString('base64') })).body.id;
    assert.equal(pruneAssets(env.app), 0, 'nothing else is old and unreferenced');
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM form_assets WHERE id = ?', loose).count, 1, 'a recent upload stays');
    await owner.del(`${base}/${form.id}`);
    env.clock.now += 2 * 86400000;
    pruneAssets(env.app);
    assert.equal(env.app.db.get('SELECT COUNT(*) AS count FROM form_assets WHERE workspace_id = ?', ws.id).count, 0, 'deleting the form lets its images be cleared');
  } finally { await env.close(); }
});

test('CSP: forms pages may frame only the two privacy-mode players; meeting pages and Vercel stay consistent', async () => {
  const env = await setup();
  try {
    const players = 'frame-src https://www.youtube-nocookie.com https://player.vimeo.com';
    const page = await env.client().get('/forms');
    assert.ok(page.headers.get('content-security-policy').endsWith(players), 'app pages allow exactly the two player origins');
    assert.doesNotMatch(page.headers.get('content-security-policy'), /\*|unsafe-inline|unsafe-eval/);
    assert.doesNotMatch(env.app.meetingCsp, /youtube|vimeo/, 'meeting rooms do not gain frame sources');
    const { readFileSync } = await import('node:fs');
    const vercel = JSON.parse(readFileSync(new URL('../../frontend/vercel.json', import.meta.url), 'utf8'));
    const policies = vercel.headers.flatMap(rule => rule.headers.filter(header => header.key === 'Content-Security-Policy').map(header => [rule.source, header.value]));
    for (const [source, value] of policies) {
      if (source.startsWith('/meet/')) assert.doesNotMatch(value, /youtube|vimeo/, source);
      else assert.ok(value.endsWith(players), source);
    }
  } finally { await env.close(); }
});

test('PostgreSQL: an existing database gains the image tables once; workspace deletion removes images and references', { skip: process.env.RUN_POSTGRES_TESTS !== 'true', timeout: 120000 }, () => {
  const config = loadConfig();
  const schemaName = 'schedora_test_' + randomUUID().replaceAll('-', '');
  let db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
  try {
    // Simulate a database created before migration 014.
    db.exec('DROP TABLE form_version_assets');
    db.exec('DROP TABLE form_assets');
    db.run("DELETE FROM schema_migrations WHERE name = 'postgres_v13_form_assets'");
    db.close();
    db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
    assert.equal(db.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = 'postgres_v13_form_assets'").count, 1);
    db.run("INSERT INTO workspaces (id, slug, name, created_at) VALUES ('media-ws', 'media-ws', 'Media', 1)");
    db.run("INSERT INTO forms (id, workspace_id, slug, draft, created_by, created_at, updated_at) VALUES ('media-form', 'media-ws', 'media-form', '{}', 'someone', 1, 1)");
    db.run("INSERT INTO form_assets (id, workspace_id, mime, width, height, bytes, sha256, data, created_at) VALUES (?, 'media-ws', 'image/png', 1, 1, 3, 'x', 'AAAA', 1)", 'a'.repeat(32));
    db.run("INSERT INTO form_version_assets (form_id, version, asset_id) VALUES ('media-form', 1, ?)", 'a'.repeat(32));
    assert.throws(() => db.run("INSERT INTO form_assets (id, workspace_id, mime, width, height, bytes, sha256, data, created_at) VALUES (?, 'media-ws', 'image/svg+xml', 1, 1, 3, 'y', 'AAAA', 1)", 'b'.repeat(32)), 'only JPEG, PNG and WebP are storable');
    assert.equal(db.get('SELECT CAST(SUM(bytes) AS BIGINT) AS total FROM form_assets').total, 3);
    db.close();
    db = openPostgres(config.databaseUrl, { ca: config.databaseCa, schemaName });
    assert.equal(db.get("SELECT COUNT(*) AS count FROM schema_migrations WHERE name = 'postgres_v13_form_assets'").count, 1, 'the upgrade runs once');
    db.run("DELETE FROM workspaces WHERE id = 'media-ws'");
    assert.deepEqual([db.get('SELECT COUNT(*) AS count FROM form_assets').count, db.get('SELECT COUNT(*) AS count FROM form_version_assets').count], [0, 0]);
  } finally { db.exec('DROP SCHEMA "' + schemaName + '" CASCADE'); db.close(); }
});
