/** Stable progress shape shared by every background job. */
export interface JobProgressSnapshot {
  readonly phase: string;
  readonly current: number;
  readonly total: number;
  readonly percent: number;
  readonly message: string;
}

export type JobProgressUpdate = Partial<Omit<JobProgressSnapshot, 'percent'>>;

/** Normalizes progress updates and derives a bounded percentage. */
export class JobProgress {
  private state: JobProgressSnapshot = { phase: 'pending', current: 0, total: 0, percent: 0, message: '' };

  update(update: JobProgressUpdate): JobProgressSnapshot {
    const current = Math.max(0, update.current ?? this.state.current);
    const total = Math.max(0, update.total ?? this.state.total);
    const percent = total > 0 ? Math.min(100, Math.max(0, (current / total) * 100)) : 0;
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
