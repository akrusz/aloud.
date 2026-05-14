/**
 * Pick an STT adapter at runtime based on what the host environment
 * supports. Order of preference:
 *
 *   1. Capacitor native plugin   — best on iOS/Android (no network)
 *   2. Web Speech API            — fine on Chrome / Edge / Android Chrome
 *   3. null                      — fall back to text input; caller decides
 *
 * Detection is async because Capacitor's `isAvailable()` is async, but
 * the result is cached so the picker is cheap to call repeatedly.
 */

import type { SttEngine } from '../../../src/platform/stt.js';

import { CapacitorSttEngine } from './capacitor-stt.js';
import { WebSpeechSttEngine, isWebSpeechSupported } from './web-speech-stt.js';

export type SttBackend = 'capacitor' | 'web-speech' | 'none';

let cachedBackend: SttBackend | null = null;

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
        case 'none':
            return null;
    }
}
