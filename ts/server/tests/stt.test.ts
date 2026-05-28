import { describe, it, expect, beforeEach } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import { encodeWav } from '../src/providers/stt.js';
import type { AuthResponse, TranscribeResponse } from '../src/contract.js';

// Stub global fetch so the route's Groq call never hits the network. Returns a
// fixed transcript and records the request for assertions.
let groqCalls: Array<{ url: string; hasFile: boolean }> = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
    groqCalls = [];
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        const u = String(url);
        if (u.includes('groq.com')) {
            const body = init?.body as FormData | undefined;
            groqCalls.push({ url: u, hasFile: body instanceof FormData && body.has('file') });
            return new Response(JSON.stringify({ text: '  hello world  ' }), { status: 200 });
        }
        return realFetch(url, init);
    }) as typeof fetch;
});

function app() {
    const config = loadConfig({ GROQ_API_KEY: 'gsk-test', ALOUD_FREE_SIGNUP_CREDITS: '20' });
    return createApp(buildDeps(config));
}

async function devToken(a: ReturnType<typeof createApp>): Promise<string> {
    const res = await a.request('/cloud/v1/auth/dev', { method: 'POST' });
    return ((await res.json()) as AuthResponse).token;
}

/** 1 second of silence at 16 kHz as raw Float32 little-endian bytes. */
function pcmBody(seconds: number, rate = 16_000): ArrayBuffer {
    return new Float32Array(Math.round(seconds * rate)).buffer;
}

describe('encodeWav', () => {
    it('writes a 44-byte RIFF/WAVE header and 16-bit samples', () => {
        const wav = encodeWav(new Float32Array([0, 1, -1]), 16_000);
        const dv = new DataView(wav.buffer);
        expect(String.fromCharCode(wav[0]!, wav[1]!, wav[2]!, wav[3]!)).toBe('RIFF');
        expect(String.fromCharCode(wav[8]!, wav[9]!, wav[10]!, wav[11]!)).toBe('WAVE');
        expect(dv.getUint32(24, true)).toBe(16_000); // sample rate
        expect(dv.getUint16(34, true)).toBe(16); // bits per sample
        expect(wav.length).toBe(44 + 3 * 2);
        expect(dv.getInt16(44 + 2, true)).toBe(0x7fff); // +1.0 → max
        expect(dv.getInt16(44 + 4, true)).toBe(-0x8000); // -1.0 → min
    });
});

describe('POST /cloud/v1/stt', () => {
    it('transcribes via Groq and debits fractional credits by duration', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt?sample_rate=16000', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' },
            body: pcmBody(10),
        });
        expect(res.status).toBe(200);
        const body = (await res.json()) as TranscribeResponse;
        expect(body.text).toBe('hello world'); // trimmed
        expect(groqCalls).toHaveLength(1);
        expect(groqCalls[0]!.hasFile).toBe(true);
        // 10s × $0.04/3600 / $0.05 per credit ≈ 0.0022 credits — fractional, tiny.
        expect(body.creditsCharged).toBeGreaterThan(0);
        expect(body.creditsCharged).toBeLessThan(0.01);
        expect(body.creditsRemaining).toBeCloseTo(20 - body.creditsCharged, 6);
    });

    it('requires auth', async () => {
        const res = await app().request('/cloud/v1/stt', { method: 'POST', body: pcmBody(1) });
        expect(res.status).toBe(401);
    });

    it('rejects a misaligned / empty body', async () => {
        const a = app();
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: new Uint8Array([1, 2, 3]).buffer, // not a multiple of 4
        });
        expect(res.status).toBe(400);
    });

    it('reports provider_error when no Groq key is configured', async () => {
        const config = loadConfig({ ALOUD_FREE_SIGNUP_CREDITS: '20' }); // no GROQ_API_KEY
        const a = createApp(buildDeps(config));
        const token = await devToken(a);
        const res = await a.request('/cloud/v1/stt', {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            body: pcmBody(1),
        });
        expect(res.status).toBe(502);
    });
});
