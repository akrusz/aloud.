/**
 * Runtime "is this a desktop environment" detection.
 *
 * "Desktop" = the /api backend is reachable. In dev/web that's Flask via
 * the Vite proxy; in a Tauri build it's the embedded Rust server (resolved
 * through appUrl(), which points at the injected loopback base). We probe
 * /api/system-info at boot and cache the result. Views read isDesktop() for
 * gating desktop-only features (claude_proxy provider, env-var hints, the
 * Open config folder button).
 *
 * Result is monotonic: once we've decided "desktop", we stick with it
 * for the session. If Flask flaps down between probes we'd rather not
 * yank the controls.
 */

import { appUrl } from './app-base.js';

/**
 * Synchronous "are we running inside the Tauri desktop shell" check.
 * Tauri v2 always injects `window.__TAURI_INTERNALS__` into the webview
 * (independent of the `withGlobalTauri` config), so this is reliable at
 * boot without a probe. Used to gate shell-specific behavior: the macOS
 * WKWebView's Web Speech API is unreliable, so STT must prefer
 * server-Whisper (see stt-picker.ts); chrome (drag region, no-select)
 * keys off it too.
 */
export function isTauri(): boolean {
    return (
        typeof window !== 'undefined' &&
        (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
            undefined
    );
}

let cached: boolean | null = null;
let inflight: Promise<boolean> | null = null;

export async function detectIsDesktop(): Promise<boolean> {
    if (cached !== null) return cached;
    if (inflight) return inflight;
    inflight = (async () => {
        try {
            const resp = await fetch(appUrl('/system-info'), { method: 'GET' });
            cached = resp.ok;
            return cached;
        } catch {
            cached = false;
            return cached;
        } finally {
            inflight = null;
        }
    })();
    return inflight;
}

/** Synchronous read — returns the cached value, or `false` until the
 *  first probe completes. Useful for render paths that can't await. */
export function isDesktopSync(): boolean {
    return cached ?? false;
}
