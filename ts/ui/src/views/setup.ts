/**
 * Setup view — pre-session configuration.
 *
 * Mirrors the existing index.html setup form's Exploration tab: intention,
 * preset cards, focus checkboxes, vibe checkboxes, guidance slider,
 * response length, additional instructions, provider, "Begin Session"
 * button. Noting mode is deferred to a later port.
 */

import type { Focus, Quality, Verbosity } from '../../../src/facilitation/index.js';

import {
    type SessionSetup,
    type Provider,
    ALL_PROVIDERS,
    DIRECTIVENESS_VALUES,
    loadSetup,
    saveSetup,
} from '../settings.js';
import type { SessionState } from '../../../src/facilitation/session.js';
import { PRESETS, findPreset } from '../presets.js';
import {
    buildScoredVoiceList,
    fetchServerVoices,
    previewVoice as runPreview,
    renderVoiceList,
    renderVoiceModalHTML,
    stopPreview,
    updateVoiceSelection,
    type ScoredVoice,
    type ServerVoice,
} from '../voice-picker.js';
import { mountModelPicker } from '../model-picker.js';
import { sessionStore } from '../state.js';
import { detectIsDesktop, isDesktopSync } from '../is-desktop.js';

const FOCUSES: ReadonlyArray<{ value: Focus; name: string; description: string }> = [
    {
        value: 'body_sensations',
        name: 'Body & sensations',
        description: 'Physical experience — texture, temperature, movement',
    },
    {
        value: 'emotions',
        name: 'Emotions & feeling tone',
        description: 'Emotional landscape, warmth, what’s alive underneath',
    },
    {
        value: 'inner_parts',
        name: 'Parts & inner world',
        description: 'Inner parts, protectors, body parts, speaking to/as parts',
    },
];

const QUALITIES: ReadonlyArray<{ value: Quality; name: string; description: string }> = [
    {
        value: 'playful',
        name: 'Playful & light',
        description: 'Play, spontaneity, delight. Doesn’t have to be serious',
    },
    {
        value: 'compassionate',
        name: 'Compassionate',
        description: 'Meeting what arises with care, tenderness, gentleness',
    },
    {
        value: 'loving',
        name: 'Loving & kind',
        description: 'Generating and radiating love and goodwill',
    },
    {
        value: 'spacious',
        name: 'Spacious',
        description: 'Notice the openness that’s already here',
    },
    {
        value: 'effortless',
        name: 'Effortless',
        description: 'Hands off the wheel, let things unfold',
    },
    {
        value: 'feeling_good',
        name: 'Feeling good',
        description: 'Noticing and cultivating pleasant sensations',
    },
];

const VERBOSITY_OPTIONS: ReadonlyArray<{ value: Verbosity; label: string }> = [
    { value: 'low', label: 'Brief' },
    { value: 'medium', label: 'Medium' },
    { value: 'high', label: 'Longer' },
];

export interface SetupViewHandle {
    /** Show the setup view (replaces any current content in `root`). */
    show(): Promise<void>;
    /** Hide the setup view (caller handles what to show next). */
    hide(): void;
    /** Current setup snapshot. */
    getSetup(): SessionSetup;
}

export async function mountSetupView(
    root: HTMLElement,
    onBegin: (setup: SessionSetup, continueFrom: SessionState | null) => void
): Promise<SetupViewHandle> {
    const setup = await loadSetup();
    // Resolve desktop-vs-mobile before the first render so claude_proxy
    // and the env-var hints show up immediately.
    await detectIsDesktop();
    // Scored voice list for the modal. Lazy-loaded; the setup form is
    // interactive while voices fetch in the background.
    let scoredVoices: ScoredVoice[] = [];

    // Pull a queued continuation off sessionStorage. Mirrors the Python
    // app — history view writes 'continueFrom' there and redirects to /,
    // setup view picks it up and threads it into onBegin. Returns null
    // when nothing is queued or the referenced session is gone.
    async function loadQueuedContinuation(): Promise<SessionState | null> {
        if (typeof sessionStorage === 'undefined') return null;
        const id = sessionStorage.getItem('continueFrom');
        if (!id) return null;
        const state = await sessionStore.load(id);
        // One-shot — clear so a reload doesn't keep auto-continuing.
        sessionStorage.removeItem('continueFrom');
        sessionStorage.removeItem('continueFromSummary');
        if (!state) return null;
        return state;
    }

    function persist(): void {
        void saveSetup(setup);
    }

    /**
     * Pull voices from `/api/voices` (when Flask is reachable) and from
     * the browser's speechSynthesis API, score them, and store on
     * scoredVoices. Includes browser voices since the TS preview can
     * also drive browser TTS — when the session view runs server TTS
     * exclusively the picker still shows the right set since server
     * voices win for any overlapping name.
     */
    async function loadVoiceCatalog(): Promise<void> {
        // speechSynthesis voice list often loads async on first call;
        // give it a tick before snapshotting.
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
        const server: readonly ServerVoice[] | null = await fetchServerVoices();
        scoredVoices = buildScoredVoiceList(server, true);
        updateVoiceButtonLabel();
    }

    function findVoice(name: string | null): ScoredVoice | null {
        if (!name) return null;
        return scoredVoices.find((v) => v.name === name) ?? null;
    }

    function updateVoiceButtonLabel(): void {
        const btn = root.querySelector<HTMLButtonElement>('#setup-voice-btn');
        if (!btn) return;
        const selectedName = stripVoicePrefix(setup.voice);
        const entry = findVoice(selectedName);
        if (entry) {
            btn.textContent = `${entry.name} · ${setup.ttsRate} wpm`;
        } else if (selectedName) {
            // Voice id is stored but we haven't loaded its details yet.
            btn.textContent = `${selectedName} · ${setup.ttsRate} wpm`;
        } else {
            btn.textContent = scoredVoices.length > 0 ? 'Default' : 'Voice';
        }
    }

    /**
     * Open the voice modal — renders the scored list, wires up row
     * clicks (select), preview clicks, the speed slider, and the close
     * button. Re-running render() blows the modal away with the rest of
     * the form, so the wiring lives inline here instead of in render().
     */
    function openVoiceModal(): void {
        const modal = root.querySelector<HTMLElement>('#setup-voice-modal');
        const listEl = root.querySelector<HTMLElement>('#setup-voice-modal-list');
        const closeBtn = root.querySelector<HTMLButtonElement>('#setup-voice-modal-close');
        const speedSlider = root.querySelector<HTMLInputElement>('#setup-speed-slider');
        const speedLabel = root.querySelector<HTMLElement>('#setup-speed-label');
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
            if (target.closest('.voice-row-preview')) {
                if (row.classList.contains('voice-row-locked')) return;
                const entry = findVoice(name);
                void runPreview(name, setup.ttsRate, entry?.engine);
                return;
            }
            if (row.classList.contains('voice-row-locked')) return;
            // Select the voice. Persist with engine prefix so the
            // session view's createTtsForVoice picks the right backend.
            const entry = findVoice(name);
            const idPrefix = entry?.engine === 'browser' ? 'browser:' : 'server:';
            setup.voice = `${idPrefix}${name}`;
            persist();
            updateVoiceSelection(listEl, name);
            updateVoiceButtonLabel();
        };
        const onSpeedInput = () => {
            const rate = Number(speedSlider.value);
            setup.ttsRate = rate;
            speedLabel.textContent = `${rate} wpm`;
            persist();
            updateVoiceButtonLabel();
        };
        const closeModal = () => {
            modal.classList.add('hidden');
            stopPreview();
            listEl.removeEventListener('click', onListClick);
            speedSlider.removeEventListener('input', onSpeedInput);
            closeBtn.removeEventListener('click', closeModal);
            modal.removeEventListener('click', onBackdrop);
        };
        const onBackdrop = (e: MouseEvent) => {
            // Click on the overlay (but not the inner panel) closes.
            if (e.target === modal) closeModal();
        };

        listEl.addEventListener('click', onListClick);
        speedSlider.addEventListener('input', onSpeedInput);
        closeBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', onBackdrop);
    }

    function render(): void {
        root.innerHTML = renderSetupHTML();

        // Intention
        const intentionEl = root.querySelector<HTMLTextAreaElement>('#intention')!;
        intentionEl.value = setup.intention;
        intentionEl.addEventListener('input', () => {
            setup.intention = intentionEl.value;
            persist();
        });

        // Presets
        root.querySelectorAll<HTMLElement>('.style-card').forEach((card) => {
            const id = card.dataset['preset']!;
            const isSelected = id === setup.preset;
            card.classList.toggle('selected', isSelected);
            const radio = card.querySelector<HTMLInputElement>('input[type="radio"]');
            if (radio) radio.checked = isSelected;
            card.addEventListener('click', () => {
                const preset = findPreset(id);
                if (!preset) return;
                setup.preset = preset.id;
                setup.focuses = [...preset.focuses];
                setup.qualities = [...preset.qualities];
                setup.dirStep = preset.dirStep;
                persist();
                render();
            });
        });

        // Focus checkboxes
        root.querySelectorAll<HTMLInputElement>('input[name="focus"]').forEach((cb) => {
            cb.checked = setup.focuses.includes(cb.value as Focus);
            cb.addEventListener('change', () => {
                const value = cb.value as Focus;
                setup.focuses = cb.checked
                    ? [...setup.focuses, value]
                    : setup.focuses.filter((f) => f !== value);
                setup.preset = null; // manual change leaves preset state
                persist();
                updatePresetHighlights();
                cb.closest('.modifier-toggle')!.classList.toggle('selected', cb.checked);
            });
        });

        // Quality checkboxes
        root.querySelectorAll<HTMLInputElement>('input[name="quality"]').forEach((cb) => {
            cb.checked = setup.qualities.includes(cb.value as Quality);
            cb.addEventListener('change', () => {
                const value = cb.value as Quality;
                setup.qualities = cb.checked
                    ? [...setup.qualities, value]
                    : setup.qualities.filter((q) => q !== value);
                setup.preset = null;
                persist();
                updatePresetHighlights();
                cb.closest('.modifier-toggle')!.classList.toggle('selected', cb.checked);
            });
        });

        // Directiveness
        const dirSlider = root.querySelector<HTMLInputElement>('#directiveness')!;
        dirSlider.value = String(setup.dirStep);
        dirSlider.addEventListener('input', () => {
            setup.dirStep = Number(dirSlider.value);
            setup.preset = null;
            persist();
            updatePresetHighlights();
        });

        // Verbosity
        const verbositySel = root.querySelector<HTMLSelectElement>('#verbosity')!;
        verbositySel.value = setup.verbosity;
        verbositySel.addEventListener('change', () => {
            setup.verbosity = verbositySel.value as Verbosity;
            persist();
        });

        // Custom instructions
        const customEl = root.querySelector<HTMLTextAreaElement>('#custom-instructions')!;
        customEl.value = setup.customInstructions;
        customEl.addEventListener('input', () => {
            setup.customInstructions = customEl.value;
            persist();
        });

        // Provider
        const providerSel = root.querySelector<HTMLSelectElement>('#provider')!;
        providerSel.value = setup.provider;
        providerSel.addEventListener('change', () => {
            setup.provider = providerSel.value as Provider;
            persist();
            void modelPicker.refresh(setup.provider);
            updateProviderHint();
        });
        // Model picker — fetches /api/models/<provider> (Flask-backed),
        // falls back to a free-form text input when the endpoint isn't
        // available. Same behavior as Python's setup.js dropdown.
        const modelContainer = root.querySelector<HTMLElement>('#model-picker-slot')!;
        const modelPicker = mountModelPicker(
            modelContainer,
            setup.provider,
            setup.model,
            (value) => {
                setup.model = value;
                persist();
            }
        );

        // Provider availability — fetch /api/providers, annotate the
        // provider <option>s with ✱ (installed but not running) or
        // ✘ (not installed/configured), and surface a hint below for
        // the active provider. API key entry itself lives in Settings,
        // not here. Mirrors Python's setup.js applyProviderAvailability
        // + updateProviderHint.
        void refreshProviderAvailability();

        // Voice — single button opens the picker modal which also has
        // the speed slider. Matches Python's index.html setup-voice-btn.
        const voiceBtn = root.querySelector<HTMLButtonElement>('#setup-voice-btn')!;
        updateVoiceButtonLabel();
        voiceBtn.addEventListener('click', () => openVoiceModal());

        // Begin session — uses any queued continuation from sessionStorage
        // (set by the history view's "Continue" button) so the same Begin
        // path handles both fresh and continued sessions, matching the
        // Python setup.js behavior.
        const beginBtn = root.querySelector<HTMLButtonElement>('#begin-btn')!;
        beginBtn.addEventListener('click', () => {
            void (async () => {
                const queued = await loadQueuedContinuation();
                onBegin(setup, queued);
            })();
        });

        // Continuation banner — shown when the history view has queued a
        // session for continuation. Matches Python's #continue-banner.
        void (async () => {
            if (typeof sessionStorage === 'undefined') return;
            const id = sessionStorage.getItem('continueFrom');
            if (!id) return;
            const state = await sessionStore.load(id);
            if (!state) return;
            const banner = root.querySelector<HTMLElement>('#continue-banner');
            const text = root.querySelector<HTMLElement>('#continue-banner-text');
            const cancel = root.querySelector<HTMLButtonElement>('#continue-cancel');
            if (!banner || !text || !cancel) return;
            const summary =
                sessionStorage.getItem('continueFromSummary') ||
                new Date(state.startTime * 1000).toLocaleString();
            text.textContent = `Continuing from: ${summary}`;
            // Use the .hidden class (matches Python — sets display:none
            // !important via the lifted CSS). Toggling the HTML hidden
            // attribute loses to .continue-banner's `display: flex`.
            banner.classList.remove('hidden');
            cancel.addEventListener('click', () => {
                sessionStorage.removeItem('continueFrom');
                sessionStorage.removeItem('continueFromSummary');
                banner.classList.add('hidden');
            });
        })();
    }

    // Provider status from /api/providers — same shape Python uses.
    interface ProviderInfo {
        available: boolean;
        installed?: boolean;
        hint?: string;
    }
    let providerStatus: Record<string, ProviderInfo> | null = null;

    async function refreshProviderAvailability(): Promise<void> {
        try {
            const resp = await fetch('/api/providers');
            if (!resp.ok) return;
            providerStatus = (await resp.json()) as Record<string, ProviderInfo>;
        } catch {
            // Flask not reachable — leave indicators clean. The session
            // view will surface a real error if the provider call fails
            // later.
            return;
        }
        applyProviderIndicators();
        updateProviderHint();
    }

    /**
     * Annotate provider <option>s with ✱ / ✘. Matches Python's
     * setup.js applyProviderAvailability — ✱ means installed but not
     * running (Ollama not started), ✘ means not configured at all (no
     * API key, no install). Available providers get no marker.
     */
    function applyProviderIndicators(): void {
        const providerSel = root.querySelector<HTMLSelectElement>('#provider');
        if (!providerSel || !providerStatus) return;
        for (const opt of Array.from(providerSel.options)) {
            const info = providerStatus[opt.value];
            opt.textContent = (opt.textContent ?? '').replace(/ [✘✱]$/, '');
            opt.classList.remove('provider-unavailable');
            if (info && !info.available) {
                if (info.installed) {
                    opt.textContent += ' ✱';
                } else {
                    opt.classList.add('provider-unavailable');
                    opt.textContent += ' ✘';
                }
            }
        }
    }

    function updateProviderHint(): void {
        const hintEl = root.querySelector<HTMLElement>('#provider-hint');
        if (!hintEl) return;
        const info = providerStatus?.[setup.provider];
        if (info && !info.available && info.hint) {
            hintEl.innerHTML = info.hint;
            hintEl.classList.remove('hidden');
        } else {
            hintEl.classList.add('hidden');
        }
    }

    function updatePresetHighlights(): void {
        root.querySelectorAll<HTMLElement>('.style-card').forEach((card) => {
            card.classList.toggle('selected', card.dataset['preset'] === setup.preset);
        });
    }

    render();
    // Load voices asynchronously so the rest of the form is interactive
    // immediately; server-side voices fetch in the background and the
    // dropdown populates when ready.
    void loadVoiceCatalog();

    return {
        async show() { render(); await loadVoiceCatalog(); },
        hide() { root.innerHTML = ''; },
        getSetup() { return setup; },
    };
}

function escapeAttr(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
    );
}

/** SessionSetup.voice carries a 'server:' or 'browser:' prefix; the voice
 *  picker works with raw names. Strip the prefix on the way in. */
function stripVoicePrefix(voice: string | null): string | null {
    if (!voice) return null;
    const m = /^(server|browser):(.*)$/.exec(voice);
    return m ? (m[2] ?? null) : voice;
}

function renderSetupHTML(): string {
    const escapeHtml = escapeAttr;

    // Mirror Python's index.html: presets are radio inputs wrapped in
    // labels styled as cards. The radio is visually hidden by the CSS
    // (.style-card input { display: none }), and the .selected class
    // on the label drives the active border.
    const presetCards = PRESETS.map(
        (p) => `
        <label class="style-card" data-preset="${p.id}">
            <input type="radio" name="preset" value="${p.id}">
            <div class="style-card-inner">
                <span class="style-name">${escapeHtml(p.name)}</span>
                <span class="style-desc">${escapeHtml(p.description)}</span>
            </div>
        </label>`
    ).join('');

    const focusToggles = FOCUSES.map(
        (f) => `
        <label class="modifier-toggle">
            <input type="checkbox" name="focus" value="${f.value}">
            <div class="modifier-info">
                <span class="modifier-name">${escapeHtml(f.name)}</span>
                <span class="modifier-desc">${escapeHtml(f.description)}</span>
            </div>
        </label>`
    ).join('');

    const qualityToggles = QUALITIES.map(
        (q) => `
        <label class="modifier-toggle">
            <input type="checkbox" name="quality" value="${q.value}">
            <div class="modifier-info">
                <span class="modifier-name">${escapeHtml(q.name)}</span>
                <span class="modifier-desc">${escapeHtml(q.description)}</span>
            </div>
        </label>`
    ).join('');

    const dirTickCount = DIRECTIVENESS_VALUES.length - 1;
    const verbosityOptions = VERBOSITY_OPTIONS.map(
        (v) => `<option value="${v.value}">${escapeHtml(v.label)}</option>`
    ).join('');

    return `
    <div id="continue-banner" class="continue-banner hidden">
        <span id="continue-banner-text">Continuing from a previous session</span>
        <button type="button" class="continue-banner-close" id="continue-cancel" aria-label="Cancel continuation">&times;</button>
    </div>

    <form id="setup-form" class="setup-form setup-container">
        <div class="form-group">
            <label for="intention">Intention <span class="optional">(optional)</span></label>
            <textarea id="intention" rows="2"
                placeholder="e.g. play with energetic flow, just be present with sensations, drop the need to control"></textarea>
        </div>

        <div class="form-group">
            <label>Suggested Presets</label>
            <div class="style-cards">${presetCards}</div>
        </div>

        <div class="form-group">
            <label>Attention Focus</label>
            <div class="modifier-toggles">${focusToggles}</div>
        </div>

        <div class="form-group">
            <label>Vibe</label>
            <div class="modifier-toggles">${qualityToggles}</div>
        </div>

        <div class="form-row form-row-thirds">
            <div class="form-group">
                <label for="directiveness">Guidance Level</label>
                <input type="range" id="directiveness" min="0" max="${dirTickCount}" step="1" value="1">
                <div class="range-labels">
                    <span>Following</span>
                    <span>Directing</span>
                </div>
            </div>
            <div class="form-group">
                <label for="verbosity">Response Length</label>
                <select id="verbosity">${verbosityOptions}</select>
            </div>
            <div class="form-group">
                <label>Voice</label>
                <button type="button" id="setup-voice-btn" class="setup-voice-btn">Default</button>
            </div>
        </div>

        <details class="advanced-settings">
            <summary>Additional instructions</summary>
            <div class="form-group">
                <textarea id="custom-instructions" rows="3"
                    placeholder="Any specific guidance for the facilitator…"></textarea>
            </div>
        </details>

        <div class="form-row">
            <div class="form-group">
                <label for="provider">Provider</label>
                <select id="provider">
                    ${ALL_PROVIDERS.filter((p) => isDesktopSync() || !p.desktopOnly)
                        .map(
                            (p) =>
                                `<option value="${p.value}">${escapeHtml(p.label)}</option>`
                        )
                        .join('')}
                </select>
            </div>
            <div class="form-group">
                <label for="model-select">Model</label>
                <div id="model-picker-slot"></div>
            </div>
        </div>

        <div id="provider-hint" class="provider-hint hidden"></div>

    </form>

    ${renderVoiceModalHTML({
        modalId: 'setup-voice-modal',
        closeId: 'setup-voice-modal-close',
        listId: 'setup-voice-modal-list',
        speedSliderId: 'setup-speed-slider',
        speedLabelId: 'setup-speed-label',
        speedValue: 110,
    })}

    <!-- setup-footer is a sibling of the form so position: fixed (from
         the lifted CSS) anchors it to the viewport bottom; the inner
         wrapper caps width to 640 px so the Begin button doesn't span
         the whole page on wide screens. Matches the original index.html. -->
    <div class="setup-footer">
        <div class="setup-footer-inner">
            <button id="begin-btn" type="button"
                class="btn btn-primary btn-begin">Begin Session</button>
        </div>
    </div>`;
}
