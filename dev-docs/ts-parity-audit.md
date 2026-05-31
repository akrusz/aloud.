# TS ↔ Flask parity audit (meditation-pal-gnz)

Structured feature-by-feature comparison of the old Flask UI (`src/web`) against
the new TypeScript UI (`ts/ui`), done **2026-05-28** as the gnz audit before
Python deletion (sk8).

## Method & honest caveats

This was a **static code-reading pass** — five parallel readers walked setup,
session, noting, history, settings, voice picker, and chrome, classifying every
old user-facing feature as PRESENT / MISSING / DIFFERENT against the TS code,
with `file:symbol` references. **Nothing was run.** I did not exercise the app,
have no felt-sense of the old version, and can't judge timing/feel/visual polish.
Treat this as a map of *where to look*, to be paired with a human hands-on pass.

Severity tiers below are my judgment of user impact, not verified in-product.

---

## Tier 1 — functional regressions (a feature is unreachable or silently wrong)

- **Noting: "Add participant" button is hard-disabled.** `ui/src/views/setup.ts`
  renders `#add-participant-btn` with a literal `disabled` attribute and a stale
  title ("…coming with the noting circle port"). `wireNotingPanel`/`newParticipant`/
  `renderParticipantList` are all fully implemented behind it, and one default
  participant is seeded — but a disabled button fires no clicks, so **users can
  never add a 2nd–4th participant.** Multi-participant noting circles (the whole
  point of the mode) are unreachable. Old: `setup.js:addParticipant`, wired at
  load. *Likely a one-line fix: drop the `disabled` attr + stale title.* Flagged
  independently by two readers as the highest-impact regression.

- **Mobile chrome is missing: no bottom-nav, no "More" sheet, no hamburger.**
  Old `base.html` `.bottom-nav` (Session/History/Settings/More) + `.mobile-more-sheet`
  (End/History/About/Theme/Fullscreen/Close) + `chrome.js` handlers have **no TS
  equivalent** (grep `bottom-nav`/`mobile-more` in `ts/ui` = 0). The TS UI keeps
  only the top `.nav`, and the imported CSS hides `.nav-links` under 767px — so on
  a phone, End Session / History / Settings / Theme are **unreachable mid-session.**
  This is the same root cause as the bottom-bar bug below (legacy CSS assumes a
  bottom-nav that doesn't exist). Big mobile gap.

- **Noting: no non-speech-only filter on user turns.** `noting-session.ts:startUserTurn`
  accepts any non-empty transcript, so a Whisper non-speech marker ("(coughing)",
  "*sighs*") counts as your note and ends your turn. Old filtered these via
  `noting.js:isNonSpeechOnly` (applied in `session.js:sendText`). The
  exploration-session path has the same gap (`respondTo` has no marker filter).

- **"Begin Session" is never disabled for an unavailable provider.** Old
  `setup.js:updateBeginButton` blocked starting when an LLM was needed but the
  selected provider wasn't available; TS always lets you click Begin and pushes
  the failure into the session view. A user whose Ollama isn't running gets a
  dead session instead of a guarded button.

- **Provider auto-selection / ordering lost.** Old sorted available-first,
  promoted `claude_proxy` to the top when working, and auto-selected the best
  available provider (`setup.js:applyProviderAvailability`). TS only annotates
  ✱/✘ markers and uses the persisted provider (`setup.ts:applyProviderIndicators`)
  — a new user can land on an unavailable default with no nudge toward a working one.

- **Error toasts gone.** Old `ui.js:showErrorToast` popped a dismissable
  `.error-toast` for LLM errors and "speech model failed". TS has no toast system
  at all (the `.error-toast` CSS is imported but never used); errors surface only
  as inline `#voice-status` text inside the session view. Out-of-session errors
  have no surface.

- **Voice commands ("mute" / "hold" / "wait") not implemented.** Old parsed spoken
  commands (`audio.js:isHoldCommand`, mute path). TS button tooltips still advertise
  them (session.ts listen/mic button titles say 'Say "hold" or "wait"') but **nothing
  parses transcripts** — the listen loop sends every final transcript to `respondTo`.

- **"No voices" warning path missing.** Old surfaced a "⚠ No voices" picker state +
  "Set up TTS in Settings" banner after a 3s timeout (`chrome.js:toggleNoVoicesBanner`,
  `voice.js:initVoices`). TS silently shows "Voice"/"Default" with no guidance.

---

## Tier 2 — the three bugs the developer flagged (all confirmed)

### Window-mode + Network dropdowns "not clickable" — intentional stubs
Not accidental: `#s-window-mode` is rendered `disabled` (`settings.ts:1215`) **and**
re-disabled in `wireDisplaySection` (`windowMode.disabled = true`, line 751). Same for
`#s-host` (Network Access, lines 840/1315). They were stubbed because the backend to
honor window-mode/network selection was never wired on the Tauri or web targets. The
Frameless checkbox was removed entirely (intentional — Tauri is always frameless).
**Fix = implement the backing behavior, then un-disable — not just remove `disabled`,
which would make them do nothing.**

### Update-check button "doesn't work" — intentional stub, no backend
`renderUpdatesSection` renders `#s-check-update` `disabled` (`settings.ts:1331`);
`wireUpdatesSection` (line 848) re-disables it and attaches no handler. There is **no
update endpoint on either TS backend** — no Tauri `check_for_updates` command, no
`tauri-plugin-updater`, no Hono route. The old chain (`settings.js` →
`/api/check-update` → `updater.py` git-fetch/GitHub-Releases compare, plus
`background.py` startup check and the About-modal "View details and install") was
never ported. The `#aboutVersion` element in the About modal is also never populated
(shows blank). **Fix = add an update-check command/route + result UI, or remove the
control until the Tauri self-update story is decided.**

### Settings/setup bottom bar floats up at narrow widths — real CSS regression
render a real `.bottom-nav` (which also resolves the Tier-1 mobile-chrome gap;
the legacy rule is correct as soon as the nav exists). Given the mobile-nav gap, doing
the bottom-nav properly kills two birds.

---

## Tier 3 — behavioral DIFFERENT (works, but not like the old app)

- **Silence/"Just Listen" mode is dumber.** Old buffered spoken text while holding,
  displayed it, and ran a `check_resume_intent` LLM classification before resuming
  (`audio.js`/`socketHandlers.js`). TS `session.ts listenBtn` is a local toggle: any
  next utterance resumes, no buffering, no resume-intent classification.
- **Barge-in re-speaks.** Old kept the triggering audio (`state.preBuffer`) so the
  onset wasn't lost; TS `barge-in.ts` opens a separate `getUserMedia` stream per
  `speak()` and discards the triggering audio — the user must re-speak. Same
  threshold/chunk constants.
- **Speculative transcription dropped.** Old pre-sent audio at base-silence to cut
  latency (`audio.js:submitSpeculative`); TS has only plain partial/final events.
- **Mic-level ring only lights for a subset of backends.** TS `mic-meter.ts` runs for
  web-speech, or server-whisper only when in Tauri (`startMeter` gate in session.ts);
  server-Whisper-in-a-browser gets a dead mic ring. Old lit it for everyone.
- **History: no pagination / "Load More".** TS `history.ts` loads & renders every
  session at once; old paged at 50 (`history.js:LIMIT`). Degrades with many sessions.
- **History: session-type tag missing.** Old appended `· Exploration`/`· Noting` to
  the date row (`history.js`); TS `renderItem` omits it (data exists as `notes:'noting
  circle'`). Empty-state also lost its "Start Your First Session" CTA.
- **Default-value drifts** (silent behavior change vs Flask): `silenceMaxMs` 5000 (was
  7000), `ttsEngine` 'browser' (was 'macos'), voice speed slider default 110 (was 120),
  index-guide tour auto-start delay 250ms (was 600ms).
- **Theme easter-egg voice mismatch.** `theme.ts` still reads `localStorage
  'aloud-voice'/'aloud-speed'`, but the new picker persists to `setup.voice` /
  `settings.defaultVoice`, so the easter egg never uses the user's chosen voice/speed.
- **TTS path / opener / end-confirm** are all re-architected client-side (streaming
  chunked TTS, client-side opener pool, synchronous summary at end instead of
  `prefetch_summary`). Parity-or-better, but different mechanisms; flagged for the
  hands-on pass.

---

## Tier 4 — copy / attribution / content

- **Methods info-panel lost its credits + anecdotes.** Old `index.html` `#info-methods`
  had the personal jhana/noting anecdotes and **acknowledgment links** (Maija Haavisto,
  Jhourney, Vince Horn). TS `setup.ts` dropped all of them. Attribution loss worth a
  deliberate decision.
- **Stale-vs-correct brand strings:** voice preview phrase is corrected in TS
  ("Welcome to aloud. I'll be your facilitator.") vs old "Welcome to glow…" — TS is
  right here. Just confirming no "glooow"/"glow" leftovers in the ported copy.
- **Language list truncated** from ~30 languages to 9 (`settings.ts` LANGS: en/es/fr/
  de/it/pt/ja/zh/ko), and no `navigator.language` auto-select. Non-English users lose
  their option.
- Various status-line copy differs (old "Speak naturally, or say 'mute'…",
  "Transcribing…", "Downloading speech model… N%"; TS backend-labelled "Listening
  (server Whisper)", "Thinking…", and a Flask-centric error hint still mentioning
  `uv run python -m src.web`).

---

## Tier 5 — settings panes: smaller drops

(All in old `settings.js`/`settings.html`, no TS equivalent unless noted.)
- Saved-API-key **masked-value** indicator (`key saved (sk-ant-…abcd)`) → TS shows
  generic "Saved".
- claude_proxy **CLI-detected status** block (`checkProxyStatus` → `/api/system-info`).
- Provider **✘/✱ availability markers** per option → TS hides unavailable instead.
- **Voice-quality upsell modal** ("Improve Your Voice Quality", Piper/macOS nudge,
  remind-later/don't-ask) — combined with the `ttsEngine='browser'` default, new users
  likely land on the worst-sounding default with no prompt to improve.
- **TTS-engine install row** (pip-install from UI), **Ollama URL field**, LAN-info
  display + copy URL (`updateLanInfo`), Save-time **"choose a voice" validation**,
  first-run "Save & Start" + auto-tour variant.
- Tour hardcodes `piperAvailable:true` (`settings.ts:887` TODO) — offers Piper even
  when not installed. Old read the real flag.
- Check-in stepper isn't greyed when its checkbox is off (old `updateCheckinSecState`).

---

## Confirmed PRESENT (parity or better) — the reassuring column

Timer, embers (+ level easter egg & burst), kasina mode (FLIP/drag/shake-rainbow,
with cleaner SPA teardown), rainbow egg, transcript bubbles + typing indicator +
continuation dividers, `[HOLD]` silence (stripped pre-speech, arguably better),
TTS toggle, mic-mute + orb desaturate, wakelock, beforeunload guard, saving overlay,
background check-in loop, voice scoring/tiers/recommended/download/uninstall/preview,
About modal (brand toggle, links), login form, LAN-setup instructions, theme
(light/dark/system + 4h decay + FOUC bootstrap + 8-click egg), SW caching strategy
(byte-identical), URL routing (full History-API router, parity-or-better), noting
turn rotation + adaptive cadence + reactive context + fixed-phrase/sound participants.

Net-new in TS (not gaps): hosted-voice tier, BYOK opt-in toggle, multi-speaker model
grouping with sibling-download locking, Back-button leave-confirm during live sessions.

---

## Intentional omissions (confirmed, not bugs)

- Fullscreen toggle, window-close button, pywebview bridge — Tauri owns its titlebar.
- `mobile-quirks.js` / `audio-utils.js` Socket.IO + Web-Audio-decode halves — N/A
  (TS uses HTTP/fetch + `HTMLAudioElement`); but the iOS **AudioContext-resume-on-
  visibilitychange** half is a real, still-relevant gap worth a small registry port.
- `sw.js` version hardcoded `0.12.1` — belongs with release tooling, not a naive
  `package.json` read (the package is a `0.0.1` placeholder).

---

## Suggested disposition

- **Quick wins for the fix session:** un-disable the noting Add-participant button
  (one line); add the `@media(max-width:767px)` footer override (one rule, fixes both
  flagged footer bugs); add the session-type tag back to history rows.
- **Needs a decision:** mobile bottom-nav (port it → also fixes footer lift + the
  mobile-chrome Tier-1 gap), update-check (implement vs remove), window-mode/network
  (implement backend vs remove the controls), voice-quality upsell + default TTS engine.
- **Behavioral parity to validate by hand:** silence/resume-intent, barge-in re-speak,
  speculative transcription, mic-ring backends.

Each Tier-1/Tier-2 item is a candidate sub-ticket under gnz.
