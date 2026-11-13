# Schedora production architecture and security audit

**Reviewed:** 11 November 2026  
**Scope:** repository evidence only. This is not a penetration test, compliance certification, or verification of Render, Supabase, DNS, payment, email, or identity-provider settings.

## Current architecture

- The product is a JavaScript single-page application served by a modular Node.js API. A root Dockerfile packages both into one Render web service. The app does not currently use server-side rendering, static generation, or incremental regeneration for workspace pages.
- The database layer supports SQLite for local work and PostgreSQL for hosted use. The Render Blueprint currently selects a free service and `RELEASE_MODE=evaluation`; PostgreSQL, DNS, secrets, paid capacity, and backups must be verified in the hosting dashboard.
- Workspace-owned records carry a workspace ID. API membership checks and a centralized owner/admin/member permission map enforce tenant access in the application. API keys are scoped to one workspace. Verify every route and query with cross-workspace tests; no PostgreSQL row-level security policy was found in the checked migrations.
- Sign-in supports passwords, Google sign-in, and configurable OIDC single sign-on. OIDC uses state, nonce, and PKCE. The checked code does not provide multi-factor authentication or passkeys.
- Session cookies are HttpOnly and SameSite=Lax, Secure in production, with CSRF protection on writes. Session tokens are stored hashed. Session expiry and cookie-domain behavior still need a staging test on the final hostnames.
- Passwords use scrypt. Integration credentials and selected short-lived sign-in state use AES-256-GCM with `APP_ENCRYPTION_KEY`. This is field-level protection for selected secrets, not end-to-end encryption of customer records. The service must read booking data to schedule meetings and send confirmations.
- Security headers include a Content Security Policy, content-type protection, referrer and permissions policies, and HSTS when the request is HTTPS. Allowed-origin and proxy settings are configurable and require production-value verification.
- The repository includes a GitHub Actions workflow for syntax/shared-code checks, unit and API tests, browser journeys, PostgreSQL tests, and release rehearsal. Render Blueprint auto-deploy is enabled; the workflow does not itself gate Render deployment on those checks. Current uncommitted work has not passed the full browser suite or hosted release checks.
- The UI has shared CSS tokens and components, a local icon system, keyboard/focus patterns, and custom Forms themes. Dark/light CSS tokens exist. A user-facing Appearance setting now controls system/light/dark mode and workspace booking-page color.
- `robots.txt`, `sitemap.xml`, default Open Graph metadata, and page titles exist. The single HTML shell means public route-specific metadata is not guaranteed to be server-rendered for search crawlers. No confirmed image optimization pipeline or Core Web Vitals baseline was found.
- Optional page-view counting is implemented in process memory without identifiers. This is not durable product analytics or funnel analysis. JSON logs and health checks exist; centralized log retention, external error tracking, uptime alert delivery, and session replay are not verified in this repository configuration.
- An audit-log table and activity view exist for selected changes. This does not establish complete audit coverage, retention controls, tamper resistance, or export for every security-relevant action.
- A privacy page and data-retention controls exist. Legal review, a data-processing agreement, subprocessors list, breach process, and jurisdiction-specific compliance evidence need an owner review.

## Release gates — not yet verified

| Area | Evidence required before claiming readiness |
|---|---|
| Tenant isolation and RBAC | Automated negative tests for every API family: user A cannot read/write user B’s workspace by changing IDs, API key, form, event, booking, file, or cursor. Review application scoping and decide whether PostgreSQL row-level security is required. |
| Authentication | Stage password, Google, and OIDC sign-in, logout, revocation, expired sessions, CSRF, account recovery, and enforced SSO. Decide and implement MFA for owners/admins before enterprise claims. |
| Encryption and privacy | Verify HTTPS and database-provider encryption at rest; document encryption-key ownership, rotation, recovery, backups, retention, deletion, and incident response. Do not call the app end-to-end encrypted. |
| Security review | Dependency and container scanning, secret scanning, threat model, external penetration test, remediation tracking, and production header/cookie/origin checks. |
| CI/CD | Require CI checks before merge and deployment. Prefer staging first, smoke checks, explicit production promotion, rollback instructions, and confirmation that Render cannot bypass the intended gate. |
| Database and recovery | Verify hosted PostgreSQL, migrations, indexes, connection limits, backups, restore drill, retention, and recovery objectives using a separate database. |
| Monitoring | Route structured logs to a retained central service; configure error tracking, uptime checks, alert recipients, and a tested alert. Define privacy-safe product analytics and opt-in rules before adding session replay. |
| Accessibility | Run automated checks and manual keyboard, screen-reader, zoom, contrast, and mobile tests against core journeys. Record WCAG 2.1 AA results; ARIA use alone is not proof of conformance. |
| Performance | Capture desktop/mobile Core Web Vitals and API latency on staging with representative data. Set thresholds from measured baselines. Do not promise sub-second TTFB without measurement. |
| SEO and sharing | Test route-specific title, description, canonical and Open Graph previews as crawlers receive them; validate sitemap/robots against real public routes. Add server-rendered metadata only where discovery needs it. |
| Browser coverage | Fix current browser-check failures, run the complete suite at desktop, tablet, and phone widths, and record the tested commit and environment. |

## Recommended implementation sequence

1. Close the immediate local UX and responsive defects; pass static checks and the browser suite on the current tree.
2. Run a tenant-isolation and authentication audit, then close high-severity security findings before adding enterprise claims.
3. Verify database, backup/restore, provider flows, and recovery on staging; keep evaluation billing and video disabled until their own gates pass.
4. Add MFA and complete audit coverage based on an agreed identity/security design. Keep OIDC SSO; do not build a new identity system without a defined requirement.
5. Add deployment promotion gates, centralized monitoring, accessibility and performance budgets, and evidence capture.
6. Decide whether SEO needs SSR only after route-by-route crawl testing; avoid a framework migration without measured customer or search value.

## Immediate design checkpoint

- Meet event editing now shows a compact draft/published state, exposes only the live link when published, marks required fields, and checks browser-native validity before saving.
- Guided setup treats an outside calendar as optional, avoids warning-style skip states, and presents the booking link without the multi-panel readiness report.
- Dashboard Appearance controls now support system, light, and dark; the public landing page is always light. Dashboard dark mode uses near-black surfaces, bright text, and green primary buttons. Product colors remain accents, and the landing page uses subtle palette gradients.
- The landing page now positions Meet scheduling first, with Forms and Flow as optional connected products. The “For consultants, agencies & service teams” line is removed.
- The sidebar profile stays visible while navigation scrolls. Account settings use a generic workspace label; setup calls the event a “Booking link” instead of repeating “Meet setup”.
- The favicon now uses the Schedora S logo asset. Development sessions use the shared `.localhost` cookie domain so a local sign-in can carry across Meet, Forms, and Flow; production continues to use the configured `.schedora.in` scope.
- Authentication screens use the same Schedora green for primary actions and legal links across products, with a pale green brand panel. Invalid sign-in feedback uses high-contrast red text on a pale red background; the auth page stays light even when the dashboard theme is dark.
- Privacy choice is remembered for one year and shared across `*.schedora.in`; buttons read “Essential only” and “Allow analytics”. This affects only cookie preference, not the privacy policy itself.
- A completed browser pass checked 664 layout combinations at 320, 375, 768, and 1280 pixels in light and dark themes, with no horizontal overflow reported. It still reported 47 journey assertions failing across bookings, Forms, Flow, and Meet; some selectors are outdated, but each failure needs triage. A later rerun stalled before navigating from Chrome’s blank page, so this does not count as full browser acceptance.
- The public-only browser check passed 136 layout checks at 320, 375, 768, and 1280 pixels in both themes, with no runtime errors or horizontal overflow. The full local suite passed 393 of 400 tests; seven PostgreSQL-only tests were skipped. The local backup/restore round-trip test passed, but hosted backup and restore remain unverified. A later full browser rerun stopped before returning a report, so the earlier journey failures remain open.

## Next work session

1. Restart the local app with the new `.localhost` cookie scope and verify one sign-in carries from Forms to Meet to Flow.
2. Review the landing page, dashboard Light/Dark themes, sidebar profile, and help/setup screens at phone, tablet, and desktop sizes; rerun the responsive browser check.
3. Walk through Meet and Forms create/publish/book/respond flows and repair the browser journeys that currently fail. Then review Flow triggers, actions, and connections.
4. Revisit the approved monthly allowance of 100 Meet video credits for Meet and Suite in the billing catalog and deployment checklist; do not deploy until pricing and checkout gates are verified.
5. Finish staging evidence for database recovery, provider email/payment/calendar flows, centralized logs/error tracking, privacy-safe product analytics, accessibility, and performance before making a production-ready decision.

## Current release decision

**Not production-ready.** The 202-file syntax check passed; 393 of 400 unit/API tests passed, with seven PostgreSQL-only tests skipped because no PostgreSQL test service was configured. The local production preflight returned `ready: false` with 18 unmet environment/provider gates; it does not verify Render settings. Public browser pages passed 136 responsive layout checks, but the full browser journeys still have 47 recorded failures; a later rerun did not return a report. MFA, external security review, full accessibility/performance evidence, hosted configuration checks, hosted backup/restore proof, and monitoring verification remain open. Nothing in this audit confirms that production secrets or provider settings are correct.
