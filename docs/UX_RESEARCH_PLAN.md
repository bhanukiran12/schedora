# Schedora UX and customer research plan

Proposal · 27 October 2026 · No original interviews, usability sessions or conversion experiments have been conducted for this strategy

Use with [Suite strategy](SUITE_STRATEGY_2026_10_27.md), [feature priorities](FEATURE_PRIORITIES.md) and [pricing proposal](PRICING_PROPOSAL.md). Current competitor observations are not proof of their design's causal effect or of Schedora customer demand.

## Evidence ladder

| Evidence | What it can support | What it cannot support |
| --- | --- | --- |
| Official product/help/pricing pages | Current documented features, displayed price/term, quota behaviour | Independent superiority, prevalence of pain, causal conversion lift |
| Vendor-selected customer stories | A named customer's reported job/problem and outcome | Representative demand or transferable percentage savings |
| Original psychology/behaviour studies | Mechanism/effect in the tested population and intervention | A guaranteed SaaS conversion/retention effect |
| Usability guidance and standards | Design rationale, accessibility/error-prevention requirements | Proof that a particular screen increases revenue |
| Local code/tests and dated provider checks | Exact tested capability and environment | All-device, production or commercial readiness |
| User's device feedback | That person's reported experience in that session | General audio/video quality or a verified root cause |

## Psychological mechanisms to test ethically

| Hypothesis | Design intervention | Measure | Guardrail / alternative explanation |
| --- | --- | --- | --- |
| A relevant starting point reduces setup uncertainty | Three native starters plus blank; goal/outcome before choosing | First valid saved draft, time, later independent edit and simulation success | Template clicks are not activation; measure wrong source/config and accidental enablement |
| Visible state increases confidence in automation | Persisted event → run → task/email states, real failure and recovery | Correct answer to “what happened?”, recovery success/time | Queued/outbox/simulation must never be labelled delivered/sent |
| Concrete next steps support follow-through | Exact time/timezone, preparation, calendar and easy manage actions | Booking completion, attendance and support contacts | Respect reminder consent; healthcare study effects do not transfer numerically |
| Recognisable choices reduce recall burden | Plain-language conditions, meaningful labels, available placeholders | Prediction accuracy and setup errors | Experts can prefer compact grouped controls; do not stereotype “visual thinkers” |
| Cost predictability reduces activation anxiety | Named meters, reset date, forecast, explicit cap and spend ceiling | Correct bill/limit prediction; later retention/support | No hidden charge, preselected top-up, false urgency or fear-based selling |
| A linked next-step trail reduces handoff uncertainty | Response received → booking offered/confirmed → follow-up/needs attention | Time to identify next action and unresolved enquiry count | Novelty and demand unproven; compare against configured competitors |

Rationale: [recognition over recall](https://www.nngroup.com/articles/recognition-and-recall/), [visibility of system status](https://www.nngroup.com/articles/visibility-system-status/), [progressive disclosure](https://www.nngroup.com/articles/progressive-disclosure/), [GOV.UK form structure](https://www.gov.uk/service-manual/design/form-structure), [planning-prompt field experiment](https://www.hks.harvard.edu/publications/following-through-good-intentions-power-planning-prompts). Choice-overload findings are heterogeneous; a meta-analysis of 50 experiments/5,036 participants found average effect near zero, so “fewer options always converts better” is not a rule. ([Original study](https://doi.org/10.1086/651235))

Use genuine completed setup work if a checklist is useful. Do not invent progress percentages for branching forms. GOV.UK recommends testing question pages without a progress indicator first, and permits related questions together. ([Question pages](https://design-system.service.gov.uk/patterns/question-pages/)) Avoid fake scarcity/social proof, hidden costs, cancellation obstruction or manufactured dependence. ([FTC dark-patterns report](https://www.ftc.gov/reports/bringing-dark-patterns-light))

## Discovery and willingness to pay

Recruit 5–8 consenting operators across consultants/coaches, small agencies and training consultation teams. This is formative research, not a representative market survey. Begin with the last actual enquiry and current tools, not a Schedora pitch. Ask the operator to reconstruct where context moved, who owned the next action, where something stalled, actual volume, cost/support burden and who pays. Ask what their existing tool chain already does well and what would prevent switching. Do not recruit the user's employer or contacts without explicit permission.

After describing the problem neutrally, show a working task prototype. Ask the participant to choose which parts they would use independently, which bundle is unnecessary and how they would replace their current workflow. Test the [price anchors](PRICING_PROPOSAL.md) as hypothetical offers with full allowances/terms; record comprehension, objections and actual pilot willingness separately from stated enthusiasm. Do not call five favourable reactions demand validation.

## Screen-by-screen design requirements

| Surface | Required experience | Truth/error requirement |
| --- | --- | --- |
| Suite homepage | One concrete outcome statement; independent product choices; use-case route and demonstration CTA | No fake customer metrics, unbuilt workflow depicted as completed live work or approved-price implication |
| Product pages | Standalone job first; who/when it fits; actual supported first task; optional suite connection | Classic/conversational is a choice, not a universal superiority claim; separate preview/provider setup |
| Onboarding | Select goal/product; minimal necessary setup; preview; share/enable only after real readiness | Checklist counts stored work; skip/back/blank paths remain available |
| Meet setup/share | Event details/location, availability/timezone, integration status and readable share summary | No slot/booking/email/provider success before authoritative confirmation |
| Public booking/manage | Duration, appointment-date timezone, slot conflict recovery, clear receipt and manage actions | Booking and email delivery are separate; cancelled/superseded joins unavailable |
| Video prejoin/room | Reachable Join, local meter, clear permission/device states, readable controls and separate host end | Resolution adapts; display actual stats when available, never diagnose hardware from a screenshot |
| Forms builder | Goal template/blank, clear edit/preview, saved draft vs live version, accessible move controls | Preserve current revision/conflict/publish contract; preview stores no response |
| Public Forms/receipt | Relevant questions, honest required labels, useful errors/back/review and explicit next action | “Response received” does not mean “appointment booked”; no lost answers after validation error |
| Response inbox | Find response/reference/time, export, current booking handoff state and needs-attention path | Only actual data/states; field/role access stays server-enforced |
| Flow entry/editor | Three locally implemented starters: booking → preparation task, response → review task, booking → existing-host notification email; blank and outcome sentence remain available | Draft default; selection sends nothing; no fake branches/unsupported fields. Respondent acknowledgement needs an explicitly chosen source form/email field and is deferred |
| Flow simulation/runs | Last-saved definition and sample-data label; outcome/error/attempts; safe retry | Outbox/queued/sent/delivered distinct; scope deduplication to supported actions |
| Plans/usage | Product-specific units, allowances/reset, total annual payment, cap outcome and cancellation | Proposed prices/calculators labelled; no checkout or spend promise without approval/enforcement |

Use current tokens/components and original assets. Verify keyboard navigation, focus/return, semantic headings/labels, error associations, contrast, zoom/reduced motion, long labels and layouts at 375/768/1440 px. Screenshots alone cannot establish WCAG compliance; include real assistive-technology testing before a compliance claim.

## Experiments and phased rollout

| Phase | Intervention | Evidence required to proceed |
| --- | --- | --- |
| 1: local draft available for Claude review; full redesign not implemented | Delivery of existing assets/routes; concrete positioning; booking/task, response/task and booking/host-email starters with outcome preview | Syntax passed 113 modules; unit suite 131 total/128 passed/three PostgreSQL skipped; all browser journeys/416 layout checks passed in the working tree including Forms work, not an isolated change set. No commit/push/deployment in this research iteration; further implementation stops at the user's request |
| 2: moderated task tests | Publish consultation event/form; choose/edit/simulate native flow; diagnose a failure; predict a bill | Observe unaided success/errors/time; five sessions identify usability defects, not population conversion rates |
| 3: linked-trail prototype | Find “what needs attention?” across response/booking/run | Faster/correct diagnosis against current UI, no invented status; agree backend state contract |
| 4: opt-in pilot | Real supported providers, spend limits and retained weekly workflow | Measured dropped handoffs, support effort, provider costs and repeat use; no critical reliability defects |
| 5: controlled experiment | Template-first vs blank or suitable form presentation | Baseline instrumented; predeclared meaningful effect/sample calculation; segment first-time/repeat users |

Instrument minimal event metadata with consent and retention: entry, template selection, valid save, preview/simulation, publish, first durable real event, outcome/recovery and quota warning. Do not place answer text, contact details, tokens or message bodies in analytics. Define denominators and distinguish mock/test/real work. Stop an experiment if error, accidental send, accessibility or unexpected charge rates worsen, even if clicks increase.
