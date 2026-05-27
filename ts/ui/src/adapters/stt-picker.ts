/**
 * Pick an STT adapter at runtime based on what the host environment
 * supports. Order of preference:
 *
 *   1. Capacitor native plugin   — best on iOS/Android (no network)
 *   2. Web Speech API            — fine on Chrome / Edge / Android Chrome
 *   3. Server Whisper            — universal fallback when Flask is up
 *   4. null                      — text-only mode
 *
 * Server Whisper is preferred over `null` because it works on Firefox,
 * Safari, and anywhere else the Web Speech API doesn't cover. It does
 * require the Flask backend to be reachable — that's the user's
 * desktop runtime, so it's reliable in development.
 *
 * Detection is async (Capacitor + server probe) and the result is
 * cached so the picker stays cheap.
 */

import type { SttEngine } from '../../../src/platform/stt.js';
import type { PacingConfig } from '../../../src/facilitation/pacing.js';

import { CapacitorSttEngine } from './capacitor-stt.js';
import { ServerWhisperSttEngine } from './server-whisper-stt.js';
import { WebSpeechSttEngine, isWebSpeechSupported } from './web-speech-stt.js';

/** VAD-tuning subset of PacingConfig the picker forwards to adapters. */
type VadOpts = Partial<
    Pick<
        PacingConfig,
        'silenceBaseMs' | 'silenceMaxMs' | 'silenceRampRate' | 'minSpeechDurationMs'
    >
>;

export type SttBackend = 'capacitor' | 'web-speech' | 'server-whisper' | 'none';

const SERVER_WHISPER_PROBE_URL = '/api/stt/whisper';
let cachedBackend: SttBackend | null = null;

async function isServerWhisperReachable(): Promise<boolean> {
    if (!ServerWhisperSttEngine.isAvailable()) return false;
    try {
        // Empty POST → Flask returns 400 (route exists, body missing) or
        // 503 (model still loading). Either proves Flask is up and the
        // route is wired. A 5xx from Vite's proxy (ECONNREFUSED, etc.)
        // means the backend is down — fail closed so we don't pretend
        // the mic will work.
        const response = await fetch(SERVER_WHISPER_PROBE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
        });
        return response.status === 400 || response.status === 503;
    } catch {
        return false;
    }
}

/**
 * Force a re-probe on the next detectSttBackend / createBestStt call.
 * Call this when Flask was started after the page loaded — otherwise
 * the picker caches "none" and the user has to reload.
 */
export function invalidateSttBackendCache(): void {
    cachedBackend = null;
}

/** Detect which STT path the current environment supports. */
export async function detectSttBackend(): Promise<SttBackend> {
    if (cachedBackend !== null) return cachedBackend;

    // Capacitor sets `window.Capacitor` when running inside the native
    // wrapper — cheap synchronous check before the async availability probe.
    const hasCapacitor =
        typeof window !== 'undefined' &&
        (window as unknown as { Capacitor?: unknown }).Capacitor !== undefined;
    if (hasCapacitor) {
        try {
            const available = await CapacitorSttEngine.isAvailable();
            if (available) {
                cachedBackend = 'capacitor';
                return cachedBackend;
            }
        } catch {
            // Fall through to next option.
        }
    }

    if (isWebSpeechSupported()) {
        cachedBackend = 'web-speech';
        return cachedBackend;
    }

    if (await isServerWhisperReachable()) {
        cachedBackend = 'server-whisper';
        return cachedBackend;
    }

    cachedBackend = 'none';
    return cachedBackend;
}

/**
 * Construct the best-available STT engine. Returns null when nothing is
 * available so the caller can switch the UI into text-only mode.
 *
 * Only the server-Whisper path implements client-side VAD, so the VAD
 * tuning fields are silently ignored by the other adapters (Capacitor
 * and Web Speech both auto-detect end-of-utterance themselves).
 */
export async function createBestStt(vadOpts: VadOpts = {}): Promise<SttEngine | null> {
    const backend = await detectSttBackend();
    switch (backend) {
        case 'capacitor':
            return new CapacitorSttEngine();
        case 'web-speech':
            return new WebSpeechSttEngine();
        case 'server-whisper':
            return new ServerWhisperSttEngine(vadOpts);
        case 'none':
            return null;
    }
}
