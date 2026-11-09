# Forms: reliability and Meet handoff

Updated 26 October 2026. Scope: the standalone Forms journey (create → edit → preview → publish → submit → receipt → review/export) and the optional handoff from an accepted response to a Meet booking page. Forms works without Meet or Flow.

Verification level: local automated tests and headless-browser journeys against SQLite. Nothing here has been verified in a deployed environment or against PostgreSQL (opt-in tests exist; see "Checks").

## 1. Contracts

### Draft, save and publish

- The draft (questions **and** routing) is separate from the live form. Saving never changes what respondents see; publishing creates an immutable version that holds both the questions and the routing.
- Saving is explicit (no autosave). The builder shows *Unsaved changes*, *Saving…*, *All changes saved*, *Not saved*, or *Not saved: changed elsewhere*. It also shows *Saved draft not yet published* next to *Live · version N*, or *Not published* / *Closed · not collecting*.
- Concurrency uses `forms.draft_revision`. Each save sends `base_revision`. A save or publish based on an older revision returns `409 draft_conflict` with the current form. The editor keeps the person's edits and offers two choices: load the latest, or save over it, which names the revision being replaced. If a save actually went through but its reply was lost, the retry comes back as a conflict containing the same draft; the builder treats that as saved.
- Publishing validates the definition and the routing against the questions being published. Routing must use existing questions and options, and booking destinations must be published event types in the same workspace with an active Meet or Suite plan. Any problem blocks publishing and is listed.
- Question keys used by any published version are read-only in the builder. New questions and options get random keys, so a key is never reused for something else.
- *Stop collecting* (unpublish) closes the form: the public link returns `410 form_closed`. Responses are kept. A form that was never published returns 404.

### Version policy for in-flight respondents

The browser submits the version it was shown. The server validates and stores the answers against that version, never the newer one:

| Situation | Result |
| --- | --- |
| Version is the live one | Accepted against it |
| Version was replaced less than 24 h ago (`VERSION_GRACE_MS`) and the form is still collecting | Accepted against the old version; stored with `form_version` = old version, and its routing applies |
| Older than that, or unknown | `409 form_version_changed`; nothing stored. The page reloads the new version, keeps answers to questions whose keys still exist, and asks the person to review and submit again |
| No version sent (older clients, API) | Treated as the live version |

The inbox, response detail and CSV show each answer with the labels of the version it answered.

### Submission

1. Every attempt from a page carries one `submission_id`, kept in `sessionStorage` until the server accepts it, so it survives a reload.
2. One transaction:
   - Checks for an accepted response with that id. If one exists, it returns that response (`200`, `replay: true`), even after republishing or closing. `answers_changed` says whether this retry's answers differ; the first accepted answers stand.
   - Otherwise it checks open/closed and the version, then validates the visible questions. Answers to hidden questions are discarded.
   - Then it checks the Forms entitlement, consumes one response unit, and inserts the response with its answer hash, the `forms.response.created` outbox event (ids only) and, when routing chooses a booking page, the handoff.
3. The receipt is shown only after a `2xx`. It shows a reference (the first 8 hex characters of the response id) and the time.
4. A timeout (20 s), network error or `5xx` is reported as *not confirmed*. The answers stay on the page, and *Submit again* reuses the same id. A `4xx` from the submission endpoint means nothing was stored for that id, and the message says so. The exception is `429 rate_limited`, which happens before the request is processed, so the page does not claim anything about an earlier attempt.
5. Preview runs only in the browser. It never calls the server and creates no response, event or usage.

### Quota

The existing approved quota (`QUOTAS.responses`, enforced only in `billingMode=enforced`) is consumed in the submission transaction. SQLite takes `BEGIN IMMEDIATE`; PostgreSQL holds the global transaction advisory lock, so concurrent submissions cannot overspend. A replay consumes nothing. Deleting a response or a form does not restore usage. When the allowance is used up, `GET /api/public/forms/{slug}` reports `availability: capacity_reached` and the page says so before anyone starts. A submission that loses the race gets `429 quota_exceeded`, and the page says the response was not saved. No new prices, plans or entitlements were added.

### Routing and the Meet handoff

- Rules are checked in the order shown and the **first match** decides. If no rule matches, the fallback applies; with neither, the respondent sees only the receipt.
- An action can show a message, show a link (*Continue*), or offer a booking page.
- Booking offers:
  - The response is accepted first. The receipt says **"Response received — choose a time"** and states that nothing has been booked yet.
  - The link is `/meet/{workspace}/{event}?handoff={token}`. The token is 24 random bytes; only its SHA-256 is stored in `form_handoffs`, and it expires after 2 hours (`HANDOFF_TTL_MS`). No name, email or answer appears in the URL.
  - The booking page removes the token from the address bar and fetches only the name, the email, and answers to questions that booking page itself asks.
  - Pre-existing booking links that still carry `?name=&email=&a_*` parameters keep working; the app no longer creates them.
- **"You are scheduled"** comes only from Meet's booking response. The handoff is marked `booked` in the same transaction as the booking. Booking retries with the same `Idempotency-Key` return the same booking. A second booking through the same handoff gets `409 handoff_used`, and after booking the token reveals only that a booking exists.
- Failures never touch the accepted response:

  | Situation | What happens |
  | --- | --- |
  | Destination unpublished, deleted, or Meet plan inactive when the response is accepted | Handoff recorded as `unavailable`; the receipt shows the fallback message or link, or says the team can follow up |
  | Plan revoked later | The booking is refused (`402`) and the handoff stays `offered` |
  | Slot taken | Fresh times are shown; the handoff stays `offered` |
  | Link expired | The handoff page stops booking; the API returns `410 handoff_expired`. The response is kept |
  | Invalid token or wrong destination | The API returns `404 handoff_not_found`; no booking or quota is created |
  | Already used token, including after expiry | The API returns `409 handoff_used`; use the booking confirmation's management links |
  | Respondent never books | The response is unaffected |

- The inbox **Next step** column reads booking state from Meet, following reschedules: offered, unavailable, confirmed (with reference), pending payment, canceled or removed. The CSV has a *Next step* column.
- Flow is not involved. Flow still receives `forms.response.created` as before.

### Response operations

- Listing, detail and CSV require `responses.read`; deletion requires `responses.delete` (owners and admins). Permission is checked on every request, including each export. Other workspaces get 404.
- The CSV:
  - Columns: response id, UTC time, form version and next step, then every question from any version, latest first.
  - Cells are always quoted, and formulas (`= + - @`, tab, CR) are neutralized in answers and labels.
  - Unicode and line breaks are preserved, and the file starts with a BOM.
- The export button downloads the file in the page; on failure it shows a retry and never downloads an error page as a CSV.
- The delete dialog explains that deletion is permanent, removes the response from future exports (downloaded files are unchanged), does not restore the allowance, and does not cancel a booking.

## 2. Other changes

- The Forms demo's *Open live product* link now goes to `/forms`; Flow's goes to `/flow`.
- The "service unreachable" page no longer says "No booking has been submitted" on every product. It names the product and says "Nothing has been submitted from this page", without guessing a cause.
- The renderer:
  - When a page has several errors, it shows a focused error summary with links to each field. Each error is tied to its field through `aria-describedby`.
  - It ignores a second submit while one is in flight.
  - It keeps every answer after any failure.
- The builder:
  - Reorder and remove buttons keep keyboard focus on the moved item and announce the move.
  - The mobile Edit/Preview tabs support arrow keys.
  - Routing rules can be reordered with buttons, and values for choice questions are picked from their options.

## 3. Migration and configuration

- `backend/migrations/006_forms_reliability.sql` (SQLite) is additive:
  - `forms.draft_revision`, `form_versions.routing` and `responses.request_hash`.
  - A new `form_handoffs` table.
  - It copies each form's current routing into its live version, so routing behaviour does not change at deploy time.
- PostgreSQL: the `postgres_v5_forms_reliability` upgrade step (`src/postgres.mjs`, `src/postgres-sql.mjs`) adds the same columns with `ADD COLUMN IF NOT EXISTS`, copies routing, and creates `form_handoffs`. It runs once inside the startup migration transaction.
- No new environment variables. The grace window and handoff lifetime are constants in `src/forms/service.mjs`.

## 4. Rollout

1. Back up the database (`npm run backup`, or a PostgreSQL snapshot).
2. Deploy the backend; migrations run at startup. Then deploy the frontend. Run `npm run sync-shared -- --check` first; the shared logic file is unchanged in this milestone.
3. Smoke test on staging:
   - Create a form, save, publish and submit.
   - Republish with a changed option and submit from a tab opened before the republish.
   - Export the CSV.
   - Add a booking rule, republish, submit, choose a time, and confirm the inbox shows *Booking confirmed*.
4. Old cached clients that omit a version are treated as live for compatibility. This does **not** guarantee that answers from an old page match the current schema. Avoid publishing schema changes during rollout, invalidate stale frontend caches, and verify old-tab behavior before resuming edits. Old booking links with query parameters still pre-fill; newly generated links use opaque tokens.

## 5. Rollback

- The schema change is additive, and the previous release ignores the new columns and table, so no down-migration is needed. Leave migration 006 applied.
Before rolling back to code that reads `forms.routing` live:

1. Stop collection and creator writes at the application/ingress level without changing publication pointers. Drain in-flight requests. Do not run old and new backend versions concurrently during this procedure.
2. Take and verify a complete database backup, including unpublished draft routing. Keep it private. The next step replaces the draft routing copy; the backup is needed to recover it later.
3. In a database transaction, restore the compatibility routing column from each form's published snapshot:

```sql
BEGIN;
UPDATE forms SET routing = (
  SELECT routing FROM form_versions
  WHERE form_versions.form_id = forms.id
    AND form_versions.version = forms.published_version
);
COMMIT;
```

4. Verify that each collecting form's `forms.routing` equals its published snapshot (including null), then switch to the previous backend/frontend together. Smoke-test routing before reopening traffic. If any check fails, remain in maintenance and restore the backup or roll forward.

- After this prepared rollback:
  - Routing again uses the old live-on-save behavior, but unpublished routing is not inadvertently activated by the rollback itself. Keep creator editing disabled until rolling forward if publication isolation is required.
  - Handoff links reach the booking page without pre-fill.
  - Responses accepted for an older version keep their recorded version.
- Prefer rolling forward. The previous release cannot enforce opaque-token handoff guarantees. Disable public booking during rollback if those guarantees are required. When returning to this release, inspect and explicitly restore desired unpublished routing from the backup through the normal draft-save process; do not restore the whole old database over newer responses. Verify revisions, published snapshots and handoff behavior before reopening traffic.

## 6. Checks (this checkout)

Review follow-up, 26 October 2026:

- Latest full local suite: 127 tests, 124 passed, 0 failed, 3 PostgreSQL integration tests skipped.
- Syntax check: 108 files passed. Shared Forms logic is synchronized. `git diff --check` passed.
- Browser journey suite: 44 steps and 376 layout checks across 320/375/768/1280 px, light and dark themes; no reported runtime errors, overflow or failed journeys. Includes used/invalid handoff pages refusing further booking. This remains local SQLite with test providers, not deployed verification or a screen-reader audit.
- Regression coverage includes rejecting expired, invalid, empty, null, wrong-destination and previously used handoff tokens; used tokens remain refused after expiry. Booking retries retain `handoff_linked: true`. Direct booking without a handoff still works.
- PostgreSQL integration was attempted with the configured private environment. Authentication was rejected (`28P01`); subsequent connections hit a temporary authentication circuit breaker. No PostgreSQL behavior or migration is verified by that attempt, and no more remote attempts were made. Correct the credentials privately and allow the provider's block to clear before using the preflight runner. No deployment, commit or push was performed.
- The new runner's missing/invalid-configuration tests pass without starting the integration suite or printing the connection URL.

The table below records the earlier implementation author's checks before this follow-up; its counts are historical.

| Check | Result |
| --- | --- |
| `npm run check` | Pass (105 files) |
| `npm run sync-shared -- --check` | Pass |
| `npm test` | 125 tests: 122 pass, 0 fail, 3 skipped (opt-in PostgreSQL). Before this milestone: 110 tests, 108 pass, 2 skipped. The count includes 3 tests in `test/meet-livekit-sdk.test.mjs`, an untracked file that appeared during this work and is not part of it |
| New tests | `test/forms-reliability.test.mjs` (10 tests), `test/postgres.test.mjs` (+2: upgrade SQL; opt-in PostgreSQL quota/retry concurrency). Updated: `forms.test.mjs` (closed form is 410), `meet-platform.test.mjs` (routing applies after republish; handoff instead of personal data in the URL) |
| `npm run browser-check` | Pass: 43 steps and 360 layout checks at 320/375/768/1280 px. New Forms journeys: save states, a no-op preview, keyboard reorder with focus, one panel at a time on mobile, save conflict, a lost reply then retry (exactly one response), error summary focus, inbox detail, export, and routing through the Meet handoff to a confirmed booking |

**Not verified:**

- PostgreSQL. From `backend`, run `node --env-file=.env --disable-warning=ExperimentalWarning scripts/test-postgres.mjs` (or `npm run test:postgres` when credentials are already in the environment). This first migrates and removes one randomly named temporary test schema. A failed preflight stops before launching the suite, avoiding repeated authentication failures. Never paste credentials into logs or command arguments.
- A deployed environment, embedded forms in third-party sites, real email delivery for bookings made through a handoff, and screen-reader behaviour with real assistive technology. Only DOM focus and ARIA wiring were checked, not a WCAG audit.
- Dark mode on product pages: the existing product theme renders light under a dark preference, as it did before this milestone.

## 7. Known limits and next steps

- The 24 h version grace and 2 h handoff lifetime are fixed constants, not workspace settings.
- Expired, invalid, unavailable and used handoffs no longer silently fall back to ordinary booking. Direct public booking without a handoff remains possible; this is not a universal person/email duplicate-booking restriction. A lost or rotated token requires returning to the response receipt or contacting the team.
- Role granularity is unchanged: members can read and export every form's responses, as before. Response-reviewer and editor roles from the strategy need an authorization decision first.
- Not built in this milestone: templates, the shared status queue, email receipts, branch tester, uploads, payments and AI.
- **Legacy text comparison:** fixed for new publishes by the evaluation policy (see "Evaluation policy"). Versions published before it keep their behaviour: `"yes "` does not show a question ruled on `yes`, yet counts as `yes` for the ending.


## Per-form follow-up history and response paging (28 October 2026 increment)

`GET /api/workspaces/:ws/forms/:id/responses` preserves `form`, `versions` and `responses`, and adds `next` plus `followups: { runs, tasks, bookings, now }`. Follow-ups are selected from the returned response ids and only linked bookings visible to the actor, using the same authorization rules as workspace Enquiries. They are not limited to the newest 200 workspace runs/tasks. The `bookings` array contains only visible id/reference pairs needed to join that history. A missing evidence payload is shown as unavailable, never as proof that no flow ran.

`next` is a timestamp/id cursor, ordered by `created_at DESC, id DESC`, so tied arrival times cannot skip responses. Pass it unchanged as `before`; an old numeric timestamp remains an exclusive timestamp cursor for compatibility. Default page size is 50, maximum 200. A null `next` means the current traversal is complete; this is not a live-update subscription or a snapshot against concurrent edits/deletions.

The inbox accumulates page-scoped history without duplicating shared booking runs, retains Load older responses under an empty attention filter, prevents simultaneous loads, announces results and preserves keyboard focus. No schema, response quota, retention, publication, delivery or entitlement change is introduced. Large-history latency and human task completion remain unmeasured.


## Sharing, templates and readable logic (30 October 2026 increment)

Scope: owner-reported confusion that sharing and response retrieval were "unclear or failing", treated as a problem to reproduce. Evidence classes are kept separate below. Nothing was committed, pushed or deployed; no production data was written.

### What was reproduced

| Check | Before | Evidence |
| --- | --- | --- |
| Storage path: create → publish → anonymous respondent (separate browser context) → receipt → host inbox → reload → CSV | **Worked.** One response stored in the form's workspace at `form_version` 1, visible after reload, exported | Local scratch journey and existing API tests |
| Production routing of the respondent URL | `https://forms.schedora.in/f/<slug>` serves the app; `/api/public/forms/<slug>` returns a JSON 404 for an unknown slug on both the apex and `forms.` hosts | Read-only GET probes with a made-up slug, 30 October. No form was created or submitted in production |
| Draft link | A draft showed a read-only full URL ("Link once published"). Anyone given it saw "This form is not available" | Builder screenshot, draft state |
| Link after publishing | At 1280 px the link was 1334 px down the page and focus went to a notice without the link. At 375 px it was inside a collapsed "Sharing · Ready" disclosure | Measured with `getBoundingClientRect`; screenshots |
| Publish button | Stayed the primary action when nothing had changed | Screenshot |

Conclusion: the reproduced failure is comprehension and findability, not storage. Production submission and PostgreSQL storage of this journey were **not** exercised, because that would create production data.

### Changes

- **Share with respondents panel** (builder, directly under the actions).
  - Live: *Respondent link* with **Copy link** and **Open live form**; **Email the link**, a `mailto:` draft in the creator's own mail app (the page says Schedora does not send it); **Share…** only where the browser supports a native share sheet; conversational link and embed code in a disclosure. It states that the editor needs a sign-in and that Preview saves nothing.
  - Draft: "Not public yet", no link or copyable field, with *Publish form* and *Preview first*.
  - Closed: the link tells visitors the form is closed; *Publish again* reopens it.
- **Honest copy feedback** inline (`role="status"`): "copied … nothing has been sent" only after the clipboard accepts the text; otherwise the field is selected with Ctrl+C/⌘C guidance. Sharing creates no email, response or event (the browser check asserts the email table is unchanged).
- **URL construction:** on the production domain the respondent link always uses the Forms host (`productOrigin('forms')`); elsewhere it uses the current origin. Loopback, private-network, `.local` and `.localhost` links carry a warning that respondents elsewhere cannot open them.
- After publishing, focus moves to the share heading and the link is in view at 320, 375, 768 and 1280 px. Readiness's Sharing area points to the panel (*Go to Share with respondents*) instead of holding a second copy of the link.
- Publish reads *Publish form*, *Publish changes* or *Publish again*, and is the primary button only when there is something to publish. *Responses (N)* shows the stored count.
- **Responses page:** the context line names the workspace and the live, closed or unpublished state, so a host looking in another workspace notices. The empty state shows the respondent link with copy when live, or explains why nothing can arrive and links to the builder.
- **Templates:** the gallery groups *For sales and client meetings* (Blank, Sales discovery, Demo request, Client onboarding, Client review) above *More starting points* (the existing four; ids and the onboarding default are unchanged). Cards show audience, purpose, question count, presentation, a logic sentence and a sketch of the first questions. **Preview** opens a modal running the real renderer in preview mode (no server call, no draft). **Create draft** still creates an unpublished draft. New templates use only supported fields and operators, ask for one email at most, include no marketing consent and preselect nothing (unit-tested). The onboarding template warns against pasting passwords.
- **Builder:** **Duplicate** on each question gives new question and option keys, moves focus to the copy and announces it. The question key moved into a *Question key* disclosure that explains its purpose; locked-key behaviour is unchanged. The Required checkbox says what it means.
- **Readable logic:** `conditionSentence()` in `frontend/js/forms-readiness.mjs` turns each supported condition into plain words using the creator's labels. It appears under each display rule, on each routing rule ("Checked only if no earlier rule matched"), for the fallback, and in readiness's After submission area. It states exact semantics: multiple-choice `equals` means "the only choice", `not_equals` includes unanswered, text `contains` ignores capitalisation, single-choice `contains` names every option whose key matches, and empty values and missing questions or options are named ("this rule cannot match"). A unit test pins every phrase to `conditionHolds` outcomes. Routing explains that the first match wins and that hidden answers count as unanswered; the server routes on validated answers with hidden ones discarded (`decideNextStep`). The evaluator, validator, publish checks and server enforcement are unchanged.

Unchanged: explicit save, revision conflicts, version pinning, idempotent submission, receipts only after a `2xx`, quota and entitlement checks, permissions, workspace isolation and CSV protections. No schema, migration, environment, billing, entitlement, video/recharge flag or deployment setting changed.

### Checks (local, first pass; final results are under the follow-up below)

- `npm test`: 229 tests, 224 pass, 0 fail, 5 PostgreSQL skipped (baseline before this work: 227, 222, 0, 5). Forms test files 32/32; `forms-readiness` 13/13 after the last wording change.
- `npm run check` (153 files), `npm run sync-shared -- --check` and `git diff --check` pass.
- `npm run browser-check`: every journey passes with no runtime errors or overflow; layout-check count is in the implementation log. New assertions: no draft link; focus and link visibility at four widths after publishing; copy success or honest failure, and a forced failure that selects the link; mail-draft wording and no email sent; nine templates with the five featured in order; template preview focus, Escape returning focus, and no form created; logic sentence following label edits; uniquely keyed duplicate; routing sentence, fallback and first-match text.
- Screenshots reviewed at 375 and 1280 px (light): draft and live share panel, copy-failure state, gallery, template preview dialog and routing sentences. The product theme is pinned light; no dark-design claim.

### Not verified

Production submission and storage, and PostgreSQL behaviour, for this journey; real clipboard and native share sheets on physical devices; real mail clients opening the `mailto:` draft; screen readers; human comprehension of the panel, templates or logic sentences.

### Form editor layout (5 November, local only)

The editor shows one surface at a time, chosen in the top bar, without changing the address or the unsaved draft: **Content** (toolbar above a framed canvas, with a question outline and an inspector beside them), **Workflow** (the logic map), **Settings** (form details, presentation, next step after submitting) and **Share** (respondent link and readiness). Publishing lands on Share with focus on its heading. The workspace sidebar and footer step aside inside the editor; the *Forms* breadcrumb returns to them. Draft and publish states, explicit save and conflict handling are unchanged.

- **Toolbar:** Add content, Design, device view, Edit/Preview, more actions. Device view reshapes the canvas and the preview. Preview is a separate run in the real renderer that stores nothing.
- **Outline:** colour-coded type badges, drag handles on hover or focus, and a separate Endings card. From 901 to 1180 px it collapses to badges, keeping names for assistive technology. At 900 px and below it is a scrolling strip, the panes stack, and reordering uses the move buttons.
- **Canvas:** wording is edited in place in a frame with the respondent's proportions; its text scales with the frame. The answer area is a sample, not an input.
- **Inspector:** Question and Answer start open. Media and Logic stay one line until used. A section stays as the author left it.

### Design and themes (5 November, local only)

**Design** opens a panel beside the canvas with **My themes** (*Create theme*, then Apply, Edit, Duplicate, Delete per card) and a **Gallery** of eight Schedora presets (Apply, Copy to My themes per card). A theme sets typography and the background, question text, answer text, button and button text colours. A weak colour pair is named in the editor (under 4.5:1) and does not block saving. Themes are separate from form templates, which hold questions.

**A form holds its own copy.** Applying a theme copies its values into `definition.theme`. Publishing freezes that copy in the version, like every other part of the definition, so:

- Editing or deleting a reusable theme changes no saved or published form. A draft using an older copy says so and offers *Apply again*.
- Edits show at once on the draft's canvas and preview. Respondents see them only after a publish. Each version keeps the look it was published with.
- The public payload omits `theme.source`.

Only a named font stack and `#rrggbb` colours are accepted, by the shared validator on save, on publish and again before the page uses them. So a theme cannot carry CSS or a URL, and no font is loaded from elsewhere. Reusable themes live in `form_themes` (workspace-scoped, `forms.manage`, 50 per workspace, `409 theme_conflict` on a stale edit), via `/api/workspaces/:ws/form-themes`. Migration `016_form_themes.sql` and `postgres_v15_form_themes` are additive.

### Typography (7 November, local only)

**Default scale.** One stylesheet block (`app.css`, "Form typography") sets every size for the published form, the builder's Preview, template previews and embeds. Sizes follow the width the form is given, through a container query on the element `renderForm` draws into, so the phone-sized Preview shows exactly what a phone shows. Earlier, Preview's phone frame used desktop sizes and a 26px title of its own.

| Text | Classic, desktop | Classic, phone | Conversational, desktop | Conversational, phone |
|---|---|---|---|---|
| Form title | 40px, 650 | 28px | 40px | 28px |
| Form description | 17px, muted | 16px | 17px | 16px |
| Page title | 24px, 600 | 21px | 24px | 21px |
| Question title | 18px, 600 | 17px | 30px, 600 | 22px |
| Description | 15px, muted, 1.55 line height | 15px | 18px | 15px |
| Answer | 16px | 16px | 22px | 18px |
| Choice | 16px, 400 | 16px | 19px | 16px |
| Button | 16px, 600 | 16px | 17px | 17px |
| Space between questions | 32px | 26px | one per screen | one per screen |

Conversational sizes scale between the phone and desktop values with the form's width.

**Controls.** A theme now holds three optional text sizes besides its font: `question_size`, `description_size` and `answer_size`, each `small` (×0.875), `medium` (Standard) or `large` (×1.15). The same steps scale the canvas, Preview and the published form, in both layouts. Answers never drop below 16px on a phone, where smaller text makes the browser zoom into the field. The theme editor has Font family and the three sizes. The Design panel also shows them for the draft's own copy of its theme: a change there affects this draft only, not the saved workspace theme, and reaches respondents only when published. A draft with no theme starts from the **default style** (Clean sans, Standard sizes). Changing its font or sizes stores a typography-only theme on that draft, `{ name: "Default style", font, …sizes }` with no colours, so the default colours and dark mode are unchanged. No workspace theme is created, and *Reset typography* (or choosing the default values again) removes it so the draft is exactly as before. Typography-only themes are accepted only on a form; a workspace theme still needs every colour.

**Compatibility.** Standard is never stored, so a theme or form nobody resized keeps exactly the JSON it had. Sizes are validated by the shared validator; the previous release ignores them, so a rolled-back server shows standard sizes and drops them on the next save. The previous release refuses a typography-only theme (it requires colours): after a rollback such a form shows the default style, and its draft cannot be saved until the typography is reset. Authoring is frozen on the rollback build in any case. No font family was added: the previous release refuses an unknown font and would drop the whole theme on rollback.

### Description limits (7 November, local only)

| Description | Before | Now | Where |
|---|---|---|---|
| Form description | 2,000 | **2,000, unchanged** | `definition.description` |
| Page description (multi-question page) | 500 | **3,000** | `help` on a grouped `page_break` |
| Question description | 500 | **3,000** | `help` on a question |

The limits are one shared constant, `DESCRIPTION_LIMITS`, used by the server, the builder's `maxlength` and its character counts. Titles (150), question labels (300), placeholders (100) and every answer limit are unchanged. Onboarding's quick form now uses the same 2,000-character form description limit (it was capped at 500 in its own field).

- **Line breaks** typed into a description are kept: the builder no longer blocks Enter in descriptions (titles stay one line), the server keeps inner line breaks, and the form shows them.
- **Character counts** sit under each description, linked to it, and are announced only from 90% of the limit.
- **Long descriptions** (over 280 characters or three line breaks) open folded, to six lines in Classic, five in Classic on a phone and four in Conversational, with *Show full description*. The button names the text it controls and states whether it is open; the whole text stays in the page for assistive technology, and an opened description stays open while the respondent answers. Text that fits is not folded.
- **Rollback:** the previous release refuses page or question descriptions over 500 characters when a draft is saved or published. It validates only on save and publish, so forms already published are still served as stored, with their long descriptions.

### Release notes: typography and description limits

Branch `codex/forms-typography`, on top of `1bbb67e`. Production has run `1bbb67e` since 7 November (Render deployment at 10:13 UTC). That deployment came from a push to `main` that was not part of this change, so "the previous release" above means `1bbb67e`.

- **No migration and no environment change.** Stored forms, versions and workspace themes are untouched. Standard sizes are never written.
- **Deploy the backend before the frontend.** A new frontend on the old backend would let authors save a typography-only draft or a description over 500 characters, and the old backend refuses both with a 400. A tab opened earlier, running the old frontend against the new backend, keeps the old 500-character limits and shows typography-only forms in the default style. It loses nothing.
- **What respondents see:** the new default type scale applies to every form, already-published ones included, as soon as the frontend is deployed. Their stored definitions do not change.
- **Rollback:** the rollback build is `1bbb67e` with `FORMS_AUTHORING_FREEZE=true`. **Keep authoring frozen on it:** it cannot save descriptions over 500 characters or typography-only drafts, and it drops text sizes from any theme it saves. Published versions are served as stored, with long descriptions shown in full and typography-only forms in the default style. Roll forward to restore everything.
- **Release rehearsal:** CI still rehearses the upgrade from `e3b6b5d`, with rollback to `a412507` (`REHEARSAL_BASELINE` in `ci.yml`). It does not yet rehearse `1bbb67e` to this branch. Moving the baseline means rewriting the rehearsal's checks, which assume a backend that predates themes, so it is a separate task before this branch is released.

### Multi-question pages and Contact Info (5 November, local only)

A page stays flat in the definition: a titled page break (`grouped: true`, `label`, optional `help`) followed directly by questions carrying `group: <its id>`. Every question therefore keeps its own key, answer, CSV column, Flow placeholder and logic. The page title is never an answer or a column. Existing page breaks, forms and published versions are unchanged, and no group key is stored on them.

- **Add content** offers **Contact Info** (First name, Last name, Phone number, Email, Company; first name and email start required) and **Page of questions**. Preset keys are readable and never reuse one the draft or any published version already uses: with an `email` in use it becomes `email_2`. A question added while a page or one of its questions is selected joins that page. An optional `placeholder` is kept per text question.
- **Builder:** the page is a collapsible row with its questions indented, lettered A, B, C under its number. The canvas shows the whole page; focusing a question selects it without moving the cursor, and the inspector shows that question's settings. The move buttons reorder within a page and move a question out at either end; a page moves whole, and a question outside moves past a page, not into it. Drag can also drop a question into a page. Removing a page asks first.
- **Respondent:** conversational mode shows a whole page on one screen; classic gives it its own page, and questions after it do not join it. Enter validates the visible questions and focuses the first invalid one (in conversational mode the error list is shown but focus goes to the question).
- **Logic:** a jump can target the page or a question on it, and a question on a page can jump onward. A hidden page hides only its own questions. Skipped questions are not required and their answers are discarded on submit.
- Contacts and booking handoffs take the name from `first_name`/`last_name` when there is no `name` question.

**Rollback:** the previous backend strips `theme`, `group` and `grouped` from a saved draft and shows such pages as ordinary questions. Do not roll back while forms use them.

### Workflow: the logic map (5 November, local only)

**Workflow** lists every question, page and ending in order, draws each jump beside the list (dashed when conditional, solid when always taken) and writes each one in words under its question, which is the accessible version. Below 900 px only the words show. Anything no rule or next-question step leads to is marked *No path leads here*. Selecting an item opens the same jump editor as the Content inspector, so there is one set of rules and one selection. "Reached" considers jumps and order; a display rule can still hide an item on a path. Scoring, tagging, outcome quiz, variables and URL parameters are not built, and no placeholder for them is shown.

### Jumps and endings (5 November, local only)

Optional definition keys, stored only when not empty, so a form without logic keeps its exact JSON:

- `logic: [{ field, rules: [{ when?, to: { type: 'field' | 'group' | 'ending', id } }] }]`. `when` uses the display-rule operators, or `{ all: [...] }` / `{ any: [...] }` of them (API and templates only; the editor keeps such a rule as written). A rule with no `when` always matches and must be last. `group` targets a page break, so groups are pages for now.
- `endings: [{ id, title, message? }]`, up to 20. The first is the default.

Semantics, all in `walkForm` in the shared Forms logic, which preview, the public form and server validation use alike:

- A question's rules are checked once it is shown, and the first match decides.
- Jumps only go forward, so every path ends. Typeform's reference also allows going back to a visited question; that is not built.
- Skipped questions are not required and their answers are discarded on submit. A respondent who changes an earlier answer keeps the abandoned answers on the page in case they switch back, but the server never stores them.
- A jump to an ending stops the form there.
- The server returns the ending with the receipt, worked out from the accepted answers of the version answered, so a retry after a republish shows the same ending.
- Post-submit routing and the Meet handoff are unchanged and independent. When a booking is offered, its heading stays and the ending appears under it.
- The receipt reference always shows with an ending.

A builder edit that invalidates a jump (a moved or deleted question, option or ending) removes that rule, with an announcement and a toast. Readiness reports jump forms as *not verified* for reachability, because its checker does not follow jumps yet.

Respondent changes in the same pass:

- Enter advances from the current answers, even when an answer redraws the form.
- In one-question-at-a-time mode, letter keys choose options, Shift+Enter makes a new line in long text, and a pointer pick on a single choice moves on after 300 ms. Arrow keys never advance. The last question always waits for Submit. These details are assumptions from general knowledge of the product; no fetched Typeform document confirmed them.
- Classic Next and Back now move focus to the new page.
- *Restart preview* keeps images.

No schema migration or environment change. **Rollback:** the previous backend ignores `logic`, so a published form with jumps would demand the skipped required questions. Unpublish or remove jumps from such forms before rolling back.

**Before quizzes:** the public payload includes the whole definition, so scoring and correct answers must not be added to it as they stand, or respondents could read them.

### Hiding answer choices (6 November, local only)

**Workflow → Logic** lets an author hide one or more choices of a standalone choice question, based on an answer to an earlier question. Typeform's behaviour was verified by the product owner beforehand; these are the Schedora rules built from it:

- `choice_rules: [{ field, rules: [{ when: { field, op, value? }, hide: [option keys] }] }]`, stored only when used, so a form without rules keeps its exact JSON. Conditions use the display-rule operators and stable keys, one condition per rule. Every rule that holds adds to what is hidden. Up to 20 rules per question.
- **Inputs:** only earlier questions, never the question itself. Variables and scores are unsupported, as in Typeform. Typeform's URL parameter input is deferred until Schedora has URL parameters.
- **Grouped pages:** a question inside a multi-question page cannot hide choices, as in Typeform. A question on such a page can be the *input* to a rule on a standalone question. A plain page break is not a multi-question page, and in classic presentation a rule can act on a question on the same page, which updates as answers change.
- **A selected choice that becomes hidden** is removed from the active answer and never stored. It does not come back by itself if the choice is shown again, unlike an answer on an abandoned jump path, which is kept in case the respondent switches back: a silently restored choice could be submitted unnoticed. If a required question is left empty, it asks again.
- **All choices hidden:** the question is skipped even when required, its response stays blank, its outgoing jumps do not run, and later rules read it as unanswered.
- **One evaluator:** `walkForm` in the shared Forms logic, used by preview, the public form and validation of the submitted version. Later display rules, jumps and hide rules read the answer without its hidden choices. A crafted request gets the same result: a hidden choice is dropped, refused if that leaves a required question empty, and cannot trigger a jump, an ending or post-submit routing.
- **Text on these forms is compared as it would be stored** (spacing tidied, email lower-cased), in the browser and on the server, so `" VIP "` cannot slip past a rule for `VIP`. The evaluation policy later extended this to every newly published version.

**Conflicts:** moving a rule-bearing question onto a multi-question page, moving its input after it, or removing a choice or question a rule uses keeps the rule, tells the author (toast, announcement, beside the question and on the map) and refuses publishing. The draft can still be saved, so the work is not lost; a conflicting rule does nothing in preview. *Publish check*, *Publish* and readiness all report it. Jumps differ: a jump a builder edit invalidates is removed, which remains right for rules with nowhere to go, whereas a hide rule usually needs only a small repair. Deleting the question that holds the rules removes them with it. Changing the type of a question a rule reads follows the same blocks as display rules.

Readiness reports these forms as *not verified* for reachability, because its checker does not follow them yet. The map writes the rules in words; they change what a question offers, not where it leads, so they are not drawn as arcs.

No schema migration or environment change. **Deployment order:** backend first. An older frontend on the new backend still shows hidden choices, and the server then drops them. **Rollback:** the previous backend strips `choice_rules` from drafts on save and ignores them on published versions, so hidden choices would be offered and stored again. Unpublish such forms before rolling back.

**Evidence (6 November, final code, local data only):** `npm test`: 317 tests, 310 pass, 0 fail, 7 skipped (the opt-in PostgreSQL tests). `npm run check`, `sync-shared --check` and `git diff --check` pass. `npm run browser-check`: exit 0, 952 layout checks at 320/375/768/1280 px in both colour preferences, no runtime errors. Its new journey authors rules in Workflow, tries them in preview, moves a question onto a page by drag, removes a choice, is refused at Publish both times, repairs, publishes, answers with Back and a changed answer (single, multi-select and full hiding), posts crafted requests, then checks the database, inbox and CSV, and Enter on a classic page. Breaking the evaluator or the publish check on purpose made `forms-choice-rules.test.mjs` fail each time.

**Not verified:** PostgreSQL (the new test file is in CI's PostgreSQL job, which must pass before release) and any deployed environment. The rule editor's focus after each change was checked, but it was not driven by real key presses or a screen reader.

### Evaluation policy (6 November, local only)

Every newly published version records `evaluation_policy: "normalized_v1"` in its stored definition. **A version without it keeps the behaviour it was published with.** Nothing rewrites a published version or a response.

With the policy, an answer and the value a rule compares it with both go through the question type's own clean-up in `checkAnswer`, in the shared `walkForm` and `answerConditionHolds`. So `"yes "` matches a rule for `yes` in display rules, jumps, hide-choice rules, endings and post-submit routing alike.

| Question type | Compared as |
|---|---|
| Short text, phone, date | Spacing collapsed and trimmed |
| Long text | Trimmed; line breaks kept |
| Email | Trimmed and lower-cased |
| Single and multiple choice | Option keys, unchanged |

- **Rule values are cleaned too, when compared.** Otherwise a rule for `Foo@Example.com` could never match a lower-cased email in the new version. A value that isn't a valid answer of its type, such as part of an email in an *includes* rule, is only tidied. The stored rule is not changed.
- **Unchanged:** capitals are still significant for `is` on text, and `includes` still ignores them. URL parameters keep their own clean-up and limits. Booking questions are outside this policy.
- **Versions from before the policy:** a form without hide rules compares answers as typed. A form with hide rules compares tidied answers with rule values as written. Both are kept exactly.
- **Drafts do not hold the policy.** Publishing stamps it, and an API request cannot set or remove it. *Unpublished changes* ignores the stamp. Builder and template previews stamp a copy to show what the next publish will do, and readiness checks reachability the same way.
- **Adopting it:** a live version from before the policy is flagged only if it has a rule comparing typed text, the only case where a result can change. The builder then explains this in Preview and readiness, and Publish works without an edit. Others adopt the policy at their next publish.
- **Responses on the old version:** a page opened on an old version keeps using it, and the server judges it by the submitted version during the existing 24-hour grace. Retries and receipts use the version answered.

**Rollout:** a tab opened before this logic cannot be updated and can still load new versions, so holding publishes is not enough. See "Rollout and rollback". **Rollback:** the previous backend ignores the key, so versions with the policy go back to legacy comparison, with no data change.

**Evidence (6 November, final code, local SQLite only):** `npm test`: 346 tests, 339 pass, 0 fail, 7 skipped (the opt-in PostgreSQL tests). `forms-evaluation-policy.test.mjs` covers forms with and without hide rules and URL parameters. `npm run check`, `sync-shared --check` and `git diff --check` pass. `npm run browser-check`: exit 0, 992 layout checks, no runtime errors. Its new journey tries `"yes "` in preview, on the public form and against the server, on an old version, on a new version and on a page left open across a republish. "Old versions" in these tests are real publishes with the stamp removed from the stored row, not data from a real earlier release. Breaking stamping, old-version behaviour, new-version clean-up, rule-value clean-up, routing or the unpublished-changes check on purpose made the tests fail; one routing break first survived, so the test was strengthened.

**Not verified:** PostgreSQL, rollout compatibility and rollback, all open on the release checklist in `docs/RELEASE_ACCEPTANCE.md`.

### Rollout and rollback (6 November, local only)

A real old frontend on the new backend got stuck: the server demanded a question the browser had not displayed, the old code had no page to show it on, and the person saw no message. A hold on publishes did not prevent it, because a tab open through the hold reaches later versions by in-app navigation, or by the reload after the 24-hour grace. Old tabs can't be patched, so the fix is on the server, with a smaller one in the browser:

- **Marker:** current browsers send `evaluator: 2` (`CLIENT_EVALUATOR`) with a submission.
- **A request without it** is treated as an older browser. An error on a question that browser did not display is waived, using `olderClientFieldIds`, which models the old walk: answers as typed, display rules and plain page breaks only. It matches the real previous renderer on 3000 random forms. An invalid leftover answer on such a question is not stored.
- **Not relaxed:** questions it did display, answer validation, and hidden choices, which are still refused or dropped, now with a message saying why. Someone crafting a request could omit the marker to skip a follow-up the old walk would not show, but required questions are not a security control and could be answered with anything anyway.
- **New browser, older server:** if the server wants a question this path skipped, as a previous backend does for a jump, the browser shows it at the end. An error naming nothing in the form shows a message rather than nothing.

`npm run release-rehearsal` runs the previous release and this tree as real servers on a disposable local PostgreSQL. Results, the deploy and rollback order, and what must be frozen are in `docs/RELEASE_ACCEPTANCE.md`.

### URL parameters (6 November, local only)

**Workflow → URL parameters** lets an author declare named parameters, such as `utm_source`, and copy an example link. **Preview** takes sample values and records nothing.

- **Schema:** `url_params: [{ key, record? }]`, stored only when used, up to 20. Names are lowercase letters, numbers and underscores, starting with a letter. `mode`, `embed` and `product` are refused because form links already use them. A rule reads a parameter as `{ param, op, value? }`, never as `field`, so a parameter is not an answer and may share a question's name without crossover.
- **What can read them:** jumps and hide-choice rules. Display rules and post-submit routing stay on answers in this slice. Variables, scoring, calculations and quizzes are out of scope.
- **One evaluator:** `walkForm` cleans parameters itself, in preview, on the public form and in validation against the submitted version, so nothing undeclared can reach a rule by any route. A respondent on an earlier version is judged by that version's declarations.

| Value | Result |
|---|---|
| Missing | `is` and `includes` are false, `is not` and `is not answered` are true |
| Empty, or only spaces | Same as missing |
| Repeated name | The first occurrence counts, even if it is empty |
| Over 200 characters | Same as missing. It is never shortened, since a shortened value could match a rule the full one does not |
| Control characters | Same as missing |
| Not text (a crafted request) | Same as missing. It is not an error, because a respondent should not be blocked over a link |
| Undeclared name, or different case | Ignored |
| Spacing | Tidied, in link values and in rule values when saved. Case is kept: `is` is exact, `includes` ignores case, as for other text rules |

**Untrusted input.** Anyone can edit a link, and the server can only judge what a request claims. So the server enforces a rule given the value sent, but someone can drop `utm_source=partner` and see the default choices. A hidden choice is about relevance, never access control, and the builder says so. Parameters never reach contacts, booking handoffs, Flow, webhooks, routing or authorization: only `answers` does. The values are only ever shown as escaped text, and CSV cells are neutralised against formulas.

**Attribution.** An author opts in per parameter with *Record with each response*. Only those values are stored, in `responses.attribution`, apart from `answers`. Other parameters are used for rules, then discarded. The inbox and CSV label them `Attribution: key`, in the last columns, and the response detail shows them under their own heading as unverified. A form that records nothing keeps its exact CSV columns. A later version that stops recording keeps earlier values, which go when the response goes, under the same retention and deletion. Retention, deletion and the answers hash are otherwise unchanged. A retry replays the first response: its parameters overwrite nothing.

**Choices made for this slice:**

- A parameter a rule reads cannot be removed until the rule changes, so nothing disappears as a side effect. There is no rename: add the new name, repoint the rules, remove the old one.
- An unsent value is not kept, so a retry works out its ending from the parameters it sends, which come from the same link. A crafted retry could only change the ending shown to itself.
- Meeting rooms pass no parameters, so rules see them as missing. The embed code does not pass on the parent page's parameters; add them to the embed address.

**Deployment:** migration `017_response_attribution.sql` and `postgres_v16_response_attribution` add one nullable column, with existing rows left as NULL. Deploy the backend before the frontend. An older frontend sends no parameters, so rules see them as missing and attribution is not recorded until it updates. **Rollback:** the column is additive and can stay, but the previous backend strips `url_params` and treats `{ param }` conditions as unmatched, so unpublish forms using them first.

**Evidence (6 November, final code, local SQLite only):** `npm test`: 328 tests, 321 pass, 0 fail, 7 skipped (the opt-in PostgreSQL tests). `npm run check`, `sync-shared --check` and `git diff --check` pass. `npm run browser-check`: exit 0, 984 layout checks at 320/375/768/1280 px in both colour preferences, no runtime errors. Its new journey declares parameters, hides a choice with `utm_source=partner`, adds a jump, tries both in preview, publishes, then checks the partner, default, empty, duplicate, oversized and undeclared links, crafted requests, a markup value, the database, inbox and CSV. That run found a real bug, since fixed: the first receipt worked out its ending without the parameters. Breaking opt-in, the size limit, the evaluator, server validation or the separation from answers on purpose made `forms-url-params.test.mjs` fail each time.

**Not verified:** PostgreSQL and frontend/backend rollout, both open on the release checklist in `docs/RELEASE_ACCEPTANCE.md`. The clipboard outcome was checked only as a reported status. The rule editor was not driven by real key presses or a screen reader.

### Comparison with Typeform's Contact Info editor (5 November)

Reference captures are normalised to CSS pixels. `…-1280.jpg` is a 1280×900 viewport scaled by 0.889 on a wider canvas (its panels start at y=50, and 50/0.889 = 56, the top edge the unscaled 1024 capture shows directly). `…-1440.jpg` is cropped to 907 px at about 1.018 scale, so nothing to the right of the canvas's start is comparable at 1440. `…-1024.jpg` shows Typeform's mobile canvas, compared with Schedora's mobile device view. These are JPEGs, some scaled, so read figures as about ±2 px. No Typeform asset or wording was copied.

| Measure (CSS px) | Typeform | Schedora now |
| --- | --- | --- |
| Top bar height | 56 | 56 |
| Toolbar height, 1280 | about 49 | 49 |
| Toolbar x range, 1280 | 288–992 | 288–992 |
| Rail expanded / at 1024 | 256 / 91 | 256 / 91 |
| Inspector width | 256 | 256 |
| Canvas frame, 1280 | x 299, y 301, 681×385 | x 299, y 307, 682×384 |
| Mobile canvas frame, 1024 | x 221, y 129, 415×734 | x 222, y 130, 415×738 |
| Question title x, 1280 | about 401 | 401 |
| Field right edge, 1280 | about 880 | about 880 |
| Rail row pitch | about 52 | 52 |
| Panel / selected row / frame colour | about #f7f7f7 / #eee / #f9f9f9 | #f7f7f7 / #eee / #f9f9f9 |

**Remaining differences, not built:** Typeform's Connect tab, mode selector, welcome screen, AI box, Text/Video switch, comments, accessibility, translation and settings toolbar icons, inspector panel toggle and phone-country picker. **Deliberate:** Schedora's purple primary and accents against its near-black, a thin purple edge on the selected row, a chevron on the page row where it has a menu, draft and save states where it has Share and View plans, numbered question badges, a visible OK sample on the canvas, and a single question vertically centred in the frame. **Unknown:** the width at which Typeform's rail collapses and whether its 1024 mobile view is automatic; Schedora collapses at 1180 px and stays in desktop view until asked. No reference exists for Typeform's Design panel or Logic map, so those were built from the owner's description and are not compared.

### Evidence (5 November, final code)

- `npm test`: 298 tests, 291 pass, 0 fail, 7 skipped (the opt-in PostgreSQL tests). `npm run check`, `sync-shared --check` and `git diff --check` pass.
- `npm run browser-check`: exit 0, 928 layout checks at 320/375/768/1280 px in both colour preferences, no runtime errors. Journeys added, on disposable local data:
  - **Contact form:** add from the picker by keyboard; move, duplicate and delete with focus checked; endings and a jump; preview at both sizes; publish; submit with real key events including a wrong email, Back, a letter-key choice and a changed path; stored response, inbox and CSV.
  - **Themes:** create a theme, every colour and font reaching the canvas; contrast warning; desktop and mobile device views and preview; preview stores nothing; publish; public page shows the theme; a saved draft with another theme and an edit to the reusable theme each leave the public page identical, computed style by computed style; a themed response is stored once.
  - **Contact Info page:** picker, keys, per-question selection and required setting, keyboard reorder within and out of the page, page moved whole, keyboard collapse, whole page on one screen, focus on the first invalid question then the remaining one, Back keeps every value, preview stores nothing, publish, inbox and CSV; a respondent changing an earlier answer to jump past the page with an abandoned answer unsaved; another jumping straight into the page.
  - **Workflow:** existing jumps drawn and written, unreached item reported, add, retarget and remove from the map with focus kept, the same rule visible in Content, saved and not published.
- This work found and fixed: a stale drag test; a nested-redraw exception from the new Enter handling; a phone layout viewport widened by a hidden heading, which the old overflow check could not see; a themed title in the wrong colour; focus lost when My themes finished loading; `$$` collapsed to `$` by a patch script in code Chrome does not run; and an existing test race where the background worker fetched a fixture's `example.com` calendar address and overwrote its status.
- One earlier full run failed in a cascade of signed-out steps; its log was lost to truncation and the cause was not established. It has not recurred.

**Not verified:** PostgreSQL, including `postgres_v15_form_themes`: the only configured database is production. `forms-jumps`, `forms-themes` and `forms-groups` are now in CI's PostgreSQL job, which must pass before release. Also any deployed environment, real touch devices, browsers other than headless Chrome (including the fallback for browsers without `field-sizing`), screen readers and human usability.

### Media: scoped, not implemented

The current schema has no media fields. Typeform's official help documents video by link only (YouTube, Vimeo, VideoAsk, Pexels), no autoplay for added video, and image alt text of up to 125 characters with a decorative option. The smallest useful scope here is an optional per-question `media` object: `{ type: 'image', url, alt (≤125), decorative }` or `{ type: 'video', provider: 'youtube' | 'vimeo', id }`. The video id would be parsed from an allow-listed URL into a fixed `youtube-nocookie.com` or `player.vimeo.com` embed. It would accept no HTML, render in fixed aspect-ratio boxes (no layout shift), never autoplay, and fall back to text if loading fails.

**Blocked on an owner decision.** The deployed `/f/` CSP (`frontend/vercel.json`, `backend/src/web.mjs`) allows only `img-src 'self' data:` and no frames, so either feature needs a CSP change, which is a deployment setting this task must not change. External images and embeds also disclose respondents' IP addresses to those hosts, which needs a privacy-notice decision. Uploads additionally need authorised storage, type and size limits, retention rules and cost approval. Nothing was added.

### Integrations audit (no code change)

| Handoff | State | Evidence |
| --- | --- | --- |
| Forms → Meet booking offer | Works; opaque 2-hour handoff token; booked only on Meet's confirmation | Local and CI tests; no real-provider or human verification |
| Forms → Flow (`forms.response.created` → one task or one email) | Works locally; the per-response trail shows actual runs and tasks | Email delivery: production reports the local outbox, so no delivery claim |
| Signed webhooks with `forms.response.created` | Admins can configure them; each delivery attempt is recorded | A saved endpoint is not a delivery; use `webhook_deliveries` |
| Connector gallery (Sheets, Slack, CRM…) | None exists; none added | — |

Recommended next integration slice: a read-only *Connected to this form* list in the builder. It would show Flow flows triggered by responses (draft, enabled or paused) with their latest actual run outcome, and, for admins, webhook endpoints with their last delivery status. *Configured* stays separate from *last run succeeded*, *last run failed* and *never run*. It needs only existing APIs and permissions. Before any new connector, document its customer job, OAuth scopes, credential storage, retry and idempotency model, cost and observable outcome. Ordinary form links do not embed Forms inside Zoom or Google Meet; the in-room offer is the separate MVS session-offer contract.

## Builder navigation and question types (30 October 2026 follow-up)

### Review of the sharing increment

The increment above was re-read against its contract before extending it. One concrete defect was fixed: on a closed form, *Publish again* in the share panel was a second primary button beside the header's primary Publish button; it is now secondary. Removing a question already deleted display rules that depended on it; that behaviour is kept, but the announcement now says how many rules went with it instead of only "Item removed". No other correctness, permission or scope problem was found. Copy still reports success only when the clipboard accepts the text: headless Chrome ran the honest failure path (link selected, manual-copy instruction) because the page had no focus, so the success message itself has no automated evidence.

### Section index

A *Form builder sections* navigation sits under the builder actions, with links named after the sections they reach: **Sharing · Ready to share? · After submitting · Form details · Questions · Preview**. *Form details* and *Questions* are new visible headings on the existing settings card and question list. Save, Publish, Responses and Delete stay in the action row only; the index adds no second copy of any action.

- Above 900 px it is sticky at the top of the page and shows the save state (*All changes saved*, *Unsaved changes*, …) on the right. That copy is hidden from assistive technology because the existing status badge already announces it. The sticky preview column starts below the bar, and sections scroll into view below it.
- At 900 px and below it scrolls with the page as one compact row of links, so it never covers content. *Preview* switches to the Preview panel and *Questions* or *Form details* switch back to the editor, using the existing Edit/Preview tabs.
- Activating a link moves focus to that section's heading (or the routing disclosure's summary) without changing the address. This matters because a fragment change can fire `popstate`, and the router would re-render and discard unsaved edits.
- The current section gets `aria-current="location"`: the last section whose top has passed the bar while scrolling, or the one just chosen. Preview sits beside the editor on wide screens, so it counts as current only when chosen or when it is the panel shown.

### Changing a question's type

Each question card has a **Question type** select. Rules live in `frontend/js/forms-type-change.mjs` (pure, unit-tested); the server enforces the published-key rule with `publishedTypeChangeAllowed` from the shared Forms logic.

| Situation | Result |
| --- | --- |
| Same family, unpublished key: text ↔ text (short, long, email, phone, date) or single ↔ multiple choice | Converted in place, keeping key, wording, help text, required setting, display rule and options. Applied at once, unless rule meanings change (below) |
| Published key widened: short → long text; email, phone or date → short or long text; single → multiple choice | Converted in place. The announcement adds that answers already received keep their original type in responses and exports |
| Published key, any other change (for example long → short text, text → email, multiple → single choice, text ↔ choice) | **Not converted in place.** A dialog offers *Replace question*: a new question with a new key, the same wording, help text, required setting and display rule (choice labels kept with new option keys; two placeholder options when coming from text). The old question leaves this draft only; published versions, responses and exports keep it with its answers |
| Single → multiple choice with dependent rules | Confirmation lists each rule before and after, for example *shown when “Kind” is “Team”* becomes *shown when “Team” is the only choice in “Kind”*. Rules are never rewritten |
| Text → email, phone or date with rules comparing typed text | Confirmation: the rules stay as they are; check in Preview that they can still match |
| Text ↔ choice, unpublished key | Confirmation. Choice → text lists the options that leave the draft; text → choice adds two placeholder options. *Is answered* and *is not answered* rules survive |
| Text ↔ choice while display rules or saved routing compare this answer's value | **Blocked.** A note under the select lists those rules; change or remove them first. The same applies to *Replace question* while any rule depends on the old question |
| Page break | No type select |

Cancelling any dialog leaves the draft exactly as it was; the select shows the current type until a change is applied. Every applied change marks the draft unsaved, and nothing reaches respondents until it is saved and published. Saving keeps the existing revision conflict handling. Dependency checks use the draft's display rules and the **saved** routing; unsaved routing edits are checked when routing is saved and again at publish.

**Server rule (new).** Publish and the publish check refuse a draft in which a key used by any published version reappears with a type `publishedTypeChangeAllowed` rejects. The message names the question and says to replace it. Saving such a draft is still allowed, so an editor never loses work, but it cannot go live. Responses were always stored and shown against the version they answered; this rule stops a key's CSV column and Flow placeholders from mixing incompatible answers. No schema change or migration. To roll back, revert the `validatePublish` check; existing data is unaffected.

### Final checks (this follow-up, final code)

- `npm test`: **235 tests, 230 pass, 0 fail, 5 PostgreSQL skipped**. New `test/forms-type-change.test.mjs` (6 tests): widening table, unpublished conversions keep key and settings and leave the input untouched, blocked text ↔ choice from display and routing rules, before/after rule meanings, published replacement and its new keys, and an API test. That API test publishes, submits, sees an incompatible retype refused by publish and the publish check (live form unchanged), publishes a widening and a replacement, then confirms the first response still reads as a version 1 email answer in the inbox and CSV.
- `npm run check` (155 files), `npm run sync-shared -- --check` (both shared modules in sync) and `git diff --check` pass.
- `npm run browser-check` on the final frontend: every journey passes, **824 layout checks** at 320, 375, 768 and 1280 px in both colour preferences, with no runtime errors or overflow. New steps:
  - Index: real Tab presses reach all six links with a visible focus ring; Enter on each moves focus to its heading and marks it current; the address and an unsaved title survive; the save state is mirrored; at 1280 px the bar stays at the top and does not overlap the preview; at 375 px it is not sticky, and Preview/Questions switch panels.
  - Type changes on a published form: the replacement dialog explains itself; cancelling leaves every type unchanged with *All changes saved* and focus back on the select; a depended-on choice question is blocked with the rule listed; single → multiple choice confirms with the before/after meaning and keeps the key; widening applies without a dialog; nothing new is published.
- Scripted end-to-end journey on disposable local data (Chrome, separate cookie-less respondent context). Template preview created 0 forms and 0 responses. Sales discovery draft: no link fields, public API 404. Edited, previewed and published (focus on share heading); sharing created no email. The anonymous respondent submitted: a simulated lost reply left 1 stored response and no receipt, and the retry showed receipt `611AC831` with still 1 response. Host detail showed the same reference after reload, and the CSV had the answer and the version column. Widening *Company* and publishing version 2 left the stored answer at version 1. Stop collecting: the public link says "This form is closed" and the response remains. A second workspace's user got 404 for the responses, CSV and form.
- Screenshots reviewed: draft at 1280 and 375 px with the index; sticky index with *Questions* current and the preview clear of the bar at 1280 px; replacement dialog at 375 px; closed builder at 1280 px and the closed public page at 375 px.

**PostgreSQL: not run.** The only configured `DATABASE_URL` (`backend/.env`) is the production Supabase database: the opt-in runner creates and drops a temporary schema there, which counts as a production database change. No separate test database is configured. Docker is installed but has no PostgreSQL image, and pulling one would mean downloading database binaries, which needs approval. The new publish query (`SELECT definition FROM form_versions WHERE form_id = ? ORDER BY version`) uses the same adapter and SQL shape as existing queries, but it has no PostgreSQL evidence. The CI PostgreSQL job will cover it once this branch is pushed.

Not verified: PostgreSQL, production, the clipboard success path, physical-device share sheets, mail clients, screen readers and human comprehension. Layout checks are not usability evidence.

Working-tree note: every tracked file in this checkout, including files this work never touched (for example `README.md`), now has CRLF line endings, written outside this session. `.gitattributes` (`* text=auto eol=lf`) normalises them on commit, so `git diff` stays proportional; nothing was converted here.

### Next work and checkpoint

1. Owner validation (below). Then let CI's PostgreSQL job run on this branch, or provide a non-production test database, before release.
2. *Connected to this form* (read-only Flow runs and webhook deliveries), as recommended in the integrations audit.
3. Type editing follow-ups: let *Replace question* repoint *is answered* / *is not answered* rules to the new question, which is safe but currently blocked; and check unsaved routing edits in the dependency list.
4. Media, after the CSP and privacy decision. Branching between pages, calculations and custom endings remain separate capabilities with no evaluator support.

### Owner validation steps

1. On `https://forms.schedora.in`, open **Create form** and **Preview** *Sales discovery*, then close it: no form appears in the list. Select **Create draft**; the builder says *Not public yet* and shows no link.
2. Use the section links under the buttons: each moves you to its section, and *Unsaved changes* stays visible at the top right on a wide screen after you edit the title. On a phone, *Preview* shows the preview panel.
3. On *Company or organisation*, change **Question type** to *Long text*: it applies at once. Change *What matters most in a solution?* to *Short text*: a note lists the rule that depends on it, and the type stays the same.
4. **Save draft**, then **Publish form**. Focus lands on *Share with respondents* with a `https://forms.schedora.in/f/` link. **Copy link**, open it in a private window, submit, and note the receipt.
5. In the builder change *Your name* to *Email*: a dialog offers *Replace question*. Select **Keep as is**: nothing changes and the draft stays saved.
6. Open **Responses (1)**, reload, check the receipt matches, and **Export CSV**.
7. **Email the link** opens your own mail app; Schedora sends nothing. **Stop collecting responses**: the private window now says the form is closed, and the response is still listed.

## Media: question images, picture choices and click-to-load video (30 October 2026)

Supersedes "Media: scoped, not implemented" above. Not committed, pushed or deployed.

**Works locally (automated evidence):** images attached to questions, pictures on choice options and click-to-load YouTube/Vimeo videos. **Not built:** respondent file uploads; see "Respondent uploads: blocked" below.

### Patterns adopted (official Typeform help, checked 30 October)

Picture choices keep a text label for every choice, because that text is what results record ([Picture Choice](https://help.typeform.com/hc/en-us/articles/360052865591-Picture-Choice-question)). Pictures show in a fixed 4:3 frame. Video is embedded by link only, with no autoplay ([video](https://help.typeform.com/hc/en-us/articles/360051639372-How-to-add-video-to-your-form)). Typeform's file uploads (10 MB, stored on its own platform with account storage limits) confirm that respondent uploads need dedicated storage ([File Upload](https://help.typeform.com/hc/en-us/articles/360051567012-File-Upload-question)). No Typeform assets, wording or branding were copied.

### Definition schema (validated by the shared `definitionProblems`, normalised by the server)

- Question `media` (not on page breaks), one of:
  - `{ type: 'image', asset, alt }`, or `{ type: 'image', asset, decorative: true }`. `asset` is a 32-hex workspace image id. `alt` is up to 250 characters and required unless the image is decorative. The normaliser drops `alt` from decorative images and `decorative: false`, so stored JSON stays stable.
  - `{ type: 'video', provider: 'youtube' | 'vimeo', video, title? }`. `video` is an 11-character YouTube id or a Vimeo id of up to 12 digits; `title` is up to 150 characters.
- Choice option `image: { asset }`. The option's label stays required and is the accessible name, so the picture uses empty alt text.
- Anything else is refused: other media types, iframe/HTML strings, path-like asset ids, foreign or unknown asset ids (checked on create, save and publish), and unsupported providers. Answers, logic, routing, CSV and Flow placeholders keep using option ids and labels, never image addresses. A test proves an image address is not a valid answer.

### Host images: limits and processing

| Limit | Value |
| --- | --- |
| Formats | JPEG, PNG, WebP (still images only). SVG, HTML, GIF, animated PNG/WebP and anything that does not parse are refused |
| Size | 2 MB per stored image (requests up to 3 MB of JSON) |
| Dimensions | At most 4000 px a side and 16 million pixels |
| Workspace quota | 10 MB of image bytes (`413 asset_quota`) |
| Service-wide guard | 60 MB of database space (base64) across all workspaces by default, `FORM_IMAGE_STORAGE_MB` (`507 asset_storage_full`), protecting the shared database; see the review follow-up below |
| Upload rate | 30 per minute per client; `forms.manage` permission |

- **Browser.** The builder re-encodes the chosen file on a canvas before upload, to at most 1600 px a side. PNG stays PNG unless it would exceed 2 MB; otherwise it becomes WebP, or JPEG where WebP encoding is unavailable. This applies photo orientation and drops camera and location metadata. States: *Preparing image…*, *Uploading…*, uploaded with dimensions, or *Not uploaded* with the reason and **Try again**, which reuses the prepared image.
- **Server** (`backend/src/forms/images.mjs`, no dependencies). It identifies the format from magic bytes, never the name or MIME type, and parses the structure: PNG chunk CRCs, JPEG segment lengths and end-of-image marker, WebP RIFF size. It reads true dimensions and removes metadata without re-encoding: PNG `tEXt/zTXt/iTXt/eXIf/tIME`; JPEG APP1 and APP3–APP15 except APP14, plus comments; WebP `EXIF/XMP`, clearing the VP8X flags. Colour-profile and JFIF data are kept. Identical images in a workspace are stored once (SHA-256).

### Storage and access model

- **Storage.** Images live in a new `form_assets` table, as base64 text so the SQLite and PostgreSQL bridge paths are identical. They are never in form JSON and never on ephemeral server disk. No new storage service, credential or paid resource. Size overhead is about 33%; the quotas count stored image bytes.
- **Builder reads:** `GET /api/workspaces/:ws/form-assets/:id` (`forms.manage`, same workspace only, `Cache-Control: private, max-age=300`).
- **Public reads:** `GET /api/public/form-assets/:id`, only while a published version of a currently collecting form in the same workspace shows the image (`form_version_assets`). Unknown ids, draft-only images, closed forms and other workspaces all get the same 404. `Cache-Control: public, max-age=3600`, so an image can remain in a browser or proxy cache for up to an hour after a form closes.
- **Response headers** on both routes: the stored MIME type, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: same-origin`, `Content-Disposition: inline`.

### Versioning, retention and deletion

- Publishing records the images each version shows in `form_version_assets`. Removing or replacing an image in a draft never changes a published version, and the live form keeps it until the next publish. Respondents still holding an older version during the 24-hour grace period still get its images, because public access checks every version of a collecting form.
- Images are immutable: *Replace image* uploads a new asset id.
- The retention job (`applyRetention`, through `pruneAssets`) deletes an image only when it is more than a day old **and** no published version references it **and** no draft in its workspace contains its id. The one-day window protects images added to unsaved drafts.
- Deleting a form removes its version references; its images are then pruned unless another draft uses them. Deleting a workspace deletes its images. Responses never reference images.
- Type changes: single ↔ multiple choice keeps options and pictures. Choice → text names the pictures that leave the draft. *Replace question* copies option pictures (with new option keys) and the question's media. Duplicating a question reuses the same immutable asset ids.

### Video

- Accepted addresses are exact `youtube.com/watch?v=`, `youtu.be/`, `youtube.com/embed|shorts|live/`, `youtube-nocookie.com/embed/`, `vimeo.com/<digits>` and `player.vimeo.com/video/<digits>`, over https or http. User information, ports, look-alike hosts, extra path segments, unlisted Vimeo hash links and non-matching ids are refused. Only the provider and id are stored. Nothing is fetched server-side, so there is no SSRF path.
- The respondent sees a placeholder naming the provider, saying that loading connects to it under its own terms, and offering **Load video from YouTube/Vimeo** and a fallback link. No thumbnail, script or frame is requested before that click (asserted on the network log). After the click the player is `youtube-nocookie.com/embed/<id>?rel=0` or `player.vimeo.com/video/<id>?dnt=1`. There is no autoplay, the title is "<Provider> video: <title or question>", it has a restricted `sandbox` and `allow` list, and focus moves to it. A loaded player stays loaded when the page redraws. Answering never requires watching.
- CSP: ordinary pages and `/f/` pages add only `frame-src https://www.youtube-nocookie.com https://player.vimeo.com`, in `backend/src/app.mjs` and `frontend/vercel.json`. Meeting pages keep the previous policy. There are no wildcards and no `unsafe-*`, and a test keeps both files consistent. **This is a deployment-affecting change that needs its own release step.**

### Rendering and accessibility

- Question images sit in a fixed 16:9 frame (`object-fit: contain`, lazy loading), so loading never shifts the page. A failed image is replaced by "Image could not be loaded: <alt text>". Images that failed before their listener attached are handled too.
- Picture choices keep native radio and checkbox inputs inside the label, in a responsive grid with a 4:3 picture frame. Focus ring and checked state apply to the whole card. If the picture fails, the label remains.
- Builder: **Add image** (a keyboard-reachable file control) and **Add video** (address field with inline errors). An image shows a thumbnail, alt text and a *Decorative* checkbox, plus *Replace* and *Remove*. Each option gets *Picture* / *Remove picture*. Removal is announced together with the fact that the live form keeps the media until publish. Save refuses a non-decorative image with no description.

### Respondent uploads: blocked (not built)

3 November feasibility follow-up: [respondent attachment contract](FORM_UPLOADS_CONTRACT.md) records a read-only Supabase inventory (zero buckets/objects), the public Free object-storage allowance and the remaining authorisation/quota/scanning/lifecycle gates. A private object-storage candidate exists, but it has not been configured and does not make uploads available. The database-only constraint below describes the existing implementation, not an assertion that no suitable object store can be provisioned.

There is no private object storage with lifecycle rules, quotas or scanning. The only durable store is the production free-tier PostgreSQL database shared with every product. Letting anonymous respondents write files of typical upload size there could exhaust it and take Schedora down, and no malware scanner exists. Creating a storage resource was out of scope (spend stays at ₹0, no production resources). So no upload control was added. Releasing it needs:

1. A private bucket with server-side credentials, a per-workspace quota, a service-wide cap and a cost owner.
2. Short-lived, single-use upload grants bound to form, version, question and submission id. Uploads stay quarantined until the response is accepted, and orphans are deleted after 24 hours.
3. Type/size/count limits and a decision on scanning: a tested scanner, or "not scanned" stated to hosts.
4. Downloads only through `responses.read`, with `Content-Disposition: attachment` and no durable links in CSV.
5. Deleting a response, form, workspace or retention-expired data removes its files.

### Checks (local, final code)

- `npm test`: **243 tests, 238 pass, 0 fail, 5 PostgreSQL skipped**. New `test/forms-media.test.mjs` (8 tests) covers:
  - metadata removal for PNG, JPEG and WebP, and idempotence;
  - refusal of SVG/HTML/GIF, a PNG signature followed by script, bad CRCs, truncation, animation, trailing data, oversize dimensions and bytes;
  - media definition rules, and malicious and look-alike video addresses;
  - picture-choice answers, logic and type changes;
  - upload permission, cross-workspace upload and read, guessed ids, deduplication and the workspace quota;
  - foreign and unknown asset references, draft vs published access, version retention after removal, unpublish revoking public access, cleanup rules and form deletion;
  - CSP scope and Vercel parity.
- `npm run check` (158 files), `sync-shared --check` and `git diff --check` pass.
- `npm run browser-check` final run: every journey passes, **840 layout checks** at 320/375/768/1280 in both colour preferences, no runtime errors or overflow. The new media step, on its own form:
  - uploads a real PNG through the file input (its text chunk confirmed stripped in storage), and saving without alt text is refused;
  - adds alt text shown in the preview, an option picture, a refused iframe string and an accepted YouTube link;
  - checks the preview image fallback, publishing (one deduplicated image recorded) and cookie-less public image delivery;
  - selects a picture choice with Space and a visible focus ring;
  - finds no YouTube/Vimeo/ytimg requests before loading, no unpiped title and no placeholder clipping at 320 px; the controlled embed then has its title and receives focus.
- One earlier full run failed at sign-up (form not yet rendered when the step filled it, an existing timing race unrelated to this work) and cascaded. The unchanged code passed in the next two full runs.
- The scripted owner journey on the final code still passes: share → anonymous submit with lost-reply retry (one response) → receipt → host detail → CSV → close → cross-workspace 404s.
- Screenshots reviewed: builder media editor at 1280 px, and the public form with image, video placeholder and picture choice at 375 px. Review caught two defects, both fixed and regression-tested: an unpiped `{{name}}` in the video title, and a clipped placeholder on phones.

**PostgreSQL: not run.** The only configured database is production. The new tables use the existing upgrade mechanism (`postgres_v13_form_assets`) and plain SQL (`COALESCE`, `||`, `LIKE`); CI's PostgreSQL job must pass before release. Not verified: real browsers other than headless Chrome, real photos from phones, Vimeo/YouTube playback (no external playback was relied on), screen readers and human usability.

### Deployment order and rollback

Migration `014_form_assets.sql` (SQLite) and `postgres_v13_form_assets` are additive. Deploy the backend first, then the frontend. The older frontend ignores media fields; the older backend would drop media on save and could not serve images, so do not roll the backend back while forms use media. To roll back, stop using media, then deploy the previous backend; the tables can stay. Watch database size: `SELECT SUM(bytes) FROM form_assets`.

### Next checkpoint

1. CI (including PostgreSQL), then a separate release that includes the CSP change.
2. Owner validation (below), with a real phone photo.
3. Respondent uploads after the storage, quota and scanning decisions above.

### Owner validation (local or staging, not production data)

1. In a draft, select **Add image** on a question and choose a phone photo. Check that the status moves to *Image uploaded* and focus lands on the description. Try **Save draft** with an empty description (refused), then describe it, or tick *Decorative*.
2. Add a **Picture** to two options of a choice question. Select **Add video** and paste a YouTube link (try a random website first; it is refused).
3. Publish, then open the public link in a private window. The image and pictures show; the video shows a placeholder until you select **Load video**. Choose a picture with the keyboard and submit. The response shows the option text.
4. Remove the image from the draft and save. The public form still shows it until you publish again.

### Media review follow-up (30 October 2026)

- **Storage budget lowered.** Images are stored as base64, about 4/3 of their bytes, in the same free 500 MB PostgreSQL database and pg_dump backups as everything else, so the earlier 200 MB cap could have taken over half the database.
  - The service-wide guard now counts stored database space and defaults to 60 MB (about 12%). `FORM_IMAGE_STORAGE_MB` changes it.
  - The workspace quota is now 10 MB of image bytes.
  - `SELECT CAST(SUM(bytes) AS BIGINT) * 4 / 3 FROM form_assets` estimates current use.
- **Concurrency.** Quotas are read and written in one transaction. On PostgreSQL every transaction holds the same advisory lock, so parallel uploads cannot both pass; a test fires two at the quota edge.
- **Reuse.** Choosing an identical image again now restarts its one-day cleanup clock, so an old unused copy is not pruned before the draft saves it.
- **PostgreSQL coverage.** `test/forms-media.test.mjs` is now in the CI PostgreSQL job, together with a PostgreSQL-only test of the `postgres_v13_form_assets` upgrade (it runs once and cascades with workspace deletion). `SUM` results use `CAST(... AS BIGINT)`, as elsewhere. Still not run locally: the only configured database is production.
- **Session offers.** Meeting rooms reuse the public renderer through `respondTo`, with link-only videos, because meeting pages keep their stricter CSP. Errors for meeting forms are listed in [MEET_SESSION_OFFERS.md](MEET_SESSION_OFFERS.md).

## Import and export (9 November 2026, local only)

**Import JSON** sits beside *Blank form* in *Create form*. **Export form definition** is in the builder's *More actions* menu. Both use Schedora's own definition format, so an exported form can be edited and imported again. The route checklist and later milestones are in `docs/FORMS_PRODUCT_CHECKLIST.md`.

- **File format.** A file is either a bare definition (`{ title, fields, … }`, as the API accepts) or an envelope: `{ "format": "schedora.form-definition", "version": 1, "exported_at", "definition" }`. Export always writes the envelope, from the **saved draft**. Unsaved builder edits are not included, and the toast says so. *Download an example file* in the dialog uses every supported part once (`frontend/js/forms-definition-example.mjs`). A test imports it through the real importer.
- **What a file carries:** the title, description, presentation, submit label, questions and page breaks with their ids, types, labels, descriptions, placeholders, required settings, choices and choice ids, multi-question pages (`grouped`/`group`), display rules, jumps, hide-choice rules, endings, URL parameter declarations and the theme. It **never** carries responses, routing (booking destinations), webhooks, flows, credentials or keys, the slug, revisions or published versions.
- **Strict import.** `backend/src/forms/definition-io.mjs` checks every key against the supported list before anything else. An unknown setting is refused by name ("Question 1 ("Name") has the setting "validation", which Schedora Forms does not support"). Excluded data is refused with the reason ("Form files never carry responses"), and server-owned keys such as `evaluation_policy` are refused too. Nothing is silently dropped. References are explained with the numbers an author sees: questions are counted without page breaks, and page breaks are named "Page N". Examples are a choice a rule uses that doesn't exist, a rule using a later question, a jump to a missing question, page or ending, and duplicate question or choice ids. The shared `definitionProblems` and `normalizeDefinition` then run as for any save. Images live in the workspace, not in the file, so an image id that isn't in the importing workspace is refused with how to fix it. Invalid JSON reports the line and column.
- **Preview before create.** `POST /forms/import-check` returns the title, presentation, counts (questions, pages, required, conditional, jumps, hide rules, endings, URL parameters), the theme name and any warnings. Warnings include a title that already exists in the workspace, piping that points at no question, a missing presentation and a description near its limit. It creates nothing. `POST /forms/import` runs the same checks again and creates an **unpublished draft** through `createForm`, in the workspace in the URL. The builder opens with "Draft created from your JSON file".
- **Access.** Both import routes and export need `forms.manage` in that workspace, and other workspaces get 404. Import is authoring, so the freeze refuses it with 423. The check and the export stay available while frozen. Rate limits: 120 checks and 60 imports a minute. The request body limit is 2 MB (the file limit is 1 MB of JSON text).
- **Not in this slice:** importing from other tools (Typeform, Google Forms). A file that looks foreign is told so and pointed at the example. There is also no import into an existing form, and no export of a published version, only the saved draft.

**Evidence (local SQLite, final code):** `npm test`: 376 tests, 369 pass, 0 fail, 7 skipped (opt-in PostgreSQL). `npm run check` and `sync-shared --check` pass. `forms-definition-io.test.mjs` covers the Technical Profile Details acceptance fixture, export → reimport deep-equality, and exclusion of routing and responses. It also covers invalid JSON, broken references, duplicate ids, refused keys, the freeze, workspace boundaries and foreign images. A headless-Chrome journey covered upload, preview, create, edit, save, reopen, preview, export and reimport through paste, then publish, submit (Classic and Conversational), the response detail and CSV. It found no overflow at 320/375/768/1280 px and no runtime errors. **Not verified:** PostgreSQL, a deployed environment, a screen reader, and real drag-and-drop of a file. The drop handler exists, but the journey used the file picker.
