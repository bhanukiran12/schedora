# Working-tree triage (Phase 0), 13 November 2026

Read-only inspection of the uncommitted checkout on `codex/public-site-demo`. Nothing was staged, committed, reset or discarded. This file and `docs/FORMS_SHEETS_AUDIT.md` are the only files added.

## Where the checkout sits

| Ref | Commit | Note |
|---|---|---|
| `HEAD` (`codex/public-site-demo`) | `989cda5` | Same as `origin/main`. **Render auto-deploys `main`**, so anything merged to `main` from here goes to production. |
| `origin/main` | `989cda5` | |
| local `main` | `ba76f3f` (29 Oct) | Stale; not used for anything. Fast-forward it when convenient. |
| `origin/codex/aws-deploy-pipeline` | `80ea741` | Built on `989cda5`. Already holds `ci.yml`, AWS infra and AWS docs (see "Deployment" group). |

Working tree: 65 modified tracked files (+2,546 / −881) and 27 untracked files.

## Sensitive-file check

| Item | Result |
|---|---|
| `backend/.env`, `backend/.env.meet-staging` | Ignored by `.gitignore` (`.env`, `.env.*`), not tracked, excluded from Docker builds by `.dockerignore`. |
| `infra/aws/livekit-staging/generated/` (staging LiveKit credentials) | Ignored by the new `.gitignore` line; excluded from Docker builds. Contents not opened. |
| `infra/aws/*.json`, `*.yaml` | No secrets. They contain the AWS **account ID** in ARNs. That is an identifier, not a credential, and the same files are already pushed on `codex/aws-deploy-pipeline`. |
| `docs/Schedora_Product_Guide_and_QA.docx` (21 KB) | Binary duplicate of `PRODUCT_GUIDE_AND_QA.md`. Not opened for secrets beyond its Markdown twin. Owner's call whether binaries belong in git. |
| Hard-coded keys, tokens, passwords | None found in the diff or untracked files. Tests use obvious fixtures (`'s'.repeat(40)`). |

## Changes by area

### A. Shared sign-in and local development domain (complete, tested)

`backend/src/platform/auth.mjs`, `google-signin.mjs`, `sso.mjs`, `config.mjs`, `app.mjs`, the auth part of `api.mjs`; `frontend/js/context.mjs`, `core.mjs` (session-expired event); tests `shared-auth`, `product-context`, untracked `local-cookie-domain.test.mjs`, `frontend-session-expiry.test.mjs`.

Moves local development to `*.schedora.localhost` so one cookie covers every product host; clears legacy host-only cookies; `loadSession` picks the newest valid token when a browser sends two. `/api/me` clears a dead cookie. Production behaviour changes only through `clearSessionCookies` sending one extra expired host-only cookie when `COOKIE_DOMAIN` is set.

### B. Billing and Meet video credits (complete, tested, **commercial change**)

`backend/src/billing/plans.mjs`, `video/config.mjs`, `credits.mjs`, `recharge.mjs`, `rooms.mjs`; `frontend/js/pricing-proposal*.mjs`; tests `meet-credits`, `meet-recharge`, `meet-video`, `video-pilot`, `pricing-proposal`, `billing`; docs `PRICING_PROPOSAL`, `PRICING_WORKSHEET`, `VIDEO_RECHARGE_PRICING`, `MEET_VIDEO`, `RAZORPAY_SUBSCRIPTIONS`, `MEET_RELEASE`, `FEATURE_PRIORITIES`.

- 1 credit changes from 1 to **5 participant-minutes** (`UNITS_PER_CREDIT` 60 → 300). Stored units are unchanged, so existing lots keep their seconds but display 5× fewer credits.
- Plan allowances: Meet 200 → 100, Suite 600 → 100 credits; production now has default allowances instead of none.
- Real packs are buyable only when priced exactly ₹2 per credit.
- Self-hosted LiveKit pilot allowed only for the exact staging origins.

### C. Forms: response validation, quiz modes, builder copy (complete, tested; one rollback risk)

`backend/src/shared/forms-logic.mjs` + synced `frontend/shared/forms-logic.mjs`, `forms/service.mjs`, `forms/definition-io.mjs`; `frontend/js/forms.mjs` (builder parts), `forms-picker.mjs`, `forms-type-change.mjs`, `forms-icons.mjs`; `forms.test.mjs`; `docs/FORMS_PRODUCT_CHECKLIST.md`.

- `answer_rule` (min/max characters or selections, custom message), enforced on the server.
- Form `mode`: universal, lead qualification, knowledge quiz (correct answers scored server-side, stripped from the public definition), match quiz starters.
- Create form now makes a blank draft directly; the template gallery is gone from the UI. `forms-templates.mjs` is now only imported by tests.
- Builder relabelled (Questions / Design / Logic / Settings / Share); Preview moved to the toolbar; Import JSON added to More actions.
- Correction to the audit: **response validation is partially built here** (length and selection counts; no number range or pattern yet).

### D. Sheets prototype (incomplete)

Untracked `backend/migrations/019_form_workbooks.sql`, `backend/src/forms/workbooks.mjs`, `frontend/js/sheet-formulas.mjs`, `workbook-merge.mjs`, `workbook-tabs.mjs`, `backend/test/forms-workbooks.test.mjs`; workbook routes in `api.mjs`; `/sheets/:id` in `web.mjs`, `app.js`, `context.mjs`; `responseWorkbook` and the workbook UI in `forms.mjs`.

Incomplete or wrong today:

1. **Failing test**: `forms-freeze.test.mjs` does not classify `PUT /forms/:id/workbook`. Owner decision (13 Nov): Sheets editing stays open during a freeze → add it to the test's allowed list with a reason.
2. The linked "Form Responses" tab gives formulas only the **first 49 responses and 12 columns** (`linkedResponseCells`). Formulas over a larger form return wrong totals with no warning.
3. Linked cells hold formatted display text (dates as locale strings), not raw values.
4. Migration 019 is a new table. Rolling the app back leaves it unused, which is harmless.

### E. Product shell, workspace overview, Meet / Flow / onboarding / account UI (complete per earlier browser passes; needs re-run)

`frontend/js/shell.mjs`, `products.mjs`, untracked `workspace-overview.mjs`, `meet.mjs`, `meet-team.mjs`, `meet-video.mjs`, `onboarding.mjs`, `account.mjs`, `settings.mjs`, `flow.mjs`, `ecosystem.mjs`, `studio.mjs`, `product-landing.mjs`, `app.js` (overview route, saved theme), `index.html`; CSS `app.css`, `product-shell.css`, `design.css`, `suite-theme.css`; `/overview` page in `web.mjs`.

The four CSS files mix rules for every product (≈900 changed lines). Splitting them by product hunk-by-hunk is error-prone, so they stay with this group.

### F. Deployment (complete; **production-affecting**)

`.github/workflows/ci.yml`, `.gitignore`, untracked `Dockerfile`, `.dockerignore`, `infra/aws/*`, `docs/AWS_DEPLOYMENT.md`, `AWS_LIVEKIT_STAGING.md`, `RENDER_DOCKER_DEPLOYMENT.md`, `render.yaml`, `backend/scripts/browser-check.mjs`.

- `ci.yml`, `AWS_*.md`, `SchedoraRuntimeBoundary.json`, `schedora-ecr.yaml` are byte-identical to `origin/codex/aws-deploy-pipeline`. `SchedoraDeployPolicy.json` differs only in line endings. `livekit-staging.yaml` (+16/−6), `schedora-web.yaml` (+2/−5), `browser-check.mjs` and `PROJECT_CHECKPOINTS.md` are newer locally; `schedora-web-staging.yaml` exists only locally.
- `render.yaml` switches production from the Node runtime to **Docker**, serves the frontend from Render (`SERVE_FRONTEND=true`) and changes `TRUST_PROXY_HOPS` 2 → 1. Merged to `main`, this changes production hosting on the next auto-deploy and assumes traffic no longer passes through Vercel.

### G. Documentation

`README.md`, `RELEASE_ACCEPTANCE.md`, untracked `PROJECT_CHECKPOINTS.md`, `PRODUCT_DESIGN_PRINCIPLES.md`, `PRODUCT_GUIDE_AND_QA.md` (+ `.docx`), `PRODUCTION_ARCHITECTURE_AUDIT.md`, `MEET_PRODUCTION_READINESS_PLAN.md`, `FORMS_SHEETS_AUDIT.md`, this file.

## Files touched by more than one group

| File | Groups | How to split |
|---|---|---|
| `backend/src/api.mjs` | A (cookies), D (workbook routes) | Patch-level split |
| `frontend/js/forms.mjs` | C (builder), D (workbook view, sort), E (overview) | Patch-level split; D and the sort button share hunks in `responses()` |
| `frontend/app.js` | D (`/sheets`), E (`/overview`, theme) | Patch-level split |
| `backend/src/web.mjs` | D, E | Two one-line hunks |
| `frontend/js/context.mjs` | A, D | Patch-level split |
| `render.yaml` | B (allowance comment), F | Keep whole in F |

Patch-level splitting is done with `git diff` → edited patch → `git apply --cached`; interactive `git add -p` is not available in this environment.

## Conflicts and risks

1. **Production deploy coupling**: `HEAD == origin/main` and Render auto-deploys `main`. Group F changes hosting; group B changes customer-visible credit maths. Neither should reach `main` without a planned cutover.
2. **Rollback leak of quiz answers**: once a knowledge-quiz version with `correct: true` is published, rolling back to `989cda5` serves the stored definition unchanged (the old `publicDefinition` does not strip `correct`/`points`), exposing answer keys to respondents. Rollback must first unpublish quiz forms, the same pattern as respondent sign-in.
3. **Rollback drops validation**: older servers ignore `answer_rule`, so published limits stop being enforced after a rollback (no data loss).
4. **Credit display**: any credit lots already in the production database would show 5× fewer credits after group B. Production video is off, so lots are expected to be zero. Verify with a read-only count before release.
5. **Sheets prototype** issues D1–D3 above.
6. The AWS branch and this checkout both carry `ci.yml` and infra. Committing group F here *and* merging that branch later must resolve to the newer local copies.

## Baseline results (this checkout, 13 Nov)

| Check | Result |
|---|---|
| `npm test` | 410 tests: **402 pass, 1 fail, 7 skipped**. Failure: `forms-freeze.test.mjs` "every Forms write route is classified" (D1). |
| `npm run check` | Pass (209 files) |
| `npm run sync-shared -- --check` | Pass |
| `npm run test:postgres` | **Not run.** Needs `DATABASE_URL` from the private `.env`, which points at the shared database. Run against a disposable PostgreSQL or in CI. |
| `npm run browser-check` (local Chrome, own temporary app) | **71 pass, 16 fail**; 1,040 layout checks at 320/375/768/1280 px, light and dark. The checkpoint recorded 17 failures. |

### Failing browser journeys

Causes marked *likely* were read from the test and the code, not debugged.

| Journey | Area | Classification |
|---|---|---|
| Forms templates: goal starting points | Forms | **Outdated test.** Expects the 11-card template picker that group C removed on purpose. The setup journey (line ~2811) has the same expectation. |
| Contact Info page: picker, outline, keyboard… | Forms | **Outdated test.** Waits for "Contact Info page added"; the label is now "Contact details". |
| Enquiries: one list across products | Forms/shell | *Likely* outdated test. Looks for a sidebar link to `/enquiries`; the Forms sidebar now links `/enquiries?from=response`. |
| contact form acceptance (… keyboard respondent …) | Forms | **Real layout regression.** On a phone the question canvas starts 345 px down (limit 340). *Likely* the new mode picker above the outline. Steps after it in this journey did not run. |
| Meet navigation on mobile: drawer sections missing | Meet/shell | *Likely* real or outdated: the new shell renders a different drawer. Needs a look. |
| host sees booking and email delivery | Meet | Copy check failed ("delivery levels not explained"). |
| Meet readiness; Team host setup | Meet | Event-type editor did not reach the expected render state. |
| video room, video prejoin, video pilot, video credits calculator | Meet video | Room/prejoin timeouts; calculator submit button selector missing (*likely* the credits UI change in group B). |
| live calendar setup; persisted live onboarding | Setup | Onboarding step flow changed (new Review step). |
| billing test checkout; proposed pricing prototype | Billing | Pricing label text changed in group B ("Pricing research prototype"); test expects the old label order. |

Phase 1 gate: the Forms layout regression must be fixed, and the three outdated Forms tests updated to the intended behaviour, so the builder journeys run end to end before undo/redo is added on top.

## Commits made (branch `codex/worktree-checkpoint`, from `989cda5`)

Approved 13 November. The order differs from the first proposal: the shell commit comes before Forms, so `forms.mjs` needs only one intermediate version. Mixed files were committed in intermediate versions built from HEAD plus the relevant changes, written straight to the index; the working tree was never rewritten.

| # | Commit | Groups | Mixed files committed in parts |
|---|---|---|---|
| 1 | Share sign-in across local product hosts and clear stale session cookies | A | `api.mjs`, `app.js`, `context.mjs`, `product-context.test.mjs` |
| 2 | Price Meet video credits at five participant-minutes and apply approved allowances | B (+ `meet-video.mjs` whole, whose credit UI depends on it) | — |
| 3 | Add the workspace overview and refresh the product shell | E (CSS includes Forms/Sheets styles) | `app.js`, `context.mjs`, `web.mjs` |
| 4 | Add Forms response validation and quiz modes | C (+ `browser-check.mjs` whole, + rollback note in `FORMS.md`) | `forms.mjs` |
| 5 | Add the form-linked Sheets prototype (not for customer use) | D | completes the mixed files |
| 6 | Package the app as one Docker service for Render and AWS (do not merge to main) | F | — |
| 7 | Record the Forms and Sheets audit, checkpoints and product guide | G | — |
