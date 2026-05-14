/**
 * History view — lists past sessions saved by the session view and
 * lets the user read or delete them. Click a row to expand the
 * transcript inline; click again (or another row) to collapse.
 *
 * Uses the shared SessionStore, so saving a session in session.ts
 * shows up here without explicit coordination.
 */

import type { SessionState, Exchange } from '../../../src/facilitation/index.js';
import { sessionStore } from '../state.js';

export interface HistoryViewHandle {
    show(): Promise<void>;
}

export async function mountHistoryView(
    root: HTMLElement,
    _onLeave: () => void
): Promise<HistoryViewHandle> {
    let expandedId: string | null = null;

    async function refresh(): Promise<void> {
        const ids = await sessionStore.list();
        const states = await Promise.all(ids.map((id) => sessionStore.load(id)));
        const sessions = states.filter((s): s is SessionState => s !== null);
        // Most recent first.
        sessions.sort((a, b) => b.startTime - a.startTime);

        root.innerHTML = renderHistoryHTML(sessions, expandedId);
        wireEvents(sessions);
    }

    function wireEvents(sessions: readonly SessionState[]): void {
        for (const session of sessions) {
            const row = root.querySelector<HTMLElement>(
                `[data-session-id="${cssEscape(session.sessionId)}"]`
            );
            if (!row) continue;

            const header = row.querySelector<HTMLElement>('.history-row-header');
            if (header) {
                header.addEventListener('click', (e) => {
                    if ((e.target as HTMLElement).closest('.history-delete')) return;
                    expandedId = expandedId === session.sessionId ? null : session.sessionId;
                    void refresh();
                });
            }

            const deleteBtn = row.querySelector<HTMLButtonElement>('.history-delete');
            if (deleteBtn) {
                deleteBtn.addEventListener('click', async (e) => {
                    e.stopPropagation();
                    if (!confirm('Delete this session? This cannot be undone.')) return;
                    await sessionStore.delete(session.sessionId);
                    if (expandedId === session.sessionId) expandedId = null;
                    await refresh();
                });
            }
        }
    }

    await refresh();
    return { show: refresh };
}

function renderHistoryHTML(sessions: readonly SessionState[], expandedId: string | null): string {
    if (sessions.length === 0) {
        return `
        <div class="history-empty">
            <p>No saved sessions yet.</p>
            <p class="muted">Sessions you end with at least one turn show up here.</p>
        </div>`;
    }

    const rows = sessions.map((s) => renderRow(s, s.sessionId === expandedId)).join('');
    return `<div class="history-list">${rows}</div>`;
}

function renderRow(session: SessionState, expanded: boolean): string {
    const escape = htmlEscape;
    const dateStr = new Date(session.startTime * 1000).toLocaleString();
    const durationStr = formatDuration(session);
    const turnCount = session.exchanges.filter((e) => e.role === 'user').length;
    const turnLabel = turnCount === 1 ? '1 turn' : `${turnCount} turns`;
    const notes = session.notes ? `<span class="history-notes">${escape(session.notes)}</span>` : '';

    const transcript = expanded ? renderTranscript(session.exchanges) : '';

    return `
    <div class="history-row${expanded ? ' expanded' : ''}" data-session-id="${escape(session.sessionId)}">
        <div class="history-row-header">
            <div class="history-row-main">
                <div class="history-date">${escape(dateStr)}</div>
                ${notes}
                <div class="history-meta">${escape(durationStr)} · ${escape(turnLabel)}</div>
            </div>
            <button class="history-delete" type="button" aria-label="Delete session">×</button>
        </div>
        ${transcript}
    </div>`;
}

function renderTranscript(exchanges: readonly Exchange[]): string {
    const items = exchanges
        .map(
            (e) => `
        <div class="message ${e.role}">
            ${htmlEscape(e.content)}
        </div>`
        )
        .join('');
    return `<div class="history-transcript transcript">${items}</div>`;
}

function formatDuration(s: SessionState): string {
    const end = s.endTime ?? s.startTime;
    const seconds = Math.max(0, Math.round(end - s.startTime));
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    if (mins === 0) return `${secs}s`;
    return `${mins}m ${secs}s`;
}

function htmlEscape(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c)
    );
}

function cssEscape(s: string): string {
    // Sessions IDs are generated via the SessionManager — letters,
    // numbers, and hyphens. But be defensive for callers that pass
    // their own IDs.
    return s.replace(/"/g, '\\"');
}
