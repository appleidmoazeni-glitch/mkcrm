"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobManager = exports.JobAlreadyRunningError = void 0;
const JobCancellation_js_1 = require("./JobCancellation.js");
const Job_js_1 = require("./Job.js");
const JobError_js_1 = require("./JobError.js");
const JobEvents_js_1 = require("./JobEvents.js");
const JobLock_js_1 = require("./JobLock.js");
const JobLogger_js_1 = require("./JobLogger.js");
const JobStatus_js_1 = require("./JobStatus.js");
class JobAlreadyRunningError extends JobError_js_1.JobEngineError {
    constructor(jobName) {
        super(JobError_js_1.JobErrorCode.Locked, `Job is already running: ${jobName}`);
        this.name = 'JobAlreadyRunningError';
    }
}
exports.JobAlreadyRunningError = JobAlreadyRunningError;
/** Coordinates versioned definitions, locking, hooks, events and execution state. */
class JobManager {
    registry;
    logger;
    events;
    lock = new JobLock_js_1.JobLock();
    running = new Map();
    latest = new Map();
    sequence = 0;
    constructor(registry, logger = new JobLogger_js_1.NoopJobLogger(), events = new JobEvents_js_1.JobEventEmitter()) {
        this.registry = registry;
        this.logger = logger;
        this.events = events;
    }
    start(name, input) {
        const lock = this.lock.acquire(name);
        if (!lock)
            throw new JobAlreadyRunningError(name);
        try {
            const job = this.registry.create(name, input);
            const id = `${name}:v${job.version}:${Date.now()}:${++this.sequence}`;
            const cancellation = new JobCancellation_js_1.JobCancellationSource();
            const status = new JobStatus_js_1.JobStatusMachine((previous, current) => {
                this.events.emit('job.statusChanged', { jobId: id, jobName: name, previous, current });
            });
            let execution;
            const context = new Job_js_1.JobContext(cancellation.token, this.logger, () => status.current, progress => this.events.emit('job.progress', { job: this.snapshotExecution(execution), progress }));
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
        }
        catch (error) {
            this.running.delete(name);
            this.lock.release(lock);
            throw error;
        }
    }
    isRunning(name) { return this.running.has(name); }
    getRunning(name) {
        const execution = this.running.get(name);
        return execution ? this.snapshotExecution(execution) : undefined;
    }
    getLatest(name) { return this.latest.get(name); }
    listRunning() { return [...this.running.values()].map(item => this.snapshotExecution(item)); }
    async cancel(name, reason) {
        const execution = this.running.get(name);
        return execution ? this.requestCancellation(execution, reason) : false;
    }
    async run(execution) {
        try {
            await this.safeHook('beforeStart', execution.job.beforeStart, execution);
            execution.context.cancellationToken.throwIfCancellationRequested();
            execution.status.transition(JobStatus_js_1.JobStatus.Running);
            await this.safeHook('afterStart', execution.job.afterStart, execution);
            this.logger.info('Background job started', this.logContext(execution));
            this.events.emit('job.started', this.snapshotExecution(execution));
            await execution.job.execute(execution.context);
            await this.safeHook('beforeComplete', execution.job.beforeComplete, execution);
            execution.status.transition(JobStatus_js_1.JobStatus.Completed);
            await this.safeHook('afterComplete', execution.job.afterComplete, execution);
            this.finishTelemetry(execution);
            this.events.emit('job.completed', this.snapshotExecution(execution));
        }
        catch (error) {
            if (error instanceof JobCancellation_js_1.JobCancelledError) {
                execution.error = error;
                execution.status.transition(JobStatus_js_1.JobStatus.Cancelled);
                this.finishTelemetry(execution);
                this.events.emit('job.cancelled', this.snapshotExecution(execution));
            }
            else {
                execution.error = this.normalizeFailure(error);
                execution.context.metrics.recordError();
                execution.status.transition(JobStatus_js_1.JobStatus.Failed);
                await this.safeErrorHook(execution.error, execution);
                this.logger.error('Background job failed', { ...this.logContext(execution), code: execution.error.code, error: execution.error.message });
                this.finishTelemetry(execution);
                this.events.emit('job.failed', this.snapshotExecution(execution));
            }
        }
        finally {
            this.finishTelemetry(execution);
            this.running.delete(execution.name);
            this.lock.release(execution.lock);
        }
        const snapshot = this.snapshotExecution(execution);
        this.latest.set(execution.name, snapshot);
        this.logger.info('Background job finished', { ...this.logContext(execution), status: execution.status.current });
        return snapshot;
    }
    async requestCancellation(execution, reason) {
        if (execution.status.current !== JobStatus_js_1.JobStatus.Pending && execution.status.current !== JobStatus_js_1.JobStatus.Running)
            return false;
        await this.safeHook('beforeCancel', execution.job.beforeCancel, execution);
        if (execution.status.current !== JobStatus_js_1.JobStatus.Pending && execution.status.current !== JobStatus_js_1.JobStatus.Running)
            return false;
        execution.status.transition(JobStatus_js_1.JobStatus.Cancelling);
        const accepted = execution.cancellation.cancel(reason);
        await this.safeHook('afterCancel', execution.job.afterCancel, execution);
        return accepted;
    }
    async safeHook(name, hook, execution) {
        if (!hook)
            return;
        try {
            await hook.call(execution.job, execution.context);
        }
        catch (error) {
            this.logger.warn('Background job lifecycle hook failed', { ...this.logContext(execution), hook: name, error: this.errorMessage(error) });
        }
    }
    async safeErrorHook(error, execution) {
        if (!execution.job.onError)
            return;
        try {
            await execution.job.onError.call(execution.job, error, execution.context);
        }
        catch (hookError) {
            this.logger.warn('Background job lifecycle hook failed', { ...this.logContext(execution), hook: 'onError', error: this.errorMessage(hookError) });
        }
    }
    normalizeFailure(error) {
        return error instanceof JobError_js_1.JobEngineError ? error : new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Failed, this.errorMessage(error), error);
    }
    errorMessage(error) { return error instanceof Error ? error.message : String(error); }
    finishTelemetry(execution) {
        execution.context.heartbeatNow();
        execution.context.metrics.finish();
    }
    logContext(execution) {
        return { jobId: execution.id, jobName: execution.name, jobVersion: execution.version };
    }
    snapshotExecution(execution) {
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
exports.JobManager = JobManager;
