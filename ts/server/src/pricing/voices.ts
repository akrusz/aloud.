/**
 * Per-voice TTS cost table. TTS is billed by characters spoken regardless of
 * which voice produced them, but DIFFERENT voices/engines cost different
 * amounts per char — so the rate is a lookup, mirroring the LLM model table.
 *
 * This is what lets the client put a per-voice "~N credits/hr" line in the
 * existing voice selector that can't drift from what actually bills: both read
 * this table (the line via /v1/me/estimates, the charge via the meter).
 *
 * Local engines (browser speechSynthesis, OS premium voices like Apple/MS Edge)
 * cost ZERO — when a capable local voice is detected the client should default
 * to it and show "free". Cloud voices (ElevenLabs, server-held key) carry a
 * per-char rate.
 *
 * ⚠️ Rates are APPROXIMATE early-2026 ElevenLabs list prices and vary by tier
 * (Flash is roughly half the standard models). Validate against a real bill
 * before launch — see the estimate-validation bead.
 */

export type TtsEngine = 'browser' | 'os' | 'elevenlabs';

export interface TtsVoiceRate {
    id: string;
    label: string;
    engine: TtsEngine;
    /** USD per character. Zero for local engines. */
    usdPerChar: number;
}

const VOICES: Record<string, TtsVoiceRate> = {
    'browser-default': { id: 'browser-default', label: 'Device voice (free)', engine: 'browser', usdPerChar: 0 },
    'os-premium': { id: 'os-premium', label: 'System premium voice (free)', engine: 'os', usdPerChar: 0 },
    'elevenlabs-flash': {
        id: 'elevenlabs-flash',
        label: 'Cloud voice — Flash',
        engine: 'elevenlabs',
        usdPerChar: 0.00003,
    },
    'elevenlabs-standard': {
        id: 'elevenlabs-standard',
        label: 'Cloud voice — Premium',
        engine: 'elevenlabs',
        usdPerChar: 0.00009,
    },
};

/** Default cloud rate used when a specific voice id isn't recognized (so a new
 *  ElevenLabs voice never bills at zero by accident). */
export const DEFAULT_CLOUD_USD_PER_CHAR = 0.00003;

export function ttsRateFor(voiceId: string): number {
    return VOICES[voiceId]?.usdPerChar ?? DEFAULT_CLOUD_USD_PER_CHAR;
}

export function ttsVoices(): TtsVoiceRate[] {
    return Object.values(VOICES);
}
