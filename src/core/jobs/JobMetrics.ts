/** Immutable metrics view safe to expose to monitoring code. */
export interface JobMetricsSnapshot {
  readonly startedAt: Date;
  readonly updatedAt: Date;
  readonly duration: number;
  readonly processedItems: number;
  readonly errors: number;
  readonly retries: number;
}

/** In-memory counters and timestamps for one execution. Duration is milliseconds. */
export class JobMetrics {
  readonly startedAt: Date;
  private lastUpdatedAt: Date;
  private processed = 0;
  private errorCount = 0;
  private retryCount = 0;
  private finishedAt: Date | undefined;

  constructor(now: Date = new Date()) { this.startedAt = now; this.lastUpdatedAt = now; }

  touch(now: Date = new Date()): void { this.lastUpdatedAt = now; }
  addProcessedItems(count = 1): void { this.processed += Math.max(0, count); this.touch(); }
  recordError(count = 1): void { this.errorCount += Math.max(0, count); this.touch(); }
  recordRetry(count = 1): void { this.retryCount += Math.max(0, count); this.touch(); }
  finish(now: Date = new Date()): void { this.finishedAt = now; this.lastUpdatedAt = now; }

  snapshot(now: Date = new Date()): JobMetricsSnapshot {
    const durationEnd = this.finishedAt ?? now;
    return {
      startedAt: new Date(this.startedAt.getTime()),
      updatedAt: new Date(this.lastUpdatedAt.getTime()),
      duration: Math.max(0, durationEnd.getTime() - this.startedAt.getTime()),
      processedItems: this.processed,
      errors: this.errorCount,
      retries: this.retryCount
    };
  }
}
