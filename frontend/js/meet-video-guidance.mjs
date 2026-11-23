import { fmtDateTime, html, notice } from './core.mjs';

// "Before you start" for hosts on the pre-join screen (backend videoGuidance in src/video/rooms.mjs).
// It explains what the server will enforce; it never changes the provider, the room or its links.

const HEADLINE = {
  enough: ['ok', 'Enough Meet credits for the planned time'],
  may_run_out: ['warn', 'Credits may run out before the planned end'],
  cannot_start: ['bad', 'Not enough Meet credits to start'],
  video_unavailable: ['bad', 'Video is not available right now']
};

export function guidancePanel(guidance) {
  const [kind, title] = HEADLINE[guidance.status] || HEADLINE.enough;
  const { limits, credits } = guidance;
  const basis = credits.estimate_basis;
  return html`<details class="video-guidance" ${guidance.status === 'enough' ? '' : 'open'}><summary><span class="badge badge-${kind}">${title}</span></summary>
    ${guidance.unavailable ? notice('bad', html`<p>${guidance.unavailable}</p>`) : ''}
    <dl class="confirm-facts">
      <dt>People</dt><dd>Up to ${limits.max_participants} at once${limits.invited_seats ? ` · ${limits.invited_seats} guest seat${limits.invited_seats === 1 ? '' : 's'} invited` : ''}</dd>
      <dt>Time</dt><dd>${limits.scheduled_minutes ? `${limits.scheduled_minutes} minutes planned, up to ${limits.overtime_minutes} minutes over. ` : ''}The room closes at ${fmtDateTime(limits.hard_end_at)}.</dd>
      <dt>Cost</dt><dd>${credits.per_participant_minute} credit per person per minute. About ${credits.estimated} credits for ${basis.participants} people over ${basis.minutes} minutes.</dd>
      <dt>To join</dt><dd>Each person needs ${credits.first_join} credits reserved when they join.</dd>
      ${credits.available != null ? html`<dt>Available</dt><dd>${credits.available} credits</dd>` : ''}
    </dl>
    ${guidance.status !== 'enough' ? notice(kind === 'bad' ? 'bad' : 'warn', html`<p>${guidance.status === 'cannot_start' ? 'Joining will be refused until credits are available.' : guidance.on_exhaustion}</p>${credits.can_recharge ? html`<p><a href="/billing" data-external>Recharge Meet credits</a></p>` : ''}`) : html`<p class="hint">${guidance.on_exhaustion}</p>`}
    <p class="hint">${guidance.at_hard_end}</p>
    <h3 class="guidance-heading">If the call can't go ahead</h3>
    <ul class="guidance-steps">${guidance.recovery.map(step => html`<li>${step}</li>`)}</ul>
  </details>`;
}
