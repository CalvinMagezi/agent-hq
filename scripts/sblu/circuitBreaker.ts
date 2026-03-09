/**
 * SBLU Circuit Breaker
 *
 * Per-SBLU circuit breaker with three states:
 *   CLOSED    — normal operation, SBLU handles traffic
 *   OPEN      — SBLU bypassed, all traffic to baseline
 *   HALF_OPEN — probing: send one request to test recovery
 *
 * State transitions:
 *   CLOSED  → OPEN      when errorRate > 5% in a 10-minute window
 *   OPEN    → HALF_OPEN after 30 seconds
 *   HALF_OPEN → CLOSED  on 5 consecutive clean probes
 *   HALF_OPEN → OPEN    on any failure during probing
 */

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

interface CircuitBreakerOptions {
    /** Error rate threshold (0–1) to trip the breaker. Default: 0.05 (5%) */
    errorThreshold?: number;
    /** Rolling window in ms to measure error rate. Default: 600_000 (10 min) */
    windowMs?: number;
    /** How long to stay OPEN before probing. Default: 30_000 (30s) */
    openDurationMs?: number;
    /** Consecutive successes required to close from HALF_OPEN. Default: 5 */
    halfOpenSuccessThreshold?: number;
    /** Minimum calls before error rate is measured. Default: 3 */
    minCallsBeforeTripCheck?: number;
}

interface CallRecord {
    ts: number;
    success: boolean;
}

export class CircuitBreaker {
    private state: CircuitState = "CLOSED";
    private calls: CallRecord[] = [];
    private openedAt: number | null = null;
    private halfOpenSuccesses = 0;

    private readonly errorThreshold: number;
    private readonly windowMs: number;
    private readonly openDurationMs: number;
    private readonly halfOpenSuccessThreshold: number;
    private readonly minCallsBeforeTripCheck: number;

    constructor(options: CircuitBreakerOptions = {}) {
        this.errorThreshold = options.errorThreshold ?? 0.05;
        this.windowMs = options.windowMs ?? 600_000;
        this.openDurationMs = options.openDurationMs ?? 30_000;
        this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 5;
        this.minCallsBeforeTripCheck = options.minCallsBeforeTripCheck ?? 3;
    }

    /** Current circuit state */
    getState(): CircuitState {
        this.maybeTransitionFromOpen();
        return this.state;
    }

    /**
     * Returns true if the SBLU should handle this call.
     * Returns false if the baseline should handle it instead.
     */
    shouldRoute(): boolean {
        this.maybeTransitionFromOpen();
        if (this.state === "CLOSED") return true;
        if (this.state === "HALF_OPEN") return true; // probe attempt
        return false; // OPEN — bypass to baseline
    }

    /** Record a successful SBLU call */
    recordSuccess(): void {
        this.calls.push({ ts: Date.now(), success: true });
        this.pruneWindow();

        if (this.state === "HALF_OPEN") {
            this.halfOpenSuccesses++;
            if (this.halfOpenSuccesses >= this.halfOpenSuccessThreshold) {
                this.state = "CLOSED";
                this.halfOpenSuccesses = 0;
                this.openedAt = null;
                console.log("[circuit-breaker] HALF_OPEN → CLOSED after clean probes");
            }
        }
    }

    /** Record a failed SBLU call */
    recordFailure(): void {
        this.calls.push({ ts: Date.now(), success: false });
        this.pruneWindow();

        if (this.state === "HALF_OPEN") {
            // Any failure during probing sends us back to OPEN
            this.state = "OPEN";
            this.openedAt = Date.now();
            this.halfOpenSuccesses = 0;
            console.log("[circuit-breaker] HALF_OPEN → OPEN (probe failed)");
            return;
        }

        if (this.state === "CLOSED") {
            this.checkAndTrip();
        }
    }

    /** Snapshot of current metrics */
    getMetrics(): {
        state: CircuitState;
        errorRate: number;
        callsInWindow: number;
        halfOpenSuccesses: number;
        openedAt: number | null;
    } {
        this.pruneWindow();
        const total = this.calls.length;
        const errors = this.calls.filter(c => !c.success).length;
        return {
            state: this.state,
            errorRate: total > 0 ? errors / total : 0,
            callsInWindow: total,
            halfOpenSuccesses: this.halfOpenSuccesses,
            openedAt: this.openedAt,
        };
    }

    // ── Private ──────────────────────────────────────────────────────────

    private pruneWindow(): void {
        const cutoff = Date.now() - this.windowMs;
        this.calls = this.calls.filter(c => c.ts >= cutoff);
    }

    private checkAndTrip(): void {
        if (this.calls.length < this.minCallsBeforeTripCheck) return;
        const errors = this.calls.filter(c => !c.success).length;
        const rate = errors / this.calls.length;
        if (rate > this.errorThreshold) {
            this.state = "OPEN";
            this.openedAt = Date.now();
            console.log(
                `[circuit-breaker] CLOSED → OPEN (error rate ${(rate * 100).toFixed(1)}% > threshold ${(this.errorThreshold * 100).toFixed(1)}%)`,
            );
        }
    }

    private maybeTransitionFromOpen(): void {
        if (this.state === "OPEN" && this.openedAt !== null) {
            if (Date.now() - this.openedAt >= this.openDurationMs) {
                this.state = "HALF_OPEN";
                this.halfOpenSuccesses = 0;
                console.log("[circuit-breaker] OPEN → HALF_OPEN (probe interval elapsed)");
            }
        }
    }
}

// ── Module-level registry of breakers per SBLU name ───────────────────

const breakers = new Map<string, CircuitBreaker>();

/** Get (or lazily create) the circuit breaker for a named SBLU. */
export function getBreakerForSBLU(sbluName: string): CircuitBreaker {
    if (!breakers.has(sbluName)) {
        breakers.set(sbluName, new CircuitBreaker());
    }
    return breakers.get(sbluName)!;
}
