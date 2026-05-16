/**
 * Top-level app — routes between Setup, Session, and History.
 *
 * The session lifecycle owns the only persistent state (a running
 * SessionManager); the other two views are stateless reads. We
 * tear down a running session before switching views.
 *
 * Routing uses the History API: each view change pushes a path so
 * the browser back/forward (and Android's hardware back button under
 * Tauri 2 / Capacitor) walk the same in-app history the user just
 * traversed. Initial-load deep-links into the right view based on
 * the URL path.
 */

import { mountSetupView } from './views/setup.js';
import { mountSessionView, type SessionViewHandle } from './views/session.js';
import { mountHistoryView } from './views/history.js';
import { mountSettingsView } from './views/settings.js';
import type { SessionSetup } from './settings.js';
import type { SessionState } from '../../src/facilitation/session.js';
import { applyChromeSettings, loadAppSettings } from './app-settings.js';
import { detectIsDesktop } from './is-desktop.js';

type View = 'setup' | 'session' | 'history' | 'settings';

const ROUTE_FOR_VIEW: Record<Exclude<View, 'session'>, string> = {
    setup: '/',
    history: '/history',
    settings: '/settings',
};

function viewFromPath(path: string): Exclude<View, 'session'> {
    if (path.startsWith('/history')) return 'history';
    if (path.startsWith('/settings')) return 'settings';
    return 'setup';
}

let currentSession: SessionViewHandle | null = null;
let currentView: View = 'setup';

function $<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element: ${id}`);
    return el as T;
}

export async function bootApp(): Promise<void> {
    // Apply persisted theme/text-scale before the first view mounts so
    // the user doesn't see a default-style flash.
    const settings = await loadAppSettings();
    applyChromeSettings(settings);

    // Probe the runtime environment so desktop-only controls
    // (claude_proxy provider, Open config folder button, env-var hints)
    // can gate themselves. Fire-and-forget — views read isDesktopSync()
    // at render time and tolerate the initial `false` answer.
    void detectIsDesktop();

    wireNav();
    wirePopstate();
    const root = $('app-root');
    // Deep-link into the right view based on the URL the user landed
    // on. Refreshing /history or /settings stays put instead of
    // bouncing the user back to setup.
    const initial = viewFromPath(window.location.pathname);
    await routeTo(root, initial, { replace: true });
}

function wireNav(): void {
    document.addEventListener('click', (e) => {
        const target = (e.target as HTMLElement).closest<HTMLElement>('[data-nav]');
        if (!target) return;
        const view = target.dataset['nav'] as View | undefined;
        if (!view || view === 'session') return;
        e.preventDefault();
        const root = $('app-root');
        void routeTo(root, view);
    });
}

/**
 * Listen for browser back/forward (and Android hardware back) so
 * users can walk the in-app history. We don't re-push the URL on
 * popstate — the browser already did. We just remount the matching
 * view.
 */
function wirePopstate(): void {
    window.addEventListener('popstate', () => {
        const root = $('app-root');
        const target = viewFromPath(window.location.pathname);
        void routeTo(root, target, { fromPopstate: true });
    });
}

/**
 * Single routing entry point. Handles URL changes (pushState /
 * replaceState as appropriate), tears down any running session,
 * and mounts the target view. `replace` is used on initial load
 * so we don't push a duplicate entry for the page we arrived on;
 * `fromPopstate` skips the URL update because the browser already
 * changed the URL for us.
 */
async function routeTo(
    root: HTMLElement,
    view: Exclude<View, 'session'>,
    options: { replace?: boolean; fromPopstate?: boolean } = {}
): Promise<void> {
    // No-op if we're already there (back/forward might land on the
    // same view if there's nothing to navigate to).
    if (currentView === view && currentSession === null) return;

    const path = ROUTE_FOR_VIEW[view];
    if (!options.fromPopstate) {
        if (options.replace) {
            window.history.replaceState({ view }, '', path);
        } else if (window.location.pathname !== path) {
            window.history.pushState({ view }, '', path);
        }
    }

    if (view === 'setup') await goSetup(root);
    else if (view === 'history') await goHistory(root);
    else if (view === 'settings') await goSettings(root);
}

function setActiveNav(view: View): void {
    currentView = view;
    document.querySelectorAll<HTMLElement>('[data-nav]').forEach((el) => {
        // Use `nav-active` to match the lifted CSS — Python's base.html
        // applies the same class to mark the current page link.
        el.classList.toggle('nav-active', el.dataset['nav'] === view);
    });
    // Nav center: setup and settings show an idle orb (Python's
    // index.html / settings.html both put one there). History gets no
    // orb. Session manages its own breathing orb.
    const navCenter = document.getElementById('navCenter');
    if (navCenter && view !== 'session') {
        if (view === 'setup' || view === 'settings') {
            navCenter.innerHTML = `
                <div class="nav-session-info">
                    <div class="orb orb-idle orb-nav" id="home-orb"></div>
                </div>`;
            wireHomeOrbBounce();
        } else {
            navCenter.innerHTML = '';
        }
    }
}

/**
 * Click-to-bounce affordance on the idle orb. Lifted from
 * src/web/static/js/setup.js:819 — toggles the .orb-bounce class
 * and lets the CSS keyframe animation play, removing it on
 * animationend so subsequent clicks re-trigger cleanly.
 */
function wireHomeOrbBounce(): void {
    const orb = document.getElementById('home-orb');
    if (!orb) return;
    orb.addEventListener('click', () => {
        orb.classList.remove('orb-bounce');
        // Reflow so the animation restarts on rapid double-clicks.
        void orb.offsetWidth;
        orb.classList.add('orb-bounce');
    });
    orb.addEventListener('animationend', () => {
        orb.classList.remove('orb-bounce');
    });
}

async function goSetup(root: HTMLElement): Promise<void> {
    if (currentSession) {
        currentSession.teardown();
        currentSession = null;
    }
    setActiveNav('setup');
    await mountSetupView(root, (setup, continueFrom) => {
        void goSession(root, setup, continueFrom);
    });
}

async function goSession(
    root: HTMLElement,
    setup: SessionSetup,
    continueFrom: SessionState | null = null
): Promise<void> {
    setActiveNav('setup'); // session is still under Setup tab conceptually
    currentSession = await mountSessionView(
        root,
        setup,
        () => {
            void goSetup(root);
        },
        continueFrom
    );
}

async function goHistory(root: HTMLElement): Promise<void> {
    if (currentSession) {
        currentSession.teardown();
        currentSession = null;
    }
    setActiveNav('history');
    await mountHistoryView(root, () => {
        void goSetup(root);
    });
}

async function goSettings(root: HTMLElement): Promise<void> {
    if (currentSession) {
        currentSession.teardown();
        currentSession = null;
    }
    setActiveNav('settings');
    await mountSettingsView(root);
}
