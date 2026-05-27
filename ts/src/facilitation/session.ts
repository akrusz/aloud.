/**
 * Session state management and conversation context.
 *
 * TS port of src/facilitation/session.py. Stripped of Python-specific
 * serialization shapes (datetime.isoformat strings); callers can format
 * on their own from the unix-seconds timestamp.
 */

import { realClock, type Clock } from '../clock.js';

export type Role = 'user' | 'assistant' | 'system';

export interface Exchange {
    role: Exclude<Role, 'system'>;
    content: string;
    /** Unix timestamp in seconds. */
    timestamp: number;
    /** Display name (e.g. participant name in noting circles). */
    name?: string;
}

export interface SessionState {
    sessionId: string;
    /** Unix timestamp in seconds. */
    startTime: number;
    /** Unix timestamp in seconds. */
    endTime: number | null;
    exchanges: Exchange[];
    tags: string[];
    notes: string;
}

export type ContextStrategy = 'rolling' | 'full';

export interface SessionManagerOptions {
    contextStrategy?: ContextStrategy;
    windowSize?: number;
    clock?: Clock;
    /** Override for generated session IDs (defaults to date-based). */
    generateSessionId?: () => string;
}

function defaultSessionId(clock: Clock): string {
    const d = new Date(clock() * 1000);
    const pad = (n: number) => n.toString().padStart(2, '0');
    return (
        `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-` +
        `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
    );
}

export class SessionManager {
    readonly contextStrategy: ContextStrategy;
    readonly windowSize: number;
    private readonly clock: Clock;
    private readonly generateSessionId: () => string;

    private _state: SessionState | null = null;

    constructor(options: SessionManagerOptions = {}) {
        this.contextStrategy = options.contextStrategy ?? 'full';
        this.windowSize = options.windowSize ?? 10;
        this.clock = options.clock ?? realClock;
        this.generateSessionId =
            options.generateSessionId ?? (() => defaultSessionId(this.clock));
    }

    get state(): SessionState | null {
        return this._state;
    }

    get isActive(): boolean {
        return this._state !== null && this._state.endTime === null;
    }

    get duration(): number {
        if (this._state === null) return 0;
        const end = this._state.endTime ?? this.clock();
        return end - this._state.startTime;
    }

    startSession(sessionId?: string): SessionState {
        this._state = {
            sessionId: sessionId ?? this.generateSessionId(),
            startTime: this.clock(),
            endTime: null,
            exchanges: [],
            tags: [],
            notes: '',
        };
        return this._state;
    }

    endSession(): SessionState | null {
        if (this._state === null) return null;
        this._state.endTime = this.clock();
        return this._state;
    }

    addUserMessage(content: string, name?: string): void {
        this.requireActive().exchanges.push({
            role: 'user',
            content,
            timestamp: this.clock(),
            ...(name !== undefined && { name }),
        });
    }

    addAssistantMessage(content: string, name?: string): void {
        this.requireActive().exchanges.push({
            role: 'assistant',
            content,
            timestamp: this.clock(),
            ...(name !== undefined && { name }),
        });
    }

    /** Append previously-saved exchanges, used for session continuation. */
    loadExchanges(exchanges: ReadonlyArray<Partial<Exchange> & { role: Exchange['role']; content: string }>): void {
        const state = this.requireActive();
        for (const ex of exchanges) {
            state.exchanges.push({
                role: ex.role,
                content: ex.content,
                timestamp: ex.timestamp ?? 0,
                ...(ex.name !== undefined && { name: ex.name }),
            });
        }
    }

    /**
     * Conversation history shaped for an LLM provider — role/content only.
     */
    getContextMessages(): Array<{ role: Exchange['role']; content: string }> {
        if (this._state === null) return [];
        let exchanges = this._state.exchanges;
        if (this.contextStrategy === 'rolling') {
            exchanges = exchanges.slice(-this.windowSize);
        }
        return exchanges.map((e) => ({ role: e.role, content: e.content }));
    }

    getLastUserMessage(): string | null {
        if (this._state === null) return null;
        for (let i = this._state.exchanges.length - 1; i >= 0; i--) {
            const ex = this._state.exchanges[i];
            if (ex && ex.role === 'user') return ex.content;
        }
        return null;
    }

    addTag(tag: string): void {
        if (this._state === null) return;
        if (!this._state.tags.includes(tag)) {
            this._state.tags.push(tag);
        }
    }

    setNotes(notes: string): void {
        if (this._state === null) return;
        this._state.notes = notes;
    }

    private requireActive(): SessionState {
        if (this._state === null) {
            throw new Error('No active session');
        }
        return this._state;
    }
}
