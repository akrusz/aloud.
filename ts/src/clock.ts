/**
 * Injectable clock — lets the orchestration layer be tested with a fake
 * time source without resorting to vi.useFakeTimers everywhere. Returns
 * seconds since the Unix epoch (to match the Python original, which uses
 * time.time()).
 */
export type Clock = () => number;

export const realClock: Clock = () => Date.now() / 1000;

/**
 * Build a controllable clock for tests. Start at `start` and advance with
 * `tick(seconds)`. Useful when verifying timing-based decisions.
 */
export function createFakeClock(start = 0): {
    clock: Clock;
    set: (t: number) => void;
    tick: (seconds: number) => void;
} {
    let now = start;
    return {
        clock: () => now,
        set: (t: number) => { now = t; },
        tick: (seconds: number) => { now += seconds; },
    };
}
