# Schedora Sheets

Updated 19 November 2026. See the [screenshot expansion checklist, verification and boundaries](SHEETS_EXPANSION_2026-11-19.md). Open a form’s workbook from **Forms → Responses → Open in Sheets** (`/sheets/:formId`), or open **Sheets** (`/sheets`) to create and share a standalone workbook.

## What is where

| Piece | File |
|---|---|
| Editor page (grid, menus, toolbar, tabs, clipboard, find, filter, import/export) | `frontend/js/sheets.mjs`, `frontend/sheets.css` |
| Sync engine (queue, conflicts, offline, undo) | `frontend/js/workbook-sync.mjs` |
| Formula engine (parser, evaluator, reference rewriting) | `backend/src/shared/sheets-engine/` → browser modules via `npm run sync-shared`. See [the engine architecture](SHEETS_ARCHITECTURE.md). |
| CSV / TSV / XLSX | `frontend/js/sheet-files.mjs` |
| Workbook shape, limits and change operations (server and browser) | `backend/src/shared/workbook-ops.mjs` → copied to `frontend/shared/` by `npm run sync-shared` |
| Server: workbook, change batches, sync and presence, linked response grid | `backend/src/forms/workbooks.mjs` |
| Tests | `backend/test/forms-workbooks.test.mjs`, browser: `npm run sheets-check` |

The table is still `form_workbooks` (migration 019): one JSON document per form with a `revision`. Prototype workbooks (cells only, 12 × 50) are read with default size and formats; nothing is rewritten until someone edits.

## Routes

| Route | Permission | Purpose |
|---|---|---|
| `GET /forms/:id/workbook` | `responses.read` | Sheets, revision, `can_edit`, response signature, limits, form title |
| `POST /forms/:id/workbook/changes` | `responses.read` + `forms.manage` | Apply a batch of operations |
| `POST /forms/:id/workbook/sync` | `responses.read` | Poll: sheets only if the revision moved, response signature, other viewers |
| `GET /forms/:id/workbook/responses` | `responses.read` | The linked Form Responses grid |
| `PUT /forms/:id/workbook` | `forms.manage` | Whole-workbook save, kept for the prototype editor during a staggered deploy |

All are allowed during a Forms authoring freeze (owner decision 13 Nov 2026); see `backend/test/forms-freeze.test.mjs`.

## Collaboration

Every edit is an operation that records what the editor saw (`from`) and what it writes (`to`): `cell`, `format`, `sheet-add`, `sheet-delete`, `sheet-name`, `sheet-move`, `sheet-prop` (rows, columns, frozen rows, column widths).

- **The server applies an operation only if the stored value still equals `from`.** If it already equals `to`, the operation counts as done, so a retried request never applies twice. Anything else is a **conflict**: the stored value is kept and returned.
- **Different cells never conflict.** Two people editing A1 and B1 at the same time both land.
- **The same cell:** the first save wins. The second person's value is kept in a conflict panel ("Yours / Saved") with **Use mine**, **Keep saved**, and "all" versions. Nothing is lost until they choose.
- **Unsynced edits survive reloads and lost connections.** The queue of unsent operations and any open conflicts are written to browser storage after every edit, keyed by user, workspace and form. On reload the page loads the workspace version, replays the queue on top, and sends it. Offline, the status says how many changes are kept, and the page retries with backoff and on the browser's `online` event.
- **Edits made while a value is being typed** carry the value the cell had when editing began, so a change someone made in the meantime becomes a conflict.
- **Undo and redo** are per person: they write earlier values as new edits and skip any cell someone else changed since (with a note).
- **Presence:** each open page polls every 3 seconds and reports its sheet and cell. Other viewers show as avatars, and their active cell has a coloured outline. Presence is kept in server memory for 15 seconds; with several server instances, each sees only its own viewers. It is a hint, never a lock.
- **Prototype drafts** stored by the old editor (`{ revision, pending, sheets, baseSheets }`) are converted into operations on first load.

Live updates are polled, not pushed: another person's edit appears within about 3 seconds.

## Standalone workbooks and sharing

Open **Sheets** from Forms or visit `/sheets`. Create a workbook there without creating a form. A workbook starts private to its owner. **Share** grants a workspace member viewer or editor access, or removes it. Viewers can read every tab, including linked responses. Leaving the workspace removes shared workbook access.

From **Forms → Responses → Manage response link**, use an existing editable workbook or create a new one for the form. One additional live destination is supported per form. Unlinking keeps a snapshot and relinking catches up with responses submitted since.

## The Form Responses sheet

The live tab is generated from the responses table. Choose **Edit a copy** in its banner or tab menu to make an editable workspace tab from the loaded responses. The copy preserves text that looks like formulas as literal values. New submissions continue appearing in the live tab, and editing a copy leaves original submissions intact.

- **Row 1 is headers; every response keeps its row.** Rows are oldest first, so a new response is added at the bottom and never moves earlier ones. `='Form Responses'!G2` keeps pointing at the same response as responses arrive. (Deleting a response moves the rows after it up, as in other spreadsheets.)
- **Columns A–F are fixed:** Submitted at (UTC), Receipt, Form version, Score, Next step, Verified sign-in email. Each question then has its own column, **in the order questions were first published**, so publishing a new version adds columns at the end instead of shifting existing ones. Link-attribution columns come last.
- **Answers are literal data.** They are never parsed as formulas, and only plain numbers are read as numbers, so `=HYPERLINK(...)` or `=99` stays text. Copying from this sheet keeps such text as text. CSV and XLSX exports prefix formula-like text with an apostrophe.
- **Searching, filtering or sorting never changes references.** The Responses page search doesn't reach this grid. Sorting or filtering inside Sheets changes only the view. Row headers always show each row's real number, so what you see and what formulas read agree.
- **Recalculation:** the poll returns a response signature (count, newest submission, live version). When it changes, the grid reloads and updates cached formulas affected by the changed cells or the open range's extent.
- **Quiz scores** are computed on the server from the published definition. Answer keys never reach the browser.
- **Size:** up to 4,999 responses. Beyond that the sheet says it shows the first ones, and references past the loaded rows are `#REF!`, never a guessed blank.

## Editing

- **Layout:** title, menus (File, Edit, View, Insert, Format, Data, Help), toolbar, name box and formula bar, grid, sheet tabs, and selection totals (Sum, Average, Count).
- **Grid:** a canvas draws the visible cells. An overscanned DOM window preserves keyboard and screen-reader navigation. Saved sheets support up to 5,000 rows × 52 columns (A–AZ) and 30 editable tabs per workbook. New sheets start at 1,000 × 26 (**Insert → Add 100 rows**).
- **Selection:** click, drag, Shift+click, Ctrl/⌘+click for disjoint selections, row and column headers, the corner (select all), and the name box (`B12` or `A1:C20`).
- **Editing:** type to replace, Enter/F2/double-click to edit the full text, Ctrl+Enter (also ⌘+Enter or Alt+Enter) for a line break, and Tab/Enter to commit and move. Click a cell when a formula expects a reference. Ctrl/⌘+Shift+Enter fills the selected range from the active edit. Drag the selection handle to extend a series.
- **Resize:** drag the right edge of a column letter or bottom edge of a row number. The cursor changes for the axis; release saves, Escape cancels. Editable-sheet sizes sync and support undo/redo. Linked response sizes are private view preferences and do not modify submitted answers.
- **Clipboard:** Ctrl+C, X and V with tab-separated text, compatible with Google Sheets and Excel. Pasting inside Sheets keeps formulas (shifting relative references) and formats. Cut moves.
- **Formatting:** bold, italic, underline, strikethrough, text and fill colours, alignment, font size and family, and borders. **Cell style** adds notes, wrapping, custom row heights and date, time, date and time, duration, scientific and accounting formats. **Format** can merge or unmerge a selection. Only the top-left cell of a merge can contain a value, and a merge stays within one frozen or scrollable pane. Unmerge affected cells before sorting or filtering or making structural changes through them.
- **Structure:** insert and delete rows and columns with updated formula references, fill down or right, drag to resize columns or double-click to fit, freeze rows or columns, change zoom, and add, rename, duplicate, move or delete tabs.
- **Data:** sort a sheet or range. Sort-view and filters affect this browser's view. **Data** also offers dropdowns, checkboxes, allowed number ranges, conditional numeric fills and named ranges.
- **Charts and pivots:** **Insert → Chart from selection** supports column, line and pie charts. **Pivot table from selection** groups by rows and optionally columns with sum, count of nonblank values, or average. Save them to an editable tab and reopen them from **Saved charts and pivot tables**. Open reports refresh as the workbook syncs. Reports can follow new form responses, and charts can be downloaded as PNG and pivots as CSV.
- **Find and replace:** Ctrl+F / Ctrl+H.
- **Import and export:** CSV, TSV and XLSX. Excel exchange preserves supported formulas, basic styles, dimensions, compatible frozen panes and merged ranges. CSV and TSV exports include displayed spill values. Clipboard HTML carries basic formatting alongside text.
- **Version history:** **File → Version history** lists up to 25 saved workbook revisions. Restoring a revision creates a new revision of editable tabs.
- **Comments:** **Insert → Cell comments** opens the thread for the active cell on an editable tab. Threads are tied to the address and are independent of workbook version history.
- **Response links:** **Forms → Responses → Manage response link** opens the workbook link controls. A form can send responses to one additional workbook in its workspace. Unlinking leaves a snapshot in the destination, and relinking refreshes it with submissions received during the pause.

**Formulas:** `+ - * / ^ &`, comparisons, `%`; references `A1`, `$A$1`, `A1:B5`, `C:C`, `C2:C`, and `'Sheet name'!A1`. Functions: SUM, AVERAGE, COUNT, COUNTA, COUNTBLANK, COUNTIF(S), SUMIF(S), AVERAGEIF(S), MIN, MAX, MEDIAN, PRODUCT, IF, IFERROR, IFNA, AND, OR, NOT, ROUND(UP/DOWN), ABS, INT, MOD, POWER, SQRT, CONCAT(ENATE), TEXTJOIN, LEN, LOWER, UPPER, PROPER, TRIM, LEFT, RIGHT, MID, SUBSTITUTE, FIND, SEARCH, VALUE, ISBLANK, ISNUMBER, ISTEXT, ISERROR, VLOOKUP, HLOOKUP, MATCH, INDEX, ROWS, COLUMNS, TODAY, PI. Errors: `#REF!`, `#VALUE!`, `#DIV/0!`, `#NAME?`, `#N/A`, `#NUM!`, `#CYCLE!`, `#ERROR!`. There is no `eval`; formulas are parsed and interpreted. The owner's decision to run an IronCalc proof of concept (Formula.js as fallback) still stands; this engine is the interim one.

The library also includes XLOOKUP, IFS, SWITCH, DATE, DATEVALUE, YEAR, MONTH, DAY, EDATE, EOMONTH, FILTER, SORT, UNIQUE, TRANSPOSE, SEQUENCE, SPLIT and ARRAYFORMULA. Array results fill neighboring cells if there is room and return `#REF!` when blocked.

**Keyboard shortcuts:** Ctrl/⌘+/ (Help → Keyboard shortcuts) lists them all. Highlights: arrows, Shift+arrows, Ctrl+arrows (edge of data), Home/End, Ctrl+Home/End, Page Up/Down, Ctrl+A, Ctrl+Space, Shift+Space, Ctrl+D/R, Ctrl+B/I/U, Ctrl+Shift+L/E/R, Ctrl+Shift+1/4/5, Ctrl+\, Ctrl+;, Ctrl+`, Ctrl+Shift+F, Alt+↓/↑ or Ctrl+Shift+PgDn/PgUp (switch sheet), Shift+F11 (new sheet), Shift+F10 (cell menu).

**Accessibility:** ARIA grid with `aria-activedescendant`, real row and column indexes, `aria-selected` on the selection, menus with arrow keys and Escape, tabs with arrow keys, and a labelled formula bar and name box.

## Verification

- `npm test` includes these Sheets tests: change batches and conflicts, two signed-in sessions over HTTP (different cells, same cell, conflict recovery, offline queue across a reload, undo), the linked grid through a published quiz form (order, literal answers, server-side scores, recalculation, search independence), formulas, reference rewriting, CSV and XLSX.
- `CHROME_PATH=… npm run sheets-check [-- --screenshots <dir>]` covers two isolated signed-in browser contexts and a signed-out respondent filling in a published form. It exercises collaboration, response copies, formulas and spills, cut and undo, Canvas selection, frozen columns, comments, charts, exports and clipboard formats. Add `--keep-open` to leave the server running for manual testing.
- `npm run sheets-benchmark` checks the 50 ms engine budget for a small edit in a workbook with 100,000 cached formulas. See [the engine architecture](SHEETS_ARCHITECTURE.md) for dependencies and volatile formulas.

## Parity with Google Sheets: still open

| Area | Gap |
|---|---|
| Files | External sharing, ownership transfer and links that grant access by themselves. |
| Live editing | WebSocket sync, distributed presence, comment resolution, mentions and live thread refresh. |
| Concurrency | Structural edits (insert/delete rows, sort) are expressed as cell moves; a concurrent edit to a moved cell becomes a conflict rather than following the move (no operational transform). |
| Formatting | Custom border styles and colours, general conditional rules and sorting through merged ranges. |
| Data | Multi-field pivots, pivot output as a range, shared filter views, protected ranges, remove-duplicates and split-text tools. |
| Formulas | The broader library, including QUERY, IMPORTRANGE and named functions. Complete function signature hints. |
| Grid | Hidden rows and columns. |
| Insert | Charts placed directly on the grid, images and hyperlinks. |
| Import/export | PDF and ODS, shared or dynamic Excel formula encoding, and Excel charts and validation rules. |
| Linked tab | Reverse form creation. Each linked tab currently shows up to 4,999 responses. Timestamps are UTC text. |
| Mobile | Usable for reading, selecting and editing, but menus are the desktop ones, and there is no touch-specific selection handle. |
