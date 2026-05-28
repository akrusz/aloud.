import { describe, it, expect, vi, afterEach } from 'vitest';
import {
    buildScoredVoiceList,
    downloadPercent,
    downloadVoiceModel,
    prefixedVoiceId,
} from '../ui/src/voice-picker.js';

afterEach(() => vi.unstubAllGlobals());

/** A Response whose body streams the given NDJSON lines as UTF-8 chunks. */
function ndjsonResponse(lines: string[], chunking: 'whole' | 'split' = 'whole'): Response {
    const enc = new TextEncoder();
    const payload = lines.map((l) => l + '\n').join('');
    const chunks =
        chunking === 'whole'
            ? [enc.encode(payload)]
            : // Split mid-line to exercise the buffer-reassembly path.
              [enc.encode(payload.slice(0, 7)), enc.encode(payload.slice(7))];
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const c of chunks) controller.enqueue(c);
            controller.close();
        },
    });
    return new Response(body, { status: 200 });
}

describe('prefixedVoiceId', () => {
    it('prefixes by engine', () => {
        expect(prefixedVoiceId('aloud', 'Leda')).toBe('aloud:Leda');
        expect(prefixedVoiceId('browser', 'Samantha')).toBe('browser:Samantha');
        expect(prefixedVoiceId('macos', 'Ava')).toBe('server:Ava'); // default
        expect(prefixedVoiceId(undefined, 'X')).toBe('server:X');
    });
});

describe('buildScoredVoiceList with hosted voices', () => {
    it('floats curated hosted voices into Recommended with a gender note', () => {
        vi.stubGlobal('navigator', { language: 'en-US' });
        // No speechSynthesis in this env → browser voices empty; no Flask voices.
        const scored = buildScoredVoiceList(null, false, [
            { name: 'Pulcherrima', gender: 'androgynous' },
            { name: 'Leda', gender: 'female' },
        ]);
        expect(scored).toHaveLength(2);
        const pul = scored.find((v) => v.name === 'Pulcherrima')!;
        expect(pul.engine).toBe('aloud');
        expect(pul.recommended).toBe(true);
        expect(pul.score).toBe(3);
        expect(pul.note).toBe('androgynous');
    });

    it('defaults to no hosted voices (availability-driven) when none are passed', () => {
        vi.stubGlobal('navigator', { language: 'en-US' });
        const scored = buildScoredVoiceList(null, false);
        expect(scored.filter((v) => v.engine === 'aloud')).toHaveLength(0);
    });
});

describe('downloadPercent', () => {
    it('uses per-file total while downloading the main model', () => {
        expect(downloadPercent({ completed: 30, total: 60, file: 'x.onnx' })).toBe(50);
    });
    it('pins to 100 once cumulative bytes exceed the tiny json file total', () => {
        // completed (whole onnx) > total (json content-length) → clamp to 100.
        expect(downloadPercent({ completed: 60_000_000, total: 20_000, file: 'x.onnx.json' })).toBe(
            100
        );
    });
    it('returns 0 when no size is known yet', () => {
        expect(downloadPercent({ completed: 0, total: 0, file: '' })).toBe(0);
    });
});

describe('downloadVoiceModel', () => {
    it('reports progress and resolves on done', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            ndjsonResponse([
                JSON.stringify({ status: 'downloading', total: 100, completed: 50, file: 'a.onnx' }),
                JSON.stringify({ status: 'downloading', total: 100, completed: 100, file: 'a.onnx' }),
                JSON.stringify({ status: 'done' }),
            ])
        );
        vi.stubGlobal('fetch', fetchMock);

        const progress: number[] = [];
        await downloadVoiceModel('en_US-lessac-medium', 'piper', (p) => progress.push(p.completed));

        expect(progress).toEqual([50, 100]);
        const [, init] = fetchMock.mock.calls[0];
        expect(JSON.parse((init as RequestInit).body as string)).toEqual({
            voice: 'en_US-lessac-medium',
            engine: 'piper',
        });
    });

    it('reassembles progress lines split across stream chunks', async () => {
        const fetchMock = vi.fn().mockResolvedValue(
            ndjsonResponse(
                [
                    JSON.stringify({ status: 'downloading', total: 8, completed: 8, file: 'a' }),
                    JSON.stringify({ status: 'done' }),
                ],
                'split'
            )
        );
        vi.stubGlobal('fetch', fetchMock);
        const seen: number[] = [];
        await downloadVoiceModel('v', 'piper', (p) => seen.push(p.completed));
        expect(seen).toEqual([8]);
    });

    it('rejects on an error line', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValue(ndjsonResponse([JSON.stringify({ status: 'error', error: 'boom' })]));
        vi.stubGlobal('fetch', fetchMock);
        await expect(downloadVoiceModel('v', 'piper')).rejects.toThrow('boom');
    });

    it('rejects on a non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('', { status: 500 })));
        await expect(downloadVoiceModel('v', 'piper')).rejects.toThrow('500');
    });
});
