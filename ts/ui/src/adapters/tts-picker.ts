/**
 * Pick a TTS engine based on the user's selected voice.
 *
 * The voice id is prefixed: `server:<name>` for voices that play
 * through the Flask /api/voices/preview endpoint, `browser:<name>` for
 * voices that come from window.speechSynthesis. The name is the
 * voice's display name (matches voice-picker.ts's ScoredVoice.name).
 *
 * For browser voices, we hand the voice name through to BrowserTtsEngine
 * so each speak() actually applies it — without this every "browser"
 * voice silently fell back to the OS default.
 */

import type { TtsEngine } from '../../../src/platform/tts.js';
import { allVoices, findVoice, type VoiceEntry } from '../voices.js';

import { BrowserTtsEngine } from './browser-tts.js';
import { ServerTtsEngine } from './server-tts.js';

export interface CreateTtsResult {
    engine: TtsEngine;
    /** Voice we settled on (null when using browser default). */
    voice: VoiceEntry | null;
}

/**
 * Construct a TtsEngine for a voice id stored in SessionSetup /
 * AppSettings. Handles a few id shapes:
 *
 *   - `server:<name>`  — server-side TTS (macOS / Piper / ElevenLabs)
 *   - `browser:<name>` — browser speechSynthesis with that voice name
 *   - `browser:` + an empty suffix or no prefix at all — browser default
 *
 * For server voices we also try the catalog so we get the right engine
 * suffix (`engine_for_voice`). For browser voices we hand the name to
 * BrowserTtsEngine directly — the catalog id scheme is voiceURI-based,
 * the picker is name-based, and reconciling those two is more brittle
 * than just trusting the name.
 */
export async function createTtsForVoice(voiceId: string | null): Promise<CreateTtsResult> {
    if (!voiceId) {
        return { engine: new BrowserTtsEngine(), voice: null };
    }

    if (voiceId.startsWith('browser:')) {
        const name = voiceId.slice('browser:'.length);
        const engine = name
            ? new BrowserTtsEngine({ defaultVoice: name })
            : new BrowserTtsEngine();
        return { engine, voice: null };
    }

    if (voiceId.startsWith('server:')) {
        const name = voiceId.slice('server:'.length);
        // Try the catalog so we can pass the right engine (piper/macos/
        // elevenlabs) to ServerTtsEngine. If the catalog can't find it,
        // fall back to a bare ServerTtsEngine with just the name — Flask
        // will route it correctly via engine_for_voice on its side.
        const voices = await allVoices();
        const voice =
            voices.find((v) => v.id === voiceId) ??
            voices.find((v) => v.name === name && v.source === 'server') ??
            null;
        const options: ConstructorParameters<typeof ServerTtsEngine>[0] = { voice: name };
        if (voice?.engine) options.engine = voice.engine;
        return { engine: new ServerTtsEngine(options), voice };
    }

    // Legacy / unprefixed id — try the catalog one more time.
    const voices = await allVoices();
    const voice = findVoice(voices, voiceId);
    if (voice && voice.source === 'server') {
        const options: ConstructorParameters<typeof ServerTtsEngine>[0] = { voice: voice.name };
        if (voice.engine) options.engine = voice.engine;
        return { engine: new ServerTtsEngine(options), voice };
    }
    return {
        engine: voice ? new BrowserTtsEngine({ defaultVoice: voice.name }) : new BrowserTtsEngine(),
        voice,
    };
}
