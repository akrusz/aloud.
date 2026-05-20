# Voice Barge-In Behavior

The barge-in system is **entirely client-side**, implemented in `src/web/static/js/session.js`. The server is unaware of barge-in — it simply receives audio and sends TTS audio.

## Detection

Three conditions must all be true (session.js lines 964–993):

1. **TTS is active** — any of: `ttsSpeaking`, `synth.speaking`, or `serverAudioPlaying` is true
2. **Mic RMS energy > `BARGE_IN_THRESHOLD` (0.04)** — intentionally higher than the normal speech threshold (0.015) to avoid triggering on TTS bleed picked up by the mic
3. **Sustained for 3 consecutive chunks (~280ms)** — if any chunk drops below threshold, the counter resets to 0

## What Happens on Trigger

When 3 consecutive above-threshold chunks are detected (lines 975–984):

1. `stopServerAudio()` — kills the Web Audio `AudioBufferSourceNode`, sets `serverAudioPlaying = false`
2. `synth.cancel()` — kills browser speechSynthesis
3. State reset — `ttsSpeaking = false`, `ttsMismatchStart = 0`, `bargeInCount = 0`
4. `preBuffer = [chunk]` — discards the old pre-buffer (which contains TTS audio that would contaminate transcription) and seeds with only the current chunk
5. Falls through to normal VAD, which begins detecting the user's speech

## TTS Playback Pathways

Two TTS pathways exist, and barge-in interrupts both:

- **Server-generated WAV** — macOS `say` generates WAV bytes on the server → sent over Socket.IO in the `facilitator_message` event → played via Web Audio API (`playServerAudio()`)
- **Browser speechSynthesis** — fallback when server TTS is unavailable or audio bytes are missing

## Post-TTS Cooldown (Normal End Only)

When TTS ends naturally (not via barge-in), an 800ms cooldown (`TTS_COOLDOWN_MS`) keeps `ttsSpeaking = true` to suppress mic input that might capture the tail of the TTS audio. This cooldown is **bypassed** during barge-in — `ttsSpeaking` is set to `false` immediately.

## TTS Watchdog

Chrome sometimes fails to fire `onend` on `SpeechSynthesisUtterance`. A watchdog (lines 933–952) checks: if `ttsSpeaking` is true but neither `synth.speaking` nor `serverAudioPlaying` is true for > 1500ms (`TTS_WATCHDOG_MS`), it force-resets `ttsSpeaking`. This prevents the system from getting permanently stuck in the "TTS is playing" state.

## Thresholds

All defined as constants in session.js (lines 354–366):

| Constant | Value | Purpose |
|---|---|---|
| `SILENCE_THRESHOLD` | 0.015 | Normal VAD speech detection |
| `BARGE_IN_THRESHOLD` | 0.04 | Speech-over-TTS detection |
| `BARGE_IN_CHUNKS` | 3 | ~280ms sustained required |
| `TTS_COOLDOWN_MS` | 800 | Post-TTS mic suppression |
| `TTS_WATCHDOG_MS` | 1500 | Force-reset stuck TTS state |

## Post-Barge-In Flow

After barge-in, the normal VAD state machine takes over:

1. `silence` → `speech_started` → `speaking`
2. Audio accumulates in `audioChunks`
3. Adaptive silence detection triggers end-of-utterance
4. `submitUtterance()` sends audio to the server for Whisper transcription
5. Server processes it as a normal `user_message` — no awareness that barge-in occurred

## Key Files

| File | Lines | Role |
|---|---|---|
| `src/web/static/js/session.js` | 331–366 | State variables and threshold constants |
| `src/web/static/js/session.js` | 932–993 | Core barge-in detection in `onaudioprocess` |
| `src/web/static/js/session.js` | 1011–1105 | VAD state machine (post-barge-in flow) |
| `src/web/static/js/session.js` | 1405–1479 | `speak()`, `playServerAudio()`, `stopServerAudio()` |
| `src/tts/macos.py` | 71–102 | `speak_to_bytes()` — generates WAV for client playback |
| `src/web/app.py` | 441–476 | `handle_user_message` — server processing after barge-in |
| `src/web/app.py` | 520–582 | `handle_audio_data` — Whisper transcription handler |
