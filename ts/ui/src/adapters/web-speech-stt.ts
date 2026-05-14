/**
 * Web Speech API adapter for the SttEngine interface.
 *
 * Coverage:
 *   - Desktop Chrome, Edge, Brave: ✓ (uses Google's cloud recognizer)
 *   - Android Chrome:               ✓
 *   - Desktop Safari (Sequoia+):    partial — requires on-device dictation
 *   - iOS Safari, iOS Capacitor:    ✗ (Apple doesn't expose SpeechRecognition;
 *                                       use a Capacitor speech plugin instead)
 *
 * Bridges the event-callback API to the AsyncIterable shape via a small
 * internal queue. We resume the iterator each time the recognizer emits.
 */

import type { SttEngine, SttEvent } from '../../../src/platform/stt.js';

// `SpeechRecognition` and `webkitSpeechRecognition` aren't in lib.dom.
// Declare just enough surface to satisfy the adapter.
interface SpeechRecognitionResultItem {
    readonly transcript: string;
    readonly confidence: number;
}
interface SpeechRecognitionResult {
    readonly isFinal: boolean;
    readonly [index: number]: SpeechRecognitionResultItem;
}
interface SpeechRecognitionResultList {
    readonly length: number;
    readonly [index: number]: SpeechRecognitionResult;
}
interface SpeechRecognitionEventLike {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultList;
}
interface SpeechRecognitionErrorEventLike {
    readonly error: string;
}
interface SpeechRecognitionLike {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    onresult: ((event: SpeechRecognitionEventLike) => void) | null;
    onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
    onend: (() => void) | null;
    start(): void;
    stop(): void;
    abort(): void;
}
interface SpeechRecognitionCtor {
    new (): SpeechRecognitionLike;
}

function getSpeechRecognitionCtor(): SpeechRecognitionCtor | null {
    const w = window as unknown as {
        SpeechRecognition?: SpeechRecognitionCtor;
        webkitSpeechRecognition?: SpeechRecognitionCtor;
    };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function isWebSpeechSupported(): boolean {
    return getSpeechRecognitionCtor() !== null;
}

export interface WebSpeechSttEngineOptions {
    /** BCP-47 language tag. Defaults to the page's lang attribute or 'en-US'. */
    lang?: string;
    /** Keep recognizing until stop(); off by default to match natural turn-taking. */
    continuous?: boolean;
    /** Emit `partial` events as the recognizer narrows in. On by default. */
    interimResults?: boolean;
}

export class WebSpeechSttEngine implements SttEngine {
    private readonly Ctor: SpeechRecognitionCtor;
    private readonly options: Required<WebSpeechSttEngineOptions>;
    private recognition: SpeechRecognitionLike | null = null;

    constructor(options: WebSpeechSttEngineOptions = {}) {
        const Ctor = getSpeechRecognitionCtor();
        if (!Ctor) {
            throw new Error(
                'Web Speech API is not available in this browser. Use a Capacitor plugin or a server STT fallback.'
            );
        }
        this.Ctor = Ctor;
        this.options = {
            lang: options.lang ?? document.documentElement.lang ?? 'en-US',
            continuous: options.continuous ?? false,
            interimResults: options.interimResults ?? true,
        };
    }

    async *start(): AsyncIterable<SttEvent> {
        const recognition = new this.Ctor();
        this.recognition = recognition;
        recognition.lang = this.options.lang;
        recognition.continuous = this.options.continuous;
        recognition.interimResults = this.options.interimResults;

        const queue: SttEvent[] = [];
        let done = false;
        let wake: (() => void) | null = null;

        const push = (event: SttEvent): void => {
            queue.push(event);
            if (wake) {
                const w = wake;
                wake = null;
                w();
            }
        };
        const finish = (): void => {
            done = true;
            if (wake) {
                const w = wake;
                wake = null;
                w();
            }
        };

        recognition.onresult = (event) => {
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const result = event.results[i];
                if (!result) continue;
                const item = result[0];
                if (!item) continue;
                push({
                    type: result.isFinal ? 'final' : 'partial',
                    text: item.transcript,
                });
            }
        };
        recognition.onerror = (event) => {
            // 'no-speech' and 'aborted' are routine end-of-turn signals, not errors.
            if (event.error === 'no-speech' || event.error === 'aborted') return;
            push({ type: 'error', error: event.error });
        };
        recognition.onend = finish;

        try {
            recognition.start();
        } catch (err) {
            // start() throws if the recognizer is already running, which can happen
            // when the user clicks the mic button twice in quick succession.
            push({ type: 'error', error: err });
            finish();
        }

        try {
            while (true) {
                while (queue.length > 0) {
                    yield queue.shift()!;
                }
                if (done) return;
                await new Promise<void>((resolve) => {
                    wake = resolve;
                });
            }
        } finally {
            recognition.onresult = null;
            recognition.onerror = null;
            recognition.onend = null;
            this.recognition = null;
        }
    }

    async stop(): Promise<void> {
        if (this.recognition) {
            try {
                this.recognition.stop();
            } catch {
                // already stopped
            }
        }
    }
}
