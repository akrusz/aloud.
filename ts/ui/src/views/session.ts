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

import {
    createBestStt,
    detectSttBackend,
    invalidateSttBackendCache,
} from '../adapters/stt-picker.js';
import { createTtsForVoice } from '../adapters/tts-picker.js';
import { type SessionSetup, dirStepToBackend } from '../settings.js';
import { sessionStore } from '../state.js';
import { getApiKey } from '../api-keys.js';
import {
    mountEmberContainer,
    unmountEmberContainer,
    wireEmberControls,
} from '../embers.js';

// Anthropic blocks browser-origin requests outright; the others (OpenAI,
// OpenRouter, Venice, Groq) accept browser CORS. So Anthropic always
// routes through the Flask proxy in browser preview; the rest go BYOK
// direct from the browser. Mobile (Capacitor) will need a different
// path for Anthropic — either @capacitor/http or a hosted proxy.
const ANTHROPIC_PROXY_URL = '/api/llm/anthropic/messages';
const OLLAMA_PROXY_URL = '/ollama';

async function buildProvider(setup: SessionSetup): Promise<LLMProvider> {
    const modelOpt = setup.model ? { model: setup.model } : {};
    if (setup.provider === 'ollama') {
        return new OllamaProvider({ baseUrl: OLLAMA_PROXY_URL, ...modelOpt });
    }
    if (setup.provider === 'anthropic') {
        // Browser-side Anthropic always goes through the Flask proxy
        // (which injects the server-side key). If we ever need BYOK
        // Anthropic in the browser, route it through @capacitor/http
        // or a CORS-relaxed proxy.
        return new AnthropicProvider({ baseUrl: ANTHROPIC_PROXY_URL, ...modelOpt });
    }
    // Remaining providers: BYOK direct from the browser.
    const apiKey = await getApiKey(setup.provider);
    if (!apiKey) {
        throw new Error(
            `No API key set for ${setup.provider}. ` +
                `Add it in Setup, or pick a different provider.`
        );
    }
    const opts = { apiKey, ...modelOpt };
    switch (setup.provider) {
        case 'openai':
            return new OpenAIProvider(opts);
        case 'openrouter':
            return new OpenRouterProvider(opts);
        case 'venice':
            return new VeniceProvider(opts);
        case 'groq':
            return new GroqProvider(opts);
    }
}


export interface SessionViewHandle {
    /** Tear down the running session and release resources. */
    teardown(): void;
}

export async function mountSessionView(
    root: HTMLElement,
    setup: SessionSetup,
    onEnd: () => void,
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

    // Pacing config — for now we keep defaults; the setup view doesn't
    // surface these yet. The PacingController honors check-in cadence
    // and the [HOLD] kill switch; the STT adapter VAD reads the rest.
    const pacingConfig = defaultPacingConfig;
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
    const { engine: tts } = await createTtsForVoice(setup.voice);
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

    const transcript = root.querySelector<HTMLElement>('#transcript')!;
    const statusEl = root.querySelector<HTMLElement>('#status')!;
    const micBtn = root.querySelector<HTMLButtonElement>('#mic')!;
    const textInput = root.querySelector<HTMLInputElement>('#text-input')!;
    const textForm = root.querySelector<HTMLFormElement>('#text-form')!;
    const endBtn = root.querySelector<HTMLButtonElement>('#end')!;
    const orbEl = root.querySelector<HTMLElement>('#session-orb')!;

    // Orb states mirror the existing app's behavior: always breathing,
    // with `orb-holding` layered on during silence mode. The richer
    // listening/thinking/speaking variants I prototyped previously are
    // deferred to meditation-pal-1au.
    function setOrbHolding(holding: boolean): void {
        orbEl.classList.toggle('orb-holding', holding);
    }

    function setStatus(text: string): void {
        statusEl.textContent = text;
    }
    function appendMessage(role: 'user' | 'assistant', text: string, partial = false): HTMLElement {
        const el = document.createElement('div');
        el.className = `message ${role}${partial ? ' partial' : ''}`;
        el.textContent = text;
        transcript.appendChild(el);
        transcript.scrollTop = transcript.scrollHeight;
        return el;
    }

    if (stt === null) {
        micBtn.disabled = true;
        const hint =
            'No mic backend available. Start Flask in another terminal (uv run python -m src.web) ' +
            'for server Whisper, or open the preview in Chrome/Edge for Web Speech, then start a ' +
            'new session.';
        micBtn.title = hint;
        micBtn.textContent = 'Mic unavailable';
        setStatus(`Mic unavailable — type to begin. ${hint}`);
    } else {
        micBtn.disabled = false;
        const label =
            sttBackend === 'capacitor'
                ? 'native STT'
                : sttBackend === 'web-speech'
                  ? 'Web Speech'
                  : 'server Whisper';
        setStatus(`Listening (${label}). Speak when ready, or type.`);
    }

    // If continuing, render the old exchanges in the transcript with a
    // "continuing from earlier" divider above them.
    if (continueFrom && continueFrom.exchanges.length > 0) {
        const divider = document.createElement('div');
        divider.className = 'message intention';
        const oldDate = new Date(continueFrom.startTime * 1000).toLocaleString();
        divider.textContent = `continuing from ${oldDate}`;
        transcript.appendChild(divider);
        for (const ex of continueFrom.exchanges) {
            if (ex.role === 'user' || ex.role === 'assistant') {
                appendMessage(ex.role, ex.content);
            }
        }
        const resumeDivider = document.createElement('div');
        resumeDivider.className = 'message intention';
        resumeDivider.textContent = '— resumed —';
        transcript.appendChild(resumeDivider);
    }

    // Show the intention as a faint first line of context, if set.
    if (setup.intention.trim()) {
        const el = document.createElement('div');
        el.className = 'message intention';
        el.textContent = `intention: ${setup.intention}`;
        transcript.appendChild(el);
    }

    let busy = false;
    let muted = false;
    let listenLoopRunning = false;
    let torn = false;
    let silenceMode = false;
    let currentPartial: HTMLElement | null = null;

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
            const { text: rawText, ttsDone } = await streamCompletionWithChunkedTts(
                provider,
                tts,
                session.getContextMessages(),
                { system: systemPrompt, ttsOptions: { rate: setup.ttsRate } }
            );
            const { signal, cleanText } = parseHoldSignal(rawText);
            session.addAssistantMessage(cleanText);
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
        micBtn.classList.toggle('listening', !muted);
        micBtn.textContent = muted ? 'Unmute mic' : 'Mute mic';
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
            setStatus('Muted — click Unmute mic or type to continue');
        }
    });

    // Generate a warm continuation opener via the LLM when resuming.
    // Fire before starting the listen loop; mark busy so the loop
    // won't start hearing mic input until the opener has finished.
    if (continueFrom && continueFrom.exchanges.length > 0) {
        busy = true;
        void (async () => {
            try {
                await generateContinuationOpener();
            } finally {
                busy = false;
            }
        })();
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
            const { text: rawText, ttsDone } = await streamCompletionWithChunkedTts(
                provider,
                tts,
                messages,
                {
                    system: builder.buildSystemPrompt(),
                    ttsOptions: { rate: setup.ttsRate },
                }
            );
            const { cleanText } = parseHoldSignal(rawText);
            session.addAssistantMessage(cleanText);
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

    textForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = textInput.value.trim();
        if (!text) return;
        textInput.value = '';
        void respondTo(text);
    });

    endBtn.addEventListener('click', () => {
        void endSession();
    });

    mountEmberContainer();
    wireEmberControls(root);

    async function endSession(): Promise<void> {
        if (torn) return;
        torn = true;
        if (checkInTimer) clearInterval(checkInTimer);
        pacing.endSession();
        const finalState = session.endSession();
        void stt?.stop();
        void tts.cancel();
        // Drop the ember container — embers are session-only.
        unmountEmberContainer();

        if (finalState && hasUserContent(finalState.exchanges)) {
            // Try to generate an LLM summary for the history row;
            // fall back to intention (or empty) if the LLM call fails.
            setStatus('Saving session…');
            let summary = '';
            try {
                summary = await generateSessionSummary(provider, finalState.exchanges);
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

        onEnd();
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
    <section class="session-stage">
        <div class="orb orb-breathing" id="session-orb" aria-hidden="true"></div>
        <div class="status"><div id="status">Connecting…</div></div>
    </section>

    <section class="transcript" id="transcript" aria-live="polite"></section>

    <section class="controls">
        <button id="mic" type="button" disabled>Start listening</button>
        <form id="text-form">
            <input id="text-input" type="text"
                placeholder="…or type here and press enter" autocomplete="off" />
        </form>
        <button id="end" type="button" class="btn-end">End session</button>
    </section>

    <section class="session-footer">
        <div class="ember-level" title="Floating ember particles">
            <span class="toggle-text">Embers</span>
            <button class="ember-btn" id="ember-minus" type="button">−</button>
            <div class="ember-blocks" id="ember-blocks">
                <span class="ember-block" data-level="1"></span>
                <span class="ember-block" data-level="2"></span>
                <span class="ember-block" data-level="3"></span>
                <span class="ember-block" data-level="4"></span>
            </div>
            <button class="ember-btn" id="ember-plus" type="button">+</button>
        </div>
    </section>`;
}
