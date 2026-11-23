import { fail } from '../http.mjs';
import { cancelRun, decideApproval, listApprovals, nextScheduleRuns, retryFailedRuns, retryFlowRun, retryPreview, runTimeline } from './engine.mjs';
import { checkPublish, createDraft, describeAutomation, describeUsage, flowFields, flowUsage, getFlowV1, listFlowsV1, manualRowFlows, publishFlow, receiveInboundHook, rotateInboundHook, runFlowOnRow, saveDraft, sendTestToMe, setFlowStatus, testFlow } from './manage.mjs';
import { connectSlack, disconnectSlack, providerStatus } from './integrations.mjs';
import { createFromTemplate, JOBS, listTemplates } from './templates.mjs';
import { flowProblems, RUN_STATUS, TRIGGERS } from '../shared/flow-logic.mjs';

// Flow v1 API (docs/FLOW_V1_IMPLEMENTATION.md, "API"). Reading needs flows.read; building, publishing,
// testing and retrying need flows.manage. Approvals are decided by their approver or an admin.
export function registerFlowRoutes(app, router, { member, limit }) {
  const { get, post, put, delete: del } = router;
  const ws = path => `/api/workspaces/:ws${path}`;
  const browserOnly = (ctx, what) => { if (ctx.apiKey) fail(403, 'forbidden', `${what} from the Schedora web app.`); };

  get(ws('/flow/workflows'), ctx => listFlowsV1(app, member(ctx, 'flows.read').workspace.id));
  post(ws('/flow/workflows'), async ctx => { const actor = member(ctx, 'flows.manage'); const body = await ctx.json(256 * 1024); return { status: 201, body: body.template ? createFromTemplate(app, actor, body) : createDraft(app, actor, body) }; });
  get(ws('/flow/workflows/:id'), ctx => getFlowV1(app, member(ctx, 'flows.read').workspace.id, ctx.params.id));
  put(ws('/flow/workflows/:id/draft'), async ctx => saveDraft(app, member(ctx, 'flows.manage'), ctx.params.id, await ctx.json(256 * 1024)));
  post(ws('/flow/workflows/:id/publish-check'), async ctx => checkPublish(app, member(ctx, 'flows.manage'), ctx.params.id));
  post(ws('/flow/workflows/:id/publish'), async ctx => publishFlow(app, member(ctx, 'flows.manage'), ctx.params.id, await ctx.json(4096)));
  post(ws('/flow/workflows/:id/status'), async ctx => setFlowStatus(app, member(ctx, 'flows.manage'), ctx.params.id, await ctx.json(4096)));
  get(ws('/flow/workflows/:id/fields'), ctx => flowFields(app, member(ctx, 'flows.read'), ctx.params.id));
  post(ws('/flow/workflows/:id/test'), async ctx => { browserOnly(ctx, 'Test workflows'); const actor = member(ctx, 'flows.manage'); limit(ctx, 'flow-test', 60); return testFlow(app, actor, ctx.params.id, await ctx.json(16 * 1024)); });
  post(ws('/flow/workflows/:id/test-send'), async ctx => { browserOnly(ctx, 'Send tests'); const actor = member(ctx, 'flows.manage'); limit(ctx, 'flow-test-send', 10); return sendTestToMe(app, actor, ctx.params.id, await ctx.json(4096)); });
  post(ws('/flow/workflows/:id/webhook'), ctx => { browserOnly(ctx, 'Create webhook addresses'); return rotateInboundHook(app, member(ctx, 'flows.manage'), ctx.params.id); });
  post(ws('/flow/workflows/:id/retry-failed'), async ctx => { const actor = member(ctx, 'flows.manage'); const body = await ctx.json(64 * 1024); return retryFailedRuns(app, actor.workspace.id, ctx.params.id, Array.isArray(body.run_ids) ? body.run_ids : null); });
  get(ws('/flow/templates'), () => ({ templates: listTemplates(), jobs: JOBS }));
  get(ws('/flow/catalog'), () => ({ triggers: TRIGGERS, statuses: RUN_STATUS }));
  // The next three times a schedule would run, for the builder. Nothing is scheduled by asking.
  get(ws('/flow/schedule-preview'), ctx => {
    member(ctx, 'flows.read');
    const q = name => ctx.query.get(name);
    const config = { every: q('every'), time: q('time') || '09:00', ...(q('weekday') != null ? { weekday: Number(q('weekday')) } : {}), ...(q('timezone') ? { timezone: q('timezone') } : {}) };
    const problems = flowProblems({ trigger: { type: 'schedule', config }, steps: [{ id: 'x', type: 'action', action: 'create_task', config: { title: 'x' } }] });
    if (problems.length) fail(400, 'validation_failed', problems[0]);
    return { timezone: config.timezone || 'UTC', runs: nextScheduleRuns(config, app.now(), 3) };
  });
  get(ws('/flow/integrations'), ctx => providerStatus(app, member(ctx, 'flows.read').workspace.id));
  put(ws('/flow/integrations/slack'), async ctx => { browserOnly(ctx, 'Connect Slack'); return connectSlack(app, member(ctx, 'integrations.manage').workspace.id, await ctx.json(4096)); });
  del(ws('/flow/integrations/slack'), ctx => { disconnectSlack(app, member(ctx, 'integrations.manage').workspace.id); return { status: 204 }; });
  get(ws('/flow/usage'), ctx => ({ ...flowUsage(app, member(ctx, 'flows.read').workspace.id), describe: describeUsage(app, ctx.params.ws) }));
  post(ws('/flow/describe'), async ctx => { browserOnly(ctx, 'Describe automations'); const actor = member(ctx, 'flows.manage'); limit(ctx, 'flow-describe', 10); return { status: 201, body: await describeAutomation(app, actor, await ctx.json(16 * 1024)) }; });

  get(ws('/flow/runs/:id'), ctx => runTimeline(app, member(ctx, 'flows.read').workspace.id, ctx.params.id));
  post(ws('/flow/runs/:id/cancel'), ctx => { const actor = member(ctx, 'flows.manage'); return cancelRun(app, actor.workspace.id, ctx.params.id, ctx.user.name || 'a team member'); });
  get(ws('/flow/runs/:id/retry'), ctx => retryPreview(app, member(ctx, 'flows.read').workspace.id, ctx.params.id));
  post(ws('/flow/runs/:id/retry'), async ctx => retryFlowRun(app, member(ctx, 'flows.manage').workspace.id, ctx.params.id, await ctx.json(4096)));

  get(ws('/flow/approvals'), ctx => listApprovals(app, member(ctx, 'flows.read'), ['pending', 'all'].includes(ctx.query.get('status')) ? ctx.query.get('status') : 'pending'));
  post(ws('/flow/approvals/:id'), async ctx => { browserOnly(ctx, 'Decide approvals'); return decideApproval(app, member(ctx, 'flows.read'), ctx.params.id, await ctx.json(16 * 1024)); });

  // Sheets: "Run Flow on this row" (editable workbooks only).
  get(ws('/workbooks/:id/row-flows'), ctx => manualRowFlows(app, member(ctx, 'flows.read'), ctx.params.id));
  post(ws('/workbooks/:id/run-flow'), async ctx => { const actor = member(ctx, 'flows.read'); limit(ctx, 'flow-row', 30); return { status: 201, body: runFlowOnRow(app, actor, ctx.params.id, await ctx.json(4096)) }; });

  // Incoming webhook trigger: signed, replay-protected, bounded; never logs the payload.
  post('/api/hooks/flows/:token', async ctx => {
    limit(ctx, 'flow-hook', 120);
    const raw = (await ctx.raw(64 * 1024)).toString('utf8');
    return { status: 202, body: receiveInboundHook(app, ctx.params.token, raw, ctx.request.headers) };
  }, { public: true, csrfExempt: true });
}
