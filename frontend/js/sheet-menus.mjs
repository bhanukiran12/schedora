import {html,raw} from './core.mjs';
import {sheetIcon} from './sheet-icons.mjs';
export function renderSpreadsheetMenu(entries,{available=()=>true,reason=()=>''}={}) {
  return html`${entries.map(entry=>{
    if(!entry)return html`<hr role="separator">`;
    const disabled=entry.disabled||(!entry.children&&!available(entry.action)&&reason(entry.action));
    const icon=entry.checked===true?sheetIcon('check'):entry.icon?sheetIcon(entry.icon):'<span class="sheet-icon"></span>';
    if(entry.children)return html`<div class="sheet-menu-group"><button type="button" role="menuitem" aria-haspopup="menu" aria-expanded="false" data-submenu><span class="sheet-menu-label">${raw(icon)}<span>${entry.label}</span></span>${raw(sheetIcon('chevron'))}</button><div class="sheets-menu sheet-submenu" role="menu" aria-label="${entry.label}" hidden>${renderSpreadsheetMenu(entry.children,{available,reason})}</div></div>`;
    return html`<button type="button" role="${typeof entry.checked==='boolean'?'menuitemcheckbox':'menuitem'}" ${typeof entry.checked==='boolean'?raw(`aria-checked="${entry.checked}"`):''} data-action="${entry.action}" ${disabled?raw('disabled'):''} title="${disabled||''}"><span class="sheet-menu-label">${raw(icon)}<span>${entry.label}</span></span>${entry.keys?html`<kbd>${entry.keys}</kbd>`:''}${disabled?html`<span class="visually-hidden">${disabled}</span>`:''}</button>`;
  })}`;
}
export function bindSpreadsheetSubmenus(menu) {
  const items=panel=>[...panel.children].flatMap(child=>child.matches('[role^="menuitem"]')?[child]:child.classList.contains('sheet-menu-group')?[child.firstElementChild]:[]).filter(item=>!item.disabled);
  function close(panel){for(const group of panel.querySelectorAll('.sheet-menu-group')){group.firstElementChild.setAttribute('aria-expanded','false');group.lastElementChild.hidden=true}}
  function open(button,focus=false){
    const panel=button.parentElement.parentElement;
    for(const other of panel.children)if(other.classList.contains('sheet-menu-group')&&other.firstElementChild!==button){close(other);other.lastElementChild.hidden=true;other.firstElementChild.setAttribute('aria-expanded','false')}
    const child=button.nextElementSibling;if(!child)return;
    child.hidden=false;button.setAttribute('aria-expanded','true');
    const box=button.getBoundingClientRect(),width=Math.min(300,innerWidth-16);child.style.width=width+'px';
    child.style.left=Math.max(8,box.right+width+8>innerWidth?box.left-width:box.right)+'px';
    child.style.top=Math.max(8,Math.min(box.top,innerHeight-Math.min(child.scrollHeight,innerHeight-16)-8))+'px';
    child.style.maxHeight=(innerHeight-16)+'px';
    if(focus)items(child)[0]?.focus();
  }
  menu.addEventListener('pointerover',event=>{const button=event.target.closest('[role^="menuitem"]');if(!button)return;if(button.hasAttribute('data-submenu'))open(button);else{const panel=button.parentElement;for(const group of panel.children)if(group.classList.contains('sheet-menu-group')){close(group);group.lastElementChild.hidden=true;group.firstElementChild.setAttribute('aria-expanded','false')}}});
  menu.addEventListener('click',event=>{const button=event.target.closest('[data-submenu]');if(button){event.stopPropagation();open(button,true)}});
  menu.addEventListener('keydown',event=>{
    const button=event.target.closest('[role^="menuitem"]');if(!button)return;
    const panel=button.closest('[role="menu"]'),list=items(panel),index=list.indexOf(button);
    if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();list[event.key==='Home'?0:event.key==='End'?list.length-1:(index+(event.key==='ArrowDown'?1:-1)+list.length)%list.length]?.focus()}
    else if(event.key==='ArrowRight'&&button.hasAttribute('data-submenu')){event.preventDefault();event.stopImmediatePropagation();open(button,true)}
    else if((event.key==='ArrowLeft'||event.key==='Escape')&&panel!==menu){event.preventDefault();event.stopImmediatePropagation();close(panel);panel.hidden=true;panel.previousElementSibling.setAttribute('aria-expanded','false');panel.previousElementSibling.focus()}
  },true);
  return ()=>close(menu);
}
