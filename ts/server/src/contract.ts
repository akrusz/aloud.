/**
 * The wire contract between the aloud client (ts/ui, Capacitor) and this
 * hosted server. This is the ENTIRE coupling surface between the two —
 * everything else here is server-private. Keep it small and stable.
 *
 * The client half lives today in ts/ui/src/adapters/claude-proxy-http.ts
 * (which currently points at the desktop Flask backend). The web-demo work
 * is "point that adapter at this server's /v1/llm/complete instead". When
 * the coordinated packages/ workspace move happens, this file is the natural
 * thing to lift into a shared @aloud/contract package both sides import; until
 * then it is mirrored by hand (the surface is tiny enough that that's fine).
 *
 * Tickets: meditation-pal-vd3 (this server), meditation-pal-8sj (credits),
 * meditation-pal-rfb (auth), meditation-pal-2yb (quota).
 */

import type { Message } from '@aloud/core/llm';

/** Providers the hosted server is willing to forward to. The web tier's
 *  ONLY LLM source is this server; on-device + bring-your-own-key live in
 *  the app-store / desktop builds and never touch this contract. */
export type ProviderId = 'anthropic' | 'groq' | 'openrouter' | 'google';

/** Channel a credit purchase flowed through. Drives the commission lookup —
 *  see pricing/commission.ts and the meditation-pal-8sj addendum. */
export type PurchaseChannel = 'web_stripe' | 'iap_apple' | 'iap_google';

// ---- POST /v1/llm/complete --------------------------------------------------

export interface CompleteRequest {
    provider: ProviderId;
    /** Provider-native model id (e.g. "claude-sonnet-4-6"). The server
     *  validates it against an allowlist so a client can't bill a user for
     *  an arbitrary expensive model. */
    model: string;
    messages: Message[];
    system?: string;
    maxTokens?: number;
    /** When true, the response is an SSE stream of CompleteChunk events
     *  terminated by a final event carrying usage + cost. */
    stream?: boolean;
}

/** Non-streaming response, or the shape carried by the terminal SSE event. */
export interface CompleteResponse {
    text: string;
    finishReason: string | null;
    /** What this turn cost the user, in credits, already debited. Mirrors
     *  the live cost meter ticket (meditation-pal-14s). */
    creditsCharged: number;
    /** Remaining balance after the debit, so the client can update the UI
     *  without a second round-trip. */
    creditsRemaining: number;
}

/** One SSE delta. `text` is the incremental delta only (matches core's
 *  StreamChunk). The final event has `done: true` and carries `result`. */
export interface CompleteChunk {
    text: string;
    done: boolean;
    result?: CompleteResponse;
}

// ---- Auth & account ---------------------------------------------------------

/** POST /v1/auth/google — exchange a Google ID token for an aloud session. */
export interface GoogleAuthRequest {
    /** The ID token (JWT) from Google Sign-In on the client. */
    idToken: string;
}

export interface AuthResponse {
    /** Bearer token for subsequent requests (our own short-lived JWT). */
    token: string;
    account: AccountView;
    /** True only on the request that created the account — lets the client
     *  show a "here are your free credits" welcome. */
    isNewAccount: boolean;
}

/** GET /v1/me — current account + balance. */
export interface AccountView {
    id: string;
    email: string;
    /** Whether Google marked the email verified. We require this before
     *  granting free credits (anti multi-account). */
    emailVerified: boolean;
    creditsRemaining: number;
}

// ---- Billing ----------------------------------------------------------------

/** POST /v1/billing/checkout — start a credit purchase. Returns a URL the
 *  client opens (web: redirect; mobile: external link, per meditation-pal-czr). */
export interface CheckoutRequest {
    packId: string;
    channel: PurchaseChannel;
    /** ISO 3166-1 alpha-2; selects the commission rate (US vs EU differ). */
    jurisdiction?: string;
}

export interface CheckoutResponse {
    checkoutUrl: string;
}

// ---- Errors -----------------------------------------------------------------

export type ErrorCode =
    | 'unauthenticated'
    | 'email_unverified'
    | 'insufficient_credits'
    | 'quota_exceeded'
    | 'model_not_allowed'
    | 'provider_error'
    | 'bad_request'
    | 'internal';

export interface ApiError {
    error: {
        code: ErrorCode;
        message: string;
    };
}

export function apiError(code: ErrorCode, message: string): ApiError {
    return { error: { code, message } };
}

/** HTTP status for each error code — single source of truth so routes stay
 *  consistent. `as const` keeps the values as literals so Hono accepts them
 *  as ContentfulStatusCode. */
export const ERROR_STATUS = {
    unauthenticated: 401,
    email_unverified: 403,
    insufficient_credits: 402,
    quota_exceeded: 429,
    model_not_allowed: 400,
    provider_error: 502,
    bad_request: 400,
    internal: 500,
} as const satisfies Record<ErrorCode, number>;
