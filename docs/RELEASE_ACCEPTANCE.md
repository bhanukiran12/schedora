# Schedora first-release acceptance

Evidence reconciled: 30 October 2026. Latest deployed application observed: `ba76f3fc64393a8da933e94aecae00447e4a5e96`; branch CI 40834683936 and main CI 40835311738 passed both jobs. Earlier evidence below retains its recorded scope. This is a requirement-by-requirement tracker, not a production-ready badge. The full researched, differentiated and validated product objective remains incomplete. A later callback-only configuration deployment is live; the final deployment restoring the normal build command still needs an authenticated status check.

## Evidence rules

3 November direct metadata check: the connected Supabase project matched the backend's configured project identity. Read-only SQL confirmed the `schedora.schema_migrations` records through `postgres_v12_calendar_success`, including `postgres_v6_email_transport`, `postgres_v8_email_delivery_reports` and `postgres_v11_live_onboarding`; the actual `accepted_transport`, `delivery_status`, `delivery_event_at` and calendar `last_success_at` columns exist. This strengthens the earlier startup-only migration evidence. It proves neither inbox delivery, row-count preservation against a before snapshot, nor a successful customer journey. Media/session upgrades13/14 were absent, consistent with this feature branch not being released. No production data or configuration changed.

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

## Release checklist: Forms (themes, groups, jumps, hide-choice rules, URL parameters, evaluation policy)

Readiness pass of 6 November 2026, on uncommitted work on top of `2f54fe7`. **Nothing was deployed, and no production or staging system was contacted.** All of it ran on this computer against disposable PostgreSQL 17 with verified TLS, the image CI uses. "Previous release" in this table means `ba76f3f`, which this document had recorded as deployed. **That was out of date:** production runs `e3b6b5d`, so the checks are rerun below.

| # | Gate | Result | Evidence or what is missing |
|---|---|---|---|
| 1 | Forms CI suite on PostgreSQL | **Pass (local)** | CI's test list: 182 tests, 182 pass. GitHub CI itself has not run, because nothing is pushed |
| 2 | Migrations on a fresh database | **Pass** | `postgres_v13` to `v16` recorded; a form publishes and answers |
| 3 | Upgrade from the previous release | **Pass** | Exactly four new steps apply; a restart repeats none; fresh and upgraded databases have identical columns and indexes |
| 4 | Older forms and responses, using data made by the previous release's own code | **Pass** | Forms, versions and responses byte-identical after upgrade; CSVs byte-identical; retry replays; `"yes "` keeps its old path |
| 5 | Older forms and responses, using sanitized production fixtures | **Blocked** | No such fixture exists in the repository. Needs a sanitized export of `forms`, `form_versions` and `responses` from production |
| 6 | Old frontend on new backend, before the fix | **Fail, reproduced** | 5 stuck cases: stamped `"yes "`, tab past the grace, tab using in-app navigation, a hidden choice changing a follow-up, a question after a hidden page |
| 7 | Holding publishes is enough | **Fail** | A tab open through the hold still reaches later versions by in-app navigation, or by the reload after the 24-hour grace. The hold is no longer required |
| 8 | Respondents never stuck on a required question their browser did not display | **Pass (local)** | With the compatibility fix, all 5 are accepted; a real `ba76f3f` frontend drove them. The rule matches the real old renderer on 3000 random forms |
| 9 | Conditional choices and attribution in the same matrix | **Pass, with limits** | Old frontend: a hidden choice is refused with a message saying why, and never stored. It is still offered, partner rules are not applied, and no attribution is recorded |
| 10 | Cached clients | **Pass (local)** | Behind a Vercel-like stand-in, the service worker is network-first and a reload runs new code. With the server down, no form can be submitted from the cache |
| 11 | Rollback rehearsal, respondents and authors | **Pass on a stand-in** | Disposable database built by the previous release, then this tree, with themes, groups, jumps, hidden choices, attribution and the policy. Limits are below |
| 12 | Rollback on a real staging copy | **Blocked** | Needs a non-production database copy and staging Render and Vercel deployments. `backend/.env` and `.env.meet-staging` were not opened |
| 13 | Rollout on real Render and Vercel | **Blocked** | Same environment. Locally, servers were swapped on one address; the real gap between the two deployments was not measured |
| 14 | Local suite and checks on the final tree | **Pass** | Results below |

### Exact checks run

```
git archive ba76f3f | tar -x -C <prev>
# DATABASE_URL: disposable PostgreSQL 17 on 127.0.0.1:54329; DATABASE_CA_CERT: its throwaway certificate
npm run test:postgres -- <CI's list, including forms-rollout-compat>   # 182 pass, 0 fail
npm run release-rehearsal -- --prev <prev>                             # 76 checks, 76 pass
npm run browser-check                                                  # exit 0, 992 layout checks, 84 steps
npm test                                                               # 350 tests, 343 pass, 0 fail, 7 PostgreSQL opt-in skipped
npm run check; npm run sync-shared -- --check; git diff --check        # pass
```

The rehearsal refuses any database that is not on this computer, and gives its servers no inherited environment. Before the fix, its rollout section gave 16 pass and 5 fail.

### Safe deploy order

1. Snapshot the database.
2. Deploy the **backend**. It applies `postgres_v13` to `v16` on start, all additive.
3. Deploy the **frontend** straight after. A hold on publishes is not needed for safety.
4. Confirm in the first responses that `evaluator` is being sent: new attribution appearing is the visible sign.
5. Keep the compatibility rule until old tabs are gone. See the removal gate below.

Between steps 2 and 3, and in tabs left open afterwards, older browsers are not stuck, but they offer hidden choices (refused if chosen), ignore partner rules and record no attribution. Expect those responses to have no attribution.

### Safe rollback order

**Prefer rolling forward.** A rollback changes what respondents are asked and what authors can keep, while a fix forward changes neither.

1. **Snapshot the database.** An edit that exists only in a draft is held nowhere else.
2. **Freeze authoring on the running release:** set `FORMS_AUTHORING_FREEZE=true` on the backend, restart, and confirm `/api/config` reports `formsAuthoringFrozen`, and that a save is refused with 423.
3. Roll back the **frontend first**. Old frontend on the new backend is the case the compatibility rule protects: hidden choices stay enforced and nothing is lost.
4. Roll back the **backend** only if it is the cause, straight after, and **only to the rollback build** on `codex/forms-rollback-e3b6b5d`, not to plain `e3b6b5d`. It starts frozen in production. In the reverse state, a new frontend on the old backend asks a stamped `"yes "` follow-up and then drops the answer.
5. **Do not reverse the migrations.** The previous backend runs on the upgraded schema, and the data in them survives for rolling forward.
6. **Never set `FORMS_AUTHORING_FREEZE=false` on the rollback build.** That is what lets a save strip settings for good.
7. **Recover by rolling forward:** deploy the release with the freeze off. Restore the snapshot only if the data itself is damaged, because that loses every response taken after it.

### While the previous backend runs

| Form uses | Respondents see | Stored | Do this |
|---|---|---|---|
| Hidden choices | All choices | **Hidden choices are stored**, and cannot be told apart later | Unpublish if a hidden choice must never be collected. Otherwise keep the backend newer |
| URL attribution | Partner rules ignored | **No attribution recorded.** Earlier values are kept but not shown | Unpublish if attribution matters, or accept the gap |
| Jumps and endings | Every question, and no custom ending | Answers on paths that used to be skipped | Unpublish if the extra required questions are a problem |
| Multi-question pages | Plain questions, no page title | Same keys, unaffected | Can stay published |
| Themes | Default look | Unaffected | Can stay published, if the look can wait |
| Evaluation policy | `"yes "` compared as typed | Follow-up not asked | Can stay published |
| Question media | Not shown; uploaded images have no route | Unaffected | Can stay published if the media isn't needed to answer |

**Authors, frozen without exception:** on plain `e3b6b5d`, with no freeze, a save succeeds and silently removes `logic`, `endings`, `choice_rules`, `url_params`, `theme`, `media`, `group`, `grouped` and `placeholder` from the draft. Rolling forward does not bring them back. A publish then makes a live version without them. Versions published before the rollback keep their settings, and those can be copied back by hand. Settings only in an unpublished draft are recoverable only from the snapshot.

**Rolling forward afterwards:** rehearsed. No migration repeats, attribution and reusable themes return, and forms nobody saved are unchanged. Responses from the rollback stay as written, and a version published during it stays without the settings.

### Staging preparation (6 November 2026)

Release branch: `codex/forms-release-staging`. **Stopped before any deployment. Production is unchanged**, and the next production step needs the owner's decision.

| Gate | Result | Evidence or what is missing |
|---|---|---|
| Production backend revision | **Pass: `e3b6b5d`** | Newest GitHub deployment record for `main - schedora-api`. Its asset route also lacks the `2f54fe7` response |
| Production frontend revision | **Pass: `e3b6b5d`** | Served `forms-logic`, `forms`, `forms-templates` and `forms-type-change` match that commit and no other in the last 40 |
| Differs from the rehearsal baseline, so rerun | **Pass** | Baseline was `ba76f3f`. Rerun from `e3b6b5d` on PostgreSQL in CI: 76 of 76 |
| Local diff reviewed | **Pass** | 39 files. Secret scan clean; no environment, key or database files |
| A push cannot deploy production | **Pass, by observation** | Pushing `2f54fe7`, and this branch four times, created previews and CI only: no Render deployment, and production files unchanged. Dashboard settings not seen |
| GitHub CI | **Pass** | `6acf5b0`: `verify` and `postgres` both succeeded. An earlier failure was the browser journeys sharing one rate limit, now fixed in the test script |
| Non-production Render and Vercel | **Blocked** | No account access here, and no staging service exists. Needs `schedora-api-staging`, and a `staging` branch whose `frontend/vercel.json` points at it (`docs/DEPLOYMENT.md`) |
| Disposable hosted database | **Blocked** | None provided |
| Approved, sanitized fixtures | **Blocked** | None exist, and no approval has been given |
| Snapshot, backend then frontend deploy | **Blocked** | Needs the above |
| Old open tab, conditional choices, attribution, publishing on staging | **Blocked** | Needs the above. Passes only on the rehearsal's local servers, against a real `e3b6b5d` frontend |
| Draft preservation during rollback on staging | **Blocked** | Needs the above. On the rehearsal, a save on the old backend removes settings, as expected |
| Author freeze before backend rollback | **Pass (CI)** | Superseded the earlier failure. See "Authoring freeze" |
| Production deployment | **Not attempted** | Out of scope |

**Pushing has a side effect:** each push creates Vercel previews on `schedora` and `schedora-frontend`, and previews forward `/api` to the production Render service (`docs/DEPLOYMENT.md`). So a form submitted on a preview of this branch would reach production. These previews were not opened. They shouldn't be used for testing.

**Also open:** PR #1 (`codex/meet-forms-media-session` to `main`) is still open. Merging it deploys `2f54fe7` to production without this release's compatibility rule, and `REHEARSAL_BASELINE` in `ci.yml` must follow production when it moves.

### Authoring freeze and rollback build (6 November 2026)

`codex/forms-rollback-e3b6b5d` is `e3b6b5d` plus the freeze and test-script fixes. The release carries the same freeze, off by default. Only the rollback build starts frozen, in production mode. It is refused in the service functions, so no route can go around it.

| Write | While frozen |
|---|---|
| Create, save, delete a form; routing; publish; unpublish | **423** |
| Create, edit, delete a reusable theme; upload an image (release only) | **423** |
| Publish check, reading, CSV export | Allowed: they change nothing |
| Public submissions | **Allowed** |
| Deleting a response | Allowed: a data request, not authoring |
| Deleting a workspace or an account | **Allowed, and it removes that workspace's forms.** Deliberate, not authoring, and not stopped |

`forms-freeze.test.mjs` fails if a new Forms write route is left unclassified. The route scan and the freeze tests run in both trees.

| Gate | Result | Evidence |
|---|---|---|
| Rollback build CI | **Pass** | `a412507`: `verify` and `postgres` |
| Release CI, including the rehearsal on PostgreSQL | **Pass** | `073cb70`: 143 of 143 |
| Direct API writes refused | **Pass** | On the frozen release, and on the rollback backend with both frontends |
| UI writes refused | **Pass** | Builder says so and disables Save and Publish. A forced Save and a publish sent from the signed-in page are refused. Creating from the dashboard creates nothing |
| Public submissions while frozen | **Pass** | Through the API and in the browser, on the frozen release and the rollback build |
| Drafts keep newer settings after rolling forward | **Pass** | Drafts, versions and themes byte-identical, including a never-published draft and an unpublished edit on a live form |
| Authoring resumes after rolling forward | **Pass** | Save at the same revision, then publish, with settings and the policy |
| Snapshot and recovery | **Pass** | A database copy restores the draft and answers a live form. It loses later responses, so rolling forward is preferred |
| Isolated Render and Vercel staging | **Blocked** | Do not exist yet |
| Frontend API destination | **Script ready, not run** | `npm run staging-preflight` uses GET only, and refuses a frontend whose API is not the staging backend. Tested against local servers |
| Snapshot, upgrade, mixed versions, freeze, rollback and recovery on staging | **Blocked** | Passes only in CI, on one machine with servers swapped |
| Production-data fixtures | **Open** | Synthetic data only. Open until an approved, sanitized export exists or the release owner waives this gate |
| Production deployment | **Not attempted** | |

Rehearsal data is synthetic, created by the code under test. The freeze flag needs a restart to change, so plan for that in a rollback. It was exercised with an explicit `FORMS_AUTHORING_FREEZE=true`; the rollback build's production default is covered by a config test, not a production-mode server.

### Separate operations during a freeze

Deleting a workspace and deleting an account are **separate operations from authoring, and stay available while Forms authoring is frozen**. This is deliberate: someone asking to remove their data should not have to wait for a release.

| Operation | Route | Confirmation still required | Effect on forms |
|---|---|---|---|
| Delete a workspace | `DELETE /api/workspaces/:ws` | The workspace name, typed, and the `workspace.delete` permission | Removes every form, version, draft and response in that workspace |
| Delete an account | `DELETE /api/me` | The password | Also removes any workspace that account alone owned, with its forms |
| Delete a Google-linked account | `POST /api/auth/google/delete-account` | A fresh Google reauthentication | Same |

**A freeze therefore does not preserve a draft in a workspace someone chooses to delete,** and a deleted workspace cannot be recovered by rolling forward. Only the snapshot holds it, and restoring that loses later responses for everyone. Other workspaces are not affected. Operators who need these held during a rollback must arrange that separately, by asking the people concerned.

### Staging rehearsal status (6 November 2026)

| Gate | Result | Evidence or what is missing |
|---|---|---|
| CI on `b54a99f` | **Pass** | `verify` and `postgres` green, rehearsal 143 of 143 |
| CI after the added checks | **Pass** | `cb46b55`: rehearsal 161 of 161, including deletion during a freeze and the rollback build in production mode with no freeze setting. Tests, scripts and docs only: no product code changed after `b54a99f` |
| Staging URLs and access | **Blocked** | No staging frontend or backend address was provided, and there is no Render or Vercel access from here. The documented name `schedora-api-staging.onrender.com` returns 404 |
| `npm run staging-preflight` against staging | **Blocked** | Needs the two addresses. Must exit 0 before any data is submitted |
| Render points at the disposable database | **Blocked** | Needs someone with Render dashboard access. It cannot be seen from outside |
| Snapshot on staging | **Blocked** | Needs the above |
| Backend-first rollout on staging | **Blocked** | Needs the above |
| Old-tab submissions on staging | **Blocked** | Needs the above |
| Author freeze on staging | **Blocked** | Needs the above |
| Rollback to `a412507` on staging | **Blocked** | Needs the above |
| Rollback build frozen in production mode, no override, on staging | **Blocked** | A production-mode server with no freeze setting passes in CI; not on a real Render service |
| Public submissions on the frozen rollback build, on staging | **Blocked** | Pass in CI |
| Newer draft settings survive recovery, on staging | **Blocked** | Pass in CI |
| Deletion documented as separate operations | **Pass** | This section. Tested on the release, and on `a412507` in the rehearsal |
| Production deployment | **Not attempted** | |

**Production-fixture gate, recorded separately: open.** No approved, sanitized export exists and no waiver has been given. All rehearsal data, in CI and on staging, is synthetic and does not count toward this gate.

No test data was submitted anywhere for these staging gates, and Vercel previews were not used.

### CI failure on `47d9617`, resolved

The PostgreSQL rehearsal failed intermittently with `timed out waiting for service worker page`. The cause was the test rig: it picked a port at random from 4000 to 4089, and Chrome refuses port 4045 as unsafe, so about 1 run in 90 could not load the page. A temporary CI probe reproduced it twice in 18 rounds, both times on `http://localhost:4045`. The rig now uses 4100 to 4189, which contains no such port. No product code was involved.

### Staging setup

Create new services only. Do not change `schedora-api`, `schedora` or `schedora-frontend`. Each staging service follows one dedicated branch, so moving between builds is a push to that branch, and only the freeze setting needs the dashboard.

**1. Render PostgreSQL:** New → Postgres. Name `schedora-staging-db`, region Singapore, Free plan is fine. Copy its **External Database URL**.

**2. Render web service:** New → Web Service, on this repository.

| Setting | Value |
|---|---|
| Name | `schedora-api-staging` |
| Branch | `staging/backend` |
| Root directory | `backend` |
| Build command | `npm ci --omit=dev && npm run check && npm run sync-shared -- --check` |
| Start command | `npm start` |
| Health check path | `/api/health` |
| Auto-deploy | On commit |

| Environment variable | Value |
|---|---|
| `RELEASE_ENVIRONMENT` | `staging` |
| `DATABASE_URL` | The External Database URL from step 1. **Never the Supabase one** |
| `NODE_ENV` | `production` |
| `NODE_VERSION` | `24` |
| `RELEASE_MODE` | `evaluation` |
| `HOST` | `0.0.0.0` |
| `SERVE_FRONTEND` | `false` |
| `TRUST_PROXY` | `true` |
| `TRUST_PROXY_HOPS` | `2` |
| `PRODUCT_DOMAIN` | `staging.invalid` (deliberately not a real domain, so links and redirects cannot lead to production) |
| `BASE_URL` | The Vercel staging address from step 3 |
| `ALLOWED_ORIGINS` | The same address |
| `BILLING_MODE` | `open` |
| `BILLING_PROVIDER` | `none` |
| `EMAIL_PROVIDER` | `outbox` |
| `SMS_PROVIDER` | `outbox` |
| `ALLOW_TEST_PAYMENTS` | `true` |
| `MEET_VIDEO_PROVIDER` | `none` |
| `MEET_VIDEO_ENABLED` | `false` |
| `APP_ENCRYPTION_KEY` | Generate a new value in Render. **Never copy production's** |
| `LOG_LEVEL` | `info` |
| `FORMS_AUTHORING_FREEZE` | `false` to begin with; the rehearsal says when to change it |

Do not set `COOKIE_DOMAIN`, and do not copy any provider keys from production: Google, Razorpay, LiveKit, email or AI.

The database connection always verifies TLS. If the service fails to start on a certificate error, send me the error. Do not turn verification off; `DATABASE_CA_CERT` is the supported setting.

**3. Vercel:** Add New → Project, on this repository.

| Setting | Value |
|---|---|
| Project name | `schedora-forms-staging` |
| Root directory | `frontend` |
| Framework preset | Other, with no build command |
| Production branch | `staging/frontend` (Settings → Git, after creating) |

Use the project's stable `*.vercel.app` production address, never a preview address. It must stay the same across the rollout so a tab left open is meaningful. The project's `/api` target is set by that branch's `vercel.json`, which I push once I know the Render address.

**What to send back:** the Render service URL, the Vercel production URL, confirmation that `DATABASE_URL` is `schedora-staging-db`, and how you want to handle the freeze setting at each pause. No passwords or connection strings: those stay in the dashboards.

### Staging rehearsal order

The staging services never hold the production database or secrets. Plain `e3b6b5d` cannot be identified by the preflight, because it has no `RELEASE_ENVIRONMENT` support. So the "previous release" here is `a412507` with the freeze off: `e3b6b5d` plus only the freeze, the deployment name and test fixes.

| Step | `staging/backend` and `staging/frontend` | `FORMS_AUTHORING_FREEZE` | Checks |
|---|---|---|---|
| 1 | `a412507`, empty database | `false` | `staging-preflight` must pass and the database be confirmed before anything else. Synthetic forms and responses |
| 2 | Snapshot | `false` | A copy of the database in Render, or `pg_dump` |
| 3 | Backend to the release, frontend still `a412507` | `false` | Upgrade; a tab left open; `"yes "`; conditional choices; attribution |
| 4 | Frontend to the release | `false` | Publishing; attribution; draft with newer settings |
| 5 | Freeze the release | `true` | Direct and UI writes refused; public submissions work |
| 6 | Backend and frontend to `a412507` | **Delete the variable** | Starts frozen with no override; public submissions; drafts intact |
| 7 | Backend and frontend to the release | `false` | Drafts identical; authoring resumes; attribution back |
| 8 | Restore the snapshot to a second database | | Recovery works on its own. Say if this needs a further database |

### Remaining before release

- [ ] Gate 5: sanitized fixtures from production, then rerun the older-form checks against them.
- [ ] Gates 12 and 13: rerun `release-rehearsal`'s scenarios on real staging, and measure the deployment gap.
- [x] GitHub CI passes on the pushed branch, including `forms-rollout-compat` and the rehearsal.
- [x] A real author freeze, tested in CI. See "Authoring freeze and rollback build".
- [ ] Decide whether deleting a workspace or an account should also be stopped during a freeze.
- [ ] Keep PR #1 open and unmerged. `e3b6b5d` is the baseline, and `REHEARSAL_ROLLBACK_BUILD` in `ci.yml` pins the rollback build.
- [x] Production's revision: `e3b6b5d`, not `ba76f3f`. Gates 3, 4 and 8 are rerun from it in CI's PostgreSQL job.
- [ ] Count how many production forms would be flagged for republishing, on the same fixtures.
- [ ] Removal gate: delete the compatibility rule (`olderClient`, `CLIENT_EVALUATOR`) once old tabs are gone, such as when requests without `evaluator` stop arriving. Those requests aren't counted anywhere yet, and a scripted API client without the marker is also treated as an older browser.

## Current source map

- Implementation history: RESEARCH_IMPLEMENTATION.md; current scope: FEATURE_PRIORITIES.md.
- Strategy/positioning: SUITE_STRATEGY_2026_10_27.md; research methods/metrics: UX_RESEARCH_PLAN.md.
- Proposal: PRICING_PROPOSAL.md. Enquiry contract: ENQUIRY_TRAIL_CONTRACT.md.
- Operations: EMAIL.md, product/video runbooks and backend/scripts/production-check.mjs.
- External evidence log: C:/Users/Nxtwave/Documents/ChatGPT/schedora/reports/Schedora-recurring-progress.md.

The original reconciliation added no feature or provider evidence; subsequent dated increments and the current monitoring row record later verified work. They do not establish customer validation or complete production readiness.

## 30 October readiness evidence correction (local increment)

An active Google/Zoom/Microsoft connection does not prove that a meeting link can be created for a new booking. The saved-event readiness assessment now labels that outcome Not verified and states when creation is requested. It does not create a test meeting, alter permissions, disable sharing or call a provider. Focused tests cover all three integrations and retain existing disconnected/team-host behavior. Deployment of this later increment is separate from ba76f3f and must be recorded before claiming it is live.

## 30 October team setup increment (local, release pending)

The [team readiness contract](TEAM_READINESS_CONTRACT.md) is implemented with a browser-session-only, event-authorized read-only endpoint, explicit coarse projections and a collapsed editor breakdown. Owners/admins see assigned current-host setup summaries, co-hosts see only themselves, and former-host setup is hidden. Calendar contents/accounts/credentials/errors are excluded. Stored connection/sync evidence is separate from provider creation or future availability. Shared policy and actual booking schedule fallback avoid divergent definitions. A saved-settings signature plus request ordering guard rejects stale UI results.

Membership regression: new slot assignment and overrides now exclude former workspace members, including group-seat reuse; round robin retains active hosts. Existing appointments are not silently canceled. Local full suite227 tests:222 pass,5 optional PostgreSQL skips; focused readiness18 passed before the later membership test addition; dedicated host suite4 pass. Browser fixture passed784 layout checks with keyboard disclosure, role downgrade, unavailable summary and no side effects;375/1280 screenshots reviewed. Final exact-commit CI, provider deployment and health must be recorded before treating this increment as released. Real-provider/human gates remain open.


## Forms history increment — 28 October 2026

Commit a6d0fc8 fixes per-form history coverage and tied-arrival paging. Branch CI 40683016103 succeeded for its exact SHA, including PostgreSQL and Linux browser. Local tests: 211 total, 207 pass, four PostgreSQL skips locally; browser: 744 layout checks. Follow-ups are selected by loaded response/authorized linked-booking ids, not the latest 200 workspace records. Paging stays usable under an empty attention filter and announces its result. No schema migration or provider change. This closes the per-form cap engineering gap; large-history latency and human validation remain open. The release checkpoint records whether this increment has reached production; the earlier 328ed25 matrix evidence remains historical.


## Calendar evidence increment — 28 October 2026 (branch verification)

The current increment adds a separate successful calendar-sync timestamp and fixes the live onboarding feed field/first-sync failure behavior. See CALENDAR_SYNC_EVIDENCE.md for its API, migration and rollback contract. Local regression and responsive checks pass; PostgreSQL upgrade/CI and production remain gates until their checkpoints are inspected. This addresses own-host successful-sync evidence, not the team-host readiness endpoint, real-provider or human-validation requirements.
