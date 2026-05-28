/**
 * Model picker — fetches available models per provider from
 * `/api/models/<provider>` (matches the Flask endpoint Python's setup
 * uses) and populates a <select>.
 *
 * Falls back to a free-form text input when the endpoint isn't
 * reachable (Flask not running, or running in a Capacitor/Tauri shell
 * where /api/models doesn't exist). The caller picks which UI to
 * render — this module just supplies the data + helpers.
 */

import { serverUrl } from './server-base.js';
import { apiUrl } from './api-base.js';

interface ModelOption {
    value: string;
    label: string;
}

const cache = new Map<string, ModelOption[]>();
let providerStatusCache: Record<string, { available: boolean; models?: string[] }> | null = null;

/**
 * Fetch model options for a provider. Returns null when the endpoint
 * isn't reachable (e.g. no Flask), so callers can swap in a text input
 * gracefully.
 */
export async function fetchModels(provider: string): Promise<ModelOption[] | null> {
    if (cache.has(provider)) return cache.get(provider)!;

    // Hosted aloud server publishes its allowlisted models (with pricing) at
    // /v1/me/models — public, no auth. The option value encodes provider/model
    // so buildProvider can route the turn (model ids may themselves contain a
    // slash, e.g. openrouter, so the leading segment is the provider).
    if (provider === 'aloud') {
        try {
            const resp = await fetch(serverUrl('/v1/me/models'));
            if (!resp.ok) return null;
            const data = (await resp.json()) as { models?: Array<{ provider: string; model: string }> };
            if (!data.models?.length) return null;
            const opts: ModelOption[] = data.models.map((m) => ({
                value: `${m.provider}/${m.model}`,
                label: m.model,
            }));
            cache.set(provider, opts);
            return opts;
        } catch {
            return null;
        }
    }

    // Ollama models come from /api/providers, not /api/models — same
    // shape as the Python setup.js handling.
    if (provider === 'ollama') {
        const status = await fetchProviderStatus();
        const ollamaInfo = status?.['ollama'];
        if (!ollamaInfo?.models?.length) return null;
        const opts: ModelOption[] = ollamaInfo.models.map((m: string) => ({
            value: m,
            label: m,
        }));
        cache.set(provider, opts);
        return opts;
    }

    try {
        const resp = await fetch(apiUrl(`/api/models/${encodeURIComponent(provider)}`));
        if (!resp.ok) return null;
        const data = (await resp.json()) as ModelOption[];
        if (!Array.isArray(data) || data.length === 0) return null;
        cache.set(provider, data);
        return data;
    } catch {
        return null;
    }
}

async function fetchProviderStatus(): Promise<typeof providerStatusCache | null> {
    if (providerStatusCache !== null) return providerStatusCache;
    try {
        const resp = await fetch(apiUrl('/api/providers'));
        if (!resp.ok) return null;
        const data = (await resp.json()) as Record<
            string,
            { available: boolean; models?: string[] }
        >;
        providerStatusCache = data;
        return data;
    } catch {
        return null;
    }
}

/**
 * Render a <select> of model options for a given provider. When the
 * fetch fails, replace the select with a free-form text input so the
 * user can type a model name anyway.
 *
 * The returned function lets the caller refresh the picker when the
 * provider changes — call refresh(newProvider) and the same DOM slot
 * gets re-populated.
 */
export function mountModelPicker(
    container: HTMLElement,
    initialProvider: string,
    initialValue: string,
    onChange: (value: string) => void
): { refresh: (provider: string) => Promise<void>; getValue: () => string } {
    let currentValue = initialValue;

    container.innerHTML = `
        <select id="model-select" disabled>
            <option value="">Loading models…</option>
        </select>`;

    function renderSelect(provider: string, models: ModelOption[]): void {
        const optionsHTML = models
            .map((m) => `<option value="${attr(m.value)}">${escape(m.label)}</option>`)
            .join('');
        container.innerHTML = `
            <select id="model-select" data-provider="${attr(provider)}">${optionsHTML}</select>`;
        const sel = container.querySelector<HTMLSelectElement>('#model-select')!;
        // The user wants the picker to always show a concrete model name
        // (no "(provider default)" placeholder), so if the persisted value
        // doesn't match anything in the list we promote the first model
        // to the active selection and persist it. Keeps the displayed
        // model honest about what's actually going to run.
        const matched = models.find((m) => m.value === currentValue);
        if (matched) {
            sel.value = matched.value;
        } else if (models[0]) {
            sel.value = models[0].value;
            currentValue = models[0].value;
            onChange(currentValue);
        }
        sel.addEventListener('change', () => {
            currentValue = sel.value;
            onChange(currentValue);
        });
    }

    function renderTextInput(provider: string): void {
        container.innerHTML = `
            <input type="text" id="model-input" data-provider="${attr(provider)}"
                placeholder="${attr(modelPlaceholder(provider))}"
                value="${attr(currentValue)}">`;
        const input = container.querySelector<HTMLInputElement>('#model-input')!;
        input.addEventListener('change', () => {
            currentValue = input.value.trim();
            onChange(currentValue);
        });
    }

    async function refresh(provider: string): Promise<void> {
        container.innerHTML = `
            <select disabled><option>Loading models…</option></select>`;
        const models = await fetchModels(provider);
        if (models && models.length > 0) {
            renderSelect(provider, models);
        } else {
            renderTextInput(provider);
        }
    }

    void refresh(initialProvider);
    return {
        refresh,
        getValue: () => currentValue,
    };
}

function modelPlaceholder(provider: string): string {
    switch (provider) {
        case 'aloud':
            return 'anthropic/claude-sonnet-4-6';
        case 'ollama':
            return 'qwen3.5:4b';
        case 'anthropic':
            return 'claude-sonnet-4-6';
        case 'openai':
            return 'gpt-5.4-mini';
        case 'openrouter':
            return 'deepseek/deepseek-v3.2';
        case 'venice':
            return 'llama-3.3-70b';
        case 'groq':
            return 'llama-3.3-70b-versatile';
        case 'claude_proxy':
            return 'sonnet | haiku | opus';
        default:
            return 'model name';
    }
}

function attr(s: string): string {
    return escape(s);
}

function escape(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
    );
}
