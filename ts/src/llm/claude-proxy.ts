/**
 * Claude provider using the local `claude` CLI for subscription routing.
 *
 * Shells out to `claude -p` (headless mode) so the user's Pro/Max
 * subscription quota is used instead of API credits. Each completion
 * spawns a fresh subprocess, passes the system prompt via
 * --system-prompt (which fully replaces Claude Code's default), and
 * parses the JSON response.
 *
 * TS port of src/llm/claude_proxy.py. Node-only — uses node:child_process
 * to spawn the binary. Not usable in the browser or Capacitor WebView;
 * callers that target multiple runtimes should feature-check before
 * constructing.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type {
    CompletionOptions,
    CompletionResult,
    LLMProvider,
    Message,
} from './base.js';

const DEFAULT_MODEL = 'sonnet';
const DEFAULT_MAX_TOKENS = 300;
const DEFAULT_TIMEOUT_MS = 90_000;

export interface ClaudeProxyProviderOptions {
    /** Model alias the `claude` CLI understands — sonnet/haiku/opus or a full ID. */
    model?: string;
    /** Hard cap on per-completion run time (default 90s). */
    timeoutMs?: number;
    /**
     * Override the binary path. Default: auto-discovered via PATH and a
     * few common install locations.
     */
    binaryPath?: string;
    /** maxTokens — accepted for API parity, but the `claude` CLI ignores it. */
    maxTokens?: number;
}

interface ClaudeCliResponse {
    is_error?: boolean;
    result?: string;
    stop_reason?: string | null;
    api_error_status?: string;
    usage?: {
        input_tokens?: number;
        output_tokens?: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
}

export class ClaudeProxyProvider implements LLMProvider {
    readonly model: string;
    readonly maxTokens: number;
    private readonly timeoutMs: number;
    private readonly binaryPathOverride: string | undefined;

    constructor(options: ClaudeProxyProviderOptions = {}) {
        this.model = options.model ?? DEFAULT_MODEL;
        this.maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        this.binaryPathOverride = options.binaryPath;
    }

    async complete(
        messages: Message[],
        options: CompletionOptions = {}
    ): Promise<CompletionResult> {
        const binary = this.binaryPathOverride ?? (await findClaudeCli());
        if (!binary) {
            throw new Error(
                'claude CLI not found on PATH. Install Claude Code to use ' +
                    'the Anthropic Subscription provider.'
            );
        }

        const prompt = formatHistory(messages);
        const args = [
            '-p',
            '--tools',
            '',
            '--no-session-persistence',
            '--disable-slash-commands',
            '--output-format',
            'json',
            '--model',
            this.model,
        ];
        if (options.system) {
            args.push('--system-prompt', options.system);
        }
        args.push(prompt);

        const { stdout, exitCode, signal } = await runProcess(binary, args, this.timeoutMs);

        if (exitCode !== 0) {
            throw new Error(
                `claude CLI failed (exit ${exitCode ?? 'null'}` +
                    (signal ? `, signal ${signal}` : '') +
                    ')'
            );
        }

        let data: ClaudeCliResponse;
        try {
            data = JSON.parse(stdout) as ClaudeCliResponse;
        } catch (err) {
            throw new Error(
                `claude CLI returned invalid JSON: ${(err as Error).message}`
            );
        }

        if (data.is_error) {
            throw new Error(
                `claude CLI error: ${data.result ?? data.api_error_status ?? 'unknown'}`
            );
        }

        const usage = data.usage ?? {};
        const inputTokens = usage.input_tokens ?? 0;
        const outputTokens = usage.output_tokens ?? 0;
        const tokensUsed = usage.input_tokens !== undefined ? inputTokens + outputTokens : null;

        return {
            text: data.result ?? '',
            finishReason: data.stop_reason ?? null,
            tokensUsed,
        };
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Encode multi-turn history as a single prompt string. The `claude` CLI
 * takes one prompt argument, so prior turns are passed inline as a
 * "User: ... / Assistant: ..." transcript. System messages are dropped;
 * the system prompt is set via --system-prompt instead.
 */
function formatHistory(messages: readonly Message[]): string {
    const convo = messages.filter((m) => m.role !== 'system');
    if (convo.length === 0) return '';
    if (convo.length === 1 && convo[0]!.role === 'user') {
        return convo[0]!.content;
    }
    return convo
        .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content}`)
        .join('\n\n');
}

/**
 * Search the user's PATH and common install locations for the `claude`
 * binary. Mirrors src/web/provider_routes.py::find_claude_cli — the
 * macOS app bundle's limited PATH often misses ~/.local/bin, so we
 * check that location explicitly.
 */
async function findClaudeCli(): Promise<string | null> {
    const path = process.env['PATH'] ?? '';
    const pathSep = process.platform === 'win32' ? ';' : ':';
    for (const dir of path.split(pathSep)) {
        if (!dir) continue;
        const candidate = join(dir, process.platform === 'win32' ? 'claude.exe' : 'claude');
        if (await isExecutable(candidate)) return candidate;
    }
    const home = homedir();
    for (const candidate of [
        join(home, '.local', 'bin', 'claude'),
        '/opt/homebrew/bin/claude',
        '/usr/local/bin/claude',
        join(home, 'bin', 'claude'),
    ]) {
        if (await isExecutable(candidate)) return candidate;
    }
    return null;
}

async function isExecutable(path: string): Promise<boolean> {
    try {
        await access(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

interface ProcessResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
}

function runProcess(
    binary: string,
    args: readonly string[],
    timeoutMs: number
): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
        let proc: ChildProcess;
        try {
            proc = spawn(binary, args as string[], { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            reject(err);
            return;
        }
        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        proc.stdout?.on('data', (c: Buffer) => stdoutChunks.push(c));
        proc.stderr?.on('data', (c: Buffer) => stderrChunks.push(c));

        const timeout = setTimeout(() => {
            proc.kill('SIGKILL');
        }, timeoutMs);

        proc.on('error', (err) => {
            clearTimeout(timeout);
            reject(err);
        });
        proc.on('close', (code, signal) => {
            clearTimeout(timeout);
            resolve({
                stdout: Buffer.concat(stdoutChunks).toString('utf-8'),
                stderr: Buffer.concat(stderrChunks).toString('utf-8'),
                exitCode: code,
                signal,
            });
        });
    });
}
