import { describe, it, expect } from 'vitest';

import { SessionManager } from '../src/facilitation/session.js';
import { createFakeClock } from '../src/clock.js';

function makeManager(opts?: ConstructorParameters<typeof SessionManager>[0]) {
    const fake = createFakeClock(1_000_000);
    const manager = new SessionManager({ clock: fake.clock, ...opts });
    return { manager, fake };
}

describe('SessionManager — lifecycle', () => {
    it('starts inactive', () => {
        const { manager } = makeManager();
        expect(manager.state).toBe(null);
        expect(manager.isActive).toBe(false);
    });

    it('starts a session and is active until ended', () => {
        const { manager } = makeManager();
        const state = manager.startSession();
        expect(state.sessionId).toBeTruthy();
        expect(manager.isActive).toBe(true);

        manager.endSession();
        expect(manager.isActive).toBe(false);
        expect(manager.state?.endTime).not.toBe(null);
    });

    it('accepts a caller-provided session ID', () => {
        const { manager } = makeManager();
        const state = manager.startSession('my-session');
        expect(state.sessionId).toBe('my-session');
    });

    it('reports duration based on the injected clock', () => {
        const { manager, fake } = makeManager();
        manager.startSession();
        fake.tick(42);
        expect(manager.duration).toBe(42);
    });
});

describe('SessionManager — exchanges', () => {
    it('records user and assistant messages with timestamps', () => {
        const { manager, fake } = makeManager();
        manager.startSession();
        fake.tick(1);
        manager.addUserMessage('hello');
        fake.tick(2);
        manager.addAssistantMessage('welcome');

        const exchanges = manager.state?.exchanges ?? [];
        expect(exchanges).toHaveLength(2);
        expect(exchanges[0]).toMatchObject({ role: 'user', content: 'hello' });
        expect(exchanges[1]).toMatchObject({ role: 'assistant', content: 'welcome' });
        expect(exchanges[1]!.timestamp - exchanges[0]!.timestamp).toBe(2);
    });

    it('throws when adding messages without a session', () => {
        const { manager } = makeManager();
        expect(() => manager.addUserMessage('x')).toThrow();
    });

    it('returns the last user message', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.addUserMessage('first');
        manager.addAssistantMessage('reply');
        manager.addUserMessage('second');
        manager.addAssistantMessage('reply 2');
        expect(manager.getLastUserMessage()).toBe('second');
    });

    it('loads saved exchanges for continuation', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.loadExchanges([
            { role: 'user', content: 'previously...', timestamp: 999 },
            { role: 'assistant', content: '...responded', timestamp: 1000 },
        ]);
        expect(manager.state?.exchanges).toHaveLength(2);
    });
});

describe('SessionManager — context strategies', () => {
    it('returns full history when strategy is "full"', () => {
        const { manager } = makeManager({ contextStrategy: 'full' });
        manager.startSession();
        for (let i = 0; i < 5; i++) {
            manager.addUserMessage(`msg ${i}`);
        }
        expect(manager.getContextMessages()).toHaveLength(5);
    });

    it('truncates to window size when strategy is "rolling"', () => {
        const { manager } = makeManager({
            contextStrategy: 'rolling',
            windowSize: 3,
        });
        manager.startSession();
        for (let i = 0; i < 5; i++) {
            manager.addUserMessage(`msg ${i}`);
        }
        const messages = manager.getContextMessages();
        expect(messages).toHaveLength(3);
        expect(messages.map((m) => m.content)).toEqual(['msg 2', 'msg 3', 'msg 4']);
    });

    it('returns role/content shapes only — no internal fields', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.addUserMessage('hi', 'You');
        const [msg] = manager.getContextMessages();
        expect(Object.keys(msg ?? {}).sort()).toEqual(['content', 'role']);
    });
});

describe('SessionManager — tags and notes', () => {
    it('adds unique tags only', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.addTag('insight');
        manager.addTag('insight');
        manager.addTag('warm');
        expect(manager.state?.tags).toEqual(['insight', 'warm']);
    });

    it('sets notes', () => {
        const { manager } = makeManager();
        manager.startSession();
        manager.setNotes('felt very settled');
        expect(manager.state?.notes).toBe('felt very settled');
    });
});
