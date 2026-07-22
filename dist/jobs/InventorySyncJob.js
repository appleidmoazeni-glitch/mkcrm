"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.InventorySyncJob = void 0;
const Job_js_1 = require("../core/jobs/Job.js");
const JobError_js_1 = require("../core/jobs/JobError.js");
/** Execution adapter only; inventory synchronization rules remain in the existing service. */
class InventorySyncJob extends Job_js_1.BackgroundJob {
    input;
    name = 'inventory-sync';
    version = 1;
    constructor(input) {
        super();
        this.input = input;
    }
    async run(context) {
        if (!this.input?.service)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, 'Inventory Sync job input is incomplete');
        context.reportProgress({ phase: 'Preparing', current: 0, total: 1, message: 'Preparing inventory synchronization' });
        context.cancellationToken.throwIfCancellationRequested();
        const control = {
            progress: (update) => context.reportProgress(this.weightedProgress(update)),
            heartbeat: () => context.heartbeatNow(),
            checkCancellation: () => context.cancellationToken.throwIfCancellationRequested()
        };
        const result = await this.input.service.sync({ ...this.input.request, jobControl: control });
        await this.input.onResult?.(result);
        this.captureMetrics(context, result);
        if (result.ok === false)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Failed, String(result.error || 'Inventory Sync failed'));
        context.reportProgress({ phase: 'Finalize', current: 1, total: 1, percent: 100, message: 'Inventory synchronization completed' });
    }
    captureMetrics(context, result) {
        const stocks = result.stockResults || [];
        const pageCount = stocks.reduce((sum, row) => sum + Number(row.pages || 0), 0);
        const inventoryRows = Number(result.stockRows || 0);
        const errors = stocks.filter(row => row.ok === false).length;
        context.metrics.setCounter('warehouseCount', result.activeWarehouseNumbers?.length || stocks.length);
        context.metrics.setCounter('pageCount', pageCount);
        context.metrics.setCounter('inventoryRows', inventoryRows);
        context.metrics.setCounter('mergedRows', Number(result.mergedRows ?? inventoryRows));
        context.metrics.setCounter('updatedRows', Number(result.updatedRows || 0));
        context.metrics.setCounter('insertedRows', Number(result.insertedRows || 0));
        context.metrics.setCounter('protectedRows', Number(result.protectedFromStale || 0));
        context.metrics.setCounter('liveRepairQueued', Number(result.queuedForLiveVerify || 0));
        context.metrics.addProcessedItems(inventoryRows);
        if (errors)
            context.metrics.recordError(errors);
    }
    weightedProgress(update) {
        const ranges = {
            'Preparing': [0, 3], 'Reading warehouses': [3, 8], 'Reading Shaygan pages': [8, 55],
            'Merge inventory': [55, 70], 'Live repair queue': [70, 82],
            'Persist inventory': [82, 97], 'Finalize': [97, 100]
        };
        const [start, end] = ranges[update.phase || ''] || [0, 97];
        const local = update.percent ?? ((update.total || 0) > 0 ? Number(update.current || 0) / Number(update.total) * 100 : 0);
        return { ...update, percent: start + (end - start) * Math.min(100, Math.max(0, local)) / 100 };
    }
}
exports.InventorySyncJob = InventorySyncJob;
