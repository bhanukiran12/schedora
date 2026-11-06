// The staging preflight must refuse a frontend whose API is really production, whatever its address says.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('../scripts/staging-preflight.mjs', import.meta.url));
const serve = config => new Promise(resolve => {
  const server = createServer((request, response) => {
    if (request.method !== 'GET') { server.nonGet = true; response.writeHead(405); return response.end(); }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url === '/api/config') return response.end(JSON.stringify(config));
    if (request.url === '/api/health') return response.end(JSON.stringify({ status: 'ok', storage: 'postgres' }));
    response.end('export const CLIENT_EVALUATOR = 2;');
  });
  server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}` }));
});
const run = (frontend, backend) => new Promise(resolve => {
  let output = '';
  const child = spawn(process.execPath, [script, '--frontend', frontend, '--backend', backend]);
  child.stdout.on('data', chunk => { output += chunk; });
  child.on('exit', status => resolve({ status, output }));
});

test('passes only when the frontend reaches the staging backend, using only GET', async () => {
  const staging = await serve({ deployment: 'staging', productDomain: 'staging.example' });
  try {
    const result = await run(staging.url, staging.url);
    assert.equal(result.status, 0, result.output);
    assert.ok(result.output.includes('confirm') || result.output.includes('Confirm'));
    assert.notEqual(staging.server.nonGet, true);
  } finally { staging.server.close(); }
});

test('refuses a frontend forwarding to production, even beside a healthy staging backend', async () => {
  const production = await serve({ productDomain: 'schedora.in' }); // production sets no deployment name
  const staging = await serve({ deployment: 'staging', productDomain: 'staging.example' });
  try {
    const result = await run(production.url, staging.url);
    assert.equal(result.status, 1);
    assert.match(result.output, /FAIL {2}the frontend's API says it is staging/);
    assert.match(result.output, /Do not submit any data/);
  } finally { production.server.close(); staging.server.close(); }
});

test('refuses a frontend forwarding to another staging-looking backend', async () => {
  const one = await serve({ deployment: 'staging', productDomain: 'one.example' });
  const two = await serve({ deployment: 'staging', productDomain: 'two.example' });
  try {
    const result = await run(one.url, two.url);
    assert.equal(result.status, 1);
    assert.match(result.output, /FAIL {2}the frontend's API and the backend report the same configuration/);
  } finally { one.server.close(); two.server.close(); }
});

test('refuses production addresses and an unreachable service', () => {
  const production = spawnSync(process.execPath, [script, '--frontend', 'https://forms.schedora.in', '--backend', 'https://schedora-api.onrender.com'], { encoding: 'utf8', timeout: 1000 });
  // It may be stopped by the timeout before finishing its reads; the address checks are printed first.
  assert.match(production.stdout, /FAIL {2}frontend is not a production address/);
  assert.match(production.stdout, /FAIL {2}backend is not a production address/);
  const missing = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
});
