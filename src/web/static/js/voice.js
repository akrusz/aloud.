/* voice.js — session-page voice management.
   Delegates scoring, rendering, and preview to voice-picker.js. */

import { state, dom, socket } from './state.js';
import {
    scoreVoiceName, buildScoredVoiceList, renderVoiceList,
    updateVoiceSelection, previewVoice as sharedPreview, stopPreview,
    getSavedVoice, setSavedVoice,
    MACOS_QUALITY_VOICES, TIER_LABELS, PREVIEW_PHRASE,
} from './voice-picker.js';

// Re-export constants for any existing consumers
export { scoreVoiceName, MACOS_QUALITY_VOICES, TIER_LABELS, PREVIEW_PHRASE };

export function buildVoiceList() {
    var includeBrowser = !state.ttsEngine || state.ttsEngine === 'browser';
    var scored = buildScoredVoiceList(state._serverVoices, includeBrowser);

    // Attach voice objects to state for browser TTS
    state.scoredVoices = scored;

    // Restore saved voice, or default to the best available.
    // Skip voices that need downloading (not usable for TTS).
    function isUsable(entry) {
        return !entry.needsDownload || entry.downloaded;
    }
    if (scored.length > 0) {
        var savedVoice = getSavedVoice();
        var found = null;
        if (savedVoice) {
            for (var i = 0; i < scored.length; i++) {
                if (scored[i].name === savedVoice && isUsable(scored[i])) {
                    found = scored[i].voice;
                    break;
                }
            }
        }
        if (!found) {
            // Pick the first usable voice
            for (var i = 0; i < scored.length; i++) {
                if (isUsable(scored[i])) { found = scored[i].voice; break; }
            }
        }
        state.preferredVoice = found || null;

        // Tell the server which voice to use (restores preference on new sessions)
        if (state.preferredVoice) {
            socket.emit('set_tts_voice', { voice: state.preferredVoice.name });
        }
    }

    updateVoicePickerLabel();
}

export function populateVoices() {
    if (!state.synth) return;
    var voices = state.synth.getVoices();
    if (voices.length === 0) return;

    // Safari voiceschanged quirk: may re-fire with fewer voices
    if (voices.length < state._maxRawVoices) return;
    state._maxRawVoices = voices.length;

    buildVoiceList();
}

export function fetchServerVoices() {
    fetch('/api/voices')
        .then(function (r) { return r.json(); })
        .then(function (voices) {
            state._serverVoices = voices;
            buildVoiceList();
        })
        .catch(function () {});
}

export function updateVoicePickerLabel() {
    if (state.preferredVoice) {
        var label = state.preferredVoice.name;
        if (state.ttsRate) label += ' \u00b7 ' + state.ttsRate + ' wpm';
        dom.voicePickerBtn.textContent = label;
    } else {
        dom.voicePickerBtn.textContent = 'Voice';
    }
}

export function openVoiceModal(deactivateVoiceFn) {
    deactivateVoiceFn();
    var selectedName = state.preferredVoice ? state.preferredVoice.name : null;
    renderVoiceList(dom.voiceModalList, state.scoredVoices, selectedName);
    dom.voiceModal.classList.remove('hidden');
}

export function closeVoiceModal(restoreMic, activateVoiceFn) {
    dom.voiceModal.classList.add('hidden');
    stopPreview();
    if (restoreMic) {
        activateVoiceFn();
    }
}

export { stopPreview };

export function previewVoice(voiceName) {
    sharedPreview(voiceName);
}

export function selectVoice(voiceName) {
    // Find the voice in scoredVoices (covers both browser and server-only voices)
    state.preferredVoice = null;
    for (var i = 0; i < state.scoredVoices.length; i++) {
        if (state.scoredVoices[i].name === voiceName) {
            state.preferredVoice = state.scoredVoices[i].voice;
            break;
        }
    }
    socket.emit('set_tts_voice', { voice: voiceName });
    setSavedVoice(voiceName);
    updateVoicePickerLabel();

    // Update selected state in modal
    updateVoiceSelection(dom.voiceModalList, voiceName);
}

/** Initialise voice system: fetch server voices, wire browser voiceschanged */
export function initVoices() {
    fetchServerVoices();

    if (state.synth) {
        populateVoices();
        state.synth.addEventListener('voiceschanged', populateVoices);
        // Safari may return empty voices initially and not fire voiceschanged
        // reliably — poll a few times as a fallback.
        if (state.scoredVoices.length === 0) {
            var retries = 0;
            var voiceRetry = setInterval(function () {
                populateVoices();
                retries++;
                if (state.scoredVoices.length > 0 || retries >= 10) clearInterval(voiceRetry);
            }, 200);
        }
    }

    // After voices have had time to load, mark the voice picker if none available
    setTimeout(function () {
        if (state.scoredVoices.length === 0 && dom.voicePickerBtn) {
            state._noVoicesMode = true;
            dom.voicePickerBtn.classList.add('no-voices');
            dom.voicePickerBtn.textContent = '\u26a0 No voices';
            dom.voicePickerBtn.title = 'No TTS voices available \u2014 click for info';
        }
    }, 3000);
}
