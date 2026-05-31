/**
 * Anthropic API provider — direct fetch, no SDK.
 *
 * Mirrors the Python implementation's use of cache_control on the system
 * prompt: repeat calls within a session pay ~10% input cost for the
 * cached prefix, which is a big deal for long facilitation sessions.
 */

import type {
    CompletionOptions,
    CompletionResult,
    LLMProvider,
    Message,
    StreamChunk,
} from './base.js';
import { iterateSseEvents } from './sse.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_MAX_TOKENS = 300;

export interface AnthropicProviderOptions {
    /**
     * Anthropic API key. Required for direct calls to api.anthropic.com.
     * Omit when pointing `baseUrl` at a proxy that supplies the key
     * server-side — the proxy will reject browser requests carrying a
     * fake key anyway, so it's cleaner to send no `x-api-key` header.
     */
    apiKey?: string;
    model?: string;
    maxTokens?: number;
    /**
     * Endpoint URL. Defaults to Anthropic's hosted API. Override with a
     * proxy URL (e.g. "/api/llm/anthropic/messages") when running in
     * the browser, since Anthropic blocks browser-origin CORS.
     */
    baseUrl?: string;
    /** Override fetch for testing. */
    fetchImpl?: typeof fetch;
}

interface AnthropicUsage {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
}

interface AnthropicMessagesResponse {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string | null;
    usage?: AnthropicUsage;
}

export class AnthropicProvider implements LLMProvider {
    readonly model: string;
    readonly maxTokens: number;
    private readonly apiKey: string | undefined;
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;

    constructor(options: AnthropicProviderOptions = {}) {
        const usingProxy = options.baseUrl !== undefined && options.baseUrl !== ANTHROPIC_API_URL;
        if (!options.apiKey && !usingProxy) {
            throw new Error(
                'Anthropic API key required when calling api.anthropic.com directly. ' +
                    'Pass apiKey, or set baseUrl to a proxy that injects the key server-side.'
            );
        }
        this.apiKey = options.apiKey;
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.baseUrl = options.baseUrl ?? ANTHROPIC_API_URL;
        this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    }

    private buildRequest(
        messages: Message[],
        options: CompletionOptions,
        stream: boolean
    ): { url: string; init: RequestInit } {
        const anthropicMessages = messages
            .filter((m) => m.role !== 'system')
            .map((m) => ({ role: m.role, content: m.content }));

        const systemParam = options.system
            ? [
                  {
                      type: 'text',
                      text: options.system,
                      cache_control: { type: 'ephemeral' },
                  },
              ]
            : undefined;

        const body: Record<string, unknown> = {
            model: this.model,
            max_tokens: options.maxTokens ?? this.maxTokens,
            messages: anthropicMessages,
            ...(stream && { stream: true }),
        };
        if (systemParam) body['system'] = systemParam;

        const headers: Record<string, string> = {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_API_VERSION,
        };
        if (this.apiKey) headers['x-api-key'] = this.apiKey;
        if (stream) headers['accept'] = 'text/event-stream';

        return {
            url: this.baseUrl,
            init: { method: 'POST', headers, body: JSON.stringify(body) },
        };
    }

    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
        const { url, init } = this.buildRequest(messages, options, false);
        const response = await this.fetchImpl(url, init);

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Anthropic API error ${response.status}: ${detail}`);
        }

        const data = (await response.json()) as AnthropicMessagesResponse;
        const text = data.content?.[0]?.text ?? '';

        return {
            text,
            finishReason: data.stop_reason ?? null,
            ...usageToResult(data.usage),
        };
    }

    async *completeStream(
        messages: Message[],
        options: CompletionOptions = {}
    ): AsyncIterable<StreamChunk> {
        const { url, init } = this.buildRequest(messages, options, true);
        const response = await this.fetchImpl(url, init);

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Anthropic API error ${response.status}: ${detail}`);
        }

        // Anthropic SSE events of interest:
        //   content_block_delta — { delta: { type: 'text_delta', text } }
        //   message_delta       — final stop_reason + usage
        //   message_stop        — terminator (no payload we need)
        let stopReason: string | null = null;
        let usage: AnthropicUsage | undefined;

        for await (const evt of iterateSseEvents(response)) {
            if (evt.event === 'content_block_delta') {
                const parsed = safeJson<{ delta?: { type?: string; text?: string } }>(evt.data);
                const delta = parsed?.delta;
                if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                    yield { text: delta.text, done: false };
                }
            } else if (evt.event === 'message_start') {
                // Initial usage (input + cache tokens) arrives here; output
                // tokens are finalized in message_delta. Merge both.
                const parsed = safeJson<{ message?: { usage?: AnthropicUsage } }>(evt.data);
                if (parsed?.message?.usage) usage = { ...usage, ...parsed.message.usage };
            } else if (evt.event === 'message_delta') {
                const parsed = safeJson<{
                    delta?: { stop_reason?: string | null };
                    usage?: AnthropicUsage;
                }>(evt.data);
                if (parsed?.delta?.stop_reason !== undefined) {
                    stopReason = parsed.delta.stop_reason;
                }
                if (parsed?.usage) usage = { ...usage, ...parsed.usage };
            } else if (evt.event === 'message_stop') {
                break;
            }
        }

        yield { text: '', done: true, finishReason: stopReason, ...usageToResult(usage) };
    }
}

/**
 * Map Anthropic's usage object to the CompletionResult split fields. Cache
 * fields are only present when prompt caching is active. `tokensUsed` keeps
 * the input+output sum for back-compat (cache reads/creation excluded, to
 * match how the Python provider sums input+output).
 */
function usageToResult(usage: AnthropicUsage | undefined): {
    tokensUsed: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
} {
    if (!usage) {
        return {
            tokensUsed: null,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheCreationTokens: null,
        };
    }
    const inputTokens = usage.input_tokens ?? 0;
    const outputTokens = usage.output_tokens ?? 0;
    return {
        tokensUsed: inputTokens + outputTokens,
        inputTokens,
        outputTokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? null,
        cacheCreationTokens: usage.cache_creation_input_tokens ?? null,
    };
}

function safeJson<T>(s: string): T | null {
    try {
        return JSON.parse(s) as T;
    } catch {
        return null;
    }
}
