# Respondent attachments: storage feasibility and implementation contract

3 November 2026. Research/design proposal only. No bucket, credential, access policy, upload capability or commercial allowance created. Existing first-release requirements remain open.

## Current evidence

The connected Supabase project matched the local backend's configured project identity (boolean comparison only; no credentials printed). A read-only aggregate inventory found an active project, an approximately19.7MB database, zero Storage buckets, zero objects and zero Storage object policies. This is a point-in-time metadata observation, not a backup/data-integrity audit or proof of available account-level quota.

Supabase's [public pricing](https://supabase.com/pricing) lists1GB file storage and5GB ordinary egress on Free, separate from its500MB database allowance. Current organisation plan, shared consumption, enforcement and billing controls must be confirmed before provisioning; do not assume the public allowance belongs exclusively to Schedora. No upgrade or nonzero spend is authorised.

Conclusion: object storage is a feasible candidate to investigate; the earlier assumption that the database is the only possible durable store is not a permanent architectural constraint. Storage is not currently configured, and unsafe anonymous database blobs remain inappropriate for respondent attachments.

## Intended customer outcome

Respondents can attach project briefs, reference images or requested documents without creating a Schedora account. An accepted form response retains private attachment references; authorised response readers can download them. Existing anonymous forms, text-only responses and CSV continue working. Completing only image attachments must not be presented as completing the broader document-upload requirement.

## Access architecture

- Use a dedicated private bucket. Public assets for question illustrations remain separate from respondent answers. No public read/list policy for answer objects.
- Schedora currently uses its own sessions and workspace memberships, not Supabase Auth identities. Do not write an `auth.uid()` policy and assume it matches Schedora's permissions.
- Prefer an application upload broker: a five-minute opaque grant bound to workspace, form, published version, question and submission identifier. Store only its digest; consume it through a transactionally protected lifecycle. Rate-limit issuance and upload separately.
- Stream a bounded request through the backend to object storage; do not buffer unlimited files. Keep provider credentials server-side, with the narrowest supported access. Provisioning credentials/access requires an explicit operational step; nothing in this proposal grants it.
- Do not expose a general Storage signing endpoint or trust an object path supplied by a respondent. Generate immutable random object keys on the server; never use a filename as a path. Repeated grants must not create an unbounded object reserve.
- Verify current provider APIs before coding. [Supabase signed upload URLs](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl) are documented as valid for two hours and usable without additional authentication. They must not be described as five-minute, single-use application grants. Returning one directly would need a different abuse/replay design.
- Downloads recheck current `responses.read` and workspace ownership. Prefer an authorised backend attachment response with no-store and safe content-disposition; if signed downloads are used, explicitly document bearer-link lifetime and cache/revocation limitations. No durable signed links in CSV, logs or analytics.
- A service-role key bypasses RLS. The application must still authorise every path and never return the key to browsers. A private bucket does not replace application-level tenant checks.

## Lifecycle and quota contract

Proposed bounded pilot values for review, not commercial entitlements:2MB/file, at most2files/question,10MB/workspace and100MB/service. Confirm these against actual available storage/egress and customer needs before enabling. Every new version adds only explicitly configured upload questions; ordinary forms remain unchanged.

Reserve expected bytes atomically before accepting an upload. Count pending, quarantined, attached and deletion-pending objects against the appropriate budget. Reject excess size while streaming, verify actual length, and reconcile against provider inventory. Provider bucket restrictions are additional protection, not the application's quota ledger.

States: issued → receiving → quarantined → validated → attached; or failed/expired → deletion_pending → deleted. Define concurrent retry behaviour before implementation. A consumed grant cannot attach another object or replace accepted bytes. Retrying a form submission reuses the accepted response and attachments without new quota consumption.

The normal response transaction validates each attachment's grant/submission/form/version/question binding and safety state before accepting it. A required upload is fulfilled only by accepted validated content. Do not create a successful response with inaccessible or quarantined attachments. Object writes and database commits are not atomic: keep enough metadata for compensation/reconciliation rather than deleting the accepted response after an object-store failure.

Propose24-hour cleanup for abandoned/quarantined objects and a clear owner-visible retention policy for accepted attachments. Do not invent consent or automatically delete accepted customer data based solely on this proposed interval. Deleting a response/form/workspace schedules its private objects for deletion; failed deletes retain quota until reconciled. Test partial failures and prove deletion through the provider API, not by deleting Storage metadata rows with SQL.

## File-safety gate

- Candidate formats: JPEG/PNG/WebP reference images and PDF briefs. Actual content, byte size and appropriate structural checks are server-validated; MIME headers/extensions are insufficient.
- Decide and test the scanner/quarantine path for documents before enabling them. Do not call files scanned, safe or clean without real evidence. A disclaimer is not a substitute for the promised safety mechanism.
- Image-only support may be a separately labelled pilot if re-encoding/validation and download safety are verified; PDF/document support remains an explicit unmet requirement until its gate passes.
- Reject SVG/HTML, scripts, archives and executables initially. No inline execution or automatic document preview. Sanitise display filenames and use attachment disposition, nosniff and private/no-store responses.
- Errors preserve form answers in the active view, distinguish upload completion from accepted submission, and provide retry/remove options. Do not silently persist sensitive files/answers in browser storage.

## Acceptance before release

Prove real provider upload/read/delete on disposable test objects, plus automated tenant isolation, expired/replayed/tampered grants, concurrent quota boundaries, oversized streaming rejection, wrong-form/question/submission references, invalid bytes, duplicate submissions, worker cleanup retries and response-access revocation. Test object/database partial failure and preserve prior published-version responses. Check keyboard/mobile/error states and actual private host downloads.

No enabled placeholder or fallback database upload should ship while provider configuration is unavailable. Existing Forms media/session release checks should finish independently; do not delay their PostgreSQL verification by silently adding an unfinished upload subsystem.

## Official references checked3November2026

- [Private versus public buckets](https://supabase.com/docs/guides/storage/buckets/fundamentals): private access requires authorisation or a limited signed URL.
- [Storage access control](https://supabase.com/docs/guides/storage/security/access-control): policies govern operations; privileged server keys require special care.
- [Signed upload URL API](https://supabase.com/docs/reference/javascript/file-buckets-createsigneduploadurl): two-hour provider upload capability.
- [Pricing](https://supabase.com/pricing): public Free storage/egress figures, not an account-specific availability guarantee.
- [TLS change notice](https://supabase.com/changelog/cbc-tls-ciphers-deprecated): some older HTTP cipher suites may be removed from10November; use supported TLS clients. Direct PostgreSQL connections are excluded from that notice. No evidence of an actual compatibility failure here.
