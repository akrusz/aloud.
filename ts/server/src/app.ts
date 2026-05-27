/**
 * Hono app factory. Wires CORS, a health check, and the /v1 routes onto an
 * injected Deps. Kept free of process/network side effects so tests can drive
 * it with `app.request(...)` against an in-memory store (see tests/).
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Deps } from './deps.js';
import { configuredProviders } from './config.js';
import { authRoutes } from './routes/auth.js';
import { meRoutes } from './routes/me.js';
import { llmRoutes } from './routes/llm.js';
import { sttRoutes } from './routes/stt.js';
import { ttsRoutes } from './routes/tts.js';
import { CURATED_VOICES } from './providers/voice-catalog.js';
import type { HostedVoice } from './contract.js';
import { billingRoutes } from './routes/billing.js';
import { adminRoutes } from './routes/admin.js';

export function createApp(deps: Deps): Hono {
    const app = new Hono();

    app.use(
        '*',
        cors({
            origin: deps.config.corsOrigins.length > 0 ? deps.config.corsOrigins : '*',
            allowMethods: ['GET', 'POST', 'OPTIONS'],
            allowHeaders: ['authorization', 'content-type'],
            // So the browser can read per-request cost off the /v1/tts response.
            exposeHeaders: ['X-Credits-Charged', 'X-Credits-Remaining'],
        })
    );

    // Liveness + a peek at what's wired, without leaking secrets.
    app.get('/health', (c) =>
        c.json({
            ok: true,
            providers: configuredProviders(deps.config),
            billing: Boolean(deps.config.stripeSecretKey),
            // Which media capabilities the client can route here (vs Flask/native).
            stt: Boolean(deps.config.providerKeys.groq),
            tts: Boolean(deps.config.googleTtsApiKey),
        })
    );

    // Public: the curated hosted voices, or [] when TTS isn't configured. The
    // client merges these into its voice picker (availability-driven menus).
    app.get('/v1/voices', (c) => {
        const voices: HostedVoice[] = deps.config.googleTtsApiKey
            ? CURATED_VOICES.map((v) => ({ name: v.name, gender: v.gender }))
            : [];
        return c.json(voices);
    });

    app.route('/v1/auth', authRoutes(deps));
    app.route('/v1/me', meRoutes(deps));
    app.route('/v1/llm', llmRoutes(deps));
    app.route('/v1/stt', sttRoutes(deps));
    app.route('/v1/tts', ttsRoutes(deps));
    app.route('/v1/billing', billingRoutes(deps));
    app.route('/v1/admin', adminRoutes(deps));

    return app;
}
