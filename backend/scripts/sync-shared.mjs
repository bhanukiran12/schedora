// These policy modules run on both the server and in the browser. Their source of truth is
// backend/src/shared/; this copies it into frontend/shared/ (Vercel deploys only frontend/).
// Usage: npm run sync-shared        Verify only: npm run sync-shared -- --check
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const check = process.argv.includes('--check');
const normalizeNewlines = (source) => source.replaceAll('\r\n', '\n');
function sync(name, source) {
  const target = new URL('../../frontend/shared/' + name, import.meta.url);
  const content = readFileSync(source, 'utf8');
  if (check) {
    const saved = readFileSync(target, { encoding: 'utf8', flag: 'r' });
    if (normalizeNewlines(saved) !== normalizeNewlines(content)) throw new Error(`frontend/shared/${name} is out of date. Run npm run sync-shared.`);
    return console.log(`Shared ${name} is in sync.`);
  }
  writeFileSync(target, content);
  console.log(`Copied ${name} to frontend/shared/.`);
}

const build = mkdtempSync(join(tmpdir(), 'schedora-sheets-engine-'));
try {
  const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
  const config = fileURLToPath(new URL('../tsconfig.sheets.json', import.meta.url));
  execFileSync(process.execPath, [compiler, '-p', config, '--outDir', build], { stdio: 'inherit' });
  for (const name of ['forms-logic.mjs', 'flow-logic.mjs', 'meet-readiness-policy.mjs', 'workbook-ops.mjs', 'workbook-settings.mjs']) {
    sync(name, new URL('../src/shared/' + name, import.meta.url));
  }
  if (!check) mkdirSync(new URL('../../frontend/shared/sheets-engine/', import.meta.url), { recursive: true });
  for (const name of ['address', 'dependencies', 'evaluator', 'index', 'parser', 'types']) {
    const path = `sheets-engine/${name}.mjs`;
    sync(path, join(build, path));
  }
} finally {
  rmSync(build, { recursive: true, force: true });
}
