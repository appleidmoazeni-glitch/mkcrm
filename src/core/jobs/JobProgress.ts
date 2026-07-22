/** Stable progress shape shared by every background job. */
export interface JobProgressSnapshot {
  readonly phase: string;
  readonly current: number;
  readonly total: number;
  readonly percent: number;
  readonly message: string;
}

export type JobProgressUpdate = Partial<JobProgressSnapshot>;

/** Normalizes progress updates and derives a bounded percentage. */
export class JobProgress {
  private state: JobProgressSnapshot = { phase: 'pending', current: 0, total: 0, percent: 0, message: '' };

  update(update: JobProgressUpdate): JobProgressSnapshot {
    const total = Math.max(0, update.total ?? this.state.total);
    const current = Math.min(total, Math.max(0, update.current ?? this.state.current));
    const calculatedPercent = update.percent ?? (total > 0 ? (current / total) * 100 : 0);
    const percent = Math.max(this.state.percent, Math.min(100, Math.max(0, calculatedPercent)));
    this.state = {
      phase: update.phase ?? this.state.phase,
      current,
      total,
      percent,
      message: update.message ?? this.state.message
    };
    return this.snapshot();
  }

  snapshot(): JobProgressSnapshot { return { ...this.state }; }
}
