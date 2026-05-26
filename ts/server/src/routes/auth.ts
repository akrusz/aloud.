/**
 * POST /v1/auth/google — exchange a Google ID token for an aloud session.
 * Creates the account on first sign-in and grants free credits iff the email
 * is verified (meditation-pal-2yb anti-multi-account lever).
 *
 * POST /v1/auth/dev — local-only shortcut that mints a session for a fixed
 * dev account without Google, so the browser UI can exercise the metered
 * proxy end-to-end before the real OAuth flow (meditation-pal-rfb) exists.
 * 404s in production (strict mode) — a dev convenience, not a backdoor.
 */

import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { ERROR_STATUS, apiError } from '../contract.js';
import type { AuthResponse, GoogleAuthRequest } from '../contract.js';
import type { Deps } from '../deps.js';
import { verifyGoogleIdToken } from '../auth/google.js';
import { issueSessionToken } from '../auth/session.js';
import { decideSignupGrant } from '../quota/freetier.js';
import type { Account } from '../credits/store.js';
import { log } from '../logger.js';

export function authRoutes(deps: Deps): Hono {
    const app = new Hono();

    app.post('/google', async (c) => {
        const body = (await c.req.json().catch(() => ({}))) as Partial<GoogleAuthRequest>;
        if (!body.idToken) {
            return c.json(apiError('bad_request', 'idToken required'), ERROR_STATUS.bad_request);
        }

        let identity;
        try {
            identity = await verifyGoogleIdToken(body.idToken, deps.config.googleClientIds);
        } catch (err) {
            log.warn('google verify failed', { err: String(err) });
            return c.json(apiError('unauthenticated', 'invalid Google sign-in'), ERROR_STATUS.unauthenticated);
        }

        let account = await deps.store.getAccountByGoogleSub(identity.sub);
        let isNewAccount = false;
        if (!account) {
            // Client IP for velocity-based abuse detection (mass-account creation
            // clusters by IP/subnet). x-forwarded-for is set by Fly/Render; take
            // the first hop. Absent locally / behind some proxies — that's fine.
            const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
            const signupIp = fwd || c.req.header('x-real-ip') || undefined;
            account = {
                id: randomUUID(),
                googleSub: identity.sub,
                email: identity.email,
                emailVerified: identity.emailVerified,
                createdAt: Date.now() / 1000,
                ...(signupIp ? { signupIp } : {}),
            } satisfies Account;
            await deps.store.createAccount(account);
            isNewAccount = true;

            const grant = decideSignupGrant(identity.emailVerified, deps.config.freeSignupCredits);
            // Emergency brake: refuse the grant if the global hourly free-credit
            // budget is exhausted (mass-signup flood). The account is still
            // created and can buy credits — it just gets no freebie right now.
            let granted = 0;
            let breakerTripped = false;
            if (grant.grantCredits > 0) {
                if (deps.grantBreaker.tryConsume(grant.grantCredits)) {
                    await deps.ledger.grant(account.id, grant.grantCredits, grant.reason);
                    granted = grant.grantCredits;
                } else {
                    breakerTripped = true;
                }
            }
            log.info('account created', {
                accountId: account.id,
                emailVerified: identity.emailVerified,
                granted,
                ...(breakerTripped ? { breakerTripped: true } : {}),
            });
            if (breakerTripped) {
                log.warn('free-grant breaker tripped', { accountId: account.id });
            }
        }

        const token = await issueSessionToken(account.id, deps.config.sessionSecret);
        const response: AuthResponse = {
            token,
            isNewAccount,
            account: {
                id: account.id,
                email: account.email,
                emailVerified: account.emailVerified,
                creditsRemaining: await deps.ledger.balance(account.id),
            },
        };
        return c.json(response);
    });

    // Stable identity for the single local dev account. Reused across sign-ins
    // so the credit ledger and history persist for the duration of a server run.
    const DEV_GOOGLE_SUB = 'dev:local';

    app.post('/dev', async (c) => {
        if (deps.config.strict) {
            // Behave as if the route doesn't exist outside dev.
            return c.json(apiError('bad_request', 'dev sign-in is disabled in production'), 404);
        }

        let account = await deps.store.getAccountByGoogleSub(DEV_GOOGLE_SUB);
        let isNewAccount = false;
        if (!account) {
            account = {
                id: randomUUID(),
                googleSub: DEV_GOOGLE_SUB,
                email: 'dev@localhost',
                emailVerified: true,
                createdAt: Date.now() / 1000,
            } satisfies Account;
            await deps.store.createAccount(account);
            isNewAccount = true;
            await deps.ledger.grant(account.id, deps.config.freeSignupCredits, 'dev signup grant');
        } else if ((await deps.ledger.balance(account.id)) <= 0) {
            // Keep local testing unblocked: refill the dev account when it runs dry.
            await deps.ledger.grant(account.id, deps.config.freeSignupCredits, 'dev top-up');
        }

        const token = await issueSessionToken(account.id, deps.config.sessionSecret);
        const response: AuthResponse = {
            token,
            isNewAccount,
            account: {
                id: account.id,
                email: account.email,
                emailVerified: account.emailVerified,
                creditsRemaining: await deps.ledger.balance(account.id),
            },
        };
        log.info('dev sign-in', { accountId: account.id, isNewAccount });
        return c.json(response);
    });

    return app;
}
