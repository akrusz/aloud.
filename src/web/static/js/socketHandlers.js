/* socketHandlers.js — all socket.on() event handlers */

import { state, dom, socket } from './state.js';
import { addMessage, addContinuation, showTyping, hideTyping, scrollToBottom, stopTimer, setStatus, showErrorToast } from './ui.js';
import { speak, stopServerAudio } from './tts.js';
import { handleTranscription, applySessionConfig } from './audio.js';
import { buildVoiceList } from './voice.js';
import { notingState, stopCircle } from './noting.js';

export function registerSocketHandlers(deactivateVoiceFn) {

    // Handle reconnection — only fires on reconnects, not the initial connect.
    socket.on('connect', function () {
        if (!state.initialConnectDone) {
            state.initialConnectDone = true;
            return;
        }
        if (state.sessionActive && state.sessionId) {
            console.log('Socket reconnected — re-registering session', state.sessionId);
            socket.emit('start_session', { session_id: state.sessionId });
        }
    });

    socket.on('session_config', function (cfg) {
        applySessionConfig(cfg);
        // Rebuild voice list now that we know the engine (filters out browser voices for server engines)
        if (cfg.tts_engine) buildVoiceList();
    });

    socket.on('session_history', function (data) {
        var exchanges = data.exchanges || [];
        addContinuation(exchanges);
    });

    socket.on('facilitator_message', function (data) {
        hideTyping();
        addMessage('facilitator', data.text);
        if (dom.ttsToggle.classList.contains('active')) {
            // If voice isn't active yet (e.g. opener arrives before mic
            // permission is granted), queue the speech for later.
            if (state.voiceActive) {
                speak(data.text, data.audio);
            } else {
                state.queuedSpeech = data.text;
                state.queuedAudio = data.audio || null;
            }
        }
    });

    socket.on('facilitator_typing', function (data) {
        if (data.typing) {
            showTyping();
        } else {
            hideTyping();
        }
    });

    socket.on('session_ended', function (data) {
        if (notingState.active) stopCircle();
        state.sessionActive = false;
        window._glooowSessionActive = false;
        stopTimer();

        // If update was pending, show update modal after session ends
        if (window._glooowPendingUpdate) {
            window._glooowPendingUpdate = false;
            dom.savingOverlay.classList.add('hidden');
            if (window._glooowShowUpdateModal) {
                window._glooowShowUpdateModal();
                return;
            }
        }

        // If navigating away (New Session / History), go immediately
        if (state.pendingNavigation) {
            var dest = state.pendingNavigation;
            state.pendingNavigation = null;
            window.location.href = dest;
            return;
        }

        dom.endedOverlay.classList.remove('hidden');
    });

    socket.on('silence_mode', function (data) {
        state.inSilenceMode = data.active;
        dom.listenBtn.classList.toggle('active', data.active);
        if (data.active) {
            state.silenceBuffer = [];
            setStatus("Holding space\u2026 say something like \u2018I\u2019m ready\u2019 to resume");
            if (dom.orbEl && !dom.kasinaToggle.checked) dom.orbEl.classList.add('orb-holding');
        } else {
            state.silenceBuffer = [];
            setStatus("Speak naturally, or say 'mute' to turn off mic");
            if (dom.orbEl) dom.orbEl.classList.remove('orb-holding');
        }
    });

    socket.on('resume_detected', function () {
        if (!state.inSilenceMode) return;
        var combined = state.silenceBuffer.join(' ... ');
        state.silenceBuffer = [];
        state.inSilenceMode = false;
        dom.listenBtn.classList.remove('active');
        socket.emit('user_message', { text: combined });
    });

    socket.on('error', function (data) {
        console.error('Server error:', data.message);
        if (data.message) {
            showErrorToast(data.message);
        }
    });

    socket.on('transcription', function (data) {
        handleTranscription(data);
    });

    // STT model download/loading progress
    socket.on('stt_progress', function (data) {
        var phase = data.phase || '';
        var pct = Math.round((data.progress || 0) * 100);
        if (phase === 'downloading') {
            setStatus('Downloading speech model\u2026 ' + pct + '%');
        } else if (phase === 'loading') {
            setStatus('Loading speech model\u2026');
        }
    });

    socket.on('stt_ready', function () {
        setStatus('Ready');
    });

    socket.on('stt_error', function (data) {
        showErrorToast('Speech model failed: ' + (data.error || 'unknown error'));
    });
}
