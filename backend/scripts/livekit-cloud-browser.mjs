import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { client, signUp } from '../test/helpers.mjs';

if (process.env.RUN_LIVEKIT_STAGING !== 'true') throw new Error('Set RUN_LIVEKIT_STAGING=true and start scripts/livekit-staging.mjs first.');
const base = 'http://localhost:3100';
const config = await (await fetch(base + '/api/config')).json();
assert.equal(config.video?.enabled, true, 'The isolated staging backend must enable video.');
const binary = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(path => path && existsSync(path));
assert.ok(binary, 'Chrome is required.');
const profile = mkdtempSync(join(tmpdir(), 'schedora-cloud-media-'));
const port = 9500 + Math.floor(Math.random() * 400);
const browser = spawn(binary, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', 'about:blank'], { stdio: 'ignore', windowsHide: true });
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const pages = [];
const steps = [];
let roomId;
const http = client(base);

async function connect(target) {
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', ({ data }) => {
    const result = JSON.parse(data);
    const operation = pending.get(result.id);
    if (!operation) return;
    pending.delete(result.id);
    clearTimeout(operation.timer);
    result.error ? operation.reject(new Error(result.error.message)) : operation.resolve(result.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timed out')); }, 25000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const wait = async (expression, message, timeout = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) { if (await evaluate(`Boolean(${expression})`)) return; await pause(200); }
    throw new Error(message);
  };
  const open = async (path, selector) => { await send('Page.navigate', { url: new URL(path, base).href }); await wait(`document.readyState === 'complete' && document.querySelector(${JSON.stringify(selector)})`, 'Page did not load: ' + selector); };
  const fill = (selector, value) => evaluate(`(() => {const element=document.querySelector(${JSON.stringify(selector)});element.value=${JSON.stringify(value)};element.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    window.__smokePeers=[];
    const OriginalPeer=window.RTCPeerConnection;
    window.RTCPeerConnection=class extends OriginalPeer{constructor(...args){super(...args);window.__smokePeers.push(this)}};
    // Test-only synthetic display: never capture the user's desktop.
    navigator.mediaDevices.getDisplayMedia=async()=>{
      const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;
      const context=canvas.getContext('2d');
      const timer=setInterval(()=>{context.fillStyle='#452a89';context.fillRect(0,0,640,360);context.fillStyle='white';context.font='24px sans-serif';context.fillText('Synthetic screen '+Date.now(),20,100)},100);
      const stream=canvas.captureStream(10);
      stream.getVideoTracks()[0].addEventListener('ended',()=>clearInterval(timer));
      window.__smokeScreen=stream;
      return stream;
    };
  ` });
  const page = { socket, send, evaluate, wait, open, fill, click };
  pages.push(page);
  return page;
}

async function mediaStats(page) {
  return page.evaluate("(async()=>{const totals={audioBytes:0,videoBytes:0,videoFrames:0};for(const peer of window.__smokePeers||[])for(const row of (await peer.getStats()).values())if(row.type==='inbound-rtp'&&!row.isRemote){if(row.kind==='audio')totals.audioBytes+=row.bytesReceived||0;if(row.kind==='video'){totals.videoBytes+=row.bytesReceived||0;totals.videoFrames+=row.framesDecoded||0}}return totals})()");
}

try {
  let targets;
  for (let attempt = 0; attempt < 50; attempt++) {
    try { targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); if (targets.some(target => target.type === 'page')) break; } catch {}
    await pause(200);
  }
  assert.ok(targets?.some(target => target.type === 'page'), 'Headless Chrome did not start.');
  const host = await connect(targets.find(target => target.type === 'page'));
  const emailName = 'CloudSmoke' + Date.now();
  const account = await signUp(http, emailName);
  await host.open('/account?next=/meet', '#signin');
  await host.fill('#signin [name=email]', account.email);
  await host.fill('#signin [name=password]', 'a sufficiently long password');
  await host.click('#signin [type=submit]');
  await host.wait("location.pathname==='/meet' && document.querySelector('.tabs')", 'Host login failed.');
  await host.open('/meet?tab=video', '#instant');
  await host.fill('#instant-title', 'Synthetic media Cloud acceptance');
  await host.click('#instant [type=submit]');
  await host.wait("document.querySelector('#join-form')", 'Host prejoin failed.');
  roomId = await host.evaluate("location.pathname.split('/').at(-1)");
  await host.wait("document.querySelector('#preview')?.srcObject?.getVideoTracks()[0]?.readyState==='live'", 'Synthetic camera preview failed.');
  await host.click('#join-button');
  await host.wait("document.querySelector('#connection')?.innerText==='Connected'", 'Host could not connect to Cloud.');
  const invite = await http.post(`/api/meet-video/rooms/${roomId}/invites`, { seats: 1 });
  assert.equal(invite.status, 201);
  const newTarget = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const guest = await connect(newTarget);
  await guest.open(invite.body.url, '#join-form');
  await guest.fill('#display-name', 'Synthetic Cloud Guest');
  await guest.wait("document.querySelector('#preview')?.srcObject?.getVideoTracks()[0]?.readyState==='live'", 'Guest camera preview failed.');
  await guest.click('#join-button');
  await guest.wait("document.querySelector('#connection')?.innerText==='Connected'", 'Guest could not connect to Cloud.');
  for (const page of [host, guest]) {
    await page.wait("document.querySelector('#grid .video-el:not(.mirrored)')?.videoWidth>0", 'Remote video was not decoded.');
    await page.wait("[...document.querySelectorAll('#remote-audio audio')].some(audio=>!audio.muted&&!audio.paused&&audio.srcObject?.getAudioTracks().some(track=>track.readyState==='live'))", 'Remote audio was not playing.');
  }
  await pause(2500);
  const received = await Promise.all([mediaStats(host), mediaStats(guest)]);
  for (const stats of received) { assert.ok(stats.audioBytes > 0, 'No incoming audio bytes.'); assert.ok(stats.videoBytes > 0 && stats.videoFrames > 0, 'No incoming decoded video.'); }
  steps.push({ check: 'Two-way synthetic audio/video over real LiveKit Cloud', received });
  await host.click('#mic');
  await host.wait("document.querySelector('#mic').textContent==='Unmute'", 'Mute failed.');
  await host.click('#mic');
  await host.wait("document.querySelector('#mic').textContent==='Mute'", 'Unmute failed.');
  await host.click('#cam');
  await host.wait("document.querySelector('#cam').textContent==='Start video'", 'Camera off failed.');
  await host.click('#cam');
  await host.wait("document.querySelector('#cam').textContent==='Stop video'", 'Camera on failed.');
  steps.push({ check: 'Microphone and camera controls', passed: true });
  await host.click('#share');
  await guest.wait("[...document.querySelectorAll('#grid video')].filter(video=>video.videoWidth>0).length>=3", 'Synthetic screen was not decoded by the guest.');
  await host.click('#share');
  await guest.wait("document.querySelectorAll('#grid video').length===2", 'Screen share did not stop.');
  steps.push({ check: 'Synthetic screen publish, remote decoding and stop over Cloud', passed: true });
  const beforeReconnect = await mediaStats(guest);
  await guest.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 });
  await pause(4000);
  await guest.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  await guest.wait("document.querySelector('#connection')?.innerText==='Connected'", 'Guest did not recover after the network interruption.', 45000);
  await pause(2500);
  const afterReconnect = await mediaStats(guest);
  assert.ok(afterReconnect.videoFrames > beforeReconnect.videoFrames, 'Video did not resume after the network interruption.');
  steps.push({ check: 'Network interruption recovery and resumed media', passed: true });
  const room = await http.get(`/api/meet-video/rooms/${roomId}`);
  const guestRow = room.body.participants.find(participant => participant.principal === 'guest');
  assert.ok(guestRow, 'Guest was not present in the server roster.');
  assert.equal((await http.post(`/api/meet-video/rooms/${roomId}/participants/${guestRow.id}/remove`)).status, 204);
  await guest.wait("document.body.innerText.includes('You were removed')", 'Cloud participant removal did not disconnect the guest.');
  await guest.open(invite.body.url, '#main h1');
  await guest.wait("document.body.innerText.includes('no longer valid')", 'Removed guest link was not revoked.');
  steps.push({ check: 'Cloud participant removal and rejected guest rejoin', passed: true });
  await host.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const screenshot = await host.send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(new URL('../data/livekit-cloud-media-smoke.png', import.meta.url), Buffer.from(screenshot.data, 'base64'));
  assert.equal((await http.post(`/api/meet-video/rooms/${roomId}/end`)).status, 204);
  await host.wait("document.body.innerText.includes('meeting has ended')", 'Host end state did not appear.', 40000);
  steps.push({ check: 'Cloud room termination', passed: true });
  const report = { at: new Date().toISOString(), provider: 'LiveKit Cloud', media: 'Chrome synthetic camera and microphone', steps, productionApproved: false };
  writeFileSync(new URL('../data/livekit-cloud-media-smoke.json', import.meta.url), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} finally {
  if (roomId) await http.post(`/api/meet-video/rooms/${roomId}/end`).catch(() => {});
  for (const page of pages) page.socket.close();
  browser.kill();
  try { rmSync(profile, { recursive: true, force: true }); } catch {}
}
