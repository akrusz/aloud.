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

import { CapacitorSttEngine } from './capacitor-stt.js';
import { ServerWhisperSttEngine } from './server-whisper-stt.js';
import { WebSpeechSttEngine, isWebSpeechSupported } from './web-speech-stt.js';

export type SttBackend = 'capacitor' | 'web-speech' | 'server-whisper' | 'none';

const SERVER_WHISPER_PROBE_URL = '/api/stt/whisper';
let cachedBackend: SttBackend | null = null;

async function isServerWhisperReachable(): Promise<boolean> {
    if (!ServerWhisperSttEngine.isAvailable()) return false;
    try {
        // OPTIONS or HEAD aren't routed by Flask for this endpoint; a tiny
        // POST with no body gets us a 400 (route exists) or 503 (model
        // loading) — both prove the endpoint is wired up.
        const response = await fetch(SERVER_WHISPER_PROBE_URL, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
        });
        return response.status !== 404;
    } catch {
        return false;
    }
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
 */
export async function createBestStt(): Promise<SttEngine | null> {
    const backend = await detectSttBackend();
    switch (backend) {
        case 'capacitor':
            return new CapacitorSttEngine();
        case 'web-speech':
            return new WebSpeechSttEngine();
        case 'server-whisper':
            return new ServerWhisperSttEngine();
        case 'none':
            return null;
    }
}
