// The forms logic module runs on both the server and in the browser. Its source of truth is
// backend/src/shared/; this copies it into frontend/shared/ (Vercel deploys only frontend/).
// Usage: npm run sync-shared        Verify only: npm run sync-shared -- --check
import { copyFileSync, readFileSync } from 'node:fs';

const source = new URL('../src/shared/forms-logic.mjs', import.meta.url);
const target = new URL('../../frontend/shared/forms-logic.mjs', import.meta.url);
const same = (() => { try { return readFileSync(source, 'utf8') === readFileSync(target, 'utf8'); } catch { return false; } })();
if (process.argv.includes('--check')) {
  if (!same) { console.error('frontend/shared/forms-logic.mjs is out of date. Run: npm run sync-shared'); process.exit(1); }
  console.log('Shared forms logic is in sync.');
} else {
  copyFileSync(source, target);
  console.log('Copied shared forms logic to frontend/shared/.');
}
