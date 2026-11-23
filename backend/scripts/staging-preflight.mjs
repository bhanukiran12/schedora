// Run before submitting anything to a staging frontend. It finds out where that frontend really sends its
// API requests, using only GET requests, and refuses unless it reaches the intended staging backend.
// A Vercel preview of this repository forwards /api to the production backend, so looks are not enough.
//
// Usage: npm run staging-preflight -- --frontend https://<staging frontend> --backend https://<staging backend>
// Exit 0 only when every check passes. Database isolation must be verified separately.
const argument = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
const frontend = (argument('--frontend') || '').replace(/\/$/, '');
const backend = (argument('--backend') || '').replace(/\/$/, '');
if (!frontend || !backend) { console.error('Give --frontend <url> and --backend <url>.'); process.exit(2); }

const PRODUCTION_HOST = /(^|\.)schedora\.in\.?$|^schedora-api\.onrender\.com\.?$/i;
const AWS_STAGING_HOST = /^(?:(?:meet|forms|flow)\.)?staging\.schedora\.in$/;
const results = [];
const check = (name, ok, detail = '') => { results.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok || !detail ? '' : ' :: ' + detail}`); };
const read = async url => {
  try {
    const response = await fetch(url, { headers: { 'User-Agent': 'schedora-staging-preflight' }, redirect: 'manual', signal: AbortSignal.timeout(70000) });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { /* not JSON */ }
    return { status: response.status, body, text, headers: response.headers };
  } catch (error) { return { status: 0, body: null, text: '', error: error.message }; }
};

const usesAwsStaging = [frontend, backend].some(url => AWS_STAGING_HOST.test(new URL(url).hostname));
for (const [name, address] of [['frontend', frontend], ['backend', backend]]) {
  const url = new URL(address);
  const awsStaging = url.protocol === 'https:' && !url.port && AWS_STAGING_HOST.test(url.hostname);
  check(`${name} is not a production address`, !url.username && !url.password && (usesAwsStaging ? awsStaging : !PRODUCTION_HOST.test(url.hostname)), url.origin);
}

const viaFrontend = await read(`${frontend}/api/config`);
const direct = await read(`${backend}/api/config`);
check('frontend answers /api/config', viaFrontend.status === 200 && viaFrontend.body, `status ${viaFrontend.status}`);
check('backend answers /api/config', direct.status === 200 && direct.body, `status ${direct.status}`);
check('the frontend\'s API says it is staging', viaFrontend.body?.deployment === 'staging', `deployment=${viaFrontend.body?.deployment ?? 'none'}: this may be forwarding to production`);
check('the backend says it is staging', direct.body?.deployment === 'staging', `deployment=${direct.body?.deployment ?? 'none'}: set RELEASE_ENVIRONMENT=staging`);
check('the frontend\'s API and the backend report the same configuration', viaFrontend.text && viaFrontend.text === direct.text, 'they differ, so the frontend may be forwarding somewhere else');

check('the backend does not use the production domain', viaFrontend.body?.productDomain && viaFrontend.body.productDomain !== 'schedora.in', 'set PRODUCT_DOMAIN=staging.invalid, or links lead to production');
if (usesAwsStaging) check('AWS staging reports the staging product domain', direct.body?.productDomain === 'staging.schedora.in', `productDomain=${direct.body?.productDomain || 'unknown'}`);

const health = await read(`${frontend}/api/health`);
check('health is ok through the frontend', health.body?.status === 'ok', health.text.slice(0, 120));
check('staging stores data in PostgreSQL', health.body?.storage === 'postgres', `storage=${health.body?.storage ?? 'unknown'}`);

const logic = await read(`${frontend}/shared/forms-logic.mjs`);
observeFrontend(logic);
function observeFrontend(file) {
  console.log(`NOTE  frontend logic: ${file.text.includes('CLIENT_EVALUATOR') ? 'release build' : 'previous or rollback build'}`);
  console.log(`NOTE  authoring: ${viaFrontend.body?.formsAuthoringFrozen ? 'frozen' : 'open'}`);
}
// Shared-database release: Flow v1 activation must stay held until every server runs the release (FLOW_V1_STAGING_RELEASE.md §4).
console.log(`NOTE  Flow v1 activation: ${viaFrontend.body?.flowActivationHeld ? 'held' : 'on'}`);
if (process.argv.includes('--expect-flow-held')) check('Flow v1 activation is held on this server', viaFrontend.body?.flowActivationHeld === true, 'set FLOW_V1_ACTIVATION=held in this task definition');
console.log('MANUAL  Confirm that the staging database may be used for this test.');

const failed = results.filter(ok => !ok).length;
console.log(`\n${results.length} checks, ${failed} failed.`);
if (failed) console.log('Do not submit any data through this frontend.');
process.exitCode = failed ? 1 : 0;
