/**
 * Stripe integration (meditation-pal-8sj) — credit packs sold via Stripe
 * Checkout, fulfilled on a verified webhook. No `stripe` SDK dependency: we
 * call the REST API with fetch and verify webhook signatures with node:crypto.
 * Fewer deps, and the signature check is right here in the open to audit.
 *
 * Optional: if STRIPE_SECRET_KEY is unset the routes report "billing not
 * configured" rather than crashing, so the server runs end-to-end in dev with
 * just the free-tier grant.
 *
 * Channel/jurisdiction commission (meditation-pal-czr addendum) is applied at
 * the pricing layer, not here — this module only moves money and credits the
 * account on confirmed payment.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

/** A purchasable credit pack. Sold at face value (see meter.ts: CREDIT_USD). */
export interface CreditPack {
    id: string;
    credits: number;
    priceUsdCents: number;
    label: string;
}

export const CREDIT_PACKS: CreditPack[] = [
    { id: 'starter', credits: 500, priceUsdCents: 500, label: '500 credits — $5' },
    { id: 'plus', credits: 1200, priceUsdCents: 1000, label: '1,200 credits — $10 (best value)' },
    { id: 'pro', credits: 3000, priceUsdCents: 2500, label: '3,000 credits — $25' },
];

export function packById(id: string): CreditPack | undefined {
    return CREDIT_PACKS.find((p) => p.id === id);
}

/**
 * Verify a Stripe webhook signature (the `Stripe-Signature` header).
 * Implements Stripe's documented scheme: HMAC-SHA256 over `${t}.${payload}`
 * keyed by the webhook secret, compared constant-time against the `v1=` value,
 * with a timestamp tolerance to defeat replay.
 */
export function verifyStripeSignature(
    payload: string,
    sigHeader: string,
    secret: string,
    toleranceSec = 300,
    now: () => number = () => Date.now() / 1000
): boolean {
    const parts = Object.fromEntries(
        sigHeader.split(',').map((kv) => kv.split('=') as [string, string])
    );
    const t = Number(parts['t']);
    const v1 = parts['v1'];
    if (!t || !v1) return false;
    if (Math.abs(now() - t) > toleranceSec) return false;

    const expected = createHmac('sha256', secret).update(`${t}.${payload}`).digest('hex');
    const a = Buffer.from(expected);
    const b = Buffer.from(v1);
    return a.length === b.length && timingSafeEqual(a, b);
}

export interface CheckoutParams {
    pack: CreditPack;
    accountId: string;
    successUrl: string;
    cancelUrl: string;
}

/**
 * Create a Stripe Checkout Session and return its URL. The accountId rides in
 * client_reference_id so the webhook can credit the right ledger on payment.
 */
export async function createCheckoutSession(
    params: CheckoutParams,
    secretKey: string,
    fetchImpl: typeof fetch = fetch
): Promise<string> {
    const form = new URLSearchParams({
        mode: 'payment',
        success_url: params.successUrl,
        cancel_url: params.cancelUrl,
        client_reference_id: params.accountId,
        'line_items[0][quantity]': '1',
        'line_items[0][price_data][currency]': 'usd',
        'line_items[0][price_data][unit_amount]': String(params.pack.priceUsdCents),
        'line_items[0][price_data][product_data][name]': params.pack.label,
        'metadata[pack_id]': params.pack.id,
        'metadata[credits]': String(params.pack.credits),
    });

    const res = await fetchImpl('https://api.stripe.com/v1/checkout/sessions', {
        method: 'POST',
        headers: {
            authorization: `Bearer ${secretKey}`,
            'content-type': 'application/x-www-form-urlencoded',
        },
        body: form.toString(),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Stripe checkout creation failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const data = (await res.json()) as { url?: string };
    if (!data.url) throw new Error('Stripe checkout session had no url');
    return data.url;
}

/** Parse the bits we need from a checkout.session.completed event. */
export interface FulfilledPurchase {
    accountId: string;
    credits: number;
    packId: string;
    stripeSessionId: string;
}

export function parseCheckoutCompleted(event: unknown): FulfilledPurchase | undefined {
    const e = event as {
        type?: string;
        data?: { object?: Record<string, unknown> };
    };
    if (e.type !== 'checkout.session.completed') return undefined;
    const obj = e.data?.object ?? {};
    const accountId = typeof obj['client_reference_id'] === 'string' ? obj['client_reference_id'] : '';
    const meta = (obj['metadata'] as Record<string, string> | undefined) ?? {};
    const credits = Number(meta['credits']);
    const packId = meta['pack_id'] ?? '';
    const stripeSessionId = typeof obj['id'] === 'string' ? obj['id'] : '';
    if (!accountId || !credits) return undefined;
    return { accountId, credits, packId, stripeSessionId };
}
