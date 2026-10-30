// These policy modules run on both the server and in the browser. Their source of truth is
// backend/src/shared/; this copies it into frontend/shared/ (Vercel deploys only frontend/).
// Usage: npm run sync-shared        Verify only: npm run sync-shared -- --check
import { copyFileSync, readFileSync } from 'node:fs';

for (const name of ['forms-logic.mjs', 'meet-readiness-policy.mjs']) {
  const source = new URL('../src/shared/' + name, import.meta.url);
  const target = new URL('../../frontend/shared/' + name, import.meta.url);
  const same = (() => { try { return readFileSync(source, 'utf8') === readFileSync(target, 'utf8'); } catch { return false; } })();
  if (process.argv.includes('--check')) {
    if (!same) { console.error('frontend/shared/' + name + ' is out of date. Run: npm run sync-shared'); process.exit(1); }
    console.log('Shared ' + name + ' is in sync.');
  } else {
    copyFileSync(source, target);
    console.log('Copied ' + name + ' to frontend/shared/.');
  }
}
