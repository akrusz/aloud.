/**
 * Billing routes (meditation-pal-8sj). Credit packs sold via Stripe Checkout,
 * fulfilled on a signature-verified webhook. Degrades gracefully when Stripe
 * isn't configured (dev runs on the free-tier grant alone).
 *
 * The webhook is the trust boundary: credits are added to the ledger ONLY here,
 * after Stripe confirms payment and the signature verifies. The checkout route
 * just starts the flow.
 */

import { Hono } from 'hono';
import {
    ERROR_STATUS,
    apiError,
    type CheckoutRequest,
    type CheckoutResponse,
} from '../contract.js';
import type { Deps } from '../deps.js';
import type { AuthVars } from '../auth/middleware.js';
import { requireAuth } from '../auth/middleware.js';
import {
    createCheckoutSession,
    packById,
    parseCheckoutCompleted,
    verifyStripeSignature,
} from '../billing/stripe.js';
import { log } from '../logger.js';

export function billingRoutes(deps: Deps): Hono<{ Variables: AuthVars }> {
    const app = new Hono<{ Variables: AuthVars }>();

    app.post('/checkout', requireAuth(deps), async (c) => {
        const secret = deps.config.stripeSecretKey;
        if (!secret) {
            return c.json(apiError('internal', 'billing not configured on this server'), ERROR_STATUS.internal);
        }
        const account = c.get('account');
        const body = (await c.req.json().catch(() => ({}))) as Partial<CheckoutRequest>;
        const pack = body.packId ? packById(body.packId) : undefined;
        if (!pack) {
            return c.json(apiError('bad_request', 'unknown packId'), ERROR_STATUS.bad_request);
        }
        const origin = deps.config.corsOrigins[0] ?? '';
        try {
            const url = await createCheckoutSession(
                {
                    pack,
                    accountId: account.id,
                    successUrl: `${origin}/?purchase=success`,
                    cancelUrl: `${origin}/?purchase=cancel`,
                },
                secret
            );
            return c.json({ checkoutUrl: url } satisfies CheckoutResponse);
        } catch (err) {
            log.error('checkout failed', { err: String(err) });
            return c.json(apiError('internal', 'could not start checkout'), ERROR_STATUS.internal);
        }
    });

    // Stripe calls this — no user auth; trust comes from signature verification.
    app.post('/webhook', async (c) => {
        const secret = deps.config.stripeWebhookSecret;
        if (!secret) return c.json(apiError('internal', 'webhook not configured'), ERROR_STATUS.internal);

        const sig = c.req.header('stripe-signature');
        const payload = await c.req.text();
        if (!sig || !verifyStripeSignature(payload, sig, secret)) {
            return c.json(apiError('unauthenticated', 'bad signature'), ERROR_STATUS.unauthenticated);
        }

        const event = JSON.parse(payload) as unknown;
        const purchase = parseCheckoutCompleted(event);
        if (purchase) {
            await deps.ledger.purchase(
                purchase.accountId,
                purchase.credits,
                `purchase:${purchase.packId}:${purchase.stripeSessionId}`
            );
            log.info('purchase fulfilled', {
                accountId: purchase.accountId,
                credits: purchase.credits,
                packId: purchase.packId,
            });
        }
        return c.json({ received: true });
    });

    return app;
}
