"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PurchaseLayerDatasetJob = void 0;
const Job_js_1 = require("../core/jobs/Job.js");
const JobError_js_1 = require("../core/jobs/JobError.js");
/** Background execution adapter; accounting and activation rules stay in the dataset service. */
class PurchaseLayerDatasetJob extends Job_js_1.BackgroundJob {
    input;
    name = 'purchase-layer-dataset';
    version = 1;
    constructor(input) {
        super();
        this.input = input;
    }
    async run(context) {
        if (!this.input?.service)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, 'Purchase Layer Dataset job input is incomplete');
        context.reportProgress({ phase: 'Validating Input', current: 0, total: 1, message: 'Preparing Purchase Layer Dataset execution' });
        context.cancellationToken.throwIfCancellationRequested();
        const control = {
            progress: (update) => context.reportProgress(this.weightedProgress(update)),
            heartbeat: () => context.heartbeatNow(),
            checkCancellation: () => context.cancellationToken.throwIfCancellationRequested()
        };
        const result = await this.input.service.buildPurchaseLayerDataset(this.input.db, { ...this.input.request, jobControl: control });
        await this.input.onResult?.(result);
        context.metrics.setCounter('invoiceCount', Number(result.purchaseInvoiceCount || 0));
        context.metrics.setCounter('itemCount', Number(result.purchaseLineCount || 0));
        context.metrics.setCounter('layerCount', Number(result.layerCount || 0));
        context.metrics.setCounter('pageCount', Number(result.pageCount || 0));
        context.metrics.addProcessedItems(Number(result.layerCount || 0));
        if (Number(result.errorCount || 0))
            context.metrics.recordError(Number(result.errorCount));
        if (result.ok === false)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Failed, String(result.error || 'Purchase Layer Dataset execution failed'));
        context.reportProgress({ phase: 'Completed', current: 1, total: 1, percent: 100, message: 'Purchase Layer Dataset completed' });
    }
    weightedProgress(update) {
        const ranges = {
            'Validating Input': [0, 2],
            'Preparing Isolated Dataset': [2, 8],
            'Reading Purchase Invoices': [8, 88],
            'Validating Dataset': [88, 98],
            'Completed': [100, 100]
        };
        const [start, end] = ranges[update.phase || ''] || [0, 99];
        const local = update.percent ?? ((update.total || 0) > 0 ? Number(update.current || 0) / Number(update.total) * 100 : 0);
        return { ...update, percent: start + (end - start) * Math.min(100, Math.max(0, local)) / 100 };
    }
}
exports.PurchaseLayerDatasetJob = PurchaseLayerDatasetJob;
