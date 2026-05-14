/**
 * Pick a TTS engine based on the user's selected voice.
 *
 * Browser voices → BrowserTtsEngine (speechSynthesis).
 * Server voices → ServerTtsEngine (fetches WAV from /api/voices/preview).
 * No selection / browser default → BrowserTtsEngine with default voice.
 */

import type { TtsEngine } from '../../../src/platform/tts.js';
import { allVoices, findVoice, type VoiceEntry } from '../voices.js';

import { BrowserTtsEngine } from './browser-tts.js';
import { ServerTtsEngine } from './server-tts.js';

export interface CreateTtsResult {
    engine: TtsEngine;
    /** The voice we actually selected (null when using browser default). */
    voice: VoiceEntry | null;
}

/**
 * Resolve a voice id (which may be stale, missing, or empty) to a
 * concrete TtsEngine + voice descriptor.
 */
export async function createTtsForVoice(voiceId: string | null): Promise<CreateTtsResult> {
    const voices = await allVoices();
    const voice = findVoice(voices, voiceId);

    if (voice && voice.source === 'server') {
        return {
            engine: new ServerTtsEngine({
                voice: stripPrefix(voice.id, 'server:'),
                ...(voice.engine && { engine: voice.engine }),
            }),
            voice,
        };
    }

    // Browser path — speechSynthesis handles voice selection by name.
    return { engine: new BrowserTtsEngine(), voice };
}

function stripPrefix(s: string, prefix: string): string {
    return s.startsWith(prefix) ? s.slice(prefix.length) : s;
}
