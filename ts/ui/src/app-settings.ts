/**
 * App-wide settings — defaults that apply across sessions.
 *
 * Distinct from SessionSetup (per-session config like intention,
 * focuses, qualities). These settings are what a fresh setup view
 * inherits when no per-session overrides exist, plus chrome-level
 * things like theme and text scale.
 *
 * Persisted to KvStorage under a single key. We don't normalize
 * across versions — when fields are added the loader fills in
 * defaults, when fields are removed old values are silently dropped.
 */

import { LocalStorageKv } from './adapters/localstorage-kv.js';
import type { Provider } from './settings.js';

export type ThemeMode = 'auto' | 'dark' | 'light';
export type TtsEngineChoice = 'macos' | 'piper' | 'browser' | 'elevenlabs';

export interface AppSettings {
    // Provider defaults for new sessions
    defaultProvider: Provider;
    defaultModel: string;

    // Display
    textScale: number;
    themeMode: ThemeMode;

    // TTS preferences
    ttsEngine: TtsEngineChoice;
    defaultVoice: string | null;
    defaultTtsRate: number;

    // Speech recognition
    language: string;
    whisperModel: 'tiny' | 'base' | 'small' | 'medium' | 'large';

    // Pacing — used by both the session view's PacingController and
    // the STT adapter's client-side VAD. Mirrors the Python config's
    // pacing block 1:1.
    silenceBaseMs: number;
    silenceMaxMs: number;
    responseDelayMs: number;
    silenceCheckinSec: number;
    silenceCheckinsEnabled: boolean;
    silenceModeEnabled: boolean;
}

export const DEFAULT_APP_SETTINGS: AppSettings = {
    defaultProvider: 'ollama',
    defaultModel: '',
    textScale: 1.0,
    themeMode: 'auto',
    ttsEngine: 'browser',
    defaultVoice: null,
    defaultTtsRate: 160,
    language: 'en',
    whisperModel: 'small',
    silenceBaseMs: 3000,
    silenceMaxMs: 5000,
    responseDelayMs: 2000,
    silenceCheckinSec: 300,
    silenceCheckinsEnabled: true,
    silenceModeEnabled: true,
};

const KEY = 'app:settings';
const kv = new LocalStorageKv();

export async function loadAppSettings(): Promise<AppSettings> {
    const raw = await kv.get(KEY);
    if (!raw) return { ...DEFAULT_APP_SETTINGS };
    try {
        const parsed = JSON.parse(raw) as Partial<AppSettings>;
        return { ...DEFAULT_APP_SETTINGS, ...parsed };
    } catch {
        return { ...DEFAULT_APP_SETTINGS };
    }
}

export async function saveAppSettings(settings: AppSettings): Promise<void> {
    await kv.set(KEY, JSON.stringify(settings));
}

/**
 * Apply chrome-level settings (text scale, theme) to the live document.
 * Called at app boot and after settings are saved. Theme persists via
 * localStorage too (theme.ts manages that key) so the FOUC preempt in
 * index.html picks it up.
 */
export function applyChromeSettings(settings: AppSettings): void {
    document.documentElement.style.setProperty('--text-scale', String(settings.textScale));
    if (settings.themeMode === 'auto') {
        // theme.ts handles auto resolution; clear any explicit override.
        localStorage.removeItem('themeMode');
    } else {
        localStorage.setItem('themeMode', settings.themeMode);
        document.documentElement.setAttribute('data-theme', settings.themeMode);
    }
}
