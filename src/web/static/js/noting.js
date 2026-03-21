/* noting.js — round-robin noting circle orchestrator.
 *
 * Manages the turn-based flow: User → P1 → P2 → ... → User.
 * Client-side timers drive the circle; server handles LLM + TTS calls.
 */

import { state, dom, socket } from './state.js';
import { addMessage } from './ui.js';
import { playServerAudio, speakBrowser, stopServerAudio } from './tts.js';

var notingState = {
    active: false,
    paused: false,       // true when mic is muted
    participants: [],    // from setup config
    userTurnCue: false,
    userTurnCueSound: null,  // short name of sound for user turn cue
    turnOrder: [],       // ['user', 0, 1, 2, ...] indices into participants
    currentTurn: -1,
    recentLabels: [],    // last N labels for reactive context
    userTurnStart: 0,
    userCadences: [],    // rolling window of user turn durations (ms)
    defaultCadenceMs: 4000,
    waitTimer: null,
    audioContext: null,
    awaitingUser: false, // true when it's the user's turn
    sendTextFn: null,    // injected from session.js
    soundBuffers: {},    // name -> AudioBuffer cache
    _pendingSounds: [],  // sound names to preload once AudioContext exists
    _serverTimeout: null, // timeout handle for server response watchdog
    _mutePoller: null,   // interval handle for mic mute detection
};

// Expose for socket handlers
export { notingState };

function participantName(index) {
    var p = notingState.participants[index];
    if (!p) return 'Participant';
    if (p.type === 'sound') {
        var snd = p.sound || 'sound';
        return snd.charAt(0).toUpperCase() + snd.slice(1);
    }
    if (p.voice) {
        // Strip qualifier like "(Premium)" from voice name
        return p.voice.replace(/\s*\(.*\)$/, '');
    }
    return 'Participant ' + (index + 1);
}

export function initNoting(participants, userTurnCue, sendTextFn, userTurnCueSound) {
    notingState.participants = participants || [];
    notingState.userTurnCue = userTurnCue || false;
    notingState.userTurnCueSound = userTurnCueSound || null;
    notingState.sendTextFn = sendTextFn;
    notingState.active = true;
    notingState.paused = false;
    notingState.recentLabels = [];
    notingState.userCadences = [];
    notingState.currentTurn = -1;
    notingState.soundBuffers = {};

    // Build turn order: user, then each participant index
    notingState.turnOrder = ['user'];
    for (var i = 0; i < notingState.participants.length; i++) {
        notingState.turnOrder.push(i);
    }

    // Audio context for turn cue sound (may be null here — sounds
    // are preloaded lazily in startCircle once AudioContext exists)
    notingState.audioContext = state.audioContext || null;

    // Collect sound names to preload (actual loading deferred to startCircle)
    notingState._pendingSounds = [];
    if (notingState.userTurnCueSound) notingState._pendingSounds.push(notingState.userTurnCueSound);
    for (var j = 0; j < notingState.participants.length; j++) {
        if (notingState.participants[j].type === 'sound' && notingState.participants[j].sound) {
            notingState._pendingSounds.push(notingState.participants[j].sound);
        }
    }

    // Try preloading now (will succeed if AudioContext already exists)
    notingState._pendingSounds.forEach(function (name) {
        preloadSound(name);
    });

    // Listen for noting responses from server
    socket.on('noting_label', handleNotingLabel);
    socket.on('noting_audio', handleNotingAudio);

    // Pause/resume when mic is muted/unmuted.
    // Poll voiceActive state — catches all mute paths (button, voice command, etc.)
    notingState._mutePoller = setInterval(function () {
        if (!notingState.active) return;
        if (!state.voiceActive && !notingState.paused) {
            pauseCircle();
        } else if (state.voiceActive && notingState.paused) {
            resumeCircle();
        }
    }, 500);
}

export function startCircle() {
    if (!notingState.active) return;

    // AudioContext now exists — pick it up and preload any sounds that
    // failed earlier (initNoting runs before activateVoice creates it).
    notingState.audioContext = state.audioContext || notingState.audioContext;
    if (notingState._pendingSounds) {
        notingState._pendingSounds.forEach(function (name) {
            preloadSound(name);
        });
    }

    advanceTurn();
}

export function stopCircle() {
    notingState.active = false;
    notingState.paused = false;
    clearServerTimeout();
    if (notingState.waitTimer) {
        clearTimeout(notingState.waitTimer);
        notingState.waitTimer = null;
    }
    if (notingState._mutePoller) {
        clearInterval(notingState._mutePoller);
        notingState._mutePoller = null;
    }
    socket.off('noting_label', handleNotingLabel);
    socket.off('noting_audio', handleNotingAudio);
}

export function pauseCircle() {
    if (!notingState.active || notingState.paused) return;
    notingState.paused = true;
    notingState.awaitingUser = false;
    if (notingState.waitTimer) {
        clearTimeout(notingState.waitTimer);
        notingState.waitTimer = null;
    }
    stopServerAudio();
}

export function resumeCircle() {
    if (!notingState.active || !notingState.paused) return;
    notingState.paused = false;
    // Restart from the current turn position
    var turn = notingState.turnOrder[notingState.currentTurn];
    if (turn === 'user') {
        startUserTurn();
    } else {
        startParticipantTurn(turn);
    }
}

// Called by audio.js/session.js when user speaks during their turn
export function handleUserNote(text) {
    if (!notingState.awaitingUser || !notingState.active) return false;

    // Reject transcriptions arriving too quickly after turn start — these
    // are echo from the previous participant's audio, not real user speech.
    // Real notes need: ~0.5s think + ~0.5s speech + ~1s silence + ~0.5s STT ≈ 2.5s+
    var timeSinceTurnStart = Date.now() - notingState.userTurnStart;
    if (timeSinceTurnStart < 2000) return false;

    notingState.awaitingUser = false;

    // Record cadence
    var elapsed = Date.now() - notingState.userTurnStart;
    notingState.userCadences.push(elapsed);
    if (notingState.userCadences.length > 5) notingState.userCadences.shift();

    notingState.recentLabels.push(text);
    if (notingState.recentLabels.length > 16) notingState.recentLabels.shift();

    addMessage('user', text, false, 'You');

    // Save to session history for transcript
    socket.emit('noting_user_note', { text: text, name: 'You' });

    // Wait briefly then advance
    scheduleNextTurn(500);
    return true;
}

function advanceTurn() {
    if (!notingState.active || notingState.paused) return;

    notingState.currentTurn = (notingState.currentTurn + 1) % notingState.turnOrder.length;
    var turn = notingState.turnOrder[notingState.currentTurn];

    if (turn === 'user') {
        startUserTurn();
    } else {
        startParticipantTurn(turn);
    }
}

var USER_TURN_DELAY = 1000; // pause before user turn cue to let circle breathe

function startUserTurn() {
    if (notingState.paused) return;

    // Reset VAD state so stale audio from participant turns (AI TTS echo,
    // sound effects leaking through the mic) doesn't get transcribed as
    // user speech.  All VAD fields live on the shared state object.
    state.audioChunks = [];
    state.vadState = 'silence';
    state.speechStartTime = 0;
    state.lastSpeechTime = 0;
    state.preBuffer = [];
    state.speculativeSent = false;
    state.speculativeText = null;
    state.awaitingSpeculative = false;
    state.pendingTranscriptions = 0;

    // Accept speech immediately (especially important for the first turn
    // after the opener, where there's already a natural pause).
    notingState.awaitingUser = true;
    notingState.userTurnStart = Date.now();

    // Brief pause before the turn cue sound — prevents the cue from
    // feeling rushed after the previous participant.  On the very first
    // turn (no cadence data yet) skip the delay since the opener gap
    // already provides breathing room.
    var cueDelay = notingState.userCadences.length === 0 ? 0 : USER_TURN_DELAY;

    if (notingState.userTurnCue) {
        if (cueDelay > 0) {
            notingState.waitTimer = setTimeout(function () {
                notingState.waitTimer = null;
                if (!notingState.active || notingState.paused) return;
                if (notingState.userTurnCueSound) {
                    playSound(notingState.userTurnCueSound);
                } else {
                    playSynthChime();
                }
            }, cueDelay);
        } else {
            if (notingState.userTurnCueSound) {
                playSound(notingState.userTurnCueSound);
            } else {
                playSynthChime();
            }
        }
    }
}

function startParticipantTurn(index) {
    if (notingState.paused) return;
    var p = notingState.participants[index];
    if (!p) { scheduleNextTurn(1000); return; }

    var delay = getParticipantDelay(p);

    notingState.waitTimer = setTimeout(function () {
        notingState.waitTimer = null;
        executeParticipantTurn(index, p);
    }, delay);
}

function executeParticipantTurn(index, p) {
    if (!notingState.active || notingState.paused) return;

    if (p.type === 'llm') {
        startServerTimeout();
        socket.emit('noting_turn', {
            context: notingState.recentLabels.slice(),
            reactive: p.reactive || 'none',
            participant_index: index,
            voice: p.voice || null,
            name: participantName(index),
        });
    } else if (p.type === 'fixed') {
        var phrase = p.phrase || 'breathing';
        notingState.recentLabels.push(phrase);
        if (notingState.recentLabels.length > 16) notingState.recentLabels.shift();
        addMessage('facilitator', phrase, false, participantName(index));

        startServerTimeout();
        socket.emit('noting_tts', {
            text: phrase,
            voice: p.voice || null,
            participant_index: index,
            name: participantName(index),
        });
    } else if (p.type === 'sound') {
        var soundName = p.sound || null;
        var displayName = participantName(index);
        if (soundName) {
            playSound(soundName, function () { scheduleNextTurn(300); });
        } else {
            playSynthChime();
            scheduleNextTurn(1000);
        }
        addMessage('facilitator', '\u2329' + displayName + '\u232A', false, displayName);
    }
}

function handleNotingLabel(data) {
    if (!notingState.active || notingState.paused) return;

    clearServerTimeout();
    var label = data.text || 'breathing';
    var pIndex = data.participant_index;
    notingState.recentLabels.push(label);
    if (notingState.recentLabels.length > 16) notingState.recentLabels.shift();

    addMessage('facilitator', label, false, participantName(pIndex));

    if (data.audio && state.audioContext) {
        playAudioThenAdvance(data.audio, label);
    } else {
        speakBrowser(label);
        scheduleNextTurn(2000);
    }
}

function handleNotingAudio(data) {
    if (!notingState.active || notingState.paused) return;

    clearServerTimeout();
    if (data.audio && state.audioContext) {
        playAudioThenAdvance(data.audio, data.text);
    } else if (data.text) {
        speakBrowser(data.text);
        scheduleNextTurn(2000);
    } else {
        scheduleNextTurn(1000);
    }
}

function playAudioThenAdvance(audioBytes, fallbackText) {
    stopServerAudio();

    var buffer = audioBytes instanceof ArrayBuffer ? audioBytes : audioBytes.buffer || audioBytes;

    state.ttsSpeaking = true;
    state.serverAudioPlaying = true;

    state.audioContext.decodeAudioData(buffer.slice(0), function (decoded) {
        state.serverAudioSource = state.audioContext.createBufferSource();
        state.serverAudioSource.buffer = decoded;
        state.serverAudioSource.connect(state.audioContext.destination);
        state.serverAudioSource.onended = function () {
            state.serverAudioPlaying = false;
            state.serverAudioSource = null;
            state.ttsSpeaking = false;
            scheduleNextTurn(300);
        };
        state.serverAudioSource.start(0);
    }, function () {
        state.serverAudioPlaying = false;
        state.ttsSpeaking = false;
        if (fallbackText) speakBrowser(fallbackText);
        scheduleNextTurn(2000);
    });
}

function scheduleNextTurn(delayMs) {
    if (!notingState.active || notingState.paused) return;
    notingState.waitTimer = setTimeout(function () {
        notingState.waitTimer = null;
        advanceTurn();
    }, delayMs);
}

function getParticipantDelay(p) {
    if (p.timing === 'fixed') {
        return (p.fixedDelay || 4) * 1000;
    }
    // Adaptive: use rolling average of user cadences
    if (notingState.userCadences.length > 0) {
        var sum = 0;
        for (var i = 0; i < notingState.userCadences.length; i++) {
            sum += notingState.userCadences[i];
        }
        return sum / notingState.userCadences.length;
    }
    return notingState.defaultCadenceMs;
}

// Server response timeout — if the server doesn't respond within this
// window, skip the turn so the circle doesn't stall.
var SERVER_TIMEOUT_MS = 15000;

function startServerTimeout() {
    clearServerTimeout();
    notingState._serverTimeout = setTimeout(function () {
        notingState._serverTimeout = null;
        if (!notingState.active || notingState.paused) return;
        console.warn('Noting: server response timeout, skipping turn');
        scheduleNextTurn(500);
    }, SERVER_TIMEOUT_MS);
}

function clearServerTimeout() {
    if (notingState._serverTimeout) {
        clearTimeout(notingState._serverTimeout);
        notingState._serverTimeout = null;
    }
}

function preloadSound(name) {
    if (!name || name === 'chime') return; // built-in synth, no file to load
    if (notingState.soundBuffers[name]) return;
    var ctx = notingState.audioContext || state.audioContext;
    if (!ctx) return;

    fetch('/static/audio/' + encodeURIComponent(name) + '.mp3')
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) {
            return ctx.decodeAudioData(buf);
        })
        .then(function (decoded) {
            notingState.soundBuffers[name] = decoded;
        })
        .catch(function () { /* sound will fall back to synth chime */ });
}

function playSound(name, onEnded) {
    // Built-in synth chime — no MP3 file
    if (!name || name === 'chime') {
        playSynthChime(onEnded);
        return;
    }

    var ctx = notingState.audioContext || state.audioContext;
    if (!ctx) {
        playSynthChime(onEnded);
        return;
    }

    var buffer = notingState.soundBuffers[name];
    if (buffer) {
        playSoundBuffer(ctx, buffer, onEnded);
        return;
    }

    // Buffer not ready — try loading on demand (preload may have run
    // before AudioContext existed).
    fetch('/static/audio/' + encodeURIComponent(name) + '.mp3')
        .then(function (r) { return r.arrayBuffer(); })
        .then(function (buf) { return ctx.decodeAudioData(buf); })
        .then(function (decoded) {
            notingState.soundBuffers[name] = decoded;
            playSoundBuffer(ctx, decoded, onEnded);
        })
        .catch(function () {
            playSynthChime(onEnded);
        });
}

function playSoundBuffer(ctx, buffer, onEnded) {
    // Signal the VAD so the mic ignores this playback (prevents the
    // mic from picking up the sound and transcribing it as user speech).
    state.ttsSpeaking = true;
    state.serverAudioPlaying = true;

    var source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.onended = function () {
        state.serverAudioPlaying = false;
        state.ttsSpeaking = false;
        if (onEnded) onEnded();
    };
    source.start(0);
}

function playSynthChime(onEnded) {
    var ctx = notingState.audioContext || state.audioContext;
    if (!ctx) { if (onEnded) onEnded(); return; }

    // Signal the VAD so the mic ignores this playback
    state.ttsSpeaking = true;
    state.serverAudioPlaying = true;

    // Simple two-tone ascending chime (~200ms)
    var now = ctx.currentTime;
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(440, now);
    osc.frequency.setValueAtTime(554, now + 0.1);  // A4 → C#5
    gain.gain.setValueAtTime(0.15, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
    osc.start(now);
    osc.stop(now + 0.2);
    osc.onended = function () {
        state.serverAudioPlaying = false;
        state.ttsSpeaking = false;
        if (onEnded) onEnded();
    };
}
