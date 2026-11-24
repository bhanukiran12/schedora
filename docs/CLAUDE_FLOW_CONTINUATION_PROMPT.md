# Claude prompt — finish Schedora Flow for release

Work in `C:\Users\Nxtwave\Documents\My Works\schedora`. Complete the remaining Flow product work from the existing checkout. Implement and verify the gaps; do not stop at an analysis or ask me to choose routine priorities.

## Product direction and existing implementation

Schedora connects Forms → Sheets → Meet → reviewed follow-up in one workspace. Flow is the automation layer for that journey. Follow the original research direction: reliable native follow-up, a plain-language vertical step list, clear run history and predictable usage. It is not a general-purpose Zapier/n8n clone. Keep one counted run per workflow execution; simulations and retries do not add usage.

Flow v1 already exists. Read these before editing:

- `docs/FLOW_V1_IMPLEMENTATION.md`
- `docs/FLOW_V1_STAGING_RELEASE.md`, especially the executed release record
- `docs/PRODUCT_RESEARCH_IMPLEMENTATION_2026-11-21.md`
- `docs/AWS_DATABASE_MIGRATION_2026-11-24.md` and its latest evidence
- The original product-analysis attachment if available: `C:\Users\Nxtwave\.codex\attachments\5e46398d-7178-4051-a040-858353d788b4\Pasted text.txt`

Inspect current code and Git status. Preserve existing changes. Another session owns the AWS database migration: do not modify its infrastructure, migration scripts, permissions, secrets, deployment definitions, production routing or database targets. Coordinate any overlapping files before editing them. Never assume that RDS provisioning means the application cutover has finished. Keep `FLOW_V1_ACTIVATION=held` until the release owner confirms that all active workers use compatible code and the chosen shared database.

Already implemented: versioned multi-step runs; conditions and branches; durable waits/event waits/approvals; retries, leases and uncertain-send recovery; scheduling; native triggers/actions; builder, simulations, field chips, run timelines, usage and failure alerts; eight templates. Verify these rather than rebuilding the engine. The latest unit run on 24 November had 560 tests: 553 passed, 0 failed, 7 optional PostgreSQL tests skipped. Those counts are historical evidence, not substitutes for your own checks. Live external-provider verification is still outstanding.

## Execute in this order

1. **Establish the actual gaps.** Compare the research and release docs with current code and visible UI. Create a short matrix: implemented and verified / implemented but unverified / missing / externally blocked. Make the remaining items concrete and then implement them in priority order. Do not present the original pre-v1 feature list as if it is still missing.

2. **Finish trustworthy integration readiness.** Review `backend/src/flow/integrations.mjs` and all connection/test paths. Configuration or the existence of an active sync row must not by itself be called a successful live test. In particular, audit Razorpay and Google Sheets readiness claims. Store evidence of the appropriate successful verification, handle connection replacement/revocation/expiry, and invalidate stale test status. Keep Not configured, Connected but untested, Provider accepted and Delivered distinct. Do not fabricate delivery evidence. A simulation never makes a provider ready for live workflows.

   Support the approved providers and contracts already present: email transport; Twilio SMS and Twilio WhatsApp with approved templates and consent; Razorpay verified payment events; Google Calendar through Meet; one-way Forms → Google Sheets sync; Slack; signed incoming/outgoing webhooks; existing REST API/MCP; reviewed Claude AI steps. Do not silently turn one-way Forms sync into arbitrary Google Sheets row automation. Do not switch providers or expose unimplemented connections as available. External CRM connectors, loops, subflows and autonomous tool-using agents remain later work unless separately authorized.

3. **Finish the eight real jobs end to end.** Audit and fix: speed-to-lead; reminders and no-show recovery; meeting preparation; reviewed after-meeting follow-up; round-robin routing and ownership; Sheets status changes/onboarding; verified payment follow-up; feedback and low-rating escalation. Confirm source bindings, field mapping, owner/recipient resolution, canceled/rescheduled bookings, opt-outs, missing data and duplicate events. Payment confirmation must not duplicate Forms receipts. Automated/undo/redo sheet writes must not retrigger their own workflows. Preserve durable waits, version pinning and restart recovery.

4. **Polish the nontechnical workflow.** Make templates, the vertical builder, save/publish/activation states, simulation preview, author-only test send, retry preview and approvals understandable without tokens or JSON. Show actionable connection failures and the exact work a retry will repeat. Preserve keyboard focus, unsaved changes and revision/conflict recovery. Check Forms/Meet/Sheets entry points. Match Schedora's System/Light/Dark dashboard styles, near-black dark surfaces and green primary buttons. Verify phone-sized approvals and run history; avoid broad unrelated redesigns of Meet, Forms or Sheets.

5. **Prove reliability and isolation.** Add meaningful tests for each actual defect: workspace and role boundaries; duplicate events; retries and partial failures; restart recovery; timer/time-zone behavior; uncertain side effects; approvals; deleted source records; paused workflows; provider replacement; and activation gating. No automatic resend of uncertain external effects. Keep one execution charge per run, and do not change approved prices or introduce message billing without approval.

6. **Run the release checks.** Use disposable SQLite/PostgreSQL fixtures with verified TLS; never run destructive tests or application initialization against the hosted URL in `.env`. Run syntax/shared-source checks, relevant unit and PostgreSQL tests, `flow-builder-check`, the combined Sheets/product/expanded gate when affected, and the full browser regression. Check desktop/mobile, light/dark, errors and overflow. Record exact passed/failed/skipped counts and fix regressions you introduce. Preserve the Sheets pointer-capture, multiline editing, resize, undo/redo and persistence fixes.

7. **Prepare real-provider acceptance separately.** List precisely which accounts, templates, OAuth settings and callback URLs remain missing. Use runtime-injected credentials; never print or commit secrets. Perform live sends, AI calls, payment tests or external writes only within the owner's explicit authorization and approved destinations. Missing credentials should block only that provider's live acceptance, not independent implementation and testing. Do not label an unrun provider test as passed.

## Deliverables

Finish the authorized code and tests. Update `docs/FLOW_V1_IMPLEMENTATION.md` with the current gap matrix, changes, exact verification results and remaining external setup. Include a short owner acceptance checklist covering the eight jobs. Report what is now usable, what remains gated and why, and any material limitation. Keep local implementation, staging deployment, production activation and live-provider verification as separate statuses. Do not deploy, alter the shared database, lift the activation hold or change production routing as part of this development handoff.
