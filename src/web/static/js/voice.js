/* voice.js — voice scoring, voice list, voice modal */

import { state, dom, socket } from './state.js';

// Known high-quality macOS voices (base names, without Premium/Enhanced suffix).
export var MACOS_QUALITY_VOICES = /^(Ava|Allison|Samantha|Susan|Tom|Zoe|Karen|Daniel|Moira|Fiona|Tessa|Lee|Majed|Luciana|Joana|Mónica)$/i;

export var TIER_LABELS = { 3: 'Premium', 2: 'Quality', 1: 'Standard', 0: 'Other' };
export var PREVIEW_PHRASE = 'Welcome to glow. I\'ll be your guide.';

export var previewAudio = null;  // Audio element for server-side preview playback

export function scoreVoiceName(name) {
    var baseName = name.replace(/\s*\(.*\)$/, '');
    if (/Premium/i.test(name)) return 3;
    if (/Enhanced/i.test(name)) return 2;
    if (/Online|Natural/i.test(name)) return 2;
    if (/^Google/i.test(name)) return 1;
    if (MACOS_QUALITY_VOICES.test(baseName)) return 1;
    return 0;
}

export function buildVoiceList() {
    var langPrefix = (navigator.language || 'en').split(/[-_]/)[0];
    var browserVoices = state.synth ? state.synth.getVoices() : [];

    // Index browser voices by name for quick lookup
    var browserByName = {};
    for (var i = 0; i < browserVoices.length; i++) {
        browserByName[browserVoices[i].name] = browserVoices[i];
    }

    // Start with server voices (authoritative — these are what actually speak)
    var scored = [];
    var seen = {};

    if (state._serverVoices) {
        for (var i = 0; i < state._serverVoices.length; i++) {
            var sv = state._serverVoices[i];
            var vLang = (sv.lang || '').split(/[-_]/)[0];
            if (vLang !== 'en' && vLang !== langPrefix) continue;

            var score = scoreVoiceName(sv.name);
            // If browser has this voice, use the real object (enables preview)
            var browserVoice = browserByName[sv.name];
            if (!browserVoice && !sv.name.match(/\(/)) {
                // Try without qualifier — e.g. server has "Ava (Premium)",
                // browser might have just "Ava"
                var baseName = sv.name.replace(/\s*\(.*\)$/, '');
                browserVoice = browserByName[baseName];
            }

            scored.push({
                voice: browserVoice || { name: sv.name, lang: sv.lang, serverOnly: true },
                score: score,
            });
            seen[sv.name] = true;
            if (browserVoice) seen[browserVoice.name] = true;
        }
    }

    // Add browser-only voices not already covered by server list
    for (var i = 0; i < browserVoices.length; i++) {
        var v = browserVoices[i];
        if (seen[v.name]) continue;
        var vLang = (v.lang || '').split(/[-_]/)[0];
        if (vLang !== 'en' && vLang !== langPrefix) continue;

        var score = scoreVoiceName(v.name);
        if (!v.localService) score = Math.max(score, 2);
        scored.push({ voice: v, score: score });
        seen[v.name] = true;
    }

    // Sort: highest score first, then alphabetically
    scored.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return a.voice.name.localeCompare(b.voice.name);
    });

    state.scoredVoices = scored;

    // Restore saved voice, or default to the best available.
    if (scored.length > 0) {
        var savedVoice = localStorage.getItem('glooow-voice');
        if (savedVoice) {
            var found = null;
            for (var i = 0; i < scored.length; i++) {
                if (scored[i].voice.name === savedVoice) { found = scored[i].voice; break; }
            }
            if (found) state.preferredVoice = found;
            else if (!state.preferredVoice) state.preferredVoice = scored[0].voice;
        } else {
            state.preferredVoice = scored[0].voice;
        }

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

    dom.voiceModalList.innerHTML = '';

    // Group by tier
    var tiers = {};
    for (var i = 0; i < state.scoredVoices.length; i++) {
        var s = state.scoredVoices[i].score;
        if (!tiers[s]) tiers[s] = [];
        tiers[s].push(state.scoredVoices[i]);
    }

    // Render tiers in descending order
    var tierOrder = [3, 2, 1, 0];
    for (var t = 0; t < tierOrder.length; t++) {
        var tier = tierOrder[t];
        var items = tiers[tier];
        if (!items || items.length === 0) continue;

        var label = document.createElement('div');
        label.className = 'voice-tier-label';
        label.textContent = TIER_LABELS[tier];
        dom.voiceModalList.appendChild(label);

        for (var i = 0; i < items.length; i++) {
            var entry = items[i];
            var row = document.createElement('div');
            row.className = 'voice-row';
            if (state.preferredVoice && entry.voice.name === state.preferredVoice.name) {
                row.classList.add('selected');
            }
            row.dataset.voiceName = entry.voice.name;

            var nameSpan = document.createElement('span');
            nameSpan.className = 'voice-row-name';
            nameSpan.textContent = entry.voice.name;
            row.appendChild(nameSpan);

            if (state.preferredVoice && entry.voice.name === state.preferredVoice.name) {
                var check = document.createElement('span');
                check.className = 'voice-row-check';
                check.textContent = '\u2713';
                row.appendChild(check);
            }

            var previewBtn = document.createElement('button');
            previewBtn.type = 'button';
            previewBtn.className = 'voice-row-preview';
            previewBtn.textContent = 'Preview';
            previewBtn.dataset.voiceName = entry.voice.name;
            row.appendChild(previewBtn);

            dom.voiceModalList.appendChild(row);
        }
    }

    dom.voiceModal.classList.remove('hidden');
}

export function closeVoiceModal(restoreMic, activateVoiceFn) {
    dom.voiceModal.classList.add('hidden');
    stopPreview();
    if (restoreMic) {
        activateVoiceFn();
    }
}

export function stopPreview() {
    if (state.synth) state.synth.cancel();
    state.previewUtterance = null;
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
}

export function previewVoice(voiceName) {
    stopPreview();

    // Use server TTS for preview — consistent quality and works for
    // voices the browser doesn't expose (e.g. macOS Premium in Safari).
    if (previewAudio) { previewAudio.pause(); previewAudio = null; }
    var url = '/api/voices/preview?voice=' + encodeURIComponent(voiceName);
    if (voiceName === 'Zarvox') url += '&text=' + encodeURIComponent('Come. On. Fahoogwuhgods.');
    previewAudio = new Audio(url);
    previewAudio.play().catch(function () {});
}

export function selectVoice(voiceName) {
    // Find the voice in scoredVoices (covers both browser and server-only voices)
    state.preferredVoice = null;
    for (var i = 0; i < state.scoredVoices.length; i++) {
        if (state.scoredVoices[i].voice.name === voiceName) {
            state.preferredVoice = state.scoredVoices[i].voice;
            break;
        }
    }
    socket.emit('set_tts_voice', { voice: voiceName });
    localStorage.setItem('glooow-voice', voiceName);
    updateVoicePickerLabel();

    // Update selected state in modal
    var rows = dom.voiceModalList.querySelectorAll('.voice-row');
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var isSelected = row.dataset.voiceName === voiceName;
        row.classList.toggle('selected', isSelected);
        // Update checkmark
        var existingCheck = row.querySelector('.voice-row-check');
        if (isSelected && !existingCheck) {
            var check = document.createElement('span');
            check.className = 'voice-row-check';
            check.textContent = '\u2713';
            row.insertBefore(check, row.querySelector('.voice-row-preview'));
        } else if (!isSelected && existingCheck) {
            existingCheck.remove();
        }
    }
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
