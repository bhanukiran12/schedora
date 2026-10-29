# Research-led implementation log

Started 27 October 2026. This log turns the [suite strategy](SUITE_STRATEGY_2026_10_27.md), [feature priorities](FEATURE_PRIORITIES.md), [pricing proposal](PRICING_PROPOSAL.md) and [UX research plan](UX_RESEARCH_PLAN.md) into reviewable frontend slices. Each slice records the problem, the resulting behaviour, its evidence class and what still depends on backend work or research.

**Evidence classes used below:**
- **Local:** automated tests and headless-browser journeys on this machine.
- **Mock:** fake providers and synthetic media.
- **Real provider:** dated staging runs.
- **Human:** a person's report on their own device.

No customer interviews or experiments have been run; nothing here is a demand or conversion finding.

## Baseline: what works, what is partial, what is a proposal

| Area | State | Notes |
| --- | --- | --- |
| Meet event types, availability, booking, cancel/reschedule, appointment-date time zones, exact join times | Works (local); committed | Covered by unit tests and browser journeys |
| Meet video room, prejoin, devices, recovery | Works locally; real LiveKit staging runs exist | Voice reported good by the user on a physical retest. Sharpness and physical-network recovery are still unverified. Production video and recharge stay disabled |
| Forms draft/publish/versions, conflict handling, receipts, CSV, Meet handoff | Works locally; **uncommitted** | Preserved untouched by this log's slices |
| Flow: two triggers, one email or task action, draft/enabled/paused, saved-definition simulation, runs/retries | Works (local); committed | One trigger → one action only |
| Research draft: homepage and product copy, Flow starters, outcome preview, outbox wording, asset routes | **Partial** (local, uncommitted) | Reviewed in slice 1 |
| Forms goal templates, logic explanation, linked enquiry trail, pricing/usage prototype | Proposal | Later slices |
| Multi-step flows, branches, delays, connectors, approved prices, budgets | Proposal only | Need backend contracts or commercial approval first |

## Review of the existing draft

**Kept as is:**
- The task-led homepage and product copy, with "EXAMPLE", "CONCEPT" and "Sample data" labels.
- The classic/conversational wording.
- The narrow static asset and page routing fix with its tests (path-restricted, 404 for missing files).
- The three starter definitions. They use only supported triggers, actions and recipients: `to: 'host'` is valid for booking triggers. Selecting a starter changes page state only; nothing is saved, enabled or sent.

**Corrected in slice 1:**
- The run outcome for email said "Email queued; check delivery status" on a **succeeded** run. The engine marks an email run succeeded only after `deliverEmail` returns `sent`, which means the provider accepted it (or the local outbox recorded it). Inbox delivery is not tracked anywhere.
- The "Configuration preview" was generic (trigger → action) and styled as a warning notice. It also re-announced itself on every redraw.
- The empty Flows list did not offer the starters.
- New drafts did not explain why Simulate was missing.
- On phones, run history squeezed text letter by letter and hid the outcome column (pre-existing).

## Slice 1: Flow native starters and truthful run state

**Problem.** A new user could not predict what a flow would do, could not discover the starters from the empty list, and could misread a succeeded email run as "delivered". On phones the run outcome was unreadable.

**Behaviour now**
- The empty Flows list offers the three starters as links (`/flow/new?starter=…`), plus Start from scratch. Opening one creates an **unsaved Draft**: no database write (tested), no enablement, no email. Blank creation remains available.
- The editor shows **What this flow will do**: one sentence naming the actual source, action and recipient. For example: "When an appointment is booked for any event type, email the host." or "…create a task titled 'Prepare for {{invitee.name}}' in Flow › Tasks."
  - It also states the status consequence (draft, paused, or enabled for new events only).
  - It also states what email means on this server.
  - It updates as you type, without re-rendering the form.
  - It is a labelled region, not a live region.
- Status explanations match the engine: drafts ignore events; paused flows hold new events and run them on resume; enabled flows run new events only.
- Simulation:
  - New drafts say they must be saved before simulating, and that simulation never sends an email or creates a task.
  - Simulating with unsaved edits says those edits are not included; the server simulates the last saved definition.
- **Run outcome wording:**

  | Outcome | Wording |
  | --- | --- |
  | Task | "Task created", with a link to Tasks |
  | Email via the local outbox | "Recorded in the local outbox. It is not delivered to an inbox." |
  | Email via a real provider | "Accepted by the email provider. Inbox delivery is not tracked here." |

  The page never says "delivered". The header explains what *succeeded* means, and that retries reuse the run so a created task or accepted email is not repeated.
- Run history becomes labelled cards on screens up to 760 px, so the outcome stays readable. Desktop keeps the table. The Retry button names its flow for screen readers.
- Starters copy only the flow's own fields (name, trigger, action and config); the trigger source resets to "any" and the status to Draft.

**Files:**
- `frontend/js/flow.mjs`
- `frontend/js/flow-starters.mjs` (draft, unchanged)
- `frontend/app.css` (appended Flow block)
- `backend/scripts/browser-check.mjs` (Flow starter step extended)

**Evidence (local; mock email outbox):**
- `npm run check`: 113 files pass.
- Flow and web tests: 8/8 pass.
- `npm run browser-check` on the full working tree, which includes the uncommitted Forms work: every journey passes, 424 layout checks with no errors or overflow.
- The extended starter journey asserts:
  - three starters appear in the empty state, and opening one writes no flow;
  - the summary text matches the starter and follows edits, and edits mark the page unsaved;
  - the unsaved-draft simulation note;
  - the host-email summary and outbox wording;
  - the replace-draft confirmation and the paused wording;
  - the saved starter persists as a Draft with the supported trigger and action;
  - the run links to Tasks, and run history never claims delivery.
- Before and after screenshots at 1440 and 375 px were reviewed. They are stored with the session's outputs, not the repository.

**Remaining dependencies:**
- **Delivery evidence:** real email needs a configured provider and a delivery test. "Accepted by provider" is the strongest claim the engine supports.
- **Respondent acknowledgement starter:** deferred. It needs a chosen source form with an Email question (the existing editor already handles that choice).
- **Run-to-record links:** linking a run to its booking or response, and a needs-attention filter, need the cross-product trail contract (a later slice).
- **Research:** whether starters help real users is untested. Measure first valid saved draft, simulation success and accidental enablement in moderated sessions. A template click is not activation.

## Slice 2: Forms goal-based starting points

**Problem.** "Create form" made a generic untitled form. A new creator had to invent structure, and nothing connected the product to the jobs in the strategy. Those jobs are consultation intake, agency briefs, programme enquiries and session feedback.

**Behaviour now**
- **Create form** opens "Choose a starting point" (`aria-expanded`/`aria-controls`, with focus moved to its heading). With no forms yet, it is shown directly.
- **Options:** Blank plus four goal templates:
  - Consultation request (consultants and coaches)
  - Project brief (small agencies)
  - Programme enquiry (training teams)
  - Session feedback (coaches and educators)
- **Each card shows** its audience, purpose, question count, presentation (classic or one question at a time), and a plain sentence explaining its logic.
- **Creating a draft** is the explicit action, through the existing draft API. It saves an **unpublished** draft and opens the builder, which says the draft is saved but not published, so nobody can open it until the creator publishes. Viewing templates creates nothing.
- **Failures:** a failed create keeps the picker open with "The draft was not created" and the server's reason.
- **Data-minimising questions:**
  - Optional questions are marked as optional through `required: false`.
  - "Programme enquiry" states that interest does not reserve a place (there is no capacity model).
  - "Session feedback" asks for an email only when the person wants a reply.
- **Supported schema only** (`frontend/js/forms-templates.mjs` is plain data, shared with the server tests). Classic and conversational presentation stay a creator's choice; conversational is suggested only for the short feedback form, not claimed to perform better.

**Files:**
- `frontend/js/forms-templates.mjs` (new)
- `frontend/js/forms.mjs` (dashboard picker and builder notice; the file also carries the preserved uncommitted Forms reliability work)
- `frontend/app.css`
- `backend/test/forms-templates.test.mjs` (new)
- `backend/scripts/browser-check.mjs`

**Evidence (local):**
- `npm run check`: 115 files pass.
- `forms-templates.test.mjs` (3/3) checks that:
  - each template passes `definitionProblems` and server normalisation;
  - the conditional logic matches its card text, including that hidden answers are discarded and the conditionally required email is enforced;
  - creating every template via the API gives `published_version: null`, a 404 on the public URL, and zero `form_versions`.
- `npm run browser-check` on the full working tree: all journeys pass, including the new template journey. It checks five options, the toggle and focus, that viewing creates nothing, the builder's unpublished notice, and that no version is published. The updated "build and publish form" journey now starts from Blank. 440 layout checks, no errors or overflow.
- **Screenshots:** before (committed HEAD, captured in a temporary worktree) and after, at 1440 and 375 px, were reviewed.

**Remaining dependencies:**
- Template content is a starting hypothesis: no creator has used it. Measure first valid publish and later edits in moderated sessions. Choosing a template is not activation.
- Programme names ("Programme A/B") are placeholders the creator must replace. A capacity or waitlist model would need its own backend contract.
- No template wires a Meet handoff or Flow automatically. Doing so would cross products silently; offering it as an explicit next step after publishing is a candidate for the linked-trail slice.

## Slice 3: Enquiry trail (per form, from real records)

**Problem.** After a response arrived, an operator could see the booking handoff status but not what happened next. They could not tell whether a follow-up ran, failed or left an open task, or which responses still needed action. The strategy's proposed distinction depends on answering "what arrived, what happened, what needs attention".

**Behaviour now**
- **"What happened next"** appears in each response's detail, as an ordered trail:
  - Response received, with its receipt.
  - The booking step: none, offered (not booked yet), confirmed, pending payment, canceled, removed, or could not be offered (with the recorded reason).
  - Each related Flow run: from the response, or from its booking via the booking id, with the run's real outcome (task open or done, email outbox or provider acceptance, failed with error, retrying, held while paused).
  - Every step has a written state ("Done", "Waiting", "Needs attention", "Not applicable", "Unknown"), not colour alone, and links to Run history, Tasks or Meetings.
- **"Needs attention" filter** over the loaded responses, with counts. Each row shows its reasons (for example "Open task (Review enquiry)").
  - **What counts:** a booking problem (canceled or could not be offered), a failed or retrying follow-up, or an open follow-up task.
  - **What doesn't:** a waiting booking offer is not counted, because nothing has gone wrong yet.
  - The filter keeps focus, and its empty state says nothing needs attention.
- **Accuracy rules:**
  - Follow-up data loads after the inbox, so the inbox is never blocked; open details refresh without moving focus.
  - Each source loads independently. Unreadable sources show as "Follow-up status unavailable" or "Unknown", never as "No follow-up recorded".
  - When a member cannot see the booking, the trail says its follow-ups are not visible to their role.
  - When run or task lists reach their 200-row limit, the page says counts are based on the latest 200.

**Live versus prototype.** Everything shown comes from real records through existing APIs:
- the response's `next_step`
- `GET /bookings` (three scopes)
- `GET /runs`
- `GET /tasks`

No sample data and no new endpoint. A workspace-wide queue with owners, reconciliation and complete linking needs a backend contract: see [Enquiry trail contract](ENQUIRY_TRAIL_CONTRACT.md).

**Files:**
- `frontend/js/enquiry-trail.mjs` (new; no browser dependencies, unit-tested)
- `frontend/js/forms.mjs` (responses page; the file also carries the preserved Forms work)
- `frontend/app.css`
- `backend/test/enquiry-trail.test.mjs` (new)
- `backend/scripts/browser-check.mjs`
- `docs/ENQUIRY_TRAIL_CONTRACT.md` (new)

**Evidence (local; email via outbox):**
- `npm run check`: 116 files pass.
- `enquiry-trail.test.mjs` (5/5) covers each booking state, joining runs through the response id and the booking id, open and done tasks, failed, retrying and paused runs, outbox versus provider wording (never "delivered"), unavailable sources reported as unknown, and the role-visibility note.
- `npm run browser-check`: all journeys pass, including a new end-to-end journey on real local records:
  - enable a response → task flow, then submit a response to the routed form, and the worker creates the task;
  - "Needs attention (1)" appears, the filter keeps focus, and the row explains "Open task (Review enquiry)";
  - the detail trail shows Response received, Booking offered (not booked yet) and Task open, and does not claim a booking;
  - completing the task via the API returns "Needs attention (0)".
  - 448 layout checks, no errors or overflow.
- **Screenshots:** the trail at 1280 and 375 px was reviewed. The "before" state for this slice is the Task 2/Forms inbox, which showed only the Next step badge.

**Remaining dependencies:**
- Workspace-wide queue, owners, resolution and notifications: see the contract.
- Runs and tasks endpoints have no subject filters, so the trail scans the latest 200. A `?subject=` filter would be a small, safe backend addition when needed.
- Whether operators find this faster than their current tools is untested; it is one of the planned moderated tasks.

## Slice 4: Proposed pricing and usage prototype (interview material)

**Problem.** The strategy needs people to understand units, allowances, resets and limit outcomes before any price is approved. The only pricing surface was the live Plans page, which must not show unapproved amounts.

**Behaviour now.** A separate page at `/pricing/proposal`:
- **Label first:** it opens with **"Proposed pricing — not available for purchase"** above the heading. The banner says the figures are interview prompts, not approved, not an offer and not purchasable, exclude undecided taxes, and that today's state is on Plans.
- **Kept out of search:** the page is `noindex` (the tag is removed on navigation) and is not linked from marketing navigation or the sitemap.
- **Plans:** four cards, Meet ₹399, Forms ₹499, Flow ₹699 and Suite ₹1,199 per workspace per month. Each shows who it fits, who can use it (seats and collaborators as in the proposal; respondents are never seats), the monthly volumes, and a "Proposed · not available" tag.
- **Annual (labelled a later concept):** shows the **full payment first** (₹3,990 / ₹4,990 / ₹6,990 / ₹11,990 paid once a year), then the monthly equivalent and the difference against 12 monthly payments.
- **How usage works**, per meter: what counts, what does not, and what happens when the allowance is used up. The limit outcomes match the **current engine**:

  | Meter | At the limit |
  | --- | --- |
  | Bookings | New bookings refused; existing appointments and rescheduling keep working |
  | Responses | Refused without a receipt; accepted responses kept |
  | Runs | Recorded as failed and not replayed |

  - The reset is stated exactly (00:00 UTC on the 1st, also on annual billing), with the next reset in the viewer's time zone.
  - The page says the proposed volumes are not today's limits.
- **Proposed safeguards** (warnings at 50/75/90/100%, no automatic overage, opt-in only with a visible rate and a hard spending limit) carry a "Proposed, not built" tag.
- **"Estimate a month":**
  - Enter bookings, responses and runs; invalid numbers get field errors.
  - It compares only the plans actually needed with Suite, and says when Suite is not needed.
  - It shows how many items would be **refused** beyond an allowance.
  - It states that the bill stays at the plan price, because usage beyond an allowance is refused rather than charged, and no extra capacity is proposed for sale.
- **Not included:** built-in video (no rate proposed and not for sale), SMS/WhatsApp, AI and payment-provider fees. The ₹398 Suite difference is described as relative to these proposed plans only, not against other companies.

**Unchanged:**
- Checkout, billing, entitlements, allowances, live prices and the Plans page.
- `frontend/js/pricing-proposal.mjs` is read by nothing in the backend or on the Plans page (tested).
- The page makes no billing API calls (tested).

**Files:**
- `frontend/js/pricing-proposal.mjs` (data and arithmetic)
- `frontend/js/pricing-proposal-page.mjs`
- `frontend/app.js` (route plus per-page meta cleanup)
- `backend/src/web.mjs` (page whitelist)
- `frontend/app.css`
- `backend/test/pricing-proposal.test.mjs`
- `backend/scripts/browser-check.mjs`

**Evidence (local):**
- `pricing-proposal.test.mjs` (4/4) checks:
  - amounts match `PRICING_PROPOSAL.md`;
  - annual totals and equivalents (₹332.50 / ₹415.83 / ₹582.50 / ₹999.17), the ₹798 difference and the ₹398 Suite difference;
  - the reset across month and year boundaries;
  - estimate options and refused counts, and input validation;
  - no backend module or the Plans page imports the proposal;
  - the route and module are served.
- **Browser journey** checks:
  - the label comes before the heading, and the page is `noindex`;
  - there is no purchase control, and the exact monthly prices appear;
  - annual shows the full payment;
  - invalid input is flagged, and the estimate shows ₹4,990 a year and "200 would be refused … refused, not charged";
  - no billing API is called;
  - the `noindex` tag does not leak to Plans, and Plans does not show proposed prices.
  - 456 layout checks, no errors or overflow.
- **Screenshots:** the page top, annual view and estimate at 1440 and 375 px were reviewed.

**Remaining dependencies:**
- **Before any price is shown as an offer:** owner approval, measured unit economics and tax treatment (see `PRICING_PROPOSAL.md`).
- **Enforced safeguards:** usage warnings, opt-in overage with spending limits, and seat limits need backend work.
- **Interview script:** ask participants to predict their bill and the limit outcome from this page *before* explaining it, and record comprehension separately from stated willingness to pay. No sessions have been run.

## Slice 5: Meet "Ready to share?" summary

**Problem.** A host could not answer "what still needs attention before I share this booking link?" without visiting four places: the editor, Calendars & apps, the public page and Delivery. Nothing distinguished "selected" from "working". The save toast said "Your booking page is live" even when no times were open or the plan was inactive.

**Behaviour now**
- A **Ready to share?** card sits at the top of every saved event type's editor. New event types get a one-line note that the check runs after saving.
- **Evidence.** The card reads only saved data and server checks, fetched in parallel:
  - `GET /event-types/:id`;
  - the host-view `GET /event-types/:id/slots`;
  - `GET /calendar` (the viewer's own connections);
  - `GET /integrations`;
  - the boot flags for video, email provider and test payments;
  - the workspace Meet entitlement.
- **Four areas.** Each area and each item shows one status, using icon, text and colour:
  - Statuses: Ready, Needs attention, Not verified or Not required.
  - Issue tags: **Required** (would stop booking), **Optional** (a recommendation) or **Unknown**.

  | Area | What is checked |
  | --- | --- |
  | **Event details** | Title, duration and kind; each location; payment. Schedora Meet with the server gate off is Required. With the gate on it is only Not verified, because a room's quality is known only when a meeting starts. Google Meet, Zoom and Teams are Ready only when the viewer is the sole host and that integration is `active`. A revoked or failed integration is Required; other hosts' connections are Not verified. Paid events need an active Stripe or Razorpay connection; without one, the summary names the test-checkout consequence. |
  | **Availability** | Friendly time-zone label; weekly hours (for example "Mon–Fri 09:00–17:00"), specific times and upcoming date exceptions; notice, horizon, buffers and caps. The authoritative check is the server's own slot calculation. It names the exact range checked: from today (or the "bookable from" date) to the horizon (or the "bookable until" date). With hours set but no open times in that range (fully booked or busy), the item is Optional: it explains the current state, because the link still works and times reappear. A start date beyond the window is Not verified, not "broken". An expired link or a past end date is Required. |
  | **Calendar and conflicts** | Each of the viewer's own connections, by state (see the list below this table). No calendar at all is an Optional limitation, never a blocker. A note says what conflict checking covers. Other hosts' calendars are Not verified, as is every host's calendar when an admin views someone else's event. |
  | **Sharing** | An inactive Meet/Suite plan is Required. A draft is Required, with "Go to Visibility"; nothing is ever published automatically. A published event is Ready, with hidden and single-use notes. Email through the local outbox is Optional ("not delivered"); through a real provider it is Not verified, with "Send a test email" for admins. Sharing actions are listed below this table. |

  **Calendar connection states:**

  | Connection | Status | Notes |
  | --- | --- | --- |
  | `active`, checked within the last hour | Ready | Shows the time of the last *successful* busy-time check |
  | `active`, checked longer ago | Not verified | |
  | `pending` | Not verified | |
  | `error` | Optional | The previous good copy is still used |
  | `revoked` | Optional | Busy times are dropped |

  **Sharing actions:**
  - The real booking link sits in a read-only field.
  - **Copy link** appears only when the event is published. It announces success or failure, plus "Copying the link does not show that booking, email or video works".
  - **Preview booking page** is a separate new-tab link. It does not publish, book or send anything.

- **Headline.** It counts required items, optional recommendations and unverified items.
  - There is no percentage and no all-green state.
  - With no blockers it says "No required issues in the saved settings", followed by what is unverified.
- **Interaction:**
  - **Unsaved changes.** Any edit adds "You have unsaved changes. This summary describes the last saved version."
  - **Re-checking.** Saving re-renders the editor, which re-runs the check. **Check again** re-fetches everything, including the event type, and announces the headline in a status region. The first load does not announce.
  - **Fix actions.** These move focus to the matching editor section heading (Details, Availability or Visibility). Links to other pages use the existing tabs; browser Back returns to the editor, which re-checks. A **Review readiness** button next to Save returns to the card.
  - **Loading and failures.** While loading, the card says "Checking saved settings…". A failed source becomes Not verified with **Check again**. If the event type itself cannot be re-read, the whole card says nothing is marked ready.
- **Permissions.** No backend changes: the summary uses only endpoints the viewer can already call.
  - Members see no admin-only actions (Review plans, Set up payments, Send a test email). They get "Ask an owner or admin…" instead.
  - Locked managed fields say "Your administrator manages this setting."
  - Nothing is added to public booking pages.
- **Save toast.** After a published save it now reads "Saved and published. Check “Ready to share?” before sending the link." instead of "Your booking page is live".

**Authoritative vs not verified**

Authoritative:
- server-validated saved fields;
- the host-view slot calculation (hours, exceptions, notice, horizon, buffers, caps, existing meetings and stored busy times);
- the viewer's own calendar connection status and last successful sync;
- the viewer's own integration status, and the workspace payment connection status;
- the server video gate, the email provider mode and the workspace entitlement.

Not verified:
- email delivery to inboxes;
- native video room quality and connection;
- whether auto-links are actually created (only the connection status is known);
- other hosts' calendars, integrations and personal hours;
- real payment completion;
- calendar freshness after the last successful sync.

An open time now can still be taken before someone books; the summary says so.

**Missing backend contracts** (proposals; not built):
- **Readiness endpoint.** `GET /event-types/:id/readiness` would evaluate every host's calendars and integrations on the server, so team events and admins could see them without exposing credentials. It would return per host `{ calendars: [{ status, last_success_at, last_attempt_at }], integrations: { google|microsoft|zoom: status } }`.
- **Last successful sync.** `calendar_connections.last_synced_at` is also written on failed attempts. A separate `last_success_at` is needed to state "last successful check" for `error` connections.
- **Email delivery evidence.** A workspace-level "last confirmed email delivery" (from provider webhooks) is needed before email can be anything other than Not verified.
- **Auto-link check.** A dry-run link check for Google Meet, Zoom and Teams, per host.
- **Accepting reason.** The host-view slots response could return `accepting` with its reason (plan inactive or preview), instead of the client combining the entitlement and published flags.

**Files:**
- `frontend/js/meet-readiness.mjs` (new; pure rules)
- `frontend/js/meet.mjs` (editor card, section ids, save toast)
- `frontend/app.css` (appended readiness block)
- `backend/test/meet-readiness.test.mjs` (new)
- `backend/scripts/browser-check.mjs` (new readiness step)

**Evidence (local; outbox email, fake providers, ICS feeds from the test harness)**

`meet-readiness.test.mjs`: 11 of 11 pass. They cover:
- a verified published event;
- a draft;
- saved values rather than form values;
- missing hours, no open times, a past end date, a start date beyond the window, and passed specific times;
- an optional disconnected calendar;
- revoked, failed, pending and stale calendars;
- the video gate off and on, and a revoked Zoom connection;
- API failures becoming Not verified with a retry;
- no side effects;
- member and admin visibility.

One end-to-end test runs over the real local API:
- an ICS calendar is connected, then failing, then revoked;
- a draft is still slot-checked for the host, but returns 404 to the public;
- members get 404 for another host's event type and slots;
- members see only their own calendars and cannot send delivery tests.

The browser journey confirms:
- four areas and no percentage;
- the optional calendar does not block, and the missing location is flagged;
- an unsaved title edit adds the notice and does not change the summary;
- fix links move focus to the right section;
- for a draft:
  - the Required "Not published" item appears;
  - Copy is absent;
  - Visibility has publish unticked;
  - the anonymous public API returns 404;
- Preview link attributes are correct, Copy gives feedback, and Check again announces;
- preview, copy and re-check leave the booking, email, meeting and published counts unchanged;
- native video is Required with the gate off and Not verified with it on.

Full checks ran on the working tree, which includes the uncommitted Forms reliability work:
- `npm run check`: 122 files.
- `npm test`: 154 tests; 151 pass, 0 fail, 3 skipped (PostgreSQL).
- `npm run browser-check`: every journey passes. 472 layout checks across 320, 375, 768 and 1280 px in light and dark, with no runtime errors or overflow.

Screenshots reviewed, before and after, at 1440 and 375 px: a published event, a draft with a long title, and the video gate off.

**Follow-up review (carried forward before Forms readiness)**
- **Keyboard focus, verified independently.** A separate script pressed real Tab and Enter keys through the card for a draft and a published event at 1440 and 375 px. It measured each focused element:
  - All 8 stops on the draft and all 5 on the published event match `:focus-visible`.
  - Each shows a 3px solid outline with at least 5.24:1 contrast against the background behind it.
  - Each is in view, not clipped by an ancestor's overflow, and not covered.
  - Enter on a fix link lands on the section heading, which is visibly focused.

  The browser journey now repeats the Tab pass with real key events.
- **Dark theme.** `frontend/app.js` pins `data-theme="light"` (commit `78f1bc5`, fixed light theme). Dark mode is therefore never shown, and the "dark" passes of `layoutCheck` re-test light. The dark `--focus` token is defined but unused. Nothing was changed; this is noted so the layout-check count is not over-read.
- **"No open times" no longer blocks sharing.** The server cannot tell a misconfigured schedule from a fully booked or busy one. The link still works and shows times as they free up, so this is now **Needs attention · Optional**, with a "Review hours" action. Structural causes stay **Required**: no weekly hours, a past end date, an expired link, or every offered time passed. The no-blocker headline now reads "No required issues in the saved settings" rather than claiming invitees can book.

**Known limitations:**
- Keyboard access uses native buttons and links, and fix actions move focus. Focus visibility was measured only in the shipped light theme.
- On phones the card was long, with four stacked areas. Slice 6 makes the areas expandable.
- In headless Chrome the Copy outcome depends on clipboard permission, so the test accepts either message.
- None of this is real-provider or human evidence.

## Slice 6: Forms "Ready to share?" summary

**Problem.** A form creator could not see in one place what respondents see now, whether the saved draft would publish, which questions the logic can never reach, or what "after submitting" means. The builder showed status badges, a collapsed "Share and embed" panel and a routing editor separately, and nothing distinguished "response received" from "booking offered" from "appointment confirmed".

**Behaviour now**
- A **Ready to share?** card sits under the builder's action buttons. Meet and Forms use the same vocabulary (`frontend/js/readiness.mjs`) and renderer (`frontend/js/readiness-view.mjs`).
  - Statuses: Ready, Needs attention, Not verified, Not required.
  - Issue tags: Required, Optional, Unknown.
  - There is no percentage.
- **Compact on phones.** Each area is a disclosure. Wide screens open all of them. Phones open only areas that need attention; the others collapse to one line ("Sharing · Ready"). The Meet card now uses the same renderer, which addresses slice 5's "long on phones" limitation.
- **Evidence:**
  - the saved form (`GET /forms/:id`);
  - for a published form, the live public payload (`GET /api/public/forms/:slug`), which gives the live definition and the server's availability (`open`, `capacity_reached`, `not_accepting`);
  - the event types the viewer can see (`GET /event-types`);
  - the shared `definitionProblems` and `visibleFields` from `/shared/forms-logic.mjs` (the same code the server runs);
  - the workspace Forms and Meet entitlements.
- **Five areas:**

  | Area | What is checked |
  | --- | --- |
  | **Draft and live** | Not published, or closed: Required, with "Go to Publish", which moves focus to the Publish button and never publishes. Live and matching the saved draft: Ready. Live with unpublished changes: Optional; it names the differences against the live definition (questions added, removed or changed; order; title, description, presentation or submit label), and when only routing differs it says routing cannot be compared here. A used-up allowance or an inactive plan is Required. A failed live check is Not verified. |
  | **Questions and logic** (the saved draft, which is what Publish makes live) | Shared validator problems are Required. No questions is Required. Unreachable questions are Optional: every controlling answer is tried with the shared visibility evaluator (each option, unanswered, and each value a rule distinguishes). Over 4,096 combinations is Not verified. An unreachable required question is called out as "never asked even though it is required" while respondents can still submit. `{{key}}` insertions that show blank (unknown key) or "…" (this question's own answer, or a later question) are Optional. |
  | **Respondent preview** | The presentation respondents get, plus actions to preview classic or conversational. These switch the existing preview, move to the Preview tab on phones and focus its heading. Preview includes unsaved edits, runs only in the browser and stores nothing. |
  | **After submission** | Always: "The receipt means the response was received, nothing more." No routing: Not required (receipt only). Each rule and the fallback are described; booking-page checks are listed below this table. Questions or options a rule refers to that no longer exist are Required. The saved-vs-live routing caveat is stated. |
  | **Sharing** | Published and accepting: Ready. The public link, conversational link, a collapsed **Embed on your site** and **Stop collecting responses** now live here; the separate "Share and embed" panel was removed. Unpublished: Required; only the future link is shown, read-only, with no copy or embed. "Copying a link does not show that responses are received or that follow-ups work." |

  **Booking pages in routing:**
  - A **published** booking page is Ready. The text explains that the receipt says "Response received — choose a time", that nothing is booked until the respondent picks a time, and that only Meet's confirmation means an appointment exists. It links to that event type's own **Ready to share?** card.
  - An **unpublished or expired** booking page is Required.
  - A **deleted** booking page is Required for admins. Members see "a booking page you cannot see (another host's)" as Not verified, because `GET /event-types` lists only event types they host.
  - **Booking rules without an active Meet plan** are Required.
  - **Unloaded event types** are Not verified.

- **Interaction:**
  - **Unsaved edits** add "This summary describes the saved draft. Save to check your changes; Preview already shows them."
  - **When it re-checks.** The card re-checks after save, publish, unpublish, routing save and loading a conflicting version. **Check again** re-reads the form into its own copy, so the builder's save revision (and conflict detection) is never changed by a check.
  - **Fix actions** move focus to the Publish button, the first question, the routing panel (opened) or the preview heading.

**Bug found and fixed (committed code):** `normalizeDefinition` added a page break's empty `label` after `show_if`, and re-normalizing on publish put it before. `has_unpublished_changes` compares stored JSON, so any form with a conditional page break showed "Saved draft not yet published" straight after publishing, both in the existing badge and in the new summary. Page-break defaults are now applied before `show_if`, so normalizing is idempotent; a regression test covers it. Drafts saved before this fix keep the old key order until they are next saved, so for those forms the badge can still appear once.

**Authoritative vs not verified**
- **Authoritative:**
  - the saved draft and routing;
  - the live definition and availability from the public endpoint;
  - the shared validator and visibility rules;
  - the workspace entitlements.
- **Same rules, checked in the browser:** routing destinations are checked with the server's rules against the event types the viewer can see. Publishing re-checks on the server and stays the final word.
- **Not verified:**
  - the live version's routing, which is not in any API response;
  - other hosts' booking pages, for members;
  - whether a respondent books after being offered a time, which the inbox and enquiry trail show per response;
  - follow-up delivery.

**Missing backend contracts** (proposals; not built):
- **`published_routing` in `GET /forms/:id`.** This would let the summary name routing differences exactly.
- **A dry-run `POST /forms/:id/check`.** It would return the publish validator's problems (definition plus routing, with destination status for every host) without publishing, so members get authoritative destination checks.
- **A semantic comparison for `has_unpublished_changes`** (parsed and canonical, not string equality). This would make stored-order differences irrelevant for older drafts.

**Carried forward from slice 5**
- **Keyboard focus** was measured with real key events; the results are in slice 5's follow-up section. The Forms browser step repeats the Tab pass over its own card.
- **"No open times"** in Meet is now Optional.

**Files:**
- `frontend/js/readiness.mjs` (new; shared vocabulary)
- `frontend/js/readiness-view.mjs` (new; shared renderer)
- `frontend/js/forms-readiness.mjs` (new; rules)
- `frontend/js/forms.mjs`, which is mixed with the uncommitted Forms work: card, share controls moved, re-check hooks, fix actions
- `frontend/js/meet-readiness.mjs` and `frontend/js/meet.mjs` (moved onto the shared modules)
- `frontend/app.css`
- `backend/src/forms/service.mjs` (normalizer key order)
- `backend/test/forms-readiness.test.mjs` (new, 9 tests)
- `backend/test/meet-readiness.test.mjs`
- `backend/scripts/browser-check.mjs`

**Evidence (local; fake providers)**

`forms-readiness.test.mjs`: 9 of 9 pass. They cover:
- a live form that matches its draft;
- draft, closed, and changed-but-unpublished states, with named differences;
- validator problems as blockers;
- unreachable required questions, plus the combination cap;
- insertion problems;
- booking destinations: published, unpublished, deleted (admin) and invisible (member); an inactive Meet plan; a failed event-type load;
- live check failed, allowance used up, plan inactive;
- the normalizer regression.

One end-to-end test runs over the real local API:
- a conditional page-break form is not "changed" after publishing;
- a member gets Not verified rather than "deleted" for the owner's booking page;
- checking creates no response.

The browser journey confirms:
- five areas and no percentage;
- the booking-offer wording and the link to Meet readiness;
- the share link and embed sit in the Sharing area;
- real Tab presses show a visible focus indicator at every stop in the card;
- unsaved edits are named and not assessed;
- the preview action switches the presentation and moves focus;
- an unpublished form with an unreachable required question and an unknown insertion is reported, offers no share link, and Go to Publish focuses Publish without publishing;
- response, version, booking and handoff counts are unchanged.

Full checks ran on the working tree, including the uncommitted Forms reliability work:
- `npm run check`: 126 files.
- `npm test`: 163 tests; 160 pass, 0 fail, 3 skipped (PostgreSQL).
- `npm run browser-check`: every journey passes. 488 layout checks, with no runtime errors or overflow.

Screenshots reviewed, before and after at 1440 and 375 px:
- a template draft;
- a live form with unreachable logic and a draft booking destination;
- unsaved edits;
- a true phone-width load showing collapsed Ready areas.

The "before" captures come from a scratch copy of the working tree with only this slice's builder edits reversed, so they keep the uncommitted Forms work. They also show the false "Saved draft not yet published" badge.

**Known limitations:**
- The unreachable-question search tries representative answers, not every possible string. For the supported operators this covers every distinct rule outcome, but it is not a formal proof.
- Phones decide which areas are open when the card renders; rotating a device does not reflow them.
- Nothing here is real-provider or human evidence. No respondent comprehension of "Response received — choose a time" has been tested.

## Slice 7: Cross-product enquiries (response → booking → follow-up → needs attention)

**Problem.** Slice 3's trail lived inside one form's responses page. Someone using Forms, Meet and Flow together could not see every enquiry in one place: a booking made directly (not from a form) had no trail, and "needs attention" could not be found without opening each form.

**Behaviour now**
- **The page.** A new `/enquiries` page, signed in and workspace-scoped, lists every loaded form response plus every **direct** booking, each with its trail.
  - Form bookings are not listed twice.
  - Bookings superseded by a reschedule are skipped.
- **Links to it:**
  - an **Enquiries** button on the Forms dashboard and the Meet Meetings tab;
  - **Enquiries needing attention** on the Flow dashboard;
  - "See enquiries across all forms and bookings" on a form's Responses page.
- **Each row shows:**
  - who it is from: a name or email answer when the form asks for one, otherwise the receipt reference, or the invitee for direct bookings;
  - where it started ("Form: …" or "Booked directly: …");
  - when;
  - the linked booking reference;
  - the attention reasons;
  - a state in text and icon: Needs attention, Waiting, Not verified or Done.
  - An expandable **What happened** reuses the slice 3 trail (receipt → booking → each follow-up run and its task), with links to the form's responses or Meetings.
- **Needs attention:**
  - follow-up failed or retrying;
  - an open task created by a follow-up;
  - booking canceled;
  - booking could not be offered;
  - **booking offer expired unused** (new). The Forms handoff link lasts 2 hours (`HANDOFF_TTL_MS`) and the handoff keeps the status `offered`, so an offer older than that was never used. The per-form trail now shows this too.
- **Layout and filters:**
  - A summary banner counts reasons ("3 enquiries need attention: 2 open tasks, 1 booking offer expired unused").
  - Filters: All, Needs attention or Waiting; and started from anywhere, a form, or a direct booking. Filters are links, so a filtered view can be bookmarked.
  - Needs attention comes first, then the most recent: responses by arrival, direct bookings by appointment time.
- **Coverage is stated on the page.** It reads, for example, "Built from responses from 1 form (latest 50 each), bookings you can see (up to 300 per list), 2 Flow runs, 2 tasks. Older records may not appear." A source that fails to load is named in an error notice, and its parts show as Not verified, never as done.
- **Read-only.** The page changes no records (tested). It uses existing endpoints only:
  - `GET /forms`;
  - `GET /forms/:id/responses?limit=50` for the 20 most recently updated forms;
  - `GET /runs` and `GET /tasks` (latest 200);
  - `GET /bookings` for each of the three scopes.
- **Permissions are unchanged.** Members see responses (all roles can read them) but only bookings they host. A form booking hosted by someone else keeps the note "Follow-ups for this booking are not visible to your role", and other hosts' direct bookings are not listed.

**Authoritative vs not verified**
- **Authoritative, from Forms, Meet and Flow records:**
  - response receipt and booking state (including reschedules, through `next_step`);
  - run status and outcome;
  - task status.
- **Inferred:**
  - "Offer expired" from the handoff's age against the server's 2-hour TTL. The handoff row's own expiry is not returned by the API.
  - Respondent names from answers, using the shared field heuristics (a short-text "name" question, otherwise an email question).
- **Not verified:**
  - anything older than the loaded windows;
  - other hosts' bookings, for members;
  - email delivery;
  - whether an open task is overdue: tasks have no due date, so every open follow-up task counts as needing attention.

**Backend dependencies.** The proposal in [ENQUIRY_TRAIL_CONTRACT.md](ENQUIRY_TRAIL_CONTRACT.md) still applies, and this slice is its frontend baseline. In particular:
- a server-side enquiry list with pagination, so nothing falls outside a window;
- ownership and resolve actions;
- `offer_unanswered` computed on the server from `form_handoffs.expires_at`;
- a task due date, so `task_open` means overdue rather than merely open;
- a `created_at` on bookings in `GET /bookings`, so direct bookings can be ordered by arrival.

**Files:**
- `frontend/js/enquiries.mjs` (new; the page)
- `frontend/js/enquiry-trail.mjs`: direct-booking trail, `buildEnquiries`, reasons, offer expiry
- `frontend/js/forms.mjs`: trail loader and renderer exported, unique heading ids, current time passed in, link
- `frontend/js/flow.mjs` and `frontend/js/meet.mjs` (links)
- `frontend/app.js` (route)
- `backend/src/web.mjs` (page whitelist)
- `frontend/app.css`
- `backend/test/enquiry-trail.test.mjs`: 4 new tests, including one over the real local API
- `backend/scripts/browser-check.mjs`

**Evidence (local; fake providers, outbox email)**

`enquiry-trail.test.mjs`: 9 of 9 pass. The new tests cover:
- an offer expiring at exactly the 2-hour boundary, and no assumption without a clock;
- direct bookings: canceled, open task, and unreadable runs shown as unknown;
- joining without duplicates, rescheduled bookings skipped, names from answers, attention first;
- an end-to-end test over the real local API. A form response is routed to Meet and booked through the handoff, and an enabled Flow creates a preparation task; one offer is left unbooked past 2 hours; one booking is made directly. The test asserts:
  - three enquiries, with the form booking linked and not repeated;
  - reasons `task_open`, `offer_expired`, `task_open`;
  - a member sees no direct bookings and gets the role note for the linked booking.

The browser journey:
- reaches the page from the Forms dashboard link;
- lists both a form response and a direct booking;
- shows the coverage note;
- puts attention first, with the banner;
- has no duplicate ids;
- expands the trail;
- passes the filters;
- leaves response, booking, run and task counts unchanged;
- passes the layout checks.

Full checks ran on the working tree, including the uncommitted Forms reliability work:
- `npm run check`: 127 files.
- `npm test`: 167 tests; 164 pass, 0 fail, 3 skipped (PostgreSQL).
- `npm run browser-check`: every journey passes. 496 layout checks, with no runtime errors or overflow.

Screenshots reviewed:
- **Before:** `/enquiries` was a "This page took a wrong turn" 404, and the only trail was per form.
- **After:** at 1440 and 375 px, with a booked form response with an open task, an expired offer and a long-named direct booking.

**Known limitations:**
- Built in the browser: up to 20 forms × 50 responses, 200 runs, 200 tasks and 300 bookings per scope. These limits are stated on the page.
- The page makes one request per form, so it is slower for large workspaces.
- There is no ownership, assignment or "resolved" state: needs attention clears only when the underlying record changes (task done, run retried successfully).
- No moderated sessions have checked that operators find this faster than their current tools. That is the contract's research gate before building notifications on top of it.

### Readiness analysis correction (Codex continuation)
A text answer can include several condition phrases at once. The earlier finite sample could therefore call a reachable required question unreachable (page includes red; question includes blue; answer red blue). Text-includes paths now show Not verified with Preview guidance, rather than a false recommendation to change the form. A regression runs the shared renderer on that concrete reachable answer. Focused readiness tests: 10 pass. This is a limit of automatic analysis, not a publish blocker.

Release review update: reviewed matched desktop/phone screenshots for Meet readiness, Forms live/draft readiness and Enquiries. Added a fresh 375px navigation assertion to distinguish initial phone behavior from desktop cards resized for layout checks. Also fixed a finite-sample collision: a not-equals rule using the sample text "any answer" could produce a false unreachable warning; the checker now chooses a distinct witness. Both regression cases use actual shared-renderer visibility, and the focused Forms readiness suite is 11/11. The full unit run before that second small correction passed 168 tests (165 pass, 3 PostgreSQL skips). No claim of human validation or dark-mode verification: the app currently pins the light theme.

## Slice 8: server-backed Forms publish checks
Problem: readiness could repeat browser validation but could not distinguish live routing from saved unpublished changes.

Authenticated form payloads now include published_routing. POST /forms/:id/publish-check runs the same definition, routing/destination and entitlement checks as Publish against a saved revision, returning revision, checked_at, can_publish and actionable problems. It creates no form version, response, booking, email, follow-up or usage. Missing/cross-workspace records return 404, signed-out access 401 and stale revisions 409. Unexpected errors are not converted into success.

The card requests that check, names its revision, separates live routing from saved routing, and marks failed/stale checks Not verified. It does not prove booking links, inbox delivery or payments work. A generation guard prevents an earlier slow check from overwriting a newer result. Publish always revalidates. No database migration or runtime setting change.

API tests compare refused checks with actual Publish, assert no business-record side effects, preserve live routing across draft edits and cover workspace/auth/stale boundaries. Pure UI tests cover verified/failed/stale/blocked results; the browser journey asserts server confirmation and live-version text. This addresses the two earlier Forms backend-contract gaps. Human usability, provider behavior and PostgreSQL concurrency remain separate verification work.

Validation: syntax checks 128 modules; full latest unit/API run 172 total, 169 pass, 3 PostgreSQL skipped; shared logic sync passes. Browser journeys including server publish-result/live-routing assertions and fresh-phone behavior pass, with 496 layout checks. Reviewed desktop readiness screenshot. An earlier full run had one file-level Meet test-process failure; all 11 Meet tests passed separately, and the subsequent entire run passed. No production release yet for slice 8.

## Slices 9–11 (Claude, 28 October 2026): alerts, delivery reports, enquiry feed

- **Slice 9, operator alerts (released `79e83d5`):** the worker evaluates failure, backlog, settlement, unfunded-usage, capacity and budget conditions each minute and notifies a webhook and/or operator email. See [OPERATIONS.md](OPERATIONS.md#operator-alerts). No production channel is configured yet, so `MONITORING_CONFIRMED` stays false and Meet video stays off.
- **Slice 10, delivery reports (released `6b8eb48`):** a signed provider webhook records delivered/delayed/bounced/complained/failed/suppressed reports per message. Meet → Delivery, Flow history and enquiry trails separate local outbox, provider acceptance and mail-server delivery. Production currently uses the local outbox, so no real delivery has been observed. See [EMAIL.md](EMAIL.md).
- **Slice 11, enquiry feed:** a server-paginated feed of every response and direct booking, newest arrival first, with stored offer expiry and every follow-up per item. It replaces the browser's per-form and recency windows on `/enquiries`, and "Load older enquiries" works by keyboard. The feed changes no records. Server-computed states, ownership and task due dates remain open in the [contract](ENQUIRY_TRAIL_CONTRACT.md).

Evidence for all three: unit/API tests including signed-webhook, reminder, retry and pagination-with-ties cases, PostgreSQL CI, the full local browser journey with layout checks at 320–1280 px, and screenshot review. Not evidenced: real alert delivery, real provider delivery reports, large-workspace latency and any human usability result.
- **Slice 12, task deadlines and assignees:** the Flow task action can set a deadline (hours after creation) and assign the task to the booking's host or a fixed member. Flow › Tasks can change both, clear the deadline and filter to "Assigned to me", and keeps keyboard focus after each change. Enquiries treat a dated open task as waiting until its deadline, then as overdue. An open task without a deadline still needs attention, so nothing is hidden. Assignees must be current members, and leaving the workspace unassigns their tasks. This needed no new columns: `due_at` and `assignee_id` already existed for contact follow-ups. Not built: enquiry-level owner/resolve, reminders or notifications for deadlines, and any evidence that operators want deadlines in this form.


## Product-shell redesign — 28 October 2026

Continued Claude's uncommitted context, OAuth and sidebar foundations. Product hosts now keep their branding through landing/auth/account; signed-in workspaces use grouped left navigation, with one secondary product switcher and a keyboard-operable phone drawer. Removed redundant Open-current-product actions and the old Meet/Flow tab bars. Product onboarding demos stay within the selected product; Forms/Flow create local drafts and lead into their existing demo editors. Suite retains combined choices. No live guided-onboarding persistence or new production integration is claimed.

See [product shell contract and evidence](PRODUCT_SHELL.md). Local evidence: 207 unit/API tests (203 passed, four PostgreSQL skipped), syntax 141 modules, shared/vendor checks and a full 680-layout browser run. The final repeated browser run also passed all journeys and 680 layout checks; branch CI remains to be recorded. Cognitive benefits remain design hypotheses pending human testing.

## Slice 13: Persisted live onboarding, product-shell defect fixes and independent accessibility checks (28 October 2026)

- **Product-shell fixes (`frontend/design.css`, `frontend/app.css`, `frontend/app.js`, `frontend/js/studio.mjs`, `frontend/js/shell.mjs`, `frontend/js/enquiries.mjs`, `frontend/js/account.mjs`):**
  - Applied Forms purple and Flow copper accent variables across onboarding and marketing views; fixed setup sidebar workspace line break; prevented phone landing nav link wrapping at 375 px; stopped initial cookie-banner dismissal from scrolling to the footer; removed the decorative demo notification bell; added `id="demo-sidebar"` and `Escape` focus restoration for the mobile demo drawer; hid the redundant `Other Schedora products` menu in the Suite sidebar.
- **Persisted LIVE onboarding (`backend/migrations/012_live_onboarding.sql`, `backend/src/onboarding.mjs`, `frontend/js/onboarding.mjs`):**
  - Authenticated live setup at `/setup` and `/setup/(meet|forms|flow)`, separate from browser-local demo setup (`/start`).
  - Persists product selection (`selected_products`), current step (`active_step`), optional calendar skip state (`meet_calendar_skipped`), and created draft record IDs (`meet_event_type_id`, `forms_form_id`, `flow_id`) in `workspace_onboarding` across refreshes and sign-ins.
  - Uses real authenticated APIs (`PUT /schedule`, `POST/PATCH /event-types`, `POST/PATCH /forms`, `POST/PATCH /flows`, `POST /flows/:id/simulate`).
  - Never auto-publishes event types or forms, never auto-enables flows, never grants entitlements, and never calls a skipped optional calendar verified. Readiness reflects actual saved database records.
- **Independent accessibility checks (`backend/scripts/browser-check.mjs`):**
  - Automated checks verify mobile drawer focus trapping (`Tab`/`Shift+Tab`), `Escape` focus restoration, `inert` background, form control labelling, `role="alert"` validation announcements, WCAG AA contrast (>= 4.5:1), and 200% zoom + WCAG 1.4.12 text-spacing reflow at 640 px and 320 px.
  - Real screen-reader testing (NVDA, VoiceOver, TalkBack) and human usability testing remain open and are not claimed as completed.
- **Email and video operational verification:**
  - Verified monitoring (`backend/src/platform/monitoring.mjs`, `backend/scripts/alert-test.mjs`), signed email delivery webhook handling (`backend/src/platform/email-events.mjs`), and production readiness gates (`backend/src/production.mjs`, `backend/src/video/config.mjs`). Production video (`MEET_VIDEO_ENABLED=false`) and recharge remain disabled until provider credentials, webhooks, monitoring channels and live smoke evidence are approved. Wording everywhere separates local outbox, provider acceptance and mail-server delivery without claiming inbox delivery.


### 2026-10-28 — Real authentication matches the selected welcome design

Pain: the real account page looked unrelated to the polished demo, and users faced multiple account forms. Implemented the user's chosen `/start` split-screen design for real login/signup, with only one primary form per route and product-scoped benefits. Suite retains all three. New signup defaults to the appropriate persisted setup; old `/account` links still work. This is a user-selected design change, not a validated conversion improvement. Existing auth, access rules and commercial plans remain unchanged. Product shell documentation and design QA contain the verification scope.


### 2026-10-28 — Reconcile current release evidence and remaining acceptance gates

Inspected main 328ed25, enquiries.mjs, Flow task service, monitoring implementation, tests and final main CI (40681407234: success). Corrected historical local/uncommitted labels and superseded Enquiries coverage limits in current scope documents; preserved historical release notes. Added RELEASE_ACCEPTANCE.md separating implementation/CI/deployment, real-provider outcomes, accessibility checks, commercial approval and human validation. Corrected the owner's manual auth URL from unsupported /signin to /login. No new customer research, provider activation, pricing decision or application behaviour was introduced. Monitoring and real email remain first operational gates; readiness backend evidence and per-form history remain independent engineering opportunities.


### 2026-10-28 — Preserve older per-form follow-ups and tied response arrivals

Pain confirmed in source: the response inbox used only the latest 200 workspace runs/tasks and three capped booking lists, so an older response could say no follow-up was recorded despite existing history. Timestamp-only paging could also omit responses with the same arrival time. Success criterion: every loaded response gets its own authorized full follow-up history, and stable paging reaches tied arrivals once each; attention filtering must not hide the load action.

Reused Enquiries subject-scoped authorization/hydration in the response API, added stable timestamp/id next cursors with legacy timestamp compatibility, and accumulated per-page context in Forms. Failed/missing evidence stays unknown. Paging now announces its result and preserves focus; repeated clicks are guarded. Tests include 61 tied arrivals, an old task behind 210 unrelated runs/tasks, member-hidden booking follow-ups, unauthenticated/other-workspace denial and context deduplication. No migration or live provider change. Final browser/CI/release evidence is recorded in the external progress checkpoint.


### 2026-10-28 — Calendar success evidence and working live calendar setup

Confirmed that `last_synced_at` changes on failed attempts, and that the live onboarding form sent `url` instead of the required `feed_url`. Added separate nullable successful-sync evidence, truthful freshness/failure labels, reconnection invalidation and first-sync failure handling. No success is backfilled for older rows. This fixes a functional onboarding blocker as well as evidence quality; team readiness remains unverified. Details, migration/rollback and tests: CALENDAR_SYNC_EVIDENCE.md. Local syntax 144 modules, tests 215 total / 210 pass / five opt-in PostgreSQL skips; browser 760 layout checks, fake feed only. Exact CI and any release state are recorded separately, never inferred from these local results.


### 2026-10-28 — Record owner-approved video recharge economics

Owner approved the retained 30%-of-cost markup after payment fees, no customer GST under the confirmed unregistered status, and purchased-credit carry-forward/no automatic expiry. Added VIDEO_RECHARGE_PRICING.md with the formula and verified arithmetic; kept infrastructure-only scenarios distinct from fully loaded costs and live prices. No application, billing configuration, catalog or activation flag changed. Operational video/recharge gates and measured full costs remain outstanding.

## 28 October 2026 — Isolate operator alert transport

Pain: configuring operator email previously required turning customer email delivery on as well. Production currently uses outbox; existing HTTP credentials alone do not establish provider delivery.

Added explicit ALERT_EMAIL_PROVIDER=http opt-in using the existing private HTTP email credentials and sender. Default inherit preserves behavior. Customer transport, queues, stored evidence, commercial settings and video gates remain unchanged. Configuration rejects missing credentials or non-HTTPS production alert endpoints. The alert-test script and worker use the same isolated provider.

Validation: syntax 144 files; full local suite 216 tests, 211 passed, five optional PostgreSQL skips, no failures. The added regression sends to a captured HTTP provider, proves queued customer mail stays outbox, checks operator-only recipients/no customer content, tests retries and confirms alerts never enter customer history. No frontend changed, so no new screenshot/keyboard claims. CI/release and real alert receipt remain separate gates; no production confirmation flags set.

## 29 October 2026 — Verify monitoring and harden production payment setup

Monitoring acceptance is now backed by actual operator-test Inbox receipt and an independent UptimeRobot controlled failure/recovery (incident373837337120738356) with owner-confirmed DOWN/UP emails. API/database and worker keyword monitors are Up; MONITORING_CONFIRMED was saved/read back on Render and deployed successfully. Five-minute polling and free-host limitations remain explicit. Video and recharge stay disabled.

A payment-readiness audit found billing provider none / mode open in the live public config, with a live-format Razorpay key stored privately. Format is not authentication evidence. Added a read-only merchant connection script (GET plans, discard response body, no database or financial writes) and production enforcement rejecting test-format Razorpay checkout keys. Development/test fixtures remain supported. Regression verifies subscription/recharge refusal before any database/provider action, no redirect of credentials, no merchant-body parsing and sanitized failure handling. No price, allowance, entitlement, expiry or live checkout setting changed. Real authentication is unverified until the private production check runs; successful authentication will not prove capture/refunds/webhooks.

## 29 October 2026 — Scoped zero-spend video validation pilot

Owner confirms zero upfront infrastructure spend and requests recharge retained in scope; physical computer/phone checks are unavailable now. Added an explicit single-workspace validation stage, separate from general production enablement and smoke confirmation. Production pilot requires Cloud credentials, verified permanent webhook, encryption and monitoring. Server clamps new instant rooms to two people,15minutes,one concurrent room/two global participants; pilot receives60 free participant-minutes per UTC month only in its selected workspace. Nonselected workspaces, legacy out-of-limit rooms and scheduled native-video admissions remain blocked. Client fields cannot expand scope. Removing the workspace stops new admission; existing connected rooms require End/terminate for immediate disconnection. No commercial price/checkout, entitlement or purchased-credit policy changed.

Authenticated workspace metadata exposes only its own pilot status. Public config keeps general video off; room views give invited guests scoped availability. Video dashboard states actual limits, hides scheduled rooms, and disables joining legacy rooms outside limits. Pilot billing view retains wallet visibility. A controlled provider script creates/reads/deletes only one new empty diagnostic room without DB/media/tokens or paid features; it does not certify media, webhooks or settlement.

Evidence before branch CI: syntax148files; full local regression before the last diagnostic-only test was added:221 total,216pass,5optional PostgreSQL skips,0fail; latest pilot-specific3tests pass. Browser journeys passed768 layout checks, including pilot controls, wallet visibility and non-pilot refusal;375/1280 screenshots reviewed, no overflow. Final branch CI must also cover the newly extended create-to-prejoin pilot journey and diagnostic test before release. Production activation/media is not yet claimed.
