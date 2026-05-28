# Desktop shell (Tauri 2)

The desktop build wraps the TS UI (`ts/ui`) in a Tauri 2 native window.
Scaffolded 2026-05-27; lives in `ts/src-tauri/`.

## Run it

```bash
cd ts
npm run tauri:dev      # builds the Rust shell, starts Vite, opens the window
npm run tauri:build    # production .app/.dmg (macOS) — see caveat below
```

**Build prerequisites:** the Rust toolchain (rustup), and **cmake** (`brew install
cmake`) plus a C compiler — `whisper-rs` compiles whisper.cpp and `piper-rs`
(via espeak-rs) compiles espeak-ng, both from source. `piper-rs`'s `ort`
backend downloads the matching ONNX Runtime binary at build time, so the same
toolchain works on macOS/Windows/Linux. On first run the app
downloads the Whisper model (base.en GGML, ~142 MB) to
`<app-data>/models/` (`~/Library/Application Support/app.aloud.meditation/models`
on macOS); STT returns 503 until that finishes loading.

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

The UI abstracts the local backend base via `ui/src/api-base.ts` (`apiUrl()`),
mirroring `server-base.ts` (`serverUrl()`) for the hosted `/v1/*` server. In a
Tauri build the Rust shell starts an embedded `axum` server (`src-tauri/server.rs`)
on an ephemeral loopback port and injects `window.__ALOUD_API_BASE__` via an
`initialization_script`; `apiUrl()` reads it (empty → relative paths in dev/web).

Endpoint progress (replacing Flask `/api/*`):

- ✅ `/api/system-info` — platform + tool availability (`which`).
- ✅ `/api/stt/whisper` — local Whisper via `whisper-rs` (whisper.cpp).
- ✅ `/api/voices` + `/api/voices/preview` — Piper (ONNX via `piper-rs`:
  `ort` + espeak-ng) cross-platform, plus macOS `say` as a Darwin-only local
  engine. See `src-tauri/src/tts.rs`.
- ✅ `/api/tts/download-model` + `/api/tts/uninstall-model` — Piper models are
  downloaded **explicitly** via the picker's Download button (streamed NDJSON
  progress, wire-compatible with the old Flask routes), never on demand: a
  session must not stall on a 100 MB fetch mid-synthesis, and the explicit
  install/uninstall UX is preserved. Multi-speaker voices share one `.onnx`, so
  downloading/uninstalling any speaker affects the whole family; the picker
  re-reads `/api/voices` afterward and all sharing speakers flip state together
  (the `downloaded` flag is per model file). The TS button is wired in
  `views/setup.ts` and `views/settings.ts` via `downloadVoiceModel()` /
  `uninstallVoiceModel()` in `voice-picker.ts`.
- ✅ `/api/providers` + `/api/models/<provider>` — `src-tauri/src/providers.rs`.
  Includes the elaborate Ollama recommendation system (total RAM via `sysinfo`,
  fast-GPU detection, curated tier catalog from `DEFAULT_OLLAMA_TIERS`, per-tier
  `fits`/`installed` annotations, `other_installed`, version + outdated against
  `MIN_OLLAMA_VERSION`). The TS settings page renders this via
  `ui/src/settings-ollama.ts` (visible only when provider = ollama).
  `/api/models` is a stub (returns `[]`) — model lists need the provider's API
  key, which on desktop lives in localStorage rather than the backend env, so
  the picker falls back to a free-form text input until a key-forwarding path
  is added.
- ✅ `/api/ollama/pull` (streamed NDJSON progress) + `/api/ollama/delete` —
  `src-tauri/src/ollama.rs`. Proxies the local Ollama daemon's HTTP API; UI
  drives per-model progress bars + Remove buttons. The
  restart / upgrade / install-Ollama-itself flows from the Python build are
  intentionally deferred (platform-specific shell-outs — brew, curl|sh, manual
  on Windows — tangential to "manage the models I have").
- ✅ `/api/llm/claude_proxy/complete` — spawns the local `claude` CLI via
  `tokio::process` and mirrors the Python provider's flags, prompt encoding,
  JSON parsing, and 90 s timeout. See `src-tauri/src/llm.rs`.
- ✅ `/api/open-config-folder`, `/api/open-sessions-folder`,
  `/api/open-voice-settings` — cross-platform `reveal_path()` helper opens the
  app data dir for the two folder buttons (desktop sessions live in webview
  storage, not on disk, so the data dir is the closest meaningful target for
  now); voice-settings opens macOS System Settings → Spoken Content on Darwin,
  400s elsewhere.
- ⬜ `/api/tts-engines` — listed in the bead but has no fetch site in the TS UI
  (only mentioned in code comments as a future option), so deferred until a
  consumer actually needs it.

## Config notes

- `tauri.conf.json`: identifier `app.aloud.meditation` (matches the Capacitor
  bundle ID); window 1000×820, min 480×600.
- `Cargo.toml`: crate name is `app` / lib `app_lib` (Tauri default; left as-is to
  avoid churn).
- `src-tauri/target/` and `src-tauri/gen/schemas` are gitignored.
