"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MongoBackupJob = void 0;
const Job_js_1 = require("../core/jobs/Job.js");
const JobError_js_1 = require("../core/jobs/JobError.js");
/** Admin backup execution adapter. Destination validation and mongodump invocation live in the service. */
class MongoBackupJob extends Job_js_1.BackgroundJob {
    input;
    name = 'mongo-backup';
    version = 1;
    constructor(input) {
        super();
        this.input = input;
    }
    async run(context) {
        if (!this.input?.service)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, 'Mongo backup job input is incomplete');
        const control = { progress: (u) => context.reportProgress(u), heartbeat: () => context.heartbeatNow(), checkCancellation: () => context.cancellationToken.throwIfCancellationRequested() };
        context.reportProgress({ phase: 'preparing', current: 0, total: 1, percent: 5, message: 'Validating backup destination' });
        control.checkCancellation();
        const result = await this.input.service.run({ ...this.input.request, jobControl: control });
        await this.input.onResult?.(result);
        context.metrics.setCounter('backupSizeBytes', Number(result.sizeBytes || 0));
        if (result.ok === false)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Failed, String(result.error || 'Mongo backup failed'));
        context.reportProgress({ phase: 'completed', current: 1, total: 1, percent: 100, message: 'Mongo backup completed' });
    }
}
exports.MongoBackupJob = MongoBackupJob;
