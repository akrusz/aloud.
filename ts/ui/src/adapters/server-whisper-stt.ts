/**
 * Server-Whisper STT adapter — captures mic audio in the browser, VADs
 * it client-side, sends 16 kHz Float32 PCM to the Flask /api/stt/whisper
 * endpoint, and emits a `final` event when transcription returns.
 *
 * This is the universal fallback: works on Firefox, Safari, and any
 * browser the Web Speech API doesn't cover. Trade-off vs. native /
 * Web Speech: requires a running Flask backend with Whisper.cpp.
 *
 * VAD: RMS-energy threshold over an adaptive noise floor, with an adaptive
 * silence timeout (base + speech×ramp, capped at max). After a short pause it
 * fires a SPECULATIVE transcription and emits it as a `partial` (so the user
 * sees their words during the pause), then submits the `final` once the full
 * adaptive silence elapses — mirroring audio.js's speculative submission.
 *
 * Onset capture: the mic stream + AudioContext are opened once and kept alive
 * across turns (only `stop()` — mute / session end — tears them down). This
 * avoids paying getUserMedia's ~1s acquisition latency on every turn, which was
 * eating the first second of a barge-in. A short pre-buffer ring also retains
 * the sub-threshold ramp before speech crosses the VAD threshold, so the
 * leading edge of the first word isn't clipped (the audio.js pre-buffer).
 */

import type { SttEngine, SttEvent } from '../../../src/platform/stt.js';
import { defaultPacingConfig, type PacingConfig } from '../../../src/facilitation/pacing.js';

const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SIZE = 4096;
// Short silence (ms) that triggers a speculative transcription mid-utterance —
// so the user sees their words during a pause, before the (longer) adaptive
// silence actually submits the turn. Speculation is skipped when the submit
// threshold is shorter than this (nothing to preview).
const SPECULATIVE_SILENCE_MS = 500;
// How much pre-speech audio (ms) to retain so the onset ramp — the start of the
// first word, which sits below the VAD threshold — survives into the captured
// utterance instead of being clipped.
const PRE_BUFFER_MS = 250;

/** The subset of PacingConfig fields the VAD here cares about. */
type VadFields = Pick<
    PacingConfig,
    'silenceBaseMs' | 'silenceMaxMs' | 'silenceRampRate' | 'minSpeechDurationMs'
>;

export interface ServerWhisperSttEngineOptions extends Partial<VadFields> {
    /** Endpoint URL. Default '/api/stt/whisper' — Vite proxies in dev. */
    endpointUrl?: string;
    /** RMS energy floor below which a frame is counted as silence. */
    energyThreshold?: number;
    /** Hard cap on a single utterance — auto-submit after this. */
    maxUtteranceMs?: number;
    /** Custom fetch (tests). */
    fetchImpl?: typeof fetch;
    /** When present, each transcription request carries `Authorization: Bearer
     *  <token>`. Used to target the hosted server's authed /v1/stt (vs the
     *  open Flask /api/stt/whisper). Returning null sends no auth header. */
    authProvider?: () => Promise<string | null>;
}

export class ServerWhisperSttEngine implements SttEngine {
    private readonly opts: Required<
        Omit<ServerWhisperSttEngineOptions, 'fetchImpl' | 'authProvider'>
    > & {
        fetchImpl: typeof fetch;
        authProvider: (() => Promise<string | null>) | null;
    };
    private context: AudioContext | null = null;
    private stream: MediaStream | null = null;
    private processor: ScriptProcessorNode | null = null;
    private source: MediaStreamAudioSourceNode | null = null;
    private stopRequested = false;

    constructor(options: ServerWhisperSttEngineOptions = {}) {
        this.opts = {
            endpointUrl: options.endpointUrl ?? '/api/stt/whisper',
            energyThreshold: options.energyThreshold ?? 0.015,
            silenceBaseMs: options.silenceBaseMs ?? defaultPacingConfig.silenceBaseMs,
            silenceMaxMs: options.silenceMaxMs ?? defaultPacingConfig.silenceMaxMs,
            silenceRampRate: options.silenceRampRate ?? defaultPacingConfig.silenceRampRate,
            // STT min-speech can be looser than facilitation min-speech;
            // adopt the PacingConfig default but allow caller override.
            minSpeechDurationMs:
                options.minSpeechDurationMs ?? defaultPacingConfig.minSpeechDurationMs,
            maxUtteranceMs: options.maxUtteranceMs ?? 30_000,
            fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
            authProvider: options.authProvider ?? null,
        };
    }

    /**
     * Whether mic capture is plausibly available. We can't probe the
     * server here without a request — that's the caller's problem.
     */
    static isAvailable(): boolean {
        return (
            typeof navigator !== 'undefined' &&
            !!navigator.mediaDevices?.getUserMedia &&
            (typeof AudioContext !== 'undefined' ||
                typeof (globalThis as unknown as { webkitAudioContext?: unknown })
                    .webkitAudioContext !== 'undefined')
        );
    }

    async *start(): AsyncIterable<SttEvent> {
        this.stopRequested = false;
        // Reuse a live stream across turns; only re-acquire if it was released
        // by stop() (mute / session end) or the OS dropped it. Re-acquiring is
        // the expensive step that used to clip a barge-in's first second.
        try {
            if (!this.stream || !this.stream.active) {
                this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }
        } catch (err) {
            yield { type: 'error', error: err };
            return;
        }

        const AC =
            (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
            (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext;
        if (!AC) {
            yield { type: 'error', error: new Error('AudioContext unavailable') };
            this.releaseAll();
            return;
        }
        if (!this.context || this.context.state === 'closed') {
            this.context = new AC();
        }
        // Autoplay policies can leave the context suspended; resume so the
        // ScriptProcessor actually receives audio.
        if (this.context.state === 'suspended') {
            try {
                await this.context.resume();
            } catch {
                /* best effort */
            }
        }
        this.source = this.context.createMediaStreamSource(this.stream);
        // ScriptProcessorNode is deprecated in favour of AudioWorklet, but
        // it's a one-liner and still works everywhere. Migrate later.
        this.processor = this.context.createScriptProcessor(FRAME_SIZE, 1, 1);

        const chunks: Float32Array[] = [];
        let speechStarted = false;
        let speechStartMs = 0;
        let lastSpeechMs = 0;
        let utteranceDone = false;
        // Adaptive noise floor — track ambient room sound so the speech
        // threshold rides above background noise instead of a fixed cut.
        let noiseFloor = 0.005;
        let noiseSamples = 0;
        const nativeRate = this.context.sampleRate;
        // Rolling pre-speech buffer: the last few frames before the VAD trips,
        // prepended to the utterance so the word's onset isn't clipped.
        const preBuffer: Float32Array[] = [];
        const preBufferFrames = Math.max(
            1,
            Math.round((PRE_BUFFER_MS / 1000) * nativeRate / FRAME_SIZE)
        );

        this.processor.onaudioprocess = (e) => {
            if (utteranceDone || this.stopRequested) return;
            const data = e.inputBuffer.getChannelData(0);
            const frame = new Float32Array(data);
            let sum = 0;
            for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
            const energy = Math.sqrt(sum / frame.length);
            const now = performance.now();

            // Threshold is whichever is higher: the static floor, or
            // 3x the running noise floor. The 3x multiplier matches the
            // existing audio.js heuristic and gives reliable separation
            // in normal rooms.
            const threshold = Math.max(this.opts.energyThreshold, noiseFloor * 3);
            const isSpeech = energy > threshold;

            if (isSpeech) {
                if (!speechStarted) {
                    speechStarted = true;
                    speechStartMs = now;
                    // Prepend the retained onset ramp, then clear it.
                    for (const f of preBuffer) chunks.push(f);
                    preBuffer.length = 0;
                }
                lastSpeechMs = now;
                chunks.push(frame);
            } else if (speechStarted) {
                chunks.push(frame);
                // Adaptive silence: each ms of speech buys silenceRampRate
                // ms of additional patience, capped at silenceMaxMs.
                const speechDur = lastSpeechMs - speechStartMs;
                const needed = Math.min(
                    this.opts.silenceBaseMs + speechDur * this.opts.silenceRampRate,
                    this.opts.silenceMaxMs
                );
                if (now - lastSpeechMs >= needed) {
                    utteranceDone = true;
                }
            } else {
                // Truly silent frame — update the noise floor. Fast
                // adaptation for the first 100 samples (~9s at 4096-frame
                // ScriptProcessor + 48kHz), then slow.
                const alpha = noiseSamples < 100 ? 0.1 : 0.01;
                noiseFloor = (1 - alpha) * noiseFloor + alpha * energy;
                noiseSamples++;
                // Keep the most recent pre-speech frames for onset retention.
                preBuffer.push(frame);
                if (preBuffer.length > preBufferFrames) preBuffer.shift();
            }

            if (speechStarted && now - speechStartMs >= this.opts.maxUtteranceMs) {
                utteranceDone = true;
            }
        };

        this.source.connect(this.processor);
        this.processor.connect(this.context.destination);

        // Transcribe a snapshot of captured frames via the Whisper endpoint —
        // used for both speculative interim passes and the final submission.
        const transcribeChunks = async (
            frames: readonly Float32Array[]
        ): Promise<
            { ok: true; text: string; seconds: number } | { ok: false; error: unknown }
        > => {
            const combined = concatFloat32(frames as Float32Array[]);
            const downsampled =
                nativeRate === TARGET_SAMPLE_RATE
                    ? combined
                    : downsampleLinear(combined, nativeRate, TARGET_SAMPLE_RATE);
            try {
                const headers: Record<string, string> = {
                    'content-type': 'application/octet-stream',
                };
                if (this.opts.authProvider) {
                    const token = await this.opts.authProvider();
                    if (token) headers['authorization'] = `Bearer ${token}`;
                }
                const response = await this.opts.fetchImpl(
                    `${this.opts.endpointUrl}?sample_rate=${TARGET_SAMPLE_RATE}`,
                    {
                        method: 'POST',
                        headers,
                        body: downsampled.buffer.slice(
                            downsampled.byteOffset,
                            downsampled.byteOffset + downsampled.byteLength
                        ) as ArrayBuffer,
                    }
                );
                if (!response.ok) {
                    const detail = await response.text().catch(() => '');
                    return {
                        ok: false,
                        error: new Error(`Whisper endpoint ${response.status}: ${detail}`),
                    };
                }
                const data = (await response.json()) as { text?: string; error?: string };
                if (data.error !== undefined) return { ok: false, error: new Error(data.error) };
                return {
                    ok: true,
                    text: (data.text ?? '').trim(),
                    seconds: downsampled.length / TARGET_SAMPLE_RATE,
                };
            } catch (err) {
                return { ok: false, error: err };
            }
        };

        try {
            // Poll while capturing. A short pause (SPECULATIVE_SILENCE_MS) fires
            // a speculative transcription so the user sees their words during
            // the pause (a partial, shown with the "…" marker); the adaptive
            // `needed` silence (set in the audio callback) ends the turn. Each
            // speculative pass re-transcribes the growing buffer.
            let lastSpecChunkCount = 0;
            let specInFlight = false;
            while (!utteranceDone && !this.stopRequested) {
                await new Promise<void>((r) => setTimeout(r, 200));
                if (utteranceDone || this.stopRequested) break;
                if (!speechStarted) continue;
                const silence = performance.now() - lastSpeechMs;
                if (
                    silence >= SPECULATIVE_SILENCE_MS &&
                    !specInFlight &&
                    chunks.length > lastSpecChunkCount
                ) {
                    specInFlight = true;
                    lastSpecChunkCount = chunks.length;
                    const result = await transcribeChunks(chunks.slice());
                    specInFlight = false;
                    // Drop the preview if the turn ended while it was in flight
                    // (the final pass will emit the authoritative text).
                    if (!utteranceDone && result.ok && result.text) {
                        yield { type: 'partial', text: result.text };
                    }
                }
            }

            if (this.stopRequested && !utteranceDone) {
                return; // user explicitly stopped before end-of-speech
            }
            if (!speechStarted) return;

            const speechDuration = lastSpeechMs - speechStartMs;
            if (speechDuration < this.opts.minSpeechDurationMs) {
                return; // sound too short — likely a cough / mic bump
            }

            const result = await transcribeChunks(chunks);
            if (!result.ok) {
                yield { type: 'error', error: result.error };
                return;
            }
            // Billable server-side STT compute — report the transcribed audio
            // duration (16 kHz mono) for session usage tracking. Only the final
            // pass is counted; speculative passes aren't, to keep the tally
            // simple (revisit if a hosted cloud-STT meters speculation).
            yield { type: 'final', text: result.text, seconds: result.seconds };
        } finally {
            // End the turn but keep the stream + context warm for the next one
            // (and for a low-latency barge-in). Full teardown only on stop().
            this.cleanupUtterance();
        }
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
        this.releaseAll();
    }

    /** Tear down the per-turn nodes; leaves the stream + context alive. */
    private cleanupUtterance(): void {
        if (this.processor) {
            try {
                this.processor.disconnect();
            } catch {
                // already disconnected
            }
            this.processor.onaudioprocess = null;
            this.processor = null;
        }
        if (this.source) {
            try {
                this.source.disconnect();
            } catch {
                // already disconnected
            }
            this.source = null;
        }
    }

    /** Full teardown: per-turn nodes + the context and mic stream. */
    private releaseAll(): void {
        this.cleanupUtterance();
        if (this.context && this.context.state !== 'closed') {
            this.context.close().catch(() => {});
        }
        this.context = null;
        this.releaseStream();
    }

    private releaseStream(): void {
        if (this.stream) {
            for (const track of this.stream.getTracks()) track.stop();
            this.stream = null;
        }
    }
}

function concatFloat32(chunks: Float32Array[]): Float32Array {
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Float32Array(total);
    let offset = 0;
    for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
    }
    return out;
}

function downsampleLinear(buffer: Float32Array, fromRate: number, toRate: number): Float32Array {
    if (fromRate === toRate) return buffer;
    const ratio = fromRate / toRate;
    const newLen = Math.round(buffer.length / ratio);
    const out = new Float32Array(newLen);
    for (let i = 0; i < newLen; i++) {
        const src = i * ratio;
        const low = Math.floor(src);
        const high = Math.min(low + 1, buffer.length - 1);
        const frac = src - low;
        out[i] = buffer[low]! * (1 - frac) + buffer[high]! * frac;
    }
    return out;
}
