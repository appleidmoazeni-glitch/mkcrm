"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SupplierSleepJob = void 0;
const Job_js_1 = require("../core/jobs/Job.js");
const JobError_js_1 = require("../core/jobs/JobError.js");
/** Execution adapter only; Supplier Sleep calculations remain in the existing service. */
class SupplierSleepJob extends Job_js_1.BackgroundJob {
    input;
    name = 'supplier-sleep';
    version = 1;
    constructor(input) {
        super();
        this.input = input;
    }
    async run(context) {
        this.validateInput();
        const control = {
            progress: update => { context.reportProgress(this.weightedProgress(update)); },
            heartbeat: () => { context.heartbeatNow(); },
            checkCancellation: () => { context.cancellationToken.throwIfCancellationRequested(); }
        };
        const request = { ...this.input.request, jobControl: control, jobOperation: this.input.operation };
        const totalPhases = this.input.operation === 'build-selected-snapshot' ? 5 : 2;
        context.reportProgress({ phase: 'Loading Suppliers', current: 0, total: totalPhases, message: 'Preparing supplier execution' });
        context.metrics.setCounter('supplierCount', this.hasSupplier(request) ? 1 : 0);
        control.checkCancellation();
        const result = this.input.operation === 'read-selected-invoices'
            ? await this.input.service.readPurchaseInvoicesForSupplier(this.input.db, request)
            : await this.input.service.buildSelectedSupplierSnapshot(this.input.db, request);
        this.captureMetrics(context, result);
        await this.input.onResult?.(result);
        if (result.ok === false)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Failed, String(result.error || 'Supplier Sleep execution failed'));
        context.reportProgress({ phase: 'Completed', current: totalPhases, total: totalPhases, message: 'Supplier Sleep completed' });
    }
    validateInput() {
        if (!this.input || !this.input.service || !this.input.operation) {
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, 'Supplier Sleep job input is incomplete');
        }
    }
    hasSupplier(request) {
        return Boolean(request.supplierAccountNo || request.accountNumber || request.supplierGuid || request.accountGuid || request.supplierName || request.accountName);
    }
    captureMetrics(context, result) {
        const snapshot = result.snapshot ?? {};
        const invoiceCount = Number(result.count ?? result.invoices?.length ?? snapshot.purchaseInvoicesSynced ?? 0);
        const layerCount = Number(snapshot.purchaseLayerCount ?? snapshot.allocatedLayerCount ?? 0);
        const errorCount = result.errors?.length ?? 0;
        context.metrics.setCounter('invoiceCount', invoiceCount);
        context.metrics.setCounter('layerCount', layerCount);
        context.metrics.addProcessedItems(invoiceCount + layerCount);
        if (errorCount)
            context.metrics.recordError(errorCount);
    }
    weightedProgress(update) {
        const ranges = {
            'Loading Suppliers': [0, 5],
            'Reading Purchase Invoices': [5, 40],
            'Building Layers': [40, 60],
            'Calculating Remaining Stock': [60, 85],
            'Saving Snapshot': [85, 99],
            'Completed': [100, 100]
        };
        const [start, end] = ranges[update.phase ?? ''] ?? [0, 99];
        const localPercent = update.percent ?? ((update.total ?? 0) > 0 ? (Number(update.current ?? 0) / Number(update.total)) * 100 : 0);
        return { ...update, percent: start + ((end - start) * Math.min(100, Math.max(0, localPercent)) / 100) };
    }
}
exports.SupplierSleepJob = SupplierSleepJob;
