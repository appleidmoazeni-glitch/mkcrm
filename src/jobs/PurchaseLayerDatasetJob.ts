import { BackgroundJob, type JobContext } from '../core/jobs/Job.js';
import { JobEngineError, JobErrorCode } from '../core/jobs/JobError.js';
import type { JobProgressUpdate } from '../core/jobs/JobProgress.js';

export interface PurchaseLayerDatasetResult extends Record<string, unknown> {
  readonly ok?: boolean;
  readonly datasetId?: string;
  readonly purchaseInvoiceCount?: number;
  readonly purchaseLineCount?: number;
  readonly layerCount?: number;
  readonly pageCount?: number;
  readonly errorCount?: number;
}
export interface PurchaseLayerDatasetService {
  buildPurchaseLayerDataset(db: unknown, request: Record<string, unknown>): Promise<PurchaseLayerDatasetResult>;
}
export interface PurchaseLayerDatasetJobInput {
  readonly db: unknown;
  readonly request: Readonly<Record<string, unknown>>;
  readonly service: PurchaseLayerDatasetService;
  readonly onResult?: (result: PurchaseLayerDatasetResult) => void | Promise<void>;
}

/** Background execution adapter; accounting and activation rules stay in the dataset service. */
export class PurchaseLayerDatasetJob extends BackgroundJob {
  readonly name = 'purchase-layer-dataset';
  readonly version = 1;

  constructor(private readonly input: PurchaseLayerDatasetJobInput) { super(); }

  protected override async run(context: JobContext): Promise<void> {
    if (!this.input?.service) throw new JobEngineError(JobErrorCode.Internal, 'Purchase Layer Dataset job input is incomplete');
    context.reportProgress({ phase:'Validating Input', current:0, total:1, message:'Preparing Purchase Layer Dataset execution' });
    context.cancellationToken.throwIfCancellationRequested();
    const control = {
      progress:(update: JobProgressUpdate) => context.reportProgress(this.weightedProgress(update)),
      heartbeat:() => context.heartbeatNow(),
      checkCancellation:() => context.cancellationToken.throwIfCancellationRequested()
    };
    const result = await this.input.service.buildPurchaseLayerDataset(this.input.db, { ...this.input.request, jobControl:control });
    await this.input.onResult?.(result);
    context.metrics.setCounter('invoiceCount', Number(result.purchaseInvoiceCount || 0));
    context.metrics.setCounter('itemCount', Number(result.purchaseLineCount || 0));
    context.metrics.setCounter('layerCount', Number(result.layerCount || 0));
    context.metrics.setCounter('pageCount', Number(result.pageCount || 0));
    context.metrics.addProcessedItems(Number(result.layerCount || 0));
    if (Number(result.errorCount || 0)) context.metrics.recordError(Number(result.errorCount));
    if (result.ok === false) throw new JobEngineError(JobErrorCode.Failed, String(result.error || 'Purchase Layer Dataset execution failed'));
    context.reportProgress({ phase:'Completed', current:1, total:1, percent:100, message:'Purchase Layer Dataset completed' });
  }

  private weightedProgress(update: JobProgressUpdate): JobProgressUpdate {
    const ranges: Readonly<Record<string, readonly [number, number]>> = {
      'Validating Input':[0, 2],
      'Preparing Isolated Dataset':[2, 8],
      'Reading Purchase Invoices':[8, 88],
      'Validating Dataset':[88, 98],
      'Completed':[100, 100]
    };
    const [start, end] = ranges[update.phase || ''] || [0, 99];
    const local = update.percent ?? ((update.total || 0) > 0 ? Number(update.current || 0) / Number(update.total) * 100 : 0);
    return { ...update, percent:start + (end - start) * Math.min(100, Math.max(0, local)) / 100 };
  }
}
