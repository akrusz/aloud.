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
    parseHoldSignal,
    generateSessionSummary,
} from '../../../src/facilitation/index.js';
import {
    AnthropicProvider,
    OllamaProvider,
    type LLMProvider,
} from '../../../src/llm/index.js';
import type { SttEngine, TtsEngine } from '../../../src/platform/index.js';

import {
    createBestStt,
    detectSttBackend,
    invalidateSttBackendCache,
} from '../adapters/stt-picker.js';
import { createTtsForVoice } from '../adapters/tts-picker.js';
import { type SessionSetup, dirStepToBackend } from '../settings.js';
import { sessionStore } from '../state.js';
import { wireEmberControls } from '../embers.js';

const ANTHROPIC_PROXY_URL = '/api/llm/anthropic/messages';
const OLLAMA_PROXY_URL = '/ollama';

function buildProvider(setup: SessionSetup): LLMProvider {
    if (setup.provider === 'anthropic') {
        return new AnthropicProvider({
            baseUrl: ANTHROPIC_PROXY_URL,
            ...(setup.model && { model: setup.model }),
        });
    }
    return new OllamaProvider({
        baseUrl: OLLAMA_PROXY_URL,
        ...(setup.model && { model: setup.model }),
    });
}

export interface SessionViewHandle {
    /** Tear down the running session and release resources. */
    teardown(): void;
}

export async function mountSessionView(
    root: HTMLElement,
    setup: SessionSetup,
    onEnd: () => void
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

    const provider = buildProvider(setup);
    const { engine: tts } = await createTtsForVoice(setup.voice);
    // Re-probe each time the user starts a session: Flask may have come up
    // (or gone down) since the last detection.
    invalidateSttBackendCache();
    const stt: SttEngine | null = await createBestStt();
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
        setStatus(`Mic unavailable — type to begin. ${hint}`);
    } else {
        micBtn.disabled = false;
        const label =
            sttBackend === 'capacitor'
                ? 'native STT'
                : sttBackend === 'web-speech'
                  ? 'Web Speech'
                  : 'server Whisper';
        setStatus(`Ready (${label}). Press mic or type to begin`);
    }

    // Show the intention as a faint first line of context, if set.
    if (setup.intention.trim()) {
        const el = document.createElement('div');
        el.className = 'message intention';
        el.textContent = `intention: ${setup.intention}`;
        transcript.appendChild(el);
    }

    let busy = false;
    let listening = false;
    let silenceMode = false;
    let currentPartial: HTMLElement | null = null;

    async function respondTo(userText: string): Promise<void> {
        if (busy) return;
        busy = true;
        try {
            if (silenceMode) {
                silenceMode = false;
                setOrbHolding(false);
            }
            appendMessage('user', userText);
            session.addUserMessage(userText);
            setStatus('Thinking…');

            const systemPrompt = builder.buildSystemPrompt();
            const result = await provider.complete(session.getContextMessages(), {
                system: systemPrompt,
            });
            const { signal, cleanText } = parseHoldSignal(result.text);
            session.addAssistantMessage(cleanText);
            appendMessage('assistant', cleanText);

            setStatus('Speaking…');
            try {
                await tts.speak(cleanText, { rate: setup.ttsRate });
            } catch {
                /* non-fatal */
            }
            if (signal === 'hold') {
                silenceMode = true;
                setStatus('Holding space — anything you say resumes');
                setOrbHolding(true);
            } else {
                setStatus(stt ? 'Ready — mic or type' : 'Ready — type to continue');
            }
        } catch (err) {
            setStatus(`Error: ${(err as Error).message}`);
        } finally {
            busy = false;
        }
    }

    async function runMicTurn(): Promise<void> {
        if (!stt || listening) return;
        listening = true;
        micBtn.classList.add('listening');
        micBtn.textContent = 'Listening…';
        setStatus('Listening…');

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
        } finally {
            listening = false;
            micBtn.classList.remove('listening');
            micBtn.textContent = 'Start listening';
            if (currentPartial) {
                currentPartial.remove();
                currentPartial = null;
            }
        }

        if (finalText.trim()) {
            await respondTo(finalText.trim());
        } else if (micError) {
            setStatus(micError);
        } else {
            setStatus('Didn’t catch that — try again, or speak a little louder');
        }
    }

    micBtn.addEventListener('click', () => {
        if (listening) void stt?.stop();
        else void runMicTurn();
    });

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

    wireEmberControls(root);

    let torn = false;
    async function endSession(): Promise<void> {
        if (torn) return;
        torn = true;
        const finalState = session.endSession();
        void stt?.stop();
        void tts.cancel();

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
