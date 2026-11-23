# Forms and Flow acceptance — 18 November 2026

Forms/Flow acceptance and the pending Meet credit regression are complete for the current staging build. The new screenshot-driven Sheets expansion is separate ongoing work.

## Corrections

- Updated the PostgreSQL video-concurrency fixture to fund exactly five ten-minute reservations using the current credit conversion. It now verifies five admitted requests, five insufficient-credit responses, zero available units, the exact reserved balance and a consistent immutable ledger. Runtime pricing was not changed.
- Form definition import/export now preserves response collection settings, number limits, scale labels, dropdown presentation and quiz feedback. Strict nested-key checks still reject unsupported properties; imported response arrays remain forbidden. Public quiz definitions continue to omit answer keys and feedback.
- Flow simulation now fills answer placeholders with fictional values derived only from the selected form structure. It never reads respondent data or creates tasks, emails or runs.
- A form's browser-tab title now follows title edits, undo/redo and restored drafts.

## Checks

- Full unit/integration suite: 470 total, 463 passed, seven opt-in PostgreSQL skips, zero failures.
- PostgreSQL acceptance: 40/40 passed over verified TLS, including the previously failing Meet credit concurrency case, Forms imports/quiz privacy, response edits/uploads, quotas and Flow side-effect/retry behavior.
- Final Chrome browser suite: 1,160 layout checks at 320/375/768/1280 widths in light/dark themes; all journeys passed, including validation, conditional questions, save conflicts, keyboard navigation, preview versus publishing, responses, CSV, Flow simulation and delivery evidence.
- The live Chrome staging journey created `Disposable acceptance QA Nov 18` (form `2297f0e0-a05d-4582-bca5-5cda1f9671ad`). It saved character limits and private-edit settings, verified preview creates no response, published version 1, rejected a short answer, accepted one response, edited that same response and showed the changed answer in the same Sheets row.
- `Disposable acceptance workflow Nov 18` (`a366363d-4fd9-4593-bb4b-8ac464ae0ac4`) created one correctly rendered task with a four-hour deadline, with a succeeded run and one attempt. Editing the response did not replace the original task text. The QA task is marked done; the workflow is saved paused and the QA form is closed to new responses. These inactive examples remain available for review; they were not deleted.
- The deployed Flow simulation displayed `Disposable QA follow-up Sample Respondent`, confirming the blank-placeholder fix. Simulation itself created no task.
- No real email or SMS was sent during these new live acceptance checks. Email provider retry, failure, recovery and duplicate prevention were verified with controlled test providers.

## Staging deployment

CloudFormation `schedora-web-staging`: UPDATE_COMPLETE. ECS task definition `schedora-web:11`: COMPLETED, one running/desired task and no pending tasks.

Image: `255948905492.dkr.ecr.ap-south-1.amazonaws.com/schedora-web@sha256:b4b9e63c01ec0ef6ac3febdc123eed609bed3b3780e8605d86a0e0c8bca09bdb`.

Private EFS attachments, scanner settings, email provider and the existing LiveKit pilot settings were preserved. No secret values were retrieved. No Git commit, merge or push was performed, and production cutover is not part of this acceptance run.
