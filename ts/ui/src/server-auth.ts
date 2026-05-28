/**
 * Session token for the hosted aloud server (@aloud/server).
 *
 * The metered LLM proxy (/v1/llm/complete) is behind bearer auth: every
 * request carries a short-lived session JWT the server minted. In production
 * that token comes from Google sign-in (meditation-pal-rfb); until that flow
 * exists, `ensureServerToken()` falls back to the server's dev sign-in route
 * (/v1/auth/dev, local-only) so the whole loop runs end-to-end locally.
 *
 * The token is cached in a KvStorage slot (localStorage today, swappable per
 * platform — same pattern as api-keys.ts). It's not a secret in the BYOK
 * sense, but treating it like one keeps it out of serialized setup/state.
 */

import { LocalStorageKv } from './adapters/localstorage-kv.js';
import { cloudUrl } from './cloud-base.js';
import type { KvStorage } from '../../src/platform/storage.js';

const TOKEN_KEY = 'server:token';

/** Shape mirrors the server's AuthResponse (ts/server/src/contract.ts).
 *  Hand-mirrored until the shared @aloud/contract package lands. */
interface AuthResponse {
    token: string;
    isNewAccount: boolean;
    account: { id: string; email: string; emailVerified: boolean; creditsRemaining: number };
}

// Lazy so importing this module doesn't construct LocalStorageKv (which throws
// outside a browser, e.g. in Node tests). Tests call setServerAuthBackend first.
let backendOverride: KvStorage | null = null;
let lazyBackend: KvStorage | null = null;
function kv(): KvStorage {
    if (backendOverride) return backendOverride;
    if (!lazyBackend) lazyBackend = new LocalStorageKv();
    return lazyBackend;
}
let fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis);

/** Swap the storage backend (tests / future Capacitor secure storage). */
export function setServerAuthBackend(kvStorage: KvStorage): void {
    backendOverride = kvStorage;
}

/** Swap fetch (tests). */
export function setServerAuthFetch(impl: typeof fetch): void {
    fetchImpl = impl;
}

export async function getServerToken(): Promise<string | null> {
    return kv().get(TOKEN_KEY);
}

export async function clearServerToken(): Promise<void> {
    await kv().delete(TOKEN_KEY);
}

/** POST /v1/auth/dev — mint (or reuse) the local dev session. */
export async function devSignIn(): Promise<AuthResponse> {
    const res = await fetchImpl(cloudUrl('/v1/auth/dev'), { method: 'POST' });
    if (!res.ok) {
        throw new Error(
            res.status === 404
                ? 'Hosted aloud server has dev sign-in disabled (production mode).'
                : `aloud server sign-in failed (${res.status}). Is it running on :8787?`
        );
    }
    const body = (await res.json()) as AuthResponse;
    await kv().set(TOKEN_KEY, body.token);
    return body;
}

/**
 * Return a valid server token, signing in via the dev route if none is
 * cached. The session JWT is long-lived (7 days) so we don't proactively
 * refresh; an expired/invalid token surfaces as a 401 from the proxy, which
 * the caller clears and retries through here.
 */
export async function ensureServerToken(): Promise<string> {
    const existing = await getServerToken();
    if (existing) return existing;
    const { token } = await devSignIn();
    return token;
}
