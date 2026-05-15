# TS migration status — overnight Phase 1

Snapshot of the overnight work on branch `claude/ts-phase-1`. The
fuller plan and reasoning live in the plan file the assistant uses;
this is the in-repo summary so the PR diff carries the context.

## What landed

Nine commits, all on `claude/ts-phase-1`. 117 tests passing, typecheck
clean across both tsconfigs (root + ui).

| Commit | What |
|---|---|
| `f89c704` | OpenAI-compatible LLM provider — single class covers openai/openrouter/venice/groq via base-URL + default-model variants. SSE streaming. |
| `8f2c86a` | UI wiring for the new providers: 6-option dropdown in setup, BYOK API key entry, dedicated `api-keys.ts` module on top of KvStorage so the backend swaps cleanly to SecureStorage on mobile. |
| `b3f53af` | Unified `PacingConfig` with Python — `silenceModeEnabled`, `silenceBaseMs/MaxMs/RampRate`, `minSpeechDurationMs`. STT adapters consume the VAD subset; controller honors the [HOLD] kill switch. |
| `f28eccd` | PacingController wired into the session view; 10s background check-in loop fires `CHECK_IN_PROMPTS` via TTS (no LLM call). Ollama `coldLoadMessage()` surfaces the "loading model into memory" status. |
| `8f68cea` | continue-from-previous-session — "Continue last" button in setup, LLM-driven welcome-back opener, "— resumed —" transcript divider. |
| `01858e7` | Token streaming via `completeStream` (optional method on `LLMProvider`); implemented on Anthropic (SSE), OpenAI (SSE), Ollama (NDJSON). `streamCompletionWithChunkedTts` helper feeds completed sentences to TTS as they arrive; suppresses TTS entirely on `[HOLD]` prefix. |
| `34531ba` | Barge-in detection — parallel mic stream during TTS, cancels on energy threshold. `wrapTtsWithBargeIn()` wraps any `TtsEngine`. Silently no-ops without mic API. |
| `e1f7e3e` | Noting mode engine — prompts + `generateNotingLabel()` with composable reactivity (none/low/high), circle-context, and anti-self-repeat. Circle UI orchestrator deferred. |
| `d2aedac` | `claude_proxy` provider for Node — shells out to `claude` CLI for Pro/Max subscription routing. Node-only; kept off the runtime-agnostic LLM barrel. |

## What's deferred or blocked

- **Noting circle UI port** — ~500 LOC orchestrator (`src/web/static/js/noting.js`).
  Engine is ready (`ts/src/facilitation/noting.ts`); UI port is its own
  focused task and benefits from human eyes on the structural decisions.
- **BYOK Anthropic on mobile** via `@capacitor/http` — needs Capacitor
  (or Tauri 2 mobile) runtime to exercise.
- **Native STT validation** (`meditation-pal-0ao`) — needs a real
  iOS/Android device, including the on-device-vs-cloud privacy check.
- **On-device LLM validation** (`meditation-pal-0vb`) — same.

## Shell decision: Tauri 2

The user is leaning Tauri 2 mobile. Honest evaluation after living in
the TS codebase tonight: the strongest argument **against** is that
Tauri 2 mobile is too new for Glooow's audio-session requirements.
Specifically:

1. **iOS `AVAudioSession` configuration**. Glooow needs `playAndRecord`
   with `mixWithOthers` so ambient music can play during sessions.
   Capacitor has mature plugins for this; Tauri 2 mobile has no
   equivalent — you'd write a Rust plugin with a Swift bridge or vendor
   one. Misconfiguration is launch-blocking (audio routes to earpiece,
   backgrounding kills audio mid-session, mic doesn't release).
2. **Android foreground service** for 30-minute sessions with the
   screen off. Capacitor: well-trodden. Tauri 2 mobile: very new.
3. **WebView quirks don't go away** — Tauri rides WKWebView on iOS, the
   same place the existing pywebview app already had to patch a
   mic-permission bug. Electron sidesteps via bundled Chromium;
   Capacitor at least has years of workarounds.
4. **Plugin ecosystem gap** for native TTS, secure storage, SQLite.

### Recommendation: spike, then commit

3–5 day Tauri 2 mobile spike before committing the rest of the shell work:

1. Minimal Tauri 2 iOS app — 30-min audio playback with the screen off,
   mic capture during playback, survives backgrounding to another music
   app.
2. Same on Android with a foreground service.
3. If both work cleanly → full speed Tauri 2, single shell everywhere.
4. If either doesn't → Capacitor for mobile, Tauri 2 for desktop.
   Same TS UI; only adapters + shell config differ.

**Tauri 2 desktop is the clearer call** — smaller binary, lower RAM,
clean Rust bindings for whisper.cpp / llama.cpp. I'd recommend it
unconditionally for desktop.

## Why I'm pausing here

Tonight's remaining items either need device validation (STT/LLM
spikes) or depend on the shell decision. The TS UI work I've done is
deliberately shell-agnostic and will run unchanged inside whichever
shell wins. Pushing further before the shell decision risks building
shell-specific code that gets thrown away.

PR is at https://github.com/akrusz/glooow/pull/7 (parent branch
`ts-core`; this branch is its successor with overnight work).
