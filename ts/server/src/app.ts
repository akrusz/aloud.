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
        })
    );

    // Liveness + a peek at what's wired, without leaking secrets.
    app.get('/health', (c) =>
        c.json({
            ok: true,
            providers: configuredProviders(deps.config),
            billing: Boolean(deps.config.stripeSecretKey),
        })
    );

    app.route('/v1/auth', authRoutes(deps));
    app.route('/v1/me', meRoutes(deps));
    app.route('/v1/llm', llmRoutes(deps));
    app.route('/v1/billing', billingRoutes(deps));
    app.route('/v1/admin', adminRoutes(deps));

    return app;
}
