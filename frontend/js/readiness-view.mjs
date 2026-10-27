// Renders a readiness result (readiness.mjs) as expandable areas. Wide screens open every area;
// phones open only the areas that need attention, so the summary stays short and every status
// is still visible in the closed summary line.
import { html, raw } from './core.mjs';
import { KIND_LABELS, STATUS_ICONS, STATUS_LABELS } from './readiness.mjs';

const action = item => item.action.section ? html`<button class="btn-link" type="button" data-goto="${item.action.section}">${item.action.label}</button>`
  : item.action.href ? html`<a href="${item.action.href}">${item.action.label}</a>`
  : item.action.retry ? html`<button class="btn-link" type="button" data-recheck>${item.action.label}</button>`
  : html`<span class="muted">${item.action.note}</span>`;

const itemView = item => html`<li data-state="${item.status || 'fact'}" data-kind="${item.kind || ''}"><span class="readiness-icon" aria-hidden="true">${item.status ? STATUS_ICONS[item.status] : 'i'}</span>
  <div><p>${item.status === 'ready' ? html`<span class="visually-hidden">Ready: </span>` : item.status ? html`<strong>${STATUS_LABELS[item.status]}${item.kind ? ` · ${KIND_LABELS[item.kind]}` : ''}:</strong> ` : ''}${item.text}</p>${item.action ? html`<p class="readiness-action">${action(item)}</p>` : ''}</div></li>`;

/** @param extra area => extra markup appended inside that area (e.g. share controls) */
export function readinessAreas(result, { extra = () => '' } = {}) {
  const wide = matchMedia('(min-width: 761px)').matches;
  return html`<p class="readiness-headline">${result.headline}</p>
    <div class="readiness-areas">${result.areas.map(area => {
      const blocking = area.items.some(item => item.kind === 'blocker');
      return html`<details class="readiness-area" data-area="${area.key}" data-state="${area.status}" data-blocking="${blocking ? 'true' : 'false'}" ${wide || area.status === 'attention' ? raw('open') : ''}>
        <summary id="ready-${area.key}"><span class="readiness-icon" aria-hidden="true">${STATUS_ICONS[area.status]}</span><span class="readiness-title">${area.title}</span><span class="readiness-state">${STATUS_LABELS[area.status]}${blocking ? ' · Required' : ''}</span></summary>
        <ul class="readiness-items">${area.items.map(itemView)}</ul>${extra(area)}</details>`;
    })}</div>`;
}
