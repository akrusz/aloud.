import './style.css';
import { bootApp } from './app.js';
import { applyTheme, resolveTheme, toggleTheme } from './theme.js';

// Apply theme before the app renders so the FOUC is invisible.
applyTheme(resolveTheme());

document.addEventListener('click', (e) => {
    const target = (e.target as HTMLElement).closest<HTMLElement>('[data-theme-toggle]');
    if (!target) return;
    e.preventDefault();
    toggleTheme();
});

bootApp().catch((err) => {
    console.error('App init failed:', err);
    const status = document.getElementById('status');
    if (status) status.textContent = `Init error: ${(err as Error).message}`;
});
