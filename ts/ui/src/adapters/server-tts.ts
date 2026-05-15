/**
 * Server-side TTS adapter — fetches synthesized WAV bytes from Flask's
 * /api/voices/preview endpoint and plays them via AudioContext.
 *
 * The endpoint is general (it accepts an arbitrary `text` param even
 * though "preview" is its historical name), so we can use it for
 * actual session TTS without adding a new route. Each speak() is one
 * HTTP request + one decodeAudioData + one buffer source playback.
 */

import type { TtsEngine, TtsOptions, TtsVoice } from '../../../src/platform/tts.js';

export interface ServerTtsEngineOptions {
    /** Voice id from /api/voices — required for the server to pick an engine. */
    voice: string;
    /** Engine override; let the server auto-detect when omitted. */
    engine?: string;
    /** Endpoint base. Defaults to '/api/voices/preview'. */
    endpointUrl?: string;
    /** Override fetch (tests). */
    fetchImpl?: typeof fetch;
}

export class ServerTtsEngine implements TtsEngine {
    private readonly voiceId: string;
    private readonly engine: string | undefined;
    private readonly endpointUrl: string;
    private readonly fetchImpl: typeof fetch;

    private context: AudioContext | null = null;
    private currentSource: AudioBufferSourceNode | null = null;
    private currentResolve: (() => void) | null = null;
    private currentAbort: AbortController | null = null;

    constructor(options: ServerTtsEngineOptions) {
        this.voiceId = options.voice;
        this.engine = options.engine;
        this.endpointUrl = options.endpointUrl ?? '/api/voices/preview';
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    }

    async speak(text: string, options?: TtsOptions): Promise<void> {
        if (!text.trim()) return;
        this.cancelSync();

        const params = new URLSearchParams({ voice: this.voiceId, text });
        if (this.engine) params.set('engine', this.engine);
        if (options?.rate !== undefined) params.set('rate', String(options.rate));

        const abort = new AbortController();
        this.currentAbort = abort;

        let buffer: ArrayBuffer;
        try {
            const response = await this.fetchImpl(`${this.endpointUrl}?${params.toString()}`, {
                signal: abort.signal,
            });
            if (!response.ok) {
                throw new Error(`Server TTS responded ${response.status}`);
            }
            buffer = await response.arrayBuffer();
        } catch (err) {
            this.currentAbort = null;
            if ((err as Error).name === 'AbortError') return;
            throw err;
        }
        if (abort.signal.aborted) return;

        const ctx = await this.ensureContext();
        let audioBuffer: AudioBuffer;
        try {
            audioBuffer = await ctx.decodeAudioData(buffer.slice(0));
        } catch (err) {
            // Some engines (server fell over, returned empty/bad bytes) — surface as a TTS error.
            throw new Error(`Failed to decode TTS audio: ${(err as Error).message}`);
        }
        if (abort.signal.aborted) return;

        // Firefox in particular can re-suspend the context during decode
        // (a few hundred ms with no scheduled output), which makes start(0)
        // play briefly and then go silent. Re-resume right before play.
        if (ctx.state === 'suspended') {
            try {
                await ctx.resume();
            } catch {
                /* will throw at start() if it's a real problem */
            }
        }

        return new Promise<void>((resolve) => {
            const source = ctx.createBufferSource();
            source.buffer = audioBuffer;
            source.connect(ctx.destination);
            this.currentSource = source;
            this.currentResolve = resolve;
            source.onended = () => this.finish(source);
            source.start(0);
        });
    }

    cancel(): Promise<void> {
        this.cancelSync();
        return Promise.resolve();
    }

    async listVoices(): Promise<TtsVoice[]> {
        // Listing voices is the picker's job (it merges server + browser).
        // The engine itself doesn't need to enumerate.
        return [];
    }

    private async ensureContext(): Promise<AudioContext> {
        if (!this.context || this.context.state === 'closed') {
            const AC =
                (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
                (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
                    .webkitAudioContext;
            if (!AC) throw new Error('AudioContext unavailable');
            this.context = new AC();
        }
        if (this.context.state === 'suspended') {
            // Await resume so the first speak() doesn't drop samples
            // while the audio engine is still warming up. iOS Safari is
            // strictest about this, but Firefox can also be slow.
            try {
                await this.context.resume();
            } catch {
                /* will throw at start() if it's a real problem */
            }
        }
        return this.context;
    }

    private cancelSync(): void {
        if (this.currentAbort) {
            this.currentAbort.abort();
            this.currentAbort = null;
        }
        if (this.currentSource) {
            try {
                this.currentSource.stop();
            } catch {
                // Already stopped — fine.
            }
            this.currentSource.disconnect();
            this.currentSource = null;
        }
        if (this.currentResolve) {
            const resolve = this.currentResolve;
            this.currentResolve = null;
            resolve();
        }
    }

    private finish(source: AudioBufferSourceNode): void {
        if (this.currentSource !== source) return;
        this.currentSource = null;
        const resolve = this.currentResolve;
        this.currentResolve = null;
        if (resolve) resolve();
    }
}
