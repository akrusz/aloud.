/* Session page — orchestrator module.
   Imports all sub-modules, runs init(), wires DOM events. */

import { state, dom, socket, initDOM } from './state.js';
import { initVoices, openVoiceModal, closeVoiceModal, previewVoice, selectVoice } from './voice.js';
import { activateVoice, deactivateVoice, toggleVoice, toggleListenMode, initAudio } from './audio.js';
import { speak, stopServerAudio } from './tts.js';
import { registerSocketHandlers } from './socketHandlers.js';
import {
    addMessage, scrollToBottom, startTimer, stopTimer, setStatus,
    setEmberLevel, regenerateEmbers, showConfirm, hideConfirm,
    endSession, doEndSession,
} from './ui.js';
import { initNoting, startCircle, stopCircle, handleUserNote, notingState } from './noting.js';

// ---- Messaging ----

function sendText(text) {
    if (!text || !state.sessionActive) return;

    // Noting mode: route through the noting circle
    if (notingState.active) {
        handleUserNote(text);
        return;
    }

    // During silence mode, buffer speech instead of submitting.
    if (state.inSilenceMode) {
        state.silenceBuffer.push(text);
        addMessage('user', text);
        setStatus("Holding space\u2026 say something like \u2018I\u2019m ready\u2019 to resume");
        socket.emit('check_resume_intent', { text: text });
        return;
    }

    addMessage('user', text);
    socket.emit('user_message', { text: text });
}

// ---- Initialize ----

function init() {
    initDOM();

    // Wire audio module's sendText callback
    initAudio(sendText);

    // Voice system (fetch server voices, browser voiceschanged)
    initVoices();

    // Socket event handlers
    registerSocketHandlers(deactivateVoice);

    const params = JSON.parse(sessionStorage.getItem('sessionParams') || '{}');

    // Generate a stable session ID that survives socket reconnections
    state.sessionId = 'ses-' + Date.now() + '-' + Math.random().toString(36).substr(2, 9);
    params.session_id = state.sessionId;
    params.tts = dom.ttsToggle.classList.contains('active');

    // Event listeners
    dom.voiceBtn.addEventListener('click', toggleVoice);
    dom.listenBtn.addEventListener('click', toggleListenMode);
    dom.ttsToggle.addEventListener('click', function () {
        dom.ttsToggle.classList.toggle('active');
        if (!dom.ttsToggle.classList.contains('active')) {
            stopServerAudio();
            if (state.synth) state.synth.cancel();
            state.ttsSpeaking = false;
        }
    });
    dom.endBtn.addEventListener('click', function (e) {
        e.preventDefault();
        endSession(deactivateVoice);
    });
    dom.newSessionBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!state.sessionActive) { window.location.href = '/'; return; }
        socket.emit('prefetch_summary');
        showConfirm('Start a new session? This will end your current session.', function () {
            state.pendingNavigation = '/';
            dom.savingOverlay.style.display = 'flex';
            doEndSession(deactivateVoice);
        });
    });
    dom.historyBtn.addEventListener('click', function (e) {
        e.preventDefault();
        if (!state.sessionActive) { window.location.href = '/history'; return; }
        socket.emit('prefetch_summary');
        showConfirm('Leave session to view history? This will end your current session.', function () {
            state.pendingNavigation = '/history';
            dom.savingOverlay.style.display = 'flex';
            doEndSession(deactivateVoice);
        });
    });

    // Restore saved speed
    var savedSpeed = localStorage.getItem('glooow-speed');
    if (savedSpeed) {
        dom.speedSlider.value = savedSpeed;
        dom.modalSpeedSlider.value = savedSpeed;
        state.ttsRate = parseInt(savedSpeed);
    }

    dom.speedSlider.addEventListener('input', function () {
        state.ttsRate = parseInt(dom.speedSlider.value);
        dom.modalSpeedSlider.value = dom.speedSlider.value;
        localStorage.setItem('glooow-speed', dom.speedSlider.value);
        socket.emit('set_tts_rate', { rate: state.ttsRate });
    });
    dom.modalSpeedSlider.addEventListener('input', function () {
        state.ttsRate = parseInt(dom.modalSpeedSlider.value);
        dom.speedSlider.value = dom.modalSpeedSlider.value;
        localStorage.setItem('glooow-speed', dom.modalSpeedSlider.value);
        socket.emit('set_tts_rate', { rate: state.ttsRate });
    });
    dom.voicePickerBtn.addEventListener('click', function () { openVoiceModal(deactivateVoice); });
    dom.voiceModalClose.addEventListener('click', function () { closeVoiceModal(true, activateVoice); });
    dom.voiceModal.addEventListener('click', function (e) {
        // Close on backdrop click (not on the modal itself)
        if (e.target === dom.voiceModal) closeVoiceModal(true, activateVoice);
    });
    dom.voiceModalList.addEventListener('click', function (e) {
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
    dom.orbEl.addEventListener('click', function (e) {
        if (!dom.kasinaToggle.checked && !state.orbDragging) {
            e.stopPropagation();
            dom.kasinaToggle.checked = true;
            dom.kasinaToggle.dispatchEvent(new Event('change'));
        }
    });

    dom.kasinaToggle.addEventListener('change', function () {
        // Capture current visual state while CSS animations are still running
        var cs = getComputedStyle(dom.orbEl);
        var startOpacity = cs.opacity;
        var startFilter = cs.filter;
        var startBoxShadow = cs.boxShadow;
        var startBackground = cs.background;

        // FIRST — snapshot current orb position
        var first = dom.orbEl.getBoundingClientRect();

        // Pause CSS animations so they don't fight the transition
        dom.orbEl.style.animation = 'none';

        // Apply the layout change
        if (dom.kasinaToggle.checked) {
            dom.orbEl.classList.remove('orb-breathing', 'orb-nav');
            dom.orbEl.classList.add('orb-kasina');
            document.body.appendChild(dom.orbEl);
            dom.sessionContainer.classList.add('kasina-active');
            // Force dark mode for kasina (save current theme to restore later)
            var currentTheme = document.documentElement.getAttribute('data-theme');
            if (currentTheme !== 'dark') {
                dom.kasinaToggle._prevTheme = currentTheme;
                document.documentElement.setAttribute('data-theme', 'dark');
            }
        } else {
            dom.orbEl.classList.remove('orb-kasina', 'orb-rainbow');
            state.orbRainbow = false;
            dom.orbEl.classList.add('orb-breathing', 'orb-nav');
            // Clear any drag positioning before moving back to nav
            dom.orbEl.style.left = '';
            dom.orbEl.style.top = '';
            dom.orbEl.style.inset = '';
            dom.orbEl.style.margin = '';
            dom.orbEl.style.cursor = '';
            document.querySelector('.nav-session-info').prepend(dom.orbEl);
            dom.sessionContainer.classList.remove('kasina-active');
            // Restore previous theme
            if (dom.kasinaToggle._prevTheme) {
                document.documentElement.setAttribute('data-theme', dom.kasinaToggle._prevTheme);
                dom.kasinaToggle._prevTheme = null;
            }
        }

        // Capture target visual state with animation at 0% for seamless handoff.
        dom.orbEl.style.animation = '';
        var cs2 = getComputedStyle(dom.orbEl);
        var endOpacity = cs2.opacity;
        var endFilter = cs2.filter;
        var endBoxShadow = cs2.boxShadow;
        var endBackground = cs2.background;
        var endMatrix = cs2.transform;
        var endScale = 1;
        if (endMatrix && endMatrix !== 'none') {
            var m = endMatrix.match(/matrix\(([^,]+)/);
            if (m) endScale = parseFloat(m[1]);
        }
        dom.orbEl.style.animation = 'none';

        // LAST — snapshot new position
        var last = dom.orbEl.getBoundingClientRect();

        // INVERT — calculate delta between old and new center
        var dx = first.left + first.width / 2 - (last.left + last.width / 2);
        var dy = first.top + first.height / 2 - (last.top + last.height / 2);
        var scale = first.width / last.width;

        // PLAY — animate from old position/appearance to new
        var anim = dom.orbEl.animate([
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

        anim.onfinish = function () {
            dom.orbEl.style.animation = '';
            requestAnimationFrame(function () {
                anim.cancel();
            });
        };
    });

    // Ember level controls
    document.getElementById('ember-minus').addEventListener('click', function () {
        setEmberLevel(Math.max(0, state.emberLevel - 1));
    });
    document.getElementById('ember-plus').addEventListener('click', function () {
        setEmberLevel(Math.min(4, state.emberLevel + 1));
    });
    dom.emberBlocks.addEventListener('click', function (e) {
        var block = e.target.closest('.ember-block');
        if (!block) return;
        var clicked = parseInt(block.dataset.level);
        setEmberLevel(clicked === state.emberLevel ? 0 : clicked);
    });

    // ---- Kasina drag + click-outside ----

    var orbDragStartX = 0, orbDragStartY = 0;
    var shakeHistory = [];
    state.orbRainbow = false;

    function startOrbDrag(clientX, clientY) {
        if (!dom.kasinaToggle.checked) return;
        state.orbDragging = true;
        state.orbMoved = false;

        var rect = dom.orbEl.getBoundingClientRect();

        // Switch from inset centering to explicit left/top
        dom.orbEl.style.inset = 'auto';
        dom.orbEl.style.margin = '0';
        dom.orbEl.style.left = rect.left + 'px';
        dom.orbEl.style.top = rect.top + 'px';
        dom.orbEl.style.cursor = 'grabbing';

        orbDragStartX = clientX - rect.left;
        orbDragStartY = clientY - rect.top;
    }

    function moveOrbDrag(clientX, clientY) {
        if (!state.orbDragging) return;
        state.orbMoved = true;
        dom.orbEl.style.left = (clientX - orbDragStartX) + 'px';
        dom.orbEl.style.top = (clientY - orbDragStartY) + 'px';

        // Record position for shake detection
        var now = Date.now();
        shakeHistory.push({ x: clientX, y: clientY, time: now });
        // Prune entries older than 500ms
        while (shakeHistory.length && now - shakeHistory[0].time > 500) {
            shakeHistory.shift();
        }
        // Detect shake: count direction reversals with sufficient distance
        if (shakeHistory.length >= 3) {
            var reversals = 0;
            for (var i = 2; i < shakeHistory.length; i++) {
                var dx1 = shakeHistory[i - 1].x - shakeHistory[i - 2].x;
                var dy1 = shakeHistory[i - 1].y - shakeHistory[i - 2].y;
                var dx2 = shakeHistory[i].x - shakeHistory[i - 1].x;
                var dy2 = shakeHistory[i].y - shakeHistory[i - 1].y;
                var dist = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                // Check for direction reversal with enough movement
                if (dist > 10 && (dx1 * dx2 + dy1 * dy2) < 0) {
                    reversals++;
                }
            }
            if (reversals >= 2) {
                var now = Date.now();
                if (!state._rainbowCooldownUntil || now >= state._rainbowCooldownUntil) {
                    state.orbRainbow = !state.orbRainbow;
                    dom.orbEl.classList.toggle('orb-rainbow', state.orbRainbow);
                    state._rainbowCooldownUntil = now + 2000;
                }
                shakeHistory = [];
            }
        }
    }

    function endOrbDrag() {
        if (!state.orbDragging) return;
        state.orbDragging = false;
        dom.orbEl.style.cursor = '';
    }

    // Mouse drag
    dom.orbEl.addEventListener('mousedown', function (e) {
        if (!dom.kasinaToggle.checked) return;
        e.preventDefault();
        startOrbDrag(e.clientX, e.clientY);
    });
    document.addEventListener('mousemove', function (e) { moveOrbDrag(e.clientX, e.clientY); });
    document.addEventListener('mouseup', endOrbDrag);

    // Touch drag
    dom.orbEl.addEventListener('touchstart', function (e) {
        if (!dom.kasinaToggle.checked) return;
        e.preventDefault();
        startOrbDrag(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: false });
    document.addEventListener('touchmove', function (e) {
        if (state.orbDragging) moveOrbDrag(e.touches[0].clientX, e.touches[0].clientY);
    });
    document.addEventListener('touchend', endOrbDrag);

    // Click outside orb exits kasina mode
    document.addEventListener('click', function (e) {
        if (!dom.kasinaToggle.checked || state.orbDragging) return;
        // Suppress if the user just finished dragging
        if (state.orbMoved) { state.orbMoved = false; return; }
        // Don't exit if clicking on controls
        if (e.target.closest('.input-area, .input-controls, .nav')) return;
        // Check if click is near the orb (within glow radius)
        var rect = dom.orbEl.getBoundingClientRect();
        var cx = rect.left + rect.width / 2;
        var cy = rect.top + rect.height / 2;
        var ddx = e.clientX - cx;
        var ddy = e.clientY - cy;
        if (Math.sqrt(ddx * ddx + ddy * ddy) < 100) return;
        // Exit kasina mode
        dom.kasinaToggle.checked = false;
        dom.kasinaToggle.dispatchEvent(new Event('change'));
    });

    // Initialize embers at default level
    setEmberLevel(state.emberLevel);

    // Confirm dialog buttons
    dom.confirmYes.addEventListener('click', function () {
        dom.confirmOverlay.style.display = 'none';
        if (state.pendingConfirmAction) {
            var action = state.pendingConfirmAction;
            state.pendingConfirmAction = null;
            action();
        }
    });
    dom.confirmNo.addEventListener('click', function () {
        hideConfirm();
    });

    // Pass saved voice so the server knows the voice from the first message
    var savedVoice = localStorage.getItem('glooow-voice');
    if (savedVoice) params.voice_name = savedVoice;

    // Start session
    socket.emit('start_session', params);
    state.sessionActive = true;
    // Expose for update indicator in base.html
    window._glooowSessionActive = true;
    window._glooowConfirmEnd = function() {
        showConfirm('End session to install update?', function () {
            dom.savingOverlay.style.display = 'flex';
            doEndSession(deactivateVoice);
            window._glooowPendingUpdate = true;
        });
    };
    state.sessionStart = Date.now();
    startTimer();

    // Clear continuation flags so they don't persist
    sessionStorage.removeItem('continueFrom');
    sessionStorage.removeItem('continueFromSummary');

    // Initialize noting mode if applicable
    var isNoting = params.meditation_type === 'noting';
    if (isNoting) {
        initNoting(params.participants || [], params.userTurnCue || false, sendText, params.userTurnCueSound || null);

        // Start the circle after the opener TTS finishes playing.
        // We register a one-shot callback (state.onTtsDone) that fires
        // when TTS playback completes — no polling needed.
        var circleStarted = false;

        function onOpenerDone() {
            if (circleStarted) return;
            circleStarted = true;
            setTimeout(function () { startCircle(); }, 1500);
        }

        // Set the callback BEFORE the facilitator_message arrives so it's
        // in place whether speak() runs immediately or speech is queued.
        state.onTtsDone = onOpenerDone;

        // Safety: if TTS never fires (toggle off, broken synth, no audio),
        // start the circle after 15s.
        setTimeout(function () { onOpenerDone(); }, 15000);
    }

    // Auto-activate voice
    activateVoice();
}

// ---- Start ----

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
