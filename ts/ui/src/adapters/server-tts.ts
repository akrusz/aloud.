/**
 * Server-side TTS adapter — fetches a WAV from Flask's /api/voices/preview
 * and plays it via an HTMLAudioElement.
 *
 * Previous iterations used Web Audio (AudioContext + BufferSource), which
 * Firefox keeps re-suspending during the decode step. HTMLAudioElement is
 * a regular media element with browser-managed lifecycle — no manual
 * resume() dance, no suspension races. We swap to it here for stability.
 *
 * The server's `rate` query param already renders the WAV at the
 * requested wpm, so we don't need to mess with playbackRate.
 */

import type { TtsEngine, TtsOptions, TtsVoice } from '../../../src/platform/tts.js';

export interface ServerTtsEngineOptions {
    voice: string;
    engine?: string;
    endpointUrl?: string;
    fetchImpl?: typeof fetch;
}

export class ServerTtsEngine implements TtsEngine {
    private readonly voiceId: string;
    private readonly engine: string | undefined;
    private readonly endpointUrl: string;
    private readonly fetchImpl: typeof fetch;

    private currentAudio: HTMLAudioElement | null = null;
    private currentUrl: string | null = null;
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

        let blob: Blob;
        try {
            const response = await this.fetchImpl(`${this.endpointUrl}?${params.toString()}`, {
                signal: abort.signal,
            });
            if (!response.ok) {
                throw new Error(`Server TTS responded ${response.status}`);
            }
            blob = await response.blob();
        } catch (err) {
            this.currentAbort = null;
            if ((err as Error).name === 'AbortError') return;
            throw err;
        }
        if (abort.signal.aborted) return;

        const url = URL.createObjectURL(blob);
        const audio = new Audio(url);
        // preload=auto so Firefox starts buffering before play(); reduces
        // any small lead-in gap and keeps playback stable end-to-end.
        audio.preload = 'auto';

        return new Promise<void>((resolve) => {
            const cleanup = () => {
                URL.revokeObjectURL(url);
                if (this.currentAudio === audio) {
                    this.currentAudio = null;
                    this.currentUrl = null;
                    this.currentAbort = null;
                }
                const r = this.currentResolve;
                this.currentResolve = null;
                if (r) r();
                else resolve();
            };
            audio.onended = cleanup;
            audio.onerror = cleanup;
            audio.onpause = () => {
                // Pause without ending means we were cancelled — finalize.
                if (audio.ended) return;
                cleanup();
            };
            this.currentAudio = audio;
            this.currentUrl = url;
            this.currentResolve = resolve;
            audio.play().catch(() => cleanup());
        });
    }

    cancel(): Promise<void> {
        this.cancelSync();
        return Promise.resolve();
    }

    async listVoices(): Promise<TtsVoice[]> {
        return [];
    }

    private cancelSync(): void {
        if (this.currentAbort) {
            this.currentAbort.abort();
            this.currentAbort = null;
        }
        if (this.currentAudio) {
            try {
                this.currentAudio.pause();
            } catch {
                // ignore
            }
            this.currentAudio.src = '';
            this.currentAudio = null;
        }
        if (this.currentUrl) {
            URL.revokeObjectURL(this.currentUrl);
            this.currentUrl = null;
        }
        if (this.currentResolve) {
            const r = this.currentResolve;
            this.currentResolve = null;
            r();
        }
    }
}
