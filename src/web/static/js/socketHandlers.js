/* socketHandlers.js — all socket.on() event handlers */

import { state, dom, socket } from './state.js';
import { addMessage, addContinuation, showTyping, hideTyping, setFacilitatorStatus, scrollToBottom, stopTimer, setStatus, showErrorToast } from './ui.js';
import { speak, stopServerAudio, queueAudioChunk } from './tts.js';
import { handleTranscription, applySessionConfig } from './audio.js';
import { buildVoiceList } from './voice.js';
import { notingState, stopCircle } from './noting.js';
import { releaseWakeLock } from './wakelock.js';

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
        setFacilitatorStatus(null);
        addMessage('facilitator', data.text);
        if (dom.ttsToggle.classList.contains('active')) {
            if (data.audio) {
                // Audio included inline (e.g. opener) — play immediately
                if (state.voiceActive) {
                    speak(data.text, data.audio);
                } else {
                    state.queuedSpeech = data.text;
                    state.queuedAudio = data.audio;
                }
            } else {
                // No audio — chunked audio will arrive via facilitator_audio.
                // Set a fallback timer for browser TTS if audio never comes.
                state._pendingSpeechText = data.text;
                state._pendingSpeechTimer = setTimeout(function() {
                    if (state._pendingSpeechText) {
                        var txt = state._pendingSpeechText;
                        state._pendingSpeechText = null;
                        if (state.voiceActive) {
                            speak(txt, null);
                        } else {
                            state.queuedSpeech = txt;
                            state.queuedAudio = null;
                        }
                    }
                }, 8000);
            }
        }
    });

    socket.on('facilitator_audio', function (data) {
        // Chunked server audio — queue for sequential playback
        if (state._pendingSpeechTimer) {
            clearTimeout(state._pendingSpeechTimer);
            state._pendingSpeechTimer = null;
        }
        state._pendingSpeechText = null;
        if (dom.ttsToggle.classList.contains('active') && state.voiceActive && data.audio) {
            queueAudioChunk(data.audio);
        }
    });

    socket.on('facilitator_typing', function (data) {
        if (data.typing) {
            showTyping();
        } else {
            hideTyping();
            setFacilitatorStatus(null);
        }
    });

    socket.on('facilitator_status', function (data) {
        // Transient hint shown alongside the typing indicator (e.g. "Loading
        // model into memory…" on the first hit of an Ollama model).
        setFacilitatorStatus(data && data.message ? data.message : null);
    });

    socket.on('session_ended', function (data) {
        if (notingState.active) stopCircle();
        state.sessionActive = false;
        window._aloudSessionActive = false;
        delete document.body.dataset.sessionActive;
        window._aloudRequestEndSession = null;
        window._aloudRequestEnd = null;
        window._aloudRequestHistory = null;
        releaseWakeLock();
        stopTimer();

        // If update was pending, show update modal after session ends
        if (window._aloudPendingUpdate) {
            window._aloudPendingUpdate = false;
            dom.savingOverlay.classList.add('hidden');
            if (window._aloudShowUpdateModal) {
                window._aloudShowUpdateModal();
                return;
            }
        }

        var dest = state.pendingNavigation || '/';
        state.pendingNavigation = null;
        window.location.href = dest;
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
