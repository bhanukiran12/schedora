// A completed run records an action, not inbox delivery. Describe the message's saved transport
// evidence; the provider configured today cannot establish what happened to an older message.
// A provider delivery report ("delivered") means the recipient's mail server accepted it; inbox
// placement and reading are never known. `problem` marks reports that need someone to act.
const REPORTS = {
  delivered: { text: 'Delivered to the recipient\'s mail server (provider report). Inbox placement is not tracked.' },
  delayed: { text: 'Accepted by the email provider; delivery is delayed and the provider is still retrying.' },
  bounced: { text: 'Bounced: the recipient\'s mail server rejected it. Contact them another way.', problem: true },
  complained: { text: 'Delivered, then marked as spam by the recipient.', problem: true },
  provider_failed: { text: 'The email provider could not send it.', problem: true },
  suppressed: { text: 'Not sent: the provider suppressed this address after an earlier bounce or spam report.', problem: true }
};

export function emailEvidence(run) {
  return deliveryEvidence(run.email_delivery);
}

// evidence: { status, transport, report } from Flow runs, or the same fields of an email record.
export function deliveryEvidence(evidence) {
  if (evidence?.status === 'sent' && evidence.transport === 'outbox') {
    return { verified: true, text: 'Recorded in the local outbox; not delivered to an inbox.' };
  }
  if (evidence?.status === 'sent' && evidence.transport === 'http') {
    const report = REPORTS[evidence.report];
    if (report) return { verified: true, problem: Boolean(report.problem), text: report.text };
    return { verified: true, text: 'Accepted by the email provider; no delivery report yet. Inbox delivery is not confirmed.' };
  }
  return { verified: false, text: 'Email action recorded; its sending method is not verified. Inbox delivery is not tracked. Check with your workspace administrator before following up.' };
}
