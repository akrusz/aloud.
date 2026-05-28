/**
 * Settings page — Ollama recommendation + model management UI.
 *
 * Port of `src/web/static/js/settings-ollama.js`. Pulls the per-machine
 * recommendation block from `/api/providers` (computed in
 * `src-tauri/src/providers.rs` for desktop, the Flask route for dev) and
 * renders the curated tier list with per-tier Download / Remove buttons,
 * plus a list of any models the user pulled outside the curated tiers.
 *
 * What the Python had that's intentionally not ported yet:
 *   - Restart Ollama
 *   - Upgrade Ollama
 *   - Install Ollama
 *
 * Those flows are platform-specific shell-outs (brew on macOS, curl|sh on
 * Linux, manual on Windows) and the desktop backend doesn't expose them
 * yet — a separate follow-up.
 */

import { apiUrl } from './api-base.js';

interface Tier {
    model: string;
    label: string;
    download: string;
    ram: string;
    note: string;
    min_gb: number;
    fits: boolean;
    installed: boolean;
}

interface OtherModel {
    model: string;
    size: string;
}

interface OllamaInfo {
    available?: boolean;
    installed?: boolean;
    models?: string[];
    hint?: string;
    version?: string | null;
    outdated?: boolean;
    min_version?: string;
    recommendation?: {
        ram_gb?: number | null;
        recommended_model?: string;
        recommended_label?: string;
        tiers?: Tier[];
        other_installed?: OtherModel[];
    };
}

export interface OllamaSettingsHandle {
    /** Re-fetch /api/providers and re-render. */
    refresh(): Promise<void>;
    /** Hide the section (provider switched away from Ollama). */
    hide(): void;
}

export interface OllamaSettingsOptions {
    /**
     * Called whenever the installed-model set changes (a pull or remove
     * completed). The caller uses it to refresh the standard model picker so
     * the dropdown reflects the new set.
     */
    onModelsChanged?: () => void | Promise<void>;
}

/**
 * Mount the recommendation UI into `el`. Returns a handle for refresh/hide;
 * call `refresh()` once the modal is open (and again whenever the provider
 * switches back to Ollama) to populate it.
 */
export function mountOllamaSettings(
    el: HTMLElement,
    options: OllamaSettingsOptions = {}
): OllamaSettingsHandle {
    const onModelsChanged = options.onModelsChanged;

    async function refresh(): Promise<void> {
        let info: OllamaInfo = {};
        try {
            const resp = await fetch(apiUrl('/api/providers'));
            if (resp.ok) {
                const data = (await resp.json()) as { ollama?: OllamaInfo };
                info = data.ollama ?? {};
            }
        } catch {
            // Backend unreachable — leave the section empty; the model picker
            // and provider hint elsewhere will surface a real error if needed.
        }
        el.classList.remove('hidden');
        el.innerHTML = renderHTML(info);
        wireButtons();
    }

    function hide(): void {
        el.classList.add('hidden');
        el.innerHTML = '';
    }

    /** Wire each Download/Remove button rendered into `el`. */
    function wireButtons(): void {
        el.querySelectorAll<HTMLButtonElement>('.ollama-pull-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                void pullModel(btn);
            });
        });
        el.querySelectorAll<HTMLButtonElement>('.ollama-remove-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                void removeModel(btn);
            });
        });
    }

    async function pullModel(btn: HTMLButtonElement): Promise<void> {
        const model = btn.dataset['model'];
        if (!model) return;
        const tile = btn.closest<HTMLElement>('.ollama-tier, .ollama-other-row');
        const progressEl = tile?.querySelector<HTMLElement>('.ollama-pull-progress');
        const fillEl = progressEl?.querySelector<HTMLElement>('.ollama-pull-bar-fill');
        const statusEl = progressEl?.querySelector<HTMLElement>('.ollama-pull-status');

        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Downloading…';
        progressEl?.classList.remove('hidden');

        try {
            const resp = await fetch(apiUrl('/api/ollama/pull'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ model }),
            });
            if (!resp.ok || !resp.body) throw new Error(`server returned ${resp.status}`);
            await consumePullStream(resp.body, fillEl ?? null, statusEl ?? null);
            // Reflect new installed state + let the standard model picker
            // pick up the new option.
            await refresh();
            if (onModelsChanged) await onModelsChanged();
        } catch (err) {
            btn.disabled = false;
            btn.textContent = originalText ?? 'Download';
            if (statusEl) statusEl.textContent = (err as Error).message;
        }
    }

    async function removeModel(btn: HTMLButtonElement): Promise<void> {
        const model = btn.dataset['model'];
        if (!model) return;
        if (
            !confirm(
                `Remove ${model}?\n\nThis will delete the model from disk. You can re-download it later.`
            )
        ) {
            return;
        }
        const originalText = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Removing…';
        try {
            const resp = await fetch(apiUrl('/api/ollama/delete'), {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ model }),
            });
            if (!resp.ok) {
                const data = (await resp.json().catch(() => ({}))) as { error?: string };
                throw new Error(data.error ?? `server returned ${resp.status}`);
            }
            await refresh();
            if (onModelsChanged) await onModelsChanged();
        } catch (err) {
            btn.disabled = false;
            btn.textContent = originalText ?? 'Remove';
            alert(`Failed to remove model: ${(err as Error).message}`);
        }
    }

    return { refresh, hide };
}

// ---------------------------------------------------------------------------
// HTML rendering
// ---------------------------------------------------------------------------

function renderHTML(info: OllamaInfo): string {
    const rec = info.recommendation;
    if (!rec || !rec.tiers || rec.tiers.length === 0) {
        // Ollama daemon not reachable / no tiers — show the hint if any so the
        // user knows why this section is empty.
        return info.hint
            ? `<p class="ollama-rec-hint">${escapeHtml(info.hint)}</p>`
            : '';
    }

    let html = '';

    if (info.outdated && info.version) {
        html += `<div class="ollama-outdated-banner">
            <div class="ollama-outdated-message">
                Your Ollama (v${escapeHtml(info.version)}) is outdated and may not be able
                to download recent models. Update Ollama to
                v${escapeHtml(info.min_version ?? '0.21.0')}+.
            </div>
        </div>`;
    }

    html += '<div class="ollama-rec-block">';
    html += `<h4 class="ollama-rec-heading">Recommended models for this machine</h4>`;
    if (rec.ram_gb) {
        html += `<p class="ollama-rec-detected">Detected: ${rec.ram_gb} GB RAM</p>`;
    }

    for (const t of rec.tiers) {
        html += renderTier(t, rec.recommended_model);
    }
    html += '</div>';

    if (rec.other_installed && rec.other_installed.length > 0) {
        html += '<div class="ollama-others-block">';
        html += `<h4 class="ollama-rec-heading">Other installed models</h4>`;
        for (const m of rec.other_installed) {
            html += `<div class="ollama-other-row">
                <div class="ollama-other-name">${escapeHtml(m.model)}<span class="ollama-other-size"> · ${escapeHtml(m.size)}</span></div>
                <button type="button" class="btn btn-small ollama-remove-btn" data-model="${escapeAttr(m.model)}">Remove</button>
            </div>`;
        }
        html += '</div>';
    }

    return html;
}

function renderTier(t: Tier, recommendedModel: string | undefined): string {
    const isRecommended = t.model === recommendedModel;
    const cls = [
        'ollama-tier',
        isRecommended ? 'is-recommended' : '',
        t.installed ? 'is-installed' : '',
        !t.fits && !t.installed ? 'wont-fit' : '',
    ]
        .filter(Boolean)
        .join(' ');

    const badge = isRecommended
        ? ' <span class="ollama-tier-badge">Recommended</span>'
        : '';
    const fitsLabel = t.fits ? '' : ` <span class="ollama-tier-fit-warning">Needs ${t.min_gb} GB</span>`;

    const action = t.installed
        ? `<button type="button" class="btn btn-small ollama-remove-btn" data-model="${escapeAttr(t.model)}">Remove</button>`
        : `<button type="button" class="btn btn-small ollama-pull-btn" data-model="${escapeAttr(t.model)}">Download (${escapeHtml(t.download)})</button>`;

    return `<div class="${cls}">
        <div class="ollama-tier-head">
            <span class="ollama-tier-label">${escapeHtml(t.label)}</span>${badge}${fitsLabel}
        </div>
        <div class="ollama-tier-model"><code>${escapeHtml(t.model)}</code> · RAM ${escapeHtml(t.ram)}</div>
        <p class="ollama-tier-note">${escapeHtml(t.note)}</p>
        <div class="ollama-tier-actions">${action}</div>
        <div class="ollama-pull-progress hidden">
            <div class="ollama-pull-bar"><div class="ollama-pull-bar-fill"></div></div>
            <div class="ollama-pull-status"></div>
        </div>
    </div>`;
}

// ---------------------------------------------------------------------------
// NDJSON stream consumer
// ---------------------------------------------------------------------------

/**
 * Read the `/api/ollama/pull` NDJSON stream, advancing the progress bar and
 * status text. Throws on an error line so the caller can restore the button.
 */
async function consumePullStream(
    body: ReadableStream<Uint8Array>,
    fillEl: HTMLElement | null,
    statusEl: HTMLElement | null
): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            let msg: { status?: string; error?: string; total?: number; completed?: number };
            try {
                msg = JSON.parse(line);
            } catch {
                continue;
            }
            if (msg.status === 'error') throw new Error(msg.error ?? 'pull failed');
            if (statusEl) statusEl.textContent = msg.status ?? '';
            if (
                typeof msg.total === 'number' &&
                typeof msg.completed === 'number' &&
                msg.total > 0 &&
                fillEl
            ) {
                const pct = Math.min(100, Math.round((msg.completed / msg.total) * 100));
                fillEl.style.width = `${pct}%`;
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Pure helpers (kept exported for tests)
// ---------------------------------------------------------------------------

export function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (ch) => {
        switch (ch) {
            case '&':
                return '&amp;';
            case '<':
                return '&lt;';
            case '>':
                return '&gt;';
            case '"':
                return '&quot;';
            default:
                return '&#39;';
        }
    });
}

function escapeAttr(s: string): string {
    return escapeHtml(s);
}

export const __test = { renderHTML, renderTier };
