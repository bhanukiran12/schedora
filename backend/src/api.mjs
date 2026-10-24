import { createRouter, fail, readBody, readJson, sendJson, send, clientAddress } from './http.mjs';
import { clearSessionCookie, createSession, deleteAccount, loadSession, signIn, signOut, signUp } from './platform/auth.mjs';
import { addMember, changeMember, createWorkspace, deleteWorkspace, listMembers, listWorkspaces, removeMember, requireMember, updateWorkspace } from './platform/workspaces.mjs';
import { createEventType, deleteEventType, findPublishedEventType, getEventType, listEventTypes, updateEventType } from './meet/event-types.mjs';
import { availableSlots, bookingByToken, cancelByToken, createBooking, hostCancel, listBookings, publicBooking, rescheduleByToken } from './meet/bookings.mjs';
import { bookingIcs } from './meet/ics.mjs';
import { connectCalendar, disconnectCalendar, getConnection, syncConnection } from './meet/calendar.mjs';
import { createForm, deleteForm, deleteResponse, exportCsv, getForm, listForms, listResponses, publishedForm, publishForm, saveDraft, submitResponse, unpublishForm } from './forms/service.mjs';
import { createFlow, deleteFlow, getFlow, listFlows, listRuns, listTasks, retryRun, simulateFlow, updateFlow, updateTask } from './flow/service.mjs';
import { entitlementsFor, usageFor } from './billing/entitlements.mjs';
import { PLANS, QUOTAS, GRACE_DAYS } from './billing/plans.mjs';
import { handleWebhook, testProviderEvent } from './billing/webhooks.mjs';
import { addDays, isValidDate, localDate } from './time.mjs';
import { isAllowedOrigin, publicConfig, releaseWarnings } from './config.mjs';

export function createApi(app) {
  const router = createRouter();
  const { get, post, patch, delete: del } = router;

  // Every private route resolves membership on the server; the workspace id in the URL is never trusted alone.
  const member = (ctx, permission) => {
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
  patch('/api/workspaces/:ws', async ctx => { const { workspace } = member(ctx, 'workspace.update'); updateWorkspace(app, workspace.id, await ctx.json()); return member(ctx).workspace; });
  del('/api/workspaces/:ws', async ctx => { const { workspace } = member(ctx, 'workspace.delete'); deleteWorkspace(app, workspace.id, await ctx.json(), workspace); return { status: 204 }; });
  get('/api/workspaces/:ws/members', ctx => listMembers(app, member(ctx, 'workspace.read').workspace.id));
  post('/api/workspaces/:ws/members', async ctx => { const actor = member(ctx, 'members.manage'); addMember(app, actor, actor.workspace.id, await ctx.json()); return { status: 201, body: listMembers(app, actor.workspace.id) }; });
  patch('/api/workspaces/:ws/members/:user', async ctx => { const actor = member(ctx, 'members.manage'); changeMember(app, actor, actor.workspace.id, ctx.params.user, await ctx.json()); return listMembers(app, actor.workspace.id); });
  del('/api/workspaces/:ws/members/:user', ctx => {
    const actor = member(ctx, ctx.params.user === ctx.user.id ? 'workspace.read' : 'members.manage');
    removeMember(app, actor, actor.workspace.id, ctx.params.user);
    return { status: 204 };
  });

  // ---- Meet (host) ----
  get('/api/workspaces/:ws/event-types', ctx => { const actor = member(ctx, 'meet.manage_own'); return listEventTypes(app, actor.workspace.id, actor); });
  post('/api/workspaces/:ws/event-types', async ctx => { const actor = member(ctx, 'meet.manage_own'); return { status: 201, body: createEventType(app, actor.workspace.id, actor, await ctx.json()) }; });
  get('/api/workspaces/:ws/event-types/:id', ctx => { const actor = member(ctx, 'meet.manage_own'); return getEventType(app, actor.workspace.id, ctx.params.id, actor); });
  patch('/api/workspaces/:ws/event-types/:id', async ctx => { const actor = member(ctx, 'meet.manage_own'); return updateEventType(app, actor.workspace.id, actor, ctx.params.id, await ctx.json()); });
  del('/api/workspaces/:ws/event-types/:id', ctx => { const actor = member(ctx, 'meet.manage_own'); deleteEventType(app, actor.workspace.id, actor, ctx.params.id); return { status: 204 }; });
  get('/api/workspaces/:ws/bookings', ctx => { const actor = member(ctx, 'meet.manage_own'); return listBookings(app, actor.workspace.id, actor, ctx.query.get('scope') || 'upcoming'); });
  post('/api/workspaces/:ws/bookings/:id/cancel', async ctx => { const actor = member(ctx, 'meet.manage_own'); hostCancel(app, actor.workspace.id, actor, ctx.params.id, await ctx.json()); return { status: 204 }; });
  get('/api/workspaces/:ws/calendar', ctx => { const actor = member(ctx, 'meet.manage_own'); return { connection: getConnection(app, actor.workspace.id, ctx.user.id) }; });
  post('/api/workspaces/:ws/calendar', async ctx => { const actor = member(ctx, 'meet.manage_own'); limit(ctx, 'calendar', 10); return { connection: await connectCalendar(app, actor.workspace.id, ctx.user.id, await ctx.json()) }; });
  post('/api/workspaces/:ws/calendar/sync', async ctx => {
    const actor = member(ctx, 'meet.manage_own');
    limit(ctx, 'calendar', 10);
    const connection = getConnection(app, actor.workspace.id, ctx.user.id);
    if (!connection) fail(404, 'not_found', 'No calendar is connected.');
    await syncConnection(app, connection.id);
    return { connection: getConnection(app, actor.workspace.id, ctx.user.id) };
  });
  del('/api/workspaces/:ws/calendar', ctx => { const actor = member(ctx, 'meet.manage_own'); disconnectCalendar(app, actor.workspace.id, ctx.user.id); return { status: 204 }; });
  get('/api/workspaces/:ws/emails', ctx => {
    const actor = member(ctx, 'emails.read');
    return app.db.all(`SELECT id, kind, to_address, subject, status, attempts, last_error, created_at, sent_at, next_attempt_at FROM emails WHERE workspace_id = ?
      ORDER BY created_at DESC LIMIT 100`, actor.workspace.id);
  });

  // ---- Meet (public) ----
  const publicEvent = ctx => {
    const eventType = findPublishedEventType(app, ctx.params.wsSlug, ctx.params.slug);
    if (!eventType) fail(404, 'not_found', 'This booking page is not available.');
    return eventType;
  };
  const eventSummary = eventType => ({
    title: eventType.title, description: eventType.description, location: eventType.location, duration_min: eventType.duration_min,
    timezone: eventType.timezone, host_name: eventType.host_name, workspace_name: eventType.workspace_name, workspace_slug: eventType.workspace_slug, slug: eventType.slug
  });
  const slotsResponse = (eventType, ctx) => {
    const from = ctx.query.get('from');
    const days = Math.min(62, Number(ctx.query.get('days')) || 62);
    const fromDate = isValidDate(from) ? addDays(from, -1) : undefined;
    const toDate = fromDate ? addDays(from, days + 1) : undefined;
    const available = entitlementsFor(app, eventType.workspace_id).meet.active;
    return { timezone: eventType.timezone, slots: available ? availableSlots(app, eventType, { fromDate, toDate }).map(ms => new Date(ms).toISOString()) : [], accepting: available, today: localDate(app.now(), eventType.timezone) };
  };
  get('/api/public/meet/:wsSlug/:slug', ctx => eventSummary(publicEvent(ctx)), { public: true });
  get('/api/public/meet/:wsSlug/:slug/slots', ctx => { limit(ctx, 'slots', 120); return slotsResponse(publicEvent(ctx), ctx); }, { public: true });
  post('/api/public/meet/:wsSlug/:slug/bookings', async ctx => {
    limit(ctx, 'booking', 20);
    const eventType = publicEvent(ctx);
    const body = await ctx.json();
    if (body.website) fail(400, 'rejected', 'Submission rejected.');
    try {
      const { booking, token, replay } = createBooking(app, eventType, body, ctx.request.headers['idempotency-key']);
      return { status: replay ? 200 : 201, body: { booking: publicBooking(app, booking, eventType), manage_token: token, replay } };
    } catch (error) {
      // A lost race returns fresh options so the invitee can pick again without reloading.
      if (error.code === 'slot_unavailable') error.details = { ...error.details, ...slotsResponse(eventType, ctx) };
      throw error;
    }
  }, { public: true });

  get('/api/public/bookings/:token', ctx => {
    limit(ctx, 'manage', 60);
    const { booking, eventType, expired } = bookingByToken(app, ctx.params.token);
    return { booking: publicBooking(app, booking, eventType), expired, can_change: !expired && booking.status === 'confirmed' && Boolean(eventType.published) };
  }, { public: true });
  get('/api/public/bookings/:token/slots', ctx => {
    limit(ctx, 'slots', 120);
    const { eventType } = bookingByToken(app, ctx.params.token);
    return slotsResponse(eventType, ctx);
  }, { public: true });
  get('/api/public/bookings/:token/ics', ctx => {
    limit(ctx, 'manage', 60);
    const { booking, eventType } = bookingByToken(app, ctx.params.token);
    const ics = bookingIcs({ booking, eventType, hostName: eventType.host_name, method: booking.status === 'canceled' ? 'CANCEL' : 'PUBLISH', now: app.now() });
    return { raw: ics, type: 'text/calendar; charset=utf-8', headers: { 'Content-Disposition': `attachment; filename="${booking.reference}.ics"` } };
  }, { public: true });
  post('/api/public/bookings/:token/cancel', async ctx => { limit(ctx, 'manage', 20); return { booking: cancelByToken(app, ctx.params.token, await ctx.json()) }; }, { public: true });
  post('/api/public/bookings/:token/reschedule', async ctx => {
    limit(ctx, 'manage', 20);
    const body = await ctx.json();
    try {
      const { booking, token } = rescheduleByToken(app, ctx.params.token, body);
      return { booking, manage_token: token };
    } catch (error) {
      if (error.code === 'slot_unavailable') error.details = { ...error.details, ...slotsResponse(bookingByToken(app, ctx.params.token).eventType, ctx) };
      throw error;
    }
  }, { public: true });

  // ---- Forms ----
  get('/api/workspaces/:ws/forms', ctx => listForms(app, member(ctx, 'forms.manage').workspace.id));
  post('/api/workspaces/:ws/forms', async ctx => { const actor = member(ctx, 'forms.manage'); return { status: 201, body: createForm(app, actor.workspace.id, ctx.user.id, await ctx.json()) }; });
  get('/api/workspaces/:ws/forms/:id', ctx => getForm(app, member(ctx, 'forms.manage').workspace.id, ctx.params.id));
  patch('/api/workspaces/:ws/forms/:id', async ctx => saveDraft(app, member(ctx, 'forms.manage').workspace.id, ctx.params.id, await ctx.json()));
  del('/api/workspaces/:ws/forms/:id', ctx => { deleteForm(app, member(ctx, 'forms.manage').workspace.id, ctx.params.id); return { status: 204 }; });
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
    let status = 500;
    try {
      if (!found) fail(404, 'not_found', 'Not found.');
      if (found.methodNotAllowed) fail(405, 'method_not_allowed', 'Method not allowed.');
      const { route } = found;
      ctx.session = loadSession(app, request);
      ctx.user = ctx.session?.user || null;
      const mutating = !['GET', 'HEAD'].includes(request.method);
      if (mutating && !route.options.csrfExempt) {
        const origin = request.headers.origin;
        if (origin && !isAllowedOrigin(app.config, origin) && origin !== `${app.config.production ? 'https' : 'http'}://${request.headers.host}`) fail(403, 'bad_origin', 'Cross-site request blocked.');
        if (ctx.session && !route.options.public && request.headers['x-csrf-token'] !== ctx.session.csrf) fail(403, 'csrf', 'Your session expired. Reload the page and try again.');
      }
      if (!route.options.public && !ctx.user) fail(401, 'unauthenticated', 'Sign in to continue.');
      const result = await route.handler(ctx);
      for (const cookie of ctx.cookies) response.appendHeader('Set-Cookie', cookie);
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
