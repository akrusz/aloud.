/**
 * Base URL for the local `/api/*` backend (formerly Flask).
 *
 * - **Dev / web**: empty base — the UI calls relative `/api/...` paths and the
 *   Vite proxy (dev) or a same-origin reverse proxy (web) forwards them.
 * - **Tauri desktop**: the Rust shell starts an embedded server on an ephemeral
 *   loopback port and injects `window.__ALOUD_API_BASE__` via an
 *   initialization_script before any page script runs (see src-tauri/lib.rs +
 *   server.rs). We read it here so `/api/*` resolves to that local server.
 *
 * Mirrors `server-base.ts` (which does the same for the hosted `/v1/*` server)
 * so desktop and web share one set of fetch-based adapters — only the base
 * differs.
 */

const BASE = (
    (globalThis as unknown as { __ALOUD_API_BASE__?: string }).__ALOUD_API_BASE__ ?? ''
).replace(/\/+$/, '');

/** Resolve an API path (e.g. "/api/system-info") against the configured base. */
export function apiUrl(path: string): string {
    return BASE ? `${BASE}${path}` : path;
}
