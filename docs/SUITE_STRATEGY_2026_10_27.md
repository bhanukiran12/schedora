# Schedora suite strategy

Decision proposal · 27 October 2026 · Research-informed; customer demand and prices unvalidated

This proposal updates positioning and prioritisation. It does not certify deployment, provider readiness or commercial availability. Use [Feature priorities](FEATURE_PRIORITIES.md), [Pricing proposal](PRICING_PROPOSAL.md) and [UX research plan](UX_RESEARCH_PLAN.md) together. Existing security, reliability and release gates remain in force.

## Product decision

**Help a small service team move an enquiry to an appointment and a useful follow-up, with a clear record of what happened.** Start by comparing consultants/coaches, small agencies and training consultation teams; do not assume one is the winning segment. The initial team-size hypothesis is 1–10 operators, not a researched market boundary.

Meet, Forms and Flow retain standalone value. One account and optional native handoffs reduce context switching; they must not force a bundle. An integrated suite is not a new market category: Fillout already lists scheduling/workflows, Paperform combines forms/signatures/workflows, and Jotform has broad form-led operations. The hypothesis to test is *a clearer, more dependable narrow workflow*, not unique integration. ([Fillout](https://www.fillout.com/pricing), [Paperform](https://paperform.com/pricing/), [Jotform](https://www.jotform.com/pricing/))

## Positioning and message hierarchy

| Surface | Proposed message | Proof needed |
| --- | --- | --- |
| Suite headline | From enquiry to appointment to follow-up. | Working supported journeys; each state tied to a record |
| Suite explanation | Forms, scheduling and simple follow-up in one workspace. Use one product or connect the next step. | Independent product access and optional handoffs |
| Meet | Share a time. Arrive with the right context. | Valid availability, timezone clarity, booking/management reliability |
| Forms | Collect useful context. Make the next step clear. | Relevant questions, durable receipt, explicit booking offer/status |
| Flow | Simple follow-up for your bookings and forms. | Supported trigger/action, saved simulation, traceable run outcome |
| Value explanation | Know what arrived, what happened next and what needs attention. | Linked records and recoverable failures, not invented success counters |
| Price explanation | See the plan, allowance and limit before you commit. | Approved rates and enforced spending/limit behaviour before commercial claims |

“Confidence through visible proof” is the proposed behavioural/value hypothesis. It is not a discovered psychological law. Avoid “cheapest,” “replaces Zapier,” “guaranteed conversion,” “enterprise compliant,” “unlimited video,” invented testimonials, competitor customer counts and unmeasured hours saved.

## Initial use cases

| Priority | Buyer job and journey | Available foundation | Work still needed |
| --- | --- | --- | --- |
| First | Consultant: publish a consultation event → booking → preparation task | Meet booking-created + Flow task action | Useful starter, readiness/status explanation, live provider verification |
| First | Agency: project enquiry → relevant questions → response-review task | Forms logic/response + Flow task action | Goal template, clear source choice, receipt-to-run navigation |
| First | Operator: new booking → notify the existing host by email | Meet booking-created + Flow email to host | Starter configured as Draft; real email provider/delivery checks |
| Next | Training team: enquiry → response receipt → acknowledgement → optional counselling booking | Forms response, email action and local Meet handoff primitives | Respondent acknowledgement is not one of the implemented starters: select a source form with a usable email field; verify provider and linked status. No automated eligibility decisions |
| Next | Coach: intake → session → consent-based feedback | Form and event primitives | A fully linked workflow; timed feedback trigger is not currently supported |
| Later | Workshop: registration → capacity confirmation → reminder/waitlist | Basic forms/booking components only | Concurrency-safe capacity and waitlist model; no capacity promise from a form alone |

Do not assume a user wants every step automated. A preparation task can be more useful and safer than sending a generic message. Do not call one booking-created action a multi-step intake orchestration.

## What to adapt from competitors

Adopt meaningful templates, quick preview, explicit timezone and state, reversible drafts, visible run history, error recovery and understandable billing units. Adapt conversational forms to the task rather than forcing one question per screen. Adapt visual workflow clarity to the current one-trigger/one-action engine; defer a canvas until execution supports its affordances. Retain original Schedora components, copy, assets and branding.

The direct Meet reference set is Calendly/Cal.com/SavvyCal; Reclaim and Motion are adjacent calendar/task suites. Forms references are Typeform/Fillout/Tally/Jotform/Google Forms/Paperform. Flow references are Zapier/Make/n8n; Power Automate is enterprise/RPA-adjacent, current Pipedream Connect is embedded integration infrastructure, and Relay.app is historical only after its September 2026 shutdown. ([Relay notice](https://relay.app/), [Pipedream pricing](https://pipedream.com/pricing))

## Rollout and evidence gates

A **local frontend draft is available for Claude Code review; the full product redesign is not implemented**. The draft retains the existing design system, clarifies suite/product use cases and availability, fixes delivery of existing frontend assets/routes, and adds three native Flow starters with an outcome preview: booking → preparation task, response → review task, and booking → notification email to the existing host. Respondent acknowledgement is deferred because it requires selecting a source form/email field. Syntax passed for 113 modules; the unit suite reported 131 tests, 128 passed and three PostgreSQL checks skipped; all browser journeys and 416 layout checks passed in the working tree including preserved Forms work, not an isolated change set. Nothing in this research iteration was committed, pushed or deployed. At the user's instruction, further implementation stops here; Claude Code will handle actions from this research.

Next, test the end-to-end task with 5–8 consenting operators and identify where they lose context or cannot predict the next result. Prototype a linked enquiry trail and usage forecast using clearly labelled examples. Only then add backend contracts for shared status, ownership, notifications, budgets, versioned workflow definitions or external connectors. Promote a feature from preview to available only after the relevant persistence, authorisation, provider, error and operational checks pass.

Success means a user can publish a useful form/event, explain what is saved/live, identify the next action, recover a failed follow-up and predict cost. A template click, attractive screen or larger feature count alone is not success.
