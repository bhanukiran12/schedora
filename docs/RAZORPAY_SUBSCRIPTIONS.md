# Schedora platform subscriptions through Razorpay

This is Schedora's subscription checkout for Meet, Forms, Flow and Suite. It is separate from hosts accepting appointment payments. Funds go to Schedora's server-configured Razorpay account. Workspace owners never provide their own payment gateway credentials to buy a Schedora plan.

## Current rollout

The owner requested integration now and live payment testing later. Checkout remains disabled. Prices have not been approved; this integration does not invent prices, publish savings claims, enable recurring charges, switch evaluation workspaces to enforced access, or purchase a subscription.

## Server configuration

Enter secrets directly in Render's environment settings, never in chat or frontend configuration:

- `BILLING_PROVIDER=razorpay`
- `BILLING_RAZORPAY_KEY_ID`: Schedora's Razorpay Key ID.
- `BILLING_RAZORPAY_KEY_SECRET`: matching private API secret.
- `BILLING_WEBHOOK_SECRET`: a separate private webhook signing secret.
- `BILLING_RAZORPAY_PLANS`: JSON mapping `meet`, `forms`, `flow`, `suite` to `{ "id": "plan_REPLACE", "amount_cents": <approved integer paise>, "currency": "INR", "cycles": <approved positive integer> }`.
- `BILLING_CHECKOUT_ENABLED=false` while setup/testing/pricing approval is incomplete.

Plans must be Razorpay monthly plans with interval 1. The checkout verifies the remote plan's price, currency and cadence against this server configuration. Billing cycles are explicitly configured and disclosed before authorization; a finite mandate does not silently renew forever. Plan creation/price selection remains an owner action.

After owner approval and provider testing, set `COMMERCIAL_BILLING_CONFIRMED=true`, `BILLING_MODE=enforced`, and `BILLING_CHECKOUT_ENABLED=true` together. Checkout requires all these conditions and complete credentials. Do not enable them to satisfy a status check. The production release gate also requires live keys and all four approved plans.

## Platform webhook

Use `https://schedora.in/api/billing/razorpay/webhook`, separate from `/api/payments/razorpay/<workspace>` used for appointment payments. Subscribe to:

`subscription.authenticated`, `subscription.activated`, `subscription.charged`, `subscription.pending`, `subscription.halted`, `subscription.cancelled`, `subscription.completed`, `subscription.expired`, `subscription.paused`, `subscription.resumed`, `subscription.updated`.

Use the same private signing secret in this webhook and `BILLING_WEBHOOK_SECRET`. Signatures are HMAC-SHA256 of the raw body. The adapter fetches authoritative subscription and plan state from Razorpay, checks the reserved checkout, workspace, plan, quantity, cycles, price and currency, and normalizes only verified state into Schedora's entitlements. A redirect, authorization-only transaction, or client-provided payment flag grants no access.

## Customer experience

- `/billing` shows published recurring prices and authorization-cycle limits. Checkout buttons remain disabled until configuration and approval are complete.
- Only the workspace owner may start checkout or cancel renewal. Administrators can read billing, but cannot change it or retrieve pending checkout links.
- Checkout uses Razorpay's hosted subscription authorization page. A signed webhook activates access only when the subscription is active, at least one cycle is paid, and its paid period is valid.
- Suite grants all three products. Individual plans grant only their product. Overlapping plans/pending mandates are blocked to avoid double billing.
- Failed renewals receive the existing seven-day grace policy only after a paid cycle. Repeated failure events do not extend the grace period. Paused/unauthorized subscriptions grant no access.
- Cancel renewal schedules provider cancellation at cycle end when a paid period remains; an unpaid mandate is canceled immediately. Paid access remains until its deadline; canceled renewals do not get the ordinary renewal-webhook tolerance beyond it.
- Duplicate webhook payloads are deduplicated. Terminal provider state cannot be overwritten by an older nonterminal state.
- A timed-out subscription creation is marked uncertain. Retrying never creates a second mandate. A verified provider event can recover the reserved checkout. If no event arrives, an operator must reconcile it in Razorpay before releasing that reservation; no automatic blind retry or automatic financial cancellation is performed.

## Processing fees

No extra surcharge or estimated gateway fee is added to subscription amounts. Razorpay's customer-paid fee option is currently disabled on the owner's account, and its documentation lists subscription-method limitations. Keep fee-bearing settings unchanged until Razorpay confirms account and payment-method eligibility. Approve subscription prices and tax treatment explicitly; do not assume appointment convenience-fee support applies to recurring mandates.

## Required verification before activation

Real Test-mode checks are deferred at the owner's request. Later verify authorization, paid activation, each product/Suite entitlement, failed renewal/grace, recovery, duplicate and out-of-order webhooks, cancellation, mandate expiry, taxes and refunds. A real live payment or refund requires owner action. Review the additive `billing_checkouts` migration and take a backup before enabling commercial billing.

Official references: [create subscriptions](https://razorpay.com/docs/api/payments/subscriptions/create-subscription/), [cancel subscriptions](https://razorpay.com/docs/api/payments/subscriptions/cancel-subscription/), [convenience-fee restrictions](https://razorpay.com/docs/payments/dashboard/account-settings/configuration/convenience-fees/).
