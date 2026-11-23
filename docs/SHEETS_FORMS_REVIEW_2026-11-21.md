# Sheets editing fix and Forms review — 21 November 2026

## Sheets correction

The formula bar was an HTML single-line input. Assigning a multiline cell to that field stripped its newlines; editing from the bar could then save the flattened text. This was reproduced in Chrome before the correction.

- The formula bar is now a textarea that retains line breaks. It expands while focused, up to 150 px, with scrolling for longer content.
- Moving an unfinished cell edit into the formula bar transfers the draft and selection without committing or flattening it.
- Delayed blur callbacks only commit the edit that actually lost focus, not a newer edit.
- Reopened cell editors reset their previous scroll offsets before positioning the caret.
- After saving from the formula bar, its value immediately follows the newly selected cell. The final live Chrome pass exposed the previous stale-value behavior, and the regression now also checks that the next blank cell has a blank formula bar.
- Alt+Enter inserts a line break in either editing area. Enter saves; Escape cancels.

The new real-keyboard regression saves multiline/long text, reloads the workbook, edits the formula bar, reopens the cell, transfers an unfinished edit between editors, inserts another line, and verifies the retained content. It failed before the correction and passed afterward.

## Forms acceptance

The current Forms implementation was reviewed through the existing full product browser suite and Forms/Sheets integration journeys. All passed:

- Blank-draft creation; question/options editing, safe type changes, reordering and keyboard focus.
- Required answers and type/answer validation, date bounds, grids, number/scale/time fields, quiz scoring and private answer keys (server tests).
- Branching, hide-choice rules, link parameters, preview without submissions, and server-side path enforcement.
- Draft save conflicts, undo/redo, desktop/phone preview, themes and typography, versioned publishing, unchanged published appearance after later draft changes.
- Classic/conversational submission, embeds, response inbox/detail/CSV, linked Sheets rows and private respondent edits updating the same response.
- Private file question uploads and host download using an injected test scanner in the browser fixture; attachment retain/remove/replace and upload isolation in server tests. This run does not repeat the real staging antivirus/persistence checks recorded on 18 November.
- Responsive/accessibility checks, light/dark themes and mobile editing surfaces.

This verifies the implemented Forms release, not every Google Forms/Sheets capability or every external integration. Lead qualification currently guides collection and routing; automatic lead scoring is not implemented. External Sheets connectors, Google Marketplace and Apps Script compatibility remain outside the implemented feature set.

## Validation

- `npm test`: 479 tests, 472 passed, seven optional PostgreSQL tests skipped, zero failures. No separate PostgreSQL run was needed for this frontend-only correction.
- `npm run sheets-check -- --expanded`: all 39 journeys passed, including offline recovery, collaboration and the new regression.
- `npm run browser-check`: all journeys passed; 1,160 layout checks across 320/375/768/1280 px in light and dark themes; no runtime errors or page overflow.
- `npm run check`: 252 files checked.
- Sheets type checking and all shared-source mirror checks passed.
- `git diff --check`: passed (existing line-ending warnings only).

Flow work is on hold at the user's request. The existing full-suite Flow regression checks ran without changing Flow code.

## Staging

### Follow-up: Ctrl+Enter and double-click

At the user's request, Ctrl+Enter now inserts a newline in the cell editor and formula bar, alongside Alt+Enter (and Command+Enter on Mac). Filling a selected range from the active edit moved to Ctrl/Command+Shift+Enter; the shortcut guide and existing fill regression were updated.

Real mouse input reproduced a double-click failure: the first selection redraw replaces the cell node, so a browser `dblclick` can target a parent instead of the cell. The grid now recognizes a rapid second click on the same cell across redraws, ignores drag movement, and opens the full editor. Dropdown/checkbox cell behavior and read-only restrictions remain enforced.

The added regression failed before the correction and passed afterward: native double-click, Ctrl+Enter in both editing areas, and exact multiline content after saving/reopening. All **40** expanded Sheets journeys, 252-file syntax checks and Sheets type checking passed. This follow-up changes only Sheets editing and documentation; the earlier Forms review remains the evidence for Forms.

Task definition **17** completed: CloudFormation UPDATE_COMPLETE, ECS COMPLETED, one running task, zero pending. It clones task 16 with only the application image changed. Image digest: `sha256:4b720a1d6de0fe8f2bbd9c7b743f51ed3ba5d61ae630977e8240b63cce9a06fe`. Live signed-in Chrome confirmed a real double-click opens the full editor, Ctrl+Enter adds lines in both editing areas, and both new lines survive saving/reloading and another double-click. [Screenshot](evidence/sheets-double-click-ctrl-enter-2026-11-21.png). The private review workbook remains open; no existing user workbook was changed.

### Earlier multiline correction

Task definition 15 completed the first correction. The follow-up formula-bar selection correction was retested with all 39 Sheets journeys, then rolled out as task definition 16 using the current task 15 configuration with only the application image changed. Final image digest: `sha256:8b60a8ba1483ddc2769ff2ee4ad37be46e04b986487bd8e3f9fae6df370adecf`.

Final rollout completed: CloudFormation `UPDATE_COMPLETE`, ECS `COMPLETED`, one running task and zero pending tasks on task definition **16**. Live signed-in Chrome verified saving B3 with multiline/long text, leaving the workbook and returning, retaining all line breaks, editing through the formula bar, adding a fourth line with Alt+Enter, and reopening the cell editor with exactly the expected content. After Enter moved to blank B4, the formula bar was immediately blank. The expanded editor was visually confirmed in the existing dark theme.

The private review workbook is [Multiline editing review — 21 Nov](https://forms.staging.schedora.in/sheets/workbooks/53d06158-3b43-4f06-89dc-7b9c594c76a6); it contains only synthetic review text. Existing user workbooks were not edited. [Screenshot](evidence/sheets-multiline-staging-2026-11-21.png).

The staging Forms builder and its respondent preview were also inspected in Chrome using the already closed disposable acceptance form, without changing or republishing it. Existing checkout changes were preserved; no Git commit/push or production cutover was performed.
