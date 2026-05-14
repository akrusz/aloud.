import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Flask backend port (matches src/config.py default). Override at dev time
// via GLOOOW_BACKEND_URL if you're running Flask on a non-default port.
const BACKEND_URL = process.env['GLOOOW_BACKEND_URL'] ?? 'http://localhost:4649';
const OLLAMA_URL = process.env['OLLAMA_URL'] ?? 'http://localhost:11434';

export default defineConfig({
    root: __dirname,
    server: {
        port: 5173,
        strictPort: false,
        proxy: {
            // Anthropic / future cloud LLM proxy lives on the Flask backend.
            '/api': BACKEND_URL,
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
