"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SaleSnapshotJob = void 0;
const Job_js_1 = require("../core/jobs/Job.js");
const JobError_js_1 = require("../core/jobs/JobError.js");
/** Execution adapter only; all Sale Snapshot calculations remain in the existing service. */
class SaleSnapshotJob extends Job_js_1.BackgroundJob {
    input;
    name = 'sale-snapshot';
    version = 1;
    constructor(input) {
        super();
        this.input = input;
    }
    async run(context) {
        if (!this.input?.service)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, 'Sale Snapshot job input is incomplete');
        context.reportProgress({ phase: 'Validating Input', current: 0, total: 1, message: 'Preparing Sale Snapshot execution' });
        context.cancellationToken.throwIfCancellationRequested();
        const control = {
            progress: (update) => context.reportProgress(this.weightedProgress(update)),
            heartbeat: () => context.heartbeatNow(),
            checkCancellation: () => context.cancellationToken.throwIfCancellationRequested()
        };
        const result = await this.input.service.buildSaleSnapshot(this.input.db, { ...this.input.request, jobControl: control });
        await this.input.onResult?.(result);
        this.captureMetrics(context, result);
        if (result.ok === false)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Failed, String(result.error || 'Sale Snapshot execution failed'));
        context.reportProgress({ phase: 'Completed', current: 1, total: 1, percent: 100, message: 'Sale Snapshot completed' });
    }
    captureMetrics(context, result) {
        const invoiceCount = Number(result.invoiceHeadersFound || 0), itemCount = Number(result.saleLinesParsed || 0);
        const sellers = result.sellerStats || [];
        const cashierCount = new Set(sellers.map(x => String(x.cashboxAccountName || '')).filter(Boolean)).size;
        context.metrics.setCounter('invoiceCount', invoiceCount);
        context.metrics.setCounter('itemCount', itemCount);
        context.metrics.setCounter('salespersonCount', sellers.length);
        context.metrics.setCounter('cashierCount', cashierCount);
        context.metrics.setCounter('pageCount', Number(result.pagesScanned || 0));
        context.metrics.setCounter('snapshotCount', result.snapshotId ? 1 : 0);
        context.metrics.addProcessedItems(invoiceCount + itemCount);
        if (result.errors?.length)
            context.metrics.recordError(result.errors.length);
    }
    weightedProgress(update) {
        const ranges = {
            'Validating Input': [0, 2], 'Resolving Salespeople and Cashiers': [2, 5],
            'Reading Sale Invoices': [5, 70], 'Calculating Snapshot': [70, 90],
            'Saving Snapshot': [90, 99], 'Completed': [100, 100]
        };
        const [start, end] = ranges[update.phase || ''] || [0, 99];
        const local = update.percent ?? ((update.total || 0) > 0 ? Number(update.current || 0) / Number(update.total) * 100 : 0);
        return { ...update, percent: start + (end - start) * Math.min(100, Math.max(0, local)) / 100 };
    }
}
exports.SaleSnapshotJob = SaleSnapshotJob;
