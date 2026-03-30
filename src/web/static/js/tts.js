/* tts.js — browser speechSynthesis TTS and server audio playback */

import { state, dom, socket } from './state.js';
import { decodeAndPlay, setAudioPlaying } from './audio-utils.js';

export var TTS_COOLDOWN_MS = 800;    // ignore mic for this long after TTS ends

// ---- Audio chunk queue ----

var audioQueue = [];
var queuePlaying = false;

function playNext() {
    if (audioQueue.length === 0) {
        queuePlaying = false;
        setTimeout(function () {
            state.ttsSpeaking = false;
            if (state.onTtsDone) { var cb = state.onTtsDone; state.onTtsDone = null; cb(); }
        }, TTS_COOLDOWN_MS);
        return;
    }
    queuePlaying = true;
    var chunk = audioQueue.shift();
    decodeAndPlay(chunk, function () {
        playNext();
    }, function (err) {
        console.warn('Audio chunk decode failed:', err);
        playNext();
    });
}

export function queueAudioChunk(audioBytes) {
    audioQueue.push(audioBytes);
    if (!queuePlaying) {
        queuePlaying = true;
        state.ttsSpeaking = true;
        state.serverAudioPlaying = true;
        playNext();
    }
}

export function clearAudioQueue() {
    audioQueue = [];
}

// ---- Speak (single audio or browser fallback) ----

export function speak(text, audioBytes) {
    // Try server-generated audio first, fall back to browser speechSynthesis
    if (audioBytes && state.audioContext) {
        playServerAudio(audioBytes, text);
    } else {
        speakBrowser(text);
    }
}

export function speakBrowser(text) {
    if (!state.synth) return;
    state.synth.cancel();

    var utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = state.ttsRate / 180;  // convert WPM to browser rate (180 WPM ~ 1.0)
    utterance.pitch = 0.85;

    // Look up voice fresh by name — Safari voice object references can
    // go stale after voiceschanged, causing silent fallback to system default.
    if (state.preferredVoice) {
        var freshVoices = state.synth.getVoices();
        for (var i = 0; i < freshVoices.length; i++) {
            if (freshVoices[i].name === state.preferredVoice.name) {
                utterance.voice = freshVoices[i];
                break;
            }
        }
    }

    state.ttsSpeaking = true;
    utterance.onend = function () {
        setTimeout(function () {
            state.ttsSpeaking = false;
            if (state.onTtsDone) { var cb = state.onTtsDone; state.onTtsDone = null; cb(); }
        }, TTS_COOLDOWN_MS);
    };
    utterance.onerror = function () {
        setTimeout(function () {
            state.ttsSpeaking = false;
            if (state.onTtsDone) { var cb = state.onTtsDone; state.onTtsDone = null; cb(); }
        }, TTS_COOLDOWN_MS);
    };

    state.synth.speak(utterance);
}

export function playServerAudio(audioBytes, fallbackText) {
    stopServerAudio();
    if (state.synth) state.synth.cancel();

    decodeAndPlay(audioBytes, function () {
        setTimeout(function () {
            state.ttsSpeaking = false;
            if (state.onTtsDone) { var cb = state.onTtsDone; state.onTtsDone = null; cb(); }
        }, TTS_COOLDOWN_MS);
    }, function (err) {
        console.warn('Server audio decode failed, falling back to browser TTS:', err);
        if (fallbackText) speakBrowser(fallbackText);
    });
}

export function stopServerAudio() {
    // Clear any queued chunks
    clearAudioQueue();
    queuePlaying = false;
    if (state.serverAudioSource) {
        try { state.serverAudioSource.stop(); } catch (e) { /* already stopped */ }
        state.serverAudioSource = null;
    }
    state.serverAudioPlaying = false;
}
