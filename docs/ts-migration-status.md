# TS migration status

Snapshot of work on branch `claude/ts-phase-1`. Tracks where we are
against the goal of reaching Python parity on desktop before doing a
Tauri 2 mobile spike.

## Where we are

The TS UI now runs against the Flask backend as a browser preview and
matches Python's behavior for the major flows. Tests: 117 passing,
typecheck + Vite build clean.

| Area | Status |
|---|---|
| Engine — pacing, session, prompts, summary, noting | Ported (`ts/src/facilitation/`) |
| LLM providers — Ollama, Anthropic, OpenAI/OpenRouter/Venice/Groq, claude_proxy | All wired in setup + session view, with proper desktop-only gating for claude_proxy |
| Streaming + sentence-chunked TTS | Done for Anthropic / OpenAI / Ollama; suppresses TTS on `[HOLD]` prefix |
| Barge-in | TTS cancellation on user-speech detection during playback |
| Voice picker | Modal port of `_voice_modal.html` — tiered (Recommended / Premium / Quality / Standard / Other), engine badges, preview button per row, in-modal WPM slider; setup + session + settings share the picker |
| Model picker | Fetches `/api/models/<provider>` (and `/api/providers` for Ollama); falls back to a text input when Flask isn't reachable; auto-selects the first model when none is set |
| History view | Per-row Continue from here / Copy text / Delete; continuation stash via `sessionStorage` matches Python's flow |
| Setup page | Tab bar / info panels not yet ported; presets / focus / vibe / directiveness / verbosity / voice / provider / model are all live; continue banner; provider availability indicators (`✱` / `✘`) |
| Settings page | LLM provider + per-provider keys with Get-a-key + Paste buttons, ElevenLabs key gated on TTS engine, voice modal with Uninstall on downloaded Piper voices, display preview pane with theme + text-scale preview-only-until-save, pacing knobs (live → session reads them), network/updates as visible-but-disabled placeholders |
| Session view | Layout mirrors `session.html` — orb in nav, conversation, voice-status + timer + TTS toggle + mic + Just Listen, ember level + kasina toggle + voice picker btn; check-in loop + continue-from-previous-session both wired |
| Chrome | Theme toggle (sun/moon) survives nav swaps, idle orb in nav on setup/settings with click-to-bounce, About modal |

## What still needs work

Things called out by the user that aren't yet done:

- **URL routing / back button** — nav doesn't update the URL, so the browser back button can't navigate between Setup / History / Settings. Affects browser preview now; will also affect the Android hardware back button under Tauri 2 / Capacitor. Plan: `history.pushState` on each `goSetup` / `goHistory` / `goSettings`, listen to `popstate`, support deep-linking on initial load.
- **Setup-page tab bar (Exploration / Noting / info `?`)** — Python's index.html has these; engine for Noting is ready but the circle UI hasn't been ported.
- **Setup `?` info panels** next to each section header — small but absent.
- **Native STT + on-device LLM validation** — needs real iOS/Android devices (beads `meditation-pal-0ao`, `0vb`).

## Recent parity fixes (most recent first)

- **Piper delay** — Flask's `/api/voices/preview` was creating a fresh Piper instance per call when the voice's engine differed from the shared `app.server_tts`, reloading the model every utterance. Added an LRU-of-1 cache so repeated calls for the same voice reuse the loaded instance.
- **Claude Subscription provider** in the dropdown via a new `/api/llm/claude_proxy/complete` Flask route + a thin `ClaudeProxyHttpProvider` TS client. Gated by an `isDesktop` probe so mobile builds won't expose it.
- **Browser voice playback** — picker stored `browser:<name>` ids but the catalog keyed by `voiceURI`; the BrowserTtsEngine was being constructed without a voice and silently using the OS default. Now the picker's name is threaded through to `BrowserTtsEngine` via a new `defaultVoice` option.
- **API key UX** — Get-a-key links to the provider's console + Paste from clipboard (with prefix soft-check and graceful `⌘V`/`Ctrl+V` placeholder fallback when the browser blocks the read).
- **ElevenLabs key** appears only when TTS engine = ElevenLabs.
- **Display preview pane** — header / body / small / dropdown / slider / checkbox / two buttons live in the right column of the Display section; the text-scale slider drives `previewInner.style.fontSize`, the theme select drives `previewBox[data-preview-theme]`. Text scale + theme now apply only to the preview until Save is clicked.
- **Provider indicators** in setup — `✱` (installed but not running) / `✘` (not configured), pulled from `/api/providers`. API key entry stays in Settings only.
- **Continue banner** × actually closes it (switched to `.hidden` class — Python's CSS `display: flex` beat the `[hidden]` attribute).
- **Preset cards** rebuilt as Python's `<label class="style-card">` with hidden radio + `.style-card-inner`.
- **Orb click bounce** in the nav center on Setup / Settings.

## Shell decision (still open)

User leaning Tauri 2 mobile. The strongest argument against is the
audio-session / foreground-service / native-TTS plugin gap on Tauri 2
mobile vs Capacitor's well-trodden equivalents.

Recommended path: a 3–5 day Tauri 2 mobile spike that proves out
30-minute screen-off audio playback + mic capture + background
survival before committing the rest of the shell work. If it works
cleanly → full speed Tauri 2 (single shell). If not → Capacitor for
mobile, Tauri 2 for desktop. Same TS UI either way; only the
platform-adapter files and the shell config differ.

**Tauri 2 desktop is the clearer call** unconditionally — smaller
binary, lower RAM, clean Rust bindings for whisper.cpp / llama.cpp.

The spike comes after we hit Python parity on desktop. We're close
but not there yet (URL routing + setup tab bar are the two
non-trivial things left).

PR is at https://github.com/akrusz/glooow/pull/7 (parent branch
`ts-core`; `claude/ts-phase-1` is its successor).
