import { JobEngineError, JobErrorCode } from './JobError.js';

/** Canonical lifecycle states for every engine execution. */
export enum JobStatus {
  Pending = 'Pending',
  Running = 'Running',
  Cancelling = 'Cancelling',
  Completed = 'Completed',
  Failed = 'Failed',
  Cancelled = 'Cancelled'
}

const transitions: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  [JobStatus.Pending]: new Set([JobStatus.Running, JobStatus.Cancelling, JobStatus.Failed, JobStatus.Cancelled]),
  [JobStatus.Running]: new Set([JobStatus.Cancelling, JobStatus.Completed, JobStatus.Failed, JobStatus.Cancelled]),
  [JobStatus.Cancelling]: new Set([JobStatus.Completed, JobStatus.Cancelled, JobStatus.Failed]),
  [JobStatus.Completed]: new Set(),
  [JobStatus.Failed]: new Set(),
  [JobStatus.Cancelled]: new Set()
};

export type JobStatusListener = (previous: JobStatus, current: JobStatus) => void;

/** Validates and owns status transitions for one execution. */
export class JobStatusMachine {
  private currentStatus = JobStatus.Pending;

  constructor(private readonly onTransition?: JobStatusListener) {}

  get current(): JobStatus { return this.currentStatus; }
  canTransition(next: JobStatus): boolean { return transitions[this.currentStatus].has(next); }

  transition(next: JobStatus): void {
    const previous = this.currentStatus;
    if (!this.canTransition(next)) {
      throw new JobEngineError(JobErrorCode.Internal, `Illegal job status transition: ${previous} -> ${next}`);
    }
    this.currentStatus = next;
    this.onTransition?.(previous, next);
  }
}
