/**
 * GET /v1/me — the signed-in account and its live credit balance. Also exposes
 * the things a client needs to render its model picker and store transparently:
 * GET /v1/me/models (allowed models + per-token cost) and GET /v1/me/packs.
 */

import { Hono } from 'hono';
import type { AccountView } from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import { allowedModels } from '../pricing/providers.js';
import { CREDIT_USD, MARGIN_MULTIPLIER } from '../pricing/meter.js';
import { CREDIT_PACKS } from '../billing/stripe.js';

export function meRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    app.get('/', requireAuth(deps), async (c) => {
        const account = c.get('account');
        const view: AccountView = {
            id: account.id,
            email: account.email,
            emailVerified: account.emailVerified,
            creditsRemaining: await deps.ledger.balance(account.id),
        };
        return c.json(view);
    });

    // Public pricing transparency — no auth needed; the margin is published.
    app.get('/models', (c) =>
        c.json({
            creditUsd: CREDIT_USD,
            marginMultiplier: MARGIN_MULTIPLIER,
            models: allowedModels(),
        })
    );

    app.get('/packs', (c) => c.json({ packs: CREDIT_PACKS }));

    return app;
}
