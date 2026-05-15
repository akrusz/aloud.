/**
 * Common shapes for LLM providers.
 *
 * The TS port uses `fetch` directly instead of vendor SDKs — keeps the
 * core dependency-free so it can run unchanged in Node, the browser, and
 * Capacitor's WebView without bundler config gymnastics.
 */

export type Role = 'user' | 'assistant' | 'system';

export interface Message {
    role: Role;
    content: string;
}

export interface CompletionResult {
    text: string;
    finishReason: string | null;
    /** Total tokens (prompt + completion) when the provider reports it. */
    tokensUsed: number | null;
}

export interface CompletionOptions {
    system?: string;
    maxTokens?: number;
}

/**
 * One chunk of a streamed completion. `text` is the incremental
 * delta only (not the cumulative text). `done` is true on the final
 * chunk; `finishReason` and `tokensUsed` are typically populated only
 * on the final chunk.
 */
export interface StreamChunk {
    text: string;
    done: boolean;
    finishReason?: string | null;
    tokensUsed?: number | null;
}

export interface LLMProvider {
    readonly model: string;
    complete(messages: Message[], options?: CompletionOptions): Promise<CompletionResult>;
    /**
     * Optional — yields incremental text deltas. Callers should
     * feature-check `provider.completeStream` and fall back to
     * `complete()` when it's not implemented.
     */
    completeStream?(
        messages: Message[],
        options?: CompletionOptions
    ): AsyncIterable<StreamChunk>;
}
