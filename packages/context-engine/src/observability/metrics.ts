/**
 * Metrics — Token usage tracking and compaction event recording.
 *
 * Every frame assembly emits a FrameMetrics object that can be:
 * - Written to .vault/_logs/
 * - Exposed via the relay server's system:event stream
 * - Aggregated by the daemon for weekly reports
 */

import type { ContextFrame, CompactionEvent } from "../types.js";

export interface FrameMetrics {
    frameId: string;
    model: string;
    profile: string;
    totalBudget: number;
    totalUsed: number;
    utilizationPct: number;
    layerBreakdown: Record<
        string,
        { allocated: number; used: number; compacted: boolean }
    >;
    compactionEvents: CompactionEvent[];
    assemblyTimeMs: number;
    chunkIndexHits: number;
    threadTurnsIncluded: number;
    threadTurnsSummarized: number;
}

/**
 * Extract metrics from a fully assembled ContextFrame.
 */
export function extractMetrics(frame: ContextFrame): FrameMetrics {
    const layerBreakdown: Record<
        string,
        { allocated: number; used: number; compacted: boolean }
    > = {};

    for (const [layer, budget] of Object.entries(frame.budget.layers)) {
        layerBreakdown[layer] = {
            allocated: budget.allocated,
            used: budget.used,
            compacted: budget.compacted,
        };
    }

    return {
        frameId: frame.frameId,
        model: frame.meta.model,
        profile: frame.meta.profile,
        totalBudget: frame.budget.limit,
        totalUsed: frame.budget.totalUsed,
        utilizationPct: frame.budget.utilizationPct,
        layerBreakdown,
        compactionEvents: frame.meta.compactionEvents,
        assemblyTimeMs: frame.meta.assemblyTimeMs,
        chunkIndexHits: frame.meta.chunkIndexHits,
        threadTurnsIncluded: frame.meta.threadTurnsIncluded,
        threadTurnsSummarized: frame.meta.threadTurnsSummarized,
    };
}

/**
 * Simple in-memory metrics collector.
 * Stores the last N frames' metrics for observability.
 */
export class MetricsCollector {
    private history: FrameMetrics[] = [];
    private maxHistory: number;

    constructor(maxHistory = 100) {
        this.maxHistory = maxHistory;
    }

    /**
     * Record metrics from a frame.
     */
    record(frame: ContextFrame): FrameMetrics {
        const metrics = extractMetrics(frame);
        this.history.push(metrics);

        // Trim oldest entries
        if (this.history.length > this.maxHistory) {
            this.history = this.history.slice(-this.maxHistory);
        }

        return metrics;
    }

    /**
     * Get all recorded metrics.
     */
    getAll(): FrameMetrics[] {
        return [...this.history];
    }

    /**
     * Get average utilization across all recorded frames.
     */
    getAverageUtilization(): number {
        if (this.history.length === 0) return 0;
        const sum = this.history.reduce((s, m) => s + m.utilizationPct, 0);
        return Math.round(sum / this.history.length);
    }

    /**
     * Get compaction frequency (% of frames that triggered compaction).
     */
    getCompactionRate(): number {
        if (this.history.length === 0) return 0;
        const compacted = this.history.filter(
            (m) => m.compactionEvents.length > 0
        ).length;
        return Math.round((compacted / this.history.length) * 100);
    }

    /**
     * Reset all metrics.
     */
    reset(): void {
        this.history = [];
    }
}
