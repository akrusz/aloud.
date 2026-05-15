import './style.css';
import { bootApp } from './app.js';
import { applyTheme, initThemeToggle, resolveTheme } from './theme.js';
import { initEmbers, regenerateEmbers } from './embers.js';
import { initAbout } from './about.js';

// Apply theme before the app renders so the FOUC is invisible.
applyTheme(resolveTheme());
// Init embers after theme so palette matches.
initEmbers();

// Wire the theme toggle once the DOM is ready. Listening on document
// click and re-running setup is idempotent (initThemeToggle guards).
function setupGlobalChrome(): void {
    const btn = document.querySelector<HTMLElement>('[data-theme-toggle]');
    if (btn) initThemeToggle(btn);
    initAbout();
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
