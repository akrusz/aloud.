/**
 * Free-tier gating + abuse controls (meditation-pal-2yb). The web demo has a
 * wide-open abuse surface (no app-store gating), so this is load-bearing.
 *
 * Two cheap levers implemented here; the heavier ones (device fingerprinting,
 * disposable-domain blocklists, velocity scoring) attach at these same seams:
 *   1. Signup grant is gated on a VERIFIED Google email (the verification
 *      itself happens in auth/google.ts). An unverified identity gets an
 *      account but zero free credits — so farming throwaway addresses yields
 *      nothing spendable.
 *   2. A per-account request-rate ceiling caps burst abuse and runaway clients.
 *      In-memory sliding window here; swap for Redis when the backend goes
 *      multi-instance (meditation-pal-a3u notes sticky-sessions/Redis only
 *      matter once stateful).
 */

export interface SignupDecision {
    grantCredits: number;
    reason: string;
}

export function decideSignupGrant(emailVerified: boolean, freeCredits: number): SignupDecision {
    if (!emailVerified) {
        return { grantCredits: 0, reason: 'email_unverified: no free credits until verified' };
    }
    return { grantCredits: freeCredits, reason: 'verified signup grant' };
}

/** Simple in-memory sliding-window rate limiter, keyed by account id. */
export class RateGuard {
    private hits = new Map<string, number[]>();

    constructor(
        private readonly maxRequests = 60,
        private readonly windowMs = 60_000,
        private readonly now: () => number = Date.now
    ) {}

    /** Returns true if allowed (and records the hit), false if over the limit. */
    allow(accountId: string): boolean {
        const t = this.now();
        const cutoff = t - this.windowMs;
        const recent = (this.hits.get(accountId) ?? []).filter((ts) => ts > cutoff);
        if (recent.length >= this.maxRequests) {
            this.hits.set(accountId, recent);
            return false;
        }
        recent.push(t);
        this.hits.set(accountId, recent);
        return true;
    }
}
