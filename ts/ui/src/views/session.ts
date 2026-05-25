/**
 * Session view — the actual meditation conversation.
 *
 * Takes a configured SessionSetup, builds the PromptBuilder + session
 * manager + LLM provider, then runs the conversation loop until the
 * user ends it. Calls back to the parent when the user wants to return
 * to setup.
 */

import {
    PromptBuilder,
    SessionManager,
    PacingController,
    TurnDecision,
    parseHoldSignal,
    generateSessionSummary,
    defaultPacingConfig,
} from '../../../src/facilitation/index.js';
import type { SessionState } from '../../../src/facilitation/session.js';
import {
    AnthropicProvider,
    OllamaProvider,
    OpenAIProvider,
    OpenRouterProvider,
    VeniceProvider,
    GroqProvider,
    type LLMProvider,
} from '../../../src/llm/index.js';
import type { SttEngine, TtsEngine } from '../../../src/platform/index.js';
import { streamCompletionWithChunkedTts } from '../streaming-tts.js';
import { wrapTtsWithBargeIn } from '../barge-in.js';
import { ClaudeProxyHttpProvider } from '../adapters/claude-proxy-http.js';

import {
    createBestStt,
    detectSttBackend,
    invalidateSttBackendCache,
} from '../adapters/stt-picker.js';
import { createTtsForVoice } from '../adapters/tts-picker.js';
import { type SessionSetup, dirStepToBackend } from '../settings.js';
import { loadAppSettings } from '../app-settings.js';
import { sessionStore } from '../state.js';
import { getApiKey } from '../api-keys.js';
import {
    mountEmberContainer,
    unmountEmberContainer,
    wireEmberControls,
    setRainbow,
} from '../embers.js';
import { initThemeToggle } from '../theme.js';
import { acquireWakeLock, releaseWakeLock } from '../wakelock.js';
import {
    buildScoredVoiceList,
    fetchServerVoices,
    previewVoice as runVoicePreview,
    renderVoiceList,
    renderVoiceModalHTML,
    stopPreview as stopVoicePreview,
    updateVoiceSelection,
    type ScoredVoice,
} from '../voice-picker.js';

// Anthropic blocks browser-origin requests outright; the others (OpenAI,
// OpenRouter, Venice, Groq) accept browser CORS. So Anthropic always
// routes through the Flask proxy in browser preview; the rest go BYOK
// direct from the browser. Mobile (Capacitor) will need a different
// path for Anthropic — either @capacitor/http or a hosted proxy.
const ANTHROPIC_PROXY_URL = '/api/llm/anthropic/messages';
const OLLAMA_PROXY_URL = '/ollama';

async function buildProvider(setup: SessionSetup): Promise<LLMProvider> {
    const modelOpt = setup.model ? { model: setup.model } : {};
    switch (setup.provider) {
        case 'ollama':
            return new OllamaProvider({ baseUrl: OLLAMA_PROXY_URL, ...modelOpt });
        case 'anthropic':
            // Browser-side Anthropic always goes through the Flask proxy
            // (CORS, plus we don't want the key in the browser).
            return new AnthropicProvider({ baseUrl: ANTHROPIC_PROXY_URL, ...modelOpt });
        case 'claude_proxy':
            // The `claude` CLI is a subprocess — Flask runs it on our
            // behalf and exposes the result over /api/llm/claude_proxy.
            return new ClaudeProxyHttpProvider(modelOpt);
        case 'openai':
        case 'openrouter':
        case 'venice':
        case 'groq': {
            // BYOK direct from the browser — these accept CORS.
            const apiKey = await getApiKey(setup.provider);
            if (!apiKey) {
                throw new Error(
                    `No API key set for ${setup.provider}. ` +
                        `Add it in Settings, or pick a different provider.`
                );
            }
            const opts = { apiKey, ...modelOpt };
            if (setup.provider === 'openai') return new OpenAIProvider(opts);
            if (setup.provider === 'openrouter') return new OpenRouterProvider(opts);
            if (setup.provider === 'venice') return new VeniceProvider(opts);
            return new GroqProvider(opts);
        }
    }
}


export interface SessionViewHandle {
    /** Tear down the running session and release resources. */
    teardown(): void;
}

export type SessionEndDestination = 'setup' | 'history';

export async function mountSessionView(
    root: HTMLElement,
    setup: SessionSetup,
    onEnd: (destination?: SessionEndDestination) => void,
    continueFrom: SessionState | null = null
): Promise<SessionViewHandle> {
    root.innerHTML = renderSessionHTML();

    const builder = new PromptBuilder({
        config: {
            focuses: setup.focuses,
            qualities: setup.qualities,
            directiveness: dirStepToBackend(setup.dirStep),
            verbosity: setup.verbosity,
            customInstructions: setup.customInstructions,
        },
    });
    const session = new SessionManager({ contextStrategy: 'full' });
    session.startSession();

    // If continuing from a previous session, hydrate the new session
    // with the old exchanges so the LLM has context.
    if (continueFrom && continueFrom.exchanges.length > 0) {
        session.loadExchanges(continueFrom.exchanges);
    }

    // Pacing config — read from persisted app settings so the values the
    // user tunes in the settings page actually affect the running
    // session. Falls back to defaults when nothing is persisted.
    const appSettings = await loadAppSettings();
    const pacingConfig = {
        ...defaultPacingConfig,
        responseDelayMs: appSettings.responseDelayMs,
        silenceCheckinSec: appSettings.silenceCheckinSec,
        silenceCheckinsEnabled: appSettings.silenceCheckinsEnabled,
        silenceModeEnabled: appSettings.silenceModeEnabled,
        silenceBaseMs: appSettings.silenceBaseMs,
        silenceMaxMs: appSettings.silenceMaxMs,
    };
    const pacing = new PacingController({ config: pacingConfig });
    pacing.startSession();

    let provider: LLMProvider;
    try {
        provider = await buildProvider(setup);
    } catch (err) {
        root.innerHTML = `
            <section class="session-stage">
                <div class="status">
                    <div id="status">${(err as Error).message}</div>
                </div>
            </section>
            <section class="controls">
                <button id="back" type="button" data-nav="setup">Back to setup</button>
            </section>`;
        return {
            teardown() {
                /* nothing to tear down */
            },
        };
    }
    const { engine: rawTts } = await createTtsForVoice(setup.voice, {
        // Server-side synthesis is billable compute — fold chars into usage.
        onServerSynthesize: (chars) => session.recordTts(chars),
    });
    // Wrap TTS with a barge-in listener so the user can interrupt the
    // facilitator mid-sentence by speaking. The listener opens its own
    // mic stream during speak() — separate from the STT adapter — and
    // calls cancel() when energy crosses the threshold for a few
    // consecutive frames.
    const ttsWithBargeIn = wrapTtsWithBargeIn(rawTts, {
        onBargeIn: () => {
            // Visual cue: drop the holding-orb if it was up. The listen
            // loop will pick up the user's next utterance naturally.
            setOrbHolding(false);
        },
    });
    // Outer wrapper: respect the TTS toggle button. When the user mutes
    // TTS, speak() becomes a no-op and any in-flight playback is
    // cancelled. Cheaper than tearing down the whole barge-in wrapper.
    const tts = {
        async speak(text: string, options?: import('../../../src/platform/index.js').TtsOptions): Promise<void> {
            if (!ttsEnabled) return;
            return ttsWithBargeIn.speak(text, options);
        },
        cancel(): Promise<void> {
            return ttsWithBargeIn.cancel();
        },
        listVoices() {
            return ttsWithBargeIn.listVoices();
        },
    } satisfies TtsEngine;
    // Re-probe each time the user starts a session: Flask may have come up
    // (or gone down) since the last detection.
    invalidateSttBackendCache();
    const stt: SttEngine | null = await createBestStt({
        silenceBaseMs: pacingConfig.silenceBaseMs,
        silenceMaxMs: pacingConfig.silenceMaxMs,
        silenceRampRate: pacingConfig.silenceRampRate,
        minSpeechDurationMs: pacingConfig.minSpeechDurationMs,
    });
    const sttBackend = await detectSttBackend();

    // The session view also injects an orb into the global nav's
    // .nav-center slot and overrides the nav links to End / History.
    // Both are restored on teardown so swapping back to setup doesn't
    // leave stale chrome.
    const navCenter = document.getElementById('navCenter');
    const navLinks = document.getElementById('navLinks');
    const savedNavLinks = navLinks ? navLinks.innerHTML : null;
    if (navCenter) {
        navCenter.innerHTML = `
            <div class="nav-session-info">
                <div class="orb orb-breathing orb-nav" id="orb"></div>
            </div>`;
    }
    if (navLinks) {
        navLinks.innerHTML = `
            <a href="#" id="end-btn" class="nav-end-link">End<span class="nav-word-session"> Session</span></a>
            <a href="#" data-nav="history">History</a>
            <button type="button" class="theme-toggle"
                data-theme-toggle aria-label="Toggle theme"></button>`;
        // Re-init the theme toggle since we just replaced its DOM node.
        const themeBtn = navLinks.querySelector<HTMLElement>('[data-theme-toggle]');
        if (themeBtn) initThemeToggle(themeBtn);
    }

    const conversation = root.querySelector<HTMLElement>('#conversation')!;
    const typingIndicator = root.querySelector<HTMLElement>('#typing-indicator')!;
    const statusEl = root.querySelector<HTMLElement>('#voice-status')!;
    const timerEl = root.querySelector<HTMLElement>('#timer')!;
    const ttsToggle = root.querySelector<HTMLButtonElement>('#tts-toggle')!;
    const micBtn = root.querySelector<HTMLButtonElement>('#voice-btn')!;
    const listenBtn = root.querySelector<HTMLButtonElement>('#listen-btn')!;
    const voicePickerBtn = root.querySelector<HTMLButtonElement>('#voice-picker-btn')!;
    const kasinaToggle = root.querySelector<HTMLInputElement>('#kasina-toggle')!;
    const orbEl = document.getElementById('orb');
    const endBtn = document.getElementById('end-btn') as HTMLAnchorElement | null;

    // Orb states mirror the existing app's behavior: always breathing,
    // with `orb-holding` layered on during silence mode. Richer states
    // (listening / thinking / speaking variants) are tracked in
    // meditation-pal-1au.
    function setOrbHolding(holding: boolean): void {
        if (orbEl) orbEl.classList.toggle('orb-holding', holding);
    }

    function setStatus(text: string): void {
        statusEl.textContent = text;
    }

    function appendMessage(
        role: 'user' | 'assistant',
        text: string,
        partial = false
    ): HTMLElement {
        const el = document.createElement('div');
        el.className = `message ${role === 'assistant' ? 'facilitator' : 'user'}${partial ? ' partial' : ''}`;
        // Match Python: text wrapped in .message-content for styling.
        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = text;
        el.appendChild(content);
        // Insert before the typing indicator so it stays at the bottom.
        conversation.insertBefore(el, typingIndicator);
        conversation.scrollTop = conversation.scrollHeight;
        return el;
    }

    function showTyping(): void {
        typingIndicator.hidden = false;
        conversation.scrollTop = conversation.scrollHeight;
    }
    function hideTyping(): void {
        typingIndicator.hidden = true;
    }

    // Session timer — counts since mount, formatted m:ss or h:mm:ss.
    const sessionStartMs = Date.now();

    // Keep the screen on for the duration of the session. The wake lock
    // module also re-acquires on visibility change while
    // body[data-session-active] is set.
    document.body.dataset['sessionActive'] = 'true';
    void acquireWakeLock();
    function updateTimer(): void {
        const elapsed = Math.floor((Date.now() - sessionStartMs) / 1000);
        const h = Math.floor(elapsed / 3600);
        const m = Math.floor((elapsed % 3600) / 60);
        const s = elapsed % 60;
        const pad = (n: number) => (n < 10 ? `0${n}` : String(n));
        timerEl.textContent = h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
    }
    updateTimer();
    const timerInterval = setInterval(updateTimer, 1000);

    // Initial mic / status hint.
    if (stt === null) {
        micBtn.disabled = true;
        micBtn.classList.add('disabled');
        const hint =
            'No mic backend available. Start Flask in another terminal (uv run python -m src.web) ' +
            'or open the preview in Chrome/Edge for Web Speech.';
        micBtn.title = hint;
        setStatus('Mic unavailable');
    } else {
        const label =
            sttBackend === 'capacitor'
                ? 'native STT'
                : sttBackend === 'web-speech'
                  ? 'Web Speech'
                  : 'server Whisper';
        setStatus(`Listening (${label})`);
    }

    function insertDivider(text: string): void {
        const divider = document.createElement('div');
        divider.className = 'message divider';
        divider.textContent = text;
        conversation.insertBefore(divider, typingIndicator);
    }

    // If continuing, render the old exchanges in the transcript with a
    // "continuing from earlier" divider above them.
    if (continueFrom && continueFrom.exchanges.length > 0) {
        const oldDate = new Date(continueFrom.startTime * 1000).toLocaleString();
        insertDivider(`continuing from ${oldDate}`);
        for (const ex of continueFrom.exchanges) {
            if (ex.role === 'user' || ex.role === 'assistant') {
                appendMessage(ex.role, ex.content);
            }
        }
        insertDivider('— resumed —');
    }

    // Show the intention as a faint first line of context, if set.
    if (setup.intention.trim()) {
        insertDivider(`intention: ${setup.intention}`);
    }

    let busy = false;
    let muted = false;
    let listenLoopRunning = false;
    let torn = false;
    let silenceMode = false;
    let currentPartial: HTMLElement | null = null;
    let scoredVoices: ScoredVoice[] = [];

    async function respondTo(userText: string): Promise<void> {
        if (busy) return;
        busy = true;
        try {
            // Speech-end event into the pacing controller — auto-exits
            // silence mode if we were in it, returns RESPOND.
            pacing.onSpeechEnd();
            pacing.onTranscription(userText);
            if (silenceMode) {
                silenceMode = false;
                setOrbHolding(false);
            }
            appendMessage('user', userText);
            session.addUserMessage(userText);

            // For Ollama: if the model isn't currently loaded into
            // memory, surface that so the user knows why the first
            // response is slow. Cheap (one HTTP call), and Ollama-only.
            if (provider instanceof OllamaProvider) {
                const coldMsg = await provider.coldLoadMessage();
                setStatus(coldMsg ?? 'Thinking…');
            } else {
                setStatus('Thinking…');
            }
            showTyping();

            const systemPrompt = builder.buildSystemPrompt();
            // Streaming + sentence-chunked TTS — falls back to non-streaming
            // when the provider doesn't implement completeStream. The
            // facilitator's first sentence starts speaking before the
            // remainder finishes generating.
            //
            // We don't render the partial text into the transcript here
            // because the [HOLD] prefix (if any) hasn't been stripped from
            // the early deltas. Render the cleaned full text at the end.
            setStatus('Speaking…');
            const { text: rawText, ttsDone, usage } = await streamCompletionWithChunkedTts(
                provider,
                tts,
                session.getContextMessages(),
                { system: systemPrompt, ttsOptions: { rate: setup.ttsRate } }
            );
            const { signal, cleanText } = parseHoldSignal(rawText);
            hideTyping();
            session.addAssistantMessage(cleanText, undefined, usage);
            appendMessage('assistant', cleanText);

            // Wait for any in-flight TTS chunks to finish so the next
            // turn doesn't pile on top.
            try {
                await ttsDone;
            } catch {
                /* non-fatal */
            }
            // Honor pacingConfig.silenceModeEnabled — when false, the
            // [HOLD] signal is dropped and we treat the response as a
            // normal one.
            const enterHold = signal === 'hold' && pacingConfig.silenceModeEnabled;
            if (enterHold) {
                silenceMode = true;
                pacing.enterSilenceMode();
                setStatus('Holding space — anything you say resumes');
                setOrbHolding(true);
            } else {
                setStatus(stt ? 'Listening…' : 'Ready — type to continue');
            }
            pacing.onResponseEnd();
        } catch (err) {
            hideTyping();
            setStatus(`Error: ${(err as Error).message}`);
        } finally {
            busy = false;
        }
    }

    /**
     * Always-on listening loop — matches the existing app's behavior.
     * Each iteration runs a single STT utterance; when speech ends, we
     * dispatch the transcription to respondTo() (which awaits TTS),
     * then loop back. Pauses while busy (LLM call + TTS playback) so
     * the mic doesn't pick up the speaker output as user input.
     *
     * Barge-in handling — interrupting TTS by speaking — is the real
     * app's behavior and lives in meditation-pal-1au for a separate
     * lift-first pass.
     */
    async function listenLoop(): Promise<void> {
        if (!stt || listenLoopRunning) return;
        listenLoopRunning = true;
        try {
            while (!torn && !muted) {
                while (busy && !torn && !muted) {
                    await new Promise<void>((r) => setTimeout(r, 100));
                }
                if (torn || muted) break;

                let finalText = '';
                let micError: string | null = null;
                try {
                    for await (const event of stt.start()) {
                        if (event.type === 'partial') {
                            if (!currentPartial) {
                                currentPartial = appendMessage('user', event.text, true);
                            } else {
                                currentPartial.textContent = event.text;
                            }
                        } else if (event.type === 'final') {
                            finalText = event.text;
                            // Billable server-side STT compute (Whisper) reports
                            // audio seconds; on-device engines omit it.
                            if (event.seconds) session.recordStt(event.seconds);
                        } else if (event.type === 'error') {
                            micError = describeSttError(event.error);
                        }
                    }
                } catch (err) {
                    micError = describeSttError(err);
                }
                if (currentPartial) {
                    currentPartial.remove();
                    currentPartial = null;
                }
                if (torn || muted) break;

                if (finalText.trim()) {
                    await respondTo(finalText.trim());
                } else if (micError) {
                    setStatus(micError);
                    // Brief backoff so a broken mic doesn't tight-loop us.
                    await new Promise<void>((r) => setTimeout(r, 2000));
                }
                // Empty utterance with no error: just loop and listen again.
            }
        } finally {
            listenLoopRunning = false;
        }
    }

    function setMicButtonState(): void {
        if (!stt) return;
        // The mic button's mute-line is driven by `.btn-voice.active` in the
        // CSS (active = mic on, line hidden); .active off shows the line. Mute
        // = remove .active. Also desaturate the orb while muted (.orb-muted).
        micBtn.classList.toggle('active', !muted);
        orbEl?.classList.toggle('orb-muted', muted);
        micBtn.setAttribute(
            'aria-label',
            muted ? 'Unmute microphone' : 'Mute microphone'
        );
    }

    micBtn.addEventListener('click', () => {
        if (!stt) return;
        if (muted) {
            muted = false;
            setMicButtonState();
            void listenLoop();
        } else {
            muted = true;
            void stt.stop();
            setMicButtonState();
            setStatus('Muted');
        }
    });

    // TTS toggle — when off, we cancel any in-flight speech and skip
    // subsequent speak() calls. Visual state: the active class shows the
    // wave icons; without it, the mute-line crosses through.
    let ttsEnabled = true;
    ttsToggle.addEventListener('click', () => {
        ttsEnabled = !ttsEnabled;
        ttsToggle.classList.toggle('active', ttsEnabled);
        if (!ttsEnabled) void tts.cancel();
    });

    // Listen mode — local silence mode toggle. Matches the Python
    // listen-btn behavior: announces "holding space", orb gets the
    // holding class, anything the user says next exits the mode.
    listenBtn.addEventListener('click', () => {
        if (silenceMode) {
            silenceMode = false;
            listenBtn.classList.remove('active');
            pacing.exitSilenceMode();
            setOrbHolding(false);
            setStatus(stt ? 'Listening…' : 'Ready');
        } else {
            silenceMode = true;
            listenBtn.classList.add('active');
            pacing.enterSilenceMode();
            setOrbHolding(true);
            setStatus("Holding space — say 'I'm ready' to resume");
        }
    });

    // Kasina gazing mode — lifted 1:1 from src/web/static/js/session.js
    // initKasinaMode(). The orb leaves the nav, grows to a 140px center
    // gaze object (.orb-kasina), can be dragged anywhere, and a shake or
    // 4 quick clicks toggles the rainbow easter egg. Click outside (or
    // re-toggle) exits. Forces dark theme while gazing.
    // Document-level kasina listeners outlive the orb element, so (unlike
    // the Flask MPA, which reloaded per navigation) we must remove them on
    // teardown or they leak across sessions. AbortController does it in one
    // shot; endSession() aborts it.
    const kasinaCleanup = new AbortController();
    initKasinaMode();

    function initKasinaMode(): void {
        if (!orbEl) return;
        const sessionContainer = root.querySelector<HTMLElement>('.session-container');
        const docOpts = { signal: kasinaCleanup.signal };

        let orbClickTimes: number[] = [];
        let orbDragStartX = 0;
        let orbDragStartY = 0;
        let shakeHistory: Array<{ x: number; y: number; time: number }> = [];
        let orbRainbow = false;
        let prevTheme: string | null = null;
        let orbDragging = false;
        let orbMoved = false;
        let rainbowCooldownUntil = 0;

        function toggleRainbow(now: number): void {
            if (rainbowCooldownUntil && now < rainbowCooldownUntil) return;
            orbRainbow = !orbRainbow;
            orbEl!.classList.toggle('orb-rainbow', orbRainbow);
            setRainbow(orbRainbow);
            rainbowCooldownUntil = now + 2000;
        }

        // Click orb in nav to enter kasina; 4 quick clicks while gazing
        // toggles rainbow. Suppress the click that ends a drag.
        orbEl.addEventListener('click', (e) => {
            if (orbMoved) {
                orbMoved = false;
                return;
            }
            if (!kasinaToggle.checked && !orbDragging) {
                e.stopPropagation();
                kasinaToggle.checked = true;
                kasinaToggle.dispatchEvent(new Event('change'));
                return;
            }
            if (kasinaToggle.checked) {
                const nowClick = Date.now();
                orbClickTimes.push(nowClick);
                while (orbClickTimes.length && nowClick - orbClickTimes[0]! > 1500) {
                    orbClickTimes.shift();
                }
                if (orbClickTimes.length >= 4) {
                    toggleRainbow(nowClick);
                    orbClickTimes = [];
                }
            }
        });

        // FLIP animation for the kasina toggle: snapshot the orb's
        // position/appearance before and after the layout change, then
        // animate the delta so the orb glides between nav and center.
        kasinaToggle.addEventListener('change', () => {
            const cs = getComputedStyle(orbEl!);
            const startOpacity = cs.opacity;
            const startFilter = cs.filter;
            const startBoxShadow = cs.boxShadow;
            const startBackground = cs.background;

            const first = orbEl!.getBoundingClientRect();
            orbEl!.style.animation = 'none';

            if (kasinaToggle.checked) {
                orbEl!.classList.remove('orb-breathing', 'orb-nav');
                orbEl!.classList.add('orb-kasina');
                document.body.appendChild(orbEl!);
                sessionContainer?.classList.add('kasina-active');
                const currentTheme = document.documentElement.getAttribute('data-theme');
                if (currentTheme !== 'dark') {
                    prevTheme = currentTheme;
                    document.documentElement.setAttribute('data-theme', 'dark');
                }
            } else {
                orbEl!.classList.remove('orb-kasina', 'orb-rainbow');
                const wasRainbow = orbRainbow;
                orbRainbow = false;
                if (wasRainbow) setRainbow(false);
                orbEl!.classList.add('orb-breathing', 'orb-nav');
                orbEl!.style.left = '';
                orbEl!.style.top = '';
                orbEl!.style.inset = '';
                orbEl!.style.margin = '';
                orbEl!.style.cursor = '';
                document.querySelector('.nav-session-info')?.prepend(orbEl!);
                sessionContainer?.classList.remove('kasina-active');
                if (prevTheme) {
                    document.documentElement.setAttribute('data-theme', prevTheme);
                    prevTheme = null;
                }
            }

            orbEl!.style.animation = '';
            const cs2 = getComputedStyle(orbEl!);
            const endOpacity = cs2.opacity;
            const endFilter = cs2.filter;
            const endBoxShadow = cs2.boxShadow;
            const endBackground = cs2.background;
            const endMatrix = cs2.transform;
            let endScale = 1;
            if (endMatrix && endMatrix !== 'none') {
                const m = endMatrix.match(/matrix\(([^,]+)/);
                if (m) endScale = parseFloat(m[1]!);
            }
            orbEl!.style.animation = 'none';

            const last = orbEl!.getBoundingClientRect();
            const dx = first.left + first.width / 2 - (last.left + last.width / 2);
            const dy = first.top + first.height / 2 - (last.top + last.height / 2);
            const scale = first.width / last.width;

            const anim = orbEl!.animate(
                [
                    {
                        transform: `translate(${dx}px, ${dy}px) scale(${scale})`,
                        opacity: startOpacity,
                        filter: startFilter,
                        boxShadow: startBoxShadow,
                        background: startBackground,
                    },
                    {
                        transform: `translate(0, 0) scale(${endScale})`,
                        opacity: endOpacity,
                        filter: endFilter,
                        boxShadow: endBoxShadow,
                        background: endBackground,
                    },
                ],
                { duration: 600, easing: 'ease-in-out', fill: 'forwards' }
            );
            anim.onfinish = () => {
                orbEl!.style.animation = '';
                requestAnimationFrame(() => anim.cancel());
            };
        });

        function startOrbDrag(clientX: number, clientY: number): void {
            if (!kasinaToggle.checked) return;
            orbDragging = true;
            orbMoved = false;
            const rect = orbEl!.getBoundingClientRect();
            orbEl!.style.inset = 'auto';
            orbEl!.style.margin = '0';
            orbEl!.style.left = `${rect.left}px`;
            orbEl!.style.top = `${rect.top}px`;
            orbEl!.style.cursor = 'grabbing';
            orbDragStartX = clientX - rect.left;
            orbDragStartY = clientY - rect.top;
        }

        function moveOrbDrag(clientX: number, clientY: number): void {
            if (!orbDragging) return;
            orbMoved = true;
            orbEl!.style.left = `${clientX - orbDragStartX}px`;
            orbEl!.style.top = `${clientY - orbDragStartY}px`;

            const now = Date.now();
            shakeHistory.push({ x: clientX, y: clientY, time: now });
            while (shakeHistory.length && now - shakeHistory[0]!.time > 1500) {
                shakeHistory.shift();
            }
            // Detect a shake: count direction reversals with enough travel.
            if (shakeHistory.length >= 3) {
                let reversals = 0;
                for (let i = 2; i < shakeHistory.length; i++) {
                    const a = shakeHistory[i - 2]!;
                    const b = shakeHistory[i - 1]!;
                    const c = shakeHistory[i]!;
                    const dx1 = b.x - a.x;
                    const dy1 = b.y - a.y;
                    const dx2 = c.x - b.x;
                    const dy2 = c.y - b.y;
                    const dist = Math.sqrt(dx2 * dx2 + dy2 * dy2);
                    if (dist > 6 && dx1 * dx2 + dy1 * dy2 < 0) reversals++;
                }
                if (reversals >= 2) {
                    toggleRainbow(Date.now());
                    shakeHistory = [];
                }
            }
        }

        function endOrbDrag(): void {
            if (!orbDragging) return;
            orbDragging = false;
            orbEl!.style.cursor = '';
        }

        orbEl.addEventListener('mousedown', (e) => {
            if (!kasinaToggle.checked) return;
            e.preventDefault();
            startOrbDrag(e.clientX, e.clientY);
        });
        document.addEventListener('mousemove', (e) => moveOrbDrag(e.clientX, e.clientY), docOpts);
        document.addEventListener('mouseup', endOrbDrag, docOpts);

        orbEl.addEventListener(
            'touchstart',
            (e) => {
                if (!kasinaToggle.checked) return;
                e.preventDefault();
                const t = e.touches[0];
                if (t) startOrbDrag(t.clientX, t.clientY);
            },
            { passive: false }
        );
        document.addEventListener(
            'touchmove',
            (e) => {
                if (orbDragging && e.touches[0])
                    moveOrbDrag(e.touches[0].clientX, e.touches[0].clientY);
            },
            docOpts
        );
        document.addEventListener('touchend', endOrbDrag, docOpts);

        // Click outside the orb (beyond its glow radius) exits kasina.
        document.addEventListener('click', (e) => {
            if (!kasinaToggle.checked || orbDragging) return;
            if (orbMoved) {
                orbMoved = false;
                return;
            }
            const target = e.target as HTMLElement;
            if (target.closest('.input-area, .input-controls, .nav')) return;
            const rect = orbEl!.getBoundingClientRect();
            const cx = rect.left + rect.width / 2;
            const cy = rect.top + rect.height / 2;
            const ddx = e.clientX - cx;
            const ddy = e.clientY - cy;
            if (Math.sqrt(ddx * ddx + ddy * ddy) < 100) return;
            kasinaToggle.checked = false;
            kasinaToggle.dispatchEvent(new Event('change'));
        }, docOpts);
    }

    // Voice picker — opens the same modal layout as the setup view's
    // picker, but selecting a voice here also rebuilds the live tts
    // engine so the next utterance uses the new voice.
    void initVoicePicker();

    async function initVoicePicker(): Promise<void> {
        const server = await fetchServerVoices();
        scoredVoices = buildScoredVoiceList(server, true);
        updateVoicePickerLabel();
    }

    function updateVoicePickerLabel(): void {
        const name = stripVoicePrefix(setup.voice);
        if (name) voicePickerBtn.textContent = `${name} · ${setup.ttsRate} wpm`;
        else voicePickerBtn.textContent = 'Voice';
    }

    voicePickerBtn.addEventListener('click', () => openSessionVoiceModal());

    function openSessionVoiceModal(): void {
        const modal = root.querySelector<HTMLElement>('#voice-modal');
        const listEl = root.querySelector<HTMLElement>('#voice-modal-list');
        const closeBtn = root.querySelector<HTMLButtonElement>('#voice-modal-close');
        const speedSlider = root.querySelector<HTMLInputElement>('#modal-speed-slider');
        const speedLabel = root.querySelector<HTMLElement>('#modal-speed-label');
        if (!modal || !listEl || !closeBtn || !speedSlider || !speedLabel) return;

        const currentName = stripVoicePrefix(setup.voice);
        renderVoiceList(listEl, scoredVoices, currentName, { showEngine: true });
        speedSlider.value = String(setup.ttsRate);
        speedLabel.textContent = `${setup.ttsRate} wpm`;
        modal.classList.remove('hidden');

        const onListClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const row = target.closest<HTMLElement>('.voice-row');
            if (!row) return;
            const name = row.dataset['voiceName'];
            if (!name) return;
            const entry = scoredVoices.find((v) => v.name === name);
            if (target.closest('.voice-row-preview')) {
                if (row.classList.contains('voice-row-locked')) return;
                void runVoicePreview(name, setup.ttsRate, entry?.engine);
                return;
            }
            if (row.classList.contains('voice-row-locked')) return;
            const idPrefix = entry?.engine === 'browser' ? 'browser:' : 'server:';
            setup.voice = `${idPrefix}${name}`;
            updateVoiceSelection(listEl, name);
            updateVoicePickerLabel();
            // Voice change mid-session: future utterances pick up the
            // new voice via createTtsForVoice. For now the active `tts`
            // is fixed at session start; a follow-up commit can rebuild
            // it. The label updating is the visible part the user
            // wanted today.
        };
        const onSpeedInput = () => {
            const rate = Number(speedSlider.value);
            setup.ttsRate = rate;
            speedLabel.textContent = `${rate} wpm`;
            updateVoicePickerLabel();
        };
        const closeModal = () => {
            modal.classList.add('hidden');
            stopVoicePreview();
            listEl.removeEventListener('click', onListClick);
            speedSlider.removeEventListener('input', onSpeedInput);
            closeBtn.removeEventListener('click', closeModal);
            modal.removeEventListener('click', onBackdrop);
        };
        const onBackdrop = (e: MouseEvent) => {
            if (e.target === modal) closeModal();
        };
        listEl.addEventListener('click', onListClick);
        speedSlider.addEventListener('input', onSpeedInput);
        closeBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', onBackdrop);
    }

    // Open the session with a facilitator greeting before the listen loop
    // starts. Mark busy so the mic loop doesn't hear input until the opener
    // finishes. Resuming → a warm welcome-back; fresh → a normal opener.
    {
        busy = true;
        void (async () => {
            try {
                if (continueFrom && continueFrom.exchanges.length > 0) {
                    await generateContinuationOpener();
                } else {
                    await generateOpener();
                }
            } finally {
                busy = false;
            }
        })();
    }

    /**
     * Fresh-session opener — mirrors meditation_session.py::generate_opener.
     * Asks the LLM for a brief welcome via buildOpenerPrompt (the prompt is
     * a one-shot instruction, NOT kept in history), falling back to the
     * static opener pool on any error.
     */
    async function generateOpener(): Promise<void> {
        const openerPrompt = builder.buildOpenerPrompt(setup.intention.trim());
        try {
            setStatus('Speaking…');
            showTyping();
            const messages = [
                ...session.getContextMessages(),
                { role: 'user' as const, content: openerPrompt },
            ];
            const { text: rawText, ttsDone, usage } = await streamCompletionWithChunkedTts(
                provider,
                tts,
                messages,
                { system: builder.buildSystemPrompt(), ttsOptions: { rate: setup.ttsRate } }
            );
            const { cleanText } = parseHoldSignal(rawText);
            hideTyping();
            // The opener prompt was a one-shot instruction — don't persist it;
            // record only the assistant greeting (with its usage).
            session.addAssistantMessage(cleanText, undefined, usage);
            appendMessage('assistant', cleanText);
            try {
                await ttsDone;
            } catch {
                /* non-fatal */
            }
            pacing.onResponseEnd();
            setStatus(stt ? 'Listening…' : 'Ready — type to continue');
        } catch (err) {
            console.warn('LLM opener failed, using static fallback', err);
            hideTyping();
            const fallback = builder.getSessionOpener();
            session.addAssistantMessage(fallback);
            appendMessage('assistant', fallback);
            try {
                await tts.speak(fallback, { rate: setup.ttsRate });
            } catch {
                /* non-fatal */
            }
            pacing.onResponseEnd();
            setStatus(stt ? 'Listening…' : 'Ready — type to continue');
        }
    }

    async function generateContinuationOpener(): Promise<void> {
        const continuationNote =
            'The meditator is returning to continue from a previous session. ' +
            "Offer a brief, warm welcome back and gently acknowledge they're " +
            'picking up where they left off.';
        try {
            setStatus('Welcoming you back…');
            // Build the message list as: previous exchanges + the synthetic
            // continuation note. Don't write the note to session history —
            // it's a one-shot instruction, not a conversational turn.
            const messages = [
                ...session.getContextMessages(),
                { role: 'user' as const, content: continuationNote },
            ];
            setStatus('Speaking…');
            showTyping();
            const { text: rawText, ttsDone, usage } = await streamCompletionWithChunkedTts(
                provider,
                tts,
                messages,
                {
                    system: builder.buildSystemPrompt(),
                    ttsOptions: { rate: setup.ttsRate },
                }
            );
            const { cleanText } = parseHoldSignal(rawText);
            hideTyping();
            session.addAssistantMessage(cleanText, undefined, usage);
            appendMessage('assistant', cleanText);
            try {
                await ttsDone;
            } catch {
                /* non-fatal */
            }
            pacing.onResponseEnd();
            setStatus(stt ? 'Listening…' : 'Ready — type to continue');
        } catch (err) {
            console.warn('Continuation opener failed', err);
            hideTyping();
            // Fall back to a static welcome — better than nothing.
            const fallback = 'Welcome back. Let’s continue.';
            session.addAssistantMessage(fallback);
            appendMessage('assistant', fallback);
            try {
                await tts.speak(fallback, { rate: setup.ttsRate });
            } catch {
                /* non-fatal */
            }
            pacing.onResponseEnd();
            setStatus(stt ? 'Listening…' : 'Ready — type to continue');
        }
    }

    // Kick off always-on listening when the view mounts.
    if (stt) {
        setMicButtonState();
        void listenLoop();
    }

    // Background check-in loop — polls the PacingController on a fixed
    // cadence. When the controller decides it's been long enough since
    // anything happened, we fire a gentle check-in ("I'm still here…")
    // to remind the user the facilitator hasn't gone anywhere. Disabled
    // when the user is in silence mode or has check-ins turned off.
    const CHECK_IN_POLL_MS = 10_000;
    const checkInTimer: ReturnType<typeof setInterval> | null = pacingConfig.silenceCheckinsEnabled
        ? setInterval(() => {
              if (torn || busy || muted) return;
              const decision = pacing.shouldRespond();
              if (decision !== TurnDecision.CheckIn) return;
              const text = builder.getCheckInPrompt();
              void respondWithFacilitatorLine(text);
          }, CHECK_IN_POLL_MS)
        : null;

    /**
     * Speak a facilitator-initiated line (check-in, not response to user
     * input). Adds it to the transcript + session history + plays TTS.
     * Does not call the LLM — the text is decided by the caller.
     */
    async function respondWithFacilitatorLine(text: string): Promise<void> {
        if (busy) return;
        busy = true;
        try {
            session.addAssistantMessage(text);
            appendMessage('assistant', text);
            setStatus('Speaking…');
            try {
                await tts.speak(text, { rate: setup.ttsRate });
            } catch {
                /* non-fatal */
            }
            pacing.onResponseEnd();
            setStatus(stt ? 'Listening…' : 'Ready — type to continue');
        } finally {
            busy = false;
        }
    }

    // End button + History link both live in the global nav (we
    // injected them on mount). Clicks during an active session go
    // through showEndConfirm() — losing a meditation to a stray tap
    // is bad UX.
    if (endBtn) {
        endBtn.addEventListener('click', (e) => {
            e.preventDefault();
            showEndConfirm('End this session?', undefined);
        });
    }
    const historyLink = navLinks?.querySelector<HTMLAnchorElement>('[data-nav="history"]');
    if (historyLink) {
        historyLink.addEventListener('click', (e) => {
            e.preventDefault();
            // Stop the global app-level data-nav handler so it doesn't
            // also dispatch — we want our confirm to be the only entry
            // into a nav-away from the live session.
            e.stopImmediatePropagation();
            showEndConfirm(
                'Leave session to view history? This will end your current session.',
                'history'
            );
        });
    }

    /**
     * Show the End-Session confirmation overlay. After a successful
     * confirm/skip-save, the session ends and onEnd is called with
     * `destination` so the app router knows where to land the user.
     * Wires fresh handlers each call so a re-open doesn't carry the
     * previous click's destination.
     */
    function showEndConfirm(
        message: string,
        destination: 'history' | undefined
    ): void {
        const overlay = root.querySelector<HTMLElement>('#session-confirm');
        const text = root.querySelector<HTMLElement>('#confirm-text');
        const yes = root.querySelector<HTMLButtonElement>('#confirm-yes');
        const no = root.querySelector<HTMLButtonElement>('#confirm-no');
        const skip = root.querySelector<HTMLButtonElement>('#confirm-skip-save');
        if (!overlay || !text || !yes || !no || !skip) return;

        text.textContent = message;
        skip.classList.remove('hidden');
        overlay.classList.remove('hidden');

        const cleanup = () => {
            overlay.classList.add('hidden');
            yes.removeEventListener('click', onYes);
            no.removeEventListener('click', onNo);
            skip.removeEventListener('click', onSkip);
        };
        const onYes = () => {
            cleanup();
            showSavingOverlay();
            void endSession(destination, false);
        };
        const onNo = () => cleanup();
        const onSkip = () => {
            cleanup();
            showSavingOverlay();
            void endSession(destination, true);
        };
        yes.addEventListener('click', onYes);
        no.addEventListener('click', onNo);
        skip.addEventListener('click', onSkip);
    }

    function showSavingOverlay(): void {
        const overlay = root.querySelector<HTMLElement>('#session-saving');
        overlay?.classList.remove('hidden');
    }

    mountEmberContainer();
    wireEmberControls(root);

    async function endSession(
        destination?: 'history',
        skipSave = false
    ): Promise<void> {
        if (torn) return;
        torn = true;
        if (checkInTimer) clearInterval(checkInTimer);
        clearInterval(timerInterval);
        pacing.endSession();
        const finalState = session.endSession();
        void stt?.stop();
        void tts.cancel();
        // Release the wake lock and clear the session-active flag so the
        // visibility-change handler stops re-acquiring it.
        releaseWakeLock();
        delete document.body.dataset['sessionActive'];
        // Drop the ember container — embers are session-only.
        unmountEmberContainer();
        // Exit kasina if active — runs the toggle's exit branch, which
        // restores the pre-kasina theme and moves the orb back into the nav
        // (about to be cleared) rather than orphaning it in <body>.
        if (kasinaToggle.checked) {
            kasinaToggle.checked = false;
            kasinaToggle.dispatchEvent(new Event('change'));
        }
        // Remove the document-level kasina drag/click listeners.
        kasinaCleanup.abort();
        // Restore the global nav slots we replaced on mount.
        if (navCenter) navCenter.innerHTML = '';
        if (navLinks && savedNavLinks !== null) {
            navLinks.innerHTML = savedNavLinks;
            // Re-init the theme toggle since its DOM node was just
            // replaced by the restore.
            const restoredThemeBtn = navLinks.querySelector<HTMLElement>('[data-theme-toggle]');
            if (restoredThemeBtn) initThemeToggle(restoredThemeBtn);
        }

        if (!skipSave && finalState && hasUserContent(finalState.exchanges)) {
            // Try to generate an LLM summary for the history row;
            // fall back to intention (or empty) if the LLM call fails.
            setStatus('Saving session…');
            let summary = '';
            try {
                // The summary is an off-transcript completion — fold its token
                // usage into the session tally before we persist finalState
                // (same object reference as session.state, so recording still
                // mutates it after endSession()).
                summary = await generateSessionSummary(provider, finalState.exchanges, {
                    onUsage: (u) => session.recordLlmUsage(u),
                });
            } catch {
                /* fall through to fallback */
            }
            finalState.notes = summary || setup.intention.trim();
            try {
                await sessionStore.save(finalState);
            } catch (err) {
                console.warn('Failed to save session', err);
            }
        }

        onEnd(destination);
    }

    function hasUserContent(exchanges: ReadonlyArray<{ role: string }>): boolean {
        // At least one real user turn — skip saving empty sessions
        // started and immediately ended by an accidental click.
        return exchanges.some((e) => e.role === 'user');
    }

    return {
        teardown(): void { void endSession(); },
    };
}

/** SessionSetup.voice carries a 'server:' or 'browser:' prefix; the voice
 *  picker works with raw names. Strip the prefix on the way in. */
function stripVoicePrefix(voice: string | null): string | null {
    if (!voice) return null;
    const m = /^(server|browser):(.*)$/.exec(voice);
    return m ? (m[2] ?? null) : voice;
}

function describeSttError(err: unknown): string {
    const msg = err instanceof Error ? err.message : String(err);
    // Common cases that benefit from plain-English status text.
    if (/Whisper endpoint 5\d\d/.test(msg) || /failed to fetch/i.test(msg)) {
        return 'Mic backend unreachable. Is Flask running? (uv run python -m src.web)';
    }
    if (/Whisper endpoint 503/.test(msg)) {
        return 'Whisper model still loading — try again in a moment.';
    }
    if (/permission/i.test(msg) || /denied/i.test(msg) || /NotAllowed/.test(msg)) {
        return 'Mic permission denied. Allow microphone access and try again.';
    }
    return `Mic error: ${msg}`;
}

function renderSessionHTML(): string {
    return `
    <div class="session-container">
        <div class="conversation" id="conversation">
            <div class="message facilitator typing-bubble" id="typing-indicator" hidden>
                <div class="message-content">
                    <span></span><span></span><span></span>
                </div>
            </div>
        </div>

        <div class="input-area">
            <div class="input-row">
                <div id="voice-status" class="voice-status">Connecting…</div>
                <span class="session-timer" id="timer">0:00</span>
                <button id="tts-toggle" class="btn btn-tts active" title="Read responses aloud" aria-label="Toggle text-to-speech">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                        <path class="tts-waves" d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
                        <path class="tts-waves" d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
                        <line class="mute-line" x1="3" y1="3" x2="21" y2="21"></line>
                    </svg>
                </button>
                <button id="voice-btn" class="btn btn-voice" title="Toggle microphone" aria-label="Toggle microphone">
                    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                        <line x1="12" y1="19" x2="12" y2="23"></line>
                        <line x1="8" y1="23" x2="16" y2="23"></line>
                        <line class="mute-line" x1="3" y1="3" x2="21" y2="21"></line>
                    </svg>
                </button>
                <button id="listen-btn" class="btn btn-listen"
                    title="Hold space — your words are saved but not sent. Say something like 'I'm ready' to resume.">
                    Just Listen
                </button>
            </div>
            <div class="input-controls">
                <div class="ember-level" title="Floating ember particles">
                    <span class="toggle-text">Embers</span>
                    <button class="ember-btn" id="ember-minus" type="button">−</button>
                    <div class="ember-blocks" id="ember-blocks">
                        <span class="ember-block filled" data-level="1"></span>
                        <span class="ember-block" data-level="2"></span>
                        <span class="ember-block" data-level="3"></span>
                        <span class="ember-block" data-level="4"></span>
                    </div>
                    <button class="ember-btn" id="ember-plus" type="button">+</button>
                </div>
                <label class="toggle-label" title="Kasina gazing mode">
                    <input type="checkbox" id="kasina-toggle">
                    <span class="toggle-text">Kasina</span>
                </label>
                <div class="voice-control">
                    <button type="button" id="voice-picker-btn" class="voice-picker-btn">Voice</button>
                </div>
            </div>
        </div>
    </div>

    <div class="ember-container" id="ember-container"></div>

    ${renderVoiceModalHTML({
        modalId: 'voice-modal',
        closeId: 'voice-modal-close',
        listId: 'voice-modal-list',
        speedSliderId: 'modal-speed-slider',
        speedLabelId: 'modal-speed-label',
        speedValue: 110,
    })}

    <div class="session-ended-overlay hidden" id="session-confirm">
        <div class="session-ended-content">
            <p id="confirm-text"></p>
            <div class="session-ended-actions">
                <button id="confirm-yes" type="button" class="btn btn-primary">End Session</button>
                <button id="confirm-no" type="button" class="btn btn-secondary">Cancel</button>
            </div>
            <button id="confirm-skip-save" type="button" class="btn-link hidden">End Without Saving</button>
        </div>
    </div>

    <div class="session-ended-overlay hidden" id="session-saving">
        <div class="session-ended-content">
            <p>Saving session…</p>
        </div>
    </div>`;
}
