import { $, api, ask, html, raw, toast, wsPath } from './core.mjs';
import { draftAddress } from './forms-picker.mjs';

export async function openAiFormDraft(ctx) {
  try {
    const budget = await api('GET', wsPath('/forms/ai-usage'));
    if (!budget.available) return toast('AI drafting is not connected on this server. You can still create a blank form.');
    if (!budget.remaining) return toast('The workspace AI budget is used up. It resets at 00:00 UTC.');
    let pdf = Promise.resolve(null);
    const decision = ask({ title: 'Draft a form with AI', body: html`<p>Your description and optional PDF are sent to the configured AI provider. Review the resulting private draft before publishing.</p><p>${budget.remaining} of ${budget.limit} requests remain today. Token usage is recorded; no form is published automatically.</p>`, fields: html`<label for="ai-form-description">Describe the form</label><textarea id="ai-form-description" name="description" minlength="10" maxlength="10000" rows="5" required placeholder="An enquiry form for our weekend coding course, including experience, preferred schedule and contact details"></textarea><label for="ai-form-pdf">Optional brochure or source PDF (up to 2 MB)</label><input id="ai-form-pdf" type="file" accept="application/pdf,.pdf"><p id="ai-form-file-state" role="status"></p>`, confirm: 'Generate private draft' });
    $('#ai-form-pdf').addEventListener('change', event => {
      const file = event.target.files?.[0];
      pdf = file ? new Promise(resolve => {
        if (file.size > 2 * 1024 * 1024) { $('#ai-form-file-state').textContent = 'Choose a PDF of up to 2 MB.'; resolve({ error: true }); return; }
        const reader = new FileReader();
        reader.onload = () => { $('#ai-form-file-state')?.replaceChildren(document.createTextNode(file.name + ' ready')); resolve(String(reader.result).split(',')[1]); };
        reader.onerror = () => resolve({ error: true });
        reader.readAsDataURL(file);
      }) : Promise.resolve(null);
    });
    const input = await decision;
    if (!input || !ctx.alive()) return;
    const source = await pdf;
    if (source?.error) return toast('The PDF could not be read. Choose a valid PDF and try again.');
    toast('Generating a private draft…');
    const result = await api('POST', wsPath('/forms/ai-draft'), { description: input.description, ...(source ? { pdf: source } : {}), request_id: crypto.randomUUID() });
    if (ctx.alive()) { toast(`Draft created. ${result.usage.input_tokens + result.usage.output_tokens} AI tokens used. Review before publishing.`); ctx.navigate(draftAddress(result.form)); }
  } catch (error) { toast(error.message || 'The draft could not be generated. Nothing was published.'); }
}

export async function openAiResponseSummary(formId) {
  try {
    const budget = await api('GET', wsPath('/forms/ai-usage'));
    if (!budget.available) return toast('AI response summaries are not connected on this server.');
    const decision = await ask({ title: 'Summarize text responses', body: html`<p>The latest 100 responses are sampled. Text answers are sent to the configured AI provider; names and other details entered in those answers may be included. Use this only when you are permitted to process that information.</p><p>Every theme links to its source responses. ${budget.remaining} of ${budget.limit} daily requests remain. This does not change any response.</p>`, confirm: 'Generate summary' });
    if (!decision) return;
    const result = await api('POST', wsPath(`/forms/${formId}/ai-summary`), { request_id: crypto.randomUUID() });
    await ask({ title: 'Themes in text responses', body: html`<p>Based on ${result.sampled} sampled responses out of ${result.total}. AI themes may need review. ${result.usage.input_tokens + result.usage.output_tokens} tokens used.</p>${result.themes.map(theme => html`<section><h3>${theme.label}</h3><ul>${theme.response_ids.map(id => html`<li><a href="/forms/${formId}/responses?q=${encodeURIComponent(id.replaceAll('-', '').slice(0, 8))}">View response ${id.replaceAll('-', '').slice(0, 8).toUpperCase()}</a></li>`)}</ul></section>`)}`, confirm: 'Close' });
  } catch (error) { toast(error.message || 'The response summary could not be generated.'); }
}
