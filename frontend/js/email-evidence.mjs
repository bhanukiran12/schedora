// A completed run records an action, not inbox delivery. Describe the message's saved transport
// evidence; the provider configured today cannot establish what happened to an older message.
export function emailEvidence(run) {
  const evidence = run.email_delivery;
  if (evidence?.status === 'sent' && evidence.transport === 'outbox') {
    return { verified: true, text: 'Recorded in the local outbox; not delivered to an inbox.' };
  }
  if (evidence?.status === 'sent' && evidence.transport === 'http') {
    return { verified: true, text: 'Accepted by the email provider; inbox delivery is not tracked.' };
  }
  return { verified: false, text: 'Email action recorded; its sending method is not verified. Inbox delivery is not tracked. Check with your workspace administrator before following up.' };
}
