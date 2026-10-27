# Developer guide: REST API, webhooks and MCP

## Authentication
Create an API key under **Account → API keys**. Send it on every request:

```
Authorization: Bearer sch_...
```

A key acts as the member who created it, inside one workspace only, with that member's role. Requests with a key need no CSRF token. Keys are stored as hashes; a revoked key stops working immediately. Limit: 600 requests per minute per workspace.

All endpoints are under `https://schedora.in/api`. Request and response bodies are JSON. Errors look like `{"error": {"code": "slot_unavailable", "message": "...", "field": "start"}}`.

## Common endpoints (`/api/workspaces/{workspace_id}/...`)

| Method and path | Purpose |
| --- | --- |
| `GET /event-types` · `POST /event-types` · `PATCH/DELETE /event-types/{id}` | Event types: kind (`one_on_one`, `group`, `collective`, `round_robin`), hosts, hours, limits, locations, questions, price, one-off settings |
| `GET /event-types/{id}/slots?from=YYYY-MM-DD&days=14` | Open start times (UTC) |
| `POST /bookings` | Book for someone: `{event_type_id, start, name, email, timezone, override?}`; optional `Idempotency-Key` header |
| `GET /bookings?scope=upcoming\|past\|canceled&event_type=&host=&contact=` | Meetings, with answers, location and email status |
| `POST /bookings/{id}/cancel` | `{reason, whole_meeting?}` |
| `GET /bookings/{id}/prep[?ai=1]` | Meeting preparation: history, notes, recaps, optional AI brief |
| `GET/POST /contacts`, `GET/PATCH/DELETE /contacts/{id}`, `POST /contacts/{id}/notes`, `POST /contacts/{id}/follow-ups` | Contacts |
| `GET/POST /workflows`, `PATCH/DELETE /workflows/{id}` | Email and SMS workflows |
| `GET/POST /polls`, `POST /polls/{id}/confirm` | Meeting polls |
| `GET /analytics?from=&to=&tz=` | Totals, by event type and host, daily counts, weekday × hour heatmap |
| `GET/POST /transcripts`, `POST /transcripts/{id}/recap` | Transcripts and AI recaps |
| `POST /notetaker/transcripts` | For call-recording services: `{title, content, booking_reference?}`; creates a recap when AI is configured |
| `GET/POST /forms`, `PATCH /forms/{id}` `{definition, base_revision}`, `PUT /forms/{id}/routing` `{routing, base_revision}`, `POST /forms/{id}/publish` `{base_revision}`, `GET /forms/{id}/responses(.csv)` | Forms, routing and responses. With `base_revision`, a save or publish based on an older draft returns `409 draft_conflict` with the current form; omit it only in single-writer scripts. Routing is part of the draft and goes live on publish. See [FORMS.md](FORMS.md) |
| `GET/POST /flows`, `GET /runs`, `GET /tasks` | Flow automations |
| `POST /forms/{id}/publish-check` `{base_revision?}` | Checks the saved revision with the same definition, routing and entitlement validation as Publish. Returns `{revision, checked_at, can_publish, problems:[{code, field, message}]}`. Does not publish, save, send or consume usage. Stale revisions return 409; normal validation failures return 200 with `can_publish:false`. Authentication, workspace scope and `forms.manage` match Publish. Authenticated form payloads include `published_routing` separately from draft `routing`; public form payloads do not expose routing. |
| `GET /meet-video/rooms?scope=current\|past` · `POST /meet-video/rooms` | Schedora Meet video rooms; `POST` starts an instant meeting (session only) |
| `GET /meet-video/wallet`, `GET /meet-video/wallet/ledger?before=&limit=`, `GET /meet-video/wallet/usage`, `GET /meet-video/calculator?participants=&minutes=` | Meet credits (owners and admins) |
| `POST /meet-video/recharges` (`Idempotency-Key`), `POST /meet-video/recharges/{id}/refresh` | Buy Meet credits (owner, web app only) |

Video room actions use the room's opaque id, not the workspace id: `GET /api/meet-video/rooms/{id}`, `POST …/join`, `…/end`, `…/participants/{participant}/remove`, `…/invites`. Guests use `GET/POST /api/public/meet-video/join/{attendance token}`. Join responses contain a short-lived provider token in a `no-store` JSON body; never put it in a URL or log. Provider webhooks: `POST /api/meet-video/webhooks/{deployment}` (signature verified against the raw body).

Public endpoints (no key): `GET /api/public/meet/{workspace}/{event}/slots`, `POST /api/public/meet/{workspace}/{event}/bookings` (requires an `Idempotency-Key` header; optional `handoff` token from a form response), and `/api/public/bookings/{manage token}` for invitees. When `handoff` is supplied, invalid/mismatched tokens return `404 handoff_not_found`, used tokens return `409 handoff_used` even after expiry, and expired unused tokens return `410 handoff_expired`. These failures do not create an unlinked booking. Omitting `handoff` retains ordinary public booking behavior.

Public Forms endpoints: `GET /api/public/forms/{slug}` (adds `availability`: `open`, `not_accepting` or `capacity_reached`; a closed form returns `410 form_closed`), `POST /api/public/forms/{slug}/responses` `{answers, submission_id, version}` (`201` accepted, `200` replay of an accepted `submission_id` with `answers_changed`; `409 form_version_changed`, `410 form_closed`, `429 quota_exceeded` mean nothing was stored), and `GET /api/public/form-handoffs/{token}` (booking pre-fill for an offered handoff, or only its status).

## Webhooks
Add endpoints under **Account → Webhooks** (owners and admins). Events: `meet.booking.created`, `meet.booking.canceled`, `meet.booking.rescheduled`, `forms.response.created`.

Each delivery is a `POST` with JSON `{id, type, created_at, workspace_id, data}` and headers:
- `Schedora-Event`: the event type
- `Schedora-Delivery`: unique delivery id (deduplicate on it)
- `Schedora-Signature`: `t=<unix seconds>,v1=<hex>` where `v1 = HMAC-SHA256(secret, t + "." + raw body)`

Verify the signature and reject timestamps older than 5 minutes. Respond with any 2xx within 10 seconds. Failed deliveries are retried with exponential backoff (8 attempts over about two hours) and can be resent from the Account page. Endpoints must be public HTTPS; private and internal addresses are refused.

```js
import { createHmac, timingSafeEqual } from 'node:crypto';
function verify(secret, rawBody, header) {
  const { t, v1 } = Object.fromEntries(header.split(',').map(part => part.split('=')));
  const expected = createHmac('sha256', secret).update(`${t}.${rawBody}`).digest();
  return Math.abs(Date.now() / 1000 - Number(t)) < 300 && timingSafeEqual(expected, Buffer.from(v1, 'hex'));
}
```

## MCP server (AI assistants)
Schedora is a Model Context Protocol server at `https://schedora.in/api/mcp` (Streamable HTTP, stateless, JSON responses), authenticated with an API key. Tools: `list_event_types`, `get_available_times`, `book_meeting`, `list_meetings`, `cancel_meeting`, `find_contacts`, `get_contact`.

Example (Claude Code):

```
claude mcp add --transport http schedora https://schedora.in/api/mcp --header "Authorization: Bearer sch_..."
```

The assistant acts with the key owner's permissions: it can only see and change what that member can.

## Embedding a booking page
Put this on any website:

```html
<div data-schedora-inline="https://schedora.in/meet/your-team/intro-call"></div>
<a href="https://schedora.in/meet/your-team/intro-call" data-schedora-popup>Book a call</a>
<script src="https://schedora.in/embed.js" async></script>
```

Embedded pages are served from `/embed/meet/...`, the only booking paths that allow framing by other sites, and resize themselves to fit.
