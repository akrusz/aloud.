/* tts.js — browser speechSynthesis TTS and server audio playback */

import { state, dom, socket } from './state.js';

export var TTS_COOLDOWN_MS = 800;    // ignore mic for this long after TTS ends

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

    // audioBytes may be an ArrayBuffer or a binary blob from Socket.IO
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
            setTimeout(function () {
                state.ttsSpeaking = false;
                if (state.onTtsDone) { var cb = state.onTtsDone; state.onTtsDone = null; cb(); }
            }, TTS_COOLDOWN_MS);
        };
        state.serverAudioSource.start(0);
    }, function (err) {
        console.warn('Server audio decode failed, falling back to browser TTS:', err);
        state.serverAudioPlaying = false;
        state.ttsSpeaking = false;
        if (fallbackText) speakBrowser(fallbackText);
    });
}

export function stopServerAudio() {
    if (state.serverAudioSource) {
        try { state.serverAudioSource.stop(); } catch (e) { /* already stopped */ }
        state.serverAudioSource = null;
    }
    state.serverAudioPlaying = false;
}
