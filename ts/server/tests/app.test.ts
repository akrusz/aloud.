import { describe, it, expect } from 'vitest';
import { loadConfig } from '../src/config.js';
import { buildDeps } from '../src/deps.js';
import { createApp } from '../src/app.js';

function app() {
    const config = loadConfig({ ANTHROPIC_API_KEY: 'sk-test', GOOGLE_CLIENT_IDS: 'client-1' });
    return createApp(buildDeps(config));
}

describe('app', () => {
    it('GET /health reports configured providers without leaking keys', async () => {
        const res = await app().request('/health');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { ok: boolean; providers: string[] };
        expect(body.ok).toBe(true);
        expect(body.providers).toContain('anthropic');
        expect(JSON.stringify(body)).not.toContain('sk-test');
    });

    it('GET /v1/me requires auth', async () => {
        const res = await app().request('/v1/me');
        expect(res.status).toBe(401);
    });

    it('GET /v1/me/models is public and publishes the markup', async () => {
        const res = await app().request('/v1/me/models');
        expect(res.status).toBe(200);
        const body = (await res.json()) as { packMarkup: number; usdPerCredit: number; models: unknown[] };
        expect(body.packMarkup).toBeGreaterThan(1);
        expect(body.usdPerCredit).toBeGreaterThan(0);
        expect(body.models.length).toBeGreaterThan(0);
    });

    it('POST /v1/llm/complete requires auth (no billing without identity)', async () => {
        const res = await app().request('/v1/llm/complete', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ provider: 'anthropic', model: 'claude-sonnet-4-6', messages: [] }),
        });
        expect(res.status).toBe(401);
    });
});
