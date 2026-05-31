/**
 * STT choice resolution + mode-aware options. In Node there's no Web Speech
 * API, so isWebSpeechSupported() is false and 'web-speech' is never offered —
 * which is exactly what lets us assert the local/web flow deterministically.
 */
import { describe, it, expect } from 'vitest';
import {
    sttEngineOptions,
    defaultSttChoice,
    resolveSttChoice,
} from '../ui/src/adapters/stt-picker.js';

describe('sttEngineOptions (no web-speech in Node)', () => {
    it('local mode offers Whisper then the hosted option', () => {
        expect(sttEngineOptions(false).map((o) => o.value)).toEqual(['whisper', 'aloud']);
    });
    it('web mode hides Whisper (local-only)', () => {
        expect(sttEngineOptions(true).map((o) => o.value)).toEqual(['aloud']);
    });
});

describe('defaultSttChoice = first option in flow order', () => {
    it('defaults to Whisper locally, hosted on the web', () => {
        expect(defaultSttChoice(false)).toBe('whisper');
        expect(defaultSttChoice(true)).toBe('aloud');
    });
});

describe('resolveSttChoice', () => {
    it('uses the flow default when nothing is stored', () => {
        expect(resolveSttChoice(null, false)).toBe('whisper');
        expect(resolveSttChoice(null, true)).toBe('aloud');
    });
    it('honors a stored pick that is offered in this mode', () => {
        expect(resolveSttChoice('aloud', false)).toBe('aloud');
    });
    it('falls back to the default when the stored pick is not offered here', () => {
        // Whisper carried into web mode is unavailable → hosted default.
        expect(resolveSttChoice('whisper', true)).toBe('aloud');
        // web-speech isn't offered in Node at all → local default Whisper.
        expect(resolveSttChoice('web-speech', false)).toBe('whisper');
    });
});
