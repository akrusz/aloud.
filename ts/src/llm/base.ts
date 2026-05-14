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

export interface LLMProvider {
    readonly model: string;
    complete(messages: Message[], options?: CompletionOptions): Promise<CompletionResult>;
}
