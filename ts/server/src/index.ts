/**
 * Server entrypoint. Loads config from the environment, asserts pricing
 * solvency (refuses to start at a loss — meditation-pal-8sj), builds deps, and
 * serves the Hono app over Node's HTTP server.
 *
 * Runs via tsx (see package.json "start"), which resolves the @aloud/core path
 * alias so the proxy can reuse core's provider/usage code at runtime.
 */

import { serve } from '@hono/node-server';
import { loadConfig, configuredProviders } from './config.js';
import { buildDeps } from './deps.js';
import { createApp } from './app.js';
import { assertSolvent, PACK_MARKUP } from './pricing/meter.js';
import { CREDIT_PACKS } from './billing/stripe.js';
import { setStrictContentCheck, log } from './logger.js';

function main(): void {
    const config = loadConfig();

    // In production, drop the content-check from throw to drop-field so a stray
    // log field can't crash a paying request — but it still never logs content.
    setStrictContentCheck(!config.strict);

    // Refuse to start if any pack's margin can't clear the worst channel.
    const solvency = assertSolvent(CREDIT_PACKS);

    const deps = buildDeps(config);
    const app = createApp(deps);

    serve({ fetch: app.fetch, port: config.port }, (info) => {
        log.info('aloud server up', {
            port: info.port,
            providers: configuredProviders(config),
            billing: Boolean(config.stripeSecretKey),
            packMarkup: PACK_MARKUP,
            packsClear: solvency.every((r) => r.clears),
            freeSignupCredits: config.freeSignupCredits,
        });
    });
}

main();
