/**
 * Server-Whisper STT adapter — captures mic audio in the browser, VADs
 * it client-side, sends 16 kHz Float32 PCM to the Flask /api/stt/whisper
 * endpoint, and emits a `final` event when transcription returns.
 *
 * This is the universal fallback: works on Firefox, Safari, and any
 * browser the Web Speech API doesn't cover. Trade-off vs. native /
 * Web Speech: requires a running Flask backend with Whisper.cpp.
 *
 * The VAD is intentionally simple — RMS-energy threshold with a
 * silence timeout. No speculative submission, no adaptive thresholding,
 * no pre-buffer (yet). The existing Flask UI's audio.js has all those
 * niceties; we can port them when the loop is solid.
 */

import type { SttEngine, SttEvent } from '../../../src/platform/stt.js';

const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SIZE = 4096;

export interface ServerWhisperSttEngineOptions {
    /** Endpoint URL. Default '/api/stt/whisper' — Vite proxies in dev. */
    endpointUrl?: string;
    /** RMS energy above which a frame counts as speech. */
    energyThreshold?: number;
    /** Trailing silence required before submitting. */
    silenceTimeoutMs?: number;
    /** Minimum total speech duration before we'll submit. */
    minSpeechDurationMs?: number;
    /** Hard cap on a single utterance — auto-submit after this. */
    maxUtteranceMs?: number;
    /** Custom fetch (tests). */
    fetchImpl?: typeof fetch;
}

export class ServerWhisperSttEngine implements SttEngine {
    private readonly opts: Required<Omit<ServerWhisperSttEngineOptions, 'fetchImpl'>> & {
        fetchImpl: typeof fetch;
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
            silenceTimeoutMs: options.silenceTimeoutMs ?? 1500,
            minSpeechDurationMs: options.minSpeechDurationMs ?? 500,
            maxUtteranceMs: options.maxUtteranceMs ?? 30_000,
            fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
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
        try {
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
            this.releaseStream();
            return;
        }
        this.context = new AC();
        this.source = this.context.createMediaStreamSource(this.stream);
        // ScriptProcessorNode is deprecated in favour of AudioWorklet, but
        // it's a one-liner and still works everywhere. Migrate later.
        this.processor = this.context.createScriptProcessor(FRAME_SIZE, 1, 1);

        const chunks: Float32Array[] = [];
        let speechStarted = false;
        let speechStartMs = 0;
        let lastSpeechMs = 0;
        let utteranceDone = false;
        let wake: (() => void) | null = null;
        const nativeRate = this.context.sampleRate;

        this.processor.onaudioprocess = (e) => {
            if (utteranceDone || this.stopRequested) return;
            const data = e.inputBuffer.getChannelData(0);
            const frame = new Float32Array(data);
            let sum = 0;
            for (let i = 0; i < frame.length; i++) sum += frame[i]! * frame[i]!;
            const energy = Math.sqrt(sum / frame.length);
            const now = performance.now();

            if (energy > this.opts.energyThreshold) {
                if (!speechStarted) {
                    speechStarted = true;
                    speechStartMs = now;
                }
                lastSpeechMs = now;
                chunks.push(frame);
            } else if (speechStarted) {
                chunks.push(frame);
                if (now - lastSpeechMs >= this.opts.silenceTimeoutMs) {
                    utteranceDone = true;
                    if (wake) {
                        const w = wake;
                        wake = null;
                        w();
                    }
                }
            }

            if (speechStarted && now - speechStartMs >= this.opts.maxUtteranceMs) {
                utteranceDone = true;
                if (wake) {
                    const w = wake;
                    wake = null;
                    w();
                }
            }
        };

        this.source.connect(this.processor);
        this.processor.connect(this.context.destination);

        try {
            await new Promise<void>((resolve) => {
                wake = resolve;
                // Wake at least once a second so stopRequested gets observed
                // even if no audio frames are flowing for some reason.
                const interval = setInterval(() => {
                    if (utteranceDone || this.stopRequested) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 250);
            });

            if (this.stopRequested && !utteranceDone) {
                return; // user explicitly stopped before end-of-speech
            }
            if (!speechStarted) return;

            const speechDuration = lastSpeechMs - speechStartMs;
            if (speechDuration < this.opts.minSpeechDurationMs) {
                return; // sound too short — likely a cough / mic bump
            }

            const combined = concatFloat32(chunks);
            const downsampled =
                nativeRate === TARGET_SAMPLE_RATE
                    ? combined
                    : downsampleLinear(combined, nativeRate, TARGET_SAMPLE_RATE);

            const response = await this.opts.fetchImpl(
                `${this.opts.endpointUrl}?sample_rate=${TARGET_SAMPLE_RATE}`,
                {
                    method: 'POST',
                    headers: { 'content-type': 'application/octet-stream' },
                    body: downsampled.buffer.slice(
                        downsampled.byteOffset,
                        downsampled.byteOffset + downsampled.byteLength
                    ) as ArrayBuffer,
                }
            );

            if (!response.ok) {
                const detail = await response.text().catch(() => '');
                yield {
                    type: 'error',
                    error: new Error(`Whisper endpoint ${response.status}: ${detail}`),
                };
                return;
            }
            const data = (await response.json()) as { text?: string; error?: string };
            if (data.error !== undefined) {
                yield { type: 'error', error: new Error(data.error) };
                return;
            }
            yield { type: 'final', text: (data.text ?? '').trim() };
        } finally {
            this.cleanup();
        }
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
        this.cleanup();
    }

    private cleanup(): void {
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
