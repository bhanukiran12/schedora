// Syntax-checks every backend and frontend module without running them.
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const roots = ['../server.mjs', '../src', '../scripts', '../test', '../../frontend'].map(path => fileURLToPath(new URL(path, import.meta.url)));
const files = [];
const walk = path => statSync(path).isDirectory() ? readdirSync(path).forEach(name => walk(join(path, name))) : /\.(m?js)$/.test(path) && files.push(path);
roots.forEach(walk);
for (const file of files) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
console.log(`Checked ${files.length} files.`);
