import { JobCancelledError, JobCancellationSource } from './JobCancellation.js';
import { JobContext, type JobStatus } from './Job.js';
import { JobLock, type JobLockHandle } from './JobLock.js';
import { NoopJobLogger, type JobLogger } from './JobLogger.js';
import type { JobMetricsSnapshot } from './JobMetrics.js';
import type { JobProgressSnapshot } from './JobProgress.js';
import type { JobRegistry } from './JobRegistry.js';

export interface JobExecutionSnapshot {
  readonly id: string;
  readonly name: string;
  readonly status: JobStatus;
  readonly progress: JobProgressSnapshot;
  readonly heartbeatAt: Date;
  readonly metrics: JobMetricsSnapshot;
  readonly error: string | undefined;
}

export interface JobHandle {
  readonly id: string;
  readonly name: string;
  readonly completion: Promise<JobExecutionSnapshot>;
  cancel(reason?: string): boolean;
  snapshot(): JobExecutionSnapshot;
}

interface RunningExecution {
  readonly id: string;
  readonly name: string;
  readonly context: JobContext;
  readonly cancellation: JobCancellationSource;
  readonly lock: JobLockHandle;
  status: JobStatus;
  error: string | undefined;
}

export class JobAlreadyRunningError extends Error {
  constructor(jobName: string) { super(`Job is already running: ${jobName}`); this.name = 'JobAlreadyRunningError'; }
}

/** Coordinates factories, per-type locking, lifecycle state and cancellation. */
export class JobManager {
  private readonly lock = new JobLock();
  private readonly running = new Map<string, RunningExecution>();
  private readonly latest = new Map<string, JobExecutionSnapshot>();
  private sequence = 0;

  constructor(
    private readonly registry: JobRegistry,
    private readonly logger: JobLogger = new NoopJobLogger()
  ) {}

  start(name: string): JobHandle {
    const lock = this.lock.acquire(name);
    if (!lock) throw new JobAlreadyRunningError(name);

    try {
      const job = this.registry.create(name);
      const cancellation = new JobCancellationSource();
      const context = new JobContext(cancellation.token, this.logger);
      const execution: RunningExecution = {
        id: `${name}:${Date.now()}:${++this.sequence}`,
        name,
        context,
        cancellation,
        lock,
        status: 'running',
        error: undefined
      };
      this.running.set(name, execution);
      this.logger.info('Background job started', { jobId: execution.id, jobName: name });
      const completion = this.run(job.execute(context), execution);
      return {
        id: execution.id,
        name,
        completion,
        cancel: reason => cancellation.cancel(reason),
        snapshot: () => this.snapshotExecution(execution)
      };
    } catch (error) {
      this.running.delete(name);
      this.lock.release(lock);
      throw error;
    }
  }

  isRunning(name: string): boolean { return this.running.has(name); }
  getRunning(name: string): JobExecutionSnapshot | undefined {
    const execution = this.running.get(name);
    return execution ? this.snapshotExecution(execution) : undefined;
  }
  getLatest(name: string): JobExecutionSnapshot | undefined { return this.latest.get(name); }
  listRunning(): readonly JobExecutionSnapshot[] { return [...this.running.values()].map(item => this.snapshotExecution(item)); }
  cancel(name: string, reason?: string): boolean { return this.running.get(name)?.cancellation.cancel(reason) ?? false; }

  private async run(completion: Promise<void>, execution: RunningExecution): Promise<JobExecutionSnapshot> {
    try {
      await completion;
      execution.status = 'completed';
    } catch (error) {
      if (error instanceof JobCancelledError) {
        execution.status = 'cancelled';
      } else {
        execution.status = 'failed';
        execution.error = error instanceof Error ? error.message : String(error);
        execution.context.metrics.recordError();
        this.logger.error('Background job failed', { jobId: execution.id, jobName: execution.name, error: execution.error });
      }
    } finally {
      execution.context.heartbeatNow();
      execution.context.metrics.finish();
      this.running.delete(execution.name);
      this.lock.release(execution.lock);
    }
    const snapshot = this.snapshotExecution(execution);
    this.latest.set(execution.name, snapshot);
    this.logger.info('Background job finished', { jobId: execution.id, jobName: execution.name, status: execution.status });
    return snapshot;
  }

  private snapshotExecution(execution: RunningExecution): JobExecutionSnapshot {
    return {
      id: execution.id,
      name: execution.name,
      status: execution.status,
      progress: execution.context.progress.snapshot(),
      heartbeatAt: execution.context.heartbeat.lastHeartbeatAt,
      metrics: execution.context.metrics.snapshot(),
      error: execution.error
    };
  }
}
