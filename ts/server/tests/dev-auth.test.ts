import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';
import type { AuthResponse } from '../src/contract.js';

function devApp() {
    // No ALOUD_ENV → permissive dev mode (strict = false).
    const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', ALOUD_FREE_SIGNUP_CREDITS: '20' });
    return createApp(buildDeps(config));
}

async function signInDev(app: ReturnType<typeof createApp>): Promise<AuthResponse> {
    const res = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
    expect(res.status).toBe(200);
    return (await res.json()) as AuthResponse;
}

describe('POST /cloud/v1/auth/dev', () => {
    it('mints a session and grants free credits on first sign-in', async () => {
        const app = devApp();
        const body = await signInDev(app);
        expect(body.token).toBeTruthy();
        expect(body.isNewAccount).toBe(true);
        expect(body.account.email).toBe('dev@localhost');
        expect(body.account.creditsRemaining).toBe(20);
    });

    it('reuses the same account on repeat sign-in (no double grant)', async () => {
        const app = devApp();
        const first = await signInDev(app);
        const second = await signInDev(app);
        expect(second.isNewAccount).toBe(false);
        expect(second.account.id).toBe(first.account.id);
        // Balance unchanged — still has credits, so no top-up.
        expect(second.account.creditsRemaining).toBe(20);
    });

    it('the minted token authenticates against a protected route', async () => {
        const app = devApp();
        const { token } = await signInDev(app);
        const res = await app.request('/cloud/v1/me', {
            headers: { authorization: `Bearer ${token}` },
        });
        expect(res.status).toBe(200);
    });

    it('404s in production (strict) mode', async () => {
        const config = loadConfig({
            ALOUD_ENV: 'production',
            ALOUD_SESSION_SECRET: 'x'.repeat(32),
            GOOGLE_CLIENT_IDS: 'client-1',
            ANTHROPIC_API_KEY: 'sk-test',
        });
        const app = createApp(buildDeps(config));
        const res = await app.request('/cloud/v1/auth/dev', { method: 'POST' });
        expect(res.status).toBe(404);
    });
});
