/* mobile-quirks.js — handle Safari-on-iOS quirks for phone sessions.

   Two issues this addresses:

   1. AudioContext suspension after backgrounding.
      iOS Safari pauses (or suspends) the AudioContext when the page
      goes to the background or the tab loses focus. When the user
      returns, server-TTS playback fails silently because the context
      is in 'suspended' state. We resume it on visibilitychange and
      defensively at the top of decodeAndPlay.

   2. Socket.IO connection going stale while backgrounded.
      Long background periods on iOS cause the WebSocket to drop, and
      auto-reconnect timers can be paused with the page. When the user
      foregrounds again, the socket may report `connected: true` but be
      effectively dead. We force a reconnect cycle on visibility so the
      session resumes responsively. */

import { state, socket } from './state.js';

function resumeAudioContextIfSuspended() {
    var ctx = state.audioContext;
    if (!ctx) return;
    if (ctx.state === 'suspended') {
        ctx.resume().catch(function () { /* user-gesture rules — ignore */ });
    }
}

function reconnectSocketIfStale() {
    if (!socket) return;
    // socket.connected is the Socket.IO-level flag; .io.engine is the
    // underlying transport. We check both — a transport in 'closed' state
    // with a stale connected=true is the iOS-after-background failure mode.
    var engineState = socket.io && socket.io.engine && socket.io.engine.readyState;
    var transportDead = engineState === 'closed' || engineState === 'closing';
    if (!socket.connected || transportDead) {
        try {
            socket.connect();
        } catch (_e) { /* socket.io handles retries internally */ }
    }
}

export function initMobileQuirks() {
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState !== 'visible') return;
        resumeAudioContextIfSuspended();
        reconnectSocketIfStale();
    });

    // pageshow fires when restoring from the bfcache (back/forward nav on
    // iOS). visibilitychange may not fire in that path, so cover it too.
    window.addEventListener('pageshow', function (e) {
        if (!e.persisted) return;
        resumeAudioContextIfSuspended();
        reconnectSocketIfStale();
    });

    // Some iOS versions suspend the context after a barge-in / TTS cancel
    // even while foregrounded. A periodic nudge while voice is active is
    // cheap insurance — `resume()` on an already-running context is a no-op.
    setInterval(resumeAudioContextIfSuspended, 5000);
}
