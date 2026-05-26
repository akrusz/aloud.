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
import {
    mountNotingSessionView,
    type NotingSessionViewHandle,
} from './views/noting-session.js';
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
let currentNoting: NotingSessionViewHandle | null = null;
// null until the first routeTo lands — keeps the initial-load
// deep-link from being treated as "already on setup" and skipped.
let currentView: View | null = null;

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
        // Back/forward out of a live session: confirm first, matching the
        // beforeunload guard (the Flask MPA caught Back via beforeunload too).
        // goSession pushes a '/session' entry, so this popstate fires while
        // the session is still mounted.
        if (currentSession || currentNoting) {
            const ok = window.confirm(
                'Leave your session? Your session so far will be saved.'
            );
            if (!ok) {
                // Re-arm the trap so the user stays in the session.
                window.history.pushState({ view: 'session' }, '', '/session');
                return;
            }
        }
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
    // No-op if we're already on that view and there's no in-flight
    // session/noting placeholder to tear down. currentView is null on
    // the very first mount so the deep-link routes correctly.
    if (
        currentView === view &&
        currentSession === null &&
        currentNoting === null
    ) {
        return;
    }

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
    // Nav center: every non-session view shows an idle orb (Python's
    // index.html and settings.html both put one there; history.html
    // doesn't, but the user wants the orb everywhere except active
    // sessions for visual consistency). Session manages its own
    // breathing orb.
    const navCenter = document.getElementById('navCenter');
    if (navCenter && view !== 'session') {
        navCenter.innerHTML = `
            <div class="nav-session-info">
                <div class="orb orb-idle orb-nav" id="home-orb"></div>
            </div>`;
        wireHomeOrbBounce();
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
    if (currentNoting) {
        currentNoting.teardown();
        currentNoting = null;
    }
    setActiveNav('setup');
    await mountSetupView(root, (setup, continueFrom) => {
        // Branch on the meditation type the user picked via the tab
        // bar. Noting routes to a placeholder view today (the
        // circle UI isn't ported yet) — same URL '/' since this is
        // still conceptually inside Setup.
        if (setup.meditationType === 'noting') {
            void goNotingSession(root);
        } else {
            void goSession(root, setup, continueFrom);
        }
    });
}

async function goSession(
    root: HTMLElement,
    setup: SessionSetup,
    continueFrom: SessionState | null = null
): Promise<void> {
    setActiveNav('setup'); // session is still under Setup tab conceptually
    // Push a '/session' history entry so the browser Back button has
    // something to pop while the session is live — wirePopstate intercepts
    // it to confirm before leaving. (Normal exits below route via routeTo,
    // which replaces this URL.)
    window.history.pushState({ view: 'session' }, '', '/session');
    currentSession = await mountSessionView(
        root,
        setup,
        (destination) => {
            // Session view tells us where to land the user. Defaults
            // to setup; "history" comes from the in-session History
            // link confirm flow. Route via routeTo so the '/session' URL
            // we pushed above gets replaced with the destination's.
            if (destination === 'history') void routeTo(root, 'history');
            else void routeTo(root, 'setup');
        },
        continueFrom
    );
}

async function goNotingSession(root: HTMLElement): Promise<void> {
    setActiveNav('setup');
    // Same back-button trap as goSession (see wirePopstate).
    window.history.pushState({ view: 'session' }, '', '/session');
    currentNoting = await mountNotingSessionView(root, () => {
        void routeTo(root, 'setup');
    });
}

async function goHistory(root: HTMLElement): Promise<void> {
    teardownInflightSessions();
    setActiveNav('history');
    await mountHistoryView(root, () => {
        void goSetup(root);
    });
}

async function goSettings(root: HTMLElement): Promise<void> {
    teardownInflightSessions();
    setActiveNav('settings');
    await mountSettingsView(root);
}

function teardownInflightSessions(): void {
    if (currentSession) {
        currentSession.teardown();
        currentSession = null;
    }
    if (currentNoting) {
        currentNoting.teardown();
        currentNoting = null;
    }
}
