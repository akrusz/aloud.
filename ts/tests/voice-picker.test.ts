import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildScoredVoiceList, prefixedVoiceId } from '../ui/src/voice-picker.js';

afterEach(() => vi.unstubAllGlobals());

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
