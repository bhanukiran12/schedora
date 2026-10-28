# Follow-up confidence: focused research and product decision

28 October 2026 · Desk research and inspected Schedora code · No participant research or authenticated competitor testing

## Decision

For the proposed small service-team audience, investigate whether an operator can correctly answer: **Was the enquiry saved, was an appointment made, and did its follow-up leave the server?** The highest-confidence immediate improvement is preserving email hand-off evidence across provider changes. Assignment and due dates remain important candidates, but this scan does not establish demand for a full approval engine.

The scope is the present form/booking → email/task → investigation journey, using current official documentation and dated public support reports. It is not a market-size study, pricing approval or a comparison of measured conversion rates. Competitor feature existence and vendor benefit statements are not evidence of user outcomes.

## Evidence and ranked problems

| Rank | Job / failure | Evidence and limits | Severity / frequency / confidence | Product move |
| --- | --- | --- | --- | --- |
| 1 | Know whether a follow-up actually left the server | Schedora's Flow and enquiry trail describe historical email results using the provider configured today. A later change from outbox to HTTP can change the description without sending that old message. This is a code-observed defect, not an observed customer incident. | High consequence if relied on; incidence unknown; high confidence in the defect | Save successful transport on the message; read it for each run. Legacy records remain unverified. Never infer inbox delivery. |
| 2 | Diagnose missing notification without confusing it with a lost response | A February 2026 Typeform community report concerns missing client notifications; staff acknowledged work on a fix and the author later believed it resolved. A June Jotform support report similarly received a resolved reply. These are two dated anecdotes, not prevalence or a current outage. | Potentially high operational consequence; prevalence unknown; moderate confidence in the recurring problem class | Keep response, run, hand-off and delivery distinct. State actual setup restrictions before asking users to check spam. Verify a real sending provider separately. |
| 3 | Understand why an automation did not run | Calendly's guide points to event-type assignment, missed timing and sender setup. Fillout documents verification restrictions for newer free accounts even while forms continue collecting responses. | Medium to high; documentation demonstrates a support scenario, not frequency; high capability confidence | Explain supported trigger/source, activation and provider restrictions. Simulation must remain explicitly side-effect free. |
| 4 | Find the responsible person and recover stalled work | Fillout now documents approvals, workflow histories and per-submission histories. Jotform's previously cited Inbox tracking covers reassignment. Schedora's loaded trail has no assignment or resolve action. | Importance for Schedora audience unvalidated; high confidence in capability gap | Compare a concrete recovery task with operators before implementing ownership, overdue rules or notifications. |

## Capability comparison for the same investigation task

| Product / source | Documented investigation path | Important boundary |
| --- | --- | --- |
| Schedora, inspected main plus this local slice | Enquiries → What happened → linked run/task; Flow Run history → stored email transport evidence | Loaded windows are bounded. No assignment, full-history guarantee or inbox confirmation. Existing production email remains outbox. |
| Fillout | Form Integrate → workflow clock/history, or submission Results → workflow history; test using a prior submission | Testing can execute a workflow. Do not equate it with Schedora's non-sending simulation. Account verification can gate sending. No hands-on speed or plan comparison performed. |
| Calendly | Verify workflow event-type assignment and timing; make a test booking and check actual communication | A configured workflow or completed test setup does not itself prove delivery. No authenticated account or recovery timing measured. |
| Typeform | Current automations documentation distinguishes newer automation from legacy Messages, with sender/metrics constraints | Availability depends on account/plan/add-on and experiment state. Do not reuse old single-message comparisons as current scope. |

## Behavioural hypothesis and validation

Hypothesis: showing persisted, message-specific evidence reduces mistaken completion and unnecessary resending. This follows the existing visibility-of-system-status rationale in the [research plan](UX_RESEARCH_PLAN.md), but no causal improvement has been measured here. Avoid adding a green delivery badge, tracking pixel, fake reassurance or a success percentage.

Use five neutral task scenarios in the planned moderated sessions: (1) response saved but no booking yet, (2) confirmed booking plus open preparation task, (3) failed follow-up eligible for retry, (4) email saved to outbox, (5) older email with unknown transport after settings changed. Ask what happened, what remains uncertain, and what action is safe. Measure correct diagnosis, mistaken delivery belief, unnecessary resend, next-action correctness and time; report individual observations and errors, not statistically reliable conversion lift. Compare configured alternatives with the same task and access. No outreach or interviews have been performed.

## Source map

Retrieved 28 October 2026. Public search covered Typeform/Calendly communities, official help, Fillout workflow documentation and broader notification-support results; only sources relevant to this task inform the decision. No private support/customer records, X, authenticated competitor accounts or representative sample was available. No frequency estimate can be derived from the search results.

- [Fillout workflow help](https://www.fillout.com/help/workflows): current approvals/action documentation, run and submission histories, prior-submission tests. Stronger current evidence than the old Draft-marked approvals blog; does not prove every plan includes approvals.
- [Fillout respondent notifications](https://www.fillout.com/help/respondent-emails): newer free-account verification restrictions, visible sending-pause notices, and collection continuing without emails. Do not claim all free accounts are affected.
- [Calendly workflow guide](https://calendly.com/learn/calendly-workflows): setup, assignment, real test booking and troubleshooting; vendor guidance, not measured customer success.
- [Typeform automation notifications](https://help.typeform.com/hc/en-us/articles/47636218717844-Send-email-notifications-to-respondents-or-yourself-when-someone-submits-your-form): newer automation/add-on and legacy availability differences; shared-sender limits on metrics.
- [Typeform community, February–April 2026](https://community.typeform.com/build-your-typeform-7/notifications-are-not-working-17752): anecdote, staff acknowledgement, later author report of recovery. Not a current outage claim.
- [Jotform support, June 2026](https://www.jotform.com/answers/39415761-email-notifications-not-receiving-alerts-for-form-submissions): one reported notification incident followed by support resolution. Not a prevalence estimate.

## Opportunity queue

**Now:** message-specific evidence and legacy uncertainty; verify migration/permissions/retry behaviour and responsive rendering. **Next release gates:** real email-provider and own-account receipt test; custom video monitoring/test alerts and production smoke under existing approvals. **Demand-gated:** ownership, meaningful task deadlines, full-history pagination and a cross-tool recovery comparison. Do not add an approval engine, delay graph or commercial promise based solely on this scan.
