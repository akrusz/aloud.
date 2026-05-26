/**
 * Noting circle orchestrator.
 *
 * TS port of the round-robin in src/web/static/js/noting.js, adapted to the
 * client-side model: instead of socket round-trips, we call the LLM provider
 * (generateNotingLabel), per-participant TTS, and the STT engine directly.
 *
 * Flow: opener → User → P1 → P2 → … → User → … Each LLM participant notes a
 * 1–2 word label in its own voice; the user notes by speaking on their turn.
 * Empty participant list = solo noting (opener + your turns). Muting the mic
 * pauses the circle; unmuting resumes.
 *
 * NOTE: like the exploration session, the audio path (STT capture, TTS, chime)
 * can't be exercised headlessly — this needs hands-on testing.
 */

import {
    SessionManager,
    generateNotingLabel,
    NOTING_OPENER_PROMPT,
    NOTING_STATIC_OPENER,
    parseHoldSignal,
} from '../../../src/facilitation/index.js';
import type { LLMProvider } from '../../../src/llm/index.js';
import type { SttEngine, TtsEngine } from '../../../src/platform/index.js';
import { buildProvider } from './session.js';
import { createTtsForVoice } from '../adapters/tts-picker.js';
import {
    createBestStt,
    detectSttBackend,
    invalidateSttBackendCache,
} from '../adapters/stt-picker.js';
import { sessionStore } from '../state.js';
import { initThemeToggle } from '../theme.js';
import type { SessionSetup, NotingParticipantConfig } from '../settings.js';

export interface NotingSessionViewHandle {
    teardown(): void;
}

const DEFAULT_CADENCE_MS = 4000;
const USER_TURN_CUE_DELAY_MS = 1000; // breathing room before the cue
const ECHO_REJECT_MS = 1500; // ignore "speech" this soon after the turn starts

export async function mountNotingSessionView(
    root: HTMLElement,
    setup: SessionSetup,
    onEnd: () => void
): Promise<NotingSessionViewHandle> {
    const participants = setup.notingParticipants ?? [];
    const session = new SessionManager({ contextStrategy: 'full' });
    session.startSession();

    let provider: LLMProvider;
    try {
        provider = await buildProvider(setup);
    } catch (err) {
        return mountError(root, (err as Error).message, onEnd);
    }

    // ---- nav chrome (breathing orb + End/History) ----
    const navLinks = document.getElementById('navLinks');
    const navCenter = document.getElementById('navCenter');
    const savedNavLinks = navLinks ? navLinks.innerHTML : null;
    if (navCenter) {
        navCenter.innerHTML = `
            <div class="nav-session-info">
                <div class="orb orb-breathing orb-nav" id="orb"></div>
            </div>`;
    }
    if (navLinks) {
        navLinks.innerHTML = `
            <a href="#" id="end-btn" class="nav-end-link">End<span class="nav-word-session"> Session</span></a>
            <a href="#" data-nav="history">History</a>
            <button type="button" class="theme-toggle" data-theme-toggle aria-label="Toggle theme"></button>`;
        const themeBtn = navLinks.querySelector<HTMLElement>('[data-theme-toggle]');
        if (themeBtn) initThemeToggle(themeBtn);
    }

    root.innerHTML = `
        <div class="session-container">
            <div class="conversation" id="conversation"></div>
            <div class="input-area">
                <div class="input-row">
                    <div id="voice-status" class="voice-status">Starting…</div>
                    <button id="voice-btn" class="btn btn-voice active" title="Toggle microphone" aria-label="Toggle microphone">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
                            <line x1="12" y1="19" x2="12" y2="23"></line>
                            <line x1="8" y1="23" x2="16" y2="23"></line>
                            <line class="mute-line" x1="3" y1="3" x2="21" y2="21"></line>
                        </svg>
                    </button>
                </div>
            </div>
        </div>`;

    const conversation = root.querySelector<HTMLElement>('#conversation')!;
    const statusEl = root.querySelector<HTMLElement>('#voice-status')!;
    const micBtn = root.querySelector<HTMLButtonElement>('#voice-btn')!;
    const orbEl = document.getElementById('orb');

    function setStatus(text: string): void {
        statusEl.textContent = text;
    }
    function appendMessage(role: 'user' | 'facilitator', text: string, name: string): HTMLElement {
        const el = document.createElement('div');
        el.className = `message ${role}`;
        const content = document.createElement('div');
        content.className = 'message-content';
        content.textContent = text;
        const sender = document.createElement('div');
        sender.className = 'message-sender';
        sender.textContent = name;
        el.append(sender, content);
        conversation.appendChild(el);
        conversation.scrollTop = conversation.scrollHeight;
        return el;
    }

    // ---- audio: STT, per-participant TTS, chime cue ----
    invalidateSttBackendCache();
    const sttBackend = await detectSttBackend();
    const stt: SttEngine | null = await createBestStt({
        silenceBaseMs: 1200,
        silenceMaxMs: 6000,
        silenceRampRate: 1,
    });

    // One TTS engine per distinct voice id (participants + narrator).
    const ttsCache = new Map<string, TtsEngine>();
    async function ttsFor(voiceId: string | null): Promise<TtsEngine> {
        const key = voiceId ?? '__default__';
        let engine = ttsCache.get(key);
        if (!engine) {
            const built = await createTtsForVoice(voiceId, {
                onServerSynthesize: (chars) => session.recordTts(chars),
            });
            engine = built.engine;
            ttsCache.set(key, engine);
        }
        return engine;
    }

    let audioCtx: AudioContext | null = null;
    function playChime(): void {
        try {
            const AC =
                (globalThis as unknown as { AudioContext?: typeof AudioContext }).AudioContext ??
                (globalThis as unknown as { webkitAudioContext?: typeof AudioContext })
                    .webkitAudioContext;
            if (!AC) return;
            audioCtx = audioCtx ?? new AC();
            const ctx = audioCtx;
            const now = ctx.currentTime;
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = 'sine';
            osc.frequency.setValueAtTime(440, now);
            osc.frequency.setValueAtTime(554, now + 0.1); // A4 → C#5
            gain.gain.setValueAtTime(0.15, now);
            gain.gain.exponentialRampToValueAtTime(0.01, now + 0.2);
            osc.start(now);
            osc.stop(now + 0.2);
        } catch {
            /* cue is optional */
        }
    }

    // ---- circle state ----
    const turnOrder: Array<'user' | number> = ['user', ...participants.map((_, i) => i)];
    let currentTurn = -1;
    const recentLabels: string[] = [];
    const ownLabels: string[][] = participants.map(() => []);
    const userCadences: number[] = [];
    let paused = false;
    let muted = false;
    let torn = false;
    let waitTimer: ReturnType<typeof setTimeout> | null = null;

    function participantName(index: number): string {
        const p = participants[index];
        if (!p) return `Participant ${index + 1}`;
        const name = stripVoiceLabel(p.voice);
        return name || `Participant ${index + 1}`;
    }

    function clearWait(): void {
        if (waitTimer) {
            clearTimeout(waitTimer);
            waitTimer = null;
        }
    }

    function scheduleNextTurn(delayMs: number): void {
        if (torn || paused) return;
        clearWait();
        waitTimer = setTimeout(() => {
            waitTimer = null;
            void advanceTurn();
        }, delayMs);
    }

    function adaptiveDelay(): number {
        if (userCadences.length === 0) return DEFAULT_CADENCE_MS;
        const sum = userCadences.reduce((a, b) => a + b, 0);
        return sum / userCadences.length;
    }

    async function advanceTurn(): Promise<void> {
        if (torn || paused) return;
        currentTurn = (currentTurn + 1) % turnOrder.length;
        const turn = turnOrder[currentTurn];
        if (turn === 'user') await startUserTurn();
        else await participantTurn(turn as number);
    }

    let userTurnStart = 0;

    /** One STT capture: shows partials, returns the final text (or '' on
     *  silence/error). */
    async function listenOnce(): Promise<string> {
        if (!stt) return '';
        let partialEl: HTMLElement | null = null;
        let finalText = '';
        try {
            for await (const event of stt.start()) {
                if (torn || paused) break;
                if (event.type === 'partial') {
                    if (!partialEl) partialEl = appendMessage('user', event.text, 'You');
                    else {
                        const c = partialEl.querySelector('.message-content');
                        if (c) c.textContent = event.text;
                    }
                    partialEl.classList.add('partial');
                } else if (event.type === 'final') {
                    finalText = event.text;
                    if (event.seconds) session.recordStt(event.seconds);
                    break;
                }
            }
        } catch {
            /* mic error — treat as empty */
        }
        if (partialEl) partialEl.remove();
        return finalText;
    }

    async function startUserTurn(): Promise<void> {
        if (torn || paused) return;
        // Cue (after a breath) BEFORE listening, so the chime isn't transcribed
        // as the user's note.
        if (setup.notingUserTurnCue) {
            const cueDelay = userCadences.length === 0 ? 0 : USER_TURN_CUE_DELAY_MS;
            if (cueDelay > 0) await sleep(cueDelay);
            if (torn || paused) return;
            playChime();
            await sleep(250);
        }
        if (torn || paused) return;
        setStatus('Your turn — note what you notice');
        userTurnStart = Date.now();

        if (!stt) {
            // No mic backend — can't take a user turn; move on after a beat.
            scheduleNextTurn(DEFAULT_CADENCE_MS);
            return;
        }

        // Listen until we get a real note. Silence/echo just re-listens (no cue
        // replay). The echo guard only rejects audio right at turn start (TTS
        // tail from the previous participant).
        while (!torn && !paused) {
            const note = (await listenOnce()).trim();
            if (torn || paused) return;
            const tooSoon = Date.now() - userTurnStart < ECHO_REJECT_MS;
            if (note && !tooSoon) {
                const cadence = Date.now() - userTurnStart;
                userCadences.push(cadence);
                if (userCadences.length > 5) userCadences.shift();
                recentLabels.push(note);
                session.addUserMessage(note, 'You');
                appendMessage('user', note, 'You');
                scheduleNextTurn(500);
                return;
            }
            await sleep(200); // brief breath before re-listening
        }
    }

    async function participantTurn(index: number): Promise<void> {
        if (torn || paused) return;
        const p = participants[index];
        if (!p) {
            scheduleNextTurn(1000);
            return;
        }
        // Wait a human-like beat before noting (adaptive to the user's cadence).
        await sleep(adaptiveDelay());
        if (torn || paused) return;

        setStatus(`${participantName(index)} is noting…`);
        const label = await generateNotingLabel(provider, {
            context: recentLabels.slice(),
            ownLabels: ownLabels[index]!.slice(),
            reactive: p.reactive,
            onUsage: (u) => session.recordLlmUsage(u),
        });
        if (torn || paused) return;

        recentLabels.push(label);
        ownLabels[index]!.push(label);
        session.addAssistantMessage(label, participantName(index));
        appendMessage('facilitator', label, participantName(index));

        try {
            const tts = await ttsFor(p.voice);
            await tts.speak(label, { rate: setup.ttsRate });
        } catch {
            /* TTS optional */
        }
        scheduleNextTurn(300);
    }

    // ---- opener ----
    async function speakOpener(): Promise<void> {
        let text = NOTING_STATIC_OPENER;
        try {
            const result = await provider.complete([{ role: 'user', content: NOTING_OPENER_PROMPT }], {
                maxTokens: 80,
            });
            session.recordLlmUsage({
                tokensIn: result.inputTokens ?? null,
                tokensOut: result.outputTokens ?? null,
                cacheRead: result.cacheReadTokens ?? null,
                cacheCreation: result.cacheCreationTokens ?? null,
            });
            const clean = parseHoldSignal(result.text).cleanText.trim();
            if (clean) text = clean;
        } catch {
            /* fall back to the static opener */
        }
        if (torn) return;
        session.addAssistantMessage(text, 'Facilitator');
        appendMessage('facilitator', text, 'Facilitator');
        setStatus('Speaking…');
        try {
            const tts = await ttsFor(setup.voice);
            await tts.speak(text, { rate: setup.ttsRate });
        } catch {
            /* optional */
        }
    }

    // ---- mute / pause ----
    function setMicButtonState(): void {
        micBtn.classList.toggle('active', !muted);
        orbEl?.classList.toggle('orb-muted', muted);
        micBtn.setAttribute('aria-label', muted ? 'Unmute microphone' : 'Mute microphone');
    }
    micBtn.addEventListener('click', () => {
        muted = !muted;
        setMicButtonState();
        if (muted) {
            paused = true;
            clearWait();
            void stt?.stop();
            setStatus('Paused — unmute to resume');
        } else if (paused) {
            paused = false;
            setStatus('Resuming…');
            // Resume from the current turn.
            const turn = turnOrder[currentTurn];
            if (turn === 'user') void startUserTurn();
            else if (typeof turn === 'number') void participantTurn(turn);
        }
    });

    // ---- end / teardown ----
    const endBtn = document.getElementById('end-btn') as HTMLAnchorElement | null;
    endBtn?.addEventListener('click', (e) => {
        e.preventDefault();
        void endSession();
    });

    async function endSession(): Promise<void> {
        if (torn) return;
        torn = true;
        paused = true;
        clearWait();
        void stt?.stop();
        if (audioCtx && audioCtx.state !== 'closed') void audioCtx.close().catch(() => {});
        const finalState = session.endSession();
        // Save if there's at least one user turn (skip empty/abandoned circles).
        if (finalState && finalState.exchanges.some((ex) => ex.role === 'user')) {
            finalState.notes = 'noting circle';
            try {
                await sessionStore.save(finalState);
            } catch {
                /* non-fatal */
            }
        }
        if (navCenter) navCenter.innerHTML = '';
        if (navLinks && savedNavLinks !== null) {
            navLinks.innerHTML = savedNavLinks;
            const btn = navLinks.querySelector<HTMLElement>('[data-theme-toggle]');
            if (btn) initThemeToggle(btn);
        }
        onEnd();
    }

    // ---- kick off ----
    setMicButtonState();
    if (sttBackend === 'none') {
        setStatus('No microphone available — noting needs a mic for your turns.');
    }
    void (async () => {
        await speakOpener();
        if (!torn) void advanceTurn();
    })();

    return {
        teardown(): void {
            void endSession();
        },
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** Strip the 'browser:'/'server:' prefix and any "(Premium)"-style qualifier. */
function stripVoiceLabel(voice: string | null): string {
    if (!voice) return '';
    const noPrefix = voice.replace(/^(browser:|server:)/, '');
    return noPrefix.replace(/\s*\(.*\)$/, '').trim();
}

function mountError(
    root: HTMLElement,
    message: string,
    onEnd: () => void
): NotingSessionViewHandle {
    root.innerHTML = `
        <section class="session-stage">
            <div class="status"><div id="status">${escapeHtml(message)}</div></div>
            <div class="controls">
                <button type="button" class="btn btn-secondary" id="noting-back-btn">Back to setup</button>
            </div>
        </section>`;
    root.querySelector('#noting-back-btn')?.addEventListener('click', () => onEnd());
    return { teardown() { /* nothing to tear down */ } };
}

function escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, (c) =>
        c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'
    );
}
