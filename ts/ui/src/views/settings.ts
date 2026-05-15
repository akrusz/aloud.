/**
 * Settings view — desktop-shell parity with src/web/templates/settings.html.
 *
 * Sections (matching Python's order):
 *   1. LLM Provider     — default provider, model, per-provider API keys
 *   2. Language & STT   — language, Whisper model size (stub)
 *   3. Text-to-Speech   — engine selector, voice picker, ElevenLabs key
 *   4. Display          — text scale, theme mode, window/frameless (stubs)
 *   5. Pacing           — silence base/max, response delay, check-in, hold
 *   6. Network          — host (stub)
 *   7. Updates          — version + check (stub)
 *
 * "Stub" rows render the same layout as Python but their controls
 * either no-op or display a small "desktop only" hint. The user's call:
 * "if there are settings page elements that we can't hook up yet
 *  because of what needs to be decided still that's fine. But we could
 *  at least have the page there with most of the elements functional."
 *
 * The chrome-level settings (theme, text scale) and the pacing knobs
 * are live and persist. Provider/key entry persists into the same
 * api-keys backend the setup view uses, so settings → setup flow works
 * end-to-end.
 */

import {
    type AppSettings,
    type ThemeMode,
    type TtsEngineChoice,
    DEFAULT_APP_SETTINGS,
    applyChromeSettings,
    loadAppSettings,
    saveAppSettings,
} from '../app-settings.js';
import { ALL_PROVIDERS, providerNeedsKey, type Provider } from '../settings.js';
import { getApiKey, hasApiKey, setApiKey } from '../api-keys.js';
import {
    buildScoredVoiceList,
    fetchServerVoices,
    previewVoice as runPreview,
    renderVoiceList,
    renderVoiceModalHTML,
    stopPreview,
    updateVoiceSelection,
    type ScoredVoice,
} from '../voice-picker.js';

export interface SettingsViewHandle {
    show(): Promise<void>;
}

export async function mountSettingsView(root: HTMLElement): Promise<SettingsViewHandle> {
    const settings = await loadAppSettings();
    let scoredVoices: ScoredVoice[] = [];

    function persist(): void {
        void saveAppSettings(settings);
    }

    async function refresh(): Promise<void> {
        root.innerHTML = renderHTML(settings);
        wire();
        await loadVoiceCatalog();
        await refreshApiKeyRows();
    }

    function wire(): void {
        wireProviderSection();
        wireLanguageSection();
        wireTtsSection();
        wireDisplaySection();
        wirePacingSection();
        wireNetworkSection();
        wireUpdatesSection();
        wireFooter();
    }

    // ---- Provider section ----------------------------------------------

    function wireProviderSection(): void {
        const providerSel = root.querySelector<HTMLSelectElement>('#s-provider')!;
        providerSel.value = settings.defaultProvider;
        providerSel.addEventListener('change', () => {
            settings.defaultProvider = providerSel.value as Provider;
            persist();
            void refreshApiKeyRows();
        });

        const modelInput = root.querySelector<HTMLInputElement>('#s-model')!;
        modelInput.value = settings.defaultModel;
        modelInput.addEventListener('change', () => {
            settings.defaultModel = modelInput.value.trim();
            persist();
        });

        // Per-provider API key inputs. The change handler writes to the
        // shared api-keys module (also used by the setup view).
        for (const p of ALL_PROVIDERS) {
            if (!p.needsKey) continue;
            const input = root.querySelector<HTMLInputElement>(`#s-key-${p.value}`);
            if (!input) continue;
            input.addEventListener('change', async () => {
                const raw = input.value.trim();
                if (raw) await setApiKey(p.value, raw);
                input.value = '';
                await refreshApiKeyRows();
            });
        }

        const infoBtn = root.querySelector<HTMLButtonElement>('#llm-info-btn');
        const infoPanel = root.querySelector<HTMLElement>('#llm-info-panel');
        infoBtn?.addEventListener('click', () => {
            infoPanel?.classList.toggle('hidden');
        });
    }

    async function refreshApiKeyRows(): Promise<void> {
        for (const p of ALL_PROVIDERS) {
            const row = root.querySelector<HTMLElement>(`#s-key-row-${p.value}`);
            if (!row) continue;
            // Always render the row even when not the active provider —
            // a user might want to enter keys for multiple providers up
            // front. Python hides inactive rows; we keep them visible
            // since the multi-provider workflow benefits from it.
            if (p.needsKey) {
                row.hidden = false;
                const status = row.querySelector<HTMLElement>('.api-key-status');
                const input = row.querySelector<HTMLInputElement>('input');
                const existing = await getApiKey(p.value);
                if (input) input.placeholder = existing ? `Saved — type to replace` : 'Paste your key';
                if (status) status.textContent = existing ? 'Saved' : '';
            } else {
                row.hidden = true;
            }
        }
        // Set the current provider's row to "active" styling.
        const active = settings.defaultProvider;
        for (const p of ALL_PROVIDERS) {
            const row = root.querySelector<HTMLElement>(`#s-key-row-${p.value}`);
            row?.classList.toggle('api-key-active', p.value === active);
        }
    }

    // ---- Language & STT ------------------------------------------------

    function wireLanguageSection(): void {
        const langSel = root.querySelector<HTMLSelectElement>('#s-language')!;
        langSel.value = settings.language;
        langSel.addEventListener('change', () => {
            settings.language = langSel.value;
            persist();
        });

        const whisperSel = root.querySelector<HTMLSelectElement>('#s-whisper-model')!;
        whisperSel.value = settings.whisperModel;
        whisperSel.addEventListener('change', () => {
            settings.whisperModel = whisperSel.value as AppSettings['whisperModel'];
            persist();
        });
    }

    // ---- TTS section ---------------------------------------------------

    function wireTtsSection(): void {
        const engineSel = root.querySelector<HTMLSelectElement>('#s-tts-engine')!;
        engineSel.value = settings.ttsEngine;
        engineSel.addEventListener('change', () => {
            settings.ttsEngine = engineSel.value as TtsEngineChoice;
            persist();
        });

        const voiceBtn = root.querySelector<HTMLButtonElement>('#s-voice-btn')!;
        updateVoiceButtonLabel(voiceBtn);
        voiceBtn.addEventListener('click', () => openVoiceModal(voiceBtn));

        const infoBtn = root.querySelector<HTMLButtonElement>('#tts-info-btn');
        const infoPanel = root.querySelector<HTMLElement>('#tts-info-panel');
        infoBtn?.addEventListener('click', () => {
            infoPanel?.classList.toggle('hidden');
        });
    }

    async function loadVoiceCatalog(): Promise<void> {
        if (
            typeof speechSynthesis !== 'undefined' &&
            speechSynthesis.getVoices().length === 0
        ) {
            await new Promise<void>((resolve) => {
                const done = () => {
                    speechSynthesis.removeEventListener('voiceschanged', done);
                    resolve();
                };
                speechSynthesis.addEventListener('voiceschanged', done);
                setTimeout(done, 600);
            });
        }
        const server = await fetchServerVoices();
        scoredVoices = buildScoredVoiceList(server, true);
        const btn = root.querySelector<HTMLButtonElement>('#s-voice-btn');
        if (btn) updateVoiceButtonLabel(btn);
    }

    function updateVoiceButtonLabel(btn: HTMLButtonElement): void {
        const name = stripVoicePrefix(settings.defaultVoice);
        if (name) btn.textContent = `${name} · ${settings.defaultTtsRate} wpm`;
        else btn.textContent = scoredVoices.length > 0 ? 'Choose voice' : 'Default';
    }

    function openVoiceModal(voiceBtn: HTMLButtonElement): void {
        const modal = root.querySelector<HTMLElement>('#settings-voice-modal');
        const listEl = root.querySelector<HTMLElement>('#settings-voice-modal-list');
        const closeBtn = root.querySelector<HTMLButtonElement>('#settings-voice-modal-close');
        const speedSlider = root.querySelector<HTMLInputElement>('#s-tts-rate');
        const speedLabel = root.querySelector<HTMLElement>('#s-tts-rate-label');
        if (!modal || !listEl || !closeBtn || !speedSlider || !speedLabel) return;

        const currentName = stripVoicePrefix(settings.defaultVoice);
        renderVoiceList(listEl, scoredVoices, currentName, { showEngine: true });
        speedSlider.value = String(settings.defaultTtsRate);
        speedLabel.textContent = `${settings.defaultTtsRate} wpm`;
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
                void runPreview(name, settings.defaultTtsRate, entry?.engine);
                return;
            }
            if (row.classList.contains('voice-row-locked')) return;
            const idPrefix = entry?.engine === 'browser' ? 'browser:' : 'server:';
            settings.defaultVoice = `${idPrefix}${name}`;
            persist();
            updateVoiceSelection(listEl, name);
            updateVoiceButtonLabel(voiceBtn);
        };
        const onSpeedInput = () => {
            const rate = Number(speedSlider.value);
            settings.defaultTtsRate = rate;
            speedLabel.textContent = `${rate} wpm`;
            persist();
            updateVoiceButtonLabel(voiceBtn);
        };
        const close = () => {
            modal.classList.add('hidden');
            stopPreview();
            listEl.removeEventListener('click', onListClick);
            speedSlider.removeEventListener('input', onSpeedInput);
            closeBtn.removeEventListener('click', close);
            modal.removeEventListener('click', backdrop);
        };
        const backdrop = (e: MouseEvent) => {
            if (e.target === modal) close();
        };
        listEl.addEventListener('click', onListClick);
        speedSlider.addEventListener('input', onSpeedInput);
        closeBtn.addEventListener('click', close);
        modal.addEventListener('click', backdrop);
    }

    // ---- Display -------------------------------------------------------

    function wireDisplaySection(): void {
        const textScale = root.querySelector<HTMLInputElement>('#s-text-scale')!;
        const textScaleLabel = root.querySelector<HTMLElement>('#s-text-scale-label')!;
        textScale.value = String(settings.textScale);
        textScaleLabel.textContent = `${Math.round(settings.textScale * 100)}%`;
        textScale.addEventListener('input', () => {
            settings.textScale = Number(textScale.value);
            textScaleLabel.textContent = `${Math.round(settings.textScale * 100)}%`;
            persist();
            applyChromeSettings(settings);
        });

        const themeSel = root.querySelector<HTMLSelectElement>('#s-theme-mode')!;
        themeSel.value = settings.themeMode;
        themeSel.addEventListener('change', () => {
            settings.themeMode = themeSel.value as ThemeMode;
            persist();
            applyChromeSettings(settings);
        });

        // Window mode / frameless are desktop-shell concerns. The
        // controls are present for parity but disabled until the shell
        // story lands (Tauri 2 or Electron). The hint below makes that
        // visible to the user.
        const windowMode = root.querySelector<HTMLSelectElement>('#s-window-mode');
        const frameless = root.querySelector<HTMLInputElement>('#s-frameless');
        if (windowMode) windowMode.disabled = true;
        if (frameless) frameless.disabled = true;
    }

    // ---- Pacing --------------------------------------------------------

    function wirePacingSection(): void {
        wireStepper('s-silence-base', settings.silenceBaseMs / 1000, (v) => {
            settings.silenceBaseMs = Math.round(v * 1000);
            persist();
        });
        wireStepper('s-silence-max', settings.silenceMaxMs / 1000, (v) => {
            settings.silenceMaxMs = Math.round(v * 1000);
            persist();
        });
        wireStepper('s-response-delay', settings.responseDelayMs / 1000, (v) => {
            settings.responseDelayMs = Math.round(v * 1000);
            persist();
        });
        wireStepper('s-silence-sec', settings.silenceCheckinSec, (v) => {
            settings.silenceCheckinSec = Math.round(v);
            persist();
        });

        const checkinsEnabled = root.querySelector<HTMLInputElement>('#s-silence-checkins-enabled');
        if (checkinsEnabled) {
            checkinsEnabled.checked = settings.silenceCheckinsEnabled;
            checkinsEnabled.addEventListener('change', () => {
                settings.silenceCheckinsEnabled = checkinsEnabled.checked;
                persist();
            });
        }
        const silenceModeEnabled = root.querySelector<HTMLInputElement>('#s-silence-mode-enabled');
        if (silenceModeEnabled) {
            silenceModeEnabled.checked = settings.silenceModeEnabled;
            silenceModeEnabled.addEventListener('change', () => {
                settings.silenceModeEnabled = silenceModeEnabled.checked;
                persist();
            });
        }
    }

    function wireStepper(
        id: string,
        initialValue: number,
        onChange: (v: number) => void
    ): void {
        const input = root.querySelector<HTMLInputElement>(`#${id}`);
        if (!input) return;
        input.value = String(initialValue);
        const wrapper = input.closest<HTMLElement>('.stepper');
        const dec = wrapper?.querySelector<HTMLButtonElement>('.stepper-dec');
        const inc = wrapper?.querySelector<HTMLButtonElement>('.stepper-inc');
        const step = Number(input.step) || 1;
        const min = input.min === '' ? -Infinity : Number(input.min);
        const max = input.max === '' ? Infinity : Number(input.max);
        const clamp = (v: number) => Math.max(min, Math.min(max, v));
        const emit = () => onChange(Number(input.value));
        input.addEventListener('change', emit);
        dec?.addEventListener('click', () => {
            input.value = String(clamp(Number(input.value) - step));
            emit();
        });
        inc?.addEventListener('click', () => {
            input.value = String(clamp(Number(input.value) + step));
            emit();
        });
    }

    // ---- Network -------------------------------------------------------

    function wireNetworkSection(): void {
        // Network host is a Flask-server concern; in the TS-on-mobile
        // world it doesn't apply. Render the control but disable + note.
        const host = root.querySelector<HTMLSelectElement>('#s-host');
        if (host) host.disabled = true;
    }

    // ---- Updates -------------------------------------------------------

    function wireUpdatesSection(): void {
        // The Python updater works against a desktop-app distribution
        // (git pull or DMG/AppImage download). Not yet applicable here.
        const btn = root.querySelector<HTMLButtonElement>('#s-check-update');
        if (btn) btn.disabled = true;
    }

    // ---- Footer --------------------------------------------------------

    function wireFooter(): void {
        // No global Save button — each field persists on change. The
        // footer still renders for visual parity, but the button is a
        // no-op + flash to confirm the user that changes are saved.
        const saveBtn = root.querySelector<HTMLButtonElement>('#s-save');
        const savedEl = root.querySelector<HTMLElement>('#settings-saved');
        saveBtn?.addEventListener('click', (e) => {
            e.preventDefault();
            persist();
            applyChromeSettings(settings);
            if (savedEl) {
                savedEl.classList.remove('hidden');
                setTimeout(() => savedEl.classList.add('hidden'), 1200);
            }
        });
    }

    await refresh();
    applyChromeSettings(settings);

    // Surface the BYOK-needs-key warning at the top of the page if a
    // BYOK provider is selected but no key is stored.
    void (async () => {
        const p = settings.defaultProvider;
        if (providerNeedsKey(p) && !(await hasApiKey(p))) {
            const status = root.querySelector<HTMLElement>('#s-provider-status');
            if (status) {
                status.textContent =
                    'Selected provider has no API key. Paste one above before starting a session.';
                status.classList.remove('hidden');
            }
        }
    })();

    return {
        async show() {
            await refresh();
        },
    };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderHTML(s: AppSettings): string {
    return `
    <div class="setup-container">
        <h1 class="settings-title">Settings</h1>

        <form id="settings-form" class="setup-form">
            ${renderProviderSection(s)}
            ${renderLanguageSection(s)}
            ${renderTtsSection(s)}
            ${renderDisplaySection(s)}
            ${renderPacingSection(s)}
            ${renderNetworkSection(s)}
            ${renderUpdatesSection(s)}
        </form>
    </div>

    <div class="settings-footer">
        <div class="settings-footer-inner">
            <button id="s-save" type="button" class="btn btn-primary btn-begin">
                Save<span class="settings-word">&nbsp;Settings</span>
            </button>
            <span class="settings-saved hidden" id="settings-saved">Saved</span>
            <div class="settings-footer-spacer"></div>
        </div>
    </div>

    ${renderVoiceModalHTML({
        modalId: 'settings-voice-modal',
        closeId: 'settings-voice-modal-close',
        listId: 'settings-voice-modal-list',
        title: 'Manage Voices',
        speedSliderId: 's-tts-rate',
        speedLabelId: 's-tts-rate-label',
        speedValue: s.defaultTtsRate,
    })}`;
}

function renderProviderSection(s: AppSettings): string {
    const providerOptions = ALL_PROVIDERS.map(
        (p) =>
            `<option value="${p.value}"${p.value === s.defaultProvider ? ' selected' : ''}>${escape(p.label)}</option>`
    ).join('');

    const keyRows = ALL_PROVIDERS.filter((p) => p.needsKey)
        .map(
            (p) => `
        <div class="form-group api-key-group" id="s-key-row-${p.value}" hidden>
            <label for="s-key-${p.value}">${escape(p.label)} API Key
                <span class="optional api-key-status"></span>
            </label>
            <input type="password" id="s-key-${p.value}" autocomplete="off"
                spellcheck="false" placeholder="Paste your key">
        </div>`
        )
        .join('');

    return `
    <section class="settings-section">
        <h2>LLM Provider <button type="button" class="info-btn" id="llm-info-btn" aria-label="LLM provider info">?</button></h2>
        <div class="info-panel hidden" id="llm-info-panel">
            <p><strong>What is an LLM?</strong> — A large language model is the AI that listens to what you say and generates thoughtful responses to guide your meditation.</p>
            <p><strong>Anthropic (Subscription)</strong> — Uses your existing Claude Pro/Max subscription via the locally-installed <code>claude</code> CLI. Desktop only.</p>
            <p><strong>Ollama (Local)</strong> — Free and private. Runs the AI entirely on your computer.</p>
            <p><strong>API Key providers</strong> — Pay-per-use cloud AI. Sign up with the provider, paste the key here.</p>
        </div>
        <p class="settings-desc">Choose how glooow connects to a language model.</p>

        <div class="form-row">
            <div class="form-group form-group-half">
                <label for="s-provider">Default Provider</label>
                <select id="s-provider" name="provider">${providerOptions}</select>
            </div>
            <div class="form-group form-group-half">
                <label for="s-model">Default Model</label>
                <input type="text" id="s-model" name="model" placeholder="(use provider default)">
            </div>
        </div>

        ${keyRows}

        <div id="s-provider-status" class="provider-hint hidden"></div>
    </section>`;
}

function renderLanguageSection(s: AppSettings): string {
    const LANGS: ReadonlyArray<[string, string]> = [
        ['en', 'English'],
        ['es', 'Español'],
        ['fr', 'Français'],
        ['de', 'Deutsch'],
        ['it', 'Italiano'],
        ['pt', 'Português'],
        ['ja', '日本語'],
        ['zh', '中文'],
        ['ko', '한국어'],
    ];
    const langOptions = LANGS.map(
        ([v, label]) =>
            `<option value="${v}"${v === s.language ? ' selected' : ''}>${escape(label)}</option>`
    ).join('');

    return `
    <section class="settings-section">
        <h2>Language &amp; Speech Recognition</h2>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label for="s-language">Language</label>
                <select id="s-language" name="language">${langOptions}</select>
                <span class="form-hint">Affects speech recognition and voice previews</span>
            </div>
            <div class="form-group form-group-half">
                <label for="s-whisper-model">Whisper Model</label>
                <select id="s-whisper-model" name="whisper_model">
                    <option value="tiny">Tiny (fastest)</option>
                    <option value="base">Base</option>
                    <option value="small">Small (recommended)</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large (most accurate)</option>
                </select>
                <span class="form-hint">Larger = more accurate but slower. Persists for next launch.</span>
            </div>
        </div>
    </section>`;
}

function renderTtsSection(s: AppSettings): string {
    const engines: ReadonlyArray<[TtsEngineChoice, string]> = [
        ['macos', "macOS (built-in 'say')"],
        ['piper', 'Piper (local neural TTS)'],
        ['browser', 'Browser (speechSynthesis)'],
        ['elevenlabs', 'ElevenLabs (API)'],
    ];
    const opts = engines
        .map(
            ([v, label]) =>
                `<option value="${v}"${v === s.ttsEngine ? ' selected' : ''}>${escape(label)}</option>`
        )
        .join('');
    return `
    <section class="settings-section">
        <h2>Text-to-Speech <button type="button" class="info-btn" id="tts-info-btn" aria-label="TTS engine info">?</button></h2>
        <div class="info-panel hidden" id="tts-info-panel">
            <p><strong>macOS</strong> — Built-in system voices. Zero latency, works offline.</p>
            <p><strong>Piper</strong> — Fast local neural TTS, ~60–100 MB per voice.</p>
            <p><strong>Browser</strong> — Uses your browser's speechSynthesis. No install needed.</p>
            <p><strong>ElevenLabs</strong> — Cloud TTS with the most natural voices. Requires an API key.</p>
        </div>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label for="s-tts-engine">TTS Engine</label>
                <select id="s-tts-engine" name="tts_engine">${opts}</select>
                <span class="form-hint">The TS preview picks the engine per voice automatically.</span>
            </div>
            <div class="form-group form-group-half">
                <label>Manage Voices</label>
                <button type="button" id="s-voice-btn" class="setup-voice-btn">Choose voice</button>
            </div>
        </div>
    </section>`;
}

function renderDisplaySection(s: AppSettings): string {
    const themes: ReadonlyArray<[ThemeMode, string]> = [
        ['auto', 'Auto (follow system)'],
        ['dark', 'Always dark'],
        ['light', 'Always light'],
    ];
    const themeOpts = themes
        .map(
            ([v, label]) =>
                `<option value="${v}"${v === s.themeMode ? ' selected' : ''}>${escape(label)}</option>`
        )
        .join('');
    return `
    <section class="settings-section">
        <h2>Display</h2>
        <div class="display-controls">
            <div class="form-group">
                <label>Text Size</label>
                <div class="text-scale-control">
                    <input type="range" id="s-text-scale" min="0.8" max="1.4" step="0.05" value="${s.textScale}">
                    <span class="text-scale-value" id="s-text-scale-label">${Math.round(s.textScale * 100)}%</span>
                </div>
            </div>
            <div class="form-group">
                <label for="s-theme-mode">Theme</label>
                <select id="s-theme-mode">${themeOpts}</select>
            </div>
            <div class="form-group">
                <label for="s-window-mode">Window Mode</label>
                <select id="s-window-mode" disabled>
                    <option value="remember">Remember last size</option>
                    <option value="fullscreen">Full screen</option>
                    <option value="maximized">Maximized</option>
                    <option value="small">Small</option>
                </select>
                <span class="form-hint">Available when the desktop shell ships.</span>
            </div>
            <label class="checkbox-label">
                <input type="checkbox" id="s-frameless" disabled>
                <span>Frameless window</span>
            </label>
        </div>
    </section>`;
}

function renderPacingSection(s: AppSettings): string {
    const stepper = (id: string, value: number, min: number, max: number, step: number) => `
        <div class="stepper">
            <button type="button" class="stepper-btn stepper-dec" data-target="${id}" aria-label="Decrease">−</button>
            <input type="number" id="${id}" class="stepper-value" min="${min}" max="${max}" step="${step}" value="${value}">
            <button type="button" class="stepper-btn stepper-inc" data-target="${id}" aria-label="Increase">+</button>
        </div>`;
    return `
    <section class="settings-section">
        <h2>Pacing</h2>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label>Pause Detection (s)</label>
                ${stepper('s-silence-base', s.silenceBaseMs / 1000, 1, 15, 0.5)}
                <span class="form-hint">Minimum pause before your speech is submitted</span>
            </div>
            <div class="form-group form-group-half">
                <label>Extended Pause (s)</label>
                ${stepper('s-silence-max', s.silenceMaxMs / 1000, 2, 20, 0.5)}
                <span class="form-hint">Maximum pause tolerance after longer speech</span>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group form-group-half">
                <label>Response Delay (s)</label>
                ${stepper('s-response-delay', s.responseDelayMs / 1000, 0.5, 10, 0.5)}
                <span class="form-hint">Wait after transcription before LLM responds</span>
            </div>
            <div class="form-group form-group-half" id="s-silence-sec-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-silence-checkins-enabled"${s.silenceCheckinsEnabled ? ' checked' : ''}>
                    <span>Check-in After Silence (s)</span>
                </label>
                ${stepper('s-silence-sec', s.silenceCheckinSec, 30, 3600, 30)}
                <span class="form-hint">Proactive check-ins after this much silence.</span>
            </div>
        </div>
        <div class="form-row">
            <div class="form-group">
                <label class="checkbox-label">
                    <input type="checkbox" id="s-silence-mode-enabled"${s.silenceModeEnabled ? ' checked' : ''}>
                    <span>Enable holding-space mode</span>
                </label>
                <span class="form-hint">If requested, the facilitator goes silent until you ask it back. Some smaller models are over-eager to enter this mode.</span>
            </div>
        </div>
    </section>`;
}

function renderNetworkSection(_s: AppSettings): string {
    return `
    <section class="settings-section">
        <h2>Network</h2>
        <div class="form-group">
            <label for="s-host">Network Access</label>
            <select id="s-host" style="max-width:280px" disabled>
                <option value="127.0.0.1">Local only</option>
                <option value="0.0.0.0">LAN access</option>
            </select>
            <span class="form-hint">Available when the desktop shell ships.</span>
        </div>
    </section>`;
}

function renderUpdatesSection(_s: AppSettings): string {
    return `
    <section class="settings-section">
        <h2>Updates</h2>
        <div class="form-group">
            <div class="settings-update-row">
                <span class="settings-update-status" id="s-update-status">TS preview build</span>
                <button type="button" class="btn btn-small btn-secondary" id="s-check-update" disabled>Check for Updates</button>
            </div>
            <span class="form-hint">Auto-update lands with the desktop shell (Tauri 2 or Electron).</span>
        </div>
    </section>`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripVoicePrefix(voice: string | null): string | null {
    if (!voice) return null;
    const m = /^(server|browser):(.*)$/.exec(voice);
    return m ? (m[2] ?? null) : voice;
}

function escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
    );
}

// Keep DEFAULT_APP_SETTINGS referenced so tree-shaking doesn't drop it
// from the bundle when the only consumer of app-settings.ts is this file.
void DEFAULT_APP_SETTINGS;
