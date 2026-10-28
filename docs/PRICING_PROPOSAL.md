# Schedora pricing proposal

Research/interview proposal · 27 October 2026 · **NOT APPROVED PRICES OR A CUSTOMER OFFER**

No billing configuration, checkout amount, allowance or tax policy is changed by this document. An interview prototype of these figures is at `/pricing/proposal`, labelled "Proposed pricing — not available for purchase" and excluded from search and navigation; see [implementation log](RESEARCH_IMPLEMENTATION.md#slice-4-proposed-pricing-and-usage-prototype-interview-material). Amounts below are INR experiment stimuli, not measured willingness to pay or a finding that Schedora is cheaper. Related: [Strategy](SUITE_STRATEGY_2026_10_27.md), [Feature gates](FEATURE_PRIORITIES.md), [existing approval worksheet](PRICING_WORKSHEET.md).

## Concrete price list to test

Start commercial discovery with monthly billing. Annual figures are an optional later interview concept using ten monthly payments per year, not a launched discount. All proposed prices exclude any applicable taxes whose treatment must be confirmed before sale.

| Proposed plan | Monthly test anchor | Research range/month | Illustrative annual total | Equivalent/month, annual paid up front |
| --- | ---: | ---: | ---: | ---: |
| Meet | ₹399 | ₹299–499 | ₹3,990 | ₹332.50 |
| Forms | ₹499 | ₹399–699 | ₹4,990 | ₹415.83 |
| Flow | ₹699 | ₹499–999 | ₹6,990 | ₹582.50 |
| Suite | ₹1,199 | ₹999–1,499 | ₹11,990 | ₹999.17 |

These annual illustrations equal 16.67% less than twelve payments at the corresponding monthly anchor. Do not display an annual monthly equivalent without the full upfront amount equally prominent. The individual anchors sum to ₹1,597/month; the illustrative Suite is ₹398 lower than that *own-plan* sum. This is not a competitor savings claim, and a user who needs only Meet should not buy the bundle to achieve a fictional saving.

## Packaging assumptions to validate, not implement silently

| Plan concept | Included access assumption | Illustrative volume for cost testing | Separate costs |
| --- | --- | --- | --- |
| Meet | One workspace, one host; two non-host collaborators | 300 bookings/month | Native video, SMS/WhatsApp, AI and payment-provider fees |
| Forms | One workspace, three editors; respondents are not seats | 1,000 accepted responses/month | Future uploads/storage or paid services only if explicitly offered |
| Flow | One workspace, three editors; supported native actions | 1,000 logical native runs/month | Paid communication/AI/provider compute, if later connected |
| Suite | One workspace, three hosts/editors in the same member pool | 300 bookings + 1,000 responses + 1,000 native runs/month | Same separately disclosed variable services; no hidden pooled credits |

These are cost-model workloads, not entitlements. They differ from current evaluation defaults. Before approval, test solo and 3/10-person team demand, whether buyers understand host/editor/viewer charges and the cost of typical/heavy users. Do not charge invitees/respondents as seats or bill an optional native handoff twice under unexplained meters.

Each anchor buys only the named product in one workspace. Forms or Flow purchase does not require paid Meet, and Meet purchase does not require Forms or Flow. Optional connections do not silently start another subscription. In this proposal Meet includes one host and two non-host collaborators; Forms and Flow each include three editors. A person using more than one purchased product remains one workspace identity; the applicable product's role/seat allowance is shown separately rather than silently adding a second identity charge. Suite includes up to three people who can host/edit across the products, not three separate pools of three people. Extra hosts/editors and viewer policies have no approved price yet; reaching a seat limit must prompt a clear choice, never an automatic charge.

**No native-video allowance, pack price or participant-minute rate is proposed or included in these anchors.** Native video, messages and AI need separately measured costs, explicit commercial approval and their existing production gates. Evaluation credits or staging grants are not included paid-plan allowances. No such usage is bundled as unlimited.

Define one logical native run as a unique event/workflow pair for supported bounded actions. Proposed policy: duplicate delivery, automatic retries of that same run and simulations do not add native-run units. This requires billing/backend review; the existing ledger remains authoritative until changed and tested. Explain partial success, manual replay, third-party spend on failures, reset dates and downgrade consequences before launch.

## Budget/control requirements

Show plan price, included allowance, current consumption, reset date, forecast and exact cap outcome separately for bookings, accepted responses, runs and participant-minutes. Warn at proposed 50/75/90/100% thresholds. Default automatic paid overage/top-up OFF; an owner can opt in only with a visible unit rate and hard monetary ceiling. Preserve accepted data and make failed admission/paused work visible; do not promise queueing if the engine actually rejects events. Exports, cancellation/effective date and invoices must remain easy to find. “No surprise bills” is a product requirement until enforcement proves it, not an approved headline.

## Compare a matched basket, not incompatible headline prices

Prices retain their original vendor currencies. No FX conversion or tax equivalence is implied. Snapshot checked 27 October 2026; recheck checkout before publication.

| Reference | Verified public anchor | Comparison limit |
| --- | --- | --- |
| Calendly Standard / Teams | $10 / $16 per seat/month on annual view | Match host count, routing, calendars and billing commitment; free plan also exists |
| Cal.com Teams / Organizations | $12 / $28 per user/month, yearly | Individual free scheduling is generous; old platform overages unverified |
| SavvyCal Basic / Premium | $12/$20 monthly; $120/$200 actual annual charge | Different invitee experience; annual display rounds Premium equivalent |
| Tally Pro | $29/month or $290/year | Free already includes logic/unlimited submissions subject to fair use; match branding/team needs |
| Fillout Starter / Pro | $15/$40 monthly equivalent, annual display | 2,000/5,000 responses; Pro branding removal; monthly quote not verified |
| Typeform | Foreground cards $39/$79/$129 monthly and $28/$56/$91 annual equivalent | Same official page contains conflicting older values; do not publish a guaranteed quote |
| Zapier | Headline starts $19.99/month | Selected paid term/task tier not fully exposed; price successful actions, exceptions and replay rules |
| Make | Official comparison headline $9 for 10,000 credits/month | Exact term/quote not established; AI and extra credits have different treatment |
| n8n Cloud Starter / Pro | €20/€50 monthly equivalent, annual; 2,500/10,000 executions | Execution semantics differ from per-action tasks; concurrency/projects differ |

Sources: [Calendly](https://calendly.com/pricing), [Cal.com](https://cal.com/pricing), [SavvyCal](https://savvycal.com/pricing), [Tally exact billing](https://tally.so/help/tally-pro), [Fillout](https://www.fillout.com/pricing), [Typeform](https://www.typeform.com/pricing), [Zapier](https://zapier.com/pricing), [Make](https://www.make.com/compare/make-vs-n8n), [n8n](https://n8n.io/pricing/).

Model three separate customer baskets: a solo consultant at 250 responses/month; a three-editor agency at 2,000; a 10,000-response operator. Specify branding, hosts, routing, storage, follow-up steps and external services. Use one relevant form vendor per alternative basket, not Typeform plus Fillout plus Jotform. Include switching/setup/support burden and missing connector coverage; compare cost only after feature coverage.

## Unit-economics approval gate

Illustration only: at ₹1,199 monthly revenue, hypothetical 3% payment processing and ₹300 variable/allocated service+support cost, contribution is ₹863.03, or 72.0% of gross revenue, before applicable taxes/refunds/acquisition/general overhead. At ₹800 service cost it falls to ₹363.03, or 30.3%. At the illustrative annual equivalent ₹999.17, the same ₹300 cost and 3% assumption leave about ₹669.19/month; annual discounts cannot be approved from the monthly margin alone. The 3% is an assumption, not a provider quote.

Measure database/hosting, storage/egress, email, media participant time and bandwidth, retries/failures, support minutes, refunds and taxes. Test normal, heavy and abusive workloads; define free/trial budgets and capacity. Approve prices only after measured contribution floors, willingness-to-pay evidence, billing semantics, legal/tax review and real payment lifecycle checks. This document authorises no sale or charge.


## Owner-approved video recharge rule — 28 October 2026

The owner approved retaining 30% over fully loaded cost after payment fees, confirmed Schedora is not GST-registered, and approved purchased credits carrying forward without automatic expiry. See [video recharge pricing](VIDEO_RECHARGE_PRICING.md) for the formula, assumptions and remaining gates. This approval is specific to video recharge policy: the Meet/Forms/Flow/Suite price anchors above remain research proposals. No live pack amounts, catalog activation, paid hosting upgrade or production video readiness is asserted.
