/**
 * Ollama provider — local inference via the Ollama HTTP API.
 *
 * Direct fetch implementation; no SDK dependency.
 */

import type { CompletionOptions, CompletionResult, LLMProvider, Message } from './base.js';

const DEFAULT_BASE_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'qwen3.5:4b';
const DEFAULT_MAX_TOKENS = 300;

export interface OllamaProviderOptions {
    baseUrl?: string;
    model?: string;
    maxTokens?: number;
    /** Enable thinking/reasoning mode (slower, off by default). */
    think?: boolean;
    /** Override fetch for testing. */
    fetchImpl?: typeof fetch;
}

interface OllamaChatResponse {
    message?: { content?: string };
    done_reason?: string | null;
    prompt_eval_count?: number;
    eval_count?: number;
}

interface OllamaTagsResponse {
    models?: Array<{ name: string }>;
}

export class OllamaProvider implements LLMProvider {
    readonly model: string;
    readonly maxTokens: number;
    readonly think: boolean;
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;

    constructor(options: OllamaProviderOptions = {}) {
        this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.think = options.think ?? false;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    }

    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        const ollamaMessages: Array<{ role: string; content: string }> = [];
        if (options.system) {
            ollamaMessages.push({ role: 'system', content: options.system });
        }
        for (const msg of messages) {
            ollamaMessages.push({ role: msg.role, content: msg.content });
        }

        const response = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
                model: this.model,
                messages: ollamaMessages,
                stream: false,
                think: this.think,
                options: { num_predict: options.maxTokens ?? this.maxTokens },
            }),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Ollama error ${response.status}: ${detail}`);
        }

        const data = (await response.json()) as OllamaChatResponse;
        const text = data.message?.content ?? '';
        const promptTokens = data.prompt_eval_count ?? 0;
        const evalTokens = data.eval_count ?? 0;
        const tokensUsed = data.eval_count !== undefined ? promptTokens + evalTokens : null;

        return {
            text,
            finishReason: data.done_reason ?? null,
            tokensUsed,
        };
    }

    /** True if the configured model (exact or prefix match) is pulled. */
    async checkModelAvailable(): Promise<boolean> {
        try {
            const response = await this.fetchImpl(`${this.baseUrl}/api/tags`);
            if (!response.ok) return false;
            const data = (await response.json()) as OllamaTagsResponse;
            const names = data.models?.map((m) => m.name) ?? [];
            return names.some((n) => n === this.model || n.startsWith(`${this.model}:`));
        } catch {
            return false;
        }
    }

    /**
     * If the configured model isn't currently loaded in Ollama's memory,
     * return a user-facing status string explaining the upcoming cold-load
     * wait. Returns null when the model is already loaded, when Ollama
     * isn't reachable, or when we can't determine load state — in all of
     * those cases the caller has nothing useful to show.
     *
     * Cheap (one HTTP call, 2s timeout); fine to call before every
     * completion. After first use the model stays loaded so subsequent
     * checks return null and the status banner clears itself.
     */
    async coldLoadMessage(): Promise<string | null> {
        try {
            const response = await this.fetchImpl(`${this.baseUrl}/api/ps`);
            if (!response.ok) return null;
            const data = (await response.json()) as OllamaPsResponse;
            const loaded = data.models?.map((m) => m.name) ?? [];
            const isLoaded = loaded.some(
                (n) => n === this.model || n.startsWith(`${this.model}:`)
            );
            if (isLoaded) return null;
            return `Loading ${this.model} into memory… first response can take a few seconds.`;
        } catch {
            return null;
        }
    }
}

interface OllamaPsResponse {
    models?: Array<{ name: string }>;
}
