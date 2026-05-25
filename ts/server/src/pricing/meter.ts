/**
 * The metered-billing core (meditation-pal-8sj): price each unit of usage by
 * its ACTUAL underlying cost x a margin multiplier, debited from a credit
 * balance. Metered debit is the direct fix for the cost-math trap
 * meditation-pal-a2j flags — a daily power user's heavy use can never run at a
 * loss, because every token they burn is repriced upward, not amortized
 * against a flat subscription.
 *
 * Money model (kept deliberately simple and transparent):
 *   - 1 credit = CREDIT_USD of retail value (default $0.01).
 *   - A unit of usage costs `providerCostUsd`; the user is charged
 *     providerCostUsd * MARGIN_MULTIPLIER, converted to credits.
 *   - Credits are sold at face value, so the per-credit economics reduce to:
 *     a pack of N credits costs N * CREDIT_USD; the provider cost those
 *     credits will fund is (creditsSpent * CREDIT_USD) / MARGIN_MULTIPLIER.
 *
 * Solvency requirement (the addendum's "must clear positive margin at the 15%
 * IAP floor"): net revenue after commission must exceed the provider cost the
 * sold credits fund. With face-value pricing that is exactly
 *     MARGIN_MULTIPLIER >= 1 / (1 - commission)
 * e.g. 15% IAP needs >= 1.176x; 18% EU needs >= 1.22x; 30% needs >= 1.43x.
 * `assertSolvent()` enforces this at boot against the worst configured channel.
 */

import type { LlmUsage, SessionUsage } from '@aloud/core/facilitation';
import { WORST_CASE_COMMISSION, commissionFor } from './commission.js';
import type { PurchaseChannel } from '../contract.js';
import {
    STT_USD_PER_SECOND,
    TTS_USD_PER_CHAR,
    pricingFor,
} from './providers.js';
import type { ProviderId } from '../contract.js';

/** Retail value of one credit, in USD. Tentative $0.12 — chosen so per-session
 *  estimates read as small friendly integers (Opus ~hr ≈ single digits). To be
 *  calibrated against real testing before launch (meditation-pal-7xl). */
export const CREDIT_USD = 0.12;

/** Markup over raw provider cost. 2x is comfortably above the worst-case
 *  commission floor (see assertSolvent) and leaves headroom for STT/TTS and
 *  unpriced overhead. Tune in the open; it's published. */
export const MARGIN_MULTIPLIER = 2.0;

/** USD provider cost of one LLM turn from its usage split. */
export function llmCostUsd(provider: ProviderId, model: string, usage: LlmUsage): number {
    const p = pricingFor(provider, model);
    if (!p) return 0;
    // Cache CREATION is billed (Anthropic ~1.25x input) — not free. With
    // history caching on it's a real leg, so it must be charged here or the
    // proxy under-bills. cache READ is the cheap ~0.1x leg.
    return (
        (usage.tokensIn ?? 0) * p.input +
        (usage.tokensOut ?? 0) * p.output +
        (usage.cacheRead ?? 0) * p.cacheRead +
        (usage.cacheCreation ?? 0) * p.cacheCreation
    );
}

export interface CostBreakdown {
    providerCostUsd: number;
    retailUsd: number;
    /** Credits to debit (rounded up — we never under-charge to a fraction). */
    credits: number;
}

function toCredits(providerCostUsd: number): CostBreakdown {
    const retailUsd = providerCostUsd * MARGIN_MULTIPLIER;
    const credits = Math.ceil(retailUsd / CREDIT_USD);
    return { providerCostUsd, retailUsd, credits };
}

/** Retail credits for a raw provider-cost USD amount (margin applied, rounded
 *  up). Used by the estimate engine to price legs (e.g. TTS) outside a full
 *  SessionUsage. */
export function usdToCredits(providerCostUsd: number): number {
    return Math.ceil((providerCostUsd * MARGIN_MULTIPLIER) / CREDIT_USD);
}

/** Price a single LLM turn (the proxy's hot path). */
export function priceLlmTurn(provider: ProviderId, model: string, usage: LlmUsage): CostBreakdown {
    return toCredits(llmCostUsd(provider, model, usage));
}

/** Price a whole session's accumulated usage (LLM + STT secs + TTS chars),
 *  e.g. for a final reconciliation or the live cost meter (meditation-pal-14s).
 *  LLM provider/model are passed since SessionUsage tallies tokens provider-
 *  agnostically; pass the dominant model used. */
export function priceSession(
    provider: ProviderId,
    model: string,
    usage: SessionUsage
): CostBreakdown {
    const p = pricingFor(provider, model);
    const llm = p
        ? usage.llmTokensIn * p.input +
          usage.llmTokensOut * p.output +
          usage.llmCacheRead * p.cacheRead +
          usage.llmCacheCreation * p.cacheCreation
        : 0;
    const stt = usage.sttSeconds * STT_USD_PER_SECOND;
    const tts = usage.ttsChars * TTS_USD_PER_CHAR;
    return toCredits(llm + stt + tts);
}

/** A conservative pre-auth hold placed at session start, before any usage is
 *  known (meditation-pal-8sj: "a small pre-auth hold at session start").
 *  Sized to a few minutes of premium use; the unused remainder is released on
 *  settle. */
export const SESSION_HOLD_CREDITS = 25;

export interface SolvencyReport {
    marginMultiplier: number;
    channel: PurchaseChannel;
    jurisdiction: string;
    commission: number;
    requiredMultiplier: number;
    clears: boolean;
    netMarginRatio: number;
}

/** Does MARGIN_MULTIPLIER clear positive net margin on every channel we sell
 *  through? Called at boot; throws if any channel would run at a loss. This is
 *  the addendum's hard requirement made executable. */
export function assertSolvent(): SolvencyReport[] {
    const channels: Array<[PurchaseChannel, string]> = [
        ['web_stripe', 'US'],
        ['web_stripe', 'EU'],
        ['iap_apple', 'US'],
        ['iap_google', 'US'],
    ];
    const reports = channels.map(([channel, jurisdiction]): SolvencyReport => {
        const commission = commissionFor(channel, jurisdiction).rate;
        const requiredMultiplier = 1 / (1 - commission);
        // Net margin per credit spent, as a fraction above break-even:
        //   revenue after commission = CREDIT_USD * (1 - commission)
        //   cost funded              = CREDIT_USD / MARGIN_MULTIPLIER
        const netMarginRatio =
            (1 - commission) - 1 / MARGIN_MULTIPLIER;
        return {
            marginMultiplier: MARGIN_MULTIPLIER,
            channel,
            jurisdiction,
            commission,
            requiredMultiplier,
            clears: MARGIN_MULTIPLIER >= requiredMultiplier,
            netMarginRatio,
        };
    });
    const failing = reports.filter((r) => !r.clears);
    if (failing.length > 0) {
        const detail = failing
            .map((r) => `${r.channel}/${r.jurisdiction} needs >=${r.requiredMultiplier.toFixed(3)}x`)
            .join('; ');
        throw new Error(
            `Pricing is insolvent: MARGIN_MULTIPLIER=${MARGIN_MULTIPLIER} does not clear ${detail}. ` +
                `Worst-case commission is ${WORST_CASE_COMMISSION}. Raise MARGIN_MULTIPLIER or drop the channel.`
        );
    }
    return reports;
}
