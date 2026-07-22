"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.BackgroundJob = exports.JobContext = void 0;
const JobHeartbeat_js_1 = require("./JobHeartbeat.js");
const JobMetrics_js_1 = require("./JobMetrics.js");
const JobProgress_js_1 = require("./JobProgress.js");
/** Immutable execution boundary passed to a job; its service objects own mutations. */
class JobContext {
    cancellationToken;
    logger;
    readStatus;
    onProgress;
    progress = new JobProgress_js_1.JobProgress();
    heartbeat = new JobHeartbeat_js_1.JobHeartbeat();
    metrics = new JobMetrics_js_1.JobMetrics();
    constructor(cancellationToken, logger, readStatus, onProgress) {
        this.cancellationToken = cancellationToken;
        this.logger = logger;
        this.readStatus = readStatus;
        this.onProgress = onProgress;
        Object.freeze(this);
    }
    get status() { return this.readStatus(); }
    reportProgress(update) {
        this.heartbeatNow();
        const snapshot = this.progress.update(update);
        this.onProgress?.(snapshot);
        return snapshot;
    }
    heartbeatNow() {
        this.metrics.touch();
        return this.heartbeat.beat();
    }
}
exports.JobContext = JobContext;
/**
 * Base class for future jobs. Implementations provide only a stable name and
 * their cooperative `run` method; orchestration remains in JobManager.
 */
class BackgroundJob {
    beforeStart;
    afterStart;
    beforeCancel;
    afterCancel;
    beforeComplete;
    afterComplete;
    onError;
    /** Called by JobManager; application code should start jobs through the manager. */
    execute(context) { return this.run(context); }
}
exports.BackgroundJob = BackgroundJob;
