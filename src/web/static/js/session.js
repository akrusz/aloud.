/* Session page — WebSocket, voice, and conversation logic */

(function () {
    'use strict';

    const socket = io();

    // DOM refs
    const conversationEl = document.getElementById('conversation');
    const voiceBtn = document.getElementById('voice-btn');
    const voiceStatus = document.getElementById('voice-status');
    const ttsToggle = document.getElementById('tts-toggle');
    const endBtn = document.getElementById('end-btn');
    const speedSlider = document.getElementById('speed-slider');
    const voicePickerBtn = document.getElementById('voice-picker-btn');
    const voiceModal = document.getElementById('voice-modal');
    const voiceModalList = document.getElementById('voice-modal-list');
    const voiceModalClose = document.getElementById('voice-modal-close');
    const modalSpeedSlider = document.getElementById('modal-speed-slider');
    const typingEl = document.getElementById('typing-indicator');
    const timerEl = document.getElementById('timer');
    const orbEl = document.getElementById('orb');
    const endedOverlay = document.getElementById('session-ended');
    const closerText = document.getElementById('closer-text');
    const kasinaToggle = document.getElementById('kasina-toggle');
    const emberBlocks = document.getElementById('ember-blocks');
    const emberContainer = document.getElementById('ember-container');
    const sessionContainer = document.querySelector('.session-container');
    const listenBtn = document.getElementById('listen-btn');

    // State
    let sessionActive = false;
    let voiceActive = false;
    let timerInterval = null;
    let sessionStart = null;
    let sessionId = null;          // stable ID that survives socket reconnections
    let initialConnectDone = false; // distinguishes first connect from reconnects
    let queuedSpeech = null;       // opener TTS queued until user gesture (mic permission)
    let orbDragging = false;        // true while dragging the kasina orb
    let orbMoved = false;           // true if mouse moved during drag (suppresses click-outside)
    let inSilenceMode = false;       // true when holding space — buffer speech, don't submit
    let silenceBuffer = [];          // transcribed texts accumulated during silence mode
    let emberLevel = 1;              // ember intensity: 0=off, 1/2/3=increasing
    let ttsRate = 160;             // speech rate in WPM — synced to server + browser TTS
    const synth = window.speechSynthesis || null;
    let preferredVoice = null;
    let scoredVoices = [];         // [{voice, score}] — built by populateVoices
    let previewUtterance = null;   // current SpeechSynthesisUtterance for preview

    // Known high-quality macOS voices (base names, without Premium/Enhanced suffix).
    var MACOS_QUALITY_VOICES = /^(Ava|Allison|Samantha|Susan|Tom|Zoe|Karen|Daniel|Moira|Fiona|Tessa|Lee|Majed|Luciana|Joana|Mónica)$/i;

    // Build scored voices array from browser speechSynthesis + server voices.
    // Server voices are authoritative (they're what actually speaks).
    // Browser voices supplement with preview capability.
    var _maxRawVoices = 0;
    var _serverVoices = null;  // cached server voice list [{name, lang}]

    function scoreVoiceName(name) {
        var baseName = name.replace(/\s*\(.*\)$/, '');
        if (/Premium/i.test(name)) return 3;
        if (/Enhanced/i.test(name)) return 2;
        if (/Online|Natural/i.test(name)) return 2;
        if (/^Google/i.test(name)) return 1;
        if (MACOS_QUALITY_VOICES.test(baseName)) return 1;
        return 0;
    }

    function buildVoiceList() {
        var langPrefix = (navigator.language || 'en').split(/[-_]/)[0];
        var browserVoices = synth ? synth.getVoices() : [];

        // Index browser voices by name for quick lookup
        var browserByName = {};
        for (var i = 0; i < browserVoices.length; i++) {
            browserByName[browserVoices[i].name] = browserVoices[i];
        }

        // Start with server voices (authoritative — these are what actually speak)
        var scored = [];
        var seen = {};

        if (_serverVoices) {
            for (var i = 0; i < _serverVoices.length; i++) {
                var sv = _serverVoices[i];
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

        // Keep all voices — sorted by quality so premium/quality are at top,
        // novelty and other voices remain available at the bottom.

        // Sort: highest score first, then alphabetically
        scored.sort(function (a, b) {
            if (b.score !== a.score) return b.score - a.score;
            return a.voice.name.localeCompare(b.voice.name);
        });

        scoredVoices = scored;

        // Restore saved voice, or default to the best available.
        // No localStorage entry means the user hasn't explicitly chosen,
        // so always pick the top voice (which may improve as server voices arrive).
        if (scored.length > 0) {
            var savedVoice = localStorage.getItem('glooow-voice');
            if (savedVoice) {
                var found = null;
                for (var i = 0; i < scored.length; i++) {
                    if (scored[i].voice.name === savedVoice) { found = scored[i].voice; break; }
                }
                if (found) preferredVoice = found;
                else if (!preferredVoice) preferredVoice = scored[0].voice;
            } else {
                preferredVoice = scored[0].voice;
            }
        }

        updateVoicePickerLabel();
    }

    function populateVoices() {
        if (!synth) return;
        var voices = synth.getVoices();
        if (voices.length === 0) return;

        // Safari voiceschanged quirk: may re-fire with fewer voices
        if (voices.length < _maxRawVoices) return;
        _maxRawVoices = voices.length;

        buildVoiceList();
    }

    function fetchServerVoices() {
        fetch('/api/voices')
            .then(function (r) { return r.json(); })
            .then(function (voices) {
                _serverVoices = voices;
                buildVoiceList();
            })
            .catch(function () {});
    }

    function updateVoicePickerLabel() {
        if (preferredVoice) {
            voicePickerBtn.textContent = preferredVoice.name;
        } else {
            voicePickerBtn.textContent = 'Voice';
        }
    }

    var TIER_LABELS = { 3: 'Premium', 2: 'Quality', 1: 'Standard', 0: 'Other' };
    var PREVIEW_PHRASE = 'Welcome to glow. I\'ll be your guide.';

    function openVoiceModal() {
        deactivateVoice();

        modalSpeedSlider.value = speedSlider.value;
        voiceModalList.innerHTML = '';

        // Group by tier
        var tiers = {};
        for (var i = 0; i < scoredVoices.length; i++) {
            var s = scoredVoices[i].score;
            if (!tiers[s]) tiers[s] = [];
            tiers[s].push(scoredVoices[i]);
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
            voiceModalList.appendChild(label);

            for (var i = 0; i < items.length; i++) {
                var entry = items[i];
                var row = document.createElement('div');
                row.className = 'voice-row';
                if (preferredVoice && entry.voice.name === preferredVoice.name) {
                    row.classList.add('selected');
                }
                row.dataset.voiceName = entry.voice.name;

                var nameSpan = document.createElement('span');
                nameSpan.className = 'voice-row-name';
                nameSpan.textContent = entry.voice.name;
                row.appendChild(nameSpan);

                if (preferredVoice && entry.voice.name === preferredVoice.name) {
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

                voiceModalList.appendChild(row);
            }
        }

        voiceModal.style.display = 'flex';
    }

    function closeVoiceModal(restoreMic) {
        voiceModal.style.display = 'none';
        stopPreview();
        if (restoreMic) {
            activateVoice();
        }
    }

    function stopPreview() {
        if (synth) synth.cancel();
        previewUtterance = null;
        if (previewAudio) { previewAudio.pause(); previewAudio = null; }
    }

    var previewAudio = null;  // Audio element for server-side preview playback

    function previewVoice(voiceName) {
        stopPreview();

        // Use server TTS for preview — consistent quality and works for
        // voices the browser doesn't expose (e.g. macOS Premium in Safari).
        if (previewAudio) { previewAudio.pause(); previewAudio = null; }
        var url = '/api/voices/preview?voice=' + encodeURIComponent(voiceName);
        if (voiceName === 'Zarvox') url += '&text=' + encodeURIComponent('Come. On. Fahoogwuhgods.');
        previewAudio = new Audio(url);
        previewAudio.play().catch(function () {});
    }

    function selectVoice(voiceName) {
        // Find the voice in scoredVoices (covers both browser and server-only voices)
        preferredVoice = null;
        for (var i = 0; i < scoredVoices.length; i++) {
            if (scoredVoices[i].voice.name === voiceName) {
                preferredVoice = scoredVoices[i].voice;
                break;
            }
        }
        socket.emit('set_tts_voice', { voice: voiceName });
        localStorage.setItem('glooow-voice', voiceName);
        updateVoicePickerLabel();

        // Update selected state in modal
        var rows = voiceModalList.querySelectorAll('.voice-row');
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

    // Fetch server voices (authoritative — these are what actually speak)
    fetchServerVoices();

    if (synth) {
        populateVoices();
        synth.addEventListener('voiceschanged', populateVoices);
        // Safari may return empty voices initially and not fire voiceschanged
        // reliably — poll a few times as a fallback.
        if (scoredVoices.length === 0) {
            var retries = 0;
            var voiceRetry = setInterval(function () {
                populateVoices();
                retries++;
                if (scoredVoices.length > 0 || retries >= 10) clearInterval(voiceRetry);
            }, 200);
        }
    }

    // Audio capture state
    let audioContext = null;
    let mediaStream = null;
    let sourceNode = null;         // MediaStreamSource — created once, reused
    let scriptProcessor = null;
    let audioChunks = [];
    let listening = false;         // true when actively detecting speech
    let ttsSpeaking = false;       // true while TTS is playing — ignore mic input
    let ttsMismatchStart = 0;      // timestamp when ttsSpeaking/synth.speaking diverged
    let serverAudioSource = null;  // AudioBufferSourceNode for server TTS playback
    let serverAudioPlaying = false; // true while server-generated audio is playing
    let queuedAudio = null;        // server audio bytes queued until voice activates
    let preBuffer = [];            // rolling buffer of recent chunks before speech detected
    let pendingTranscriptions = 0;  // count of in-flight transcription requests

    // VAD state machine (mirrors src/audio/vad.py)
    let vadState = 'silence';      // 'silence' | 'speech_started' | 'speaking'
    let speechStartTime = 0;       // Date.now() when speech onset detected
    let lastSpeechTime = 0;        // Date.now() of last above-threshold chunk
    let noiseFloor = 0.005;        // adaptive noise floor (EMA)
    let noiseSamples = 0;          // count for EMA alpha selection
    let bargeInCount = 0;          // consecutive high-energy chunks during TTS

    // Speculative transcription: pre-send audio at base silence so the
    // result is ready when the adaptive threshold is reached.
    let speculativeGen = 0;        // generation counter — incremented to invalidate stale results
    let speculativeSent = false;   // have we sent speculative audio for the current utterance?
    let speculativeText = null;    // transcription text if result arrived before threshold
    let awaitingSpeculative = false; // adaptive threshold reached, waiting for result

    var SILENCE_THRESHOLD = 0.015; // RMS level below which counts as silence
    var SILENCE_DURATION = 3000;   // ms of silence before auto-submitting (base)
    var SILENCE_DURATION_MAX = 7000; // ms — cap for adaptive silence tolerance
    var SILENCE_RAMP_RATE = 0.12;  // extra silence ms per ms of speech (ramps from base to max)
    var PRE_BUFFER_CHUNKS = 20;    // ~2s of audio to keep before speech onset
    var MIN_SPEECH_DURATION = 500; // ms — reject sounds shorter than this
    var MIN_UTTERANCE_DURATION = 4000; // ms — don't submit until this long after speech onset
    var NOISE_REJECT_MS = 200;     // ms — abort speech_started if silence exceeds this
    var TTS_COOLDOWN_MS = 800;     // ignore mic for this long after TTS ends
    var TTS_WATCHDOG_MS = 1500;    // force-reset ttsSpeaking if synth stopped this long ago
    var BARGE_IN_THRESHOLD = 0.04; // RMS energy to detect user speaking over TTS
    var BARGE_IN_CHUNKS = 3;       // consecutive chunks required (~280ms at 44.1kHz)
    var TRANSCRIPTION_TIMEOUT_MS = 15000; // warn if transcription takes too long

    // ---- Ember configuration ----

    var EMBER_COUNTS = [0, 3, 6, 12];
    var EMBER_COLORS = ['#e8a840', '#d4873a', '#c07830', '#e0a038', '#cc8030'];
    var EMBER_SHRINK_RATE = 0.3; // px/s — constant for all embers

    function hexGlow(hex) {
        return 'rgba(' + parseInt(hex.slice(1, 3), 16) + ','
            + parseInt(hex.slice(3, 5), 16) + ','
            + parseInt(hex.slice(5, 7), 16) + ',0.4)';
    }

    function setEmberLevel(level) {
        emberLevel = level;
        var blocks = emberBlocks.querySelectorAll('.ember-block');
        for (var i = 0; i < blocks.length; i++) {
            blocks[i].classList.toggle('filled', i < level);
        }
        regenerateEmbers();
    }

    function regenerateEmbers() {
        emberContainer.innerHTML = '';
        if (emberLevel === 0) {
            emberContainer.classList.remove('active');
            return;
        }
        emberContainer.classList.add('active');
        var count = EMBER_COUNTS[emberLevel];
        for (var i = 0; i < count; i++) {
            var span = document.createElement('span');
            span.className = 'ember';
            var sizeRange = [0, 2, 3.5, 5][emberLevel];
            var size = 2 + Math.random() * sizeRange;
            var color = EMBER_COLORS[Math.floor(Math.random() * EMBER_COLORS.length)];
            var glow = Math.round(3 + size);
            span.style.left = (5 + Math.random() * 90) + '%';
            span.style.width = size + 'px';
            span.style.height = size + 'px';
            span.style.background = color;
            span.style.boxShadow = '0 0 ' + glow + 'px ' + Math.round(size * 0.4) + 'px ' + hexGlow(color);

            var dur = 10 + Math.random() * 20; // 10–30s for speed variety
            var drift = Math.round(-30 + Math.random() * 60);
            var endScale = Math.max(0, 1 - EMBER_SHRINK_RATE * dur / size).toFixed(3);

            span.animate([
                { transform: 'translateY(0) translateX(0) scale(1)', opacity: 0, offset: 0 },
                { transform: 'translateY(-5vh) translateX(' + Math.round(drift * 0.06) + 'px) scale(0.97)', opacity: 0.7, offset: 0.06 },
                { transform: 'translateY(-95vh) translateX(' + drift + 'px) scale(' + endScale + ')', opacity: 0, offset: 1.0 },
            ], {
                duration: dur * 1000,
                delay: Math.random() * dur * 1000,
                iterations: Infinity,
                easing: 'linear',
            });

            emberContainer.appendChild(span);
        }
    }

    // ---- Initialize ----

    function init() {
        const params = JSON.parse(sessionStorage.getItem('sessionParams') || '{}');

        // Generate a stable session ID that survives socket reconnections
        sessionId = 'ses-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
        params.session_id = sessionId;
        params.tts = ttsToggle.checked;

        // Event listeners
        voiceBtn.addEventListener('click', toggleVoice);
        listenBtn.addEventListener('click', toggleListenMode);
        endBtn.addEventListener('click', endSession);
        var newSessionLink = document.querySelector('.nav-links a[href="/"]');
        if (newSessionLink) {
            newSessionLink.addEventListener('click', function (e) {
                if (sessionActive && !confirm('Start a new session? This will end your current session.')) {
                    e.preventDefault();
                }
            });
        }
        // Restore saved speed
        var savedSpeed = localStorage.getItem('glooow-speed');
        if (savedSpeed) {
            speedSlider.value = savedSpeed;
            modalSpeedSlider.value = savedSpeed;
            ttsRate = parseInt(savedSpeed);
        }

        speedSlider.addEventListener('input', function () {
            ttsRate = parseInt(speedSlider.value);
            modalSpeedSlider.value = speedSlider.value;
            localStorage.setItem('glooow-speed', speedSlider.value);
            socket.emit('set_tts_rate', { rate: ttsRate });
        });
        modalSpeedSlider.addEventListener('input', function () {
            ttsRate = parseInt(modalSpeedSlider.value);
            speedSlider.value = modalSpeedSlider.value;
            localStorage.setItem('glooow-speed', modalSpeedSlider.value);
            socket.emit('set_tts_rate', { rate: ttsRate });
        });
        voicePickerBtn.addEventListener('click', function () { openVoiceModal(); });
        voiceModalClose.addEventListener('click', function () { closeVoiceModal(true); });
        voiceModal.addEventListener('click', function (e) {
            // Close on backdrop click (not on the modal itself)
            if (e.target === voiceModal) closeVoiceModal(true);
        });
        voiceModalList.addEventListener('click', function (e) {
            // Preview button
            var previewBtn = e.target.closest('.voice-row-preview');
            if (previewBtn) {
                e.stopPropagation();
                previewVoice(previewBtn.dataset.voiceName);
                return;
            }
            // Voice row click — select that voice
            var row = e.target.closest('.voice-row');
            if (row) {
                selectVoice(row.dataset.voiceName);
            }
        });

        // Click orb in nav bar to enter kasina mode
        orbEl.addEventListener('click', function (e) {
            if (!kasinaToggle.checked && !orbDragging) {
                e.stopPropagation();
                kasinaToggle.checked = true;
                kasinaToggle.dispatchEvent(new Event('change'));
            }
        });

        kasinaToggle.addEventListener('change', function () {
            // Capture current visual state while CSS animations are still running
            var cs = getComputedStyle(orbEl);
            var startOpacity = cs.opacity;
            var startFilter = cs.filter;
            var startBoxShadow = cs.boxShadow;
            var startBackground = cs.background;

            // FIRST — snapshot current orb position
            var first = orbEl.getBoundingClientRect();

            // Pause CSS animations so they don't fight the transition
            orbEl.style.animation = 'none';

            // Apply the layout change
            // Move orb out of nav (which has transform) so position:fixed
            // is relative to the viewport, then move it back on deactivate.
            if (kasinaToggle.checked) {
                orbEl.classList.remove('orb-breathing', 'orb-nav');
                orbEl.classList.add('orb-kasina');
                document.body.appendChild(orbEl);
                sessionContainer.classList.add('kasina-active');
                // Force dark mode for kasina (save current theme to restore later)
                var currentTheme = document.documentElement.getAttribute('data-theme');
                if (currentTheme !== 'dark') {
                    kasinaToggle._prevTheme = currentTheme;
                    document.documentElement.setAttribute('data-theme', 'dark');
                }
            } else {
                orbEl.classList.remove('orb-kasina');
                orbEl.classList.add('orb-breathing', 'orb-nav');
                // Clear any drag positioning before moving back to nav
                orbEl.style.left = '';
                orbEl.style.top = '';
                orbEl.style.inset = '';
                orbEl.style.margin = '';
                orbEl.style.cursor = '';
                document.querySelector('.nav-session-info').prepend(orbEl);
                sessionContainer.classList.remove('kasina-active');
                // Restore previous theme
                if (kasinaToggle._prevTheme) {
                    document.documentElement.setAttribute('data-theme', kasinaToggle._prevTheme);
                    kasinaToggle._prevTheme = null;
                }
            }

            // Capture target visual state with animation at 0% for seamless handoff.
            // Temporarily enable CSS animation so getComputedStyle reflects the
            // 0% keyframe values (opacity, scale, box-shadow, etc.).
            orbEl.style.animation = '';
            var cs2 = getComputedStyle(orbEl);
            var endOpacity = cs2.opacity;
            var endFilter = cs2.filter;
            var endBoxShadow = cs2.boxShadow;
            var endBackground = cs2.background;
            // Extract animation-applied scale for the end transform
            var endMatrix = cs2.transform;
            var endScale = 1;
            if (endMatrix && endMatrix !== 'none') {
                var m = endMatrix.match(/matrix\(([^,]+)/);
                if (m) endScale = parseFloat(m[1]);
            }
            orbEl.style.animation = 'none';

            // LAST — snapshot new position
            var last = orbEl.getBoundingClientRect();

            // INVERT — calculate delta between old and new center
            var dx = first.left + first.width / 2 - (last.left + last.width / 2);
            var dy = first.top + first.height / 2 - (last.top + last.height / 2);
            var scale = first.width / last.width;

            // PLAY — animate from old position/appearance to new.
            // End values match the CSS animation's 0% keyframe so the
            // handoff is seamless when we re-enable animations.
            var anim = orbEl.animate([
                {
                    transform: 'translate(' + dx + 'px, ' + dy + 'px) scale(' + scale + ')',
                    opacity: startOpacity,
                    filter: startFilter,
                    boxShadow: startBoxShadow,
                    background: startBackground
                },
                {
                    transform: 'translate(0, 0) scale(' + endScale + ')',
                    opacity: endOpacity,
                    filter: endFilter,
                    boxShadow: endBoxShadow,
                    background: endBackground
                }
            ], {
                duration: 600,
                easing: 'ease-in-out',
                fill: 'forwards'
            });

            // Re-enable CSS animations once the transition finishes.
            // fill:forwards holds the FLIP end values (which match animation 0%)
            // until the CSS animation takes over, preventing any flash.
            anim.onfinish = function () {
                orbEl.style.animation = '';
                requestAnimationFrame(function () {
                    anim.cancel();
                });
            };
        });

        // Ember level controls
        document.getElementById('ember-minus').addEventListener('click', function () {
            setEmberLevel(Math.max(0, emberLevel - 1));
        });
        document.getElementById('ember-plus').addEventListener('click', function () {
            setEmberLevel(Math.min(3, emberLevel + 1));
        });
        emberBlocks.addEventListener('click', function (e) {
            var block = e.target.closest('.ember-block');
            if (!block) return;
            var clicked = parseInt(block.dataset.level);
            setEmberLevel(clicked === emberLevel ? 0 : clicked);
        });

        // ---- Kasina drag + click-outside ----

        function startOrbDrag(clientX, clientY) {
            if (!kasinaToggle.checked) return;
            orbDragging = true;
            orbMoved = false;

            var rect = orbEl.getBoundingClientRect();

            // Switch from inset centering to explicit left/top
            orbEl.style.inset = 'auto';
            orbEl.style.margin = '0';
            orbEl.style.left = rect.left + 'px';
            orbEl.style.top = rect.top + 'px';
            orbEl.style.cursor = 'grabbing';

            orbDragStartX = clientX - rect.left;
            orbDragStartY = clientY - rect.top;
        }

        var orbDragStartX = 0, orbDragStartY = 0;

        function moveOrbDrag(clientX, clientY) {
            if (!orbDragging) return;
            orbMoved = true;
            orbEl.style.left = (clientX - orbDragStartX) + 'px';
            orbEl.style.top = (clientY - orbDragStartY) + 'px';
        }

        function endOrbDrag() {
            if (!orbDragging) return;
            orbDragging = false;
            orbEl.style.cursor = '';
        }

        // Mouse drag
        orbEl.addEventListener('mousedown', function (e) {
            if (!kasinaToggle.checked) return;
            e.preventDefault();
            startOrbDrag(e.clientX, e.clientY);
        });
        document.addEventListener('mousemove', function (e) { moveOrbDrag(e.clientX, e.clientY); });
        document.addEventListener('mouseup', endOrbDrag);

        // Touch drag
        orbEl.addEventListener('touchstart', function (e) {
            if (!kasinaToggle.checked) return;
            e.preventDefault();
            startOrbDrag(e.touches[0].clientX, e.touches[0].clientY);
        }, { passive: false });
        document.addEventListener('touchmove', function (e) {
            if (orbDragging) moveOrbDrag(e.touches[0].clientX, e.touches[0].clientY);
        });
        document.addEventListener('touchend', endOrbDrag);

        // Click outside orb exits kasina mode
        document.addEventListener('click', function (e) {
            if (!kasinaToggle.checked || orbDragging) return;
            // Suppress if the user just finished dragging
            if (orbMoved) { orbMoved = false; return; }
            // Don't exit if clicking on controls
            if (e.target.closest('.input-area, .input-controls, .nav')) return;
            // Check if click is near the orb (within glow radius)
            var rect = orbEl.getBoundingClientRect();
            var cx = rect.left + rect.width / 2;
            var cy = rect.top + rect.height / 2;
            var dx = e.clientX - cx;
            var dy = e.clientY - cy;
            if (Math.sqrt(dx * dx + dy * dy) < 100) return;
            // Exit kasina mode
            kasinaToggle.checked = false;
            kasinaToggle.dispatchEvent(new Event('change'));
        });

        // Initialize embers at default level
        setEmberLevel(emberLevel);

        // Start session
        socket.emit('start_session', params);
        sessionActive = true;
        sessionStart = Date.now();
        startTimer();

        // Clear continuation flag so it doesn't persist
        sessionStorage.removeItem('continueFrom');

        // Auto-activate voice — the mic permission prompt acts as a user
        // gesture, which unlocks speechSynthesis for TTS.
        activateVoice();
    }

    // Handle reconnection — only fires on reconnects, not the initial connect.
    // Re-registers the session so the server re-maps the new socket sid to
    // our existing session (preserving conversation history).
    socket.on('connect', function () {
        if (!initialConnectDone) {
            initialConnectDone = true;
            return;
        }
        if (sessionActive && sessionId) {
            console.log('Socket reconnected — re-registering session', sessionId);
            socket.emit('start_session', { session_id: sessionId });
        }
    });

    // ---- Messaging ----

    function sendText(text) {
        if (!text || !sessionActive) return;

        // During silence mode, buffer speech instead of submitting.
        // Show it in the conversation but don't send to the LLM.
        // Only a resume phrase triggers sending everything at once.
        if (inSilenceMode) {
            silenceBuffer.push(text);
            addMessage('user', text);
            setStatus("Holding space\u2026 say \u2018come back\u2019 to resume");
            if (isResumeCommand(text)) {
                var combined = silenceBuffer.join(' ... ');
                silenceBuffer = [];
                inSilenceMode = false;
                listenBtn.classList.remove('active');
                socket.emit('user_message', { text: combined });
            }
            return;
        }

        addMessage('user', text);
        socket.emit('user_message', { text: text });
    }

    function addMessage(role, text, historical) {
        var wasAtBottom = isNearBottom();

        const msg = document.createElement('div');
        msg.className = 'message ' + role + (historical ? ' historical' : '');

        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = text;
        msg.appendChild(content);

        conversationEl.insertBefore(msg, typingEl);
        if (wasAtBottom) {
            scrollToBottom();
        }
    }

    function isNearBottom() {
        var threshold = 50;
        return conversationEl.scrollTop + conversationEl.clientHeight >= conversationEl.scrollHeight - threshold;
    }

    function scrollToBottom() {
        // Immediate scroll so isNearBottom() sees the right position
        conversationEl.scrollTop = conversationEl.scrollHeight;
        // Re-scroll after render to catch any layout reflow from text wrapping
        requestAnimationFrame(function () {
            conversationEl.scrollTop = conversationEl.scrollHeight;
        });
    }

    // ---- Socket events ----

    socket.on('session_history', function (data) {
        var exchanges = data.exchanges || [];
        exchanges.forEach(function (ex) {
            var role = ex.role === 'assistant' ? 'facilitator' : 'user';
            addMessage(role, ex.content, true);
        });
        // Add visual separator between old and new conversation
        var sep = document.createElement('div');
        sep.className = 'continuation-separator';
        sep.innerHTML = '<span>continuing...</span>';
        conversationEl.insertBefore(sep, typingEl);
        scrollToBottom();
    });

    socket.on('facilitator_message', function (data) {
        typingEl.classList.remove('visible');
        addMessage('facilitator', data.text);
        if (ttsToggle.checked) {
            // If voice isn't active yet (e.g. opener arrives before mic
            // permission is granted), queue the speech for later.
            if (voiceActive) {
                speak(data.text, data.audio);
            } else {
                queuedSpeech = data.text;
                queuedAudio = data.audio || null;
            }
        }
    });

    socket.on('facilitator_typing', function (data) {
        if (data.typing) {
            typingEl.classList.add('visible');
            scrollToBottom();
        } else {
            typingEl.classList.remove('visible');
        }
    });

    socket.on('session_ended', function (data) {
        sessionActive = false;
        stopTimer();

        if (data.closer) {
            closerText.textContent = data.closer;
        }

        if (ttsToggle.checked && data.closer) {
            // audioContext may have been closed by deactivateVoice() —
            // create a temporary one for playing the closer audio.
            if (data.audio && !audioContext) {
                var tmpCtx = new (window.AudioContext || window.webkitAudioContext)();
                var buf = data.audio instanceof ArrayBuffer ? data.audio : data.audio.buffer || data.audio;
                tmpCtx.decodeAudioData(buf.slice(0), function (decoded) {
                    var src = tmpCtx.createBufferSource();
                    src.buffer = decoded;
                    src.connect(tmpCtx.destination);
                    src.onended = function () { tmpCtx.close(); };
                    src.start(0);
                }, function () {
                    tmpCtx.close();
                    speakBrowser(data.closer);
                });
            } else {
                speak(data.closer, data.audio);
            }
        }

        endedOverlay.style.display = 'flex';
    });

    socket.on('silence_mode', function (data) {
        var orb = document.getElementById('orb');
        inSilenceMode = data.active;
        listenBtn.classList.toggle('active', data.active);
        if (data.active) {
            silenceBuffer = [];
            setStatus("Holding space\u2026 say \u2018come back\u2019 to resume");
            if (orb && !kasinaToggle.checked) orb.classList.add('orb-holding');
        } else {
            silenceBuffer = [];
            setStatus("Speak naturally, or say 'mute' to turn off mic");
            if (orb) orb.classList.remove('orb-holding');
        }
    });

    socket.on('error', function (data) {
        console.error('Server error:', data.message);
    });

    // ---- Audio helpers ----

    function downsampleTo16k(buffer, fromRate) {
        if (fromRate === 16000) return buffer;
        var ratio = fromRate / 16000;
        var newLength = Math.round(buffer.length / ratio);
        var result = new Float32Array(newLength);
        for (var i = 0; i < newLength; i++) {
            // Linear interpolation for decent quality
            var srcIndex = i * ratio;
            var low = Math.floor(srcIndex);
            var high = Math.min(low + 1, buffer.length - 1);
            var frac = srcIndex - low;
            result[i] = buffer[low] * (1 - frac) + buffer[high] * frac;
        }
        return result;
    }

    // ---- VAD helpers ----

    function updateNoiseFloor(energy) {
        var alpha = noiseSamples < 100 ? 0.1 : 0.01;
        noiseFloor = (1 - alpha) * noiseFloor + alpha * energy;
        noiseSamples++;
    }

    // ---- Voice Input (server-side Whisper via AudioContext) ----
    //
    // Voice mode activates automatically when the session starts.
    // The mic stays open and continuously listens. When you stop speaking
    // (silence for SILENCE_DURATION ms), the captured audio is sent for
    // transcription, then listening resumes automatically. Click mic to
    // mute/unmute.

    function setStatus(text) {
        voiceStatus.textContent = text;
    }

    function toggleVoice() {
        if (voiceActive) {
            deactivateVoice();
        } else {
            activateVoice();
        }
    }

    function toggleListenMode() {
        if (inSilenceMode) {
            // Exit: send buffered text if any, then resume normal mode
            inSilenceMode = false;
            listenBtn.classList.remove('active');
            if (silenceBuffer.length > 0) {
                var combined = silenceBuffer.join(' ... ');
                silenceBuffer = [];
                socket.emit('user_message', { text: combined });
            } else {
                // Nothing buffered — still need to tell the server
                socket.emit('user_message', { text: '(silence)' });
            }
            setStatus("Speak naturally, or say 'mute' to turn off mic");
            var orb = document.getElementById('orb');
            if (orb) orb.classList.remove('orb-holding');
        } else {
            // Enter holding-space mode locally
            inSilenceMode = true;
            silenceBuffer = [];
            listenBtn.classList.add('active');
            setStatus("Holding space\u2026 say \u2018come back\u2019 to resume");
            var orb = document.getElementById('orb');
            if (orb && !kasinaToggle.checked) orb.classList.add('orb-holding');
        }
    }

    function activateVoice() {
        navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
            mediaStream = stream;
            audioContext = new (window.AudioContext || window.webkitAudioContext)();

            // Build the audio pipeline once — it stays connected for the
            // entire voice-active session.  This avoids the startup gap that
            // was eating the first fraction of each utterance.
            sourceNode = audioContext.createMediaStreamSource(mediaStream);
            scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1);

            scriptProcessor.onaudioprocess = function (e) {
                // ---- TTS watchdog ----
                // Chrome sometimes fails to fire onend, leaving ttsSpeaking
                // stuck at true.  If synth has actually stopped for longer
                // than TTS_WATCHDOG_MS, force-reset the flag.
                // For server audio, check serverAudioPlaying directly.
                if (ttsSpeaking) {
                    var synthDone = synth ? !synth.speaking : true;
                    var serverDone = !serverAudioPlaying;
                    if (synthDone && serverDone) {
                        if (ttsMismatchStart === 0) {
                            ttsMismatchStart = Date.now();
                        } else if (Date.now() - ttsMismatchStart > TTS_WATCHDOG_MS) {
                            console.warn('TTS watchdog: resetting stuck ttsSpeaking flag');
                            ttsSpeaking = false;
                            ttsMismatchStart = 0;
                        }
                    } else {
                        ttsMismatchStart = 0;
                    }
                }

                var channelData = e.inputBuffer.getChannelData(0);
                var chunk = new Float32Array(channelData);

                // Compute RMS energy (used for both barge-in and VAD)
                var sum = 0;
                for (var i = 0; i < chunk.length; i++) {
                    sum += chunk[i] * chunk[i];
                }
                var energy = Math.sqrt(sum / chunk.length);

                // ---- Barge-in detection during TTS ----
                // Instead of ignoring all audio while TTS plays, monitor for
                // the user speaking over it.  If energy stays above a higher
                // threshold for a few consecutive chunks, cancel TTS and
                // start capturing immediately.
                var synthActive = ttsSpeaking || (synth && synth.speaking) || serverAudioPlaying;
                if (synthActive) {
                    if (energy > BARGE_IN_THRESHOLD) {
                        bargeInCount++;
                        if (bargeInCount >= BARGE_IN_CHUNKS) {
                            // User is speaking — cancel TTS and resume capture
                            console.log('Barge-in detected, cancelling TTS');
                            stopServerAudio();
                            if (synth) synth.cancel();
                            ttsSpeaking = false;
                            ttsMismatchStart = 0;
                            bargeInCount = 0;
                            // Start fresh — don't seed from pre-buffer since
                            // it's contaminated with TTS speaker audio.
                            preBuffer = [chunk];
                            // Fall through to normal VAD below
                        } else {
                            return;
                        }
                    } else {
                        bargeInCount = 0;
                        preBuffer = [];
                        return;
                    }
                }

                // If not actively listening, just maintain the rolling
                // pre-buffer so the onset of the next utterance is captured.
                if (!listening) {
                    preBuffer.push(chunk);
                    if (preBuffer.length > PRE_BUFFER_CHUNKS) {
                        preBuffer.shift();
                    }
                    return;
                }

                var now = Date.now();

                // Adaptive threshold: at least SILENCE_THRESHOLD, or 3x noise floor
                var threshold = Math.max(SILENCE_THRESHOLD, noiseFloor * 3);
                var isSpeech = energy > threshold;

                if (vadState === 'silence') {
                    if (isSpeech) {
                        vadState = 'speech_started';
                        speechStartTime = now;
                        lastSpeechTime = now;
                        // Seed audio buffer from pre-buffer so onset isn't lost
                        for (var i = 0; i < preBuffer.length; i++) {
                            audioChunks.push(preBuffer[i]);
                        }
                        preBuffer = [];
                        audioChunks.push(chunk);
                    } else {
                        updateNoiseFloor(energy);
                        preBuffer.push(chunk);
                        if (preBuffer.length > PRE_BUFFER_CHUNKS) {
                            preBuffer.shift();
                        }
                    }
                } else if (vadState === 'speech_started') {
                    // Always capture audio during onset (including brief pauses)
                    audioChunks.push(chunk);
                    if (isSpeech) {
                        lastSpeechTime = now;
                        if (now - speechStartTime >= MIN_SPEECH_DURATION) {
                            vadState = 'speaking';
                            if (!inSilenceMode) setStatus('Listening...');
                        }
                    } else {
                        // Short silence — noise reject if too long
                        if (now - lastSpeechTime > NOISE_REJECT_MS) {
                            // Too short for normal speech, but may be a
                            // voice command like "mute" — send for
                            // command-only transcription before discarding.
                            submitCommandCandidate();
                            vadState = 'silence';
                            speechStartTime = 0;
                            lastSpeechTime = 0;
                        }
                    }
                } else if (vadState === 'speaking') {
                    audioChunks.push(chunk);
                    if (isSpeech) {
                        lastSpeechTime = now;
                        // User resumed speaking — invalidate any speculative
                        if (speculativeSent) {
                            speculativeGen++;
                            speculativeSent = false;
                            speculativeText = null;
                        }
                    } else {
                        // Adaptive silence: the longer the user has been
                        // speaking, the more patience for thinking pauses.
                        var speechDur = lastSpeechTime - speechStartTime;
                        var silenceNeeded = Math.min(
                            SILENCE_DURATION + speechDur * SILENCE_RAMP_RATE,
                            SILENCE_DURATION_MAX
                        );
                        var silenceElapsed = now - lastSpeechTime;

                        // At base silence, pre-send audio for transcription
                        // so the result is ready when adaptive threshold hits.
                        if (!speculativeSent &&
                            silenceNeeded > SILENCE_DURATION &&
                            silenceElapsed >= SILENCE_DURATION &&
                            now - speechStartTime >= MIN_UTTERANCE_DURATION) {
                            submitSpeculative();
                        }

                        if (silenceElapsed >= silenceNeeded) {
                            if (now - speechStartTime >= MIN_UTTERANCE_DURATION) {
                                if (speculativeText !== null) {
                                    // Transcription already back — use it
                                    finalizeSpeculative();
                                } else if (speculativeSent) {
                                    // Sent but not back yet — wait for it
                                    awaitingSpeculative = true;
                                    vadState = 'silence';
                                    audioChunks = [];
                                    speechStartTime = 0;
                                    lastSpeechTime = 0;
                                    speculativeSent = false;
                                } else {
                                    // Short speech or no ramp — normal submit
                                    submitUtterance();
                                }
                            } else {
                                // Short utterance — submit as command candidate
                                submitCommandCandidate();
                                vadState = 'silence';
                                speechStartTime = 0;
                                lastSpeechTime = 0;
                            }
                        }
                    }
                }
            };

            sourceNode.connect(scriptProcessor);
            scriptProcessor.connect(audioContext.destination);

            voiceActive = true;
            voiceBtn.classList.add('active');

            // Speak any opener that was queued before mic permission was granted
            if (queuedSpeech && ttsToggle.checked) {
                speak(queuedSpeech, queuedAudio);
                queuedSpeech = null;
                queuedAudio = null;
            }

            beginListening();
        }).catch(function (err) {
            console.error('Microphone error:', err);
            if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
                setStatus('Microphone access denied. Click mic to retry.');
            } else {
                setStatus('Microphone error. Click mic to retry.');
            }
        });
    }

    function beginListening() {
        if (!voiceActive || !audioContext || !mediaStream) return;

        // Reset VAD state fully (including noise floor) so each exchange
        // starts clean — prevents TTS residue from inflating the threshold.
        audioChunks = [];
        listening = true;
        vadState = 'silence';
        speechStartTime = 0;
        lastSpeechTime = 0;
        noiseFloor = 0.005;
        noiseSamples = 0;
        pendingTranscriptions = 0;
        bargeInCount = 0;
        speculativeSent = false;
        speculativeText = null;
        awaitingSpeculative = false;

        if (inSilenceMode) {
            setStatus("Holding space\u2026 say \u2018come back\u2019 to resume");
        } else {
            setStatus("Speak naturally, or say 'mute' to turn off mic");
        }
    }

    function isHoldCommand(text) {
        // Recognise short hold/wait phrases so they can be forwarded to
        // the LLM even from command-candidate transcriptions.
        var lower = text.toLowerCase();
        return /\b(hold|wait|one moment|one sec|hang on|just a)\b/.test(lower);
    }

    function isResumeCommand(text) {
        // Recognise phrases that signal the user wants to exit silence
        // mode and resume the conversation.
        var lower = text.toLowerCase().replace(/[^a-z' ]/g, '').trim();
        if (/^(okay|ok)$/.test(lower)) return true;
        return /\b(come back|i'm back|im back|i'm here|im here|resume|back now)\b/.test(lower);
    }

    function submitCommandCandidate() {
        // Submit a short utterance that the VAD would normally reject as
        // noise.  We send it for transcription tagged as command-only so
        // that the transcription handler can act on "mute" but
        // silently discard anything that isn't a recognised command.
        var chunks = audioChunks;
        audioChunks = [];

        if (chunks.length === 0) return;

        var totalLength = 0;
        for (var i = 0; i < chunks.length; i++) {
            totalLength += chunks[i].length;
        }
        var combined = new Float32Array(totalLength);
        var offset = 0;
        for (var i = 0; i < chunks.length; i++) {
            combined.set(chunks[i], offset);
            offset += chunks[i].length;
        }

        var nativeSampleRate = audioContext ? audioContext.sampleRate : 16000;
        if (nativeSampleRate !== 16000) {
            combined = downsampleTo16k(combined, nativeSampleRate);
        }

        var durationSec = (combined.length / 16000).toFixed(1);
        pendingTranscriptions++;
        console.log('Submitting command candidate: ' + combined.length + ' samples @ 16kHz, ~' + durationSec + 's');

        socket.emit('audio_data', {
            audio: combined.buffer,
            sample_rate: 16000,
            command_only: true,
        });
    }

    function submitSpeculative() {
        // Send a snapshot of the current audio for early transcription
        // while the adaptive silence window continues.  Audio chunks are
        // NOT consumed — if the user resumes speaking the speculative
        // result is discarded and the full audio is submitted later.
        if (audioChunks.length === 0) return;

        var totalLength = 0;
        for (var i = 0; i < audioChunks.length; i++) {
            totalLength += audioChunks[i].length;
        }
        var combined = new Float32Array(totalLength);
        var offset = 0;
        for (var i = 0; i < audioChunks.length; i++) {
            combined.set(audioChunks[i], offset);
            offset += audioChunks[i].length;
        }

        var nativeSampleRate = audioContext ? audioContext.sampleRate : 16000;
        if (nativeSampleRate !== 16000) {
            combined = downsampleTo16k(combined, nativeSampleRate);
        }

        var durationSec = (combined.length / 16000).toFixed(1);
        pendingTranscriptions++;
        speculativeSent = true;
        console.log('Submitting speculative transcription: ~' + durationSec + 's (gen ' + speculativeGen + ')');

        socket.emit('audio_data', {
            audio: combined.buffer,
            sample_rate: 16000,
            speculative_gen: speculativeGen,
        });
    }

    function finalizeSpeculative() {
        // Use a speculative transcription result that arrived before
        // the adaptive silence threshold was reached.
        var text = speculativeText;
        audioChunks = [];
        vadState = 'silence';
        speechStartTime = 0;
        lastSpeechTime = 0;
        speculativeSent = false;
        speculativeText = null;
        awaitingSpeculative = false;

        if (!text) return;
        var lower = text.toLowerCase().replace(/[^a-z]/g, '');
        if (lower === 'mute') {
            deactivateVoice();
            return;
        }
        sendText(text);
    }

    function submitUtterance() {
        // Grab the current audio and reset VAD, but keep listening — the
        // transcription happens asynchronously in the background so the
        // user is never blocked from speaking.
        var chunks = audioChunks;
        audioChunks = [];
        vadState = 'silence';
        speechStartTime = 0;
        lastSpeechTime = 0;

        if (chunks.length === 0) return;

        // Combine all chunks into one Float32Array
        var totalLength = 0;
        for (var i = 0; i < chunks.length; i++) {
            totalLength += chunks[i].length;
        }
        var combined = new Float32Array(totalLength);
        var offset = 0;
        for (var i = 0; i < chunks.length; i++) {
            combined.set(chunks[i], offset);
            offset += chunks[i].length;
        }

        var nativeSampleRate = audioContext ? audioContext.sampleRate : 16000;

        // Downsample to 16kHz on the client — sends 2-3x less data over the
        // socket and eliminates server-side resampling entirely.
        if (nativeSampleRate !== 16000) {
            combined = downsampleTo16k(combined, nativeSampleRate);
        }

        var durationSec = (combined.length / 16000).toFixed(1);

        pendingTranscriptions++;
        console.log('Submitting audio: ' + combined.length + ' samples @ 16kHz, ~' + durationSec + 's (' + pendingTranscriptions + ' pending)');

        // Safety timeout — log a warning if transcription is very slow
        setTimeout(function () {
            if (pendingTranscriptions > 0) {
                console.warn('Transcription still pending after ' + TRANSCRIPTION_TIMEOUT_MS + 'ms');
            }
        }, TRANSCRIPTION_TIMEOUT_MS);

        socket.emit('audio_data', {
            audio: combined.buffer,
            sample_rate: 16000,
        });

        // Listening continues uninterrupted — VAD was reset above,
        // noise floor will re-calibrate from the next silent chunks.
    }

    function deactivateVoice() {
        voiceActive = false;
        listening = false;
        voiceBtn.classList.remove('active');
        // Don't reset inSilenceMode — silence mode persists through mic mute/unmute
        setStatus('Microphone off. Click mic to resume.');

        stopServerAudio();
        pendingTranscriptions = 0;
        if (scriptProcessor) { scriptProcessor.disconnect(); scriptProcessor = null; }
        if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
        if (mediaStream) {
            mediaStream.getTracks().forEach(function (t) { t.stop(); });
            mediaStream = null;
        }
        if (audioContext) {
            audioContext.close();
            audioContext = null;
        }
        audioChunks = [];
        preBuffer = [];
        vadState = 'silence';
        speechStartTime = 0;
        lastSpeechTime = 0;
        noiseFloor = 0.005;
        noiseSamples = 0;
        ttsSpeaking = false;
        ttsMismatchStart = 0;
        bargeInCount = 0;
        speculativeSent = false;
        speculativeText = null;
        awaitingSpeculative = false;
    }

    socket.on('transcription', function (data) {
        pendingTranscriptions = Math.max(0, pendingTranscriptions - 1);

        var text = (data.text || '').trim();
        var commandOnly = data.command_only || false;
        var specGen = data.speculative_gen;
        console.log('Transcription received:', text || '(empty)',
            specGen !== undefined ? '(speculative gen ' + specGen + ')' : '',
            commandOnly ? '(command candidate)' : '',
            data.error ? 'error: ' + data.error : '',
            '(' + pendingTranscriptions + ' still pending)');

        // Handle speculative transcription results
        if (specGen !== undefined) {
            if (specGen !== speculativeGen) return; // stale, ignore
            if (awaitingSpeculative) {
                // Adaptive threshold already passed — use immediately
                awaitingSpeculative = false;
                if (text) {
                    var lower = text.toLowerCase().replace(/[^a-z]/g, '');
                    if (lower === 'mute') { deactivateVoice(); return; }
                    sendText(text);
                }
            } else {
                // Store for when the adaptive threshold is reached
                speculativeText = text;
            }
            return;
        }

        if (text) {
            // Voice command: "mute" disables the microphone
            var lower = text.toLowerCase().replace(/[^a-z]/g, '');
            if (lower === 'mute') {
                deactivateVoice();
                return;
            }
            // Command-only transcriptions are discarded unless they
            // match a recognised command — they were too short for normal
            // speech and only sent speculatively.  Hold/wait phrases are
            // forwarded so the LLM can trigger silence mode.  Resume
            // phrases are forwarded during silence mode to exit it.
            if (commandOnly) {
                if (inSilenceMode && isResumeCommand(text)) { sendText(text); return; }
                if (isHoldCommand(text)) sendText(text);
                return;
            }
            sendText(text);
        }
    });

    // ---- Voice Output ----

    function speak(text, audioBytes) {
        // Try server-generated audio first, fall back to browser speechSynthesis
        if (audioBytes && audioContext) {
            playServerAudio(audioBytes, text);
        } else {
            speakBrowser(text);
        }
    }

    function speakBrowser(text) {
        if (!synth) return;
        synth.cancel();

        var utterance = new SpeechSynthesisUtterance(text);
        utterance.rate = ttsRate / 180;  // convert WPM to browser rate (180 WPM ≈ 1.0)
        utterance.pitch = 0.85;

        // Look up voice fresh by name — Safari voice object references can
        // go stale after voiceschanged, causing silent fallback to system default.
        if (preferredVoice) {
            var freshVoices = synth.getVoices();
            for (var i = 0; i < freshVoices.length; i++) {
                if (freshVoices[i].name === preferredVoice.name) {
                    utterance.voice = freshVoices[i];
                    break;
                }
            }
        }

        ttsSpeaking = true;
        utterance.onend = function () {
            setTimeout(function () { ttsSpeaking = false; }, TTS_COOLDOWN_MS);
        };
        utterance.onerror = function () {
            setTimeout(function () { ttsSpeaking = false; }, TTS_COOLDOWN_MS);
        };

        synth.speak(utterance);
    }

    function playServerAudio(audioBytes, fallbackText) {
        stopServerAudio();
        if (synth) synth.cancel();

        // audioBytes may be an ArrayBuffer or a binary blob from Socket.IO
        var buffer = audioBytes instanceof ArrayBuffer ? audioBytes : audioBytes.buffer || audioBytes;

        ttsSpeaking = true;
        serverAudioPlaying = true;

        audioContext.decodeAudioData(buffer.slice(0), function (decoded) {
            serverAudioSource = audioContext.createBufferSource();
            serverAudioSource.buffer = decoded;
            serverAudioSource.connect(audioContext.destination);
            serverAudioSource.onended = function () {
                serverAudioPlaying = false;
                serverAudioSource = null;
                setTimeout(function () { ttsSpeaking = false; }, TTS_COOLDOWN_MS);
            };
            serverAudioSource.start(0);
        }, function (err) {
            console.warn('Server audio decode failed, falling back to browser TTS:', err);
            serverAudioPlaying = false;
            ttsSpeaking = false;
            if (fallbackText) speakBrowser(fallbackText);
        });
    }

    function stopServerAudio() {
        if (serverAudioSource) {
            try { serverAudioSource.stop(); } catch (e) { /* already stopped */ }
            serverAudioSource = null;
        }
        serverAudioPlaying = false;
    }

    // ---- Timer ----

    function startTimer() {
        timerInterval = setInterval(updateTimer, 1000);
    }

    function stopTimer() {
        if (timerInterval) {
            clearInterval(timerInterval);
            timerInterval = null;
        }
    }

    function updateTimer() {
        if (!sessionStart) return;
        var elapsed = Math.floor((Date.now() - sessionStart) / 1000);
        var hours = Math.floor(elapsed / 3600);
        var minutes = Math.floor((elapsed % 3600) / 60);
        var seconds = elapsed % 60;
        var pad = function (n) { return (n < 10 ? '0' : '') + n; };
        if (hours > 0) {
            timerEl.textContent = hours + ':' + pad(minutes) + ':' + pad(seconds);
        } else {
            timerEl.textContent = minutes + ':' + pad(seconds);
        }
    }

    // ---- End Session ----

    function endSession() {
        if (!sessionActive) return;

        if (voiceActive) {
            deactivateVoice();
        }

        socket.emit('end_session');
    }

    // ---- Start ----

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
