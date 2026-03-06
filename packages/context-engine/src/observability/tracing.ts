/**
 * Tracing — Frame assembly tracing linked to relay trace IDs.
 *
 * Provides lightweight tracing for debugging frame assembly.
 * Links frame IDs to relay adapter trace IDs for end-to-end observability.
 */

export interface TraceEntry {
    frameId: string;
    /** External trace ID from the relay adapter */
    relayTraceId?: string;
    /** Timestamp of frame assembly start */
    startedAt: string;
    /** Assembly duration in ms */
    durationMs: number;
    /** Model the frame was built for */
    model: string;
    /** Budget profile used */
    profile: string;
    /** Summary of what happened during assembly */
    events: string[];
}

/**
 * Simple trace logger — stores recent traces for debugging.
 */
export class TraceLogger {
    private traces: TraceEntry[] = [];
    private maxTraces: number;

    constructor(maxTraces = 50) {
        this.maxTraces = maxTraces;
    }

    /**
     * Record a trace entry.
     */
    record(entry: TraceEntry): void {
        this.traces.push(entry);
        if (this.traces.length > this.maxTraces) {
            this.traces = this.traces.slice(-this.maxTraces);
        }
    }

    /**
     * Get trace by frame ID.
     */
    getByFrameId(frameId: string): TraceEntry | undefined {
        return this.traces.find((t) => t.frameId === frameId);
    }

    /**
     * Get recent traces.
     */
    getRecent(limit = 10): TraceEntry[] {
        return this.traces.slice(-limit);
    }

    /**
     * Reset all traces.
     */
    reset(): void {
        this.traces = [];
    }
}
