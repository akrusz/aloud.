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
        const by = (model: string) => models.find((m) => m.model === model)!;
        const opus = by('claude-opus-4-7').creditsPerHour;
        const sonnet = by('claude-sonnet-4-6').creditsPerHour;
        const haiku = by('claude-haiku-4-5-20251001').creditsPerHour;
        expect(opus).toBeGreaterThan(sonnet);
        expect(sonnet).toBeGreaterThan(haiku);
        // The measured ~14x Opus:Haiku ratio should be in the right ballpark.
        expect(opus / haiku).toBeGreaterThan(8);
    });

    it('a NO-CACHE model (Groq) can beat a cached cheap model (Haiku) on cost: '
        + 'this workload is ~98% re-sent history, so cheap cache reads matter more than sticker price', () => {
        const by = (model: string) => models.find((m) => m.model === model)!;
        // Groq has no prompt caching, so the heavy re-sent prefix bills at full
        // input rate — making it pricier here than Haiku-with-caching despite a
        // lower sticker price. A real, counterintuitive cost-model fact.
        expect(by('llama-3.3-70b-versatile').creditsPerHour).toBeGreaterThan(
            by('claude-haiku-4-5-20251001').creditsPerHour
        );
    });
});

describe('estimateStt', () => {
    it('is a small, model-independent leg', () => {
        const stt = estimateStt();
        expect(stt.creditsPerHour).toBeGreaterThan(0);
        // VAD-segmented speech makes STT cheap relative to a premium model hour.
        const opus = estimateModels().find((m) => m.model === 'claude-opus-4-7')!;
        expect(stt.creditsPerHour).toBeLessThan(opus.creditsPerHour);
    });
});

describe('estimateVoices', () => {
    const voices = estimateVoices();

    it('local engines cost zero, cloud voices cost something', () => {
        const browser = voices.find((v) => v.voiceId === 'browser-default')!;
        const flash = voices.find((v) => v.voiceId === 'elevenlabs-flash')!;
        expect(browser.creditsPerHour).toBe(0);
        expect(flash.creditsPerHour).toBeGreaterThan(0);
    });

    it('premium cloud voice costs more than flash', () => {
        const flash = voices.find((v) => v.voiceId === 'elevenlabs-flash')!;
        const premium = voices.find((v) => v.voiceId === 'elevenlabs-standard')!;
        expect(premium.creditsPerHour).toBeGreaterThan(flash.creditsPerHour);
    });
});

describe('ttsRateFor', () => {
    it('falls back to a non-zero cloud rate for unknown voices (never bills at 0 by accident)', () => {
        expect(ttsRateFor('some-new-elevenlabs-voice')).toBeGreaterThan(0);
        expect(ttsRateFor('browser-default')).toBe(0);
    });
});
