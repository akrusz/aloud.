/**
 * OpenAI-compatible chat completions provider.
 *
 * Direct fetch implementation (no SDK) so this runs unchanged in Node,
 * the browser, and Capacitor's WebView. One adapter covers OpenAI,
 * OpenRouter, Venice, and Groq — they all speak the same wire format,
 * they just differ in base URL and default model. The named exports
 * at the bottom of this file bake those defaults in.
 */

import type {
    CompletionOptions,
    CompletionResult,
    LLMProvider,
    Message,
    StreamChunk,
} from './base.js';
import { iterateSseEvents } from './sse.js';

const OPENAI_BASE_URL = 'https://api.openai.com/v1';
const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_MAX_TOKENS = 300;

export interface OpenAIProviderOptions {
    /**
     * API key. Required for direct calls. Omit when pointing `baseUrl`
     * at a proxy that injects the key server-side.
     */
    apiKey?: string;
    model?: string;
    maxTokens?: number;
    /**
     * Base URL ending at `/v1` (no trailing slash). Defaults to
     * api.openai.com. Override for OpenRouter, Venice, Groq, or a proxy.
     */
    baseUrl?: string;
    /**
     * Extra body fields merged into the request — used by Venice for
     * `venice_parameters.include_venice_system_prompt: false`.
     */
    extraBody?: Record<string, unknown>;
    /** Override fetch for testing. */
    fetchImpl?: typeof fetch;
}

interface OpenAIChatResponse {
    choices?: Array<{
        message?: { content?: string | null };
        finish_reason?: string | null;
    }>;
    usage?: { total_tokens?: number };
}

export class OpenAIProvider implements LLMProvider {
    readonly model: string;
    readonly maxTokens: number;
    private readonly apiKey: string | undefined;
    private readonly baseUrl: string;
    private readonly extraBody: Record<string, unknown> | undefined;
    private readonly fetchImpl: typeof fetch;

    constructor(options: OpenAIProviderOptions = {}) {
        const baseUrl = (options.baseUrl ?? OPENAI_BASE_URL).replace(/\/+$/, '');
        const usingProxy = baseUrl !== OPENAI_BASE_URL;
        if (!options.apiKey && !usingProxy) {
            throw new Error(
                'OpenAI API key required when calling api.openai.com directly. ' +
                    'Pass apiKey, or set baseUrl to a proxy that injects the key server-side.'
            );
        }
        this.apiKey = options.apiKey;
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.baseUrl = baseUrl;
        this.extraBody = options.extraBody;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    }

    private buildRequest(
        messages: Message[],
        options: CompletionOptions,
        stream: boolean
    ): RequestInit {
        const openaiMessages: Array<{ role: string; content: string }> = [];
        if (options.system) {
            openaiMessages.push({ role: 'system', content: options.system });
        }
        for (const msg of messages) {
            openaiMessages.push({ role: msg.role, content: msg.content });
        }

        const body: Record<string, unknown> = {
            model: this.model,
            messages: openaiMessages,
            max_tokens: options.maxTokens ?? this.maxTokens,
            ...(stream && {
                stream: true,
                // Some providers (Groq, Together) need this to send usage on
                // the final chunk; OpenAI also recognizes it. Harmless when
                // unsupported.
                stream_options: { include_usage: true },
            }),
        };
        if (this.extraBody) Object.assign(body, this.extraBody);

        const headers: Record<string, string> = {
            'content-type': 'application/json',
        };
        if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
        if (stream) headers['accept'] = 'text/event-stream';

        return { method: 'POST', headers, body: JSON.stringify(body) };
    }

    async complete(
        messages: Message[],
        options: CompletionOptions = {}
    ): Promise<CompletionResult> {
        const init = this.buildRequest(messages, options, false);
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, init);

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`OpenAI-compatible API error ${response.status}: ${detail}`);
        }

        const data = (await response.json()) as OpenAIChatResponse;
        const choice = data.choices?.[0];
        const text = choice?.message?.content ?? '';
        const tokensUsed = data.usage?.total_tokens ?? null;

        return {
            text,
            finishReason: choice?.finish_reason ?? null,
            tokensUsed,
        };
    }

    async *completeStream(
        messages: Message[],
        options: CompletionOptions = {}
    ): AsyncIterable<StreamChunk> {
        const init = this.buildRequest(messages, options, true);
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, init);

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`OpenAI-compatible API error ${response.status}: ${detail}`);
        }

        // OpenAI SSE format:
        //   data: {"choices":[{"delta":{"content":"Hello"},"finish_reason":null}]}
        //   ...
        //   data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{...}}
        //   data: [DONE]
        let finishReason: string | null = null;
        let tokensUsed: number | null = null;

        for await (const evt of iterateSseEvents(response)) {
            const raw = evt.data.trim();
            if (raw === '[DONE]') break;
            const parsed = safeJson<OpenAIStreamChunk>(raw);
            if (!parsed) continue;
            const choice = parsed.choices?.[0];
            const text = choice?.delta?.content;
            if (typeof text === 'string' && text.length > 0) {
                yield { text, done: false };
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (parsed.usage?.total_tokens !== undefined) {
                tokensUsed = parsed.usage.total_tokens;
            }
        }

        yield { text: '', done: true, finishReason, tokensUsed };
    }
}

interface OpenAIStreamChunk {
    choices?: Array<{
        delta?: { content?: string };
        finish_reason?: string | null;
    }>;
    usage?: { total_tokens?: number };
}

function safeJson<T>(s: string): T | null {
    try {
        return JSON.parse(s) as T;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Pre-configured providers for the OpenAI-compatible services we support.
// Each one is just OpenAIProvider with a different default base URL and
// model. Callers can still override either at construction time.
// ---------------------------------------------------------------------------

/**
 * Subclass-style factory: returns a class with provider-specific defaults
 * baked in. Easier to typecheck than three separate class declarations
 * that vary only in two constants.
 */
function preconfigured(defaults: {
    baseUrl: string;
    defaultModel: string;
    extraBody?: Record<string, unknown>;
}): new (options?: OpenAIProviderOptions) => OpenAIProvider {
    return class extends OpenAIProvider {
        constructor(options: OpenAIProviderOptions = {}) {
            super({
                ...options,
                baseUrl: options.baseUrl ?? defaults.baseUrl,
                model: options.model ?? defaults.defaultModel,
                ...(defaults.extraBody && {
                    extraBody: { ...defaults.extraBody, ...(options.extraBody ?? {}) },
                }),
            });
        }
    };
}

/** OpenRouter — multi-vendor LLM proxy. */
export const OpenRouterProvider = preconfigured({
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'deepseek/deepseek-v3.2',
});

/** Venice — privacy-focused open-weights inference. */
export const VeniceProvider = preconfigured({
    baseUrl: 'https://api.venice.ai/api/v1',
    defaultModel: 'llama-3.3-70b',
    // Suppress Venice's stock system prompt so our facilitator prompt wins.
    extraBody: { venice_parameters: { include_venice_system_prompt: false } },
});

/** Groq — fast inference on open-weights models. */
export const GroqProvider = preconfigured({
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
});
