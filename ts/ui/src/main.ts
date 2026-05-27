import './style.css';
import { bootApp } from './app.js';
import { applyTheme, initThemeToggle, resolveTheme } from './theme.js';
import { regenerateEmbers } from './embers.js';
import { initAbout } from './about.js';
import { isTauri } from './is-desktop.js';
import { initTauriWindowDrag } from './tauri-chrome.js';

// Tag the document for the Tauri desktop shell so CSS can apply app-like
// chrome (block text selection, pad the nav clear of the macOS traffic
// lights). Set before first paint to avoid a flash of selectable web chrome.
if (isTauri()) document.documentElement.setAttribute('data-shell', 'tauri');

// Apply theme before the app renders so the FOUC is invisible.
applyTheme(resolveTheme());
// Embers are session-only — the container is mounted by the session
// view on entry (mirrors the original app's session.html-scoped
// ember-container). regenerateEmbers is a no-op when no session is
// active, so the theme toggle click handler is still safe to call it.

// Wire the theme toggle once the DOM is ready. Listening on document
// click and re-running setup is idempotent (initThemeToggle guards).
function setupGlobalChrome(): void {
    const btn = document.querySelector<HTMLElement>('[data-theme-toggle]');
    if (btn) initThemeToggle(btn);
    initAbout();
    initTauriWindowDrag();
}
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupGlobalChrome, { once: true });
} else {
    setupGlobalChrome();
}

// Palette differs between light/dark — regenerate embers whenever the
// theme flips so they switch immediately instead of waiting for the
// current particles to expire naturally.
document.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).closest('[data-theme-toggle]')) {
        // initThemeToggle has already changed the theme; just refresh embers.
        regenerateEmbers();
    }
});

bootApp().catch((err) => {
    console.error('App init failed:', err);
    const status = document.getElementById('status');
    if (status) status.textContent = `Init error: ${(err as Error).message}`;
});
