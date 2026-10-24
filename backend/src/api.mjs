import { createRouter, fail, readBody, readJson, sendJson, send, clientAddress } from './http.mjs';
import { clearSessionCookie, createSession, deleteAccount, loadSession, signIn, signOut, signUp } from './platform/auth.mjs';
import { addMember, changeMember, createWorkspace, deleteWorkspace, listMembers, listWorkspaces, removeMember, requireMember, updateWorkspace } from './platform/workspaces.mjs';
import { saveRouting, createForm, deleteForm, deleteResponse, exportCsv, getForm, listForms, listResponses, publishedForm, publishForm, saveDraft, submitResponse, unpublishForm } from './forms/service.mjs';
import { createFlow, deleteFlow, getFlow, listFlows, listRuns, listTasks, retryRun, simulateFlow, updateFlow, updateTask } from './flow/service.mjs';
import { entitlementsFor, usageFor } from './billing/entitlements.mjs';
import { PLANS, QUOTAS, GRACE_DAYS } from './billing/plans.mjs';
import { handleWebhook, testProviderEvent } from './billing/webhooks.mjs';
import { isAllowedOrigin, publicConfig, releaseWarnings } from './config.mjs';
import { registerMeetRoutes } from './api-meet.mjs';
import { disconnectIntegration, finishOAuth, PROVIDERS, startOAuth } from './platform/oauth.mjs';
import { finishSso, getSsoConfig, saveSsoConfig, ssoWorkspaceFor, startSso } from './platform/sso.mjs';
import { handleMcp } from './platform/mcp.mjs';
import { chat, createRecap, createTranscript, deleteTranscript, getTranscript, handleInboundEmail, listTranscripts, meetingPrep, publicRecap, shareRecap, unshareRecap } from './ai/service.mjs';
import { timingSafeEqual } from 'node:crypto';
import { audit, authenticateKey, createEndpoint, createKey, deleteEndpoint, listAudit, listEndpoints, listKeys, redeliver, revokeKey, updateEndpoint } from './platform/developer.mjs';

export function createApi(app) {
  const router = createRouter();
  const { get, post, patch, put, delete: del } = router;

  // Every private route resolves membership on the server; the workspace id in the URL is never trusted alone.
  const member = (ctx, permission) => {
    if (ctx.apiKey && ctx.params.ws !== ctx.apiKey.workspaceId) fail(404, 'not_found', 'Workspace not found.');
    const access = requireMember(app, ctx.user, ctx.params.ws, permission);
    return { ...access, userId: ctx.user.id };
  };
  const limit = (ctx, name, max, windowMs = 60000) => {
    const retry = app.rateLimit(`${name}:${ctx.ip}`, max, windowMs);
    if (retry) fail(429, 'rate_limited', 'Too many attempts. Please wait a moment and try again.', { retry_after: retry });
  };

  // ---- Health ----
  get('/api/health', () => {
    let database = 'ok';
    try { app.db.get('SELECT 1'); } catch { database = 'error'; }
    const pending = app.db.get("SELECT (SELECT COUNT(*) FROM outbox WHERE dispatched_at IS NULL) AS events, (SELECT COUNT(*) FROM emails WHERE status IN ('queued','sending')) AS emails, (SELECT COUNT(*) FROM flow_runs WHERE status IN ('queued','retrying')) AS runs");
    return { status: database === 'ok' ? 'ok' : 'degraded', database, worker: { last_tick_at: app.worker?.state.lastTickAt ?? null, error: app.worker?.state.lastError ?? null }, pending, release_warnings: releaseWarnings(app.config).length };
  }, { public: true });

  get('/api/config', () => publicConfig(app.config), { public: true });

  // ---- Auth ----
  post('/api/auth/signup', async ctx => {
    limit(ctx, 'signup', 10, 3600000);
    const userId = await signUp(app, await ctx.json());
    const session = createSession(app, userId);
    ctx.setCookie(session.cookie);
    return { status: 201, body: me(userId, session.csrf) };
  }, { public: true });

  post('/api/auth/login', async ctx => {
    limit(ctx, 'login', 10);
    const body = await ctx.json();
    const userId = await signIn(app, body);
    if (ctx.session) signOut(app, ctx.session);
    const session = createSession(app, userId);
    ctx.setCookie(session.cookie);
    return me(userId, session.csrf);
  }, { public: true });

  post('/api/auth/logout', ctx => { signOut(app, ctx.session); ctx.setCookie(clearSessionCookie(app.config)); return { status: 204 }; }, { public: true });

  function me(userId, csrf) {
    const user = app.db.get('SELECT id, name, email FROM users WHERE id = ?', userId);
    return { user, csrf_token: csrf, workspaces: listWorkspaces(app, userId) };
  }
  get('/api/me', ctx => ctx.user ? me(ctx.user.id, ctx.session.csrf) : { user: null, workspaces: [] }, { public: true });
  del('/api/me', async ctx => { await deleteAccount(app, ctx.user, await ctx.json()); ctx.setCookie(clearSessionCookie(app.config)); return { status: 204 }; });

  // ---- Workspaces ----
  post('/api/workspaces', async ctx => ({ status: 201, body: { id: createWorkspace(app, ctx.user, await ctx.json()), workspaces: listWorkspaces(app, ctx.user.id) } }));
  get('/api/workspaces/:ws', ctx => { const { workspace, role } = member(ctx, 'workspace.read'); return { ...workspace, role, entitlements: entitlementsFor(app, workspace.id) }; });
  patch('/api/workspaces/:ws', async ctx => {
    const actor = member(ctx, 'workspace.update');
    const body = await ctx.json(400 * 1024);
    updateWorkspace(app, actor.workspace.id, body);
    audit(app, actor.workspace.id, actor.userId, 'workspace.updated', Object.keys(body).join(','));
    return member(ctx).workspace;
  });
  del('/api/workspaces/:ws', async ctx => { const { workspace } = member(ctx, 'workspace.delete'); deleteWorkspace(app, workspace.id, await ctx.json(), workspace); return { status: 204 }; });
  get('/api/workspaces/:ws/members', ctx => listMembers(app, member(ctx, 'workspace.read').workspace.id));
  post('/api/workspaces/:ws/members', async ctx => { const actor = member(ctx, 'members.manage'); addMember(app, actor, actor.workspace.id, await ctx.json()); return { status: 201, body: listMembers(app, actor.workspace.id) }; });
  patch('/api/workspaces/:ws/members/:user', async ctx => { const actor = member(ctx, 'members.manage'); changeMember(app, actor, actor.workspace.id, ctx.params.user, await ctx.json()); return listMembers(app, actor.workspace.id); });
  del('/api/workspaces/:ws/members/:user', ctx => {
    const actor = member(ctx, ctx.params.user === ctx.user.id ? 'workspace.read' : 'members.manage');
    removeMember(app, actor, actor.workspace.id, ctx.params.user);
    return { status: 204 };
  });

  registerMeetRoutes(app, router, { member, limit });

  // ---- OAuth integrations (calendars, video) ----
  get('/api/workspaces/:ws/integrations/:provider/start', ctx => {
    const actor = member(ctx, 'meet.manage_own');
    if (ctx.apiKey) fail(403, 'forbidden', 'Connect integrations from the web app.');
    return startOAuth(app, actor.workspace.id, actor.userId, ctx.params.provider);
  });
  del('/api/workspaces/:ws/integrations/:provider', ctx => {
    const actor = member(ctx, 'meet.manage_own');
    if (!PROVIDERS[ctx.params.provider]) fail(404, 'not_found', 'Unknown integration.');
    disconnectIntegration(app, actor.workspace.id, actor.userId, ctx.params.provider);
    return { status: 204 };
  });
  get('/api/oauth/:provider/callback', async ctx => {
    if (!PROVIDERS[ctx.params.provider]) fail(404, 'not_found', 'Unknown integration.');
    try {
      const result = await finishOAuth(app, ctx.params.provider, ctx.query, ctx.user);
      return { redirect: `/meet?tab=calendar&${result.ok ? 'connected=' + ctx.params.provider : 'error=denied'}` };
    } catch (error) {
      return { redirect: `/meet?tab=calendar&error=${encodeURIComponent(error.message.slice(0, 120))}` };
    }
  }, { public: true });

  // ---- AI: transcripts, recaps, chat, meeting prep, Meet Assist ----
  get('/api/workspaces/:ws/transcripts', ctx => listTranscripts(app, member(ctx, 'meet.manage_own').workspace.id, ctx.query.get('q')));
  post('/api/workspaces/:ws/transcripts', async ctx => { const actor = member(ctx, 'meet.manage_own'); return { status: 201, body: createTranscript(app, actor.workspace.id, actor.userId, await ctx.json(600 * 1024)) }; });
  // For notetaker services (call-recording bots) that deliver transcripts with an API key.
  post('/api/workspaces/:ws/notetaker/transcripts', async ctx => {
    const actor = member(ctx, 'meet.manage_own');
    const transcript = createTranscript(app, actor.workspace.id, actor.userId, await ctx.json(600 * 1024), 'notetaker');
    let recap = null;
    if (app.anthropic) { try { recap = await createRecap(app, actor.workspace.id, transcript.id); } catch { recap = null; } }
    return { status: 201, body: { transcript_id: transcript.id, recap } };
  });
  get('/api/workspaces/:ws/transcripts/:id', ctx => getTranscript(app, member(ctx, 'meet.manage_own').workspace.id, ctx.params.id));
  get('/api/workspaces/:ws/transcripts/:id/download', ctx => {
    const transcript = getTranscript(app, member(ctx, 'meet.manage_own').workspace.id, ctx.params.id);
    return { raw: transcript.content, type: 'text/plain; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="transcript-${transcript.id.slice(0, 8)}.txt"` } };
  });
  del('/api/workspaces/:ws/transcripts/:id', ctx => { deleteTranscript(app, member(ctx, 'meet.manage_own').workspace.id, ctx.params.id); return { status: 204 }; });
  post('/api/workspaces/:ws/transcripts/:id/recap', async ctx => { const actor = member(ctx, 'meet.manage_own'); limit(ctx, 'ai', 20); return { status: 201, body: await createRecap(app, actor.workspace.id, ctx.params.id) }; });
  post('/api/workspaces/:ws/recaps/:id/share', async ctx => shareRecap(app, member(ctx, 'meet.manage_own').workspace.id, ctx.params.id, await ctx.json()));
  del('/api/workspaces/:ws/recaps/:id/share', ctx => { unshareRecap(app, member(ctx, 'meet.manage_own').workspace.id, ctx.params.id); return { status: 204 }; });
  get('/api/public/recaps/:token', async ctx => { limit(ctx, 'login', 20); return publicRecap(app, ctx.params.token, ctx.request.headers['x-recap-passcode']); }, { public: true });
  post('/api/workspaces/:ws/ai/chat', async ctx => { const actor = member(ctx, 'meet.manage_own'); limit(ctx, 'ai', 30); return chat(app, actor, await ctx.json(256 * 1024)); });
  get('/api/workspaces/:ws/bookings/:id/prep', async ctx => {
    const actor = member(ctx, 'meet.manage_own');
    const booking = app.db.get('SELECT meeting_id FROM bookings WHERE id = ? AND workspace_id = ?', ctx.params.id, actor.workspace.id);
    const isHost = booking && app.db.get('SELECT 1 FROM meeting_hosts WHERE meeting_id = ? AND host_id = ?', booking.meeting_id, actor.userId);
    if (!booking || (!isHost && !['owner', 'admin'].includes(actor.role))) fail(404, 'not_found', 'Appointment not found.');
    if (ctx.query.get('ai') === '1') limit(ctx, 'ai', 20);
    return meetingPrep(app, actor.workspace.id, ctx.params.id, ctx.query.get('ai') === '1');
  });
  // Inbound email webhook (from the email provider's inbound parsing), authenticated by a shared secret.
  post('/api/assist/inbound', async ctx => {
    const secret = String(ctx.request.headers['x-inbound-secret'] || '');
    const expected = app.config.inboundEmailSecret;
    if (!expected || secret.length !== expected.length || !timingSafeEqual(Buffer.from(secret), Buffer.from(expected))) fail(401, 'unauthorized', 'Invalid inbound secret.');
    return handleInboundEmail(app, await ctx.json(256 * 1024));
  }, { public: true, csrfExempt: true });

  // ---- Single sign-on (OpenID Connect) ----
  get('/api/workspaces/:ws/sso', ctx => getSsoConfig(app, member(ctx, 'workspace.delete').workspace.id));
  put('/api/workspaces/:ws/sso', async ctx => {
    const actor = member(ctx, 'workspace.delete');
    const result = saveSsoConfig(app, actor.workspace.id, await ctx.json());
    audit(app, actor.workspace.id, actor.userId, 'sso.updated', result.issuer);
    return result;
  });
  get('/api/auth/sso/lookup', ctx => {
    limit(ctx, 'login', 30);
    const found = ssoWorkspaceFor(app, { email: ctx.query.get('email'), workspace: ctx.query.get('workspace') });
    return { sso: Boolean(found), workspace: found?.slug ?? null };
  }, { public: true });
  get('/api/auth/sso/start', async ctx => {
    limit(ctx, 'login', 20);
    const found = ssoWorkspaceFor(app, { email: ctx.query.get('email'), workspace: ctx.query.get('workspace') });
    if (!found) return { redirect: '/account?error=' + encodeURIComponent('Single sign-on is not set up for that workspace or email domain.') };
    const { url, cookie } = await startSso(app, found.id);
    ctx.setCookie(cookie);
    return { redirect: url };
  }, { public: true });
  get('/api/auth/sso/callback', async ctx => {
    try {
      const { cookies } = await finishSso(app, ctx.request, ctx.query);
      cookies.forEach(ctx.setCookie);
      return { redirect: '/meet' };
    } catch (error) {
      return { redirect: '/account?error=' + encodeURIComponent(error.message.slice(0, 160)) };
    }
  }, { public: true });

  // ---- MCP server for AI tools (API key required) ----
  post('/api/mcp', async ctx => {
    if (!ctx.apiKey) fail(401, 'api_key_required', 'Use a workspace API key: Authorization: Bearer sch_...');
    const result = handleMcp(app, ctx, await ctx.json(256 * 1024).catch(() => ({})));
    return result === null || (Array.isArray(result) && !result.length) ? { status: 202 } : result;
  }, { public: true });
  get('/api/mcp', () => fail(405, 'method_not_allowed', 'This MCP server uses POST (stateless Streamable HTTP).'), { public: true });
  get('/api/key', ctx => {
    if (!ctx.apiKey) fail(401, 'api_key_required', 'Use a workspace API key.');
    const workspace = app.db.get('SELECT id, name, slug FROM workspaces WHERE id = ?', ctx.apiKey.workspaceId);
    return { user: ctx.user, workspace };
  }, { public: true });

  // ---- Developer platform: webhooks, API keys, audit log ----
  get('/api/workspaces/:ws/webhooks', ctx => listEndpoints(app, member(ctx, 'developer.manage').workspace.id));
  post('/api/workspaces/:ws/webhooks', async ctx => { const actor = member(ctx, 'developer.manage'); const result = createEndpoint(app, actor.workspace.id, await ctx.json()); audit(app, actor.workspace.id, actor.userId, 'webhook.created', result.url); return { status: 201, body: result }; });
  patch('/api/workspaces/:ws/webhooks/:id', async ctx => updateEndpoint(app, member(ctx, 'developer.manage').workspace.id, ctx.params.id, await ctx.json()));
  del('/api/workspaces/:ws/webhooks/:id', ctx => { const actor = member(ctx, 'developer.manage'); deleteEndpoint(app, actor.workspace.id, ctx.params.id); audit(app, actor.workspace.id, actor.userId, 'webhook.deleted', ctx.params.id); return { status: 204 }; });
  post('/api/workspaces/:ws/webhooks/deliveries/:id/redeliver', ctx => { redeliver(app, member(ctx, 'developer.manage').workspace.id, ctx.params.id); return { status: 204 }; });
  get('/api/workspaces/:ws/api-keys', ctx => { const actor = member(ctx, 'workspace.read'); return listKeys(app, actor.workspace.id, actor.userId); });
  post('/api/workspaces/:ws/api-keys', async ctx => {
    if (ctx.apiKey) fail(403, 'forbidden', 'API keys cannot create other API keys.');
    const actor = member(ctx, 'workspace.read');
    const result = createKey(app, actor.workspace.id, actor.userId, await ctx.json());
    audit(app, actor.workspace.id, actor.userId, 'api_key.created', result.id);
    return { status: 201, body: result };
  });
  del('/api/workspaces/:ws/api-keys/:id', ctx => { const actor = member(ctx, 'workspace.read'); revokeKey(app, actor.workspace.id, actor.userId, ctx.params.id); audit(app, actor.workspace.id, actor.userId, 'api_key.revoked', ctx.params.id); return { status: 204 }; });
  get('/api/workspaces/:ws/audit', ctx => listAudit(app, member(ctx, 'audit.read').workspace.id));

  // ---- Forms ----
  get('/api/workspaces/:ws/forms', ctx => listForms(app, member(ctx, 'forms.manage').workspace.id));
  post('/api/workspaces/:ws/forms', async ctx => { const actor = member(ctx, 'forms.manage'); return { status: 201, body: createForm(app, actor.workspace.id, ctx.user.id, await ctx.json()) }; });
  get('/api/workspaces/:ws/forms/:id', ctx => getForm(app, member(ctx, 'forms.manage').workspace.id, ctx.params.id));
  patch('/api/workspaces/:ws/forms/:id', async ctx => saveDraft(app, member(ctx, 'forms.manage').workspace.id, ctx.params.id, await ctx.json()));
  del('/api/workspaces/:ws/forms/:id', ctx => { deleteForm(app, member(ctx, 'forms.manage').workspace.id, ctx.params.id); return { status: 204 }; });
  put('/api/workspaces/:ws/forms/:id/routing', async ctx => saveRouting(app, member(ctx, 'forms.manage').workspace.id, ctx.params.id, await ctx.json()));
  post('/api/workspaces/:ws/forms/:id/publish', ctx => publishForm(app, member(ctx, 'forms.manage').workspace.id, ctx.user.id, ctx.params.id));
  post('/api/workspaces/:ws/forms/:id/unpublish', ctx => unpublishForm(app, member(ctx, 'forms.manage').workspace.id, ctx.params.id));
  get('/api/workspaces/:ws/forms/:id/responses', ctx => {
    const { workspace } = member(ctx, 'responses.read');
    const form = getForm(app, workspace.id, ctx.params.id);
    const versions = Object.fromEntries(app.db.all('SELECT version, definition FROM form_versions WHERE form_id = ?', form.id).map(row => [row.version, JSON.parse(row.definition)]));
    return { form, versions, responses: listResponses(app, workspace.id, form.id, { before: ctx.query.get('before'), limit: ctx.query.get('limit') }) };
  });
  get('/api/workspaces/:ws/forms/:id/responses.csv', ctx => {
    const { workspace } = member(ctx, 'responses.read');
    const { filename, body } = exportCsv(app, workspace.id, ctx.params.id);
    return { raw: body, type: 'text/csv; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="${filename.replace(/[^a-z0-9.-]/gi, '_')}"`, 'Cache-Control': 'no-store' } };
  });
  del('/api/workspaces/:ws/forms/:id/responses/:rid', ctx => { deleteResponse(app, member(ctx, 'responses.delete').workspace.id, ctx.params.id, ctx.params.rid); return { status: 204 }; });

  get('/api/public/forms/:slug', ctx => {
    const form = publishedForm(app, ctx.params.slug);
    return { slug: form.slug, version: form.published_version, definition: form.definition, workspace_name: form.workspace_name, accepting: entitlementsFor(app, form.workspace_id).forms.active };
  }, { public: true });
  post('/api/public/forms/:slug/responses', async ctx => {
    limit(ctx, 'responses', 30);
    const result = submitResponse(app, ctx.params.slug, await ctx.json(256 * 1024));
    return { status: result.replay ? 200 : 201, body: result };
  }, { public: true });

  // ---- Flow ----
  get('/api/workspaces/:ws/flows', ctx => listFlows(app, member(ctx, 'flows.read').workspace.id));
  post('/api/workspaces/:ws/flows', async ctx => ({ status: 201, body: createFlow(app, member(ctx, 'flows.manage').workspace.id, await ctx.json()) }));
  get('/api/workspaces/:ws/flows/:id', ctx => getFlow(app, member(ctx, 'flows.read').workspace.id, ctx.params.id));
  patch('/api/workspaces/:ws/flows/:id', async ctx => updateFlow(app, member(ctx, 'flows.manage').workspace.id, ctx.params.id, await ctx.json()));
  del('/api/workspaces/:ws/flows/:id', ctx => { deleteFlow(app, member(ctx, 'flows.manage').workspace.id, ctx.params.id); return { status: 204 }; });
  post('/api/workspaces/:ws/flows/:id/simulate', ctx => simulateFlow(app, member(ctx, 'flows.read').workspace.id, ctx.params.id));
  get('/api/workspaces/:ws/runs', ctx => listRuns(app, member(ctx, 'flows.read').workspace.id, { flowId: ctx.query.get('flow') || null, status: ctx.query.get('status') || null }));
  post('/api/workspaces/:ws/runs/:id/retry', ctx => { retryRun(app, member(ctx, 'flows.manage').workspace.id, ctx.params.id); return { status: 204 }; });
  get('/api/workspaces/:ws/tasks', ctx => listTasks(app, member(ctx, 'tasks.manage').workspace.id, ctx.query.get('status') || null));
  patch('/api/workspaces/:ws/tasks/:id', async ctx => { updateTask(app, member(ctx, 'tasks.manage').workspace.id, ctx.params.id, await ctx.json()); return { status: 204 }; });

  // ---- Billing ----
  get('/api/workspaces/:ws/billing', ctx => {
    const { workspace, role } = member(ctx, 'billing.read');
    return {
      mode: app.config.billingMode, provider: app.config.billingProvider, role, grace_days: GRACE_DAYS,
      plans: Object.entries(PLANS).map(([id, plan]) => ({ id, ...plan, price: null })),
      quotas: QUOTAS,
      entitlements: entitlementsFor(app, workspace.id),
      usage: usageFor(app, workspace.id),
      subscriptions: app.db.all('SELECT id, plan, status, current_period_end, cancel_at_period_end, grace_until, created_at FROM subscriptions WHERE workspace_id = ? ORDER BY created_at DESC', workspace.id)
    };
  });
  // Test provider only: simulates checkout and lifecycle events through the signed webhook path.
  post('/api/workspaces/:ws/billing/test-events', async ctx => {
    const { workspace } = member(ctx, 'billing.manage');
    const body = await ctx.json();
    const period = Math.floor(app.now() / 1000) + 30 * 86400;
    const subscriptionId = typeof body.subscription === 'string' ? body.subscription : null;
    const existing = subscriptionId && app.db.get('SELECT external_id, plan FROM subscriptions WHERE id = ? AND workspace_id = ?', subscriptionId, workspace.id);
    if (subscriptionId && !existing) fail(404, 'not_found', 'Subscription not found.');
    const actions = {
      checkout: () => { if (!PLANS[body.plan]) fail(400, 'validation_failed', 'Choose a plan.', { field: 'plan' }); return ['subscription.updated', { id: 'sub_test_' + crypto.randomUUID(), plan: body.plan, status: 'active', current_period_end: period, cancel_at_period_end: false }]; },
      renew: () => ['invoice.paid', { id: existing.external_id, current_period_end: period }],
      payment_failed: () => ['invoice.payment_failed', { id: existing.external_id }],
      cancel: () => ['subscription.updated', { id: existing.external_id, cancel_at_period_end: true }],
      end: () => ['subscription.deleted', { id: existing.external_id }]
    };
    if (!actions[body.action] || (body.action !== 'checkout' && !existing)) fail(400, 'validation_failed', 'Unknown billing action.');
    const [type, subscription] = actions[body.action]();
    return { result: testProviderEvent(app, workspace.id, type, subscription) };
  });
  post('/api/billing/webhook', async ctx => {
    const raw = (await readBody(ctx.request, 65536)).toString('utf8');
    return { result: handleWebhook(app, raw, ctx.request.headers['schedora-signature']) };
  }, { public: true, csrfExempt: true });

  // ---- Analytics (optional, consent-gated, in-memory counters only) ----
  post('/api/analytics', ctx => {
    if (!app.config.analytics) fail(503, 'disabled', 'Analytics disabled');
    if (ctx.request.headers['x-analytics-consent'] !== 'accepted') fail(403, 'consent_required', 'Consent required');
    const page = String(ctx.request.headers['x-page-path'] || '').split('/').slice(0, 2).join('/') || '/';
    app.analytics.set(page, (app.analytics.get(page) || 0) + 1);
    return { status: 204 };
  }, { public: true });

  return async function handleApi(request, response, path, url) {
    const started = Date.now();
    const found = router.match(request.method, path);
    const ctx = { request, response, params: found?.params || {}, query: url.searchParams, ip: clientAddress(request, app.config.trustProxy, app.config.trustProxyHops), cookies: [] };
    ctx.setCookie = cookie => ctx.cookies.push(cookie);
    ctx.json = limitBytes => readJson(request, limitBytes);
    ctx.raw = limitBytes => readBody(request, limitBytes);
    let status = 500;
    try {
      if (!found) fail(404, 'not_found', 'Not found.');
      if (found.methodNotAllowed) fail(405, 'method_not_allowed', 'Method not allowed.');
      const { route } = found;
      // API keys (Authorization: Bearer sch_...) act as their user within one workspace, without cookies.
      const key = authenticateKey(app, request.headers.authorization);
      if (key?.invalid) fail(401, 'invalid_api_key', 'The API key is invalid or revoked.');
      if (key) {
        ctx.apiKey = key;
        ctx.user = key.user;
        const retry = app.rateLimit('apikey:' + key.workspaceId, 600, 60000);
        if (retry) fail(429, 'rate_limited', 'API rate limit reached.', { retry_after: retry });
      } else {
        ctx.session = loadSession(app, request);
        ctx.user = ctx.session?.user || null;
      }
      const mutating = !['GET', 'HEAD'].includes(request.method);
      if (mutating && !route.options.csrfExempt && !ctx.apiKey) {
        const origin = request.headers.origin;
        if (origin && !isAllowedOrigin(app.config, origin) && origin !== `${app.config.production ? 'https' : 'http'}://${request.headers.host}`) fail(403, 'bad_origin', 'Cross-site request blocked.');
        if (ctx.session && !route.options.public && request.headers['x-csrf-token'] !== ctx.session.csrf) fail(403, 'csrf', 'Your session expired. Reload the page and try again.');
      }
      if (!route.options.public && !ctx.user) fail(401, 'unauthenticated', 'Sign in to continue.');
      const result = await route.handler(ctx);
      for (const cookie of ctx.cookies) response.appendHeader('Set-Cookie', cookie);
      if (result && result.redirect) {
        status = 302;
        response.writeHead(302, { Location: result.redirect, 'Cache-Control': 'no-store' });
        return response.end();
      }
      if (result && result.raw !== undefined) {
        status = 200;
        return send(request, response, 200, result.type, result.raw, { 'Cache-Control': 'no-store', ...result.headers });
      }
      const wrapped = result && typeof result === 'object' && 'status' in result && Object.keys(result).every(key => key === 'status' || key === 'body');
      status = wrapped ? result.status : 200;
      sendJson(request, response, status, wrapped ? result.body ?? null : result);
    } catch (error) {
      status = error.status || 500;
      if (status === 500) app.log('error', 'request_failed', { path: found ? path.replace(/[^/]{20,}/g, ':id') : 'unmatched', error: error.message, stack: error.stack?.split('\n').slice(0, 3).join(' | ') });
      for (const cookie of ctx.cookies) response.appendHeader('Set-Cookie', cookie);
      const headers = error.details?.retry_after ? { 'Retry-After': String(error.details.retry_after) } : {};
      sendJson(request, response, status, { error: { code: error.code || 'server_error', message: status === 500 ? 'Something went wrong on our side. Please try again.' : error.message, ...(error.details || {}) } }, headers);
    } finally {
      app.log('info', 'api', { method: request.method, route: found?.route ? found.route.regex.source.replace(/\(\[\^\/\]\+\)/g, ':p').replace(/\\|\^|\$/g, '') : 'unmatched', status, ms: Date.now() - started });
    }
  };
}
