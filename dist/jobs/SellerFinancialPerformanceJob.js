"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SellerFinancialPerformanceJob = void 0;
const Job_js_1 = require("../core/jobs/Job.js");
const JobError_js_1 = require("../core/jobs/JobError.js");
/** Background execution adapter; all accounting rules remain in the service. */
class SellerFinancialPerformanceJob extends Job_js_1.BackgroundJob {
    input;
    name = 'seller-financial-performance';
    version = 1;
    constructor(input) {
        super();
        this.input = input;
    }
    async run(context) {
        if (!this.input?.service)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, 'Seller Financial Performance job input is incomplete');
        context.reportProgress({ phase: 'Validating Input', current: 0, total: 1, message: 'Preparing seller financial read model' });
        context.cancellationToken.throwIfCancellationRequested();
        const operation = String(this.input.request.operation || 'build');
        const execute = operation === 'deep-verify' ? this.input.service.deepVerify.bind(this.input.service) : this.input.service.buildReadModel.bind(this.input.service);
        const result = await execute(this.input.db, {
            ...this.input.request,
            jobControl: {
                progress: (update) => context.reportProgress(this.weighted(update)),
                heartbeat: () => context.heartbeatNow(),
                checkCancellation: () => context.cancellationToken.throwIfCancellationRequested()
            }
        }, { ...this.input.requestedBy });
        await this.input.onResult?.(result);
        context.metrics.setCounter('runCount', result.runId ? 1 : 0);
        context.metrics.setCounter('verificationCount', result.verificationId ? 1 : 0);
        context.metrics.setCounter('lineCount', Number(result.lineCount || 0));
        context.metrics.setCounter('summaryCount', Number(result.summaryCount || 0));
        context.metrics.setCounter('retryCount', Number(result.retryCount || 0));
        context.metrics.setCounter('resumeCount', Number(result.resumeCount || 0));
        context.metrics.addProcessedItems(Number(result.lineCount || 0));
        if (result.ok === false)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Failed, 'Seller Financial Performance build failed');
        context.reportProgress({ phase: 'Completed', current: 1, total: 1, percent: 100, message: 'Seller Financial Performance completed' });
    }
    weighted(update) {
        const ranges = {
            'Validating Input': [0, 2],
            'Reading Immutable Sources': [2, 18],
            'Replaying Stored Fingerprints': [18, 90],
            'Projecting Seller Financial Lines': [18, 50],
            'Writing Seller Financial Lines': [50, 85],
            'Building Summaries': [85, 99],
            'Completed': [100, 100]
        };
        const [start, end] = ranges[update.phase || ''] || [0, 99];
        const local = update.percent ?? ((update.total || 0) > 0 ? Number(update.current || 0) / Number(update.total) * 100 : 0);
        return { ...update, percent: start + (end - start) * Math.min(100, Math.max(0, local)) / 100 };
    }
}
exports.SellerFinancialPerformanceJob = SellerFinancialPerformanceJob;
