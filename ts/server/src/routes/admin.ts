/**
 * Admin spend-monitoring endpoints (dev ask). Gated by ALOUD_ADMIN_TOKEN —
 * when that's unset the routes are DISABLED (404), never open. Separate from
 * user auth: this is operator access, not account access.
 *
 * GET /v1/admin/metrics?sinceHours=24 — ledger aggregates + abuse velocity
 * signals, so the operator can watch free-grant burn and provider cost and
 * tweak the grant/pricing in near-real-time.
 */

import { Hono } from 'hono';
import { timingSafeEqual } from 'node:crypto';
import { ERROR_STATUS, apiError } from '../contract.js';
import type { Deps } from '../deps.js';
import { buildMetrics } from '../admin/metrics.js';

function tokenOk(provided: string | undefined, expected: string): boolean {
    if (!provided) return false;
    const a = Buffer.from(provided);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function adminRoutes(deps: Deps): Hono {
    const app = new Hono();

    app.get('/metrics', async (c) => {
        const expected = deps.config.adminToken;
        // No token configured → feature disabled. 404 (not 403) so its existence
        // isn't advertised.
        if (!expected) return c.notFound();

        const header = c.req.header('authorization') ?? '';
        const provided = header.toLowerCase().startsWith('bearer ')
            ? header.slice(7)
            : undefined;
        if (!tokenOk(provided, expected)) {
            return c.json(apiError('unauthenticated', 'admin token required'), ERROR_STATUS.unauthenticated);
        }

        const sinceHours = Number(c.req.query('sinceHours') ?? 24);
        const now = Date.now() / 1000;
        const windowSinceTs = now - Math.max(0, sinceHours) * 3600;

        const [accounts, entries] = await Promise.all([
            deps.store.allAccounts(),
            deps.store.allEntries(),
        ]);
        return c.json(buildMetrics(accounts, entries, now, windowSinceTs));
    });

    return app;
}
