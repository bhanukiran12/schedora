// Popup: connects with a workspace API key (Account → API keys) and lists booking links.
const main = document.getElementById('main');
const status = document.getElementById('status');
const say = message => { status.textContent = message; };
const store = { get: keys => chrome.storage.local.get(keys), set: values => chrome.storage.local.set(values), clear: () => chrome.storage.local.clear() };

function element(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

async function call(settings, path, init = {}) {
  const response = await fetch(settings.server + path, { ...init, headers: { Authorization: `Bearer ${settings.key}`, 'Content-Type': 'application/json', ...init.headers } });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status})`);
  return body;
}

function showSetup(message) {
  main.replaceChildren(
    element('p', { textContent: message || 'Connect the extension with an API key from Account → API keys.' }),
    element('label', { htmlFor: 'server', textContent: 'Schedora address' }), element('input', { id: 'server', value: 'https://schedora.in', type: 'url' }),
    element('label', { htmlFor: 'key', textContent: 'API key' }), element('input', { id: 'key', type: 'password', placeholder: 'sch_…', autocomplete: 'off' }),
    element('div', { className: 'row' }, element('button', { className: 'primary', textContent: 'Connect', onclick: connect }))
  );
}

async function connect() {
  const server = document.getElementById('server').value.trim().replace(/\/$/, '');
  const key = document.getElementById('key').value.trim();
  try {
    if (new URL(server).protocol !== 'https:') throw new Error('Use an https:// address.');
    const info = await call({ server, key }, '/api/key');
    await store.set({ server, key, workspace: info.workspace });
    load();
  } catch (error) { say(error.message); }
}

async function load() {
  const settings = await store.get(['server', 'key', 'workspace']);
  if (!settings.key) return showSetup();
  try {
    const types = (await call(settings, `/api/workspaces/${settings.workspace.id}/event-types`)).filter(type => type.published && !type.managed_template);
    const link = type => `${settings.server}/meet/${settings.workspace.slug}/${type.slug}`;
    main.replaceChildren(
      element('p', { className: 'meta', textContent: settings.workspace.name }),
      types.length ? element('ul', {}, ...types.map(type => element('li', {},
        element('div', {}, element('div', { textContent: type.title }), element('div', { className: 'meta', textContent: `${type.duration_min} min${type.one_off ? ' · one-off' : ''}` })),
        element('button', { textContent: 'Copy link', onclick: async () => { await navigator.clipboard.writeText(link(type)); say('Link copied.'); } })
      ))) : element('p', { textContent: 'No published event types yet.' }),
      element('div', { className: 'row' },
        element('button', { className: 'primary', textContent: 'New one-off link', onclick: () => oneOff(settings, types) }),
        element('button', { textContent: 'Open Meet', onclick: () => chrome.tabs.create({ url: settings.server + '/meet' }) }),
        element('button', { textContent: 'Disconnect', onclick: async () => { await store.clear(); showSetup('Disconnected.'); } }))
    );
  } catch (error) { showSetup(error.message); }
}

// Creates a single-use link with the same settings as your first event type, valid for 14 days.
async function oneOff(settings, types) {
  const base = types.find(type => !type.one_off);
  if (!base) return say('Create an event type in Meet first.');
  try {
    const created = await call(settings, `/api/workspaces/${settings.workspace.id}/event-types`, {
      method: 'POST',
      body: JSON.stringify({ title: base.title, duration_min: base.duration_min, timezone: base.timezone, locations: base.locations, rules: base.rules, published: true, one_off: true, single_use: true, expires_at: new Date(Date.now() + 14 * 86400000).toISOString() })
    });
    await navigator.clipboard.writeText(`${settings.server}/meet/${settings.workspace.slug}/${created.slug}`);
    say('One-off link copied. It works once and expires in 14 days.');
  } catch (error) { say(error.message); }
}

load();
