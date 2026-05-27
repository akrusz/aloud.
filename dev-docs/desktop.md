# Desktop shell (Tauri 2)

The desktop build wraps the TS UI (`ts/ui`) in a Tauri 2 native window.
Scaffolded 2026-05-27; lives in `ts/src-tauri/`.

## Run it

```bash
cd ts
npm run tauri:dev      # builds the Rust shell, starts Vite, opens the window
npm run tauri:build    # production .app/.dmg (macOS) — see caveat below
```

`tauri:dev` runs `beforeDevCommand` (`npm run ui:dev -- --port 1420 --strictPort`)
and points the webview at `http://localhost:1420`. The port is **pinned** on
purpose: Tauri's `devUrl` is a fixed string, so if Vite were allowed to drift to
another port (5174, …) the window would silently load the wrong server. 1420 is
Tauri's conventional dev port and is kept separate from the plain browser
`npm run ui:dev` (still 5173).

## Dev vs. production backend

- **Dev** (`tauri:dev`): the webview loads the Vite dev server, so Vite's proxy
  (`ui/vite.config.ts`) forwards `/api/*` to Flask (`localhost:4649`) and `/v1/*`
  to the hosted server. **Flask must be running** for STT/TTS/providers to work:
  `uv run python -m src.web` from the repo root. This is the current
  "runs on desktop against the existing backend" state.
- **Production** (`tauri:build`): there is no Vite proxy. The bundled static UI
  issues `fetch('/api/...')` against `tauri://localhost`, which has no backend.
  So a production desktop build is **not functional yet** — it needs the local
  backend described below. This is the Flask-removal work, not the scaffold.

## Backend plan (Flask removal, desktop)

Decision (see `meditation-pal-nn1`): desktop uses **native Rust in Tauri** for
local inference — `whisper-rs` (whisper.cpp) for STT, Piper (ONNX) for TTS —
plus trivial command/HTTP shims for providers, the `claude` CLI subprocess, and
the config-folder shell escapes. The web target does **not** share this: web
users get cloud forwarding (`ts/server`) or browser-native STT/TTS, so the two
targets split cleanly and the Rust choice doesn't force a parallel Node
inference backend.

The UI already abstracts the hosted server base via `ui/src/server-base.ts`
(`serverUrl()`). The `/api/*` endpoints currently rely on the Vite proxy; the
Flask-removal phase mirrors `server-base.ts` with an `apiUrl()` helper pointed at
an embedded local server (or Tauri commands) in the desktop build. Endpoints to
replace: `/api/stt/whisper`, `/api/voices` + `/api/voices/preview`,
`/api/providers`, `/api/models`, `/api/tts-engines`, `/api/system-info`,
`/api/llm/claude_proxy/complete`, `/api/open-*`.

## Config notes

- `tauri.conf.json`: identifier `app.aloud.meditation` (matches the Capacitor
  bundle ID); window 1000×820, min 480×600.
- `Cargo.toml`: crate name is `app` / lib `app_lib` (Tauri default; left as-is to
  avoid churn).
- `src-tauri/target/` and `src-tauri/gen/schemas` are gitignored.
