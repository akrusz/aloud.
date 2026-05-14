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
    apiKey: string;
    model?: string;
    maxTokens?: number;
    /** Override the API URL for testing. */
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
    private readonly apiKey: string;
    private readonly baseUrl: string;
    private readonly fetchImpl: typeof fetch;

    constructor(options: AnthropicProviderOptions) {
        if (!options.apiKey) {
            throw new Error(
                'Anthropic API key required. Pass apiKey or set it from your env loader.'
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

        const response = await this.fetchImpl(this.baseUrl, {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-api-key': this.apiKey,
                'anthropic-version': ANTHROPIC_API_VERSION,
            },
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
