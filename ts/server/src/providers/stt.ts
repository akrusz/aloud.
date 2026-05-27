/**
 * Server-side STT: transcribe raw PCM via Groq's OpenAI-compatible Whisper
 * endpoint (whisper-large-v3-turbo). The client captures + downsamples to mono
 * Float32 and POSTs the raw samples; we wrap them into a WAV container (Groq
 * wants a file upload) and forward. Stateless — audio is never persisted (the
 * privacy invariant; see logger.ts and meditation-pal-dn2).
 */

const GROQ_TRANSCRIBE_URL = 'https://api.groq.com/openai/v1/audio/transcriptions';
const GROQ_STT_MODEL = 'whisper-large-v3-turbo';

/** Encode mono Float32 PCM in [-1, 1] as a 16-bit little-endian WAV. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
    const dataBytes = samples.length * 2;
    const buf = new ArrayBuffer(44 + dataBytes);
    const view = new DataView(buf);
    const writeStr = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true); // fmt chunk size
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true); // byte rate (mono, 16-bit)
    view.setUint16(32, 2, true); // block align
    view.setUint16(34, 16, true); // bits per sample
    writeStr(36, 'data');
    view.setUint32(40, dataBytes, true);
    let off = 44;
    for (let i = 0; i < samples.length; i++) {
        const s = Math.max(-1, Math.min(1, samples[i]!));
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
    }
    return new Uint8Array(buf);
}

/** Transcribe mono Float32 PCM via Groq. Throws on an upstream error. */
export async function transcribeWithGroq(
    samples: Float32Array,
    sampleRate: number,
    apiKey: string,
    fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis)
): Promise<string> {
    const wav = encodeWav(samples, sampleRate);
    const form = new FormData();
    form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
    form.append('model', GROQ_STT_MODEL);
    form.append('response_format', 'json');

    const res = await fetchImpl(GROQ_TRANSCRIBE_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => '');
        throw new Error(`Groq STT ${res.status}: ${detail}`);
    }
    const data = (await res.json()) as { text?: string };
    return (data.text ?? '').trim();
}
