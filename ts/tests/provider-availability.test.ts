import { describe, it, expect, beforeAll } from 'vitest';
import type { Capabilities } from '../ui/src/capabilities.js';

// settings.ts constructs a LocalStorageKv at import; give it a minimal stub so
// the module loads under Node, then import it dynamically.
let mod: typeof import('../ui/src/settings.js');
beforeAll(async () => {
    const store = new Map<string, string>();
    (globalThis as unknown as { localStorage: Storage }).localStorage = {
        getItem: (k: string) => store.get(k) ?? null,
        setItem: (k: string, v: string) => void store.set(k, v),
        removeItem: (k: string) => void store.delete(k),
        clear: () => store.clear(),
        key: () => null,
        length: 0,
    } as Storage;
    mod = await import('../ui/src/settings.js');
});

const caps = (over: Partial<Capabilities>): Capabilities => ({
    flask: false,
    hosted: false,
    ollama: false,
    ...over,
});

describe('isProviderAvailable', () => {
    it('always offers BYOK providers (no capability requirement)', () => {
        const byok = mod.ALL_PROVIDERS.find((p) => p.value === 'openai')!;
        expect(mod.isProviderAvailable(byok, caps({}))).toBe(true);
    });

    it('gates aloud-hosted on the server, Ollama on a local daemon, claude_proxy on Flask', () => {
        const get = (v: string) => mod.ALL_PROVIDERS.find((p) => p.value === v)!;
        expect(mod.isProviderAvailable(get('aloud'), caps({ hosted: true }))).toBe(true);
        expect(mod.isProviderAvailable(get('aloud'), caps({}))).toBe(false);
        expect(mod.isProviderAvailable(get('ollama'), caps({ ollama: true }))).toBe(true);
        expect(mod.isProviderAvailable(get('ollama'), caps({}))).toBe(false);
        expect(mod.isProviderAvailable(get('claude_proxy'), caps({ flask: true }))).toBe(true);
        expect(mod.isProviderAvailable(get('claude_proxy'), caps({}))).toBe(false);
    });

    it('on a local build, BYOK shows by default', () => {
        const byok = mod.ALL_PROVIDERS.find((p) => p.value === 'anthropic')!;
        expect(mod.isProviderAvailable(byok, caps({}), { hostedBuild: false })).toBe(true);
    });

    it('on the hosted build, BYOK is hidden unless explicitly enabled', () => {
        const byok = mod.ALL_PROVIDERS.find((p) => p.value === 'anthropic')!;
        expect(mod.isProviderAvailable(byok, caps({ hosted: true }), { hostedBuild: true })).toBe(false);
        expect(
            mod.isProviderAvailable(byok, caps({ hosted: true }), { hostedBuild: true, allowByok: true })
        ).toBe(true);
    });

    it('hosted website (BYOK off): shows aloud only; (BYOK on): adds the key providers', () => {
        const caps0 = caps({ hosted: true });
        const off = mod.ALL_PROVIDERS.filter((p) =>
            mod.isProviderAvailable(p, caps0, { hostedBuild: true })
        ).map((p) => p.value);
        expect(off).toEqual(['aloud']); // Ollama/claude_proxy need local; BYOK hidden

        const on = mod.ALL_PROVIDERS.filter((p) =>
            mod.isProviderAvailable(p, caps0, { hostedBuild: true, allowByok: true })
        ).map((p) => p.value);
        expect(on).toContain('aloud');
        expect(on).toContain('anthropic');
        expect(on).not.toContain('ollama');
        expect(on).not.toContain('claude_proxy');
    });
});
