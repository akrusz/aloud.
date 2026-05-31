/**
 * Audition Google Cloud TTS voices for the curated hosted set.
 *
 * Lists the available voices (filtered, default Chirp3-HD en-US), synthesizes a
 * short meditation sample with each, writes the MP3s to voice-previews/, and
 * generates an index.html with a labeled <audio> player per voice so you can
 * listen through them quickly and pick the best couple.
 *
 *   cd ts/server
 *   npx tsx scripts/preview-voices.ts                 # Chirp3-HD en-US
 *   npx tsx scripts/preview-voices.ts Studio          # filter by name substring
 *   npx tsx scripts/preview-voices.ts Chirp3-HD en-GB # filter + language
 *
 * Needs GOOGLE_TTS_API_KEY in .env (the same key /v1/tts uses). Output is
 * gitignored. Cost is a few cents — one short clip per voice.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { synthesizeWithGoogle } from '../src/providers/tts.js';

const SAMPLE =
    "Let's begin. Find a comfortable position, and when you're ready, gently " +
    'let your eyes close. Take a slow breath in... and let it go.';

const VOICES_URL = 'https://texttospeech.googleapis.com/v1/voices';

interface GoogleVoice {
    name: string;
    languageCodes: string[];
    ssmlGender?: string;
}

async function listVoices(apiKey: string, languageCode: string): Promise<GoogleVoice[]> {
    const res = await fetch(`${VOICES_URL}?key=${encodeURIComponent(apiKey)}&languageCode=${languageCode}`);
    if (!res.ok) throw new Error(`voices.list ${res.status}: ${await res.text().catch(() => '')}`);
    const data = (await res.json()) as { voices?: GoogleVoice[] };
    return data.voices ?? [];
}

function html(entries: Array<{ name: string; gender: string; file: string }>): string {
    const rows = entries
        .map(
            (e) => `
    <div class="row">
      <div class="meta"><span class="name">${e.name}</span><span class="g">${e.gender}</span></div>
      <audio controls preload="none" src="${e.file}"></audio>
    </div>`
        )
        .join('');
    return `<!doctype html><meta charset="utf-8"><title>aloud voice audition</title>
<style>
 body{font:15px/1.5 system-ui,sans-serif;max-width:760px;margin:2rem auto;padding:0 1rem;color:#222}
 h1{font-size:1.2rem} .sample{color:#666;font-style:italic;margin-bottom:1.5rem}
 .row{display:flex;align-items:center;gap:1rem;padding:.5rem 0;border-bottom:1px solid #eee}
 .meta{width:280px} .name{font-weight:600} .g{color:#999;margin-left:.5rem;font-size:.85em}
 audio{flex:1}
</style>
<h1>aloud voice audition — ${entries.length} voices</h1>
<p class="sample">“${SAMPLE}”</p>${rows}
`;
}

async function main(): Promise<void> {
    try {
        process.loadEnvFile();
    } catch {
        /* rely on ambient env */
    }
    const apiKey = process.env['GOOGLE_TTS_API_KEY'];
    if (!apiKey) {
        console.error('GOOGLE_TTS_API_KEY not set (put it in ts/server/.env).');
        process.exit(1);
    }

    const filter = process.argv[2] ?? 'Chirp3-HD';
    const languageCode = process.argv[3] ?? 'en-US';

    const all = await listVoices(apiKey, languageCode);
    const voices = all.filter((v) => v.name.includes(filter)).sort((a, b) => a.name.localeCompare(b.name));
    if (voices.length === 0) {
        console.error(`No voices match "${filter}" for ${languageCode}. Try a different filter.`);
        process.exit(1);
    }

    const outDir = resolve(import.meta.dirname, '..', 'voice-previews');
    mkdirSync(outDir, { recursive: true });
    console.log(`Synthesizing ${voices.length} "${filter}" voices (${languageCode}) → ${outDir}`);

    const entries: Array<{ name: string; gender: string; file: string }> = [];
    for (const v of voices) {
        try {
            const mp3 = await synthesizeWithGoogle(SAMPLE, v.name, 1.0, apiKey);
            const file = `${v.name}.mp3`;
            writeFileSync(resolve(outDir, file), mp3);
            entries.push({ name: v.name, gender: v.ssmlGender ?? '', file });
            console.log(`  ✓ ${v.name}`);
        } catch (err) {
            console.log(`  ✗ ${v.name} — ${String(err)}`);
        }
    }

    writeFileSync(resolve(outDir, 'index.html'), html(entries));
    console.log(`\nOpen: ${resolve(outDir, 'index.html')}`);
}

void main();
