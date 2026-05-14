import { describe, it, expect, vi } from 'vitest';

import { AnthropicProvider } from '../src/llm/anthropic.js';
import { OllamaProvider } from '../src/llm/ollama.js';

function mockJsonResponse(data: unknown, init: { ok?: boolean; status?: number } = {}): Response {
    const body = JSON.stringify(data);
    return new Response(body, {
        status: init.status ?? (init.ok === false ? 500 : 200),
        headers: { 'content-type': 'application/json' },
    });
}

describe('AnthropicProvider', () => {
    it('throws if no API key provided and no proxy URL', () => {
        expect(() => new AnthropicProvider({ apiKey: '' })).toThrow(/API key/);
    });

    it('accepts an empty apiKey when baseUrl points at a proxy', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({ content: [{ type: 'text', text: 'ok' }] })
        );
        const provider = new AnthropicProvider({
            baseUrl: '/api/llm/anthropic/messages',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }]);
        const [, init] = fetchImpl.mock.calls[0]!;
        const headers = (init as RequestInit).headers as Record<string, string>;
        // No x-api-key header — proxy injects it server-side
        expect(headers['x-api-key']).toBeUndefined();
        expect(headers['anthropic-version']).toBe('2023-06-01');
    });

    it('sends the system prompt with ephemeral cache_control and strips system from messages', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                content: [{ type: 'text', text: 'Welcome.' }],
                stop_reason: 'end_turn',
                usage: { input_tokens: 100, output_tokens: 5 },
            })
        );
        const provider = new AnthropicProvider({
            apiKey: 'test-key',
            model: 'claude-test',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        const result = await provider.complete(
            [
                { role: 'system', content: 'should be stripped' },
                { role: 'user', content: 'hi' },
            ],
            { system: 'be warm' }
        );

        expect(result.text).toBe('Welcome.');
        expect(result.finishReason).toBe('end_turn');
        expect(result.tokensUsed).toBe(105);

        expect(fetchImpl).toHaveBeenCalledTimes(1);
        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(url).toContain('/v1/messages');
        const headers = (init as RequestInit).headers as Record<string, string>;
        expect(headers['x-api-key']).toBe('test-key');
        expect(headers['anthropic-version']).toBe('2023-06-01');

        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.model).toBe('claude-test');
        expect(body.system).toEqual([
            { type: 'text', text: 'be warm', cache_control: { type: 'ephemeral' } },
        ]);
        // System messages are filtered out of the messages array
        expect(body.messages).toEqual([{ role: 'user', content: 'hi' }]);
    });

    it('omits the system field when no system prompt provided', async () => {
        const fetchImpl = vi.fn(async () => mockJsonResponse({ content: [{ type: 'text', text: '' }] }));
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await provider.complete([{ role: 'user', content: 'hi' }]);
        const body = JSON.parse(((fetchImpl.mock.calls[0]?.[1] as RequestInit).body) as string);
        expect(body.system).toBeUndefined();
    });

    it('surfaces API errors with the status code', async () => {
        const fetchImpl = vi.fn(async () => new Response('rate limited', { status: 429 }));
        const provider = new AnthropicProvider({
            apiKey: 'k',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        await expect(provider.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/429/);
    });
});

describe('OllamaProvider', () => {
    it('sends system as a leading message and uses num_predict for max tokens', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                message: { content: 'What do you notice?' },
                done_reason: 'stop',
                prompt_eval_count: 20,
                eval_count: 8,
            })
        );
        const provider = new OllamaProvider({
            model: 'qwen3.5:4b',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });

        const result = await provider.complete(
            [{ role: 'user', content: "I'm here" }],
            { system: 'be a facilitator', maxTokens: 150 }
        );

        expect(result.text).toBe('What do you notice?');
        expect(result.finishReason).toBe('stop');
        expect(result.tokensUsed).toBe(28);

        const [url, init] = fetchImpl.mock.calls[0]!;
        expect(url).toBe('http://localhost:11434/api/chat');
        const body = JSON.parse((init as RequestInit).body as string);
        expect(body.model).toBe('qwen3.5:4b');
        expect(body.stream).toBe(false);
        expect(body.think).toBe(false);
        expect(body.options).toEqual({ num_predict: 150 });
        expect(body.messages).toEqual([
            { role: 'system', content: 'be a facilitator' },
            { role: 'user', content: "I'm here" },
        ]);
    });

    it('strips trailing slashes from the base URL', () => {
        const provider = new OllamaProvider({ baseUrl: 'http://localhost:11434/' });
        // The trailing-slash strip is private — verify indirectly via a request.
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({ message: { content: '' }, eval_count: 0, prompt_eval_count: 0 })
        );
        const p = new OllamaProvider({
            baseUrl: 'http://localhost:11434/',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        void provider;
        return p.complete([{ role: 'user', content: 'x' }]).then(() => {
            expect(fetchImpl.mock.calls[0]?.[0]).toBe('http://localhost:11434/api/chat');
        });
    });

    it('checkModelAvailable matches exact and prefixed model names', async () => {
        const fetchImpl = vi.fn(async () =>
            mockJsonResponse({
                models: [{ name: 'qwen3.5:4b' }, { name: 'gemma:2b' }],
            })
        );
        const provider = new OllamaProvider({
            model: 'qwen3.5',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(await provider.checkModelAvailable()).toBe(true);

        const notFound = new OllamaProvider({
            model: 'mistral',
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(await notFound.checkModelAvailable()).toBe(false);
    });

    it('checkModelAvailable returns false on network error', async () => {
        const fetchImpl = vi.fn(async () => {
            throw new Error('econnrefused');
        });
        const provider = new OllamaProvider({
            fetchImpl: fetchImpl as unknown as typeof fetch,
        });
        expect(await provider.checkModelAvailable()).toBe(false);
    });
});
