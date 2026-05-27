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

    it('on the website (hosted only), shows hosted + BYOK but not Ollama/claude_proxy', () => {
        const web = caps({ hosted: true });
        const visible = mod.ALL_PROVIDERS.filter((p) => mod.isProviderAvailable(p, web)).map((p) => p.value);
        expect(visible).toContain('aloud');
        expect(visible).toContain('anthropic');
        expect(visible).not.toContain('ollama');
        expect(visible).not.toContain('claude_proxy');
    });
});
