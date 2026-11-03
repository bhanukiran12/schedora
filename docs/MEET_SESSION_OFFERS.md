# Session offers and pinned notes in Schedora meeting rooms

Status (30 October 2026): **contract plus a first vertical slice, local only.** Not committed, deployed or verified with real media, real devices or real people. It applies only to Schedora's own meeting room (native video, which production still keeps off apart from the owner pilot). Nothing here puts a form into Zoom, Google Meet or Teams; that would need each provider's own supported extension mechanism and is not planned.

## Problem

During a live session the host pastes the form link into chat several times, because people who join late never saw it. Chat history is not durable for late joiners, and the link gives the host no view of who has answered.

## Outcome

The host attaches one published form to the meeting. Everyone in the meeting, including people who join later, sees it on a persistent session card. They can open it beside the call, minimise it and come back, and they get one automatic prompt per offer. After the server accepts their response they see a receipt and a completed status, and reconnecting neither prompts again nor allows a second response. The host sees private submission status. A host can also pin one short instruction with an optional link.

Default: **offer, never block.** Required information before entry would be a separately disclosed admission policy (not built). A form never interrupts the call or takes over the screen without the attendee choosing to open it, apart from the single prompt.

## Terms

| Term | Meaning | Evidence stored |
| --- | --- | --- |
| Attendance | Admitted to the room (`video_participants`, status `admitted`/`joined`) | Existing video tables; unchanged |
| Offer | One form attached to one room, with an identity of its own | `video_session_offers` |
| Prompted | The client showed this attendee the automatic prompt for this offer | `prompted_at` on the attendee's receipt row |
| Opened (viewing) | The attendee opened the form panel | `opened_at` |
| Submitted | The Forms service accepted a response for this offer from this attendee | `submitted_at` + `response_id` |

Opening a form is not submitting it. Submitting is not proof of attendance, consent to recording or acceptance of anything; it is a form response.

## Data

Migration `015_session_offers.sql` (SQLite) and the PostgreSQL upgrade step `postgres_v14_session_offers`. All of it is additive.

- `video_session_offers(id, room_id → video_rooms CASCADE, workspace_id → workspaces CASCADE, form_id → forms CASCADE, mode 'auto'|'manual', status 'active'|'replaced'|'removed', launched_at, created_by, created_at, ended_at, ended_by)`.
  - A partial unique index allows at most one `active` offer per room.
  - `launched_at` is the moment attendees can see the offer. For `auto` that is when it is attached; for `manual` it is when the host selects **Offer now**.
- `video_session_receipts(offer_id → offers CASCADE, participant_id → video_participants CASCADE, prompted_at, opened_at, submitted_at, response_id → responses SET NULL)`, with primary key `(offer_id, participant_id)`.
  - It stores **no answers** and no copy of response data, only the response id.
- `video_session_notes(room_id → video_rooms CASCADE PK, workspace_id, body ≤ 500 chars, link_url, link_label ≤ 60, updated_by, updated_at)`.

Deleting a room, form or workspace removes its offers and receipts. A deleted response leaves the receipt's `submitted_at` in place with `response_id` null.

## Identity and binding

- **Members** are identified by their session plus the room's stable member identity (`m-…`, derived from room and user ids).
- **Guests** are identified by their attendance credential (the join link token) **and** their seat id: a random UUID returned only to the tab that was admitted and kept in that tab's `sessionStorage`. The server checks that the seat belongs to that credential and that room, and is `admitted` or `joined`. People who share one booking link get separate seats, and none of them can see another seat's id.
  - Participant lists, with their seat ids, go only to hosts.
- Display names and email text are never used to identify a respondent.
- A **session ticket** links a submission to an (offer, attendee) pair. It is an HMAC (key derived from `APP_ENCRYPTION_KEY`, refused in production without it) over offer id, participant id and expiry. Attendees receive it only in their own no-store session response, and only while the form is collecting and they have not submitted. It expires when the room's maximum end passes.
  - A ticket cannot be altered to name another attendee or offer.
  - A leaked ticket could let someone submit a real response marked as that attendee's. The impact is a false *completed* mark for one attendee, not access to anyone's answers.
- A guest who opens the link in a **new tab** gets a new seat and so counts as a new attendee. Reconnecting in the same tab resumes the seat. This is a stated limitation, not a guarantee.

## Permissions

3 November hardening: all member session routes require a browser session, including reads that can issue attendee tickets. Ordinary members must have an admitted/joined seat to read session resources; hosts retain their management access before joining. Before creating a session-linked response, the submission transaction rechecks room state, guest invitation validity and current member membership rather than waiting for background removal. Existing accepted-response replay behaviour remains unchanged. These are locally tested changes, not a production release claim.

| Action | Who |
| --- | --- |
| Attach, replace, launch or remove an offer; edit or remove the pinned note | Room hosts as the room already defines them: workspace owner/admin (`meet.manage_all`), an active host of the booked meeting (including team co-hosts), or the creator of an instant meeting. The form must belong to the room's workspace and have a published version |
| See the offer and note | Admitted attendees of that room (members and guests) while their admission is valid. Hosts also see a manual offer before it is launched |
| See per-attendee status (name, prompted/opened/submitted) | Room hosts. It is evidence of status, not answers |
| Open the linked response from the host panel | Room hosts who **also** hold `responses.read` in the workspace. Managing a call does not grant response access; without that permission the panel shows status only |
| See their own receipt reference | Only the attendee who submitted |

Answers never appear in participant lists, room broadcasts, provider metadata or LiveKit data messages. The LiveKit token grants still exclude `canPublishData`.

## Form and version policy

- An offer names a **form**, not a version. Attendees load the form's currently published version through the existing public endpoint, and submissions go through the existing `submitResponse` path with its validation, version grace period (24 h), quota, entitlement, idempotency key and `forms.response.created` event. Nothing is duplicated.
- **Republished** while someone answers: the existing `form_version_changed` handling applies (answers kept, review, submit again).
- **Closed** (unpublished): the offer stays attached but shows *This form is closed*. Hosts see the same state and can remove or replace it. Submissions get the existing `410 form_closed`.
- **Quota exhausted or plan inactive:** shown as *not accepting responses right now*. Submissions get the existing errors.
- **Replaced:** the old offer becomes `replaced` and a new offer id is created, even for the same form. Earlier receipts stay with the old offer. Someone mid-answer on the old offer can still submit; it is recorded against the offer they answered.
- **Removed:** the offer becomes `removed`. Late joiners see nothing, and no prompt appears.
- **Access revoked** (attendee removed by a host, guest credential revoked, booking canceled, meeting ended): session reads return 404/410 and the card disappears. A submission carrying a ticket for a seat that is no longer in the room is refused with `403 not_in_meeting` and nothing is written.
- **Second response:** a ticket whose receipt already has a submission is refused with `409 session_already_submitted` before anything is written. A retry with the same submission id still returns the first receipt.
- **Preview** never creates a response or a receipt.

## API

All responses are `Cache-Control: no-store` JSON. Mutations use the existing session, origin and CSRF checks; API keys cannot use member routes that need a session.

| Method and path | Purpose |
| --- | --- |
| `GET /api/meet-video/rooms/:room/session` | Member view: offer, note, own status; hosts also get evidence and the list of attachable forms |
| `POST /api/meet-video/rooms/:room/session/offer` `{ form_id, mode }` | Host attaches or replaces (same form and mode as the active offer: returns it unchanged) |
| `POST /api/meet-video/rooms/:room/session/offer/launch` `{ offer_id }` | Host offers a manual offer now |
| `DELETE /api/meet-video/rooms/:room/session/offer` `{ offer_id }` | Host removes |
| `POST /api/meet-video/rooms/:room/session/note` `{ body, link_url?, link_label? }` / `DELETE …/note` | Host pins or removes the note |
| `POST /api/meet-video/rooms/:room/session/receipts` `{ offer_id, event: 'prompted' \| 'opened' }` | Member attendee records their own prompt/open |
| `GET /api/public/meet-video/join/:token/session?participant=` | Guest view |
| `POST /api/public/meet-video/join/:token/session/receipts` `{ participant, offer_id, event }` | Guest records their own prompt/open |
| `POST /api/public/forms/:slug/responses` `{ …, session_ticket }` | Existing submit, optionally linked to an offer |

## Pinned note

Plain text up to 500 characters; line breaks are kept and no markup is interpreted. The optional link must be an absolute `https://` URL with no credentials, at most 500 characters. It opens in a new tab with `rel="noopener noreferrer"`, and its label (default: the link's host) is text only. Replacing the note overwrites it, removing it deletes it, and both are explicit host actions. Pinning a message is common elsewhere (Zoom supports it), so it is not presented as unique.

## Attendee experience

- A **session card** above the meeting controls shows the note and the offer: *Form: <title>* with **Open form**, or *Completed · Receipt <ref>*. It is present for late joiners from their first session read.
- **One automatic prompt per offer:** the first time a launched offer is seen, an inline prompt offers **Open form** / **Not now**, and the prompt is recorded server-side. A reconnect, reload in the same tab or member rejoin does not prompt again.
- The form opens in a **side panel** of the same page, so the call, audio and microphone continue. **Minimise** returns to the card with answers kept on that page.
  - On phones the panel covers the video area; the controls stay reachable.
- Submission reuses the public form's renderer and retry logic. An uncertain result keeps the answers and offers **Submit again** with the same submission id. Only a server-confirmed result shows the receipt and switches the card to *Completed*.
- Video media inside a form shows a link that opens the video in a new tab instead of an embedded player, because meeting pages keep their stricter content policy.

## Not in this slice

- Required pre-entry forms (admission policy).
- Offers in Zoom, Google Meet or Teams.
- Push delivery: attendees poll every 10 s while in the room; LiveKit data messages stay disabled.
- Several simultaneous offers.
- Attaching an offer before the room exists (for scheduled rooms, the room exists once the booking is made).
- Per-offer response filters in the Forms inbox. The host panel links each response instead.
