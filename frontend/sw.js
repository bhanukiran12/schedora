// Network-first app shell. Private spreadsheet copies exist only after explicit device opt-in.
const SHELL_CACHE='schedora-shell-v3';
const PRIVATE_PREFIX='schedora-sheets-offline-v1-';
const META='/__schedora_sheets_offline_meta';
const SHELL=['/','/app.css','/app.js','/favicon.svg','/manifest.webmanifest'];
const UUID='[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const PAGE=new RegExp('^/sheets/(?:workbooks/)?('+UUID+')$');
const STATIC=/^\/(?:[a-z-]+\.(?:js|css|svg|png|webmanifest)|(?:js|shared|shared\/sheets-engine)\/[a-z-]+\.mjs)$/;
self.addEventListener('install',event=>event.waitUntil(caches.open(SHELL_CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key.startsWith('schedora-shell-')&&key!==SHELL_CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
async function copies(){const result=[];for(const key of await caches.keys()){if(!key.startsWith(PRIVATE_PREFIX))continue;const cache=await caches.open(key);const response=await cache.match(META);if(response)result.push({key,cache,meta:await response.json()})}return result}
async function purge(){for(const key of await caches.keys())if(key.startsWith(PRIVATE_PREFIX))await caches.delete(key)}
async function currentCopy(request){const page=new URL(request.referrer||request.url).pathname;return(await copies()).find(copy=>copy.meta.page===page)}
async function privateFetch(request){
  const url=new URL(request.url);const copy=await currentCopy(request);
  try{
    const response=await fetch(request);
    if(url.pathname==='/api/me'){
      if(response.status===401)await purge();
      else if(response.ok){const me=await response.clone().json();for(const entry of await copies())if(entry.meta.user!==me.user?.id)await caches.delete(entry.key)}
    }
    if(copy&&copy.meta.requests.includes(url.pathname+url.search)){
      if(response.status===401||response.status===403||response.status===404)await caches.delete(copy.key);
      else if(response.ok)await copy.cache.put(request,response.clone());
    }
    return response;
  }catch(error){
    if(copy&&copy.meta.requests.includes(url.pathname+url.search)){const saved=await copy.cache.match(request);if(saved)return saved}
    throw error;
  }
}
// Server-accepted snapshots refresh an enabled copy; pending POST bodies are never cached.
async function workbookWrite(request){
  const copy=await currentCopy(request),response=await fetch(request);
  const endpoint=copy?.meta.requests.find(path=>/\/(?:workbooks\/[^/]+|workbook)$/.test(path));
  if(!copy||!endpoint||!new URL(request.url).pathname.startsWith(endpoint+'/'))return response;
  if([401,403,404].includes(response.status)){await caches.delete(copy.key);return response}
  if(!response.ok)return response;
  const result=await response.clone().json().catch(()=>null);
  if(!result?.sheets)return response;
  const old=await copy.cache.match(endpoint);if(!old)return response;
  const snapshot=await old.json();
  if(result.revision>=snapshot.revision)await copy.cache.put(endpoint,new Response(JSON.stringify({...snapshot,sheets:result.sheets,revision:result.revision,...(typeof result.can_edit==='boolean'?{can_edit:result.can_edit}:{})}),{headers:{'Content-Type':'application/json'}}));
  return response;
}
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);if(url.origin!==location.origin)return;
  if(request.method!=='GET'){
    if(/^\/api\/(?:auth\/(?:logout|login|signup)|account(?:\/|$))/.test(url.pathname))event.respondWith(purge().then(()=>fetch(request)));
    else if(/\/(?:changes|sync|restore)$/.test(url.pathname))event.respondWith(workbookWrite(request));
    return;
  }
  if(url.pathname.startsWith('/api/')){event.respondWith(privateFetch(request));return}
  if(/^\/meet\/(?:room|join)\//.test(url.pathname))return;
  if(request.mode==='navigate'){
    event.respondWith(fetch(request).catch(async error=>{const copy=(await copies()).find(item=>item.meta.page===url.pathname);if(copy){const page=await copy.cache.match(url.pathname);if(page)return page}const shell=await caches.match('/');if(shell)return shell;throw error}));return;
  }
  if(STATIC.test(url.pathname))event.respondWith(fetch(request).then(async response=>{if(response.ok)(await caches.open(SHELL_CACHE)).put(request,response.clone());return response}).catch(async error=>{const cached=await caches.match(request);if(cached)return cached;throw error}));
});
self.addEventListener('message',event=>{
  if(!event.ports?.[0]||!event.data?.type?.startsWith('SHEETS_OFFLINE_'))return;
  event.waitUntil((async()=>{
    const reply=value=>event.ports[0].postMessage(value);
    try{
      const source=new URL(event.source.url);const page=event.data.page??source.pathname,match=PAGE.exec(page);if(source.origin!==location.origin||!PAGE.test(source.pathname)||!match)throw Error('Open a spreadsheet first.');
      if(event.data.type==='SHEETS_OFFLINE_STATUS'){reply({enabled:(await copies()).some(item=>item.meta.page===page)});return}
      if(event.data.type==='SHEETS_OFFLINE_REMOVE'){for(const item of await copies())if(item.meta.page===page)await caches.delete(item.key);reply({enabled:false});return}
      if(event.data.type!=='SHEETS_OFFLINE_ENABLE')throw Error('Unknown offline command.');
      const meResponse=await fetch('/api/me',{credentials:'same-origin',cache:'no-store'});if(!meResponse.ok)throw Error('Sign in while online to enable offline editing.');const me=await meResponse.json();
      const endpoint=event.data.endpoint;
      if(typeof endpoint!=='string'||!new RegExp('^/api/workspaces/'+UUID+'/(?:workbooks/'+UUID+'|forms/'+UUID+'/workbook)$').test(endpoint)||!endpoint.includes(match[1]))throw Error('Wait for this workbook to finish opening, then try again.');
      if((await copies()).length>=10&&!(await copies()).some(item=>item.meta.page===page))throw Error('Remove an offline copy before adding another (maximum 10).');
      const requestPaths=new Set(['/api/me','/api/config',endpoint]);
      const staticPaths=new Set(SHELL);
      for(const input of (event.data.assets??[]).slice(-250)){
        let url;try{url=new URL(input,location.origin)}catch{continue}if(url.origin!==location.origin)continue;
        if(STATIC.test(url.pathname))staticPaths.add(url.pathname+url.search);
        else if(url.pathname.startsWith(endpoint+'/links/')||url.pathname===endpoint+'/responses')requestPaths.add(url.pathname+url.search);
      }
      const key=PRIVATE_PREFIX+me.user.id+'-'+match[1],cache=await caches.open(key);let total=0;
      try{
        for(const path of [page,...requestPaths]){const response=await fetch(path,{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error('This spreadsheet could not be saved for offline use.');const bytes=(await response.clone().arrayBuffer()).byteLength;total+=bytes;if(total>8*1024*1024)throw Error('The offline copy exceeds the 8 MB allowance.');await cache.put(path,response)}
        await(await caches.open(SHELL_CACHE)).addAll([...staticPaths]);
        await cache.put(META,new Response(JSON.stringify({page,user:me.user.id,requests:[...requestPaths]}),{headers:{'Content-Type':'application/json'}}));
      }catch(error){await caches.delete(key);throw error}
      reply({enabled:true});
    }catch(error){reply({error:error.message||'Offline setup failed.'})}
  })());
});
