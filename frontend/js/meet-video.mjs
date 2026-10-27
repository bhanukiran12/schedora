// Schedora Meet video: prejoin, meeting room, instant meetings and the Meet credits panel.
// Meeting pages are always full page loads (/meet/room/… for members, /meet/join/… for guests):
// only those documents receive the camera/microphone permission and the provider CSP.
// Provider tokens live only in memory for the current connection; nothing is persisted.
import { $, $$, api, ask, badge, boot, copy, errorBlock, fmtDateTime, fmtFull, html, loading, mount, notice, raw, session, toast, wsPath } from './core.mjs';
import { setTitle, signInPrompt } from './pages.mjs';

let sdkPromise = null;
const sdk = () => sdkPromise ||= import('/vendor/livekit-client.esm.mjs');
const credits = units => Math.floor(units / 60 * 10) / 10;
const inr = (minor, currency) => new Intl.NumberFormat('en-IN', { style: 'currency', currency }).format(minor / 100);

// One live meeting per document. Anything that navigates away disposes it first.
let active = null;
export function leaveMeeting(reason = 'navigate') {
  const current = active;
  active = null;
  if (current) current.dispose(reason);
}
window.addEventListener('pagehide', () => leaveMeeting('pagehide'));

const STATES = {
  too_early: ['This meeting has not opened yet', 'This page checks again automatically and opens the meeting when joining starts.'],
  ended: ['This meeting has ended', 'Thanks for joining. You can close this page.'],
  canceled: ['This appointment was canceled', 'Its meeting link no longer works. Contact the host if you think this is a mistake.'],
  rescheduled: ['This appointment was rescheduled', 'Use the meeting link in your newest confirmation email.'],
  revoked: ['This meeting link is no longer valid', 'Ask the host for a new link.'],
  payment_pending: ['Payment is still pending', 'Complete payment for your appointment, then use the link in your confirmation email.'],
  unavailable: ['Video is not available right now', 'Schedora Meet video is switched off for this meeting. Your appointment itself is unaffected; contact the host for another way to meet.'],
  // The service did not answer: the cause is unknown, so none is named.
  unreachable: ['We could not connect to the video service', 'This may be a network problem or a temporary service issue. Your appointment itself is unaffected.'],
  unsupported: ['This browser cannot join video meetings', 'Use a recent version of Chrome, Edge, Firefox or Safari on a computer or phone.']
};
const ERROR_STATES = { meeting_ended: 'ended', meeting_canceled: 'canceled', booking_canceled: 'canceled', booking_rescheduled: 'rescheduled', link_revoked: 'revoked', payment_pending: 'payment_pending', video_unavailable: 'unavailable', too_early: 'too_early' };

function stateScreen(ctx, info, state, extra = '') {
  const [title, text] = STATES[state] || ['Unable to join', 'Please try again later.'];
  mount(ctx.main, html`<div class="container page narrow"><div class="card video-state" role="status">
    ${info?.workspace ? html`<span class="tag">${info.workspace.name}</span>` : ''}<h1>${title}</h1>
    ${info?.title ? html`<p><strong>${info.title}</strong>${info.starts_at ? html`<br>${fmtFull(info.starts_at)}` : ''}</p>` : ''}
    <p>${text}</p>${extra}</div></div>`);
}

const supported = () => Boolean(window.RTCPeerConnection && navigator.mediaDevices?.getUserMedia);

// ---------------------------------------------------------------------------------------------
// Entry points

export async function hostRoom(ctx) {
  const publicId = ctx.params[0];
  setTitle('Meeting · Meet by Schedora');
  if (!session.user) return mount(ctx.main, signInPrompt(ctx, { product: 'meet', title: 'Sign in to join this meeting', lead: 'This is a host link for Schedora Meet. Guests use the link from their invitation email.' }));
  let info;
  try { info = await api('GET', `/api/meet-video/rooms/${encodeURIComponent(publicId)}`); }
  catch (error) {
    if (error.status === 404) return stateScreen(ctx, null, 'revoked', html`<p class="hint">If this meeting belongs to another workspace, switch workspace or ask its host for access.</p>`);
    throw error;
  }
  if (!ctx.alive()) return;
  meetingFlow(ctx, {
    info, host: info.role === 'host', defaultName: session.user.name,
    load: participant => api('GET', `/api/meet-video/rooms/${encodeURIComponent(publicId)}${participant ? '?participant=' + encodeURIComponent(participant) : ''}`),
    join: body => api('POST', `/api/meet-video/rooms/${encodeURIComponent(publicId)}/join`, body),
    end: () => api('POST', `/api/meet-video/rooms/${encodeURIComponent(publicId)}/end`),
    remove: id => api('POST', `/api/meet-video/rooms/${encodeURIComponent(publicId)}/participants/${encodeURIComponent(id)}/remove`),
    invite: () => api('POST', `/api/meet-video/rooms/${encodeURIComponent(publicId)}/invites`, { seats: 5 })
  });
}

async function resumeKey(token) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
  return 'schedora.video.' + [...new Uint8Array(digest)].slice(0, 8).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function guestRoom(ctx) {
  const token = ctx.params[0];
  setTitle('Join meeting · Meet by Schedora');
  let info;
  try { info = await api('GET', `/api/public/meet-video/join/${encodeURIComponent(token)}`); }
  catch (error) {
    if (error.status === 404) return stateScreen(ctx, null, 'revoked');
    throw error;
  }
  if (!ctx.alive()) return;
  // The seat id (not a secret) lets a reload in this tab resume the same seat. Tab-scoped only.
  const key = await resumeKey(token).catch(() => null);
  const seat = { get: () => { try { return key && sessionStorage.getItem(key); } catch { return null; } }, set: id => { try { if (key) sessionStorage.setItem(key, id); } catch { /* storage blocked */ } } };
  meetingFlow(ctx, {
    info, host: false, defaultName: '',
    load: participant => api('GET', `/api/public/meet-video/join/${encodeURIComponent(token)}${participant ? '?participant=' + encodeURIComponent(participant) : ''}`),
    join: async body => { const result = await api('POST', `/api/public/meet-video/join/${encodeURIComponent(token)}`, { ...body, resume: seat.get() || undefined }); seat.set(result.participant_id); return result; }
  });
}

// ---------------------------------------------------------------------------------------------
// Prejoin

function meetingFlow(ctx, flow) {
  document.body.dataset.meetingPage = '1';
  const { info } = flow;
  if (info.workspace?.brand_color) import('./meet.mjs').then(module => module.applyBrand(info.workspace.brand_color)).catch(() => {});
  if (!supported()) return stateScreen(ctx, info, 'unsupported');
  if (!info.video.available) return stateScreen(ctx, info, 'unavailable');
  if (info.state !== 'open') {
    if (info.state === 'too_early') return waitAndRetry(ctx, flow, html`<p class="hint">Opens at ${fmtDateTime(info.join_opens_at)}.</p>`, 30000);
    return stateScreen(ctx, info, info.state);
  }
  prejoin(ctx, flow);
}

function waitAndRetry(ctx, flow, extra, delay) {
  stateScreen(ctx, flow.info, 'too_early', extra);
  const timer = setTimeout(async () => {
    if (!ctx.alive()) return;
    try { flow.info = await flow.load(); } catch { /* keep waiting */ }
    if (ctx.alive()) meetingFlow(ctx, flow);
  }, delay);
  active = { dispose: () => clearTimeout(timer) };
}

// Shared vocabulary for media controls, so prejoin and the room say the same thing. The button
// names the action; the state is announced separately.
const MEDIA = {
  camera: on => on ? 'Turn camera off' : 'Turn camera on',
  microphone: on => on ? 'Mute microphone' : 'Unmute microphone',
  state: (camera, microphone) => `Camera ${camera ? 'on' : 'off'} · Microphone ${microphone ? 'on' : 'muted'}`
};

// Guidance for getUserMedia failures. Only the browser's error name is used; no cause is guessed.
function deviceAdvice(error, device, { joining = true } = {}) {
  const name = error?.name;
  const without = joining ? ` You can join with the ${device} off.` : '';
  if (name === 'NotAllowedError' || /permission/i.test(error?.message || '')) {
    return `Your browser is blocking the ${device}. To allow it, select the camera or lock icon in the address bar, allow the ${device}, then reload this page.${without}`;
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return `No ${device} was found. Connect one and choose it in the device settings.${without}`;
  if (name === 'NotReadableError' || name === 'AbortError') return `Your ${device} could not start. Another app may be using it; close that app and try again.${without}`;
  return `Your ${device} could not be started.${without}`;
}

async function prejoin(ctx, flow) {
  const { info } = flow;
  const LK = await sdk().catch(() => null);
  if (!ctx.alive()) return;
  if (!LK) return stateScreen(ctx, info, 'unreachable', html`<p class="hint">The meeting software could not be loaded. Check your connection and reload.</p>`);
  if (!LK.isBrowserSupported()) return stateScreen(ctx, info, 'unsupported');
  const preview = { video: null, audio: null, camera: true, microphone: true, disposed: false, joining: false, meter: null, problems: {} };
  const stopMeter = () => { preview.meter?.(); preview.meter = null; delete document.body.dataset.micMeter; };
  const stopPreview = () => { stopMeter(); preview.video?.stop(); preview.audio?.stop(); preview.video = preview.audio = null; };
  active = { dispose: () => { preview.disposed = true; stopPreview(); } };

  mount(ctx.main, html`<div class="container page prejoin-page"><div class="prejoin">
    <section class="prejoin-preview card" aria-label="Camera and microphone check">
      <div class="video-frame"><video id="preview" class="video-el mirrored" autoplay muted playsinline aria-label="Your camera preview"></video><div id="preview-off" class="video-placeholder" hidden>Camera off</div></div>
      <div class="row video-toggles">
        <button class="btn" type="button" id="toggle-camera" aria-describedby="media-state">${MEDIA.camera(true)}</button>
        <button class="btn" type="button" id="toggle-mic" aria-describedby="media-state">${MEDIA.microphone(true)}</button>
      </div>
      <p class="media-state" id="media-state" role="status">${MEDIA.state(true, true)}</p>
      <div class="mic-meter"><label for="mic-level">Microphone level</label><meter id="mic-level" min="0" max="1" low="0.08" high="0.7" optimum="0.4" value="0"></meter></div>
      <p class="hint" id="mic-quiet" hidden>We can't hear anything yet. Check that the right microphone is selected and isn't muted on the device.</p>
      <div id="device-status" aria-live="polite"><p class="hint">Your browser may ask to use your camera and microphone. Allow them to be seen and heard, or join with them off.</p></div>
    </section>
    <section class="card card-plain prejoin-details">
      ${info.workspace ? html`<span class="tag">${info.workspace.name}</span>` : ''}
      <h1>${info.title}</h1>
      ${info.starts_at ? html`<p class="lead">${fmtFull(info.starts_at)}</p>` : ''}
      <form id="join-form" novalidate>
        <label for="display-name">Your name</label><input id="display-name" name="display_name" required maxlength="60" autocomplete="name" value="${flow.defaultName || ''}">
        <div data-form-status tabindex="-1" id="join-status" aria-live="polite"></div>
        <div class="actions"><button class="btn btn-primary" type="submit" id="join-button">Join meeting</button></div>
        <details class="device-settings"><summary>Camera and microphone settings</summary>
          <label for="camera-select">Camera</label><select id="camera-select"><option value="">Default camera</option></select>
          <label for="mic-select">Microphone</label><select id="mic-select"><option value="">Default microphone</option></select>
        </details>
        <p class="hint">Meetings are charged to the host's workspace by connected time. Guests never pay.</p>
      </form>
    </section></div></div>`);

  const status = () => {
    const notes = Object.values(preview.problems).filter(Boolean);
    mount($('#device-status'), notes.length ? notice('warn', html`${notes.map(note => html`<p>${note}</p>`)}`) : '');
  };
  function syncToggles() {
    $('#toggle-camera').textContent = MEDIA.camera(preview.camera);
    $('#toggle-mic').textContent = MEDIA.microphone(preview.microphone);
    $('#media-state').textContent = MEDIA.state(preview.camera, preview.microphone);
  }
  // Local-only level meter: an analyser on the preview track, closed whenever the track changes.
  function startMeter() {
    stopMeter();
    if (!preview.audio) return;
    let analyser;
    try { analyser = LK.createAudioAnalyser(preview.audio); } catch { return; }
    const meter = $('#mic-level');
    const started = Date.now();
    let loudest = 0;
    const timer = setInterval(() => {
      const level = Math.min(1, analyser.calculateVolume() * 3);
      loudest = Math.max(loudest, level);
      if (meter) meter.value = level;
      const quiet = $('#mic-quiet');
      if (quiet) quiet.hidden = !(Date.now() - started > 5000 && loudest < 0.02);
    }, 120);
    document.body.dataset.micMeter = 'on';
    preview.meter = () => { clearInterval(timer); analyser.cleanup().catch(() => {}); if (meter) meter.value = 0; };
  }
  async function startCamera() {
    preview.video?.stop(); preview.video = null;
    if (!preview.camera) { $('#preview-off').hidden = false; return; }
    try {
      const track = await LK.createLocalVideoTrack({ deviceId: $('#camera-select').value || undefined, resolution: preset(LK, info.video.max_video_height).resolution });
      if (preview.disposed || !preview.camera) { track.stop(); return; }
      preview.video?.stop();
      preview.video = track;
      preview.video.attach($('#preview'));
      $('#preview-off').hidden = true;
      preview.problems.camera = null;
    } catch (error) { if (preview.disposed) return; preview.camera = false; preview.problems.camera = deviceAdvice(error, 'camera'); $('#preview-off').hidden = false; syncToggles(); }
    status();
  }
  async function startMic() {
    stopMeter();
    preview.audio?.stop(); preview.audio = null;
    if (!preview.microphone) return;
    try {
      const track = await LK.createLocalAudioTrack({ deviceId: $('#mic-select').value || undefined, echoCancellation: true, noiseSuppression: true });
      if (preview.disposed || !preview.microphone) { track.stop(); return; }
      preview.audio?.stop();
      preview.audio = track;
      preview.problems.microphone = null;
      startMeter();
    } catch (error) { if (preview.disposed) return; preview.microphone = false; preview.problems.microphone = deviceAdvice(error, 'microphone'); syncToggles(); }
    status();
  }
  async function listDevices() {
    try {
      const [cameras, mics] = await Promise.all([LK.Room.getLocalDevices('videoinput', false), LK.Room.getLocalDevices('audioinput', false)]);
      if (preview.disposed) return;
      fillDevices($('#camera-select'), cameras, 'Default camera');
      fillDevices($('#mic-select'), mics, 'Default microphone');
    } catch { /* device names need permission; the defaults still work */ }
  }
  $('#toggle-camera').onclick = async () => { preview.camera = !preview.camera; syncToggles(); await startCamera(); };
  $('#toggle-mic').onclick = async () => { preview.microphone = !preview.microphone; syncToggles(); await startMic(); };
  $('#camera-select').onchange = startCamera;
  $('#mic-select').onchange = startMic;
  // Bound before any permission prompt resolves, so Join never falls back to a GET submission.
  $('#join-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (preview.disposed || preview.joining) return;
    const name = $('#display-name').value.trim();
    if (!name) { mount($('#join-status'), notice('bad', html`<p>Enter your name.</p>`)); $('#display-name').focus(); return; }
    preview.joining = true;
    $('#join-button').setAttribute('aria-disabled', 'true');
    mount($('#join-status'), html`<p class="muted" role="status">Joining…</p>`);
    try {
      const admission = await flow.join({ display_name: name });
      if (!ctx.alive() || preview.disposed) return;
      stopMeter(); // the meeting takes over the track; the analyser must not outlive the prejoin page
      const tracks = { video: preview.video, audio: preview.audio, devices: { videoinput: $('#camera-select').value, audioinput: $('#mic-select').value } };
      preview.disposed = true;
      preview.video = preview.audio = null; // ownership moves to the meeting
      await meeting(ctx, flow, LK, admission, tracks);
    } catch (error) {
      if (!ctx.alive()) return;
      $('#join-button')?.removeAttribute('aria-disabled');
      if (error.code === 'waiting_for_host') return waitForHost(ctx, flow);
      if (ERROR_STATES[error.code] && error.code !== 'too_early') { leaveMeeting(); return stateScreen(ctx, info, ERROR_STATES[error.code]); }
      const message = error.code === 'insufficient_credits' && flow.host ? html`<p>${error.message}</p><p><a href="/billing" data-external>Review Meet credits</a></p>`
        : error.code === 'too_early' ? html`<p>This meeting is not open yet.</p>` : error.status === 0 ? html`<p>Schedora could not be reached. Check your connection and try again.</p>` : html`<p>${error.message}</p>`;
      mount($('#join-status'), notice('bad', message));
    } finally { preview.joining = false; }
  });
  await Promise.all([startCamera(), startMic()]);
  if (!preview.disposed) await listDevices();
}

function fillDevices(select, devices, label) {
  if (!select) return;
  const value = select.value;
  mount(select, html`<option value="">${label}</option>${devices.filter(device => device.deviceId && device.deviceId !== 'default').map((device, index) => html`<option value="${device.deviceId}">${device.label || `${label.replace('Default ', '')} ${index + 1}`}</option>`)}`);
  select.value = [...select.options].some(option => option.value === value) ? value : '';
}

function waitForHost(ctx, flow) {
  mount($('#join-status'), notice('info', html`<p><strong>Waiting for the host.</strong> You'll join automatically when they arrive. Keep this page open.</p>`));
  let delay = 4000;
  let timer = null;
  const previous = active;
  const check = async () => {
    if (!ctx.alive() || active !== handle) return;
    try {
      const info = await flow.load();
      if (info.state !== 'open') { leaveMeeting(); return stateScreen(ctx, info, info.state); }
      if (info.host_present) { $('#join-form')?.requestSubmit(); return; }
    } catch { /* keep waiting */ }
    delay = Math.min(15000, delay * 1.5);
    timer = setTimeout(check, delay);
  };
  const handle = { dispose: reason => { clearTimeout(timer); previous?.dispose(reason); } };
  active = handle;
  timer = setTimeout(check, delay);
}

function preset(LK, maxHeight) {
  const presets = LK.VideoPresets;
  return maxHeight >= 720 ? presets.h720 : maxHeight >= 540 ? presets.h540 : maxHeight >= 360 ? presets.h360 : presets.h180;
}

// Screen-share failures. Browsers report both a cancelled picker and an OS-level block as
// NotAllowedError; Chrome marks the OS case with "by system", so only then is that cause named.
function shareAdvice(error) {
  if (!navigator.mediaDevices?.getDisplayMedia) return ['info', 'This browser cannot share its screen. Most phones and tablets cannot; use a computer to share.'];
  if (error?.name === 'NotAllowedError' && /system/i.test(error.message || '')) return ['warn', 'Your computer is blocking screen sharing for this browser. On a Mac, open System Settings › Privacy & Security › Screen Recording, allow this browser, then restart it and try again.'];
  if (error?.name === 'NotAllowedError') return ['info', 'Screen sharing did not start. If you chose Cancel, nothing is shared; select Share screen to try again.'];
  if (error?.name === 'NotReadableError' || error?.name === 'AbortError') return ['warn', 'The screen could not be captured. Close other apps that may be recording the screen, then try again.'];
  return ['warn', 'Screen sharing could not start. Try again, or share a different window or tab.'];
}

// ---------------------------------------------------------------------------------------------
// Meeting

async function meeting(ctx, flow, LK, admission, tracks) {
  const maxHeight = flow.info.video.max_video_height;
  const room = new LK.Room({
    adaptiveStream: true, dynacast: true, disconnectOnPageLeave: true,
    videoCaptureDefaults: { resolution: preset(LK, maxHeight).resolution, ...(tracks.devices?.videoinput ? { deviceId: tracks.devices.videoinput } : {}) },
    audioCaptureDefaults: tracks.devices?.audioinput ? { deviceId: tracks.devices.audioinput } : undefined,
    publishDefaults: { simulcast: true, videoEncoding: preset(LK, maxHeight).encoding, screenShareEncoding: { maxBitrate: 1500000, maxFramerate: 15 }, dtx: true }
  });
  const participantId = admission.participant_id;
  const state = { disposed: false, ended: null, pollTimer: null, host: admission.role === 'host', settling: false, connected: false };
  const remoteAudio = new Map();
  const detachAudio = entry => { entry.track.detach(entry.element); entry.element.remove(); };
  const dispose = () => {
    if (state.disposed) return;
    state.disposed = true;
    clearInterval(state.pollTimer);
    room.removeAllListeners();
    for (const entry of remoteAudio.values()) detachAudio(entry);
    remoteAudio.clear();
    tracks.video?.stop(); tracks.audio?.stop();
    room.disconnect(true).catch(() => {});
    delete document.body.dataset.inMeeting;
  };
  active = { dispose };
  document.body.dataset.inMeeting = '1';
  const shareSupported = Boolean(navigator.mediaDevices?.getDisplayMedia);

  mount(ctx.main, html`<div class="video-room" id="video-room">
    <header class="video-bar"><div class="video-title"><strong>${flow.info.title}</strong><span id="connection" class="connection-chip" data-state="connecting" role="status">Connecting…</span></div>
      ${state.host ? html`<button class="btn btn-small btn-end" type="button" id="end-all">End for everyone</button>` : ''}</header>
    <div id="room-alerts" class="room-alerts" aria-live="assertive"></div>
    <section class="video-stage" aria-label="Participants' video"><div class="video-grid" id="grid"></div></section>
    <div id="remote-audio"></div>
    <aside class="room-panel card" id="people-panel" hidden aria-labelledby="people-heading"><div class="row-between"><h2 id="people-heading">People</h2><button class="btn btn-small" type="button" data-close-panel>Close</button></div><ul class="list" id="people"></ul>
      ${state.host ? html`<button class="btn btn-small" type="button" id="copy-invite">Copy guest link</button>` : ''}</aside>
    <aside class="room-panel card" id="devices-panel" hidden aria-labelledby="devices-heading"><div class="row-between"><h2 id="devices-heading">Devices</h2><button class="btn btn-small" type="button" data-close-panel>Close</button></div>
      <label for="dev-audioinput">Microphone</label><select id="dev-audioinput" data-kind="audioinput"></select>
      <label for="dev-videoinput">Camera</label><select id="dev-videoinput" data-kind="videoinput"></select>
      ${LK.supportsAudioOutputSelection() ? html`<label for="dev-audiooutput">Speaker</label><select id="dev-audiooutput" data-kind="audiooutput"></select>`
        : html`<p class="hint" id="no-output">This browser does not let websites choose a speaker. Use your device's sound settings instead.</p>`}
      <div id="device-message" role="status"></div></aside>
    <nav class="video-controls" aria-label="Meeting controls">
      <button class="btn" type="button" id="enable-audio" hidden>Turn on meeting sound</button>
      <button class="btn" type="button" id="mic" aria-describedby="room-media-state">${MEDIA.microphone(true)}</button>
      <button class="btn" type="button" id="cam" aria-describedby="room-media-state">${MEDIA.camera(true)}</button>
      <button class="btn" type="button" id="share" ${shareSupported ? '' : raw('aria-disabled="true"')}>Share screen</button>
      <button class="btn" type="button" id="devices-toggle" aria-expanded="false" aria-controls="devices-panel">Devices</button>
      <button class="btn" type="button" id="people-toggle" aria-expanded="false" aria-controls="people-panel">People</button>
      <button class="btn btn-leave" type="button" id="leave">Leave</button>
      <span class="visually-hidden" id="room-media-state" role="status"></span>
    </nav></div>`);

  const CONNECTION = { connecting: 'Connecting…', connected: 'Connected', reconnecting: 'Reconnecting…', disconnected: 'Disconnected' };
  const connection = value => { const element = $('#connection'); if (element) { element.dataset.state = value; element.textContent = CONNECTION[value]; } };
  const alertBox = (kind, message) => { const element = $('#room-alerts'); if (element) mount(element, message ? notice(kind, html`<p>${message}</p>`) : ''); };
  const tiles = new Map();
  function tileFor(participant, source = 'camera') {
    const key = participant.identity + ':' + source;
    let tile = tiles.get(key);
    if (!tile) {
      tile = document.createElement('figure');
      tile.className = 'video-tile' + (source === 'screen' ? ' video-tile-screen' : '');
      const video = document.createElement('video');
      video.className = 'video-el' + (participant.isLocal && source === 'camera' ? ' mirrored' : '');
      video.autoplay = true; video.playsInline = true; video.muted = true;
      const placeholder = document.createElement('div');
      placeholder.className = 'video-placeholder';
      const caption = document.createElement('figcaption');
      // Names are participant-supplied: text only, never markup.
      caption.textContent = (participant.name || 'Guest') + (participant.isLocal ? ' (you)' : '') + (source === 'screen' ? ' · screen' : '');
      placeholder.textContent = (participant.name || 'G').slice(0, 1).toUpperCase();
      tile.append(video, placeholder, caption);
      $('#grid')?.append(tile);
      tiles.set(key, tile);
    }
    return tile;
  }
  function refresh() {
    if (state.disposed) return;
    const participants = [room.localParticipant, ...room.remoteParticipants.values()];
    const seen = new Set();
    const heard = new Set();
    for (const participant of participants) {
      if (!participant.isLocal) for (const publication of participant.audioTrackPublications.values()) {
        const track = publication.track;
        if (!track) continue;
        heard.add(publication.trackSid);
        const previous = remoteAudio.get(publication.trackSid);
        if (previous?.track === track) continue;
        if (previous) detachAudio(previous);
        const element = track.attach();
        element.autoplay = true;
        element.muted = false;
        $('#remote-audio')?.append(element);
        remoteAudio.set(publication.trackSid, { track, element });
      }
      const camera = participant.getTrackPublication(LK.Track.Source.Camera);
      const screen = participant.getTrackPublication(LK.Track.Source.ScreenShare);
      const tile = tileFor(participant);
      seen.add(participant.identity + ':camera');
      const video = tile.querySelector('video');
      if (camera?.track && !camera.isMuted) { camera.track.attach(video); tile.classList.remove('video-off'); } else { tile.classList.add('video-off'); if (camera?.track) camera.track.detach(video); }
      tile.classList.toggle('speaking', participant.isSpeaking);
      tile.classList.toggle('muted', !participant.isMicrophoneEnabled);
      if (screen?.track) { const screenTile = tileFor(participant, 'screen'); seen.add(participant.identity + ':screen'); screen.track.attach(screenTile.querySelector('video')); }
    }
    for (const [key, tile] of tiles) if (!seen.has(key)) { tile.querySelectorAll('video').forEach(video => { video.srcObject = null; }); tile.remove(); tiles.delete(key); }
    for (const [key, entry] of remoteAudio) if (!heard.has(key)) { detachAudio(entry); remoteAudio.delete(key); }
    if ($('#enable-audio')) $('#enable-audio').hidden = room.canPlaybackAudio;
    $('#grid')?.setAttribute('data-count', String(Math.min(9, tiles.size)));
    const local = room.localParticipant;
    const label = (selector, text) => { const button = $(selector); if (button && button.textContent !== text) button.textContent = text; };
    label('#mic', MEDIA.microphone(local.isMicrophoneEnabled));
    label('#cam', MEDIA.camera(local.isCameraEnabled));
    label('#share', local.isScreenShareEnabled ? 'Stop sharing' : 'Share screen');
    $('#share')?.classList.toggle('is-active', local.isScreenShareEnabled);
    $('#mic')?.classList.toggle('is-off', !local.isMicrophoneEnabled);
    $('#cam')?.classList.toggle('is-off', !local.isCameraEnabled);
    const media = MEDIA.state(local.isCameraEnabled, local.isMicrophoneEnabled) + (local.isScreenShareEnabled ? ' · Sharing screen' : '');
    if ($('#room-media-state') && $('#room-media-state').textContent !== media) $('#room-media-state').textContent = media;
    drawPeople(participants);
  }
  function drawPeople(participants) {
    const list = $('#people');
    if (!list) return;
    list.replaceChildren(...participants.map(participant => {
      const item = document.createElement('li');
      item.className = 'row-between';
      const label = document.createElement('span');
      label.textContent = (participant.name || 'Guest') + (participant.isLocal ? ' (you)' : '') + (participant.isMicrophoneEnabled ? '' : ' · muted');
      item.append(label);
      if (state.host && !participant.isLocal && state.roster) {
        const row = state.roster.find(entry => entry.identity === participant.identity);
        if (row) {
          const button = document.createElement('button');
          button.className = 'btn btn-small';
          button.type = 'button';
          button.textContent = 'Remove';
          button.setAttribute('aria-label', 'Remove ' + (participant.name || 'guest'));
          button.onclick = async () => {
            if (!(await ask({ title: 'Remove this person?', body: 'They are disconnected now and cannot rejoin this meeting. A guest link they used stops working.', confirm: 'Remove', danger: true }))) return;
            try { await flow.remove(row.id); toast('Removed.'); } catch (error) { toast(error.message); }
          };
          item.append(button);
        }
      }
      return item;
    }));
  }

  // Panels: one at a time; Escape or Close returns focus to the button that opened it.
  const panels = { 'people-panel': '#people-toggle', 'devices-panel': '#devices-toggle' };
  function setPanel(id, open) {
    for (const [panelId, toggle] of Object.entries(panels)) {
      const show = panelId === id && open;
      const panel = $('#' + panelId);
      if (!panel) continue;
      const wasOpen = !panel.hidden;
      panel.hidden = !show;
      $(toggle).setAttribute('aria-expanded', String(show));
      if (show && !wasOpen) panel.querySelector('select, button:not([data-close-panel]), [data-close-panel]')?.focus();
      if (!show && wasOpen && panelId === id) $(toggle).focus();
    }
    if (open && id === 'devices-panel') loadDevices();
  }
  $('#video-room').addEventListener('keydown', event => {
    if (event.key !== 'Escape') return;
    const open = Object.keys(panels).find(id => !$('#' + id).hidden);
    if (open) { event.preventDefault(); setPanel(open, false); }
  });
  $$('[data-close-panel]').forEach(button => button.onclick = () => setPanel(button.closest('.room-panel').id, false));
  $('#people-toggle').onclick = () => setPanel('people-panel', $('#people-panel').hidden);
  $('#devices-toggle').onclick = () => setPanel('devices-panel', $('#devices-panel').hidden);

  // Devices: the SDK switches the active device in place, keeping mute and camera state.
  const KIND_NAMES = { audioinput: 'microphone', videoinput: 'camera', audiooutput: 'speaker' };
  const deviceMessage = (kind, message) => mount($('#device-message'), message ? notice(kind, html`<p>${message}</p>`) : '');
  let known = {};
  async function loadDevices({ announceRemoved = false } = {}) {
    for (const select of $$('#devices-panel select')) {
      const kind = select.dataset.kind;
      let devices = [];
      try { devices = await LK.Room.getLocalDevices(kind, false); } catch { /* permission not granted: defaults only */ }
      if (state.disposed) return;
      const ids = devices.map(device => device.deviceId);
      const activeId = room.getActiveDevice(kind);
      if (announceRemoved && activeId && activeId !== 'default' && known[kind]?.includes(activeId) && !ids.includes(activeId)) {
        alertBox('warn', `Your ${KIND_NAMES[kind]} was disconnected. Choose another one under Devices.`);
      }
      known[kind] = ids;
      fillDevices(select, devices, `Default ${KIND_NAMES[kind]}`);
      if (activeId && ids.includes(activeId) && activeId !== 'default') select.value = activeId;
    }
  }
  $('#devices-panel').addEventListener('change', async event => {
    const kind = event.target.dataset.kind;
    if (!kind) return;
    const id = event.target.value || 'default';
    deviceMessage('', '');
    try {
      const switched = await room.switchActiveDevice(kind, id);
      deviceMessage(switched === false ? 'warn' : 'ok', switched === false ? `The ${KIND_NAMES[kind]} could not be switched. Try another one.` : `Switched ${KIND_NAMES[kind]}.`);
    } catch (error) {
      deviceMessage('warn', kind === 'audiooutput' ? 'This speaker could not be selected. Use your device sound settings instead.' : deviceAdvice(error, KIND_NAMES[kind], { joining: false }));
      await loadDevices();
    }
    refresh();
  });

  function finish(kind, message, { rejoin = false } = {}) {
    if (state.disposed && state.ended) return;
    state.ended = kind;
    dispose();
    active = null;
    if (!ctx.alive()) return;
    const titles = { left: 'You left the meeting', ended: 'The meeting has ended', removed: 'You were removed from the meeting', duplicate: 'You joined from another tab or device', failed: 'You were disconnected', canceled: 'This appointment was canceled' };
    mount(ctx.main, html`<div class="container page narrow"><div class="card video-state" role="status"><h1 tabindex="-1">${titles[kind]}</h1>${message ? html`<p>${message}</p>` : ''}
      <div class="actions">${rejoin ? html`<a class="btn btn-primary" href="${location.pathname}" data-external id="rejoin">Rejoin</a>` : ''}${session.user ? html`<a class="btn" href="/meet?tab=video" data-external>Back to Meet</a>` : ''}</div>
      ${rejoin ? html`<p class="hint">Rejoining checks your access again before you reconnect.</p>` : ''}</div></div>`);
    $('#main h1')?.focus?.();
  }

  // After the provider disconnects us, ask the server what it recorded before naming a cause.
  const ENDED = { host: 'The host ended the meeting for everyone.', time_limit: 'The meeting reached its time limit.', paused: 'Schedora Meet video was paused by the service.', canceled: 'The appointment was canceled.' };
  const REMOVED = { removed_by_host: 'A host removed you from this meeting.', credits_exhausted: "The host's workspace ran out of Meet credits, so your connection was stopped. Contact the host.",
    booking_canceled: 'The appointment was canceled.', booking_rescheduled: 'The appointment was rescheduled. Use the link in your newest confirmation email.' };
  function confirmedOutcome(info) {
    if (!info) return null;
    if (['ended', 'canceled'].includes(info.state) || ['ended', 'ending', 'canceled'].includes(info.status)) return [info.state === 'canceled' ? 'canceled' : 'ended', ENDED[info.end_cause] || 'This meeting has ended.'];
    if (info.you?.status === 'removed') return ['removed', REMOVED[info.you.removed_reason] || 'Your access to this meeting was stopped.'];
    if (['rescheduled', 'revoked'].includes(info.state)) return ['removed', STATES[info.state][1]];
    return null;
  }
  async function settle(reason) {
    if (state.settling || state.disposed) return;
    state.settling = true;
    connection('disconnected');
    const R = LK.DisconnectReason;
    if (reason === R.CLIENT_INITIATED) return finish('left', '', { rejoin: true });
    if (reason === R.DUPLICATE_IDENTITY) return finish('duplicate', 'This tab was disconnected because you joined again elsewhere.', { rejoin: true });
    let info = null;
    try { info = await flow.load(participantId); } catch { /* the server could not be asked */ }
    const confirmed = confirmedOutcome(info);
    if (confirmed) return finish(confirmed[0], confirmed[1]);
    // Without confirmation, removal and room deletion are still final from the provider's side,
    // but no cause is named.
    if (reason === R.PARTICIPANT_REMOVED) return finish('removed', 'The meeting service disconnected you.');
    if (reason === R.ROOM_DELETED) return finish('ended', 'This meeting has ended.');
    finish('failed', 'Your connection to the meeting was lost.', { rejoin: true });
  }

  room
    .on(LK.RoomEvent.AudioPlaybackStatusChanged, refresh)
    .on(LK.RoomEvent.ParticipantConnected, refresh).on(LK.RoomEvent.ParticipantDisconnected, refresh)
    .on(LK.RoomEvent.TrackSubscribed, refresh).on(LK.RoomEvent.TrackUnsubscribed, refresh)
    .on(LK.RoomEvent.TrackMuted, refresh).on(LK.RoomEvent.TrackUnmuted, refresh)
    .on(LK.RoomEvent.LocalTrackPublished, refresh).on(LK.RoomEvent.LocalTrackUnpublished, refresh) // includes screen share stopped from the browser's own control
    .on(LK.RoomEvent.ActiveSpeakersChanged, refresh)
    .on(LK.RoomEvent.MediaDevicesChanged, () => loadDevices({ announceRemoved: true }))
    .on(LK.RoomEvent.Reconnecting, () => { connection('reconnecting'); alertBox('warn', 'Connection interrupted. Reconnecting… You do not need to do anything.'); })
    .on(LK.RoomEvent.Reconnected, () => { connection('connected'); alertBox('', ''); })
    .on(LK.RoomEvent.MediaDevicesError, error => alertBox('warn', deviceAdvice(error, 'camera or microphone', { joining: false })))
    // Before the first successful connection, a failure is reported by connect() below instead.
    .on(LK.RoomEvent.Disconnected, reason => { if (!state.disposed && state.connected) settle(reason); });

  $('#leave').onclick = () => { room.disconnect(true); };
  $('#enable-audio').onclick = async () => {
    try { await room.startAudio(); refresh(); }
    catch { alertBox('warn', 'Meeting sound is blocked. Allow sound for this site in the browser, then try again.'); }
  };
  $('#mic').onclick = async () => { try { await room.localParticipant.setMicrophoneEnabled(!room.localParticipant.isMicrophoneEnabled); } catch (error) { alertBox('warn', deviceAdvice(error, 'microphone', { joining: false })); } refresh(); };
  $('#cam').onclick = async () => { try { await room.localParticipant.setCameraEnabled(!room.localParticipant.isCameraEnabled, { resolution: preset(LK, maxHeight).resolution }); } catch (error) { alertBox('warn', deviceAdvice(error, 'camera', { joining: false })); } refresh(); };
  $('#share').onclick = async () => {
    if (!shareSupported) return alertBox(...shareAdvice(null));
    try { await room.localParticipant.setScreenShareEnabled(!room.localParticipant.isScreenShareEnabled, { audio: true, resolution: { width: 1920, height: Math.min(1080, maxHeight), frameRate: 15 } }); alertBox('', ''); }
    catch (error) { alertBox(...shareAdvice(error)); }
    refresh();
  };
  $('#end-all')?.addEventListener('click', async () => {
    if (!(await ask({ title: 'End the meeting for everyone?', body: 'Everyone is disconnected and the meeting links stop working. To leave without ending it, choose Leave instead.', confirm: 'End meeting for everyone', danger: true }))) return;
    try { await flow.end(); finish('ended', 'You ended the meeting for everyone.'); } catch (error) { toast(error.message); }
  });
  $('#copy-invite')?.addEventListener('click', async () => { try { copy((await flow.invite()).url, 'Guest link'); } catch (error) { toast(error.message); } });

  try {
    await room.connect(admission.url, admission.token, { autoSubscribe: true });
  } catch (error) {
    dispose();
    active = null;
    if (!ctx.alive()) return;
    return stateScreen(ctx, flow.info, 'unreachable', html`<div class="actions"><a class="btn btn-primary" href="${location.pathname}" data-external>Try again</a></div>`);
  }
  admission.token = null; // reconnects use the provider's own refreshed token
  if (state.disposed || !ctx.alive()) { dispose(); return; }
  state.connected = true;
  connection('connected');
  await room.startAudio().catch(() => {});
  try {
    if (tracks.audio) await room.localParticipant.publishTrack(tracks.audio);
    if (tracks.video) await room.localParticipant.publishTrack(tracks.video, { simulcast: true });
  } catch { alertBox('warn', 'Your camera or microphone could not be shared. Use the buttons below to try again.'); }
  tracks.video = tracks.audio = null; // the room owns them now and stops them on disconnect
  refresh();

  // Server state every 30 s: a meeting ended elsewhere, this person's removal, and (hosts) roster and credits.
  const poll = async () => {
    if (state.disposed) return;
    try {
      const info = await flow.load(participantId);
      if (state.disposed) return;
      const confirmed = confirmedOutcome(info);
      if (confirmed) return finish(confirmed[0], confirmed[1]);
      state.roster = info.participants;
      if (info.low_balance) alertBox('warn', 'Meet credits are running low. People will be disconnected when the reserved time runs out.' + (state.host ? ' Recharge from the Plans page.' : ''));
      refresh();
    } catch { /* transient */ }
  };
  state.pollTimer = setInterval(poll, 30000);
  poll();
}

// ---------------------------------------------------------------------------------------------
// Meet dashboard tab: instant meetings and scheduled rooms

export async function videoTab(ctx, panel) {
  if (!boot.video?.enabled) {
    return mount(panel, html`<div class="empty video-unavailable"><h2>Built-in video is not available yet</h2>
      <p>Schedora Meet video rooms are not enabled on this server, so instant meetings and the Schedora Meet location cannot be used. Nothing is charged for video while it is off.</p>
      <p>Your event types can still use Google Meet, Zoom, Microsoft Teams or your own video link.</p>
      <div class="actions"><a class="btn" href="/meet?tab=integrations">Connect a video app</a><a class="btn" href="/meet?tab=types">Review event types</a></div></div>`);
  }
  const scope = ctx.query.get('scope') === 'past' ? 'past' : 'current';
  const rooms = await api('GET', wsPath('/meet-video/rooms?scope=' + scope));
  if (!ctx.alive()) return;
  mount(panel, html`<div class="row-between">
      <form id="instant" class="row" novalidate><label class="visually-hidden" for="instant-title">Meeting title</label><input id="instant-title" name="title" maxlength="120" placeholder="Instant meeting"><button class="btn btn-primary" type="submit">Start a meeting now</button></form>
      <nav class="row" aria-label="Meeting rooms">${[['current', 'Current and upcoming'], ['past', 'Past']].map(([key, label]) => html`<a class="btn btn-small ${key === scope ? 'btn-primary' : ''}" href="/meet?tab=video&scope=${key}">${label}</a>`)}</nav></div>
    <p class="hint">Instant and scheduled Schedora Meet rooms use your workspace's Meet credits for every connected person, including hosts.</p>
    ${rooms.length ? html`<ul class="list section-gap">${rooms.map(room => html`<li class="row-between"><div><div class="list-title">${room.title}</div>
      <div class="meta"><span>${room.kind === 'instant' ? 'Instant' : 'Scheduled'}</span>${room.starts_at ? html`<span>${fmtDateTime(room.starts_at)}</span>` : ''}<span>${badge(room.status === 'open' ? 'active' : room.status, room.status)}</span>${room.low_balance ? html`<span>Low credits</span>` : ''}</div></div>
      ${scope === 'current' ? html`<div class="row"><a class="btn btn-small btn-primary" href="${room.host_url}" data-external>Join</a><button class="btn btn-small" data-invite="${room.public_id}">Copy guest link</button><button class="btn btn-small btn-danger" data-end="${room.public_id}">End</button></div>` : ''}</li>`)}</ul>`
      : html`<div class="empty section-gap">${scope === 'past' ? 'No past video meetings.' : 'No open video meetings. Start one now, or add Schedora Meet as the location of an event type.'}</div>`}`);
  $('#instant').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const room = await api('POST', wsPath('/meet-video/rooms'), { title: $('#instant-title').value.trim() || undefined });
      location.assign(room.host_url); // full page load: only meeting pages get camera access
    } catch (error) { toast(error.message); }
  });
  $$('[data-invite]', panel).forEach(button => button.onclick = async () => {
    try { copy((await api('POST', `/api/meet-video/rooms/${button.dataset.invite}/invites`, { seats: 5 })).url, 'Guest link'); } catch (error) { toast(error.message); }
  });
  $$('[data-end]', panel).forEach(button => button.onclick = async () => {
    if (!(await ask({ title: 'End this meeting?', body: 'Everyone is disconnected and its links stop working.', confirm: 'End meeting', danger: true }))) return;
    try { await api('POST', `/api/meet-video/rooms/${button.dataset.end}/end`); toast('Meeting ended.'); ctx.render(); } catch (error) { toast(error.message); }
  });
}

// ---------------------------------------------------------------------------------------------
// Billing page: Meet credits

export async function creditsSection(ctx, container) {
  let data;
  try { data = await api('GET', wsPath('/meet-video/wallet')); }
  catch (error) { return mount(container, errorBlock(error)); }
  if (!ctx.alive()) return;
  const owner = data.role === 'owner';
  const { wallet, catalog } = data;
  const focus = ctx.query.get('recharge');
  mount(container, html`<section class="card card-plain" aria-labelledby="credits-title"><h2 id="credits-title">Meet video credits</h2>
    <p>1 credit = 1 participant-minute of connected time in Schedora Meet video, including hosts. ${data.policy.spending_order}</p>
    ${wallet.low_balance ? notice('warn', html`<p><strong>Low balance.</strong> Each person needs credits reserved before joining a video meeting, and people are removed when reserved time runs out.</p>`) : ''}
    ${wallet.restricted_reason ? notice('bad', html`<p>Credit purchases are on hold for this workspace (${wallet.restricted_reason.replace(/_/g, ' ')}). Contact support.</p>`) : ''}
    <div class="grid-3 credit-cards">
      <div class="card"><h3>Subscription credits</h3><p class="credit-figure">${wallet.subscription.credits}</p><p class="hint">${wallet.subscription.resets_at ? `Reset ${fmtDateTime(wallet.subscription.resets_at)}. Unused credits expire.` : 'No monthly allowance for this workspace right now.'}</p></div>
      <div class="card"><h3>Purchased credits</h3><p class="credit-figure">${wallet.purchased.credits}</p><p class="hint">Carry forward. No automatic expiry.</p></div>
      <div class="card"><h3>Available now</h3><p class="credit-figure">${wallet.spendable.credits}</p><p class="hint">${wallet.reserved.credits} reserved for meetings in progress. Used this month: ${data.usage_this_month.credits}.</p></div>
    </div>
    <h3 class="section-gap">Estimate a meeting</h3>
    <form id="calculator" class="inline-fields" novalidate>
      <div><label for="calc-people">People (including hosts)</label><input id="calc-people" name="participants" type="number" min="1" max="100" value="4" required></div>
      <div><label for="calc-minutes">Minutes</label><input id="calc-minutes" name="minutes" type="number" min="1" max="1440" value="30" required></div>
      <div class="actions"><button class="btn" type="submit">Estimate</button></div>
    </form>
    <div id="calc-result" aria-live="polite"></div>
    <h3 class="section-gap">Buy credits</h3>
    ${catalog.packages.length ? html`<div class="grid-3">${catalog.packages.map(pack => html`<div class="card"><h4>${pack.name}</h4><p><strong>${pack.credits.toLocaleString()} credits</strong><br>${inr(pack.amount_minor, pack.currency)}</p>
      ${pack.fixture ? html`<p class="hint">Development fixture: simulated payment, not a real price.</p>` : ''}
      ${owner ? html`<button class="btn ${pack.checkout_available ? 'btn-primary' : ''}" data-buy="${pack.id}" ${pack.checkout_available && !wallet.restricted_reason ? '' : raw('disabled')}>Buy ${pack.credits.toLocaleString()} credits</button>` : ''}</div>`)}</div>
      ${catalog.packages.some(pack => pack.checkout_available) ? '' : notice('info', html`<p>Credit purchases are being set up. No payment can be taken yet.</p>`)}`
      : notice('info', html`<p>Credit packs are not available yet.</p>`)}
    ${!owner ? html`<p class="hint">Only the workspace owner can buy credits.</p>` : ''}
    ${data.recharges.length ? html`<h3 class="section-gap">Purchases</h3><ul class="list">${data.recharges.map(order => html`<li class="row-between ${order.id === focus ? 'highlight' : ''}"><div><div class="list-title">${order.credits.toLocaleString()} credits · ${inr(order.amount_minor, order.currency)}</div>
      <div class="meta"><span>${fmtDateTime(order.created_at)}</span>${order.uncollectable_credits ? html`<span>${order.uncollectable_credits} credits already used before reversal</span>` : ''}</div></div>
      <div class="row">${badge(order.status === 'paid' ? 'active' : ['open', 'creating', 'uncertain'].includes(order.status) ? 'pending' : 'canceled', order.status.replace(/_/g, ' '))}
        ${owner && order.status === 'open' && order.provider === 'razorpay' && order.checkout_url ? html`<a class="btn btn-small btn-primary" href="${order.checkout_url}" data-external>Continue payment</a>` : ''}
        ${owner && ['open', 'uncertain'].includes(order.status) && order.provider === 'razorpay' ? html`<button class="btn btn-small" data-refresh="${order.id}">Check payment</button>` : ''}
        ${owner && order.provider === 'test' && order.status === 'open' ? html`<button class="btn btn-small" data-test-pay="${order.id}">Simulate payment</button>` : ''}</div></li>`)}</ul>` : ''}
    <h3 class="section-gap">Recent usage</h3><div id="usage">${loading()}</div>
    <h3 class="section-gap">Credit history</h3><div class="table-wrap"><table><caption class="visually-hidden">Credit ledger</caption><thead><tr><th scope="col">Date</th><th scope="col">Entry</th><th scope="col">Credits</th><th scope="col">Details</th></tr></thead><tbody id="ledger"></tbody></table></div>
    <button class="btn btn-small" id="ledger-more" hidden>Show older entries</button>
  </section>`);

  $('#calculator').addEventListener('submit', async event => {
    event.preventDefault();
    try {
      const result = await api('GET', wsPath(`/meet-video/calculator?participants=${encodeURIComponent($('#calc-people').value)}&minutes=${encodeURIComponent($('#calc-minutes').value)}`));
      mount($('#calc-result'), notice(result.shortfall_credits ? 'warn' : 'ok', html`<p><strong>${result.participant_minutes.toLocaleString()} participant-minutes ≈ ${result.credits_required.toLocaleString()} credits.</strong> Available: ${result.available_credits.toLocaleString()}.
        ${result.shortfall_credits ? html`Short by ${result.shortfall_credits.toLocaleString()} credits${result.suggested_package ? html` (suggested: ${catalog.packages.find(pack => pack.id === result.suggested_package)?.name || result.suggested_package})` : ''}.` : 'Enough credits.'}</p>
        <p class="hint">${result.note} Each person also needs the next ${result.admission_buffer_credits} credits reserved before joining.</p>`));
    } catch (error) { mount($('#calc-result'), errorBlock(error)); }
  });
  $$('[data-buy]', container).forEach(button => {
    const key = crypto.randomUUID();
    button.onclick = async () => {
      button.disabled = true;
      try {
        const order = await api('POST', wsPath('/meet-video/recharges'), { package_id: button.dataset.buy }, { 'Idempotency-Key': key });
        if (order.provider === 'razorpay' && order.checkout_url) { location.assign(order.checkout_url); return; }
        toast('Purchase created.'); ctx.render();
      } catch (error) { toast(error.message); button.disabled = false; }
    };
  });
  $$('[data-refresh]', container).forEach(button => button.onclick = async () => {
    try { const result = await api('POST', wsPath(`/meet-video/recharges/${button.dataset.refresh}/refresh`)); toast(result.result === 'granted' ? 'Payment confirmed. Credits added.' : 'Payment status: ' + result.order.status.replace(/_/g, ' ')); ctx.render(); } catch (error) { toast(error.message); }
  });
  $$('[data-test-pay]', container).forEach(button => button.onclick = async () => {
    try { await api('POST', wsPath(`/meet-video/recharges/${button.dataset.testPay}/test-event`), { action: 'pay' }); toast('Simulated payment confirmed. Credits added.'); ctx.render(); } catch (error) { toast(error.message); }
  });
  // Returning from Razorpay: the redirect proves nothing, so ask the server to verify with Razorpay.
  if (focus && owner && data.recharges.some(order => order.id === focus && ['open', 'uncertain'].includes(order.status) && order.provider === 'razorpay')) {
    api('POST', wsPath(`/meet-video/recharges/${encodeURIComponent(focus)}/refresh`)).then(result => { if (result.result === 'granted' && ctx.alive()) { toast('Payment confirmed. Credits added.'); ctx.render(); } }).catch(() => {});
  }

  const entryLabels = { grant: 'Added', expire: 'Expired', reserve: 'Reserved', release: 'Released', consume: 'Used', refund: 'Refunded', reversal: 'Reversed', adjustment: 'Adjustment' };
  let cursor = null;
  async function loadLedger() {
    const page = await api('GET', wsPath('/meet-video/wallet/ledger?limit=25' + (cursor ? '&before=' + encodeURIComponent(cursor) : '')));
    if (!ctx.alive()) return;
    $('#ledger').insertAdjacentHTML('beforeend', String(html`${page.entries.map(entry => html`<tr><td>${fmtDateTime(entry.created_at)}</td><td>${entryLabels[entry.entry_type] || entry.entry_type}</td>
      <td>${entry.units ? (entry.units > 0 ? '+' : '') + credits(entry.units) : entry.held_delta ? `(${entry.held_delta > 0 ? '+' : ''}${credits(entry.held_delta)} held)` : '0'}</td><td>${entry.note || entry.reference_type?.replace(/_/g, ' ') || ''}</td></tr>`)}`));
    cursor = page.next;
    $('#ledger-more').hidden = !cursor;
  }
  $('#ledger-more').onclick = () => loadLedger().catch(error => toast(error.message));
  loadLedger().catch(error => mount($('#ledger'), html`<tr><td colspan="4">${error.message}</td></tr>`));
  api('GET', wsPath('/meet-video/wallet/usage')).then(rows => {
    if (!ctx.alive()) return;
    mount($('#usage'), rows.length ? html`<ul class="list">${rows.slice(0, 20).map(row => html`<li class="row-between"><div><div class="list-title">${row.room_title || 'Meeting'}</div><div class="meta"><span>${row.display_name || 'Participant'}${row.role === 'host' ? ' (host)' : ''}</span><span>${fmtDateTime(row.period_from)}</span><span>${Math.round(row.connected_ms / 60000)} min connected</span></div></div>
      <span>${credits(row.units_charged)} credits</span></li>`)}</ul>` : html`<p class="muted">No video usage yet.</p>`);
  }).catch(() => {});
}
