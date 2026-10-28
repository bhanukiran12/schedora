import { fail } from './http.mjs';
import { addDays, isValidDate, isValidTimeZone, localDate } from './time.mjs';
import { invalid } from './validate.mjs';
import { can } from './platform/workspaces.mjs';
import { entitlementsFor } from './billing/entitlements.mjs';
import { assignTemplate, createEventType, deleteEventType, findEventTypeBySlug, getEventType, listEventTypes, locationDisplay, normalizeOverrides, normalizeRules, publicWorkspacePage, updateEventType, AUTO_VIDEO, LOCATION_TYPES } from './meet/event-types.mjs';
import { bookingByToken, cancelByToken, computeAvailability, createBooking, hostBook, hostCancel, listBookings, loadEventType, publicBooking, rescheduleByToken } from './meet/bookings.mjs';
import { bookingIcs } from './meet/ics.mjs';
import { connectCalendar, disconnectCalendar, listConnections, syncConnection } from './meet/calendar.mjs';
import { createWorkflow, deleteWorkflow, listWorkflows, updateWorkflow, TRIGGERS, PLACEHOLDERS } from './meet/workflows.mjs';
import { closePoll, confirmPoll, createPoll, deletePoll, getPoll, listPolls, publicPoll, vote } from './meet/polls.mjs';
import { analytics } from './meet/analytics.mjs';
import { connectStripe } from './meet/payments.mjs';
import { connectRazorpay } from './meet/razorpay.mjs';
import { addFollowUp, addNote, createContact, deleteContact, deleteNote, getContact, listContacts, updateContact } from './platform/contacts.mjs';
import { queueEmail, deliverEmail } from './platform/email.mjs';

// Meet routes: host management (workspace members) and public booking (invitees).
export function registerMeetRoutes(app, router, { member, limit }) {
  const { get, post, patch, put, delete: del } = router;
  const ws = path => `/api/workspaces/:ws${path}`;

  // ---- Event types ----
  get(ws('/event-types'), ctx => { const actor = member(ctx, 'meet.manage_own'); return listEventTypes(app, actor.workspace.id, actor); });
  post(ws('/event-types'), async ctx => { const actor = member(ctx, 'meet.manage_own'); return { status: 201, body: createEventType(app, actor.workspace.id, actor, await ctx.json(128 * 1024)) }; });
  get(ws('/event-types/:id'), ctx => { const actor = member(ctx, 'meet.manage_own'); return getEventType(app, actor.workspace.id, ctx.params.id, actor); });
  patch(ws('/event-types/:id'), async ctx => { const actor = member(ctx, 'meet.manage_own'); return updateEventType(app, actor.workspace.id, actor, ctx.params.id, await ctx.json(128 * 1024)); });
  del(ws('/event-types/:id'), ctx => { const actor = member(ctx, 'meet.manage_own'); deleteEventType(app, actor.workspace.id, actor, ctx.params.id); return { status: 204 }; });
  post(ws('/event-types/:id/assign'), async ctx => { const actor = member(ctx, 'meet.manage_all'); return assignTemplate(app, actor.workspace.id, actor, ctx.params.id, await ctx.json()); });
  // Host view of free times (also for unpublished types and booking on behalf).
  get(ws('/event-types/:id/slots'), ctx => {
    const actor = member(ctx, 'meet.manage_own');
    getEventType(app, actor.workspace.id, ctx.params.id, actor);
    return slotsResponse(loadEventType(app, ctx.params.id), ctx, true);
  });
  get(ws('/meet/options'), ctx => { member(ctx, 'meet.manage_own'); return { location_types: LOCATION_TYPES, workflow_triggers: TRIGGERS, placeholders: PLACEHOLDERS }; });

  // ---- Personal working hours (used by team event types) ----
  get(ws('/schedule'), ctx => {
    const actor = member(ctx, 'meet.manage_own');
    const row = app.db.get('SELECT timezone, rules, overrides FROM user_schedules WHERE workspace_id = ? AND user_id = ?', actor.workspace.id, actor.userId);
    return row ? { timezone: row.timezone, rules: JSON.parse(row.rules), overrides: JSON.parse(row.overrides) } : null;
  });
  put(ws('/schedule'), async ctx => {
    const actor = member(ctx, 'meet.manage_own');
    const body = await ctx.json();
    if (!isValidTimeZone(body.timezone)) invalid('timezone', 'Choose a valid time zone.');
    const rules = normalizeRules(body.rules ?? []);
    const overrides = normalizeOverrides(body.overrides ?? []).map(o => o.start_min == null ? { date: o.date, unavailable: true } : o);
    app.db.run(`INSERT INTO user_schedules (workspace_id, user_id, timezone, rules, overrides, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (workspace_id, user_id) DO UPDATE SET timezone = excluded.timezone, rules = excluded.rules, overrides = excluded.overrides, updated_at = excluded.updated_at`,
    actor.workspace.id, actor.userId, body.timezone, JSON.stringify(rules), JSON.stringify(overrides), app.now());
    return { timezone: body.timezone, rules, overrides };
  });

  // ---- Bookings ----
  get(ws('/bookings'), ctx => {
    const actor = member(ctx, 'meet.manage_own');
    return listBookings(app, actor.workspace.id, actor, ctx.query.get('scope') || 'upcoming', { eventTypeId: ctx.query.get('event_type'), hostId: ctx.query.get('host'), contactId: ctx.query.get('contact') });
  });
  post(ws('/bookings'), async ctx => {
    const actor = member(ctx, 'meet.manage_own');
    const { booking, token, replay } = hostBook(app, actor.workspace.id, actor, await ctx.json(), ctx.request.headers['idempotency-key']);
    const eventType = loadEventType(app, booking.event_type_id);
    return { status: replay ? 200 : 201, body: { booking: publicBooking(app, booking, eventType), manage_url: token ? `${app.config.baseUrl}/meet/manage/${token}` : null } };
  });
  post(ws('/bookings/:id/cancel'), async ctx => { const actor = member(ctx, 'meet.manage_own'); hostCancel(app, actor.workspace.id, actor, ctx.params.id, await ctx.json()); return { status: 204 }; });

  get(ws('/emails'), ctx => {
    const actor = member(ctx, 'emails.read');
    return app.db.all(`SELECT id, kind, channel, to_address, subject, status, attempts, last_error, created_at, sent_at, next_attempt_at, accepted_transport, delivery_status, delivery_event_at FROM emails WHERE workspace_id = ?
      ORDER BY created_at DESC LIMIT 100`, actor.workspace.id);
  });
  post(ws('/emails/test'), async ctx => {
    const actor = member(ctx, 'emails.read');
    if (!['owner', 'admin'].includes(actor.role)) fail(403, 'forbidden', 'Only workspace administrators can send delivery checks.');
    if (ctx.apiKey) fail(403, 'forbidden', 'Send delivery checks from the web app.');
    const body = await ctx.json();
    if (!['account', 'google'].includes(body.target)) fail(400, 'validation_failed', 'Choose your account or connected Google inbox.');
    // Never accept a caller-supplied address: tests can only reach the current user's inboxes.
    const to = body.target === 'google'
      ? app.db.get("SELECT account FROM integrations WHERE workspace_id = ? AND user_id = ? AND provider = 'google' AND status = 'active'", actor.workspace.id, ctx.user.id)?.account
      : ctx.user.email;
    if (!to) fail(400, 'not_connected', 'Connect your Google account first.');
    if (app.config.emailProvider !== 'http') fail(409, 'email_not_configured', 'A real email provider is not configured yet.');
    limit(ctx, 'email-test', 6, 3600000);
    // A persisted hourly key also deduplicates double clicks and checks after a restart.
    const id = queueEmail(app, {
      workspaceId: actor.workspace.id,
      key: `delivery-test:${actor.workspace.id}:${ctx.user.id}:${body.target}:${Math.floor(app.now() / 3600000)}`,
      kind: 'delivery_test', to, subject: 'Schedora email delivery check',
      body: 'This is the email delivery check you requested from Schedora. Your sending configuration is working. No appointment was created.'
    });
    await deliverEmail(app, id);
    app.nudge();
    const result = app.db.get('SELECT status, last_error FROM emails WHERE id = ?', id);
    return { to, status: result.status, error: result.last_error, provider: 'http' };
  });

  // ---- Calendars ----
  get(ws('/calendar'), ctx => { const actor = member(ctx, 'meet.manage_own'); const connections = listConnections(app, actor.workspace.id, ctx.user.id); return { connection: connections[0] || null, connections }; });
  post(ws('/calendar'), async ctx => { const actor = member(ctx, 'meet.manage_own'); limit(ctx, 'calendar', 10); return { connection: await connectCalendar(app, actor.workspace.id, ctx.user.id, await ctx.json()) }; });
  post(ws('/calendar/sync'), async ctx => {
    const actor = member(ctx, 'meet.manage_own');
    limit(ctx, 'calendar', 10);
    const connections = listConnections(app, actor.workspace.id, ctx.user.id);
    if (!connections.length) fail(404, 'not_found', 'No calendar is connected.');
    for (const connection of connections) await syncConnection(app, connection.id);
    const fresh = listConnections(app, actor.workspace.id, ctx.user.id);
    return { connection: fresh[0], connections: fresh };
  });
  del(ws('/calendar'), ctx => { const actor = member(ctx, 'meet.manage_own'); disconnectCalendar(app, actor.workspace.id, ctx.user.id); return { status: 204 }; });
  del(ws('/calendar/:id'), ctx => { const actor = member(ctx, 'meet.manage_own'); disconnectCalendar(app, actor.workspace.id, ctx.user.id, ctx.params.id); return { status: 204 }; });

  // ---- Workflows ----
  const workflowGuard = (actor, eventTypeId) => {
    if (!eventTypeId) { if (!can(actor.role, 'meet.manage_all')) fail(403, 'forbidden', 'Only administrators create workspace-wide workflows.'); return; }
    getEventType(app, actor.workspace.id, eventTypeId, actor);
  };
  get(ws('/workflows'), ctx => { const actor = member(ctx, 'meet.manage_own'); return listWorkflows(app, actor.workspace.id, ctx.query.get('event_type')); });
  post(ws('/workflows'), async ctx => { const actor = member(ctx, 'meet.manage_own'); const body = await ctx.json(); workflowGuard(actor, body.event_type_id); return { status: 201, body: createWorkflow(app, actor.workspace.id, body) }; });
  patch(ws('/workflows/:id'), async ctx => {
    const actor = member(ctx, 'meet.manage_own');
    const existing = app.db.get('SELECT event_type_id FROM meet_workflows WHERE id = ? AND workspace_id = ?', ctx.params.id, actor.workspace.id);
    if (!existing) fail(404, 'not_found', 'Workflow not found.');
    const body = await ctx.json();
    workflowGuard(actor, existing.event_type_id);
    if (body.event_type_id !== undefined) workflowGuard(actor, body.event_type_id);
    return updateWorkflow(app, actor.workspace.id, ctx.params.id, body);
  });
  del(ws('/workflows/:id'), ctx => {
    const actor = member(ctx, 'meet.manage_own');
    const existing = app.db.get('SELECT event_type_id FROM meet_workflows WHERE id = ? AND workspace_id = ?', ctx.params.id, actor.workspace.id);
    if (!existing) fail(404, 'not_found', 'Workflow not found.');
    workflowGuard(actor, existing.event_type_id);
    deleteWorkflow(app, actor.workspace.id, ctx.params.id);
    return { status: 204 };
  });

  // ---- Polls ----
  get(ws('/polls'), ctx => { const actor = member(ctx, 'meet.manage_own'); return listPolls(app, actor.workspace.id, actor); });
  post(ws('/polls'), async ctx => { const actor = member(ctx, 'meet.manage_own'); return { status: 201, body: createPoll(app, actor.workspace.id, actor, await ctx.json()) }; });
  get(ws('/polls/:id'), ctx => { const actor = member(ctx, 'meet.manage_own'); return getPoll(app, actor.workspace.id, actor, ctx.params.id); });
  post(ws('/polls/:id/confirm'), async ctx => { const actor = member(ctx, 'meet.manage_own'); return confirmPoll(app, actor.workspace.id, actor, ctx.params.id, await ctx.json()); });
  post(ws('/polls/:id/close'), ctx => { const actor = member(ctx, 'meet.manage_own'); return closePoll(app, actor.workspace.id, actor, ctx.params.id); });
  del(ws('/polls/:id'), ctx => { const actor = member(ctx, 'meet.manage_own'); deletePoll(app, actor.workspace.id, actor, ctx.params.id); return { status: 204 }; });

  // ---- Contacts ----
  get(ws('/contacts'), ctx => { const actor = member(ctx, 'contacts.read'); return listContacts(app, actor.workspace.id, { search: ctx.query.get('q'), tag: ctx.query.get('tag'), offset: ctx.query.get('offset') }); });
  post(ws('/contacts'), async ctx => { const actor = member(ctx, 'contacts.manage'); return { status: 201, body: createContact(app, actor.workspace.id, await ctx.json()) }; });
  get(ws('/contacts/:id'), ctx => { const actor = member(ctx, 'contacts.read'); return getContact(app, actor.workspace.id, ctx.params.id); });
  patch(ws('/contacts/:id'), async ctx => { const actor = member(ctx, 'contacts.manage'); return updateContact(app, actor.workspace.id, ctx.params.id, await ctx.json()); });
  del(ws('/contacts/:id'), ctx => { const actor = member(ctx, 'contacts.delete'); deleteContact(app, actor.workspace.id, ctx.params.id); return { status: 204 }; });
  post(ws('/contacts/:id/notes'), async ctx => { const actor = member(ctx, 'contacts.manage'); return addNote(app, actor.workspace.id, actor, ctx.params.id, await ctx.json()); });
  del(ws('/contacts/:id/notes/:note'), ctx => { const actor = member(ctx, 'contacts.manage'); deleteNote(app, actor.workspace.id, actor, ctx.params.id, ctx.params.note); return { status: 204 }; });
  post(ws('/contacts/:id/follow-ups'), async ctx => { const actor = member(ctx, 'contacts.manage'); return addFollowUp(app, actor.workspace.id, actor, ctx.params.id, await ctx.json()); });

  // ---- Analytics ----
  get(ws('/analytics'), ctx => {
    const actor = member(ctx, 'meet.manage_own');
    const timezone = isValidTimeZone(ctx.query.get('tz')) ? ctx.query.get('tz') : 'UTC';
    const to = ctx.query.get('to') || localDate(app.now(), timezone);
    return analytics(app, actor.workspace.id, actor, { from: ctx.query.get('from') || addDays(to, -29), to, timezone });
  });

  // ---- Payments setup ----
  get(ws('/integrations'), ctx => {
    const actor = member(ctx, 'meet.manage_own');
    return app.db.all(`SELECT id, provider, account, status, last_error, created_at, user_id FROM integrations WHERE workspace_id = ? AND (user_id IS NULL OR user_id = ?)`, actor.workspace.id, actor.userId);
  });
  post(ws('/integrations/stripe'), async ctx => { const actor = member(ctx, 'integrations.manage'); return connectStripe(app, actor.workspace.id, await ctx.json()); });
  del(ws('/integrations/stripe'), ctx => {
    const actor = member(ctx, 'integrations.manage');
    app.db.run("DELETE FROM integrations WHERE workspace_id = ? AND user_id IS NULL AND provider = 'stripe'", actor.workspace.id);
    return { status: 204 };
  });
  post(ws('/integrations/razorpay'), async ctx => {
    const actor = member(ctx, 'integrations.manage');
    return connectRazorpay(app, actor.workspace.id, await ctx.json());
  });
  del(ws('/integrations/razorpay'), ctx => {
    const actor = member(ctx, 'integrations.manage');
    if (app.db.get("SELECT 1 FROM bookings WHERE workspace_id = ? AND status = 'pending' AND payment_ref LIKE 'razorpay:%'", actor.workspace.id)) fail(409, 'payments_pending', 'Wait for pending payments before disconnecting Razorpay.');
    app.db.run("DELETE FROM integrations WHERE workspace_id = ? AND user_id IS NULL AND provider = 'razorpay'", actor.workspace.id);
    return { status: 204 };
  });

  // ---- Public ----
  const publicEvent = ctx => {
    const eventType = findEventTypeBySlug(app, ctx.params.wsSlug, ctx.params.slug);
    const now = app.now();
    const live = eventType && eventType.published && (!eventType.expires_at || eventType.expires_at > now);
    // Members may preview unpublished event types; nobody can book them.
    const preview = eventType && !live && ctx.user && app.db.get('SELECT 1 FROM memberships WHERE workspace_id = ? AND user_id = ?', eventType.workspace_id, ctx.user.id);
    if (!live && !preview) fail(404, 'not_found', 'This booking page is not available.');
    return { ...eventType, hosts: loadEventType(app, eventType.id).hosts, preview: !live };
  };
  const eventSummary = eventType => ({
    title: eventType.title, description: eventType.description, duration_min: eventType.duration_min, kind: eventType.kind, seats: eventType.seats,
    timezone: eventType.timezone, workspace_name: eventType.workspace_name, workspace_slug: eventType.workspace_slug, slug: eventType.slug,
    host_name: eventType.kind === 'round_robin' ? eventType.workspace_name : eventType.hosts.map(host => host.name).join(', '),
    location: eventType.location,
    locations: eventType.locations.map(location => ({ type: location.type, label: LOCATION_TYPES[location.type], display: locationDisplay(location), needs_phone: location.type === 'phone_host_calls', auto_video: AUTO_VIDEO.includes(location.type) })),
    questions: eventType.questions, price: eventType.price_cents ? { amount_cents: eventType.price_cents, currency: eventType.currency, fee_policy: app.payments.feePolicy(eventType.workspace_id) } : null,
    branding: { color: eventType.brand_color, logo: eventType.logo, welcome: eventType.welcome_message },
    confirmation_message: eventType.confirmation_message, redirect_url: eventType.redirect_url, preview: Boolean(eventType.preview), one_off: eventType.one_off
  });
  function slotsResponse(eventType, ctx, hostView = false) {
    const from = ctx.query.get('from');
    const days = Math.min(62, Number(ctx.query.get('days')) || 62);
    const fromDate = isValidDate(from) ? addDays(from, -1) : undefined;
    const toDate = fromDate ? addDays(from, days + 1) : undefined;
    const accepting = entitlementsFor(app, eventType.workspace_id).meet.active && (hostView || !eventType.preview);
    const { slots, joinable } = accepting || hostView ? computeAvailability(app, eventType, { fromDate, toDate }) : { slots: new Map(), joinable: new Map() };
    const list = [...slots.keys()].map(ms => new Date(ms).toISOString());
    const seats = eventType.kind === 'group' ? Object.fromEntries([...slots.keys()].map(ms => {
      const meeting = joinable.get(ms);
      return [new Date(ms).toISOString(), meeting ? meeting.seats - meeting.taken : eventType.seats];
    })) : undefined;
    return { timezone: eventType.timezone, slots: accepting || hostView ? list : [], seats_left: seats, accepting, today: localDate(app.now(), eventType.timezone) };
  }
  get('/api/public/meet/:wsSlug', ctx => {
    const page = publicWorkspacePage(app, ctx.params.wsSlug);
    if (!page) fail(404, 'not_found', 'This page is not available.');
    return page;
  }, { public: true });
  get('/api/public/meet/:wsSlug/:slug', ctx => eventSummary(publicEvent(ctx)), { public: true });
  get('/api/public/meet/:wsSlug/:slug/slots', ctx => { limit(ctx, 'slots', 120); return slotsResponse(publicEvent(ctx), ctx); }, { public: true });
  post('/api/public/meet/:wsSlug/:slug/bookings', async ctx => {
    limit(ctx, 'booking', 20);
    const eventType = publicEvent(ctx);
    if (eventType.preview) fail(409, 'preview_only', 'This page is a preview. Publish the event type to accept bookings.');
    const body = await ctx.json();
    if (body.website) fail(400, 'rejected', 'Submission rejected.');
    try {
      const { booking, token, replay, handoff_linked } = createBooking(app, eventType, body, ctx.request.headers['idempotency-key']);
      let checkout = null;
      let checkout_error = null;
      if (booking.status === 'pending' && token) {
        try { checkout = await app.payments.checkout(booking, eventType, token); }
        catch { checkout_error = 'Checkout is temporarily unavailable. Retry payment from your booking page before the hold expires.'; }
      }
      return { status: replay ? 200 : 201, body: { booking: publicBooking(app, booking, eventType), manage_token: token, replay, checkout, checkout_error, handoff_linked: Boolean(handoff_linked) } };
    } catch (error) {
      if (error.code === 'slot_unavailable') error.details = { ...error.details, ...slotsResponse(eventType, ctx) };
      throw error;
    }
  }, { public: true });

  get('/api/public/bookings/:token', ctx => {
    limit(ctx, 'manage', 60);
    const { booking, eventType, expired } = bookingByToken(app, ctx.params.token);
    return { booking: publicBooking(app, booking, eventType), expired, can_change: !expired && booking.status === 'confirmed' && (Boolean(eventType.published) || eventType.one_off) };
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
  post('/api/public/bookings/:token/checkout', async ctx => {
    limit(ctx, 'manage', 20);
    const { booking, eventType } = bookingByToken(app, ctx.params.token);
    if (booking.status !== 'pending') fail(409, 'not_pending', 'This booking does not need payment.');
    return app.payments.checkout(booking, eventType, ctx.params.token);
  }, { public: true });
  post('/api/public/bookings/:token/test-pay', ctx => {
    limit(ctx, 'manage', 20);
    const { booking } = bookingByToken(app, ctx.params.token);
    return { result: app.payments.testPay(ctx.params.token, booking.id) };
  }, { public: true });
  post('/api/payments/stripe/:wsId', async ctx => {
    const raw = (await ctx.raw(256 * 1024)).toString('utf8');
    return { result: app.payments.handleStripeWebhook(ctx.params.wsId, raw, ctx.request.headers['stripe-signature']) };
  }, { public: true, csrfExempt: true });
  post('/api/payments/razorpay/:wsId', async ctx => {
    const raw = (await ctx.raw(256 * 1024)).toString('utf8');
    return { result: await app.payments.razorpay.webhook(ctx.params.wsId, raw, ctx.request.headers['x-razorpay-signature']) };
  }, { public: true, csrfExempt: true });
  post('/api/public/bookings/:token/verify-payment', async ctx => {
    limit(ctx, 'manage', 20);
    const { booking } = bookingByToken(app, ctx.params.token);
    return { result: await app.payments.razorpay.verify(booking, ctx.params.token) };
  }, { public: true });

  get('/api/public/polls/:slug', ctx => { limit(ctx, 'manage', 60); return publicPoll(app, ctx.params.slug); }, { public: true });
  post('/api/public/polls/:slug/votes', async ctx => { limit(ctx, 'responses', 30); return vote(app, ctx.params.slug, await ctx.json()); }, { public: true });
}
