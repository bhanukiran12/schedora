# Final Forms and Sheets validation — 21 November 2026

## Current request

Complete the remaining review and final tests, then add draggable row heights/column widths with visible resize cursors. Flow development stays on hold.

## Test results

- Main suite: **472 passed**, zero failures; seven opt-in PostgreSQL tests skipped in this ordinary run.
- Separate verified-TLS PostgreSQL run: **60 passed**, zero failures/skips. Covers the seven opt-in checks plus Forms reliability, uploads/media, workbooks, migrations, concurrency and session offers. The disposable local certificate had expired; it was renewed without disabling TLS verification. The disposable database container was stopped afterward.
- Full product browser suite: **all journeys passed**, **1,160** layout checks at 320/375/768/1280 px in light/dark themes; no runtime errors or overflow. This completed before the Sheets-only axis-resizing addition; that addition is covered separately by the Sheets suite below.
- Sheets: **41 expanded journeys passed** after axis resizing, including native mouse/keyboard editing, row/column resizing, persistence, undo/redo and canceled drags. The supplemental linked-response-view check also passed: its frozen header row retains its resized height after reload, while the canonical grid stays read-only. An initial test selector omitted the tab's leading icon; correcting the selector resolved that test-only failure without changing runtime code.
- Syntax: **252 files** checked. Sheets type checking and shared-source synchronization checks passed.
- Staging preflight: **11/11 passed**: staging host/API routing, product domain, health and PostgreSQL storage.

## Row and column resizing

- Hover at the right edge of a column letter for the horizontal resize cursor, or the bottom edge of a row number for the vertical resize cursor.
- Drag to preview the size; release to save. Column widths remain bounded at 24–800 px; row heights at 20–240 px. Zoom is accounted for.
- Undo/redo applies to saved editable-sheet size changes. Escape or a canceled pointer gesture discards the preview.
- Preview sizes are held separately from the synchronized workbook, so an unfinished drag cannot silently mutate saved data. Existing optimistic conflict checks apply when the final size is saved.
- Linked response-row sizes are local view preferences; the canonical response values remain read-only. Editable workbook sizes persist on the server. View-only access cannot change saved workbook dimensions.

## Remaining feature scope

These are separate future work, not failed checks in this release:

1. External Sheets data connectors, Google Marketplace/Apps Script compatibility and live Google-hosted chips/finance services.
2. Automatic Forms lead scoring/prioritization. Current qualification mode collects fit information and uses the existing logic/routing tools.
3. Flow product review and improvements, pending the user's instructions.
4. Production launch acceptance and cutover; this work deploys to staging only.

Existing workbook limits still apply: 30 editable tabs, 5,000 rows, 52 columns and 2 MB per workbook. Full Google Sheets parity is not claimed.

## Deployment

Staging task definition **18** rollout accepted, cloning task 17 with only the application image changed. Image digest: `sha256:775c0647e692b28d8fb1ba811983bcc16fe6d9be202fdd61be5c1b1903f18977`.

Final rollout completed: **CloudFormation UPDATE_COMPLETE**, **ECS COMPLETED**, one running task and zero pending on task definition **18**. The 11-check staging preflight passed again after deployment.

Signed-in Chrome verification was interrupted by the extension reporting an unattached debugger during the final reload. No successful manual post-deployment resizing check is claimed. The real headless Chrome suite verified resize cursors, native pointer drags, persistence, undo/cancel and linked view preferences; [its screenshot shows the enlarged row 20 and column B](evidence/sheets-axis-resize-2026-11-21.png).

Existing changes were preserved; no Git commit/push or production cutover.
