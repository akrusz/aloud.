/**
 * Speech-to-text engine interface.
 *
 * Native iOS (SFSpeechRecognizer), Android (SpeechRecognizer), and the
 * Web Speech API all produce a stream of partial → final transcripts and
 * handle their own silence detection. The interface mirrors that shape:
 * `start()` returns an async iterable of events; the engine yields one
 * or more `partial` events followed by a `final`, then the iteration ends
 * (until the next `start()`). `stop()` requests early termination.
 *
 * Concrete native implementations land alongside the Capacitor wrapper
 * — keep this file dependency-free so the core remains importable in any
 * runtime.
 */

export type SttEvent =
    | { type: 'partial'; text: string }
    | {
          type: 'final';
          text: string;
          /**
           * Seconds of audio transcribed, when the engine ran billable
           * server-side STT compute (e.g. Whisper). Omitted for on-device
           * engines (Web Speech, native), which consume no metered compute —
           * the caller folds this into session STT-seconds usage.
           */
          seconds?: number;
      }
    | { type: 'error'; error: unknown };

export interface SttEngine {
    /**
     * Begin a recognition session. Yields events until end-of-speech, an
     * error, or `stop()` is called. The async iterator completes on its
     * own when the engine considers the utterance finished.
     */
    start(): AsyncIterable<SttEvent>;

    /** Request early termination of an in-progress recognition. */
    stop(): Promise<void>;

    /**
     * Optional: open the mic stream + audio graph WITHOUT beginning an
     * utterance. Engines that keep an onset pre-buffer (server-Whisper) use
     * this to start filling it immediately — e.g. during the opening greeting —
     * so a barge-in on the very first facilitator turn isn't clipped (otherwise
     * the graph is created lazily on the first start() and there's no buffered
     * onset yet). No-op / absent on engines that don't need it.
     */
    prime?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// In-memory implementation for tests / dry-run CLI usage
// ---------------------------------------------------------------------------

export interface InMemorySttEngineOptions {
    /** Sequence of events to yield on each `start()` call. */
    script: readonly SttEvent[];
    /** Optional delay between events, useful when timing matters. */
    delayMs?: number;
}

export class InMemorySttEngine implements SttEngine {
    private readonly script: readonly SttEvent[];
    private readonly delayMs: number;
    private stopRequested = false;

    constructor(options: InMemorySttEngineOptions) {
        this.script = options.script;
        this.delayMs = options.delayMs ?? 0;
    }

    async *start(): AsyncIterable<SttEvent> {
        this.stopRequested = false;
        for (const event of this.script) {
            if (this.stopRequested) return;
            if (this.delayMs > 0) {
                await new Promise<void>((resolve) => setTimeout(resolve, this.delayMs));
            }
            yield event;
        }
    }

    async stop(): Promise<void> {
        this.stopRequested = true;
    }
}

/**
 * Helper: drain an STT iterator down to its final transcript, ignoring
 * partials. Returns null if the stream ends with an error or no final.
 */
export async function collectFinal(stt: SttEngine): Promise<string | null> {
    for await (const event of stt.start()) {
        if (event.type === 'final') return event.text;
        if (event.type === 'error') return null;
    }
    return null;
}
