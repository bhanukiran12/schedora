# Schedora frontend design implementation

Source: Figma file `tF7dXunSUiPZw5m8atVGpn`, Page 1. Implemented 24 October 2026.

The existing vanilla JavaScript SPA is retained. No new runtime dependencies, backend routes, credentials, database migrations or payment changes were introduced. Figma's “Book” is presented as the approved “Meet” product name.

## Entry points

- `/`: Figma-inspired ecosystem homepage, product discovery, connected journey, use cases, value, plans, roadmap, FAQ and demo entry.
- `/products/meet`, `/products/forms`, `/products/flow`: existing product introductions; primary buttons continue to the real product subdomains. Each now also links to its interactive demo.
- `/start`: local onboarding introduction, product selection, calendar connection simulation, weekly hours and first event, ready-to-share preview.
- `/demo`: combined workspace overview, with product sidebar, search, activity, people, settings and notifications.
- `/demo/meet`: scheduling overview, event creation/editing, availability, booking preview and local booking management.
- `/demo/forms`: form management, templates/duplication, builder, classic/conversational preview, response inbox and CSV export.
- `/demo/flow`: workflow management/editor, trigger/action simulation, run history, failed-run review/retry and task completion.

## Interaction coverage

Meet: create/edit event types; set duration, location, buffer and notice; publish/unpublish; copy preview links; change weekly hours and timezone; choose a day/time; validate sample attendee details; create a local booking; review, reschedule or cancel. Preview slots respect enabled weekdays, working hours, existing local bookings and buffers. Minimum notice and real calendar conflicts are explicitly not enforced in this preview.

Forms: create, edit, duplicate and publish/unpublish; rename and describe a form; choose classic or conversational presentation; add/edit/remove/reorder questions; required text, long text, email, number, date and dropdown answers; submit a local response; inspect answers; export CSV with formula-injection protection. Conditional branching and production file upload are not newly implemented in this local preview; the existing live builder remains available separately.

Flow: create/edit/delete local workflows; choose booking or response trigger; prepare an email preview or create a local task; enable/draft status; simulate with a sample recipient; inspect results; resolve missing-email failures and retry; complete tasks. Existing sample brief/intake cards are labelled conceptual; the simulator does not claim to create a real meeting brief or send an intake email.

Shared: workspace rename, sample profile settings, demo team members, workspace search, quick create, notifications, help, local reset, responsive sidebar and theme-aware design tokens.

## Service boundary

The preview uses `schedora.design-preview.v1` in localStorage. It never stores passwords or API keys and never authorizes a calendar, sends an email, charges money, creates real appointments or invites real members. Direct `/demo` and `/start` loads skip config/session requests. Preview data belongs to the current browser origin, so it is not shared between subdomains/devices. Clearing browser storage resets it.

The current live `/meet`, `/forms`, `/flow`, `/account` and `/billing` flows remain in place. The new preview must be connected deliberately rather than swapping local sample data into production screens. Demo routes are excluded from indexing.

## Backend integration work for the next phase

1. Replace the local repository (`demo-store.mjs`) with adapters to existing authenticated workspace endpoints and map actual DTOs. Remove sample seed metrics; keep explicit empty/loading/error states.
2. Connect onboarding to real signup/workspace creation without persisting credentials client-side. Replace calendar simulation with the existing OAuth flow.
3. Map event/availability writes and booking submission to live APIs; keep server timezone conversion, conflict checking, notice, holds and rate limiting authoritative.
4. Map form schema, publication and response handling to live APIs. Port conditional logic and add uploads only with server validation, storage rules and limits.
5. Map workflow authoring/run history to real actions and worker status; preserve idempotency and retry controls. Implement multi-step intake/brief concepts only after backend support exists.
6. Bind role-based controls to server permissions. Demo people controls are not invitations or access grants.
7. Leave live Razorpay subscription charging gated until approved prices, webhook verification and payment tests are complete.

## Assets and verification

Source PNG marks and SVG icons are bundled under `frontend/assets/figma`; no temporary Figma URLs are used by the app. Inter is bundled with its OFL license. Existing approved transparent logos remain unchanged for live screens. Existing shared safe templating, form validation, dialogs, notifications and copy helpers are reused.

Use `node backend/scripts/design-preview.mjs` for the isolated frontend preview on port 4176; it does not load `.env` or the database. Unit tests cover unavailable/corrupt local storage, working hours, booking overlap/buffers, simulation outcomes and safe CSV output. Browser QA evidence is recorded in `design-qa.md`.

Design guidance used: Product Design (source-based implementation and QA) and UI UX Designer (SaaS hierarchy, accessibility, clear primary actions and usable state handling). No additional design-generation credits were required.
