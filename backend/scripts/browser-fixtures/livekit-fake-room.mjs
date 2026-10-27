// Browser-check fixture only: served in place of /vendor/livekit-client.esm.mjs through DevTools
// request interception, never by the application. It re-exports the real SDK (devices, tracks,
// analyser, presets, events) and replaces Room with a scriptable stand-in, so the meeting room UI
// can be exercised without a media server. Nothing here verifies real media or provider behaviour.
import * as Real from '/vendor/livekit-client.esm.mjs?real';
export * from '/vendor/livekit-client.esm.mjs?real';

const { RoomEvent, DisconnectReason, Track } = Real;

function participant({ identity, name, isLocal = false }) {
  const publications = new Map();
  return {
    identity, name, isLocal, isSpeaking: false, publications,
    audioTrackPublications: new Map(),
    get isMicrophoneEnabled() { const pub = publications.get(Track.Source.Microphone); return Boolean(pub && !pub.isMuted); },
    get isCameraEnabled() { const pub = publications.get(Track.Source.Camera); return Boolean(pub && !pub.isMuted); },
    get isScreenShareEnabled() { return publications.has(Track.Source.ScreenShare); },
    getTrackPublication(source) { return publications.get(source); }
  };
}

export class Room {
  static getLocalDevices(...args) { return Real.Room.getLocalDevices(...args); }
  constructor(options) {
    this.options = options;
    this.handlers = new Map();
    this.remoteParticipants = new Map();
    this.canPlaybackAudio = true;
    this.activeDevices = {};
    const room = this;
    const local = participant({ identity: 'local', name: 'You', isLocal: true });
    const toggle = async (source, enabled, create) => {
      let pub = local.publications.get(source);
      if (!pub && enabled) { pub = { track: await create(), isMuted: false }; local.publications.set(source, pub); }
      if (pub) pub.isMuted = !enabled;
      room.emit(enabled ? RoomEvent.TrackUnmuted : RoomEvent.TrackMuted);
    };
    Object.assign(local, {
      async publishTrack(track) { local.publications.set(track.kind === 'video' ? Track.Source.Camera : Track.Source.Microphone, { track, isMuted: false }); room.emit(RoomEvent.LocalTrackPublished); },
      setMicrophoneEnabled: enabled => toggle(Track.Source.Microphone, enabled, () => Real.createLocalAudioTrack()),
      setCameraEnabled: enabled => toggle(Track.Source.Camera, enabled, () => Real.createLocalVideoTrack()),
      async setScreenShareEnabled(enabled) {
        if (enabled && window.__fakeShareError) throw new DOMException(window.__fakeShareError.message, window.__fakeShareError.name);
        if (enabled) local.publications.set(Track.Source.ScreenShare, { track: null, isMuted: false }); else local.publications.delete(Track.Source.ScreenShare);
        room.emit(enabled ? RoomEvent.LocalTrackPublished : RoomEvent.LocalTrackUnpublished);
      }
    });
    this.localParticipant = local;
    window.__fakeRoom = this;
    window.__fakeSwitches = [];
  }
  on(event, handler) { if (!this.handlers.has(event)) this.handlers.set(event, []); this.handlers.get(event).push(handler); return this; }
  removeAllListeners() { this.handlers.clear(); return this; }
  emit(event, ...args) { for (const handler of this.handlers.get(event) || []) handler(...args); }
  async connect(url, token) { this.connected = Boolean(url && token); }
  async startAudio() {}
  async disconnect() {
    for (const pub of this.localParticipant.publications.values()) pub.track?.stop?.();
    this.localParticipant.publications.clear();
    this.emit(RoomEvent.Disconnected, DisconnectReason.CLIENT_INITIATED);
  }
  getActiveDevice(kind) { return this.activeDevices[kind]; }
  async switchActiveDevice(kind, deviceId) {
    window.__fakeSwitches.push([kind, deviceId, this.localParticipant.isMicrophoneEnabled, this.localParticipant.isCameraEnabled]);
    if (deviceId === 'fail') throw new DOMException('Could not start', 'NotReadableError');
    this.activeDevices[kind] = deviceId;
    return true;
  }
  // Test hooks.
  addRemote(name) { const remote = participant({ identity: 'remote-' + name, name }); this.remoteParticipants.set(remote.identity, remote); this.emit(RoomEvent.ParticipantConnected, remote); }
  drop(reasonName) { this.emit(RoomEvent.Disconnected, DisconnectReason[reasonName]); }
}
