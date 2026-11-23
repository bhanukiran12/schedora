import {ask,toast} from './core.mjs';
async function worker(){if(!('serviceWorker'in navigator))throw Error('This browser does not support offline spreadsheets.');await navigator.serviceWorker.register('/sw.js');const registration=await navigator.serviceWorker.ready;return registration.active}
function message(target,data){return new Promise((resolve,reject)=>{const channel=new MessageChannel();const timer=setTimeout(()=>reject(Error('Offline setup timed out. Check the connection and try again.')),45000);channel.port1.onmessage=event=>{clearTimeout(timer);channel.port1.close();event.data.error?reject(Error(event.data.error)):resolve(event.data)};target.postMessage({...data,page:location.pathname},[channel.port2])})}
export async function toggleOfflineSpreadsheet(endpoint){
  const target=await worker();const {enabled}=await message(target,{type:'SHEETS_OFFLINE_STATUS'});
  const confirmed=await ask({title:enabled?'Remove offline copy?':'Make available offline?',body:enabled?'Remove the saved copy from this device. Your online workbook and pending edits stay intact.':'Save this workbook and the pages needed to edit it on this device. Use a trusted device: saved data can be opened without a network connection. Signing out removes offline copies. Changes sync when the connection returns; new form responses need a connection.',confirm:enabled?'Remove offline copy':'Save offline copy'});if(!confirmed)return;
  if(enabled){await message(target,{type:'SHEETS_OFFLINE_REMOVE'});toast('Offline copy removed.');return}
  await message(target,{type:'SHEETS_OFFLINE_ENABLE',endpoint,assets:performance.getEntriesByType('resource').map(entry=>entry.name)});toast('Available offline on this device. Reopen this workbook URL to continue editing offline.');
}
