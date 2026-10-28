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


## Per-form follow-up history and response paging (28 October 2026 increment)

`GET /api/workspaces/:ws/forms/:id/responses` preserves `form`, `versions` and `responses`, and adds `next` plus `followups: { runs, tasks, bookings, now }`. Follow-ups are selected from the returned response ids and only linked bookings visible to the actor, using the same authorization rules as workspace Enquiries. They are not limited to the newest 200 workspace runs/tasks. The `bookings` array contains only visible id/reference pairs needed to join that history. A missing evidence payload is shown as unavailable, never as proof that no flow ran.

`next` is a timestamp/id cursor, ordered by `created_at DESC, id DESC`, so tied arrival times cannot skip responses. Pass it unchanged as `before`; an old numeric timestamp remains an exclusive timestamp cursor for compatibility. Default page size is 50, maximum 200. A null `next` means the current traversal is complete; this is not a live-update subscription or a snapshot against concurrent edits/deletions.

The inbox accumulates page-scoped history without duplicating shared booking runs, retains Load older responses under an empty attention filter, prevents simultaneous loads, announces results and preserves keyboard focus. No schema, response quota, retention, publication, delivery or entitlement change is introduced. Large-history latency and human task completion remain unmeasured.
