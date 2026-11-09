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
| `/forms` overview and list | Find a form, see whether it's live, open it | — | Browser: populated, filtered, no-match and offline-error states at 320/375/768/1280, plus unit tests | **Done (M4 part 1)** |
| Create form → Blank / Templates (`/forms` and `/setup/forms`) | Start quickly from the right point | — | Browser: identical cards on both routes, cancel paths, workspace pinned across tabs, setup → builder → setup | **Done (M4 part 2)** |
| Create form → **Import JSON** | Bring an existing definition in without a terminal or API key | — | Server tests plus the browser journey below | **Done (M1)** |
| Builder · Content (outline, canvas, inspector) | Edit questions in place | — | Browser at 320/375/768/1280; keyboard pass with real key events (outline, add, reorder); fixture with 39 questions | **Done (M4 parts 1 and 4)** |
| Builder · Workflow (logic map, jumps, URL parameters) | Understand and edit branching | Dense. URL parameters and answer prefill aren't distinguished (M2). | Existing logicmap/jumps tests plus browser | Planned (M2/M4) |
| Builder · Design | Apply a theme and typography | Opens as a side panel from the toolbar, so it's not discoverable from the section nav | Theme tests plus screenshots | Planned (M4) |
| Builder · Settings (presentation, access, routing) | Form-wide behaviour | — | Browser: sign-in journey | **Who can respond done (M3)** |
| Builder · Share + readiness | Get the link and the embed code | The embed sits in a disclosure | Browser: prefill journey | **Prefilled links done (M2)**; layout polish M4 |
| Builder · More actions | Secondary actions | — | Browser: Export downloads the file | **Done (M1: Export form definition)** |
| Preview (builder pane, both layouts) | See what respondents see | Works. Device toggle present. | Browser: classic and conversational render after reopen | Verified in M1 |
| `/forms/:id/responses` and detail | Scan, filter, inspect, export | — | Server tests (also on PostgreSQL); browser: loading, filtered, no-match, search-error, empty, other-workspace and signed-out states; side panel and phone sheet keep the row; filtered and full CSVs | **Done (M4 part 3)** |
| `/f/:slug` Classic | Answer and submit | Works. Respondent pages now show only the Forms lockup in the header (M4 part 1). | Browser: 9-error summary, conditional question, Loom description, receipt, sign-in states | Verified in M1 and M3 |
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

## Milestone 3: Respondent sign-in (done, using the workspace's existing SSO)

This uses the workspace's own OIDC provider, as you decided. Respondents never become users, members or editors. Sign-in is enforced on the server for both form access and submission, and existing links stay public. The contract, the tests and a rollback hazard are in `docs/FORMS.md`, "Respondent sign-in".

**Still open for you to decide:**
- Plan restrictions for sign-in forms. None are applied today.
- Whether respondents outside the SSO email domain should be allowed, through a per-form *allowed respondent domains* list. It matters if students sign in with personal addresses.
- Whether protected forms should work in embeds or meetings later.

## Milestone 4: Every route (in progress)

**Part 1 is done:** the Forms list, the builder header's Preview step and phone tabs, and the respondent header. See `docs/FORMS.md`, "Route pass, part 1".

**Remaining, in order:**
1. ~~The `/setup/forms` creation flow joined to the same picker.~~ Done (part 2).
2. ~~Responses: search, filters and a side detail panel.~~ Done (part 3).
3. ~~Builder outline on phones and toolbar hierarchy.~~ Done (part 4).
4. An embed check (`?embed=1` inside a host page).
5. Endings polish.

None of these depends on SSO.

Production deployment is not part of any milestone. Nothing has been deployed.
