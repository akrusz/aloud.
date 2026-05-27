/**
 * Post-session summary generation.
 *
 * TS port of meditation_session.py::generate_summary — sends the
 * conversation back to the LLM and asks for a 10-words-or-fewer
 * summary line to display in the history list.
 */

import type { LLMProvider, Message } from '../llm/index.js';

const SUMMARY_SYSTEM_PROMPT =
    'You are a helpful assistant. The conversation above is a completed ' +
    'meditation session between a facilitator and a meditator. Your job ' +
    "is to produce a brief summary of the session for the meditator's " +
    'history log. Respond with only the summary, nothing else.';

const SUMMARY_USER_PROMPT =
    'Summarize this meditation session in at most 10 words. ' +
    'Just the summary, nothing else.';

export interface GenerateSummaryOptions {
    /** Override the max-tokens hint for shorter completions. */
    maxTokens?: number;
}

/**
 * Generate a short summary for a finished session. Returns an empty
 * string if the LLM returns nothing usable; never throws upstream — the
 * caller can fall back to intention or "" without try/catch.
 */
export async function generateSessionSummary(
    provider: LLMProvider,
    messages: ReadonlyArray<{ role: 'user' | 'assistant' | 'system'; content: string }>,
    options: GenerateSummaryOptions = {}
): Promise<string> {
    const llmMessages: Message[] = [...messages.map((m) => ({ role: m.role, content: m.content }))];
    llmMessages.push({ role: 'user', content: SUMMARY_USER_PROMPT });

    try {
        const result = await provider.complete(llmMessages, {
            system: SUMMARY_SYSTEM_PROMPT,
            maxTokens: options.maxTokens ?? 60,
        });
        return stripThinkTags(result.text).trim();
    } catch {
        return '';
    }
}

/**
 * Some open-weights models (Qwen 3, DeepSeek-R1, etc.) emit a
 * <think>...</think> reasoning block before the answer. Strip it so the
 * summary line stays clean.
 */
function stripThinkTags(text: string): string {
    return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
