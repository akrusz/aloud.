/**
 * Noting-session placeholder.
 *
 * The noting circle UI orchestrator (~500 LOC of Python in
 * src/web/static/js/noting.js) isn't ported yet. The engine pieces
 * — prompts, generateNotingLabel, participant types — live in
 * ts/src/facilitation/noting.ts and are ready when the UI work
 * begins.
 *
 * For now, Setup's Noting tab routes here so the user can see a
 * dedicated page rather than nothing happening. End sends them
 * back to setup.
 */

export interface NotingSessionViewHandle {
    teardown(): void;
}

export async function mountNotingSessionView(
    root: HTMLElement,
    onEnd: () => void
): Promise<NotingSessionViewHandle> {
    // Swap the nav links to a single End affordance like the
    // exploration session does — this is conceptually a session,
    // not the setup page.
    const navLinks = document.getElementById('navLinks');
    const navCenter = document.getElementById('navCenter');
    const savedNavLinks = navLinks ? navLinks.innerHTML : null;
    if (navLinks) {
        navLinks.innerHTML = `
            <a href="#" id="end-btn" class="nav-end-link">End</a>
            <a href="#" data-nav="history">History</a>
            <button type="button" class="theme-toggle"
                data-theme-toggle aria-label="Toggle theme"></button>`;
    }
    if (navCenter) {
        navCenter.innerHTML = `
            <div class="nav-session-info">
                <div class="orb orb-idle orb-nav"></div>
            </div>`;
    }

    root.innerHTML = `
        <section class="setup-container" style="text-align: center; padding-top: 4rem;">
            <h1 class="settings-title">Noting</h1>
            <p style="max-width: 32rem; margin: 1.5rem auto; line-height: 1.6;">
                The noting circle UI is being ported next. The engine
                (prompts, label generation, reactive context) is
                already in place — what's missing is the participant
                circle, turn rotation, and sound cues.
            </p>
            <div style="margin-top: 2rem;">
                <button type="button" class="btn btn-secondary" id="noting-back-btn">Back to setup</button>
            </div>
        </section>`;

    const endBtn = document.getElementById('end-btn') as HTMLAnchorElement | null;
    const backBtn = root.querySelector<HTMLButtonElement>('#noting-back-btn');
    const handleEnd = (e: Event) => {
        e.preventDefault();
        teardown();
        onEnd();
    };
    endBtn?.addEventListener('click', handleEnd);
    backBtn?.addEventListener('click', handleEnd);

    let torn = false;
    function teardown(): void {
        if (torn) return;
        torn = true;
        if (navLinks && savedNavLinks !== null) navLinks.innerHTML = savedNavLinks;
        if (navCenter) navCenter.innerHTML = '';
    }

    return { teardown };
}
