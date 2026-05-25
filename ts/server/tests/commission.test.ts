import { describe, it, expect } from 'vitest';
import { commissionFor, WORST_CASE_COMMISSION } from '../src/pricing/commission.js';

describe('commissionFor', () => {
    it('US web checkout is the cheapest path (~Stripe only)', () => {
        expect(commissionFor('web_stripe', 'US').rate).toBeCloseTo(0.03, 3);
    });

    it('EU web checkout models the Apple Core Technology Commission on top', () => {
        expect(commissionFor('web_stripe', 'EU').rate).toBeGreaterThan(
            commissionFor('web_stripe', 'US').rate
        );
    });

    it('IAP fallback uses the small-business floor', () => {
        expect(commissionFor('iap_apple', 'US').rate).toBeCloseTo(0.15, 3);
        expect(commissionFor('iap_google', 'US').rate).toBeCloseTo(0.15, 3);
    });

    it('falls back to a jurisdiction default rather than throwing', () => {
        const unknown = commissionFor('web_stripe', 'JP');
        expect(unknown.rate).toBeGreaterThan(0);
    });

    it('worst-case constant bounds the table', () => {
        expect(commissionFor('web_stripe', 'EU').rate).toBeLessThanOrEqual(WORST_CASE_COMMISSION);
    });
});
