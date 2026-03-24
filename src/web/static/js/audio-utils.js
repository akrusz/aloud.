/* audio-utils.js — shared audio decode/playback helpers */

import { state } from './state.js';

/**
 * Set both TTS state flags at once.
 * @param {boolean} playing
 */
export function setAudioPlaying(playing) {
    state.ttsSpeaking = playing;
    state.serverAudioPlaying = playing;
}

/**
 * Decode a base64/binary WAV buffer and play it through the AudioContext.
 *
 * @param {ArrayBuffer|Blob} audioBytes  — raw audio data (WAV/MP3)
 * @param {function} [onEnded]           — called when playback finishes
 * @param {function} [onError]           — called on decode failure
 *
 * The playing source is stored on state.serverAudioSource so it can be
 * stopped externally (e.g. by stopServerAudio in tts.js).
 */
export function decodeAndPlay(audioBytes, onEnded, onError) {
    var buffer = audioBytes instanceof ArrayBuffer
        ? audioBytes
        : audioBytes.buffer || audioBytes;

    setAudioPlaying(true);

    state.audioContext.decodeAudioData(buffer.slice(0), function (decoded) {
        state.serverAudioSource = state.audioContext.createBufferSource();
        state.serverAudioSource.buffer = decoded;
        state.serverAudioSource.connect(state.audioContext.destination);
        state.serverAudioSource.onended = function () {
            state.serverAudioPlaying = false;
            state.serverAudioSource = null;
            if (onEnded) onEnded();
        };
        state.serverAudioSource.start(0);
    }, function (err) {
        setAudioPlaying(false);
        if (onError) onError(err);
    });
}
