/** Immutable metrics view safe to expose to monitoring code. */
export interface JobMetricsSnapshot {
  readonly startedAt: Date;
  readonly completedAt: Date | undefined;
  readonly updatedAt: Date;
  readonly duration: number;
  readonly processedItems: number;
  readonly errors: number;
  readonly retries: number;
  readonly counters: Readonly<Record<string, number>>;
}

/** In-memory counters and timestamps for one execution. Duration is milliseconds. */
export class JobMetrics {
  readonly startedAt: Date;
  private lastUpdatedAt: Date;
  private processed = 0;
  private errorCount = 0;
  private retryCount = 0;
  private readonly namedCounters = new Map<string, number>();
  private finishedAt: Date | undefined;

  constructor(now: Date = new Date()) { this.startedAt = now; this.lastUpdatedAt = now; }

  touch(now: Date = new Date()): void { if (!this.finishedAt) this.lastUpdatedAt = now; }
  addProcessedItems(count = 1): void { this.processed += Math.max(0, count); this.touch(); }
  recordError(count = 1): void { this.errorCount += Math.max(0, count); this.touch(); }
  recordRetry(count = 1): void { this.retryCount += Math.max(0, count); this.touch(); }
  setCounter(name: string, value: number): void { this.namedCounters.set(name, Math.max(0, value)); this.touch(); }
  incrementCounter(name: string, count = 1): void { this.setCounter(name, (this.namedCounters.get(name) ?? 0) + count); }
  finish(now: Date = new Date()): void {
    if (this.finishedAt) return;
    this.finishedAt = now;
    this.lastUpdatedAt = now;
  }

  snapshot(now: Date = new Date()): JobMetricsSnapshot {
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
