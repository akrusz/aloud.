import { describe, it, expect } from 'vitest';
import {
    CREDIT_USD,
    MARGIN_MULTIPLIER,
    assertSolvent,
    llmCostUsd,
    priceLlmTurn,
    priceSession,
} from '../src/pricing/meter.js';

describe('llmCostUsd', () => {
    it('prices input, output, and cache-read separately (never summed)', () => {
        // sonnet: 3/M in, 15/M out, 0.3/M cache-read
        const cost = llmCostUsd('anthropic', 'claude-sonnet-4-6', {
            tokensIn: 1_000_000,
            tokensOut: 1_000_000,
            cacheRead: 1_000_000,
        });
        expect(cost).toBeCloseTo(3 + 15 + 0.3, 6);
    });

    it('returns 0 for an unknown model rather than throwing', () => {
        expect(llmCostUsd('anthropic', 'no-such-model', { tokensIn: 1000 })).toBe(0);
    });

    it('treats null/absent usage fields as zero', () => {
        expect(llmCostUsd('anthropic', 'claude-sonnet-4-6', {})).toBe(0);
        expect(
            llmCostUsd('anthropic', 'claude-sonnet-4-6', { tokensIn: null, tokensOut: 1000 })
        ).toBeCloseTo(1000 * (15 / 1_000_000), 9);
    });
});

describe('priceLlmTurn', () => {
    it('applies the margin multiplier and rounds credits up', () => {
        const turn = priceLlmTurn('anthropic', 'claude-sonnet-4-6', {
            tokensIn: 1000,
            tokensOut: 500,
        });
        const expectedUsd = (1000 * 3 + 500 * 15) / 1_000_000; // raw provider cost
        expect(turn.providerCostUsd).toBeCloseTo(expectedUsd, 9);
        expect(turn.retailUsd).toBeCloseTo(expectedUsd * MARGIN_MULTIPLIER, 9);
        expect(turn.credits).toBe(Math.ceil((expectedUsd * MARGIN_MULTIPLIER) / CREDIT_USD));
        expect(Number.isInteger(turn.credits)).toBe(true);
    });
});

describe('priceSession', () => {
    it('sums all three metered legs (llm + stt + tts)', () => {
        const turn = priceSession('groq', 'llama-3.3-70b-versatile', {
            llmCalls: 1,
            llmTokensIn: 1000,
            llmTokensOut: 1000,
            llmCacheRead: 0,
            llmCacheCreation: 0,
            sttSeconds: 60,
            ttsChars: 500,
        });
        expect(turn.providerCostUsd).toBeGreaterThan(0);
        expect(turn.credits).toBeGreaterThan(0);
    });
});

describe('assertSolvent', () => {
    it('clears every channel at the default 2x multiplier', () => {
        const reports = assertSolvent();
        expect(reports.length).toBeGreaterThan(0);
        for (const r of reports) {
            expect(r.clears).toBe(true);
            expect(r.netMarginRatio).toBeGreaterThan(0);
        }
    });

    it('the 15% IAP floor requires >= ~1.176x and 2x clears it', () => {
        const iap = assertSolvent().find((r) => r.channel === 'iap_apple');
        expect(iap).toBeDefined();
        expect(iap!.requiredMultiplier).toBeCloseTo(1 / 0.85, 3);
        expect(MARGIN_MULTIPLIER).toBeGreaterThanOrEqual(iap!.requiredMultiplier);
    });
});
