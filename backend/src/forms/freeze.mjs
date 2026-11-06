// The Forms authoring freeze (docs/RELEASE_ACCEPTANCE.md, "Safe rollback order"). It stops every change an
// author can make to forms, in the service functions, so no route or later caller can go around it.
// Public submissions, reading, exports and deleting responses are not authoring and stay available.
import { fail } from '../http.mjs';

export function assertAuthoringOpen(app) {
  if (app.config.formsAuthoringFrozen) fail(423, 'forms_authoring_frozen', 'Editing forms is paused while a release is in progress. Nothing was saved, and your live forms keep working. Try again later.');
}
