import { $, api, ask, html, mount, session, toast, wsPath } from './core.mjs';
import { needsSession, setTitle, signInPrompt } from './pages.mjs';

export async function workbookListPage(ctx) {
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'forms', title: 'Sign in to open Sheets', lead: 'Open your workbooks and workbooks shared with you.' }));
  if (!needsSession(ctx)) return;
  setTitle('Schedora Sheets');
  mount(ctx.main, html`<div class="container page">
    <div class="row-between"><h1>Sheets</h1><button type="button" class="btn btn-primary" id="new-workbook">New workbook</button></div>
    <button type="button" class="btn" id="workbook-trash">Trash</button>
    <div id="workbook-list" class="loading" role="status">Loading workbooks…</div></div>`);
  $('#workbook-trash').addEventListener('click',async()=>{try{const {workbooks}=await api('GET',wsPath('/workbooks/trash'));if(!workbooks.length)return toast('Trash is empty.');const result=await ask({title:'Restore spreadsheet',fields:html`<label for="trash-workbook">Spreadsheet</label><select name="id" id="trash-workbook">${workbooks.map(item=>html`<option value="${item.id}">${item.title}</option>`)}</select>`,confirm:'Restore'});if(result){await api('PUT',wsPath('/workbooks/'+result.id+'/trash'),{trashed:false});ctx.navigate('/sheets/workbooks/'+result.id)}}catch(error){toast(error.message)}});
  $('#new-workbook').addEventListener('click', async () => {
    const input = await ask({ title: 'New workbook', fields: html`<label for="new-workbook-title">Name</label><input id="new-workbook-title" name="title" maxlength="100" value="Untitled workbook" required>`, confirm: 'Create workbook' });
    if (!ctx.alive() || !input) return;
    try {
      const workbook = await api('POST', wsPath('/workbooks'), input);
      if (ctx.alive()) ctx.navigate(`/sheets/workbooks/${workbook.id}`);
    } catch (error) { if (ctx.alive()) toast(error.message); }
  });
  try {
    const { workbooks } = await api('GET', wsPath('/workbooks'));
    if (!ctx.alive()) return;
    const list = $('#workbook-list');
    list.classList.remove('loading');
    list.removeAttribute('role');
    mount(list, workbooks.length ? html`<ul class="plain-list">${workbooks.map(item => html`<li class="card row-between"><a href="/sheets/workbooks/${item.id}">${item.title}</a><span class="muted">${({ owner: 'Owner', editor: 'Editor', viewer: 'Viewer' })[item.role]}</span></li>`)}</ul>` : html`<p>You have no standalone workbooks yet.</p>`);
  } catch (error) { if (ctx.alive()) $('#workbook-list').textContent = error.message; }
}
