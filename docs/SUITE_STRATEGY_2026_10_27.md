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
| First | Consultant: publish a consultation event → booking → preparation task | Meet booking-created + Flow task action; Draft starter, Meet readiness and linked trail released | Observe unaided setup/recovery with operators; verify applicable real providers |
| First | Agency: project enquiry → relevant questions → response-review task | Goal templates, Forms logic/receipts, Flow task action and Enquiries released | Test whether operators identify the right next action; address pagination/ownership from observed use |
| First | Operator: new booking → notify the existing host by email | Draft starter, saved simulation and provider/outbox wording released | Production email currently uses outbox; configure/test real delivery before promising inbox notifications |
| Next | Training team: enquiry → response receipt → acknowledgement → optional counselling booking | Forms response, email action and local Meet handoff primitives | Respondent acknowledgement is not one of the implemented starters: select a source form with a usable email field; verify provider and linked status. No automated eligibility decisions |
| Next | Coach: intake → session → consent-based feedback | Form and event primitives | A fully linked workflow; timed feedback trigger is not currently supported |
| Later | Workshop: registration → capacity confirmation → reminder/waitlist | Basic forms/booking components only | Concurrency-safe capacity and waitlist model; no capacity promise from a form alone |

Do not assume a user wants every step automated. A preparation task can be more useful and safer than sending a generic message. Do not call one booking-created action a multi-step intake orchestration.

## What to adapt from competitors

Adopt meaningful templates, quick preview, explicit timezone and state, reversible drafts, visible run history, error recovery and understandable billing units. Adapt conversational forms to the task rather than forcing one question per screen. Adapt visual workflow clarity to the current one-trigger/one-action engine; defer a canvas until execution supports its affordances. Retain original Schedora components, copy, assets and branding.

The direct Meet reference set is Calendly/Cal.com/SavvyCal; Reclaim and Motion are adjacent calendar/task suites. Forms references are Typeform/Fillout/Tally/Jotform/Google Forms/Paperform. Flow references are Zapier/Make/n8n; Power Automate is enterprise/RPA-adjacent, current Pipedream Connect is embedded integration infrastructure, and Relay.app is historical only after its September 2026 shutdown. ([Relay notice](https://relay.app/), [Pipedream pricing](https://pipedream.com/pricing))

## Current release checkpoint — 28 October 2026

`328ed25` is deployed to existing Vercel/Render, with successful branch/main CI including PostgreSQL 17 and Linux browser checks. Product context/sidebar, live persisted onboarding and real split-screen auth are released; current Enquiries uses server pagination and task deadlines/assignees exist. Earlier release paragraphs below are historical. Local PostgreSQL credentials remain unusable, but that does not invalidate the passing disposable CI evidence. Real email provider delivery, operator alert receipt, real Google cross-host sign-in, human usability and production video acceptance remain open; pricing is unapproved. See [release acceptance](RELEASE_ACCEPTANCE.md) for current gates and evidence scope.

## Rollout and evidence gates (historical release notes)

**Release state, 27 October 2026:** research-led increments are deployed on the existing Vercel frontend and Render backend. `c06330e` released Flow starters/outcome previews, Forms templates/reliability, linked response trails, the isolated pricing proposal and Meet readiness. `f8cd341` released shared readiness presentation, Forms readiness and the read-only Enquiries list. `eb7fd06` added server-backed saved-revision publish checks and separate live routing. The source, tests and dated evidence are recorded in [RESEARCH_IMPLEMENTATION.md](RESEARCH_IMPLEMENTATION.md). This is an incremental product improvement, not proof that a complete visual redesign or market validation is finished.

For `eb7fd06`, local validation reported 172 tests (169 pass, three opt-in PostgreSQL tests skipped), 128 syntax-checked modules and 496 browser layout checks. GitHub's Linux workflow succeeded, both hosts served the same commit, and a check on an existing production form passed without saving or publishing. PostgreSQL health is confirmed; PostgreSQL concurrency tests remain unverified because local credentials fail. Native video credentials and a signed permanent webhook are configured, but video/recharge remain disabled pending custom alerts and actual production acceptance. Production email is still an outbox. Prices and allowances are proposals, not approved offers. No customer interviews or conversion experiments have been run.

The user subsequently authorized Codex to continue autonomously while Claude is unavailable. Preserve concurrent work, use bounded validated increments and keep external spending at zero. Do not bypass provider, commercial or human-evidence gates to make the roadmap look complete.

Next, test the released end-to-end task with 5–8 consenting operators and identify where they lose context or cannot predict the next result. The linked trail and usage forecast now exist; test those surfaces rather than commissioning duplicate prototypes. Distinguish a code-backed API contract from a demand decision: accurate publish checks are implemented, while assignment, due dates, notifications, workflow graphs and connectors still require their own evidence and execution contracts. Promote a feature from preview to available only after the relevant persistence, authorisation, provider, error and operational checks pass.

Success means a user can publish a useful form/event, explain what is saved/live, identify the next action, recover a failed follow-up and predict cost. A template click, attractive screen or larger feature count alone is not success.

## Next evidence-led decisions

| Uncertainty or observed limitation | Next evidence to collect | Decision it should inform |
| --- | --- | --- |
| Production email records an outbox entry rather than delivering to an inbox | A configured provider, acceptance/failure test and an independently observed inbox result, without emailing customers | Whether email follow-up can be offered as an operational feature; more copy or animation cannot close this gap |
| Every open follow-up task counts as needing attention; tasks have no due date | Have operators diagnose a real or consented synthetic queue and explain which tasks need action now | Whether to add due dates, assignment or a separate action state; do not assume all open tasks are overdue |
| Enquiries loads bounded windows in the browser | Test a large local workspace and ask operators to locate a known older enquiry; measure coverage, latency and correct recovery | Server pagination/search and visible scope, before claiming complete-workspace coverage |
| Competitors already offer scheduling and connected form workflows | Compare the same consultation and project-enquiry tasks in current Schedora and appropriately configured Cal.com/Fillout/Typeform alternatives; record capabilities and setup steps with dated sources | A specific reason to choose or switch, not a claim that having three products is unique |
| No original willingness-to-pay or usability evidence exists | Use the existing neutral interview/task protocol with consenting operators; no outreach without authorization | Which segment/job to prioritize and whether proposed plans are understandable; feature counts and hypothetical enthusiasm are insufficient |

These are research and operational priorities, not newly discovered market demand. Continue independent research, local tests and reversible improvements while external verification is unavailable. Keep unsupported claims and paid activation out of the release.
