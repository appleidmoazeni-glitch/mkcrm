"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FifoShadowJob = void 0;
const Job_js_1 = require("../core/jobs/Job.js");
const JobError_js_1 = require("../core/jobs/JobError.js");
/** Execution adapter only. Accounting decisions remain in the isolated shadow engine. */
class FifoShadowJob extends Job_js_1.BackgroundJob {
    input;
    name = 'fifo-shadow';
    version = 1;
    constructor(input) {
        super();
        this.input = input;
    }
    async run(context) {
        if (!this.input?.service)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, 'FIFO Shadow job input is incomplete');
        context.reportProgress({ phase: 'Validating Input', current: 0, total: 1, message: 'Preparing FIFO Shadow execution' });
        context.cancellationToken.throwIfCancellationRequested();
        const control = {
            progress: (update) => context.reportProgress(this.weightedProgress(update)),
            heartbeat: () => context.heartbeatNow(),
            checkCancellation: () => context.cancellationToken.throwIfCancellationRequested()
        };
        const result = await this.input.service.buildShadowDataset(this.input.db, { ...this.input.request, jobControl: control }, { ...this.input.requestedBy });
        await this.input.onResult?.(result);
        context.metrics.setCounter('datasetCount', result.datasetId ? 1 : 0);
        context.metrics.setCounter('allocationCount', Number(result.allocationCount || 0));
        context.metrics.setCounter('exceptionCount', Number(result.exceptionCount || 0));
        context.metrics.setCounter('retryCount', Number(result.retryCount || 0));
        context.metrics.setCounter('resumeCount', Number(result.resumeCount || 0));
        context.metrics.addProcessedItems(Number(result.allocationCount || 0));
        if (result.ok === false)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Failed, String(result.error || 'FIFO Shadow reconciliation failed'));
        context.reportProgress({ phase: 'Completed', current: 1, total: 1, percent: 100, message: 'FIFO Shadow completed' });
    }
    weightedProgress(update) {
        const ranges = {
            'Validating Input': [0, 2],
            'Reading Immutable Sources': [2, 20],
            'Allocating FIFO Shadow': [20, 72],
            'Writing Isolated Shadow Ledger': [72, 98],
            'Completed': [100, 100]
        };
        const [start, end] = ranges[update.phase || ''] || [0, 99];
        const local = update.percent ?? ((update.total || 0) > 0 ? Number(update.current || 0) / Number(update.total) * 100 : 0);
        return { ...update, percent: start + (end - start) * Math.min(100, Math.max(0, local)) / 100 };
    }
}
exports.FifoShadowJob = FifoShadowJob;
