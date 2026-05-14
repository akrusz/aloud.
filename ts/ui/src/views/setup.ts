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
    DIRECTIVENESS_VALUES,
    loadSetup,
    saveSetup,
} from '../settings.js';
import { PRESETS, findPreset } from '../presets.js';

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
    onBegin: (setup: SessionSetup) => void
): Promise<SetupViewHandle> {
    const setup = await loadSetup();

    function persist(): void {
        void saveSetup(setup);
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
            card.classList.toggle('selected', id === setup.preset);
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
        });
        const modelInput = root.querySelector<HTMLInputElement>('#model')!;
        modelInput.value = setup.model;
        modelInput.addEventListener('change', () => {
            setup.model = modelInput.value.trim();
            persist();
        });

        // Begin session
        const beginBtn = root.querySelector<HTMLButtonElement>('#begin-btn')!;
        beginBtn.addEventListener('click', () => onBegin(setup));
    }

    function updatePresetHighlights(): void {
        root.querySelectorAll<HTMLElement>('.style-card').forEach((card) => {
            card.classList.toggle('selected', card.dataset['preset'] === setup.preset);
        });
    }

    render();

    return {
        async show() { render(); },
        hide() { root.innerHTML = ''; },
        getSetup() { return setup; },
    };
}

function renderSetupHTML(): string {
    const escapeHtml = (s: string): string =>
        s.replace(/[&<>"']/g, (c) =>
            ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
        );

    const presetCards = PRESETS.map(
        (p) => `
        <div class="style-card" data-preset="${p.id}" role="button" tabindex="0">
            <span class="style-name">${escapeHtml(p.name)}</span>
            <span class="style-desc">${escapeHtml(p.description)}</span>
        </div>`
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
    <div class="setup-container">
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

        <div class="form-row">
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
                    <option value="ollama">Ollama (local)</option>
                    <option value="anthropic">Anthropic (proxy)</option>
                </select>
            </div>
            <div class="form-group">
                <label for="model">Model</label>
                <input id="model" type="text" placeholder="qwen3.5:4b" />
            </div>
        </div>

        <div class="setup-footer">
            <button id="begin-btn" class="btn btn-primary btn-begin" type="button">
                Begin Session
            </button>
        </div>
    </div>`;
}
