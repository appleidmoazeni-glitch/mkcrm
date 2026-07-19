import type { JobCancellationToken } from './JobCancellation.js';
import { JobHeartbeat } from './JobHeartbeat.js';
import type { JobLogger } from './JobLogger.js';
import { JobMetrics } from './JobMetrics.js';
import { JobProgress, type JobProgressSnapshot, type JobProgressUpdate } from './JobProgress.js';

export type JobStatus = 'running' | 'completed' | 'failed' | 'cancelled';

/** Services available to a job during one execution. */
export class JobContext {
  readonly progress = new JobProgress();
  readonly heartbeat = new JobHeartbeat();
  readonly metrics = new JobMetrics();

  constructor(
    readonly cancellation: JobCancellationToken,
    readonly logger: JobLogger
  ) {}

  reportProgress(update: JobProgressUpdate): JobProgressSnapshot {
    this.heartbeatNow();
    return this.progress.update(update);
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
  protected abstract run(context: JobContext): Promise<void>;

  /** Called by JobManager; application code should start jobs through the manager. */
  execute(context: JobContext): Promise<void> { return this.run(context); }
}
