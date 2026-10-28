# Video recharge pricing policy

Owner approved: 28 October 2026. This approves the pricing rule and purchased-credit policy; it is not a live recharge catalog or evidence of production activation.

## Approved rule

- Retain profit equal to 30% of fully loaded cost after payment processing fees. This is markup on cost, not a 30% revenue margin.
- Schedora is not GST-registered, as confirmed by the owner. Do not collect or show customer GST under the current status. Include applicable non-recoverable supplier taxes in cost; do not assume input tax credits. Registration obligations must be reassessed as circumstances change.
- Purchased credits carry forward with no automatic expiry, including through plan changes and cancellation. Monthly subscription/evaluation allowances retain their separate reset rules.
- One credit is one participant-minute, including the host. A two-person 30-minute call uses 60 credits.

## Calculation

Let C be fully loaded cost for a pack, excluding the gateway charge represented below. Let f be the actual fraction of the customer payment deducted as processing fees, including applicable tax on those fees.

Customer total P = 1.30 * C / (1 - f).

Under the research baseline of a 2% gateway fee plus 18% GST on that fee, f = 0.0236, so P = 1.3314215485 * C. Round the full pack total UP to the next paise, after calculating from unrounded costs. For C = Rs100, P = Rs133.15; approximately Rs3.14 goes to fees and Rs30.01 remains above cost. Actual merchant/payment-method fees may differ; the formula must use those actual fees before a catalog is configured.

C includes allocated hosting/database/backup/monitoring, LiveKit participant-time and downstream transfer, provider-side taxes/FX/card charges, support, refunds/disputes and other applicable costs. Do not treat free allowances as a permanent zero-cost service or count a shared allowance once per customer. Avoid counting gateway fees twice.

## Research scenarios, not approved live pack amounts

Assumptions: hypothetical LiveKit Ship at $50/month plus a $7/month backend, planning FX Rs100/USD (not a verified invoice rate), 2Mbps average downstream per participant, no recording/AI. Ship includes 150000 participant-minutes and 250GB, with model overages $0.0005/minute and $0.12/GB. All backend cost is allocated to video in this illustration.

| Monthly participant-minutes | Infrastructure subtotal Rs/month | Subtotal Rs/credit | Formula output Rs/credit, no customer GST |
| ---: | ---: | ---: | ---: |
| 5000 | 5700 | 1.140 | 1.5178 |
| 10000 | 5700 | 0.570 | 0.7589 |
| 50000 | 11700 | 0.234 | 0.3116 |
| 150000 | 29700 | 0.198 | 0.2636 |
| 200000 | 41200 | 0.206 | 0.2743 |

These subtotals exclude the other costs listed above and possible supplier taxes. They are not fully loaded C and must not become a live catalog unchanged. Bandwidth, concurrency, group size, usage volume and existing shared-quota consumption require measurement. Purchased credits create a future service obligation; retain a cost reserve for later redemption. No paid infrastructure upgrade is authorized by approving this pricing formula.

## Activation gates still open

Configure a measured-cost-based catalog and verify live payment capture/webhooks/refund handling before enabling recharge. Do not publish development fixture prices. Video still requires an actual operator alert channel/received test, external health monitoring, production-provider media/lifecycle/settlement evidence and approved allowance/capacity/spend limits. Never set confirmation flags just to bypass checks. Current cost research and this approval do not provide that operational evidence.

## Sources checked 28 October 2026

- LiveKit pricing: https://livekit.com/pricing
- LiveKit quotas and free shared hard caps: https://docs.livekit.io/deploy/admin/quotas-and-limits/
- LiveKit metering/rounding: https://docs.livekit.io/deploy/admin/billing/
- Razorpay standard fee baseline: https://razorpay.com/pricing/
- CGST section 32, unregistered collection prohibition: https://cbic-gst.gov.in/pdf/CGST-Act-Updated-01082021.pdf
- Hosting option $7/month inspected read-only in the existing Render compute console; no upgrade performed. Free-service limitations: https://render.com/docs/free
