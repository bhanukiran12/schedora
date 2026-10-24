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
| `GET/POST /forms`, `PUT /forms/{id}/routing`, `GET /forms/{id}/responses(.csv)` | Forms, routing and responses |
| `GET/POST /flows`, `GET /runs`, `GET /tasks` | Flow automations |

Public endpoints (no key): `GET /api/public/meet/{workspace}/{event}/slots`, `POST /api/public/meet/{workspace}/{event}/bookings` (requires an `Idempotency-Key` header), and `/api/public/bookings/{manage token}` for invitees.

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
