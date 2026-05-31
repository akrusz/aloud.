/**
 * server-auth.ts — the hosted-session token flow. Covers the new Google
 * sign-in path (meditation-pal-rfb) and the dev fallback, with an injected KV
 * + fetch so it runs hermetically in Node.
 *
 * Note: VITE_GOOGLE_CLIENT_ID is unset in the test env, so
 * isGoogleSignInConfigured() is false here — ensureServerToken takes the dev
 * branch. The Google-configured branch (throws ServerSignInRequiredError) is a
 * build-time toggle we can't flip per-test; it's exercised by typecheck + the
 * unit assertion on googleSignIn directly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
    googleSignIn,
    devSignIn,
    ensureServerToken,
    getServerToken,
    clearServerToken,
    isGoogleSignInConfigured,
    setServerAuthBackend,
    setServerAuthFetch,
} from '../ui/src/server-auth.js';
import type { KvStorage } from '../src/platform/storage.js';

class MemoryKv implements KvStorage {
    private m = new Map<string, string>();
    async get(k: string) {
        return this.m.get(k) ?? null;
    }
    async set(k: string, v: string) {
        this.m.set(k, v);
    }
    async delete(k: string) {
        this.m.delete(k);
    }
    async keys() {
        return [...this.m.keys()];
    }
    async clear() {
        this.m.clear();
    }
}

const AUTH_BODY = {
    token: 'tok-google',
    isNewAccount: true,
    account: { id: 'a1', email: 'u@example.com', emailVerified: true, creditsRemaining: 20 },
};

let kv: MemoryKv;

beforeEach(() => {
    kv = new MemoryKv();
    setServerAuthBackend(kv);
});

describe('googleSignIn', () => {
    it('POSTs the ID token as JSON and caches the returned session token', async () => {
        let seen: { url: string; init?: RequestInit } | null = null;
        setServerAuthFetch(async (url, init) => {
            seen = { url: String(url), init };
            return new Response(JSON.stringify(AUTH_BODY), { status: 200 });
        });

        const body = await googleSignIn('id-token-xyz');

        expect(body.token).toBe('tok-google');
        expect(seen!.url).toMatch(/\/cloud\/v1\/auth\/google$/);
        expect(seen!.init?.method).toBe('POST');
        expect(JSON.parse(String(seen!.init?.body))).toEqual({ idToken: 'id-token-xyz' });
        // Token is cached for subsequent ensureServerToken() calls.
        expect(await getServerToken()).toBe('tok-google');
    });

    it('throws a friendly message when the server rejects the token (401)', async () => {
        setServerAuthFetch(async () => new Response('nope', { status: 401 }));
        await expect(googleSignIn('bad')).rejects.toThrow(/rejected/i);
        expect(await getServerToken()).toBeNull();
    });
});

describe('ensureServerToken', () => {
    it('returns a cached token without any network call', async () => {
        await kv.set('server:token', 'cached');
        setServerAuthFetch(async () => {
            throw new Error('should not fetch when a token is cached');
        });
        expect(await ensureServerToken()).toBe('cached');
    });

    it('falls back to dev sign-in when Google is not configured (dev build)', async () => {
        // Guard the assumption this whole branch rests on.
        expect(isGoogleSignInConfigured()).toBe(false);
        setServerAuthFetch(async () =>
            new Response(JSON.stringify({ ...AUTH_BODY, token: 'tok-dev' }), { status: 200 })
        );
        await clearServerToken();
        expect(await ensureServerToken()).toBe('tok-dev');
    });
});

describe('devSignIn', () => {
    it('surfaces the production-mode 404 as a clear message', async () => {
        setServerAuthFetch(async () => new Response('', { status: 404 }));
        await expect(devSignIn()).rejects.toThrow(/production mode/i);
    });
});
