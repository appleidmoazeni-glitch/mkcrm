import { JobCancelledError, JobCancellationSource } from './JobCancellation.js';
import { JobContext, type BackgroundJob, type JobLifecycleHook } from './Job.js';
import { JobEngineError, JobErrorCode } from './JobError.js';
import { JobEventEmitter } from './JobEvents.js';
import { JobLock, type JobLockHandle } from './JobLock.js';
import { NoopJobLogger, type JobLogger } from './JobLogger.js';
import type { JobMetricsSnapshot } from './JobMetrics.js';
import type { JobProgressSnapshot } from './JobProgress.js';
import type { JobRegistry } from './JobRegistry.js';
import { JobStatus, JobStatusMachine } from './JobStatus.js';

export interface JobExecutionSnapshot {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly status: JobStatus;
  readonly progress: JobProgressSnapshot;
  readonly heartbeatAt: Date;
  readonly metrics: JobMetricsSnapshot;
  readonly error: JobEngineError | undefined;
}

export interface JobHandle {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly completion: Promise<JobExecutionSnapshot>;
  cancel(reason?: string): Promise<boolean>;
  snapshot(): JobExecutionSnapshot;
}

interface RunningExecution {
  readonly id: string;
  readonly name: string;
  readonly version: number;
  readonly job: BackgroundJob;
  readonly context: JobContext;
  readonly cancellation: JobCancellationSource;
  readonly lock: JobLockHandle;
  readonly status: JobStatusMachine;
  error: JobEngineError | undefined;
}

export class JobAlreadyRunningError extends JobEngineError {
  constructor(jobName: string) {
    super(JobErrorCode.Locked, `Job is already running: ${jobName}`);
    this.name = 'JobAlreadyRunningError';
  }
}

/** Coordinates versioned definitions, locking, hooks, events and execution state. */
export class JobManager {
  private readonly lock = new JobLock();
  private readonly running = new Map<string, RunningExecution>();
  private readonly latest = new Map<string, JobExecutionSnapshot>();
  private sequence = 0;

  constructor(
    private readonly registry: JobRegistry,
    private readonly logger: JobLogger = new NoopJobLogger(),
    readonly events: JobEventEmitter = new JobEventEmitter()
  ) {}

  start(name: string, input?: unknown): JobHandle {
    const lock = this.lock.acquire(name);
    if (!lock) throw new JobAlreadyRunningError(name);

    try {
      const job = this.registry.create(name, input);
      const id = `${name}:v${job.version}:${Date.now()}:${++this.sequence}`;
      const cancellation = new JobCancellationSource();
      const status = new JobStatusMachine((previous, current) => {
        this.events.emit('job.statusChanged', { jobId: id, jobName: name, previous, current });
      });
      let execution: RunningExecution;
      const context = new JobContext(
        cancellation.token,
        this.logger,
        () => status.current,
        progress => this.events.emit('job.progress', { job: this.snapshotExecution(execution), progress })
      );
      execution = { id, name, version: job.version, job, context, cancellation, lock, status, error: undefined };
      this.running.set(name, execution);
      const completion = this.run(execution);
      return {
        id,
        name,
        version: job.version,
        completion,
        cancel: reason => this.requestCancellation(execution, reason),
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
  async cancel(name: string, reason?: string): Promise<boolean> {
    const execution = this.running.get(name);
    return execution ? this.requestCancellation(execution, reason) : false;
  }

  private async run(execution: RunningExecution): Promise<JobExecutionSnapshot> {
    try {
      await this.safeHook('beforeStart', execution.job.beforeStart, execution);
      execution.context.cancellationToken.throwIfCancellationRequested();
      execution.status.transition(JobStatus.Running);
      await this.safeHook('afterStart', execution.job.afterStart, execution);
      this.logger.info('Background job started', this.logContext(execution));
      this.events.emit('job.started', this.snapshotExecution(execution));

      await execution.job.execute(execution.context);
      await this.safeHook('beforeComplete', execution.job.beforeComplete, execution);
      execution.status.transition(JobStatus.Completed);
      await this.safeHook('afterComplete', execution.job.afterComplete, execution);
      this.finishTelemetry(execution);
      this.events.emit('job.completed', this.snapshotExecution(execution));
    } catch (error) {
      if (error instanceof JobCancelledError) {
        execution.error = error;
        execution.status.transition(JobStatus.Cancelled);
        this.finishTelemetry(execution);
        this.events.emit('job.cancelled', this.snapshotExecution(execution));
      } else {
        execution.error = this.normalizeFailure(error);
        execution.context.metrics.recordError();
        execution.status.transition(JobStatus.Failed);
        await this.safeErrorHook(execution.error, execution);
        this.logger.error('Background job failed', { ...this.logContext(execution), code: execution.error.code, error: execution.error.message });
        this.finishTelemetry(execution);
        this.events.emit('job.failed', this.snapshotExecution(execution));
      }
    } finally {
      this.finishTelemetry(execution);
      this.running.delete(execution.name);
      this.lock.release(execution.lock);
    }

    const snapshot = this.snapshotExecution(execution);
    this.latest.set(execution.name, snapshot);
    this.logger.info('Background job finished', { ...this.logContext(execution), status: execution.status.current });
    return snapshot;
  }

  private async requestCancellation(execution: RunningExecution, reason?: string): Promise<boolean> {
    if (execution.status.current !== JobStatus.Pending && execution.status.current !== JobStatus.Running) return false;
    await this.safeHook('beforeCancel', execution.job.beforeCancel, execution);
    if (execution.status.current !== JobStatus.Pending && execution.status.current !== JobStatus.Running) return false;
    execution.status.transition(JobStatus.Cancelling);
    const accepted = execution.cancellation.cancel(reason);
    await this.safeHook('afterCancel', execution.job.afterCancel, execution);
    return accepted;
  }

  private async safeHook(name: string, hook: JobLifecycleHook | undefined, execution: RunningExecution): Promise<void> {
    if (!hook) return;
    try { await hook.call(execution.job, execution.context); }
    catch (error) { this.logger.warn('Background job lifecycle hook failed', { ...this.logContext(execution), hook: name, error: this.errorMessage(error) }); }
  }

  private async safeErrorHook(error: JobEngineError, execution: RunningExecution): Promise<void> {
    if (!execution.job.onError) return;
    try { await execution.job.onError.call(execution.job, error, execution.context); }
    catch (hookError) { this.logger.warn('Background job lifecycle hook failed', { ...this.logContext(execution), hook: 'onError', error: this.errorMessage(hookError) }); }
  }

  private normalizeFailure(error: unknown): JobEngineError {
    return error instanceof JobEngineError ? error : new JobEngineError(JobErrorCode.Failed, this.errorMessage(error), error);
  }

  private errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
  private finishTelemetry(execution: RunningExecution): void {
    execution.context.heartbeatNow();
    execution.context.metrics.finish();
  }
  private logContext(execution: RunningExecution): Readonly<Record<string, unknown>> {
    return { jobId: execution.id, jobName: execution.name, jobVersion: execution.version };
  }

  private snapshotExecution(execution: RunningExecution): JobExecutionSnapshot {
    return {
      id: execution.id,
      name: execution.name,
      version: execution.version,
      status: execution.status.current,
      progress: execution.context.progress.snapshot(),
      heartbeatAt: execution.context.heartbeat.lastHeartbeatAt,
      metrics: execution.context.metrics.snapshot(),
      error: execution.error
    };
  }
}
