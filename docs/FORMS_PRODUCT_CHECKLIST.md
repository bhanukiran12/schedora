# Forms product checklist

Started 9 November 2026 on branch `codex/forms-typography`, from a clean working tree at `0d6ac90`. This is the acceptance checklist for improving Forms. Each route lists its user goal, its main UX gaps, and how it will be verified. Typeform is the reference for hierarchy, navigation and editing interactions. Schedora's branding and existing contracts in `docs/FORMS.md` stay as they are.

Status key: **Done** means built and verified locally in this checkout. **Planned** means the gap is recorded and not built yet.

## What already exists

- **Routes** (`frontend/app.js`, `backend/src/web.mjs`): `/forms`, `/forms/:id` (builder with Content, Workflow, Settings and Share surfaces), `/forms/:id/responses`, `/f/:slug` (public Classic and Conversational, `?mode=conversational`, `?embed=1`), `/setup/forms` (guided setup), and `/enquiries` (workspace inbox across Forms and Meet).
- **APIs** (`backend/src/api.mjs`): CRUD, routing, publish, publish-check, unpublish, responses (paged), CSV, response delete, themes and assets. Public: get form, submit, handoff and asset.
- **Identity and parameters**: host sign-in uses password, Google and workspace OIDC SSO (`platform/sso.mjs`). SSO is for workspace members only and auto-joins people from a matching email domain. Respondents are always anonymous. `url_params` are untrusted attribution and logic inputs, kept apart from answers. A Meet `session_ticket` can link a response to a meeting seat. Question keys exist and lock once published, and the inspector shows them under *Question key*.
- **Integrations**: Forms → Meet booking handoff, Forms → Flow (`forms.response.created`), signed webhooks, the MCP tools and API keys. There is no connector gallery and no Forms-specific integration route.
- **Embeds**: the Share panel has iframe embed code (`/f/:slug?embed=1`). `embed.js` covers Meet only.

## Route checklist

| Route / surface | User goal | Main UX gaps found | Verification | Status |
|---|---|---|---|---|
| `/forms` overview and list | Find a form, see whether it's live, open it | No search, filter or sort. Draft/live status is a small badge. Only two row actions (Edit, Responses), with no export, duplicate or copy link. The empty state pushes the picker open, but the list isn't the first thing a returning user sees. | Browser: empty, loading, error and populated states at 320/375/768/1280. Search and filter unit tests. | Planned (M4) |
| Create form → Blank / Templates | Start quickly from the right point | The picker is hidden behind *Create form*. Templates are grouped well. `/setup/forms` uses a separate flow. | Browser journey from both entry points creates the same unpublished draft. | Partly (M1 added *Start your own*; unifying `/setup/forms` is M4) |
| Create form → **Import JSON** | Bring an existing definition in without a terminal or API key | — | Server tests plus the browser journey below | **Done (M1)** |
| Builder · Content (outline, canvas, inspector) | Edit questions in place | Toolbar icons have equal weight. Save, Preview and Publish sit far apart, and Preview is a tab icon. On phones the section tabs clip (*Responses* is cut off) and the outline becomes a chip strip with no labels. | Browser at all widths, keyboard-only pass, screenshots | Planned (M4) |
| Builder · Workflow (logic map, jumps, URL parameters) | Understand and edit branching | Dense. URL parameters and answer prefill aren't distinguished (M2). | Existing logicmap/jumps tests plus browser | Planned (M2/M4) |
| Builder · Design | Apply a theme and typography | Opens as a side panel from the toolbar, so it's not discoverable from the section nav | Theme tests plus screenshots | Planned (M4) |
| Builder · Settings (presentation, routing) | Form-wide behaviour | No per-form access setting (M3) | — | Planned (M3) |
| Builder · Share + readiness | Get the link and the embed code | The embed sits in a disclosure | Browser: prefill journey | **Prefilled links done (M2)**; layout polish M4 |
| Builder · More actions | Secondary actions | — | Browser: Export downloads the file | **Done (M1: Export form definition)** |
| Preview (builder pane, both layouts) | See what respondents see | Works. Device toggle present. | Browser: classic and conversational render after reopen | Verified in M1 |
| `/forms/:id/responses` and detail | Scan, filter, inspect, export | Table without filters or search. The detail opens below the table, far from the clicked row on phones. | Browser at all widths. CSV contents checked. | Planned (M4); export verified in M1 |
| `/f/:slug` Classic | Answer and submit | Works: the required-error summary, progress and long folded descriptions | Browser: 9-error summary, conditional question, Loom description, receipt | Verified in M1 |
| `/f/:slug?mode=conversational` | One question at a time | Works | Browser: required error, conditional question, receipt | Verified in M1 |
| `/f/:slug?embed=1` | Embedded on another site | Not re-checked this milestone | Browser inside an iframe host page | Planned (M4) |
| Endings | Custom completion screens | Edited in the outline's *Endings* card | Existing jumps/endings tests | Planned (M4 polish) |
| `/enquiries` | Cross-product inbox | Out of Forms scope except the links into it | — | Not in scope |

## Milestone 1: Import JSON and export (done)

**Built**

- `POST /api/workspaces/:ws/forms/import-check`: validates on the server and returns a summary and warnings. Creates nothing.
- `POST /api/workspaces/:ws/forms/import`: runs the same checks again, then creates an **unpublished draft** in the selected workspace.
- `GET /api/workspaces/:ws/forms/:id/definition.json`: the saved draft in a `{ format, version, exported_at, definition }` envelope.
- UI: an *Import JSON* card beside *Blank form*, with a dialog (upload, drop or paste) and a downloadable example. It shows a preview (title, question and page counts, required, conditional, jumps, warnings) before *Create draft*. The builder's *More actions* menu has *Export form definition*.
- The contract is in `docs/FORMS.md`, under "Import and export".

**Acceptance evidence (local SQLite, headless Chrome, 9 November)**

- `backend/test/forms-definition-io.test.mjs` (8 tests) covers:
  - the Technical Profile Details fixture
  - the example file, plus export → reimport deep-equal
  - routing and responses excluded from export
  - invalid JSON with line and column
  - broken display, jump and ending references, and duplicate question and choice IDs
  - unsupported, excluded and server-owned keys
  - the authoring freeze
  - workspace boundaries and anonymous access
  - images from another workspace
- A scratchpad browser journey ran through these steps:
  1. Sign up and open `/forms` in an empty workspace.
  2. Refused files: invalid JSON, a broken logic reference (*"Question 28 ("Other Technology Proficiency") has a display rule that refers to the choice "phd" in Question 5 …, which doesn't exist"*) and a duplicate ID. None of them created a form.
  3. Upload `technical-profile-draft/definition.json`. The preview showed 39 questions, 7 pages, 30 required and 1 conditional question.
  4. Create the draft. The builder confirmed it was unpublished.
  5. Confirm the draft kept the required project, the conditional proficiency question, the Question Bank text (byte-identical) and the required Loom field.
  6. Edit the Loom label, save, reopen, and preview in Classic and Conversational.
  7. Export, then reimport through the paste box. The copy was identical and the duplicate-title warning appeared.
  8. Publish, then submit in both layouts. This covered the required-error summary, the conditional question appearing only after "Other technologies" was answered, and the Loom description.
  9. Open the responses and the response detail, then export the CSV.
- Layout: no horizontal overflow at 320/375/768/1280 px in both colour preferences, for the picker, the dialog (empty, error and preview states), the builder, the public form and the responses. No runtime errors.

## Milestone 2: Entry IDs and prefilled links (done)

Built as `Share → Build prefilled link` with `answer.<key>=value` links. The contract and evidence are in `docs/FORMS.md`, "Prefilled links and question IDs". Sensitive and contact questions are never offered, and the respondent page ignores them even in a hand-written link. Verified in a fresh browser context: grouped questions, conditional logic, a renamed label, republishing, invalid values, and editing a prefilled answer through to the stored response.

## Milestone 3: Respondent sign-in (design; needs your decision)

Three things are kept separate:

- A **question ID** targets a field (definition, prefill).
- A **response ID** identifies a submission (receipt reference, inbox).
- A **verified respondent identity** comes only from a sign-in completed on the server. It is stored with the response as `respondent: { subject, email, issuer, verified_at }` and is never taken from answers or the URL.

Proposed design:

- A per-form `access: 'public' | 'signin'` setting, stored on the form (not in the definition file), default `public`, so every existing link is unchanged.
- `GET /api/public/forms/:slug` and `POST …/responses` both enforce it on the server. Without a valid respondent session they return `401 signin_required` and reveal no definition.
- The respondent session is separate from the host session: its own cookie and short expiry, and it never grants workspace membership.
- Optional claim mapping (email → an email question, `student_id` → a text question). Mapped answers are shown read-only as *Verified by sign-in*, kept apart from editable prefill, and come from the session, never from the submitted body.
- Tests to write: direct API calls without a session, expired sessions, a session from another workspace or form, and existing public links.

**Decision needed from you:** which identity provider respondents sign in with.

- (a) The workspace's existing OIDC SSO connection. This needs a change so that respondent sign-in never auto-joins people as members.
- (b) Google sign-in with an email-domain allow-list per form.
- (c) A one-time email code.

Also: should sign-in-required forms be gated by plan?

My recommendation is (a) with (b) as a fallback for workspaces without SSO. M3 code waits for this decision; M2 and M4 don't.

## Milestone 4: Every route (planned)

This milestone works through the *Planned (M4)* rows above:

- Workspace list: search, live/draft filter, status emphasis, and row actions (Edit, Responses, Copy link, Export, Duplicate).
- One creation flow shared by `/forms` and `/setup/forms`.
- Builder toolbar hierarchy: save state next to Save, a visible *Preview* button, and *Publish* as the single primary action.
- The mobile section tabs and the outline.
- Responses: filters, search and a side detail panel.
- An embed check.

Each route gets verified at 320/375/768/1280 px across empty, loading, error and permission states. The full journey is import → edit → preview → publish → submit → inspect → export.

Production deployment is not part of any milestone. Nothing has been deployed.
