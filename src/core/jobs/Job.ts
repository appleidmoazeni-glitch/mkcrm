import type { JobCancellationToken } from './JobCancellation.js';
import { JobHeartbeat } from './JobHeartbeat.js';
import type { JobEngineError } from './JobError.js';
import type { JobLogger } from './JobLogger.js';
import { JobMetrics } from './JobMetrics.js';
import { JobProgress, type JobProgressSnapshot, type JobProgressUpdate } from './JobProgress.js';
import type { JobStatus } from './JobStatus.js';

export type JobLifecycleHook = (context: JobContext) => void | Promise<void>;
export type JobErrorHook = (error: JobEngineError, context: JobContext) => void | Promise<void>;

/** Immutable execution boundary passed to a job; its service objects own mutations. */
export class JobContext {
  readonly progress = new JobProgress();
  readonly heartbeat = new JobHeartbeat();
  readonly metrics = new JobMetrics();

  constructor(
    readonly cancellationToken: JobCancellationToken,
    readonly logger: JobLogger,
    private readonly readStatus: () => JobStatus,
    private readonly onProgress?: (progress: JobProgressSnapshot) => void
  ) { Object.freeze(this); }

  get status(): JobStatus { return this.readStatus(); }

  reportProgress(update: JobProgressUpdate): JobProgressSnapshot {
    this.heartbeatNow();
    const snapshot = this.progress.update(update);
    this.onProgress?.(snapshot);
    return snapshot;
  }

  heartbeatNow(): Date {
    this.metrics.touch();
    return this.heartbeat.beat();
  }
}

/**
 * Base class for future jobs. Implementations provide only a stable name and
 * their cooperative `run` method; orchestration remains in JobManager.
 */
export abstract class BackgroundJob {
  abstract readonly name: string;
  abstract readonly version: number;
  beforeStart?: JobLifecycleHook;
  afterStart?: JobLifecycleHook;
  beforeCancel?: JobLifecycleHook;
  afterCancel?: JobLifecycleHook;
  beforeComplete?: JobLifecycleHook;
  afterComplete?: JobLifecycleHook;
  onError?: JobErrorHook;
  protected abstract run(context: JobContext): Promise<void>;

  /** Called by JobManager; application code should start jobs through the manager. */
  execute(context: JobContext): Promise<void> { return this.run(context); }
}
