# Forms + Sheets: audit, comparison and roadmap

Written 13 November 2026 against branch `codex/public-site-demo` (HEAD `989cda5`) **plus its uncommitted working tree** (65 modified files and several untracked ones, including the first Sheets prototype). Nothing in this document has been implemented yet; it is the plan to approve before work starts.

Status key for the comparison tables:

- **Implemented**: code exists and is covered by tests or a recorded browser pass (see `docs/FORMS.md`, `docs/FORMS_PRODUCT_CHECKLIST.md`).
- **Partial**: some of the capability exists, with the gap stated.
- **Needs improvement**: works, but the UX or limits fall short of what people expect from Google.
- **Missing**: no code.

Reference products were studied from Google's public help pages and general product knowledge only. No Google code, private APIs, trademarks or visual assets are used; Schedora's design stays its own.

---

## 1. What the repository is today

| Area | Facts |
|---|---|
| Frontend | Vanilla ES modules, **no build step**, tagged-template `html` rendering (`frontend/js/core.mjs`), one SPA router (`frontend/app.js`). Third-party JS is vendored into `frontend/vendor/` (only LiveKit today). |
| Backend | Node 24, own HTTP layer (`backend/src/http.mjs`), `node:sqlite` locally and PostgreSQL in production (`postgres.mjs`, `migrations/001–019`). Only three runtime dependencies. |
| Shared logic | `backend/src/shared/forms-logic.mjs` is copied to `frontend/shared/` by `npm run sync-shared`, so the browser and server evaluate visibility, piping and validation identically. Any new question type must go through it. |
| Auth / roles | Shared Schedora sign-in, Google, OIDC SSO; roles owner/admin/member with permissions such as `forms.manage`, `responses.read`, `responses.delete` (`docs/AUTHORIZATION.md`). No per-form sharing. |
| Billing | `billing/plans.mjs`: Forms plan ₹499/month, Suite ₹1,199; responses quota 5,000/month. No Sheets entitlement. |
| Deploy | Render from `main` (production), AWS ECS staging in progress, Vercel preview for frontend branches. |

### Forms (mature, ~6,000 lines)

`frontend/js/forms.mjs` (2,929 lines) plus 20 focused `forms-*.mjs` modules; `backend/src/forms/*`. Builder with outline, canvas and inspector; Content, Workflow, Design, Settings and Share surfaces; Classic and Conversational respondent layouts; versioned publishing; Meet handoff; Flow trigger; signed webhooks; import/export JSON; prefilled links; respondent SSO sign-in (off by default).

### Sheets (prototype, uncommitted, ~500 lines)

- `backend/migrations/019_form_workbooks.sql`, `backend/src/forms/workbooks.mjs`: **one workbook per form**, stored as a JSON blob, optimistic `revision` check (409 on conflict).
- `frontend/js/workbook-tabs.mjs`, `workbook-merge.mjs`: editable tabs next to a read-only "Form Responses" tab; three-way merge on conflict; 30-step undo; local cache when offline.
- `frontend/js/sheet-formulas.mjs`: hand-written parser with `+ - * /`, `SUM AVERAGE MIN MAX COUNT`, ranges, cross-sheet references, cycle detection.
- Route `/sheets/:formId` reuses the Responses page in "workbook" mode.
- **Hard limits**: 12 columns (A–L) × 50 rows, 12 sheets, 1,000 chars per cell, 1 MB per workbook. No standalone spreadsheets, no formatting, no sort/filter, no virtualization.

Verdict: a useful proof that the integration idea works, but the data model (one JSON blob, form-owned, fixed grid) cannot grow into a Sheets product. Phase 3 replaces the storage model; the merge and offline ideas are worth keeping.

---

## 2. Feature comparison: Forms

### Builder

| Google Forms capability | Schedora | Notes |
|---|---|---|
| Short answer, paragraph | Implemented | `short_text`, `long_text` |
| Multiple choice, checkboxes | Implemented | `single_choice`, `multiple_choice`, picture choices |
| Dropdown | **Missing** | Can be a rendering option of `single_choice` (same answer shape, no migration of answers) |
| Linear scale, rating (stars/hearts) | **Missing** | New `scale` type, integer answer |
| Multiple-choice grid, checkbox grid | **Missing** | New `grid` type; answer is `{row: col}`; needs CSV and Sheets column expansion |
| Date | Implemented | |
| Time, duration | **Missing** | |
| Number (with min/max) | **Missing** | Google uses validation on short answer; a typed `number` is cleaner for Sheets |
| Email, phone | Implemented (Schedora extra) | |
| File upload | **Missing, blocked by design** | `docs/FORM_UPLOADS_CONTRACT.md`: no private object storage, quotas or scanning yet |
| Response validation (length, regex, number range) | **Missing** | Only type-level checks today |
| Sections / page breaks | Implemented | Multi-question pages, page titles |
| Go to section based on answer | Implemented, stronger than Google | Jump rules, hide-choice rules, endings, logic map |
| Required | Implemented | |
| Title + description, image, video | Implemented | Question images, YouTube/Vimeo click-to-load |
| Duplicate question | Implemented | `duplicateBlock` |
| Drag to reorder | Implemented | Pointer + keyboard |
| Undo / redo | **Missing** | Autosave exists, so a mistake is saved immediately with no way back |
| Keyboard shortcuts | Partial | Outline navigation and reorder; no Ctrl+Z/Y, Ctrl+D, Ctrl+Enter, no shortcut help |
| Autosave + status | Implemented | "All changes saved / Saving… / Not saved: changed elsewhere" |
| Preview | Implemented | Device toggle, both layouts |
| Templates | Partial | Mode starters (lead, quiz, match); the template gallery was removed on 10 Nov |
| Quiz mode, answer key, points | Partial | Correct answers scored server-side; no per-question points, feedback, or release-score settings |
| Shuffle question / option order | **Missing** | |
| Collaborators on a form | Partial | Every workspace member with `forms.manage` can edit all forms; no per-form sharing |

### Customization

| Capability | Schedora | Notes |
|---|---|---|
| Fonts and text sizes | Implemented | 4 font stacks × 3 size steps |
| Colours and themes | Implemented | Workspace themes with 5 colour tokens |
| Header image / background image | Partial | Colour backgrounds only |
| Logo / branding | **Missing on forms** | Exists for Meet booking pages; reuse that asset path |
| Thank-you message | Implemented, stronger | Multiple endings, routing to Meet |
| Progress bar | Needs checking | Conversational layout shows progress; Classic needs a check |

### Publishing and access

| Capability | Schedora | Notes |
|---|---|---|
| Shareable link, public / sign-in only | Implemented | Sign-in uses workspace SSO, switch off by default |
| Embed code | Implemented | iframe + `?embed=1`, auto-resize |
| QR code | **Missing** | Small, client-side |
| Accepting responses toggle | Implemented | Unpublish = closed |
| Scheduled open / close dates | **Missing** | |
| Response limit per form | **Missing** | Only the plan-wide monthly quota |
| Limit to one response per person | **Missing** | Needs sign-in or a weaker cookie rule |
| Edit after submit, response receipt email | **Missing** | |
| Prefilled links | Implemented | |

### Responses

| Capability | Schedora | Notes |
|---|---|---|
| Individual responses | Implemented | Side panel, phone sheet |
| **Summary with charts** | **Missing** | Highest-visibility gap versus Google Forms |
| Per-question view | **Missing** | |
| Search and filters | Implemented | |
| CSV export | Implemented | Filtered and full |
| XLSX export | **Missing** | |
| New-response email notification | **Missing** | Flow can send one, but there is no simple per-form toggle |
| Link to spreadsheet | Partial | Prototype workbook, see Sheets |
| Delete response | Implemented | |

---

## 3. Feature comparison: Sheets

Everything below is measured against the prototype. Google Sheets' per-spreadsheet limit is 10 million cells.

| Google Sheets capability | Schedora | Notes |
|---|---|---|
| Standalone spreadsheets (list, create, rename, delete) | **Missing** | Prototype workbooks only exist per form |
| Rows / columns, insert / delete / resize | Partial | Fixed 12 × 50, no insert/delete/resize |
| Multiple worksheets | Partial | Up to 12 tabs, rename, delete |
| Cell editing, formula bar, A1 navigation | Partial | Basic editing and address display |
| Copy / paste (incl. from Excel/Google) | Partial | Single-cell copy only |
| Undo / redo | Partial | 30 cell edits |
| Sort / filter / filter views | **Missing** | |
| Freeze rows / columns | **Missing** | |
| Formatting (number, date, bold, colour, alignment, wrap) | **Missing** | |
| Data validation, dropdown cells | **Missing** | |
| Find and replace | **Missing** | |
| Import / export CSV, XLSX | **Missing** | |
| Formulas: SUM, AVERAGE, MIN, MAX, COUNT | Implemented (basic) | Own parser |
| IF, SUMIF(S), COUNTIF(S), VLOOKUP, XLOOKUP, INDEX/MATCH, FILTER, SORT, UNIQUE, text and date functions | **Missing** | Needs a real engine (section 5) |
| Charts | **Missing** | |
| Conditional formatting | **Missing** | |
| Pivot tables | **Missing** | |
| Protected ranges | Partial | Only the linked responses tab is read-only |
| Sharing permissions | **Missing** | Workspace roles only |
| Real-time collaboration, presence | Partial | Optimistic revision + 3-way merge; no live updates |
| Version history | **Missing** | |
| Large datasets (virtualized rendering) | **Missing** | Every cell is a DOM node |

---

## 4. Forms → Sheets integration (the differentiator)

Google's model: one form writes to one response sheet; the sheet is a separate file the owner can unlink, and edits to response rows do not flow back. Schedora can do better because both products share one database and one workspace.

### Recommended design

1. **The response table is the source of truth; the sheet is a view.** The linked "Form Responses" tab is generated from `form_responses` (already true in the prototype). It is never written to by sheet users, so there is nothing to sync and nothing to drift. Duplicate prevention is already solved at submission time (submission id kept per tab, idempotent server insert).
2. **Analysis lives in other tabs** that reference the responses tab by formula (`='Form Responses'!C2`, `COUNTIF('Form Responses'!D:D, "Yes")`). This is how the prototype works and it should stay.
3. **Columns are keyed by question key, not label or position.** Question keys already lock once published (`docs/FORMS.md`), so renaming or reordering questions never breaks a formula. New questions append columns; deleted questions keep their historical column, marked as removed.
4. **Annotation columns** (status, owner, notes) are the one write-back users want. Store them per `response_id` in a separate table so they survive regeneration and re-sorting. This is the main thing Google cannot do cleanly.
5. **Live update** by polling the response count/`updated_at` first (cheap, works on Render), Server-Sent Events later. No WebSocket infrastructure is needed for Phase 4.
6. **Access** follows `responses.read` for viewing and `forms.manage` (later, per-sheet editor) for analysis tabs. A sheet linked to a sign-in form must not leak identity columns to members without `responses.read`.
7. **Recovery**: because the responses tab is derived, "re-sync" is just a re-read. Deleting a response removes its row; annotations for it are deleted with it.

---

## 5. Library recommendations

The constraints that decide this: no bundler today, vanilla ES modules, commercial SaaS, and code that ships to browsers.

| Need | Recommendation | Licence | Why / why not the alternatives |
|---|---|---|---|
| Formula engine | **IronCalc** (Rust → WebAssembly), evaluated in a time-boxed spike first | MIT / Apache-2.0 | Real Excel-compatible engine with dependency graph and hundreds of functions; runs in browser and Node, so the server can recompute the same values. Young project and release history is unclear, hence the spike. |
| Formula fallback | **Formula.js** (`@formulajs/formulajs`) on top of the existing parser, extended with a dependency graph | MIT | Function implementations only (IF, SUMIF, VLOOKUP, XLOOKUP, text, date). Lower risk, more of our own code. |
| *Not recommended* | HyperFormula | GPLv3 or paid commercial key | Best-in-class, but GPLv3 obligations apply to JS shipped to browsers in a closed SaaS; would need a paid licence. Revisit only if budget allows. |
| Grid rendering | **Own virtualized DOM grid**, growing out of `workbook-tabs.mjs` | — | Keeps the no-build stack and our accessibility conventions (roving tabindex, ARIA grid). Render only visible rows/columns; this is a few hundred lines, not a framework. |
| *Not recommended* | Univer | Apache-2.0 core; collaboration, import/export, charts, pivots are **Pro (commercial)** | Very capable, but large, needs a bundler, and the features we need most sit behind its commercial licence. |
| *Not recommended* | Handsontable | Commercial for SaaS | Licence cost. |
| XLSX import/export | **SheetJS Community Edition** (from cdn.sheetjs.com, vendored) or **ExcelJS** on the server | Apache-2.0 / MIT | ExcelJS on the server keeps export out of the browser bundle and works for Forms XLSX export too. |
| Charts | **Chart.js** (vendored ESM) | MIT | Covers bar/pie/line for Forms Summary and Sheets charts; canvas, accessible fallback table rendered by us. Hand-rolled SVG is fine for Forms Summary alone. |
| QR codes | **qrcode-generator** | MIT | Tiny, no dependencies, client-side. |
| Real-time co-editing (later) | **Yjs** | MIT | Only if Phase 5 needs simultaneous cell editing; the current revision + merge model is enough until then. |

Every library is pinned and vendored into `frontend/vendor/` like LiveKit (`npm run vendor-*`), so there is still no build step.

---

## 6. Roadmap

Effort is a rough size for one engineer (S ≤ 2 days, M ≤ 1 week, L ≤ 3 weeks). Each item ships behind its own commit with tests and a browser check, per the existing release practice.

### Phase 0: stabilise the checkout (prerequisite, S)

- The working tree carries 65 modified files across Meet, billing, Forms and Sheets, uncommitted. Split them into reviewable commits (or branches) before new Forms/Sheets work starts, so a regression can be traced.
- Backend tests on this checkout (13 Nov): 410 tests, 402 pass, **1 fail**, 7 skipped. The failure is `forms-freeze.test.mjs`: the new prototype route `PUT /forms/:id/workbook` is not classified, and `saveWorkbook` does not call `assertAuthoringOpen`, so workbook edits would still be accepted during a release authoring freeze. Decide whether workbook edits are authoring (freeze them) or allowed, then classify the route.
- Re-run the full browser check. The last recorded local run (`docs/PROJECT_CHECKPOINTS.md`, 13 Nov) had 17 failed journeys including **Forms keyboard navigation and mobile layout**.

### Phase 1: Forms audit fixes and UX (S–M)

1. Fix the failing Forms keyboard and mobile journeys. *Depends on Phase 0.*
2. **Builder undo / redo** with Ctrl/⌘+Z, Ctrl/⌘+Shift+Z / Ctrl+Y, plus Ctrl/⌘+D duplicate, Ctrl/⌘+Enter add question, and a `?` shortcut sheet. Autosave already exists, so undo is the missing safety net. (S)
3. Finish the open design approval for the builder (question list beside the editor, single Publish, saved/pending state), already proposed in `PROJECT_CHECKPOINTS.md`.

### Phase 2: Forms parity (M–L)

Priority order, highest value first:

1. **Responses Summary tab with charts** (M). Per-question counts and bar charts for choices, number stats, latest text answers.
2. **Question types**: dropdown display, linear scale / rating, number, time, then grids (M each; grids touch CSV and Sheets columns). All via `forms-logic.mjs` with server validation.
3. **Response validation** rules: length, number range, regex (S).
4. Publishing controls: **open/close dates, per-form response limit, one response per signed-in person** (M).
5. **New-response email notification** toggle and respondent receipt (S, reuses `platform/email.mjs`).
6. QR code (S), XLSX export (S with ExcelJS), logo and header image (S, reuses Meet branding assets).
7. Shuffle questions/options, quiz points and feedback (M).
8. File uploads: **blocked** on the owner decisions in `FORM_UPLOADS_CONTRACT.md` (storage, quota, scanning, cost owner).

### Phase 3: Sheets core (L)

*Depends on the formula-engine spike result.*

1. Data model: `spreadsheets` (workspace-owned, optional `form_id` link) and `sheet_cells` stored sparsely (or per-sheet chunks), with per-sheet revisions instead of one workbook blob. Migrate prototype workbooks.
2. `/sheets` list and standalone spreadsheets.
3. Virtualized grid: insert/delete/resize rows and columns, multi-cell selection, copy/paste TSV (Excel/Google compatible), fill, undo/redo per sheet, freeze panes, formula bar.
4. Formula engine integration; server-side recompute for exports.
5. Formatting basics, sort, filter, find and replace, CSV/XLSX import and export.
6. Limits: start at 100k cells per spreadsheet and raise after measuring.

### Phase 4: Forms ↔ Sheets integration (M)

Implements section 4: generated responses tab keyed by question key, annotation columns, polling refresh, access rules, "Open in Sheets" from Responses, "Create sheet from form" and "Link existing sheet".

### Phase 5: Advanced Sheets (L each)

Charts, conditional formatting, data validation dropdowns, pivot tables, protected ranges, per-spreadsheet sharing (viewer/commenter/editor), version history (snapshot per N revisions), live co-editing with presence (Yjs) only if demand is proven.

### Phase 6: Pricing and limits (S, owner decision)

Sheets is not in any plan today. Decide whether Sheets is included in Forms (recommended: yes, it makes Forms + Sheets the affordable bundle) and set limits for spreadsheets, cells and history retention. Update `PRICING_PROPOSAL.md` with dated competitor snapshots before any price claim.

### Phase 7: Production readiness (ongoing)

PostgreSQL tests for every new table, performance budget (grid scroll at 60 fps with 100k cells, formula recompute < 100 ms for typical sheets), security review of formula evaluation (no `eval`), CSV/XLSX formula-injection escaping on export, rate limits, backup/restore coverage, rollback notes per migration.

### Owner decisions needed

1. Approve Phase 0 (splitting the uncommitted tree) before new work.
2. Formula engine: IronCalc spike vs. Formula.js fallback vs. paying for HyperFormula.
3. Whether Sheets is bundled into the Forms plan.
4. File-upload storage and cost owner (unchanged from earlier).
