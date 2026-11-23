# Schedora Sheets engine

## Phase 0 · Compatibility baseline

The workbook editor uses the existing Schedora workspace, routes and storage. Each sheet stores its raw cell entries in a sparse object keyed by A1 address. The shared workbook operations still validate dimensions, edits and formats. Form Responses is a literal sheet supplied by the Forms API. The editable response-copy action still creates a regular workspace sheet.

The compatibility tests pin relative and absolute references, sheet names containing apostrophes, blank cells, lazy `IF`, range errors, cycles, and the treatment of formula-like text from responses. The golden suite checks 29 examples in the TypeScript engine and the generated browser build. Expected core function behavior follows the [Google Sheets function reference](https://support.google.com/docs/table/25273?hl=en).

## Phase 1 · Engine core

- `index.mts` provides the public engine functions and types. The editor still imports through its `sheet-formulas.mjs` entry point.
- `types.mts` defines the formula tree, sheet input, parsed input, cell values and typed spreadsheet errors.
- `parser.mts` parses formulas with precedence, function calls, references and error literals. `address.mts` rewrites references when copying formulas or editing sheet structure. It preserves absolute coordinates, quoted names and string literals.
- `evaluator.mts` calculates against the supplied sheets. An evaluator caches results for that workbook view, detects cycles, and bounds evaluation work.

`parseInput` distinguishes formulas, numbers, percentages, currency, booleans and text. It also recognizes calendar-valid ISO dates as UTC dates and `HH:mm[:ss[.sss]]` times as a fraction of a day. The workbook evaluator retains existing text behavior for dates and times so saved formulas keep the same results. The live response sheet only coerces plain numbers and treats submitted text literally.

`createEvaluator(sheets)` takes the existing sheet objects and returns `value(sheet, address)` and `block(...)`. Each returns a value or an error object with a spreadsheet error code. Passing the sheets up front provides access to the sparse cell keys, which are needed to calculate open-ended ranges. The older `sheetValue(...)` helper continues to throw for formula errors.

The TypeScript source has no browser or I/O dependencies. `npm run sync-shared` type-checks it and emits the browser modules to `frontend/shared/sheets-engine`. CI compiles into a temporary directory and compares the output with the checked-in browser files using `npm run sync-shared -- --check`. The production server and static frontend serve the generated modules with no build step at startup.

## Phase 2 · Incremental recalculation

`dependencies.mts` records reverse edges for formulas the editor has evaluated. A single-cell reference takes a direct edge. Rectangles are indexed as disjoint two-dimensional segments so a changed cell can find covering formulas without enumerating each range or scanning every formula. Open-ended references also track the last populated row of their source sheet. A formula that reads a different branch on its next evaluation replaces its previous subscriptions.

`update(sheets, changes)` takes changed addresses for in-place edits and undo/redo. `update(sheets)` compares the raw cells in new sheet snapshots from syncing and from live responses. Both follow reverse edges transitively, order affected cached formulas with their precedents first, and keep other cached results. Renames, added or removed sheets, and changes to reference bounds rebuild the cache and graph. Formulas that have yet to be read evaluate on demand.

Actual reads detect cycles, so a formula that only reads the shape of a range can include its own cell. All members of a live cycle receive `#CYCLE!`, and editing a reference can recover the cycle. The evaluator retains its work and recursion limits for cold dependency chains and unusually expensive formulas.

`TODAY`, `NOW`, `RAND`, `INDIRECT` and `OFFSET` refresh on each recalculation pass. Time-based formulas share one clock reading per pass, and repeat reads of a cached random cell return the same value until the next pass. `TODAY` keeps its ISO text display. `NOW` returns a numeric date-time serial until date-time formatting is added. `INDIRECT` accepts A1 references, including cross-sheet references. `recalculate()` explicitly starts a pass and returns counts of invalidated cells and evaluated formulas.

`npm run sheets-benchmark` warms 100,000 formulas, then runs 40 single-cell edits. Each edit recalculates three dependent formulas and checks the 50 ms budget. Timing covers the engine update and excludes rendering and network sync.

## Phase 3 · Editing commands and undo

Cut and paste, row and column changes, and drag-fill use grouped workbook operations. The server checks each group's expected values against a temporary copy and writes the group as a unit. A concurrent edit to an affected cell prevents the entire group from saving. Undo follows the same rule for grouped changes, and independent cell edits continue to merge separately. The offline queue preserves operation order and sends batches within the existing operation limit.

`sheet-commands.mjs` moves a snapshot of the selected cells and formats before rewriting references. An absolute reference follows the moved cell during a cut. During a copy or formula fill, only relative coordinates shift. A rectangular reference wholly contained in the moved cells follows them. A partially overlapping rectangle keeps its original bounds, since following just the moved portion would require a disjoint union. Drag-fill extends numeric progressions, ISO dates, English weekdays and months, and numbered text. Unrecognized selections repeat, with relative formula references shifted per destination cell.

## Phase 4 · Canvas grid

`sheet-grid.mjs` draws cell text, gridlines, formatting, selection and presence at the device pixel ratio. Row and column offset tables locate the visible rectangle. Frozen rows and columns and the scrolling area are clipped separately. A small DOM window keeps the spreadsheet's ARIA grid, browser hit targets, filter and resize controls, and the real text editor used for formula entry and input methods. The name box and keyboard move selection through the same viewport calculations. Column borders support drag resize and double-click autofit. During formula entry, clicking a cell inserts its A1 reference and highlights the referenced cell.

The browser check exercises drag-fill, grouped undo, formula point entry, disjoint selections and far horizontal scrolling. It also drives 45 paint frames against a synthetic one-million-cell array and measures draw time and frame cadence. The performance sample measures the canvas renderer. Saved workbooks use 5,000-row, 52-column, and 2 MB limits. Ctrl/⌘+click adds disjoint regions for formatting, clearing and keyboard fill. Clipboard and structural actions use one rectangular range.

## Local verification

Run the following from `backend` after `npm ci`.

```sh
npm run typecheck:sheets
npm run sync-shared -- --check
npm run check
node --test test/sheets-engine.test.mjs test/sheets-recalculation.test.mjs test/sheets-commands.test.mjs test/forms-workbooks.test.mjs
npm run sheets-benchmark
npm run sheets-check
```

## Formatting, formulas and workbook records

Row heights and column widths use cumulative offsets to find the viewport. The renderer separates frozen column bands and frozen rows from the scrollable area. Number formats and validation rules are persisted in cell metadata. The server also checks validation on cell writes.

Array formulas resolve their spill ranges before publishing the displayed values. An occupied destination returns a reference error. Scalar-only workbooks retain incremental dependency recalculation. Workbooks with array anchors rebuild cached values and spill ranges on demand after an edit.

Version snapshots are bounded to the latest 25 saved revisions. Restoring checks the currently saved revision and records the restore as a new revision. Form response links are workspace-scoped. Live links derive rows from submitted responses, while unlinking freezes the current rows in the destination. Cell comment threads are separate from the workbook document so a normal edit or version restore does not overwrite comments.
