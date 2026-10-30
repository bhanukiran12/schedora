# Team-event setup evidence

Design contract, 30 October 2026. **Proposed; endpoint and team UI are not implemented.** Existing readiness still shows other hosts as Not verified. This contract closes a specification gap, not a release or customer-validation gate.

## Job and evidence

A team event owner needs to identify which host needs setup before sharing a booking page, without asking every host to reveal their private calendar. The success criterion is correctly identifying a missing connection or stale conflict check and the person who can fix it. A connection alone must not imply successful meeting-link creation or future availability.

Official competitor observation: Calendly lets admins inspect connection status, while each user connects and controls their own calendars. Its availability documentation distinguishes schedules from connected-calendar busy times. Sources checked 30 October: [Admins FAQs](https://calendly.com/help/admins-faq), [Availability overview](https://calendly.com/help/availability-overview). These are vendor capability descriptions, not evidence of causal conversion lift, customer demand or Schedora superiority.

Schedora design hypothesis: per-host setup evidence, including successful-check freshness separately from connection status, helps operators diagnose a team booking problem. Test comprehension and recovery time against the current Not verified message. No interviews or comparative task studies have been run.

## Current code constraints

- `backend/src/meet/event-types.mjs:getEventType` permits assigned hosts or roles with `meet.manage_all`; unmatched workspace/resource combinations return 404.
- `backend/src/platform/workspaces.mjs:PERMISSIONS` limits `meet.manage_all` to owner/admin. Do not change that role matrix implicitly.
- `backend/src/meet/bookings.mjs:hostSchedule` uses a personal schedule only when `use_host_schedules` is true AND a saved personal schedule exists. Otherwise it falls back to the event schedule. Missing personal hours therefore cannot automatically be called a broken event.
- Calendar `last_synced_at` is the last attempt; `last_success_at` is successful busy-time evidence. Cached blocks can remain after a failed attempt. Do not substitute one timestamp for the other.
- OAuth integration status is active/revoked/error. It is not a completed test of meeting-link creation. The released assessor already preserves this distinction.
- Existing calendar endpoints remain self-only. This feature must not let an administrator connect, disconnect or resync another host's calendar.

## Proposed read-only API

`GET /api/workspaces/:ws/event-types/:id/host-readiness`

Initial implementation: browser session only; API-key access returns 403 rather than silently adding a new integration-status export. Apply normal authentication, `meet.manage_own`, workspace membership and `getEventType` resource authorization before reading any host setup. Use a read transaction so host assignment, role and setup are evaluated consistently. No provider calls, sync jobs, emails, bookings, grant changes or writes occur on this GET.

Return `event_type_id`, `event_updated_at`, `checked_at`, `scope` (`all_hosts` or `self_only`) and `hosts`. Times are integer Unix milliseconds from the server clock. `checked_at` means the stored evidence was read; it must never become a successful sync timestamp.

Each host entry contains:

| Field | Contract |
| --- | --- |
| `user_id`, `name` | Assigned host identity already available in the authorized event response; no new email/account address field |
| `visibility` | `summary` for self and owner/admin; otherwise `restricted` |
| `calendar` | Summary below, or null when restricted |
| `meeting_links` | One entry for each distinct configured automatic location: provider, connection state, creation evidence; null when restricted |
| `schedule_source` | `personal` or `event_fallback` for summary viewers; null when restricted. Derived using the same selection as the booking engine, never a second independent fallback algorithm |

Return all assigned host identities to an authorized co-host so missing rows cannot be mistaken for verified hosts, but replace every other host's setup fields with null and `visibility: restricted`. Owner/admin can inspect every assigned host's coarse summary. A non-host member does not gain event access. Role downgrade/removal must apply on the next request, including while an editor is open. Never return setup from another workspace just because the user ID matches.

No feed URL, calendar label/name, calendar ID, busy count, busy time/event, personal schedule rules/time zone, integration ID/account, tokens, credentials, raw provider errors, email or phone number may appear. Project explicit columns into explicit response objects; never spread database rows. Do not put response contents or private IDs into diagnostic logs. Use authenticated private/no-store response handling; no shared or cross-user cache.

### Calendar summary

Expose only `state` and `coverage`; omit underlying timestamps and connection counts from this initial shared summary. Derive freshness with the existing one-hour policy from `meet-readiness.mjs`, using a single named shared policy during implementation rather than maintaining two unrelated constants.

| Stored evidence | `state` / `coverage` | Meaning |
| --- | --- | --- |
| No connection | `not_connected` / `none` | Optional conflict-coverage limitation, not an event blocker |
| Every connection active, each with nonfuture success at most one hour old | `checked_recently` / `current` | Connected calendars were checked recently; unconnected calendars and changes since then are unknown |
| Every connection pending, without successful evidence | `waiting` / `unknown` | First successful check not recorded |
| Every connection revoked | `revoked` / `none` | Previously connected calendars are no longer checked |
| Every connection errored | `failed` / `unknown` | Latest checks failed; do not claim cached blocks are fresh |
| Every connection active but at least one success absent/stale/future | `not_verified` / `unknown` | Connected does not prove recent conflict coverage |
| Mixed states (including one fresh connection and one failed/pending/revoked) | `partial` / `unknown` | Some connected calendars need attention; a single fresh one cannot make the host green |
| Unknown legacy status or unusable evidence | `not_verified` / `unknown` | Fail closed on the claim, without inventing a cause or changing booking policy |

An empty successful calendar is valid evidence; zero busy periods does not mean sync failed. A failed latest attempt remains failed/partial even when the previous success is recent. Summary states do not alter existing cached-block retention or worker scheduling.

### Meeting-link summary

Map only configured locations: Google Meet → google, Zoom → zoom, Teams → microsoft. For each host/provider return `connection: connected|not_connected|revoked|failed|not_verified` and `creation: not_verified`. Active means connected, never creation verified. Missing connection is a required setup problem for an automatic location. Provider failure/revocation cannot be inferred from a generic network error.

Do not include payment integrations, unrelated apps or another workspace's connection. Native Schedora video retains its separate pilot/production gates and is not an OAuth connection. Static links and in-person locations need no automatic-link connection row.

### Availability and overall readiness

This endpoint reports host setup evidence, not bookability or an overall Ready badge. The UI must continue to use the existing server slot calculation and its exact checked date range. Collective events require the appropriate joint availability; round robin needs an eligible available host, not necessarily every host free. Avoid inventing new all-host blocking rules from setup summaries. No open slots, unavailable slots, publish status, entitlements and expired dates keep their existing separate semantics.

No personal schedule is not automatically a blocker because the actual engine may use the event fallback. A shared snapshot is not a reservation; admission and booking still revalidate on the server.

## Frontend acceptance

- Keep the existing first-screen headline and Required / Optional / Not verified vocabulary. Add a collapsed host breakdown with a meaningful text label; do not dump another long checklist onto phone screens.
- Show host name and the reason/action, for example: “Ravi: Calendar check failed. Ask Ravi to check their connection.” Do not expose the provider's raw error message.
- Self actions may lead to the existing own-calendar/app settings. Other-host rows offer explanatory text only; no impersonation, auto-email, invite or settings mutation.
- Ordinary co-hosts see “Only this host and workspace admins can see their setup.” Never turn restricted data into a success icon.
- Check again re-fetches saved evidence. It does not synchronize a calendar, test a link, send an email, or publish. Loading/failure leaves the prior snapshot explicitly dated or marks it unavailable; no silent green fallback.
- Unsaved event edits remain excluded. An old response for a different event, workspace or save revision must not replace the current card. Announce updates in the existing live region without moving focus.
- Controls have visible keyboard focus, text as well as colour, proper expanded state and usable 320/375 px layouts. Test keyboard, zoom/reflow and screenshots on the resulting UI; this document is not visual evidence.

## Required verification before release

| Case | Required result |
| --- | --- |
| Anonymous / cross-workspace / non-host member | Existing 401/404 semantics; no setup leaked |
| Owner and admin, including admin who is not a host | Every assigned host's coarse summary, no private fields |
| Ordinary assigned co-host | Own evidence only; other rows restricted with null setup fields |
| API key, revoked session, removed member, demoted admin | No expanded access; fresh authorization on each request |
| Same person in two workspaces | Connections never cross the workspace boundary |
| Fresh/empty success; missing/old/future success; recent failed attempt; revocation; mixed calendars | Exact calendar table above; no green result from partial evidence |
| Google/Zoom/Teams active/revoked/error/missing; unrelated/payment apps | Only relevant providers; creation always unverified |
| Personal hours selected/missing, event fallback, collective and round robin | Matches booking-engine semantics; no invented host blocker |
| Provider/raw error includes a sentinel token, feed label and private appointment data | None appears in response/logs or restricted rows |
| Repeated GET/refresh; role and assignment changes; stale UI response | No writes or provider calls; new permissions respected; stale response discarded |
| SQLite and throwaway PostgreSQL over TLS | Same response/state/authorization results; no migration expected |
| Browser keyboard/mobile/error paths and consenting operator task | Automated/visual results recorded separately from human task outcome |

Implementation order: shared pure policy and permission tests → read-only endpoint → editor integration and browser checks → exact-commit CI → verified release. Do not announce this as supported until implemented and deployed. Remaining research question: can an operator identify the host who needs action without mistaking “checked recently” for a guarantee of no conflicts? Record actual task results, not an assumed psychological benefit.
