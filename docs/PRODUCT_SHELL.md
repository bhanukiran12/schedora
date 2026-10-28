# Product context, routes and navigation

28 October 2026 · Implementation contract for the product-shell redesign (branch `codex/product-shell`). One shared account, session and workspace model across products. Product context controls presentation only; entitlements still come from the server.

## Context rules

1. **Host first.** `meet.` (and legacy `book.`), `forms.` and `flow.` subdomains of the product domain fix the context to that product for every non-public page on that host. In development, `meet.localhost` and similar names behave the same way.
2. **Then route.** On the apex domain and on local/preview hosts, `/meet…`, `/forms…`, `/flow…` and `/products/<product>` select that product. Everything else is Suite.
3. **Public pages keep their own identity.** Booking pages, management links, rooms, polls, recaps, public forms and embeds render as before on any host and are never redirected.
4. **Context never grants access.** Entitlement notices and API permissions are unchanged; a Suite subscriber entering on `meet.` sees Meet only.

The rules are implemented once in `frontend/js/context.mjs` (pure functions, unit-tested) and used by the router, header, sidebar and auth pages.

## Route matrix (production hosts)

| Host · path | Signed out | Signed in |
| --- | --- | --- |
| `schedora.in/` | Suite landing | Suite landing with a "Go to your workspace" link (Suite shell begins at `/enquiries`, `/account`) |
| `schedora.in/products/meet` (forms, flow) | Client redirect (not an HTTP 308 response) to `https://meet.schedora.in/` | same |
| `schedora.in/meet`, `/meet/event-types/…`, `/meet/contacts/…` (and Forms/Flow app routes) | Redirect to the same path, query and hash on the product subdomain | same |
| `schedora.in/account`, `/billing`, `/enquiries`, `/start`, `/demo` | Suite sign-in / plans / demo | Suite shell |
| `meet.schedora.in/` | **Meet landing** | Replaced with `/meet` (Meet dashboard) |
| `meet.schedora.in/meet?tab=…`, `/meet/event-types/…`, `/meet/contacts/…` | Meet sign-in page with return to the same address | Meet shell, section from the path |
| `meet.schedora.in/account`, `/billing`, `/enquiries` | Meet sign-in / Meet plans context | Meet shell |
| `meet.schedora.in/start`, `/demo` | Meet-only demo onboarding / Meet demo (`/demo` → `/demo/meet`) | same (demo never uses live data) |
| `meet.schedora.in/forms…` or `/flow…` (app routes of another product) | Redirect to that product's subdomain, same path | same |
| `meet.schedora.in/products/forms` | Redirect to `https://forms.schedora.in/` | same |
| Public: `/meet/<ws>/<type>`, `/embed/meet/…`, `/meet/manage/…`, `/meet/pay/…`, `/meet/room/…`, `/meet/join/…`, `/meet/poll/…`, `/meet/<ws>`, `/recap/…`, `/f/<slug>`, `/privacy`, `/terms` | Unchanged on every host | Unchanged |

Forms and Flow follow the Meet rows with `/forms` and `/flow` as their dashboards. Local and preview hosts (`localhost`, `*.vercel.app`) never redirect between hosts; they use the route rules only.

**Sign-in returns.** Password sign-in stays on the current host and returns to the safe same-host path (`/…`, never `//…`). Google sign-in starts on the API with `next` set to the absolute product address; the server accepts only `https://` on the product domain or its `meet.`/`forms.`/`flow.` subdomains with an allowed path, and returns errors and "Google connected" to the same product host. The session cookie is scoped to `.schedora.in` in production (verified from the response header on 28 October), so one sign-in and one sign-out cover every product.

## Navigation structure

App pages for signed-in members use a left sidebar instead of the site header and tab rows.

| Product | Groups and destinations |
| --- | --- |
| Meet | **Scheduling:** Event types, Meetings, Video, Polls · **People & follow-up:** Contacts, Meet reminders (the former "Workflows" tab; Meet-only email reminders, distinct from the Flow product) · **Insights:** Analytics, Notes & AI · **Setup:** Calendars & apps, Email delivery |
| Forms | **Forms:** All forms · **Responses:** Enquiries |
| Flow | **Automations:** Flows, Run history, Tasks · **Follow-up:** Enquiries |
| Suite | **Products:** Meet, Forms, Flow (open on their own hosts) · **Across products:** Enquiries |

Every sidebar ends with the same lower area: workspace selector (or name), Account & settings, Plans & billing (owners and admins), the signed-in person, and one "Other Schedora products" menu. That menu is the only product switcher in a product shell; there is no "Open <current product>" button.

Phones (< 900 px) get a top bar with the product name and current section plus a "Menu" button that opens the same navigation as a drawer (`aria-expanded`, focus moves into the drawer, Escape and the close button return focus to the toggle, background is inert).

The current page is marked with `aria-current="page"`, a filled background, a left bar and bold text, not colour alone.

## Decisions and evidence

| Decision | Observed problem | Intended benefit | Evidence level |
| --- | --- | --- | --- |
| Host-based product context | `meet.schedora.in/account` and `/start` rendered Suite branding (screenshots 3 and 5) | Orientation: people stay in the product they chose | Direct observation of the defect; no user test |
| Left sidebar with groups | Ten Meet destinations competed in one row with a "More" overflow (screenshots 1–2) | All destinations visible and grouped by task, fewer hidden items | Common pattern for multi-section tools; not tested with Schedora users |
| Remove "Open Meet" and header "Schedora apps" in product shells | Redundant control to the current product and a promotional switcher in the task area | One primary action per page; switching still available in one secondary place | Direct observation; usability effect unmeasured |
| Product landing at the product root | Meet domain root showed a generic sign-in hero with unqualified claims ("payments and AI recaps included") | People understand the product before creating an account; claims match configured capability | Copy review against current configuration (payments and AI depend on provider setup) |
| Entry-product onboarding | Demo onboarding asked a Meet visitor to choose all products and declared "Everything is in place" with the calendar skipped (screenshots 5–6) | First useful outcome without learning the suite; skipped steps shown as skipped | Direct observation; outcome unmeasured |
| Product-scoped demo navigation | Meet demo listed All products, Forms and Flow and a decorative bell | Demo matches the live product structure | Direct observation |

None of these establishes a conversion or satisfaction effect. The moderated tasks in `UX_RESEARCH_PLAN.md` remain the way to test them.

## Not part of the screenshots

The flame character in every screenshot is drawn over the Windows taskbar and the Snipping Tool notification, and no Schedora file contains it. It is a desktop overlay, not part of the product, and was left alone.


## Implementation and verification — Codex continuation, 28 October

Connected the prepared context/config/shell modules to the actual app router. The live product screens use the sidebar, while public booking, management, payment, room and form links retain their own views. Product-host roots show product introductions signed out and enter their dashboard signed in. Account presentation uses the host context; authentication shows one primary form, an expandable alternative and optional organisation SSO. Google sign-in uses the official supplied mark and allowlisted product return addresses. No cookie scope or entitlement rule changed.

Product demo entry retains the selected product. Meet skips the Suite product chooser; Forms and Flow have independent draft setup, edit/preview or simulation handoffs. Suite retains all choices and links to each selected setup. These are explicitly browser-local demo journeys: they create no live account, calendar connection, booking, email or subscription. Existing live editors and readiness checks remain the real setup paths. This release does not newly implement a persisted live multi-product onboarding wizard.

Verification: local unit/API suite 207 total, 203 pass, four opt-in PostgreSQL skips; syntax 141 modules. Shared Forms and pinned SDK checks pass. The full browser run passed every existing journey plus all three product-host landing/auth/account/dashboard/setup/demo journeys and drawer Escape/focus/inert checks, with 680 layout checks at 320/375/768/1280. These theme-labelled checks exercise the app's fixed light theme. The repeated full browser run also passed all journeys and 680 layout checks after auth navigation was simplified and cookie banners dismissed for product screenshots. No real Google consent, customer usability study, screen reader or production domain smoke has been performed in this run. PostgreSQL/Linux CI must pass on the pushed branch before merging.

Reviewed desktop sidebar/editor and phone authentication/account/setup screenshots. The first test attempt used outdated tab selectors and consequently lost its workspace fixture; that run failed. Updated navigation assertions to the implemented drawer contract; the subsequent full run passed. Screenshots are kept outside Git in the ChatGPT workspace under outputs/product-shell-*. Google mark source: https://developers.google.com/static/identity/images/g-logo.png; branding guidance: https://developers.google.com/identity/branding-guidelines .

Main was b46e943 at fetch. This branch also contains Claude's previously committed task-deadline/assignee increment 2a4ea83, which the full-tree tests include. No production setting, video gate, price, credential, payment or migration is added by the shell redesign. Push/review the branch before merging to production.

## Persisted live onboarding, product-shell defect fixes & accessibility verification — 28 October

1. **Product-shell review and visual/behavioural defect fixes:**
   - Fixed product accent tokens in `frontend/design.css` so Forms (`#6941d9`) and Flow (`#b64d18`) keep their product colours across `/start` onboarding outcomes and marketing views instead of falling back to Meet green.
   - Fixed `.ds-setup-body > aside .ds-connected` so `Your workspace` and `Northstar Studio` render on separate lines instead of running together.
   - Adjusted phone header navigation spacing in `frontend/app.css` so `Features · How it works · Try the demo · Plans` fit on a single row at `375px` width.
   - Fixed `consentBanner` in `frontend/app.js` so dismissing the initial cookie banner focuses `#main` (`preventScroll: true`) instead of scrolling the viewport to `#cookie-settings` in the footer.
   - Removed the non-functional decorative notification bell button from `.ds-appbar` in `frontend/js/studio.mjs`, wired `id="demo-sidebar"` and keyboard `Escape` focus restoration for the mobile demo menu, and preserved product context on signed-out `/enquiries` and `/billing`.
   - Hid the redundant `Other Schedora products` switcher on Suite pages (`product === 'suite'`), where `Meet`, `Forms` and `Flow` are already listed in the primary sidebar navigation, and added `Guided setup` (`/setup` or `/setup/<product>`) to `.side-bottom`.

2. **Persisted LIVE workspace onboarding (`/setup`, `/setup/meet`, `/setup/forms`, `/setup/flow`):**
   - Added `012_live_onboarding.sql` (`workspace_onboarding` table) and PostgreSQL upgrade `postgres_v11_live_onboarding` (`backend/src/postgres-sql.mjs`, `backend/src/postgres.mjs`).
   - Added `GET /api/workspaces/:ws/onboarding` and `PATCH /api/workspaces/:ws/onboarding` (`backend/src/onboarding.mjs`) and `frontend/js/onboarding.mjs`.
   - Separate and explicitly labelled from browser-local demo setup (`/start`). Progress is persisted in the workspace database across browser refreshes and sign-ins.
   - Suite users can choose which products (`meet`, `forms`, `flow`) to set up without purchasing a plan or changing entitlements.
   - Supports skipping the optional Meet calendar step (`meet_calendar_skipped: true`), which is explicitly labelled `Skipped · not verified` and never reported as a connected or verified calendar.
   - Saves real working hours (`PUT /schedule`), unpublished draft event types (`POST / PATCH /event-types`), unpublished draft forms (`POST / PATCH /forms`) and disabled draft workflows (`POST / PATCH /flows`), plus safe workflow simulations (`POST /flows/:id/simulate`).
   - Readiness in `/setup` is computed strictly from actual saved records (`assessReadiness`, `assessFormReadiness`, server `checkFormPublish`, and saved flow status). Deleting a record immediately updates onboarding readiness. Live onboarding never auto-publishes event types or forms, never auto-enables flows, and never grants entitlements.

3. **Independent accessibility checks:**
   - Verified automatically in `backend/scripts/browser-check.mjs`: mobile drawer focus trap (`Tab` and `Shift+Tab` wrap inside `#app-sidebar`, background is `inert`, `Escape` closes and restores focus to `#side-open`), explicit form control labels, `role="alert"` error announcements on invalid submit, WCAG AA contrast ratios (>= 4.5:1), and 200% zoom / text-spacing reflow at `640px` and `320px` with zero horizontal overflow across 696 layout checks (`320/375/768/1280` px).
   - **Still requires human / assistive-technology testing:** real screen-reader traversal and live-region announcement timing with NVDA (Windows), VoiceOver (macOS/iOS) and TalkBack (Android), hardware switch/voice control, and moderated human usability sessions.
