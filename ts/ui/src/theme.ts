/**
 * Theme management — light / dark / system preference, with manual
 * overrides that decay after a few hours so the app trends back toward
 * the system preference. Same logic the existing base.html bootstrap
 * uses, ported so the TS preview feels consistent.
 *
 * Priority:
 *   1. localStorage 'themeMode' = 'dark' | 'light'         (sticky, no expiry)
 *   2. localStorage 'theme'      = { value, ts }            (4h expiry)
 *   3. prefers-color-scheme media query
 *   4. Time-of-day fallback (light 7am–7pm, dark otherwise)
 */

export type Theme = 'light' | 'dark';

const TOGGLE_TTL_MS = 4 * 60 * 60 * 1000;
const STICKY_KEY = 'themeMode';
const TOGGLE_KEY = 'theme';

interface ToggleRecord {
    value: Theme;
    ts: number;
}

function readToggle(): Theme | null {
    const sticky = localStorage.getItem(STICKY_KEY);
    if (sticky === 'dark' || sticky === 'light') return sticky;

    const raw = localStorage.getItem(TOGGLE_KEY);
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as Partial<ToggleRecord>;
        if (
            (parsed.value === 'dark' || parsed.value === 'light') &&
            typeof parsed.ts === 'number' &&
            Date.now() - parsed.ts < TOGGLE_TTL_MS
        ) {
            return parsed.value;
        }
    } catch {
        // Fall through.
    }
    localStorage.removeItem(TOGGLE_KEY);
    return null;
}

function systemPreference(): Theme | null {
    if (!window.matchMedia) return null;
    if (window.matchMedia('(prefers-color-scheme: dark)').matches) return 'dark';
    if (window.matchMedia('(prefers-color-scheme: light)').matches) return 'light';
    return null;
}

function timeOfDayFallback(): Theme {
    const hour = new Date().getHours();
    return hour >= 7 && hour < 19 ? 'light' : 'dark';
}

export function resolveTheme(): Theme {
    return readToggle() ?? systemPreference() ?? timeOfDayFallback();
}

export function applyTheme(theme: Theme): void {
    document.documentElement.setAttribute('data-theme', theme);
}

export function toggleTheme(): Theme {
    const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    const next: Theme = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    localStorage.setItem(TOGGLE_KEY, JSON.stringify({ value: next, ts: Date.now() } satisfies ToggleRecord));
    return next;
}

export function initTheme(): void {
    applyTheme(resolveTheme());
    // React to system-level changes when the user has no recent override.
    if (window.matchMedia) {
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            if (readToggle() !== null) return;
            applyTheme(e.matches ? 'dark' : 'light');
        });
    }
}
