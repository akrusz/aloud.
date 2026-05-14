/**
 * Top-level app — toggles between Setup and Session views.
 *
 * Architecture deliberately minimal: each view is a mount function that
 * takes a root element and a "leave" callback. The router owns the
 * transition, not the views. Lets us add History and Settings later
 * without coupling views to each other.
 */

import { mountSetupView } from './views/setup.js';
import { mountSessionView, type SessionViewHandle } from './views/session.js';
import type { SessionSetup } from './settings.js';

let currentSession: SessionViewHandle | null = null;

function $<T extends HTMLElement>(id: string): T {
    const el = document.getElementById(id);
    if (!el) throw new Error(`Missing element: ${id}`);
    return el as T;
}

export async function bootApp(): Promise<void> {
    const root = $('app-root');
    await showSetup(root);
}

async function showSetup(root: HTMLElement): Promise<void> {
    if (currentSession) {
        currentSession.teardown();
        currentSession = null;
    }
    await mountSetupView(root, (setup) => {
        void showSession(root, setup);
    });
}

async function showSession(root: HTMLElement, setup: SessionSetup): Promise<void> {
    currentSession = await mountSessionView(root, setup, () => {
        void showSetup(root);
    });
}
