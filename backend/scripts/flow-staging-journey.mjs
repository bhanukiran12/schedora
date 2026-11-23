// Flow v1 acceptance journey over HTTP (docs/FLOW_V1_STAGING_RELEASE.md, "Staging journey").
//
// Form with a private lead score → booking from the form's handoff → Flow: only if Hot → wait 1 minute →
// a person approves → follow-up email → Sheets row updated. Then: a canceled booking stops its pending
// run, a second tenant cannot read or decide the first tenant's workflow or approval, and consent
// withdrawal stops messages. Everything is created in a new synthetic account that is deleted at the end.
//
//   Local rehearsal (fake providers, nothing leaves the machine):
//     node scripts/flow-staging-journey.mjs --base http://127.0.0.1:<port>
//   AWS staging, only when live testing is authorized for this run:
//     FLOW_QA_LIVE_AUTHORIZED=yes FLOW_QA_EMAIL=<your own test inbox> node scripts/flow-staging-journey.mjs --base https://staging.schedora.in --live
//
// It never targets production hosts, never takes a payment, and sends at most two emails, both to
// FLOW_QA_EMAIL (live) or example.com addresses (local outbox).
import { randomUUID, randomBytes } from 'node:crypto';

const argument = name => { const at = process.argv.indexOf(name); return at > 0 ? process.argv[at + 1] : null; };
const base = (argument('--base') || '').replace(/\/$/, '');
const live = process.argv.includes('--live');
if (!base) { console.error('Give --base <url>.'); process.exit(2); }
const host = new URL(base).hostname;
const local = ['127.0.0.1', 'localhost', '::1'].includes(host);
const AWS_STAGING = /^(?:(?:meet|forms|flow)\.)?staging\.schedora\.in$/;
if (!local) {
  if (!live || !AWS_STAGING.test(host)) { console.error('Refusing: only local servers, or AWS staging with --live.'); process.exit(2); }
  if (process.env.FLOW_QA_LIVE_AUTHORIZED !== 'yes' || !process.env.FLOW_QA_EMAIL) { console.error('Refusing: live staging needs FLOW_QA_LIVE_AUTHORIZED=yes and FLOW_QA_EMAIL (your own test inbox).'); process.exit(2); }
}
const stamp = Date.now().toString(36);
const inbox = local ? null : process.env.FLOW_QA_EMAIL;
const address = tag => inbox ? inbox.replace('@', `+flowqa-${stamp}-${tag}@`) : `flowqa-${stamp}-${tag}@example.com`;

const checks = [];
const check = (name, ok, detail = '') => { checks.push(Boolean(ok)); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function client() {
  let cookie = '';
  let csrf = '';
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(base + path, { method, redirect: 'manual', headers: { 'User-Agent': 'schedora-flow-qa', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(/,(?=\s*[A-Za-z0-9_]+=)/).map(part => part.split(';')[0]).filter(part => !part.endsWith('=')).join('; ') || cookie;
    const text = await response.text();
    let parsed = text;
    try { parsed = JSON.parse(text); } catch { /* not JSON */ }
    if (parsed?.csrf_token) csrf = parsed.csrf_token;
    return { status: response.status, body: parsed };
  };
  return { get: path => request('GET', path), post: (path, body = {}, headers) => request('POST', path, body, headers), put: (path, body = {}) => request('PUT', path, body), del: (path, body) => request('DELETE', path, body) };
}
const must = (response, label, statuses = [200, 201]) => { if (!statuses.includes(response.status)) throw new Error(`${label}: HTTP ${response.status} ${JSON.stringify(response.body).slice(0, 300)}`); return response.body; };
async function until(fn, label, timeout = 150000, every = 2000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeout) { last = await fn(); if (last) return last; await sleep(every); }
  throw new Error('Timed out waiting for ' + label);
}

const owner = client();
const other = client();
const password = randomBytes(18).toString('base64url');
const accounts = [];
async function signUp(http, name, tag) {
  const email = address(tag);
  const body = must(await http.post('/api/auth/signup', { name, email, password, workspace: `Flow QA ${stamp} ${tag}` }), 'signup');
  accounts.push({ http, workspace: body.workspaces[0] });
  return body.workspaces[0];
}

let exitCode = 0;
try {
  const health = must(await owner.get('/api/health'), 'health');
  check('server healthy before the journey', health.status === 'ok' && health.database === 'ok' && !health.worker?.stale, `${health.storage}, worker ${health.worker?.stale ? 'stale' : 'ticking'}`);
  const ws = await signUp(owner, 'Flow QA Owner', 'owner');
  const api = path => `/api/workspaces/${ws.id}${path}`;
  // Plans: open billing needs nothing; staging's test billing activates Suite without charging.
  if ((await owner.get(api('/flow/workflows'))).status === 402) await owner.post(api('/billing/test-events'), { action: 'checkout', plan: 'suite' });

  const type = must(await owner.post(api('/event-types'), { title: `Flow QA consult ${stamp}`, timezone: 'UTC', published: true, min_notice_min: 0 }), 'event type');
  const book = must(await owner.post(api('/workbooks'), { title: `Flow QA leads ${stamp}` }), 'workbook');
  const sheet = must(await owner.get(api(`/workbooks/${book.id}`)), 'workbook read').sheets[0];
  must(await owner.post(api(`/workbooks/${book.id}/changes`), { ops: [['A1', 'Name'], ['B1', 'Email'], ['C1', 'Status']].map(([cell, to]) => ({ op: 'cell', sheet: sheet.id, cell, from: null, to })) }), 'sheet headers');
  const form = must(await owner.post(api('/forms'), { definition: { title: `Flow QA enquiry ${stamp}`, presentation: 'classic', mode: 'lead_qualification', lead_scoring: { warm: 25, hot: 50 }, fields: [
    { id: 'name', type: 'short_text', label: 'Your name', required: true },
    { id: 'email', type: 'email', label: 'Email', required: true },
    { id: 'timing', type: 'single_choice', label: 'When would you start?', required: true, options: [{ id: 'now', label: 'This month', lead_points: 60 }, { id: 'later', label: 'Exploring', lead_points: 5 }] }
  ] } }), 'lead form');
  must(await owner.put(api(`/forms/${form.id}/routing`), { routing: { rules: [{ condition: { field: 'timing', op: 'answered' }, action: { type: 'event', event_type_id: type.id } }] } }), 'booking handoff');
  must(await owner.post(api(`/forms/${form.id}/publish`)), 'publish form');
  const publicForm = must(await owner.get(`/api/public/forms/${form.slug}`), 'public form');
  check('lead points stay private on the public form', !JSON.stringify(publicForm).includes('lead_points') && !JSON.stringify(publicForm).includes('lead_scoring'));

  const definition = { trigger: { type: 'meet.booking.created', source: type.id }, steps: [
    { id: 'hot', type: 'condition', match: 'all', rules: [{ field: 'lead.band', op: 'equals', value: 'Hot' }] },
    { id: 'pause', type: 'wait', mode: 'duration', minutes: 1 },
    { id: 'review', type: 'approval', approver: 'admins', expires_hours: 24, title: 'Follow up {{contact.name}}' },
    { id: 'mail', type: 'action', action: 'send_email', config: { to: 'contact', subject: `Flow QA follow-up ${stamp}`, body: 'Hi {{contact.name}}, thanks for booking. (Schedora Flow acceptance test.)' } },
    { id: 'row', type: 'action', action: 'sheet_row', config: { workbook: book.id, sheet: sheet.id, mode: 'upsert', match_column: 'Email', match_value: '{{contact.email}}', values: { Name: '{{contact.name}}', Email: '{{contact.email}}', Status: 'Followed up' } } }
  ] };
  const flow = must(await owner.post(api('/flow/workflows'), { name: `Flow QA ${stamp}`, definition }), 'create workflow');
  check('a new workflow is an inactive draft', flow.status === 'draft' && flow.published_version == null);
  must(await owner.post(api(`/flow/workflows/${flow.id}/publish`), { revision: flow.draft_revision }), 'publish workflow');
  const on = await owner.post(api(`/flow/workflows/${flow.id}/status`), { status: 'enabled' });
  check('workflow turns on only with its connections ready', on.status === 200, on.status === 200 ? 'email provider ready' : JSON.stringify(on.body).slice(0, 300));
  if (on.status !== 200) throw new Error('cannot continue without an enabled workflow');

  // Respondent: Hot lead → booking through the handoff.
  const visitor = client();
  const lead = { name: 'Flow QA Lead', email: address('lead') };
  const submitted = must(await visitor.post(`/api/public/forms/${form.slug}/responses`, { answers: { name: lead.name, email: lead.email, timing: 'now' }, submission_id: `flowqa${stamp}lead`.padEnd(24, '0').slice(0, 40) }), 'form response');
  const handoff = new URL(submitted.next.url, base).searchParams.get('handoff');
  check('the form offers a booking (received, not booked yet)', submitted.next?.type === 'booking' && submitted.next.status === 'offered');
  const slots = must(await visitor.get(`/api/public/meet/${ws.slug}/${type.slug}/slots`), 'slots').slots;
  const booked = must(await visitor.post(`/api/public/meet/${ws.slug}/${type.slug}/bookings`, { name: lead.name, email: lead.email, timezone: 'UTC', start: slots[0], handoff }, { 'Idempotency-Key': randomUUID() }), 'booking');
  check('booking linked to the form response', booked.handoff_linked === true);
  const responses = must(await owner.get(api(`/forms/${form.id}/responses`)), 'responses').responses;
  check('the owner sees the private lead score as Hot', responses[0]?.lead_score?.band === 'Hot', JSON.stringify({ score: responses[0]?.lead_score?.score, band: responses[0]?.lead_score?.band }));

  const runs = async () => must(await owner.get(api(`/runs?flow=${flow.id}`)), 'runs');
  const run = await until(async () => (await runs()).find(item => item.subject_id === booked.booking.id), 'the run to start');
  const timeline = id => owner.get(api(`/flow/runs/${id}`)).then(response => must(response, 'timeline'));
  await until(async () => (await timeline(run.id)).run?.status === 'waiting' || (await timeline(run.id)).status === 'waiting', 'the condition to pass and the wait to start', 60000);
  check('condition passed for a Hot lead; the run waits on the server', true);
  const approval = await until(async () => must(await owner.get(api('/flow/approvals')), 'approvals').find(item => item.run_id === run.id), 'the approval request (after the 1-minute wait)', 180000);
  check('approval title names the person, not a token', approval.title === `Follow up ${lead.name}`, approval.title);

  // A second tenant can neither see nor decide it.
  const ws2 = await signUp(other, 'Flow QA Other', 'other');
  const foreign = [
    await other.get(`/api/workspaces/${ws.id}/flow/workflows/${flow.id}`),
    await other.post(`/api/workspaces/${ws2.id}/flow/approvals/${approval.id}`, { decision: 'approve', revision: approval.revision }),
    await other.get(`/api/workspaces/${ws2.id}/flow/runs/${run.id}`)
  ].map(response => response.status);
  check('another tenant cannot read the workflow, decide the approval or read the run', foreign.every(status => [403, 404].includes(status)), foreign.join(', '));
  const foreignBook = await other.get(`/api/workspaces/${ws.id}/workbooks/${book.id}`);
  check('another tenant cannot read the workbook', [403, 404].includes(foreignBook.status), String(foreignBook.status));

  const decided = must(await owner.post(api(`/flow/approvals/${approval.id}`), { decision: 'approve', revision: approval.revision }), 'approve');
  const again = await owner.post(api(`/flow/approvals/${approval.id}`), { decision: 'approve', revision: approval.revision });
  check('approved once; a second decision is refused', decided.status === 'approved' && again.status === 409, `${decided.status} / ${again.status}`);
  const finished = await until(async () => { const view = await timeline(run.id); return ['succeeded', 'failed', 'canceled', 'skipped'].includes(view.run?.status || view.status) && view; }, 'the run to finish', 120000);
  const steps = finished.steps || finished.run?.steps || [];
  const mailStep = steps.find(step => step.id === 'mail');
  check('run finished: follow-up accepted by the email provider, sheet updated', (finished.run?.status || finished.status) === 'succeeded', JSON.stringify(steps.map(step => [step.id, step.status])));
  check('acceptance is reported separately from delivery', mailStep && /accepted|outbox|local/i.test(JSON.stringify(mailStep)) && !/delivered/i.test(JSON.stringify(mailStep.output || {})), JSON.stringify(mailStep?.output || mailStep || {}).slice(0, 200));
  const workbook = JSON.stringify(must(await owner.get(api(`/workbooks/${book.id}`)), 'workbook after'));
  check('Sheets row written once with the follow-up status', workbook.includes('Followed up') && workbook.split(lead.email).length - 1 === 1);

  // Cancellation stops pending work.
  const second = { name: 'Flow QA Cancel', email: address('cancel') };
  const handoff2 = new URL(must(await visitor.post(`/api/public/forms/${form.slug}/responses`, { answers: { name: second.name, email: second.email, timing: 'now' }, submission_id: `flowqa${stamp}cancel`.padEnd(24, '0').slice(0, 40) }), 'second response').next.url, base).searchParams.get('handoff');
  const booked2 = must(await visitor.post(`/api/public/meet/${ws.slug}/${type.slug}/bookings`, { name: second.name, email: second.email, timezone: 'UTC', start: slots[1], handoff: handoff2 }, { 'Idempotency-Key': randomUUID() }), 'second booking');
  const run2 = await until(async () => (await runs()).find(item => item.subject_id === booked2.booking.id), 'the second run');
  must(await owner.post(api(`/bookings/${booked2.booking.id}/cancel`), {}), 'cancel booking', [200, 204]);
  const stopped = await until(async () => { const view = await timeline(run2.id); return ['canceled', 'succeeded', 'failed'].includes(view.run?.status || view.status) && view; }, 'the canceled booking to stop its run', 120000);
  check('canceling the booking stopped its pending run before any follow-up', (stopped.run?.status || stopped.status) === 'canceled', stopped.run?.reason || stopped.reason || '');

  // Exactly one run per booking even though the worker kept ticking.
  const all = await runs();
  check('no repeated runs or effects', all.filter(item => item.subject_id === booked.booking.id).length === 1 && all.length === 2, `${all.length} runs`);
  const usage = must(await owner.get(api('/flow/usage')), 'usage');
  check('usage counts one run per execution', Number(usage.used) === 2, `${usage.used} used`);
} catch (error) {
  console.log('FAIL  journey stopped: ' + error.message);
  exitCode = 1;
} finally {
  // Cleanup: delete the synthetic workspaces and accounts (their workflows, runs, forms, bookings and sheets go with them).
  for (const { http, workspace } of accounts.reverse()) {
    const removed = await http.del(`/api/workspaces/${workspace.id}`, { confirm: workspace.name });
    const gone = await http.del('/api/me', { password });
    console.log(`cleanup: workspace ${[200, 204].includes(removed.status) ? 'deleted' : 'NOT deleted (' + removed.status + ')'}, account ${[200, 204].includes(gone.status) ? 'deleted' : 'NOT deleted (' + gone.status + ')'}`);
  }
}
const failed = checks.filter(ok => !ok).length;
console.log(`\n${checks.length - failed} of ${checks.length} checks passed${exitCode ? '; the journey stopped early' : ''}.`);
process.exit(failed || exitCode ? 1 : 0);

