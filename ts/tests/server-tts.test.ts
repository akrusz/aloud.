import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ServerTtsEngine } from '../ui/src/adapters/server-tts.js';

// HTMLAudioElement isn't in the Node test env; stub a minimal Audio that
// "plays" instantly so speak() resolves. The adapter only needs play() +
// the lifecycle event handlers.
beforeEach(() => {
    (globalThis as unknown as { Audio: unknown }).Audio = class {
        onended: (() => void) | null = null;
        onerror: (() => void) | null = null;
        onpause: (() => void) | null = null;
        preload = '';
        src = '';
        constructor(public url?: string) {}
        play() {
            queueMicrotask(() => this.onended?.());
            return Promise.resolve();
        }
        pause() {}
    };
    (globalThis as unknown as { URL: typeof URL }).URL.createObjectURL = () => 'blob:x';
    (globalThis as unknown as { URL: typeof URL }).URL.revokeObjectURL = () => {};
});

describe('ServerTtsEngine (hosted POST mode)', () => {
    it('POSTs JSON with a bearer token and the voice/rate, then plays the audio', async () => {
        let seen: { url: string; init: RequestInit } | null = null;
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
            seen = { url: String(url), init: init! };
            return new Response(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/mpeg' }), {
                status: 200,
            });
        }) as unknown as typeof fetch;

        const onSynthesize = vi.fn();
        const engine = new ServerTtsEngine({
            voice: 'en-US-Chirp3-HD-Achernar',
            endpointUrl: '/v1/tts',
            usePost: true,
            authProvider: async () => 'tok-123',
            fetchImpl,
            onSynthesize,
        });

        await engine.speak('Breathe in.', { rate: 0.9 });

        expect(seen).not.toBeNull();
        const { url, init } = seen!;
        expect(url).toBe('/v1/tts');
        expect(init.method).toBe('POST');
        expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer tok-123');
        const body = JSON.parse(init.body as string);
        expect(body).toMatchObject({ text: 'Breathe in.', voice: 'en-US-Chirp3-HD-Achernar', rate: 0.9 });
        expect(onSynthesize).toHaveBeenCalledWith('Breathe in.'.length);
    });

    it('still supports the legacy GET query mode (Flask)', async () => {
        let seenUrl = '';
        const fetchImpl = (async (url: string | URL | Request) => {
            seenUrl = String(url);
            return new Response(new Blob([new Uint8Array([1])], { type: 'audio/wav' }), { status: 200 });
        }) as unknown as typeof fetch;

        const engine = new ServerTtsEngine({ voice: 'Samantha', endpointUrl: '/api/voices/preview', fetchImpl });
        await engine.speak('hello');
        expect(seenUrl).toContain('/api/voices/preview?');
        expect(seenUrl).toContain('voice=Samantha');
    });
});
