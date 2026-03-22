/* audio.js — audio capture, VAD state machine, speculative transcription,
   barge-in detection, utterance submission */

import { state, dom, socket } from './state.js';
import { stopServerAudio, speak, TTS_COOLDOWN_MS } from './tts.js';
import { setStatus } from './ui.js';
import { notingState } from './noting.js';

// ---- VAD constants ----

export var SILENCE_THRESHOLD = 0.015; // RMS level below which counts as silence
export var SILENCE_DURATION = 3000;   // ms of silence before auto-submitting (base)
export var SILENCE_DURATION_MAX = 7000; // ms — cap for adaptive silence tolerance

// Allow server to override silence timing via session_config event
export function applySessionConfig(cfg) {
    if (cfg.silence_base_ms != null) SILENCE_DURATION = cfg.silence_base_ms;
    if (cfg.silence_max_ms != null) SILENCE_DURATION_MAX = cfg.silence_max_ms;
}
export var SILENCE_RAMP_RATE = 0.12;  // extra silence ms per ms of speech (ramps from base to max)
export var PRE_BUFFER_CHUNKS = 20;    // ~2s of audio to keep before speech onset
export var MIN_SPEECH_DURATION = 500; // ms — reject sounds shorter than this
export var MIN_UTTERANCE_DURATION = 4000; // ms — don't submit until this long after speech onset
export var MIN_UTTERANCE_DURATION_SILENCE = 800; // ms — lower threshold during silence mode
export var NOISE_REJECT_MS = 200;     // ms — abort speech_started if silence exceeds this
export var TTS_WATCHDOG_MS = 1500;    // force-reset ttsSpeaking if synth stopped this long ago
export var BARGE_IN_THRESHOLD = 0.04; // RMS energy to detect user speaking over TTS
export var BARGE_IN_CHUNKS = 3;       // consecutive chunks required (~280ms at 44.1kHz)
export var TRANSCRIPTION_TIMEOUT_MS = 15000; // warn if transcription takes too long

// ---- Noting-mode overrides (short labels need snappy detection) ----
var SILENCE_DURATION_NOTING = 1000;         // 1s silence for quick noting words
var MIN_UTTERANCE_DURATION_NOTING = 800;    // 0.8s min — noting labels are very short

// ---- Internal refs ----

// sendText callback — set by init to avoid circular imports
var _sendText = null;

export function initAudio(sendTextFn) {
    _sendText = sendTextFn;
}

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
    var alpha = state.noiseSamples < 100 ? 0.1 : 0.01;
    state.noiseFloor = (1 - alpha) * state.noiseFloor + alpha * energy;
    state.noiseSamples++;
}

// ---- Voice Input (server-side Whisper via AudioContext) ----

export function toggleVoice() {
    if (state.voiceActive) {
        deactivateVoice();
    } else {
        activateVoice();
    }
}

export function toggleListenMode() {
    if (state.inSilenceMode) {
        // Exit: send buffered text if any, then resume normal mode
        state.inSilenceMode = false;
        dom.listenBtn.classList.remove('active');
        if (state.silenceBuffer.length > 0) {
            var combined = state.silenceBuffer.join(' ... ');
            state.silenceBuffer = [];
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
        state.inSilenceMode = true;
        state.silenceBuffer = [];
        dom.listenBtn.classList.add('active');
        setStatus("Holding space\u2026 say something like \u2018I\u2019m ready\u2019 to resume");
        var orb = document.getElementById('orb');
        if (orb && !dom.kasinaToggle.checked) orb.classList.add('orb-holding');
    }
}

export function activateVoice() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
        state.mediaStream = stream;
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();

        // Build the audio pipeline once — it stays connected for the
        // entire voice-active session.
        state.sourceNode = state.audioContext.createMediaStreamSource(state.mediaStream);
        state.scriptProcessor = state.audioContext.createScriptProcessor(4096, 1, 1);

        state.scriptProcessor.onaudioprocess = function (e) {
            processAudio(e);
        };

        state.sourceNode.connect(state.scriptProcessor);
        state.scriptProcessor.connect(state.audioContext.destination);

        state.voiceActive = true;
        dom.voiceBtn.classList.add('active');
        socket.emit('voice_mute', { muted: false });
        var orb = document.getElementById('orb');
        if (orb) orb.classList.remove('orb-muted');

        // Speak any opener that was queued before mic permission was granted
        if (state.queuedSpeech && dom.ttsToggle.classList.contains('active')) {
            speak(state.queuedSpeech, state.queuedAudio);
            state.queuedSpeech = null;
            state.queuedAudio = null;
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
    if (!state.voiceActive || !state.audioContext || !state.mediaStream) return;

    // Reset VAD state fully (including noise floor) so each exchange
    // starts clean — prevents TTS residue from inflating the threshold.
    state.audioChunks = [];
    state.listening = true;
    state.vadState = 'silence';
    state.speechStartTime = 0;
    state.lastSpeechTime = 0;
    state.noiseFloor = 0.005;
    state.noiseSamples = 0;
    state.pendingTranscriptions = 0;
    state.bargeInCount = 0;
    state.speculativeSent = false;
    state.speculativeText = null;
    state.awaitingSpeculative = false;

    if (state.inSilenceMode) {
        setStatus("Holding space\u2026 say something like \u2018I\u2019m ready\u2019 to resume");
    } else {
        setStatus("Speak naturally, or say 'mute' to turn off mic");
    }
}

export function isHoldCommand(text) {
    var lower = text.toLowerCase();
    return /\b(hold|wait|one moment|one sec|hang on|just a)\b/.test(lower);
}

// ---- VAD state machine (processAudio) ----

function processAudio(e) {
    // ---- TTS watchdog ----
    if (state.ttsSpeaking) {
        var synthDone = state.synth ? !state.synth.speaking : true;
        var serverDone = !state.serverAudioPlaying;
        if (synthDone && serverDone) {
            if (state.ttsMismatchStart === 0) {
                state.ttsMismatchStart = Date.now();
            } else if (Date.now() - state.ttsMismatchStart > TTS_WATCHDOG_MS) {
                console.warn('TTS watchdog: resetting stuck ttsSpeaking flag');
                state.ttsSpeaking = false;
                state.ttsMismatchStart = 0;
            }
        } else {
            state.ttsMismatchStart = 0;
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

    // Update mic button glow based on audio level
    var rawLevel = Math.min(energy / 0.08, 1);
    state.smoothedLevel = state.smoothedLevel * 0.7 + rawLevel * 0.3;
    dom.voiceBtn.style.setProperty('--mic-level', state.smoothedLevel);

    // ---- Barge-in detection during TTS ----
    var synthActive = state.ttsSpeaking || (state.synth && state.synth.speaking) || state.serverAudioPlaying;
    if (synthActive) {
        if (energy > BARGE_IN_THRESHOLD) {
            state.bargeInCount++;
            if (state.bargeInCount >= BARGE_IN_CHUNKS) {
                console.log('Barge-in detected, cancelling TTS');
                stopServerAudio();
                if (state.synth) state.synth.cancel();
                state.ttsSpeaking = false;
                state.ttsMismatchStart = 0;
                state.bargeInCount = 0;
                state.preBuffer = [chunk];
                // Fall through to normal VAD below
            } else {
                return;
            }
        } else {
            state.bargeInCount = 0;
            state.preBuffer = [];
            return;
        }
    }

    // If not actively listening, just maintain the rolling
    // pre-buffer so the onset of the next utterance is captured.
    if (!state.listening) {
        state.preBuffer.push(chunk);
        if (state.preBuffer.length > PRE_BUFFER_CHUNKS) {
            state.preBuffer.shift();
        }
        return;
    }

    var now = Date.now();

    // Adaptive threshold: at least SILENCE_THRESHOLD, or 3x noise floor
    var threshold = Math.max(SILENCE_THRESHOLD, state.noiseFloor * 3);
    var isSpeech = energy > threshold;

    if (state.vadState === 'silence') {
        if (isSpeech) {
            state.vadState = 'speech_started';
            state.speechStartTime = now;
            state.lastSpeechTime = now;
            // Seed audio buffer from pre-buffer so onset isn't lost
            for (var i = 0; i < state.preBuffer.length; i++) {
                state.audioChunks.push(state.preBuffer[i]);
            }
            state.preBuffer = [];
            state.audioChunks.push(chunk);
        } else {
            updateNoiseFloor(energy);
            state.preBuffer.push(chunk);
            if (state.preBuffer.length > PRE_BUFFER_CHUNKS) {
                state.preBuffer.shift();
            }
        }
    } else if (state.vadState === 'speech_started') {
        // Always capture audio during onset (including brief pauses)
        state.audioChunks.push(chunk);
        if (isSpeech) {
            state.lastSpeechTime = now;
            if (now - state.speechStartTime >= MIN_SPEECH_DURATION) {
                state.vadState = 'speaking';
                if (!state.inSilenceMode) setStatus('Listening...');
            }
        } else {
            // Short silence — noise reject if too long
            if (now - state.lastSpeechTime > NOISE_REJECT_MS) {
                submitCommandCandidate();
                state.vadState = 'silence';
                state.speechStartTime = 0;
                state.lastSpeechTime = 0;
            }
        }
    } else if (state.vadState === 'speaking') {
        state.audioChunks.push(chunk);
        if (isSpeech) {
            state.lastSpeechTime = now;
            // User resumed speaking — invalidate any speculative
            if (state.speculativeSent) {
                state.speculativeGen++;
                state.speculativeSent = false;
                state.speculativeText = null;
            }
        } else {
            var isNoting = notingState.active;

            // Adaptive silence: the longer the user has been
            // speaking, the more patience for thinking pauses.
            // Noting mode uses flat, short thresholds for snappy detection.
            var speechDur = state.lastSpeechTime - state.speechStartTime;
            var baseSilence = isNoting ? SILENCE_DURATION_NOTING : SILENCE_DURATION;
            var maxSilence = isNoting ? SILENCE_DURATION_NOTING : SILENCE_DURATION_MAX;
            var rampRate = isNoting ? 0 : SILENCE_RAMP_RATE;
            var silenceNeeded = Math.min(
                baseSilence + speechDur * rampRate,
                maxSilence
            );
            var silenceElapsed = now - state.lastSpeechTime;

            var minUtterance = state.inSilenceMode
                ? MIN_UTTERANCE_DURATION_SILENCE
                : (isNoting ? MIN_UTTERANCE_DURATION_NOTING : MIN_UTTERANCE_DURATION);

            // At base silence, pre-send audio for transcription
            // (skip speculative in noting mode — labels are short, just submit directly)
            if (!isNoting &&
                !state.speculativeSent &&
                silenceNeeded > SILENCE_DURATION &&
                silenceElapsed >= SILENCE_DURATION &&
                now - state.speechStartTime >= minUtterance) {
                submitSpeculative();
            }

            if (silenceElapsed >= silenceNeeded) {
                if (now - state.speechStartTime >= minUtterance) {
                    if (!isNoting && state.speculativeText !== null) {
                        finalizeSpeculative();
                    } else if (!isNoting && state.speculativeSent) {
                        state.awaitingSpeculative = true;
                        if (!state.inSilenceMode) setStatus('Transcribing...');
                        state.vadState = 'silence';
                        state.audioChunks = [];
                        state.speechStartTime = 0;
                        state.lastSpeechTime = 0;
                        state.speculativeSent = false;
                    } else {
                        submitUtterance();
                    }
                } else {
                    submitCommandCandidate();
                    state.vadState = 'silence';
                    state.speechStartTime = 0;
                    state.lastSpeechTime = 0;
                }
            }
        }
    }
}

// ---- Submission helpers ----

function submitCommandCandidate() {
    var chunks = state.audioChunks;
    state.audioChunks = [];

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

    var nativeSampleRate = state.audioContext ? state.audioContext.sampleRate : 16000;
    if (nativeSampleRate !== 16000) {
        combined = downsampleTo16k(combined, nativeSampleRate);
    }

    var durationSec = (combined.length / 16000).toFixed(1);
    state.pendingTranscriptions++;
    console.log('Submitting command candidate: ' + combined.length + ' samples @ 16kHz, ~' + durationSec + 's');

    socket.emit('audio_data', {
        audio: combined.buffer,
        sample_rate: 16000,
        command_only: true,
    });
}

function submitSpeculative() {
    if (state.audioChunks.length === 0) return;

    var totalLength = 0;
    for (var i = 0; i < state.audioChunks.length; i++) {
        totalLength += state.audioChunks[i].length;
    }
    var combined = new Float32Array(totalLength);
    var offset = 0;
    for (var i = 0; i < state.audioChunks.length; i++) {
        combined.set(state.audioChunks[i], offset);
        offset += state.audioChunks[i].length;
    }

    var nativeSampleRate = state.audioContext ? state.audioContext.sampleRate : 16000;
    if (nativeSampleRate !== 16000) {
        combined = downsampleTo16k(combined, nativeSampleRate);
    }

    var durationSec = (combined.length / 16000).toFixed(1);
    state.pendingTranscriptions++;
    state.speculativeSent = true;
    console.log('Submitting speculative transcription: ~' + durationSec + 's (gen ' + state.speculativeGen + ')');

    socket.emit('audio_data', {
        audio: combined.buffer,
        sample_rate: 16000,
        speculative_gen: state.speculativeGen,
    });
}

function finalizeSpeculative() {
    var text = state.speculativeText;
    state.audioChunks = [];
    state.vadState = 'silence';
    state.speechStartTime = 0;
    state.lastSpeechTime = 0;
    state.speculativeSent = false;
    state.speculativeText = null;
    state.awaitingSpeculative = false;

    if (!text) return;
    var lower = text.toLowerCase().replace(/[^a-z]/g, '');
    if (lower === 'mute') {
        deactivateVoice();
        return;
    }
    _sendText(text);
}

export function submitUtterance() {
    var chunks = state.audioChunks;
    state.audioChunks = [];
    state.vadState = 'silence';
    state.speechStartTime = 0;
    state.lastSpeechTime = 0;

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

    var nativeSampleRate = state.audioContext ? state.audioContext.sampleRate : 16000;

    if (nativeSampleRate !== 16000) {
        combined = downsampleTo16k(combined, nativeSampleRate);
    }

    var durationSec = (combined.length / 16000).toFixed(1);

    state.pendingTranscriptions++;
    console.log('Submitting audio: ' + combined.length + ' samples @ 16kHz, ~' + durationSec + 's (' + state.pendingTranscriptions + ' pending)');

    // Safety timeout
    setTimeout(function () {
        if (state.pendingTranscriptions > 0) {
            console.warn('Transcription still pending after ' + TRANSCRIPTION_TIMEOUT_MS + 'ms');
        }
    }, TRANSCRIPTION_TIMEOUT_MS);

    socket.emit('audio_data', {
        audio: combined.buffer,
        sample_rate: 16000,
    });

    if (!state.inSilenceMode) setStatus('Transcribing...');
}

export function deactivateVoice() {
    state.voiceActive = false;
    state.listening = false;
    state.smoothedLevel = 0;
    dom.voiceBtn.style.removeProperty('--mic-level');
    dom.voiceBtn.classList.remove('active');
    setStatus('Microphone off. Click mic to resume.');

    socket.emit('voice_mute', { muted: true });
    var orb = document.getElementById('orb');
    if (orb) orb.classList.add('orb-muted');
    stopServerAudio();
    state.pendingTranscriptions = 0;
    if (state.scriptProcessor) { state.scriptProcessor.disconnect(); state.scriptProcessor = null; }
    if (state.sourceNode) { state.sourceNode.disconnect(); state.sourceNode = null; }
    if (state.mediaStream) {
        state.mediaStream.getTracks().forEach(function (t) { t.stop(); });
        state.mediaStream = null;
    }
    if (state.audioContext) {
        state.audioContext.close();
        state.audioContext = null;
    }
    state.audioChunks = [];
    state.preBuffer = [];
    state.vadState = 'silence';
    state.speechStartTime = 0;
    state.lastSpeechTime = 0;
    state.noiseFloor = 0.005;
    state.noiseSamples = 0;
    state.ttsSpeaking = false;
    state.ttsMismatchStart = 0;
    state.bargeInCount = 0;
    state.speculativeSent = false;
    state.speculativeText = null;
    state.awaitingSpeculative = false;
}

/** Handle incoming transcription result — called by socketHandlers */
export function handleTranscription(data) {
    state.pendingTranscriptions = Math.max(0, state.pendingTranscriptions - 1);

    var text = (data.text || '').trim();
    var commandOnly = data.command_only || false;
    var specGen = data.speculative_gen;
    console.log('Transcription received:', text || '(empty)',
        specGen !== undefined ? '(speculative gen ' + specGen + ')' : '',
        commandOnly ? '(command candidate)' : '',
        data.error ? 'error: ' + data.error : '',
        '(' + state.pendingTranscriptions + ' still pending)');

    // Handle speculative transcription results
    if (specGen !== undefined) {
        if (specGen !== state.speculativeGen) return; // stale, ignore
        if (state.awaitingSpeculative) {
            state.awaitingSpeculative = false;
            if (text) {
                var lower = text.toLowerCase().replace(/[^a-z]/g, '');
                if (lower === 'mute') { deactivateVoice(); return; }
                _sendText(text);
            }
        } else {
            state.speculativeText = text;
        }
        // Reset idle status (the non-speculative path does this below,
        // but this early-return would skip it).
        if (state.vadState === 'silence' && state.pendingTranscriptions === 0 && state.voiceActive) {
            if (state.inSilenceMode) {
                setStatus("Holding space\u2026 say something like \u2018I\u2019m ready\u2019 to resume");
            } else {
                setStatus("Speak naturally, or say 'mute' to turn off mic");
            }
        }
        return;
    }

    if (text) {
        var lower = text.toLowerCase().replace(/[^a-z]/g, '');
        if (lower === 'mute') {
            deactivateVoice();
            return;
        }
        if (commandOnly) {
            if (state.inSilenceMode) { _sendText(text); return; }
            if (isHoldCommand(text)) _sendText(text);
            return;
        }
        _sendText(text);
    }

    // Restore idle status when all transcriptions are done
    if (state.vadState === 'silence' && state.pendingTranscriptions === 0 && state.voiceActive) {
        if (state.inSilenceMode) {
            setStatus("Holding space\u2026 say something like \u2018I\u2019m ready\u2019 to resume");
        } else {
            setStatus("Speak naturally, or say 'mute' to turn off mic");
        }
    }
}
