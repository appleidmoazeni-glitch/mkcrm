"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobMetrics = void 0;
/** In-memory counters and timestamps for one execution. Duration is milliseconds. */
class JobMetrics {
    startedAt;
    lastUpdatedAt;
    processed = 0;
    errorCount = 0;
    retryCount = 0;
    namedCounters = new Map();
    finishedAt;
    constructor(now = new Date()) { this.startedAt = now; this.lastUpdatedAt = now; }
    touch(now = new Date()) { if (!this.finishedAt)
        this.lastUpdatedAt = now; }
    addProcessedItems(count = 1) { this.processed += Math.max(0, count); this.touch(); }
    recordError(count = 1) { this.errorCount += Math.max(0, count); this.touch(); }
    recordRetry(count = 1) { this.retryCount += Math.max(0, count); this.touch(); }
    setCounter(name, value) { this.namedCounters.set(name, Math.max(0, value)); this.touch(); }
    incrementCounter(name, count = 1) { this.setCounter(name, (this.namedCounters.get(name) ?? 0) + count); }
    finish(now = new Date()) {
        if (this.finishedAt)
            return;
        this.finishedAt = now;
        this.lastUpdatedAt = now;
    }
    snapshot(now = new Date()) {
        const durationEnd = this.finishedAt ?? now;
        return {
            startedAt: new Date(this.startedAt.getTime()),
            completedAt: this.finishedAt ? new Date(this.finishedAt.getTime()) : undefined,
            updatedAt: new Date(this.lastUpdatedAt.getTime()),
            duration: Math.max(0, durationEnd.getTime() - this.startedAt.getTime()),
            processedItems: this.processed,
            errors: this.errorCount,
            retries: this.retryCount,
            counters: Object.freeze(Object.fromEntries(this.namedCounters))
        };
    }
}
exports.JobMetrics = JobMetrics;
