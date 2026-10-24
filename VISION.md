# Schedora product vision
Version 1.0 · 24 October 2026 · Working product direction

## Vision
Make time for what matters by helping people arrange appointments, collect useful information, and move work forward through three distinct products that work together.

## Product family
| Brand | Purpose | Planned public address |
| --- | --- | --- |
| Schedora | Suite discovery, shared account and commercial relationship | schedora.in |
| Meet by Schedora | Appointment scheduling | meet.schedora.in |
| Forms by Schedora | Forms and intake | forms.schedora.in |
| Flow by Schedora | Event-driven automation | flow.schedora.in |

Names, symbols and color families are approved. Subdomains are the planned experience, not evidence that DNS or hosting is configured. Earlier book.schedora.in references remain compatibility considerations. Do not change the primary domain spelling.

## People and problem
Initial audience hypothesis: independent service providers and small teams coordinating appointments and intake. Validate through interviews before claiming market fit.
- Hosts lose time exchanging appointment options and gathering context.
- Invitees need a clear, mobile-friendly way to choose a time.
- Small teams need useful follow-up without repeatedly copying information.

## Promise and principles
1. Each product delivers value independently.
2. One Schedora account and workspace connect the family.
3. Use plain language, visible time zones, accessible interfaces and clear status.
4. Never present a preview, queued action or failed request as a completed real-world action.
5. Collect only necessary information and make optional analytics a choice.
6. Build original experiences informed by public workflows; do not copy proprietary code or assets.

## Commercial direction
Support individual product subscriptions and a Suite bundle. One billing relationship grants server-verified product entitlements. Prices, quotas, currency, payment provider, trial rules and regional tax handling are undecided. Do not publish invented prices.

## Delivery strategy
Start with a reliable Meet booking experience, establish shared identity and data ownership, then deliver persisted Forms and a small reliable Flow engine. Existing Forms and Flow demos provide direction, not production functionality.

## Success measures
Measure activation, successful booking completion, abandoned booking steps, scheduling conflicts, form completion, automation delivery and retention. Establish numeric targets after baseline evidence. No business outcomes have yet been measured.

## Boundaries
The product now persists bookings, form responses and workflow runs, with accounts, roles and test-mode billing, and is prepared for Vercel + Render deployment. It is not yet a commercial service: it is undeployed, has no connected email or payment provider, no legal operator details and no pilot evidence. See [Launch status](LAUNCH.md).

