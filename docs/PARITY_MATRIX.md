# Functional parity matrix

Updated 24 October 2026. Statuses: **tested** (built and covered by automated tests), **built** (code exists; verified only against simulated providers, or by browser checks, not with live accounts), **needs account** (built, and goes live once the owner connects the named provider), **partial**, **deferred**.

The comparison follows a public description of a leading scheduling product's features. Schedora's code, text and design are original; no proprietary code or assets were used. Automated evidence: `backend/test/*.test.mjs` (57 tests) and `backend/scripts/browser-check.mjs` (journeys at 320–1280 px, light and dark).

## Meet: core scheduling

| Capability | Status | Notes |
| --- | --- | --- |
| Personal booking links, custom URL | tested | `/meet/<workspace>` page listing event types; editable address and per-event links |
| One-on-one meetings, unlimited bookings | tested | Monthly allowance applies only in enforced billing mode (proposed quota) |
| Calendar sync to prevent double booking | tested / needs account | iCalendar feeds tested; Google and Microsoft 365 via OAuth built and tested against simulated APIs; up to 6 calendars per host |
| Real-time availability | tested | Busy times sync every 15 minutes and on demand |
| Working hours, days off, holidays, time zones, notice, date range | tested | Weekly hours, date exceptions, bookable-from/until |
| Daily, weekly, monthly meeting limits | tested | Per host and event type |
| Buffers before and after | tested | |
| Invitee time zone display, DST | tested | |
| Reschedule and cancel by link, calendars updated | tested | Expiring links; host calendar events removed on cancel (OAuth) |

## Meeting types

| Type | Status | Notes |
| --- | --- | --- |
| One-on-one | tested | |
| Group | tested | Seats per meeting; attendees join one meeting; seat count shown |
| Collective | tested | Only times when every host is free; blocks all hosts |
| Round robin | tested | Priority, equal distribution, availability; known contacts go to their owner |
| One-off meetings | tested | Hidden, optional single use, expiry and specific offered times |
| Meeting polls | tested | Vote without an account; host confirms and everyone is booked |

## Booking page customization

| Capability | Status | Notes |
| --- | --- | --- |
| Branding (logo, color, welcome text) | tested | Logo PNG/JPEG/WebP up to 200 KB; color applied to public pages |
| Custom URLs | tested | Workspace address and event links |
| Custom questions | tested | Short/long text, email, phone, choices, date; shown to hosts and usable in workflows |
| Location options | tested / needs account | Video link, in person, phone (either direction), custom; Google Meet, Zoom and Teams links created automatically once connected |
| Website embedding | built | Inline and popup widget (`embed.js`); `/embed/...` pages auto-resize |
| Preview before sharing | tested | Members can preview unpublished event types |
| Confirmation message or redirect | built | |

## Automated communication

| Capability | Status | Notes |
| --- | --- | --- |
| Confirmations to invitee and host(s), calendar file | tested | Guests receive invitations too |
| Email reminders | tested | Built-in reminder plus workflows |
| SMS reminders | built / needs account | Twilio adapter; messages recorded in the outbox until connected |
| Follow-up emails, custom workflows | tested | Booked, before, after, canceled, rescheduled; conditional on answers |
| Reschedule and cancel links in messages | tested | |

## AI features

| Capability | Status | Notes |
| --- | --- | --- |
| Scheduling assistant by email (Meet Assist) | built / needs account | Copy the assistant on a thread; it replies with bookable times. Needs an inbound email provider and, for drafted wording, an Anthropic API key |
| Chat about meetings, contacts, availability | built / needs account | Read-only tools; needs an Anthropic API key |
| Meeting notetaker that joins calls | partial | Transcripts can be pasted, uploaded or sent by a recording service through the API; joining calls requires a meeting-bot vendor (not connected) |
| Automatic recaps, decisions, action items | built / needs account | Structured output from Claude |
| Searchable transcripts | tested | |
| Secure recap sharing with passcode, transcript download | tested | |
| Drafted follow-up emails | built | Part of each recap |
| Meeting preparation | tested | History, notes, answers, recaps; optional AI brief |

## Contacts and CRM

| Capability | Status | Notes |
| --- | --- | --- |
| Automatic contact profiles | tested | From bookings and form responses |
| Relationship history | tested | Meetings and form responses on one profile |
| Notes, follow-up reminders, custom fields, tags | tested | |
| Book from a contact | built | Opens "Schedule for someone" pre-filled |
| CRM sync (HubSpot, Salesforce and others) | partial | Signed webhooks and the REST API allow syncing to any CRM; native connectors are deferred |

## Team and sales

| Capability | Status | Notes |
| --- | --- | --- |
| Team scheduling | tested | Collective and round-robin event types |
| Book on behalf of others | tested | Optionally outside working hours; never double-books |
| Lead routing | tested | Routing forms in Forms send respondents to booking pages, links or messages, pre-filled |
| Known-lead matching | tested | Using Schedora contacts; CRM lookups deferred |
| Managed event types | tested | Templates assigned to members with locked fields that follow the template |
| Roles and permissions | tested | Owner, admin, member ([authorization matrix](AUTHORIZATION.md)) |

## Payments

| Capability | Status | Notes |
| --- | --- | --- |
| Paid bookings | tested / needs account | Slot held 15 minutes during checkout; each workspace connects its own Stripe account; test checkout for evaluation |
| PayPal | deferred | |
| Invoice links in follow-ups | partial | Any link can be added to workflow messages |

## Integrations and platform

| Capability | Status | Notes |
| --- | --- | --- |
| Google, Outlook/Office 365, Teams calendars | needs account | OAuth apps required |
| Exchange (on-premises) | deferred | Exchange Online is covered by Microsoft 365 |
| Google Meet, Zoom, Teams links | needs account | |
| Browser extension | built | Chrome, Edge and Firefox (Manifest V3); store publishing needs developer accounts; Safari needs conversion |
| Mobile apps | partial | Installable web app (PWA) for iOS and Android; native store apps deferred |
| Webhooks and API | tested | Signed webhooks with retries; REST API with keys ([API.md](API.md)) |
| MCP server for AI tools | tested | |
| Admin controls, audit log | tested | |
| Single sign-on | tested | OpenID Connect (Okta, Entra ID, Google Workspace); SAML deferred |
| Analytics | tested | Totals, by event type and host, daily trend, busiest times, revenue |
| Enterprise compliance programs | deferred | Organizational work, not code |

## Forms and Flow

Forms: field types, classic and conversational presentation, multi-page logic, piping, versions, responses, CSV export, embedding and lead routing are tested. Flow: booking-created, booking-canceled, booking-rescheduled and response triggers with email and task actions, exactly-once runs, retries and pause are tested. File uploads, calculated fields, scoring and payments in Forms are deferred.

## Not yet researched

Current competitor prices and plan limits must be captured with dated snapshots in [PRICING_WORKSHEET.md](PRICING_WORKSHEET.md) before any price or savings claim.
