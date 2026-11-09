# Public pages and demo polish

Reviewed and completed locally on 2026-11-09, on `codex/public-site-demo`.
Continues the unfinished public-site changes left by Claude after `f1afc66`.

## Behaviour

- Marketing pages render before configuration/account requests finish. Signed-in identity is refreshed when available; demo entry does not request backend configuration or account data.
- Suite hero has a primary Try the demo action and secondary Explore products action.
- All four demo product links stay available in Settings. Explicit demo product selection takes precedence over the host, including returning to All products from a product subdomain.
- Demo signup links identify the product and preserve its setup destination through switching to login. Demo data is not imported into the real workspace.
- Sample booking dates move forward while visitor-created historical bookings remain unchanged. Upcoming lists exclude past calendar dates. Same-day time-of-day filtering remains outside this change.
- Forms demo exposes Edit, Responses and Preview. Responses links filter to the selected form. Forms tables become stacked rows at narrow widths.
- Flow's failed-run callout appears before statistics, with review/retry and filtered-history actions.
- Demo navigation, labels and supporting text are larger. Live builder and respondent typography settings remain separate.
- Billing uses one evaluation-access statement where all products have evaluation access; the comparison table and product grid fit smaller screens.

## Routes exercised

| Surface | Verification |
| --- | --- |
| Suite `/` | Local anonymous rendering, primary actions, responsive layout |
| `/products/meet`, `/products/forms`, `/products/flow` | Local anonymous product landing layouts |
| Product subdomain roots and login/signup | Existing full browser journey using product.localhost hosts |
| Suite login/signup | Layout and safe return paths; no external identity provider |
| `/billing` | Anonymous layout plus signed-in billing in full regression suite |
| `/demo`, `/demo/meet`, `/demo/forms`, `/demo/flow` | Layout, product links, setup handoff; no backend API requests |
| `/demo/settings` with each product | Navigation retained; selected context retained |
| Forms-host Flow demo → Settings → All products | Explicit cross-product context preserved |
| Form-specific demo responses | Filter preserved, responsive layout |

## Evidence and limits

- Unit suite: 400 tests, 393 passed, 7 optional PostgreSQL tests skipped.
- Full regression browser suite: 1,032 layout checks passed. This ran before the last demo-only responsive/context refinements.
- Focused public browser suite rerun after those refinements: use `npm run browser-check -- --public-only`. It checks 320/375/768/1280 widths, 1440px demo layout, 640px desktop reflow equivalent to a 1280px viewport at 200% zoom, phone Escape/focus, signup handoff and demo network isolation.
- The browser suite emulates light/dark colour-scheme preferences; this is not a manual screen-reader or complete contrast audit.
- `npm run check`, shared-file sync and `git diff --check` passed during completion.
- PostgreSQL CI, production hosting, real OAuth/SSO and actual browser zoom interaction were not run in this continuation.
- New screenshots are under `C:/Users/Nxtwave/.codex/visualizations/2026/11/05/01a1aba6-8447-77a2-92e4-8e165b4839a7/public-polish/after`.
- Claude's previous public screenshots were copied to the sibling `claude-before` folder. They are preserved reference material, not newly captured baseline evidence.

No production configuration, respondent sign-in setting, live form or response was changed. No merge or deployment is part of this work.
