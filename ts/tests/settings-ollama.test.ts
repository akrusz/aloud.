import { describe, it, expect } from 'vitest';
import { __test, escapeHtml } from '../ui/src/settings-ollama.js';

const { renderHTML, renderTier } = __test;

const TIER_QWEN = {
    model: 'qwen3.5:4b',
    label: 'Acceptable',
    download: '~3.4GB',
    ram: '~5GB',
    note: 'Smallest size and fast on any hardware.',
    min_gb: 0,
    fits: true,
    installed: false,
};

const TIER_GEMMA_E4B = {
    model: 'gemma4:e4b',
    label: 'Decent',
    download: '~9.6GB',
    ram: '~10GB',
    note: "Google's edge model.",
    min_gb: 16,
    fits: true,
    installed: true,
};

describe('escapeHtml', () => {
    it('escapes the entity-significant ASCII chars', () => {
        expect(escapeHtml(`<a href="x">y & 'z'</a>`)).toBe(
            '&lt;a href=&quot;x&quot;&gt;y &amp; &#39;z&#39;&lt;/a&gt;'
        );
    });
});

describe('renderTier', () => {
    it('marks the recommended tier and shows Download', () => {
        const html = renderTier(TIER_QWEN, 'qwen3.5:4b');
        expect(html).toContain('is-recommended');
        expect(html).toContain('ollama-tier-badge');
        expect(html).toContain('ollama-pull-btn');
        expect(html).not.toContain('ollama-remove-btn');
        expect(html).toContain('data-model="qwen3.5:4b"');
    });

    it('shows Remove + is-installed when the tier is installed', () => {
        const html = renderTier(TIER_GEMMA_E4B, 'qwen3.5:4b');
        expect(html).toContain('is-installed');
        expect(html).toContain('ollama-remove-btn');
        expect(html).not.toContain('ollama-pull-btn');
    });

    it("adds a Needs-N-GB warning when a tier doesn't fit", () => {
        const tooBig = { ...TIER_GEMMA_E4B, min_gb: 32, fits: false, installed: false };
        const html = renderTier(tooBig, 'qwen3.5:4b');
        expect(html).toContain('wont-fit');
        expect(html).toContain('Needs 32 GB');
    });
});

describe('renderHTML', () => {
    it('returns empty when no recommendation tiers', () => {
        expect(renderHTML({})).toBe('');
    });

    it('renders the hint when no tiers but Ollama is unreachable', () => {
        const html = renderHTML({ hint: 'Ollama is not installed.' });
        expect(html).toContain('Ollama is not installed.');
    });

    it('shows the detected RAM and the outdated banner', () => {
        const html = renderHTML({
            version: '0.18.0',
            outdated: true,
            min_version: '0.21.0',
            recommendation: {
                ram_gb: 16,
                recommended_model: 'gemma4:e4b',
                recommended_label: 'Decent',
                tiers: [TIER_GEMMA_E4B, TIER_QWEN],
                other_installed: [],
            },
        });
        expect(html).toContain('Detected: 16 GB RAM');
        expect(html).toContain('outdated and may not be able');
        expect(html).toContain('v0.18.0');
        expect(html).toContain('v0.21.0');
        // Both tiers rendered.
        expect(html).toContain('gemma4:e4b');
        expect(html).toContain('qwen3.5:4b');
    });

    it('renders the other-installed list with Remove buttons', () => {
        const html = renderHTML({
            recommendation: {
                tiers: [TIER_QWEN],
                other_installed: [{ model: 'mistral:latest', size: '4.1GB' }],
            },
        });
        expect(html).toContain('ollama-others-block');
        expect(html).toContain('mistral:latest');
        expect(html).toContain('4.1GB');
        // Has a Remove button targeting mistral.
        expect(html).toContain('data-model="mistral:latest"');
    });
});
