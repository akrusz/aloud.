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

export type Provider = 'ollama' | 'anthropic';

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
};

const SETTINGS_KEY = 'preview:setup';
const kv = new LocalStorageKv();

export async function loadSetup(): Promise<SessionSetup> {
    const raw = await kv.get(SETTINGS_KEY);
    if (!raw) return { ...defaultSetup };
    try {
        return { ...defaultSetup, ...(JSON.parse(raw) as Partial<SessionSetup>) };
    } catch {
        return { ...defaultSetup };
    }
}

export async function saveSetup(setup: SessionSetup): Promise<void> {
    await kv.set(SETTINGS_KEY, JSON.stringify(setup));
}
