/* voice-picker.js — shared voice scoring, modal rendering, preview, and selection.
   Used by session (voice.js), settings (settings.js), and index (index.html). */

// Known high-quality macOS voices (base names, without Premium/Enhanced suffix).
export var MACOS_QUALITY_VOICES = /^(Ava|Allison|Samantha|Susan|Tom|Zoe|Karen|Daniel|Moira|Fiona|Tessa|Lee|Majed|Luciana|Joana|Mónica)$/i;

export var TIER_LABELS = { 3: 'Premium', 2: 'Quality', 1: 'Standard', 0: 'Other' };
var ENGINE_LABELS = { macos: 'macOS', piper: 'Piper', elevenlabs: 'ElevenLabs', browser: 'Browser' };
export var PREVIEW_PHRASE = 'Welcome to glow. I\'ll be your guide.';

var _previewAudio = null;

// ---- Scoring ----

export function scoreVoiceName(name) {
    var baseName = name.replace(/\s*\(.*\)$/, '');
    if (/Premium/i.test(name)) return 3;
    if (/Enhanced/i.test(name)) return 2;
    if (/Online|Natural/i.test(name)) return 2;
    if (/^Google/i.test(name)) return 1;
    if (MACOS_QUALITY_VOICES.test(baseName)) return 1;
    return 0;
}

// ---- Voice list building ----

/**
 * Build a scored, sorted voice list from server + browser voices.
 * Returns an array of { name, lang, score, voice? } where voice is the
 * browser SpeechSynthesisVoice object when available (enables browser TTS).
 *
 * @param {Array} serverVoices  - voices from /api/voices
 * @param {boolean} includeBrowserVoices - merge browser speechSynthesis voices
 * @returns {Array} scored voice entries, sorted best-first
 */
export function buildScoredVoiceList(serverVoices, includeBrowserVoices) {
    var langPrefix = (navigator.language || 'en').split(/[-_]/)[0];
    var browserVoices = (includeBrowserVoices && window.speechSynthesis)
        ? window.speechSynthesis.getVoices() : [];

    // Index browser voices by name for quick lookup
    var browserByName = {};
    for (var i = 0; i < browserVoices.length; i++) {
        browserByName[browserVoices[i].name] = browserVoices[i];
    }

    var scored = [];
    var seen = {};

    // Server voices first (authoritative — these are what actually speak)
    if (serverVoices) {
        for (var i = 0; i < serverVoices.length; i++) {
            var sv = serverVoices[i];
            var vLang = (sv.lang || '').split(/[-_]/)[0];
            if (vLang !== 'en' && vLang !== langPrefix) continue;

            var score = scoreVoiceName(sv.name);

            // If browser has this voice, attach the real object (enables preview)
            var browserVoice = browserByName[sv.name];
            if (!browserVoice && !sv.name.match(/\(/)) {
                var baseName = sv.name.replace(/\s*\(.*\)$/, '');
                browserVoice = browserByName[baseName];
            }

            var entry = {
                name: sv.name,
                lang: sv.lang,
                score: score,
                voice: browserVoice || { name: sv.name, lang: sv.lang, serverOnly: true },
            };
            // Pass through download metadata from server
            if (sv.needs_download) {
                entry.needsDownload = true;
                entry.downloaded = sv.downloaded;
                entry.sizeDisplay = sv.size_display;
            }
            if (sv.recommended) entry.recommended = true;
            if (sv.engine) entry.engine = sv.engine;
            scored.push(entry);
            seen[sv.name] = true;
            if (browserVoice) seen[browserVoice.name] = true;
        }
    }

    // Browser-only voices not already covered by server list
    for (var i = 0; i < browserVoices.length; i++) {
        var v = browserVoices[i];
        if (seen[v.name]) continue;
        var vLang = (v.lang || '').split(/[-_]/)[0];
        if (vLang !== 'en' && vLang !== langPrefix) continue;

        var score = scoreVoiceName(v.name);
        if (!v.localService) score = Math.max(score, 2);
        scored.push({ name: v.name, lang: v.lang, score: score, voice: v });
        seen[v.name] = true;
    }

    // Sort: highest score first, then recommended first, then alphabetically
    scored.sort(function (a, b) {
        if (b.score !== a.score) return b.score - a.score;
        if (a.recommended !== b.recommended) return a.recommended ? -1 : 1;
        return a.name.localeCompare(b.name);
    });

    return scored;
}

// ---- Modal rendering ----

/**
 * Render the voice modal list into a container element.
 *
 * @param {HTMLElement} listEl - the .voice-modal-list container
 * @param {Array} scoredVoices - output from buildScoredVoiceList
 * @param {string|null} selectedName - currently selected voice name
 * @param {Object} [options] - rendering options
 * @param {boolean} [options.showUninstall] - show uninstall button on downloaded voices
 * @param {boolean} [options.showEngine] - show engine badge on each voice
 */
export function renderVoiceList(listEl, scoredVoices, selectedName, options) {
    listEl.innerHTML = '';
    var opts = options || {};

    if (scoredVoices.length === 0) {
        listEl.innerHTML = '<div class="voice-tier-label">No text-to-speech voices available</div>';
        return;
    }

    // Split recommended voices out, then group rest by tier
    var recommended = [];
    var tiers = {};
    for (var i = 0; i < scoredVoices.length; i++) {
        if (scoredVoices[i].recommended) {
            recommended.push(scoredVoices[i]);
        } else {
            var s = scoredVoices[i].score;
            if (!tiers[s]) tiers[s] = [];
            tiers[s].push(scoredVoices[i]);
        }
    }

    // Render recommended section first
    if (recommended.length > 0) {
        var recLabel = document.createElement('div');
        recLabel.className = 'voice-tier-label';
        recLabel.textContent = 'Recommended';
        listEl.appendChild(recLabel);
        for (var i = 0; i < recommended.length; i++) {
            _renderVoiceRow(listEl, recommended[i], selectedName, opts);
        }
    }

    // Render remaining tiers in descending order
    var tierOrder = [3, 2, 1, 0];
    for (var t = 0; t < tierOrder.length; t++) {
        var tier = tierOrder[t];
        var items = tiers[tier];
        if (!items || items.length === 0) continue;

        var label = document.createElement('div');
        label.className = 'voice-tier-label';
        label.textContent = TIER_LABELS[tier];
        listEl.appendChild(label);

        for (var i = 0; i < items.length; i++) {
            _renderVoiceRow(listEl, items[i], selectedName, opts);
        }
    }
}

function _renderVoiceRow(listEl, entry, selectedName, opts) {
    var row = document.createElement('div');
    row.className = 'voice-row';
    if (entry.needsDownload && !entry.downloaded) row.classList.add('voice-row-locked');
    if (entry.name === selectedName) row.classList.add('selected');
    row.dataset.voiceName = entry.name;

    var nameSpan = document.createElement('span');
    nameSpan.className = 'voice-row-name';
    nameSpan.textContent = entry.name;
    // Engine badge inline after the name (e.g. "Samantha  macOS")
    if (opts && opts.showEngine && entry.engine) {
        var engineBadge = document.createElement('span');
        engineBadge.className = 'voice-row-engine';
        engineBadge.textContent = ENGINE_LABELS[entry.engine] || entry.engine;
        nameSpan.appendChild(engineBadge);
    }
    row.appendChild(nameSpan);

    if (entry.name === selectedName) {
        var check = document.createElement('span');
        check.className = 'voice-row-check';
        check.textContent = '\u2713';
        row.appendChild(check);
    }

    if (entry.needsDownload) {
        if (entry.downloaded) {
            // Uninstall button for downloaded voices
            if (opts && opts.showUninstall) {
                var unBtn = document.createElement('button');
                unBtn.type = 'button';
                unBtn.className = 'voice-row-uninstall';
                unBtn.textContent = 'Uninstall';
                unBtn.dataset.voiceName = entry.name;
                unBtn.dataset.engine = entry.engine || '';
                row.appendChild(unBtn);
            }
        } else {
            var size = document.createElement('span');
            size.className = 'voice-row-size';
            size.textContent = entry.sizeDisplay;
            row.appendChild(size);

            var dlBtn = document.createElement('button');
            dlBtn.type = 'button';
            dlBtn.className = 'voice-row-download';
            dlBtn.textContent = 'Download';
            dlBtn.dataset.voiceName = entry.name;
            dlBtn.dataset.engine = entry.engine || '';
            row.appendChild(dlBtn);
        }
    }

    var previewBtn = document.createElement('button');
    previewBtn.type = 'button';
    previewBtn.className = 'voice-row-preview';
    previewBtn.textContent = 'Preview';
    previewBtn.dataset.voiceName = entry.name;
    if (entry.needsDownload && !entry.downloaded) {
        previewBtn.classList.add('preview-unavailable');
        previewBtn.title = 'Download this voice first to preview it';
    }
    row.appendChild(previewBtn);

    listEl.appendChild(row);
}

/**
 * Update checkmark/selected state in a rendered voice modal list.
 *
 * @param {HTMLElement} listEl - the .voice-modal-list container
 * @param {string} selectedName - newly selected voice name
 */
export function updateVoiceSelection(listEl, selectedName) {
    var rows = listEl.querySelectorAll('.voice-row');
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i];
        var isSelected = row.dataset.voiceName === selectedName;
        row.classList.toggle('selected', isSelected);
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

// ---- Preview ----

export function previewVoice(voiceName, rate, engine) {
    stopPreview();
    var url = '/api/voices/preview?voice=' + encodeURIComponent(voiceName);
    if (rate) url += '&rate=' + rate;
    if (engine) url += '&engine=' + encodeURIComponent(engine);
    if (voiceName === 'Zarvox') url += '&text=' + encodeURIComponent('Come. On. Fahoogwuhgods.');
    _previewAudio = new Audio(url);
    _previewAudio.play().catch(function () {});
}

export function stopPreview() {
    if (window.speechSynthesis) window.speechSynthesis.cancel();
    if (_previewAudio) { _previewAudio.pause(); _previewAudio = null; }
}

// ---- localStorage helpers ----

export function getSavedVoice() {
    return localStorage.getItem('glooow-voice');
}

export function setSavedVoice(name) {
    localStorage.setItem('glooow-voice', name);
}

export function getSavedSpeed() {
    return localStorage.getItem('glooow-speed');
}

export function setSavedSpeed(rate) {
    localStorage.setItem('glooow-speed', String(rate));
}
