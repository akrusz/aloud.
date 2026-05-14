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
} from '../../../src/facilitation/index.js';
import {
    AnthropicProvider,
    OllamaProvider,
    type LLMProvider,
} from '../../../src/llm/index.js';
import type { SttEngine, TtsEngine } from '../../../src/platform/index.js';

import { BrowserTtsEngine } from '../adapters/browser-tts.js';
import { createBestStt, detectSttBackend } from '../adapters/stt-picker.js';
import { type SessionSetup, dirStepToBackend } from '../settings.js';

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
    const tts: TtsEngine = new BrowserTtsEngine();
    const stt: SttEngine | null = await createBestStt();
    const sttBackend = await detectSttBackend();

    const transcript = root.querySelector<HTMLElement>('#transcript')!;
    const statusEl = root.querySelector<HTMLElement>('#status')!;
    const micBtn = root.querySelector<HTMLButtonElement>('#mic')!;
    const textInput = root.querySelector<HTMLInputElement>('#text-input')!;
    const textForm = root.querySelector<HTMLFormElement>('#text-form')!;
    const endBtn = root.querySelector<HTMLButtonElement>('#end')!;

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
        micBtn.title =
            'No mic backend available — start Flask (uv run python -m src.web) for server Whisper, or use Chrome/Edge for Web Speech.';
        setStatus('Mic unavailable — type to begin');
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
            if (silenceMode) silenceMode = false;
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
                await tts.speak(cleanText);
            } catch {
                /* non-fatal */
            }
            if (signal === 'hold') {
                silenceMode = true;
                setStatus('Holding space — anything you say resumes');
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
                    setStatus(`Mic error: ${String(event.error)}`);
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
        } else {
            setStatus('Didn’t catch that — try again');
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
        endSession();
    });

    let torn = false;
    function endSession(): void {
        if (torn) return;
        torn = true;
        session.endSession();
        void stt?.stop();
        void tts.cancel();
        onEnd();
    }

    return {
        teardown(): void { endSession(); },
    };
}

function renderSessionHTML(): string {
    return `
    <section class="status"><div id="status">Connecting…</div></section>

    <section class="transcript" id="transcript" aria-live="polite"></section>

    <section class="controls">
        <button id="mic" type="button" disabled>Start listening</button>
        <form id="text-form">
            <input id="text-input" type="text"
                placeholder="…or type here and press enter" autocomplete="off" />
        </form>
        <button id="end" type="button" class="btn-end">End session</button>
    </section>`;
}
