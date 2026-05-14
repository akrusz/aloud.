/**
 * Browser-side session orchestrator.
 *
 * Wires the TS orchestration core (PromptBuilder + SessionManager + an
 * LLM provider) to browser adapters (Web Speech, speechSynthesis,
 * localStorage). Mirrors the responsibilities of session.js in the
 * existing Flask-served UI, but talks directly to the LLM from the
 * browser — no Python in the path.
 *
 * This is a working preview, not the final UI. The point is to validate
 * the full TS loop end-to-end in a real browser before we wrap in
 * Capacitor or replace the Flask frontend.
 */

import {
    PromptBuilder,
    SessionManager,
    parseHoldSignal,
    type Focus,
} from '../../src/facilitation/index.js';
import {
    AnthropicProvider,
    OllamaProvider,
    type LLMProvider,
} from '../../src/llm/index.js';
import type { SttEngine, TtsEngine } from '../../src/platform/index.js';

import { WebSpeechSttEngine, isWebSpeechSupported } from './adapters/web-speech-stt.js';
import { BrowserTtsEngine } from './adapters/browser-tts.js';
import { LocalStorageKv } from './adapters/localstorage-kv.js';

const SETTINGS_KEY = 'preview:settings';
const kv = new LocalStorageKv();

interface Settings {
    provider: 'ollama' | 'anthropic';
    model: string;
    directiveness: number;
    focuses: Focus[];
}

const defaultSettings: Settings = {
    provider: 'ollama',
    model: '',
    directiveness: 3,
    focuses: ['open_awareness'],
};

// Browser endpoints — both routed through Vite's dev proxy (or Flask in
// production), so the browser sees same-origin requests.
const ANTHROPIC_PROXY_URL = '/api/llm/anthropic/messages';
const OLLAMA_PROXY_URL = '/ollama';

async function loadSettings(): Promise<Settings> {
    const raw = await kv.get(SETTINGS_KEY);
    if (!raw) return defaultSettings;
    try {
        return { ...defaultSettings, ...(JSON.parse(raw) as Partial<Settings>) };
    } catch {
        return defaultSettings;
    }
}

async function saveSettings(settings: Settings): Promise<void> {
    await kv.set(SETTINGS_KEY, JSON.stringify(settings));
}

function $<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element: ${id}`);
    return el as T;
}

function setStatus(text: string): void {
    $('status').textContent = text;
}

function appendMessage(role: 'user' | 'assistant', text: string, partial = false): HTMLElement {
    const el = document.createElement('div');
    el.className = `message ${role}${partial ? ' partial' : ''}`;
    el.textContent = text;
    const transcript = $('transcript');
    transcript.appendChild(el);
    transcript.scrollTop = transcript.scrollHeight;
    return el;
}

function buildProvider(settings: Settings): LLMProvider {
    if (settings.provider === 'anthropic') {
        // No apiKey here — the Flask proxy at ANTHROPIC_PROXY_URL injects it
        // from the server-side ANTHROPIC_API_KEY env var, so it never lives
        // in the browser.
        return new AnthropicProvider({
            baseUrl: ANTHROPIC_PROXY_URL,
            ...(settings.model && { model: settings.model }),
        });
    }
    return new OllamaProvider({
        baseUrl: OLLAMA_PROXY_URL,
        ...(settings.model && { model: settings.model }),
    });
}

export async function bootApp(): Promise<void> {
    const settings = await loadSettings();
    hydrateSettingsUI(settings);
    wireSettingsUI(settings);

    const session = new SessionManager({ contextStrategy: 'full' });
    const builder = new PromptBuilder({
        config: {
            focuses: settings.focuses,
            directiveness: settings.directiveness,
        },
    });
    session.startSession();

    const tts: TtsEngine = new BrowserTtsEngine();
    const sttSupported = isWebSpeechSupported();
    const stt: SttEngine | null = sttSupported ? new WebSpeechSttEngine() : null;

    const micBtn = $<HTMLButtonElement>('mic');
    const textInput = $<HTMLInputElement>('text-input');
    const textForm = $<HTMLFormElement>('text-form');
    const endBtn = $<HTMLButtonElement>('end');

    if (!sttSupported) {
        micBtn.disabled = true;
        micBtn.title = 'Web Speech API not supported in this browser';
        setStatus('Mic unavailable in this browser — type to begin');
    } else {
        micBtn.disabled = false;
        setStatus('Press mic or type to begin');
    }

    let provider: LLMProvider;
    try {
        provider = buildProvider(settings);
    } catch (err) {
        setStatus((err as Error).message);
        return;
    }

    let listening = false;
    let busy = false;
    let silenceMode = false;
    let currentPartial: HTMLElement | null = null;

    async function respondTo(userText: string): Promise<void> {
        if (busy) return;
        busy = true;
        try {
            // Any speech exits silence mode locally; the LLM may put us back in.
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
                /* TTS errors are non-fatal */
            }
            if (signal === 'hold') {
                silenceMode = true;
                setStatus('Holding space — say or type anything to resume');
            } else {
                setStatus(stt ? 'Ready — press mic or type' : 'Ready — type to continue');
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
        if (listening) {
            void stt?.stop();
        } else {
            void runMicTurn();
        }
    });

    textForm.addEventListener('submit', (e) => {
        e.preventDefault();
        const text = textInput.value.trim();
        if (!text) return;
        textInput.value = '';
        void respondTo(text);
    });

    endBtn.addEventListener('click', () => {
        session.endSession();
        void stt?.stop();
        void tts.cancel();
        setStatus('Session ended.');
        micBtn.disabled = true;
        textInput.disabled = true;
    });
}

function hydrateSettingsUI(settings: Settings): void {
    ($('provider') as HTMLSelectElement).value = settings.provider;
    ($('model') as HTMLInputElement).value = settings.model;
    const dir = $('directiveness') as HTMLInputElement;
    dir.value = String(settings.directiveness);
    $('directiveness-value').textContent = String(settings.directiveness);
    const focusEl = $('focuses') as HTMLSelectElement;
    for (const option of Array.from(focusEl.options)) {
        option.selected = settings.focuses.includes(option.value as Focus);
    }
}

function wireSettingsUI(settings: Settings): void {
    const persist = (): void => {
        void saveSettings(settings);
    };
    ($('provider') as HTMLSelectElement).addEventListener('change', (e) => {
        settings.provider = (e.target as HTMLSelectElement).value as Settings['provider'];
        persist();
    });
    ($('model') as HTMLInputElement).addEventListener('change', (e) => {
        settings.model = (e.target as HTMLInputElement).value.trim();
        persist();
    });
    ($('directiveness') as HTMLInputElement).addEventListener('input', (e) => {
        settings.directiveness = Number((e.target as HTMLInputElement).value);
        $('directiveness-value').textContent = String(settings.directiveness);
        persist();
    });
    ($('focuses') as HTMLSelectElement).addEventListener('change', (e) => {
        const sel = e.target as HTMLSelectElement;
        settings.focuses = Array.from(sel.selectedOptions).map((o) => o.value as Focus);
        persist();
    });
}
