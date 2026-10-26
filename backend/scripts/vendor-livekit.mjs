// The meeting page loads the LiveKit browser SDK from the site itself (CSP allows scripts only
// from 'self', and the frontend has no build step). This copies the pinned package's
// self-contained ESM bundle into frontend/vendor/ with a header recording version and checksum.
// Usage: npm run vendor-livekit        Verify only: npm run vendor-livekit -- --check
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const pinned = pkg.devDependencies['livekit-client'];
if (!/^\d+\.\d+\.\d+$/.test(pinned)) { console.error('Pin livekit-client to an exact version in package.json.'); process.exit(1); }
const source = new URL('../node_modules/livekit-client/dist/livekit-client.esm.mjs', import.meta.url);
const target = new URL('../../frontend/vendor/livekit-client.esm.mjs', import.meta.url);
const header = (version, digest) => `/* livekit-client ${version} (Apache-2.0, https://github.com/livekit/client-sdk-js). Vendored by backend/scripts/vendor-livekit.mjs; sha256 ${digest}. Do not edit. */\n`;
const sha = text => createHash('sha256').update(text).digest('hex');

if (process.argv.includes('--check')) {
  if (!existsSync(target)) { console.error('frontend/vendor/livekit-client.esm.mjs is missing. Run: npm run vendor-livekit'); process.exit(1); }
  const vendored = readFileSync(target, 'utf8');
  const [first, ...rest] = vendored.split('\n');
  const body = rest.join('\n');
  const match = /^\/\* livekit-client (\S+) .* sha256 ([a-f0-9]{64})\. Do not edit\. \*\/$/.exec(first);
  if (!match || match[1] !== pinned || match[2] !== sha(body)) { console.error('Vendored LiveKit client does not match the pinned version. Run: npm run vendor-livekit'); process.exit(1); }
  if (existsSync(source) && JSON.parse(readFileSync(new URL('../node_modules/livekit-client/package.json', import.meta.url), 'utf8')).version === pinned && readFileSync(source, 'utf8') !== body) {
    console.error('Vendored LiveKit client differs from the installed package. Run: npm run vendor-livekit'); process.exit(1);
  }
  console.log(`Vendored LiveKit client ${pinned} is in sync.`);
} else {
  const installed = JSON.parse(readFileSync(new URL('../node_modules/livekit-client/package.json', import.meta.url), 'utf8')).version;
  if (installed !== pinned) { console.error(`Installed livekit-client ${installed} does not match the pin ${pinned}. Run npm ci.`); process.exit(1); }
  const body = readFileSync(source, 'utf8');
  if (/^\s*import\s/m.test(body.slice(0, 2000)) || /\bnew Function\(|\beval\(/.test(body)) { console.error('Bundle is not self-contained or uses eval; it cannot run under the site CSP.'); process.exit(1); }
  mkdirSync(new URL('../../frontend/vendor/', import.meta.url), { recursive: true });
  writeFileSync(target, header(pinned, sha(body)) + body);
  console.log(`Vendored livekit-client ${pinned}.`);
}
