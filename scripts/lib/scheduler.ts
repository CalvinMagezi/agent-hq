/**
 * A drop-in replacement for setInterval that avoids "rapid-fire" drift accumulation
 * when the system sleeps/wakes, preventing a backlog of missed ticks from executing
 * all at once.
 */
export function driftAwareInterval(
    callback: () => void | Promise<void>,
    intervalMs: number
): () => void {
    let expectedNext = Date.now() + intervalMs;
    let timer: Timer | null = null;
    let isRunning = false;

    async function tick() {
        if (isRunning) {
            // Drop tick if previous execution is still running
            timer = setTimeout(tick, intervalMs);
            return;
        }

        const now = Date.now();
        const drift = now - expectedNext;

        // If we drifted significantly (e.g. system sleep), skip the missed ticks entirely
        if (drift > intervalMs) {
            console.warn(`[Scheduler] Detected clock drift of ${drift}ms. Resetting interval baseline to prevent burst execution.`);
            expectedNext = now;
        }

        isRunning = true;
        try {
            await callback();
        } catch (err) {
            console.error("[Scheduler] Error in interval callback:", err);
        } finally {
            isRunning = false;
        }

        expectedNext += intervalMs;
        const delayToNext = Math.max(0, expectedNext - Date.now());

        // Ensure we don't go below a reasonable tick floor if expectedNext is somehow still in the past
        timer = setTimeout(tick, delayToNext === 0 ? intervalMs : delayToNext);
    }

    timer = setTimeout(tick, intervalMs);

    return () => {
        if (timer) {
            clearTimeout(timer);
        }
    };
}
