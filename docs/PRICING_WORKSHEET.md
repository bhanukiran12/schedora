# Pricing approval worksheet

Status: **monthly plan prices approved 10 November 2026**. Competitor comparisons, cost validation, tax review, usage limits and claims of savings remain open. The product displays the approved monthly prices; subscription checkout remains separately gated on matching Razorpay plans and release readiness.

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

## 3. Approved plan prices and open usage assumptions

| Plan | Monthly | Annual, paid upfront (12% off) | Monthly allowance (bookings / responses / flow runs) | Comparable competitor cost | Difference | Contribution margin |
| --- | ---: | ---: | --- | --- | --- | --- |
| Meet | ₹399 | ₹4,213.44 | 1000 bookings (proposed in `backend/src/billing/plans.mjs`) | | | |
| Forms | ₹499 | ₹5,269.44 | 5000 responses (proposed) | | | |
| Flow | ₹699 | ₹7,381.44 | 5000 runs (proposed) | | | |
| Suite | ₹1,199 | ₹12,661.44 | all of the above | | | |

Prices are per workspace. Annual plans are charged once upfront for 12 months. The usage limits in the table remain proposals and are not approved commercial terms.

Planning hypothesis from the roadmap: at least 20% lower than the comparable paid basket. If margins cannot support that, narrow the plan or adjust allowances rather than reducing reliability.

## 4. Decisions still open

Trial length (if any), regional currency and tax handling, refund policy, annual Razorpay plan IDs and checkout implementation, behavior at quota (block vs. overage), and data access after cancellation (current build: data kept, new activity blocked). The 12% annual discount is approved; annual checkout is not yet available.

## 4a. Schedora Meet video credits (commercial terms approved; launch inputs remain)

Owner-approved (10 November 2026; allowance revised 11 November 2026): 1 credit = 5 participant-minutes (hosts included); the approved price is ₹2 per credit (₹0.40 per participant-minute). Monthly allowance credits expire at period end; purchased credits carry forward without automatic expiry. Meet includes 100 credits/month; Suite includes 100 credits/month. No trial allowance or pack sizes are approved. These are commercial decisions, not a live catalog: production video and recharges remain off until the implementation is updated, full costs support the rate, and release gates pass. See [video recharge pricing](VIDEO_RECHARGE_PRICING.md) and [Meet video](MEET_VIDEO.md).

| Input | Meet plan | Suite plan | Trial | Notes |
| --- | --- | --- | --- | --- |
| Monthly allowance (credits) | 100 | 100 | Not approved | Monthly plan windows; 1 credit = 5 participant-minutes |

| Pack | Credits | Price (INR) | Provider cost estimate at that volume | Margin |
| --- | --- | --- | --- | --- |
| Pack sizes not yet selected | | ₹2 per credit / ₹0.40 per participant-minute (approved rate; viability gate open) | | 30% over fully loaded cost after fees, per approved policy |

Also decide: refund policy for partly used packs (build: unspent credits reversed proportionally, used credits recorded as uncollectable), and the operational monthly provider-cost budget.

## 5. Approval

Owner: ____________  Date: ____________  Decision: ____________
