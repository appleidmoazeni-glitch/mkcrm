/** Error used to distinguish cooperative cancellation from job failure. */
export class JobCancelledError extends Error {
  constructor(message = 'Job was cancelled') {
    super(message);
    this.name = 'JobCancelledError';
  }
}

/** Read-only cancellation contract passed to a running job. */
export interface JobCancellationToken {
  readonly isCancellationRequested: boolean;
  readonly reason: string | undefined;
  throwIfCancellationRequested(): void;
}

/** Owns the mutable side of a cancellation token. Cancellation is cooperative. */
export class JobCancellationSource implements JobCancellationToken {
  private cancelled = false;
  private cancellationReason: string | undefined;
  readonly token: JobCancellationToken = this;

  get isCancellationRequested(): boolean { return this.cancelled; }
  get reason(): string | undefined { return this.cancellationReason; }
  throwIfCancellationRequested(): void {
    if (this.cancelled) throw new JobCancelledError(this.cancellationReason);
  }

  cancel(reason = 'Job was cancelled'): boolean {
    if (this.cancelled) return false;
    this.cancelled = true;
    this.cancellationReason = reason;
    return true;
  }
}
