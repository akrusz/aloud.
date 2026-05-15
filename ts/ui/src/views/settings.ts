/**
 * Settings view — placeholder.
 *
 * Real content (theme, provider/key entry, TTS engine, STT model,
 * Ollama install, auth, etc.) lands in a follow-up commit. For now
 * the route exists so clicking "Settings" in the nav works.
 */

export interface SettingsViewHandle {
    show(): Promise<void>;
}

export async function mountSettingsView(root: HTMLElement): Promise<SettingsViewHandle> {
    root.innerHTML = `
    <section class="setup-container">
        <p style="margin-top: 2rem; color: var(--muted, #888);">
            Settings — coming next.
        </p>
    </section>`;
    return {
        async show() {
            /* no-op for the placeholder */
        },
    };
}
