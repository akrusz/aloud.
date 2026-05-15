/**
 * Typed setup state + persistence.
 *
 * Maps the existing setup-form shape onto the PromptBuilder's
 * config shape. The slider is 0-4 for UX; we map to 0/3/5/7/10 for
 * the PromptBuilder so it lines up with the Python implementation's
 * DIRECTIVENESS_ADDITIONS keys.
 */

import type {
    Focus,
    Quality,
    Verbosity,
} from '../../src/facilitation/index.js';
import { LocalStorageKv } from './adapters/localstorage-kv.js';
import { loadAppSettings } from './app-settings.js';

export type Provider =
    | 'ollama'
    | 'anthropic'
    | 'openai'
    | 'openrouter'
    | 'venice'
    | 'groq';

export const ALL_PROVIDERS: ReadonlyArray<{ value: Provider; label: string; needsKey: boolean }> = [
    { value: 'ollama', label: 'Ollama (local)', needsKey: false },
    { value: 'anthropic', label: 'Anthropic Claude', needsKey: true },
    { value: 'openai', label: 'OpenAI', needsKey: true },
    { value: 'openrouter', label: 'OpenRouter', needsKey: true },
    { value: 'venice', label: 'Venice', needsKey: true },
    { value: 'groq', label: 'Groq', needsKey: true },
];

export function providerNeedsKey(p: Provider): boolean {
    return ALL_PROVIDERS.find((x) => x.value === p)?.needsKey ?? false;
}

export interface SessionSetup {
    intention: string;
    preset: string | null;
    focuses: Focus[];
    qualities: Quality[];
    /** UI slider value 0-4. Map via DIRECTIVENESS_VALUES below. */
    dirStep: number;
    verbosity: Verbosity;
    customInstructions: string;
    provider: Provider;
    model: string;
    /**
     * Voice ID from voices.ts. null = use the browser's default voice.
     * Format: 'browser:<voiceURI>' or 'server:<engine-voice-name>'.
     */
    voice: string | null;
    /** TTS rate in words-per-minute. Browser TTS normalizes; server TTS passes through. */
    ttsRate: number;
}

export const DIRECTIVENESS_VALUES: readonly number[] = [0, 3, 5, 7, 10];

export function dirStepToBackend(step: number): number {
    const v = DIRECTIVENESS_VALUES[Math.max(0, Math.min(step, DIRECTIVENESS_VALUES.length - 1))];
    return v ?? 3;
}

export const defaultSetup: SessionSetup = {
    intention: '',
    preset: 'pleasant_play',
    focuses: ['body_sensations', 'emotions'],
    qualities: ['playful', 'feeling_good'],
    dirStep: 1,
    verbosity: 'medium',
    customInstructions: '',
    provider: 'ollama',
    model: '',
    voice: null,
    ttsRate: 160,
};

const SETTINGS_KEY = 'preview:setup';
const kv = new LocalStorageKv();

export async function loadSetup(): Promise<SessionSetup> {
    // Merge order: defaults < app-settings defaults < persisted session
    // setup. So a fresh setup inherits the user's app-level defaults
    // (provider, voice, rate) but a previously-tweaked per-session
    // setup wins where they overlap.
    const appSettings = await loadAppDefaults();
    const base: SessionSetup = { ...defaultSetup, ...appSettings };
    const raw = await kv.get(SETTINGS_KEY);
    if (!raw) return base;
    try {
        return { ...base, ...(JSON.parse(raw) as Partial<SessionSetup>) };
    } catch {
        return base;
    }
}

/**
 * Pluck the SessionSetup-shaped subset of fields out of AppSettings so
 * the setup view can inherit them. The cycle (app-settings imports
 * Provider type from here, this file imports loadAppSettings) is only
 * at the type level — type-only imports don't cause runtime cycles.
 */
async function loadAppDefaults(): Promise<Partial<SessionSetup>> {
    const s = await loadAppSettings();
    return {
        provider: s.defaultProvider,
        model: s.defaultModel,
        voice: s.defaultVoice,
        ttsRate: s.defaultTtsRate,
    };
}

export async function saveSetup(setup: SessionSetup): Promise<void> {
    await kv.set(SETTINGS_KEY, JSON.stringify(setup));
}
