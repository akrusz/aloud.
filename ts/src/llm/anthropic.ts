/**
 * Anthropic API provider — direct fetch, no SDK.
 *
 * Mirrors the Python implementation's use of cache_control on the system
 * prompt: repeat calls within a session pay ~10% input cost for the
 * cached prefix, which is a big deal for long facilitation sessions.
 */

import type { CompletionOptions, CompletionResult, LLMProvider, Message } from './base.js';

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

interface AnthropicMessagesResponse {
    content?: Array<{ type: string; text?: string }>;
    stop_reason?: string | null;
    usage?: { input_tokens?: number; output_tokens?: number };
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

    async complete(messages: Message[], options: CompletionOptions = {}): Promise<CompletionResult> {
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
        };
        if (systemParam) body['system'] = systemParam;

        const headers: Record<string, string> = {
            'content-type': 'application/json',
            'anthropic-version': ANTHROPIC_API_VERSION,
        };
        if (this.apiKey) headers['x-api-key'] = this.apiKey;

        const response = await this.fetchImpl(this.baseUrl, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
        });

        if (!response.ok) {
            const detail = await response.text().catch(() => '');
            throw new Error(`Anthropic API error ${response.status}: ${detail}`);
        }

        const data = (await response.json()) as AnthropicMessagesResponse;
        const text = data.content?.[0]?.text ?? '';
        const tokensUsed =
            data.usage && (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0);

        return {
            text,
            finishReason: data.stop_reason ?? null,
            tokensUsed: typeof tokensUsed === 'number' ? tokensUsed : null,
        };
    }
}
