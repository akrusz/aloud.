/**
 * Credit ledger operations on top of any CreditsStore. Pure-ish business
 * logic: balance is always derived by summing append-only entries, so it can
 * never drift from its history.
 *
 * Hold lifecycle (meditation-pal-8sj "pre-auth hold at session start"):
 *   placeHold(N)        -> appends a -N 'hold' entry, returns holdId
 *   settleHold(holdId, actual) -> releases the hold (+N) and debits `actual`
 *   releaseHold(holdId) -> releases the hold (+N), no debit (session aborted)
 * Spendable balance already reflects outstanding holds because the hold entry
 * is negative. Settling swaps the estimate for the real cost atomically from
 * the caller's perspective.
 */

import { randomUUID } from 'node:crypto';
import type { Clock } from '@aloud/core';
import type { CreditsStore, LedgerEntry, LedgerKind } from './store.js';

export class InsufficientCreditsError extends Error {
    constructor(public readonly needed: number, public readonly available: number) {
        super(`insufficient credits: need ${needed}, have ${available}`);
        this.name = 'InsufficientCreditsError';
    }
}

export class Ledger {
    private readonly now: () => number;

    constructor(
        private readonly store: CreditsStore,
        clock?: Clock
    ) {
        // core's Clock is `() => number` (seconds since epoch).
        this.now = clock ?? (() => Date.now() / 1000);
    }

    async balance(accountId: string): Promise<number> {
        const entries = await this.store.listEntries(accountId);
        return entries.reduce((sum, e) => sum + e.amount, 0);
    }

    private async append(
        accountId: string,
        kind: LedgerKind,
        amount: number,
        reason: string,
        holdId?: string
    ): Promise<LedgerEntry> {
        const entry: LedgerEntry = {
            id: randomUUID(),
            accountId,
            kind,
            amount,
            reason,
            createdAt: this.now(),
            ...(holdId ? { holdId } : {}),
        };
        await this.store.appendEntry(entry);
        return entry;
    }

    /** One-time signup grant (meditation-pal-2yb). Caller guards against
     *  granting twice; this just records it. */
    grant(accountId: string, credits: number, reason = 'signup_grant'): Promise<LedgerEntry> {
        return this.append(accountId, 'signup_grant', Math.abs(credits), reason);
    }

    /** Record a completed credit purchase (called from the Stripe webhook
     *  after payment confirmation). */
    purchase(accountId: string, credits: number, reason: string): Promise<LedgerEntry> {
        return this.append(accountId, 'purchase', Math.abs(credits), reason);
    }

    /** Place a pre-auth hold, failing if spendable balance can't cover it.
     *  The hold entry is tagged with its own holdId so settle/release can find
     *  it. */
    async placeHold(accountId: string, credits: number, reason: string): Promise<string> {
        const available = await this.balance(accountId);
        if (available < credits) throw new InsufficientCreditsError(credits, available);
        const holdId = randomUUID();
        await this.append(accountId, 'hold', -Math.abs(credits), reason, holdId);
        return holdId;
    }

    /** Settle a hold to an actual cost: release the held amount, then debit
     *  the real cost. Net effect on balance is -actual. */
    async settleHold(
        accountId: string,
        holdId: string,
        actualCredits: number,
        reason: string
    ): Promise<void> {
        const held = await this.heldAmount(accountId, holdId);
        await this.append(accountId, 'hold_release', held, `release:${holdId}`, holdId);
        if (actualCredits > 0) {
            await this.append(accountId, 'debit', -Math.abs(actualCredits), reason, holdId);
        }
    }

    /** Release a hold with no charge (session aborted before any usage). */
    async releaseHold(accountId: string, holdId: string): Promise<void> {
        const held = await this.heldAmount(accountId, holdId);
        await this.append(accountId, 'hold_release', held, `release:${holdId}`, holdId);
    }

    /** Direct debit with no prior hold (e.g. reconciling a turn outside a held
     *  session). Throws if it would overdraw. */
    async debit(accountId: string, credits: number, reason: string): Promise<void> {
        const available = await this.balance(accountId);
        if (available < credits) throw new InsufficientCreditsError(credits, available);
        await this.append(accountId, 'debit', -Math.abs(credits), reason);
    }

    /** The magnitude of an outstanding hold (positive). 0 if already released. */
    private async heldAmount(accountId: string, holdId: string): Promise<number> {
        const entries = await this.store.listEntries(accountId);
        let net = 0;
        for (const e of entries) {
            if (e.holdId !== holdId) continue;
            if (e.kind === 'hold') net += -e.amount; // hold is negative; magnitude held
            if (e.kind === 'hold_release') net -= e.amount; // release is positive
        }
        return Math.max(0, net);
    }
}
