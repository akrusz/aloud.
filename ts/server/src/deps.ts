/**
 * Dependency container — everything the routes need, assembled once at boot
 * and threaded through. Keeps routes pure (no module-level singletons) and
 * makes tests trivial: build a Deps with a MemoryCreditsStore and a fake key
 * set, no network.
 */

import type { Config } from './config.js';
import type { CreditsStore } from './credits/store.js';
import { MemoryCreditsStore } from './credits/memory-store.js';
import { Ledger } from './credits/ledger.js';
import { Forwarder } from './providers/forward.js';
import { RateGuard } from './quota/freetier.js';

export interface Deps {
    config: Config;
    store: CreditsStore;
    ledger: Ledger;
    forwarder: Forwarder;
    rateGuard: RateGuard;
}

export interface BuildDepsOptions {
    store?: CreditsStore;
}

export function buildDeps(config: Config, options: BuildDepsOptions = {}): Deps {
    const store = options.store ?? new MemoryCreditsStore();
    return {
        config,
        store,
        ledger: new Ledger(store),
        forwarder: new Forwarder(config.providerKeys),
        rateGuard: new RateGuard(),
    };
}
