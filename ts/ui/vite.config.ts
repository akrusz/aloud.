import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Flask backend port (matches src/config.py default). Override at dev time
// via ALOUD_BACKEND_URL if you're running Flask on a non-default port.
const BACKEND_URL = process.env['ALOUD_BACKEND_URL'] ?? 'http://localhost:4649';
const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://localhost:11434';
// Hosted aloud server (@aloud/server) — the metered LLM proxy. Defaults to the
// dev port in ts/server/.env.example; override with ALOUD_SERVER_URL.
const SERVER_URL = process.env['ALOUD_SERVER_URL'] ?? 'http://localhost:8787';

export default defineConfig({
    root: __dirname,
    server: {
        // Allow Vite to read CSS / TS sources from outside ui/ — we
        // import the existing app's CSS verbatim from src/web/static/.
        // Repo root is two levels up (../..).
        fs: {
            allow: [resolve(__dirname, '../..')],
        },
        port: 5173,
        strictPort: false,
        proxy: {
            // Hosted aloud cloud service: auth, account, billing, and the
            // metered LLM/STT/TTS forwarding (/cloud/v1/*). The Hono server
            // speaks /cloud/v1 directly — no rewrite needed.
            '/cloud': SERVER_URL,
            // The app's own backend (/app/v1/*). In dev this is still the
            // Python/Flask backend, which serves the legacy /api/* paths, so
            // rewrite the versioned prefix back to /api until Flask is retired
            // (then point this at the Hono server, which serves /app/v1/*).
            '/app': {
                target: BACKEND_URL,
                rewrite: (path) => path.replace(/^\/app\/v1/, '/api'),
            },
            // Ollama is direct-to-local but we route through Vite so the
            // browser sees same-origin (no need to widen OLLAMA_ORIGINS).
            '/ollama': {
                target: OLLAMA_URL,
                changeOrigin: true,
                rewrite: (path) => path.replace(/^\/ollama/, ''),
            },
        },
    },
    resolve: {
        alias: {
            '@core': resolve(__dirname, '../src'),
        },
    },
    build: {
        outDir: resolve(__dirname, 'dist'),
        emptyOutDir: true,
        sourcemap: true,
    },
});
