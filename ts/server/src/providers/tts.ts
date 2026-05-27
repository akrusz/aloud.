/**
 * Server-side TTS: synthesize speech via Google Cloud Text-to-Speech (REST,
 * no SDK). Returns MP3 bytes. Stateless — the text transits only for the
 * synthesis call and is never persisted (privacy invariant; see logger.ts).
 *
 * Voice names encode their language (e.g. en-US-Chirp3-HD-Achernar →
 * languageCode en-US). Chirp3-HD is Google's high-naturalness tier; the voice
 * is configurable per request so the client's voice picker can drive it.
 */

const GOOGLE_TTS_URL = 'https://texttospeech.googleapis.com/v1/text:synthesize';

/** Default voice when the client doesn't specify one. Chirp3-HD = top tier. */
export const DEFAULT_TTS_VOICE = 'en-US-Chirp3-HD-Achernar';

/** languageCode is the first two hyphen segments of the voice name. */
function languageOf(voice: string): string {
    const parts = voice.split('-');
    return parts.length >= 2 ? `${parts[0]}-${parts[1]}` : 'en-US';
}

/** Synthesize `text` to MP3 bytes. Throws on an upstream error. */
export async function synthesizeWithGoogle(
    text: string,
    voice: string,
    rate: number,
    apiKey: string,
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<Uint8Array> {
    const res = await fetchImpl(`${GOOGLE_TTS_URL}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            input: { text },
            voice: { languageCode: languageOf(voice), name: voice },
            audioConfig: { audioEncoding: 'MP3', speakingRate: rate },
        }),
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Google TTS ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { audioContent?: string };
    if (!data.audioContent) throw new Error('Google TTS returned no audioContent');
    return Uint8Array.from(Buffer.from(data.audioContent, 'base64'));
}
