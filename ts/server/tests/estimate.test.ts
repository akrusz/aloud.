import { describe, it, expect } from 'vitest';
import { estimateModels, estimateStt, estimateVoices } from '../src/pricing/estimate.js';
import { ttsRateFor } from '../src/pricing/voices.js';

describe('estimateModels', () => {
    const models = estimateModels();

    it('produces an estimate for every allowed model', () => {
        expect(models.length).toBeGreaterThanOrEqual(3);
        for (const m of models) {
            expect(m.creditsPerSession).toBeGreaterThan(0);
            expect(m.creditsPerHour).toBeGreaterThanOrEqual(m.creditsPerSession);
        }
    });

    it('orders by cost: Opus > Sonnet > Haiku, with a large Opus:Haiku spread', () => {
        // Compare on retail USD, not rounded credits — at CREDIT_USD $0.12 the
        // per-hour credit counts round to small integers and lose ratio precision.
        const usd = (model: string) => models.find((m) => m.model === model)!.retailUsdPerHour;
        expect(usd('claude-opus-4-7')).toBeGreaterThan(usd('claude-sonnet-4-6'));
        expect(usd('claude-sonnet-4-6')).toBeGreaterThan(usd('claude-haiku-4-5-20251001'));
        // ~5x on this cache-heavy workload.
        expect(usd('claude-opus-4-7') / usd('claude-haiku-4-5-20251001')).toBeGreaterThan(3);
    });

    it('a NO-CACHE model (Groq) can beat a cached cheap model (Haiku) on cost: '
        + 'this workload is ~98% re-sent history, so cheap cache reads matter more than sticker price', () => {
        const usd = (model: string) => models.find((m) => m.model === model)!.retailUsdPerHour;
        // Groq has no prompt caching, so the heavy re-sent prefix bills at full
        // input rate — making it pricier here than Haiku-with-caching despite a
        // lower sticker price. A real, counterintuitive cost-model fact.
        expect(usd('llama-3.3-70b-versatile')).toBeGreaterThan(usd('claude-haiku-4-5-20251001'));
    });
});

describe('estimateStt', () => {
    it('is a small, model-independent leg', () => {
        const stt = estimateStt();
        expect(stt.creditsPerHour).toBeGreaterThan(0);
        // VAD-segmented speech makes STT cheap relative to a premium model hour.
        const opus = estimateModels().find((m) => m.model === 'claude-opus-4-7')!;
        expect(stt.retailUsdPerHour).toBeLessThan(opus.retailUsdPerHour);
    });
});

describe('estimateVoices', () => {
    const voices = estimateVoices();

    it('local engines cost zero across the whole band', () => {
        const browser = voices.find((v) => v.voiceId === 'browser-default')!;
        expect(browser.creditsPerHour.spacious).toBe(0);
        expect(browser.creditsPerHour.typical).toBe(0);
        expect(browser.creditsPerHour.engaged).toBe(0);
    });

    it('cloud voice cost rises across the talk band (spacious < typical < engaged)', () => {
        const flash = voices.find((v) => v.voiceId === 'elevenlabs-flash')!;
        expect(flash.creditsPerHour.spacious).toBeLessThan(flash.creditsPerHour.typical);
        expect(flash.creditsPerHour.typical).toBeLessThan(flash.creditsPerHour.engaged);
    });

    it('ElevenLabs is the pricey end; OpenAI/neural are several times cheaper', () => {
        const at = (id: string) => voices.find((v) => v.voiceId === id)!.creditsPerHour.typical;
        expect(at('elevenlabs-standard')).toBeGreaterThan(at('elevenlabs-flash'));
        expect(at('elevenlabs-flash')).toBeGreaterThan(at('openai-tts'));
        expect(at('elevenlabs-flash') / at('openai-tts')).toBeGreaterThan(1.5);
    });
});

describe('ttsRateFor', () => {
    it('falls back to a non-zero cloud rate for unknown voices (never bills at 0 by accident)', () => {
        expect(ttsRateFor('some-new-elevenlabs-voice')).toBeGreaterThan(0);
        expect(ttsRateFor('browser-default')).toBe(0);
    });
});
