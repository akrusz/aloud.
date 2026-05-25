/**
 * Persistence boundary for accounts + credit ledger. The interface is the
 * contract; implementations are swappable.
 *
 * Ships with an in-memory implementation (memory-store.ts) used by tests and
 * local dev. PRODUCTION SWAP: implement this same interface over SQLite
 * (own-your-data, on-brand) or Postgres — nothing above this file knows which
 * backing store is in use. The ledger logic (ledger.ts) is pure and sits on
 * top of whichever store is injected.
 *
 * Design notes:
 *  - The ledger is append-only: balance is derived from entries, never mutated
 *    in place. That gives a full audit trail (every grant, debit, hold,
 *    release, top-up) which is exactly what billing disputes need.
 *  - Holds are first-class: a session places a hold at start, then settles it
 *    to an actual debit (releasing the remainder). An unsettled hold reduces
 *    spendable balance without yet being a charge.
 */

export type LedgerKind =
    | 'signup_grant'
    | 'purchase'
    | 'debit'
    | 'hold'
    | 'hold_release'
    | 'refund';

export interface LedgerEntry {
    id: string;
    accountId: string;
    kind: LedgerKind;
    /** Signed credit delta. Grants/purchases/releases positive; debits/holds
     *  negative. Balance = sum of all entries' amounts. */
    amount: number;
    /** For hold/hold_release/settle linkage. */
    holdId?: string;
    /** Free-text reason, e.g. "llm:anthropic:claude-sonnet-4-6". Never carries
     *  message content. */
    reason: string;
    createdAt: number;
}

export interface Account {
    id: string;
    /** Google `sub` claim — stable per-user id; used to dedupe sign-ins. */
    googleSub: string;
    email: string;
    emailVerified: boolean;
    createdAt: number;
}

export interface CreditsStore {
    getAccountByGoogleSub(sub: string): Promise<Account | undefined>;
    getAccountById(id: string): Promise<Account | undefined>;
    createAccount(account: Account): Promise<void>;

    /** Append a ledger entry. Implementations must make this atomic. */
    appendEntry(entry: LedgerEntry): Promise<void>;
    /** All entries for an account, oldest first. */
    listEntries(accountId: string): Promise<LedgerEntry[]>;
}
