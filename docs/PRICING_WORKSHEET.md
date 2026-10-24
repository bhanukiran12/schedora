# Pricing approval worksheet

Status: **template, not filled**. No price, currency or savings claim is approved. The product shows "Not yet published" until the owner completes this worksheet and signs off.

## 1. Competitor snapshot (fill on the day of approval)

Save a dated copy (PDF or screenshot) of each official pricing page and record it here.

| Product | Plan compared | Billing term | Currency | Price per seat | Seats in basket | Included usage | Features required by our basket | Taxes / add-ons | Source URL | Captured on |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Calendly | | | | | | | | | https://calendly.com/pricing | |
| Typeform | | | | | | | | | https://www.typeform.com/pricing | |
| Fillout | | | | | | | | | https://www.fillout.com/pricing | |

Compare Meet with the matching scheduling plan, Forms with the matching Typeform **or** Fillout plan (the customer's realistic choice, not both added together), and Suite with the customer's actual replacement basket. Note any feature Schedora lacks next to its lower price.

## 2. Schedora cost per workspace per month

Measure on staging under a typical and a heavy workload.

| Cost item | Typical | Heavy | Source |
| --- | --- | --- | --- |
| Render instance share + disk | | | |
| Vercel bandwidth | | | |
| Emails sent (confirmations, reminders, flows) | | | |
| Payment fees (% + fixed) | | | |
| Taxes borne by the company | | | |
| Refunds and failed payments allowance | | | |
| Support time | | | |
| **Total cost** | | | |

## 3. Proposed plans

| Plan | Price | Monthly allowance (bookings / responses / flow runs) | Comparable competitor cost | Difference | Contribution margin |
| --- | --- | --- | --- | --- | --- |
| Meet | | 1000 bookings (proposed in `backend/src/billing/plans.mjs`) | | | |
| Forms | | 5000 responses (proposed) | | | |
| Flow | | 5000 runs (proposed) | | | |
| Suite | | all of the above | | | |

Planning hypothesis from the roadmap: at least 20% lower than the comparable paid basket. If margins cannot support that, narrow the plan or adjust allowances rather than reducing reliability.

## 4. Decisions still open

Trial length (if any), regional currency and tax handling, refund policy, payment provider, annual discount, behavior at quota (block vs. overage), and data access after cancellation (current build: data kept, new activity blocked).

## 5. Approval

Owner: ____________  Date: ____________  Decision: ____________
