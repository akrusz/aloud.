/**
 * Base URL for the hosted aloud server (@aloud/server).
 *
 * Dev: the UI calls relative paths (/v1/...) and the Vite proxy forwards them
 * to the server (ui/vite.config.ts). A deployed static build has no proxy, so
 * it needs the absolute server origin, baked in at build time via
 * VITE_ALOUD_SERVER_URL (e.g. `VITE_ALOUD_SERVER_URL=https://api.aloud.example
 * npm run ui:build`). Leave it unset for dev and for any deploy where the
 * static host reverse-proxies /v1 to the server on the same origin.
 */

const BASE = (import.meta.env.VITE_ALOUD_SERVER_URL ?? '').replace(/\/+$/, '');

/** Resolve a server path (e.g. "/v1/llm/complete") against the configured base. */
export function serverUrl(path: string): string {
    return BASE ? `${BASE}${path}` : path;
}
