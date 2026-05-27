/**
 * Build-time environment for the UI. We don't pull in `vite/client` wholesale
 * (the UI tsconfig runs with `types: []` to keep the typecheck hermetic), so
 * declare just the env vars we read. Vite statically replaces
 * `import.meta.env.VITE_*` with literals at build time.
 */
interface ImportMetaEnv {
    /** Absolute origin of the hosted aloud server for a deployed static build,
     *  e.g. https://api.aloud.example. Unset in dev — paths stay relative and
     *  the Vite proxy forwards them. */
    readonly VITE_ALOUD_SERVER_URL?: string;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
