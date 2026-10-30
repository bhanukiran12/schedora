# Schedora first-release acceptance

Evidence reconciled: 30 October 2026. Latest deployed application observed: `ba76f3fc64393a8da933e94aecae00447e4a5e96`; branch CI 40834683936 and main CI 40835311738 passed both jobs. Earlier evidence below retains its recorded scope. This is a requirement-by-requirement tracker, not a production-ready badge. The full researched, differentiated and validated product objective remains incomplete. A later callback-only configuration deployment is live; the final deployment restoring the normal build command still needs an authenticated status check.

## Evidence rules

Implemented code, automated tests, deployment health, real-provider results and customer validation are different evidence classes. A passing test proves only its covered scenario. Do not count old local skips as failing CI, or count healthy startup as a direct database/data-integrity audit. Pricing stimuli are not approved commercial terms. Hypotheses are not interview findings.

## Acceptance matrix

| Requirement | Current authoritative evidence | State | Evidence still required |
| --- | --- | --- | --- |
| Independent product identity, login/signup, appropriate setup; Suite retains all three | context.mjs, account.mjs, shell.mjs, onboarding.mjs; final browser host journeys, 736 layout checks; eight live auth URLs return 200/noindex | Automated and deployed | Real Google sign-in across subdomains, user task comprehension |
| Saved/published Forms, conditional required fields, safe retry/quota enforcement | forms-reliability.test.mjs, forms-publish-check.test.mjs; real PostgreSQL CI; browser draft/publish/submit/conflict journeys | Automated and deployed | Own-workspace human end-to-end result; production data audit remains separate |
| Meet event creation, booking, timezone, cancellation/reschedule and readiness | Meet tests and browser journeys; saved-state readiness uses server slot checks | Automated and deployed | Real provider link creation, other-host readiness, last-successful-calendar-sync evidence |
| Response → booking offer → booking → follow-up is understandable and traceable | enquiries.mjs keyset feed; enquiry-trail/Flow tests and browser journeys | Automated and deployed within recorded scope | Human task success; server state/counts, enquiry ownership/resolve and reconciliation |
| Flow task deadlines/assignees and email transport evidence are truthful | flow/service.mjs; flow.test.mjs; task/email browser journeys | Automated and deployed | Actual provider-accepted/delivered/bounced message to own test addresses; production remains outbox |
| Accessible navigation, control labels, errors and responsive layouts | Browser keyboard/drawer/focus, contrast and zoom/reflow checks; reviewed screenshots | Automated/visual evidence | Real screen-reader check and consenting human task study; do not claim a complete WCAG audit |
| Real email operations | Production config previously read as outbox; code separates outbox/acceptance/delivery | Open operational gate | Configure selected real provider privately, signed delivery webhook, own-inbox receipt and controlled failure evidence |
| Monitoring reaches the operator | Real operator-test Inbox receipt; UptimeRobot API/database and worker monitors Up; controlled incident 373837337120738356 recovered, owner confirmed actual DOWN/UP email receipt; Render monitoring flag read back true on 29 October | Verified within the recorded five-minute-monitor scope | Maintain monitor/recipient configuration and quota capacity; this is not provider media, commercial readiness or an uptime guarantee. See EXTERNAL_MONITORING.md |
| Built-in video production acceptance | LiveKit credentials/permanent signed callback configured; staging evidence and user audio retest; ba76f3f adds an owner-workspace instant-only pilot, two people/15 minutes/one room and 60 evaluation participant-minutes per UTC month; production empty-room control-plane creation/list/cleanup passed | Limited pilot active; general video and recharge purchases disabled | Production media/lifecycle/credit-settlement acceptance, physical-device/recovery/accessibility checks and ongoing shared-quota capacity verification. Control-plane success does not prove media quality. See VIDEO_VALIDATION_PILOT.md |
| Recharge callback security and commercial activation | Razorpay platform webhook TthBMZ8qoOl3NO enabled with five approved events and a saved secret; backend provider razorpay; 30 October controlled unknown-event check accepted a valid HMAC (200/ignored) and rejected an invalid signature (400) | Receiver verified within that scope; checkout and recharge purchases closed | Actual Razorpay delivery (including matching signing secrets), capture/exact-once credits/refunds, measured fully loaded pack costs/reserve and owner-approved amounts. No live transaction has been tested; see VIDEO_RECHARGE_PRICING.md |
| Pricing/allowances/tax/positioning match actual offer | PRICING_PROPOSAL.md labelled interview material; live purchase paths unchanged | Proposal only | Measured costs, owner commercial/tax approval, enforced budgets and comprehension research |
| Differentiation and customer value validated | Dated official competitor research and UX_RESEARCH_PLAN.md hypotheses | Hypothesis only | Consenting operator interviews/tasks using last real enquiry; compare current workflow, record failures and willingness-to-pay evidence |
| Release reproducible and healthy | Branch CI 40680867402 and main CI 40681407234 both success for 328ed25; Vercel and Render provider status success; DB/worker health OK | Verified increment | Does not close provider/human/commercial gates above; retain rollback to 83a0dec |

## Next work, ordered by evidence need

1. Operator monitoring acceptance is recorded above. Close the separate customer-email configuration gap using the existing implementation, chosen provider and private configuration. Operator alert receipt does not prove customer delivery. Do not simulate delivery or flip confirmation flags. No paid plan or live-customer messages are authorized by this document.
2. Independently improve backend evidence for Meet readiness (separate successful calendar-sync timestamp and team-host scope). Per-form complete history and tied-arrival paging now have passing local and PostgreSQL/Linux CI evidence in a6d0fc8; see the release checkpoint for deployment status. Agree API/data semantics before expanding UI claims.
3. Run the owner's existing manual validation checklist against the released login/setup/Forms/Meet/Flow journeys. Record environment, dates and actual outcomes; unrun steps remain open.
4. Conduct the scoped consenting-operator research in UX_RESEARCH_PLAN.md before prioritising major feature expansion or approving prices. Research scripts are ready; no interviews or conversions are fabricated.
5. Enable production video only after its operational, smoke and budget gates are genuinely met. AWS migration remains separate and blocked by account readiness.

## Current source map

- Implementation history: RESEARCH_IMPLEMENTATION.md; current scope: FEATURE_PRIORITIES.md.
- Strategy/positioning: SUITE_STRATEGY_2026_10_27.md; research methods/metrics: UX_RESEARCH_PLAN.md.
- Proposal: PRICING_PROPOSAL.md. Enquiry contract: ENQUIRY_TRAIL_CONTRACT.md.
- Operations: EMAIL.md, product/video runbooks and backend/scripts/production-check.mjs.
- External evidence log: C:/Users/Nxtwave/Documents/ChatGPT/schedora/reports/Schedora-recurring-progress.md.

The original reconciliation added no feature or provider evidence; subsequent dated increments and the current monitoring row record later verified work. They do not establish customer validation or complete production readiness.

## 30 October readiness evidence correction (local increment)

An active Google/Zoom/Microsoft connection does not prove that a meeting link can be created for a new booking. The saved-event readiness assessment now labels that outcome Not verified and states when creation is requested. It does not create a test meeting, alter permissions, disable sharing or call a provider. Focused tests cover all three integrations and retain existing disconnected/team-host behavior. Deployment of this later increment is separate from ba76f3f and must be recorded before claiming it is live.


## Forms history increment — 28 October 2026

Commit a6d0fc8 fixes per-form history coverage and tied-arrival paging. Branch CI 40683016103 succeeded for its exact SHA, including PostgreSQL and Linux browser. Local tests: 211 total, 207 pass, four PostgreSQL skips locally; browser: 744 layout checks. Follow-ups are selected by loaded response/authorized linked-booking ids, not the latest 200 workspace records. Paging stays usable under an empty attention filter and announces its result. No schema migration or provider change. This closes the per-form cap engineering gap; large-history latency and human validation remain open. The release checkpoint records whether this increment has reached production; the earlier 328ed25 matrix evidence remains historical.


## Calendar evidence increment — 28 October 2026 (branch verification)

The current increment adds a separate successful calendar-sync timestamp and fixes the live onboarding feed field/first-sync failure behavior. See CALENDAR_SYNC_EVIDENCE.md for its API, migration and rollback contract. Local regression and responsive checks pass; PostgreSQL upgrade/CI and production remain gates until their checkpoints are inspected. This addresses own-host successful-sync evidence, not the team-host readiness endpoint, real-provider or human-validation requirements.
