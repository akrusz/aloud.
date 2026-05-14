import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    root: __dirname,
    server: {
        port: 5173,
        strictPort: false,
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
