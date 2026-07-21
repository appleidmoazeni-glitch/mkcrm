import { BackgroundJob, type JobContext } from '../core/jobs/Job.js';
import { JobEngineError, JobErrorCode } from '../core/jobs/JobError.js';
import type { JobProgressUpdate } from '../core/jobs/JobProgress.js';

export interface SaleSnapshotResult extends Record<string, unknown> {
  readonly ok?: boolean;
  readonly snapshotId?: string;
  readonly invoiceHeadersFound?: number;
  readonly saleLinesParsed?: number;
  readonly pagesScanned?: number;
  readonly sellerStats?: readonly Record<string, unknown>[];
  readonly errors?: readonly unknown[];
}
export interface SaleSnapshotService { buildSaleSnapshot(db: unknown, request: Record<string, unknown>): Promise<SaleSnapshotResult>; }
export interface SaleSnapshotJobInput {
  readonly db: unknown;
  readonly request: Readonly<Record<string, unknown>>;
  readonly service: SaleSnapshotService;
  readonly onResult?: (result: SaleSnapshotResult) => void | Promise<void>;
}

/** Execution adapter only; all Sale Snapshot calculations remain in the existing service. */
export class SaleSnapshotJob extends BackgroundJob {
  readonly name = 'sale-snapshot';
  readonly version = 1;

  constructor(private readonly input: SaleSnapshotJobInput) { super(); }

  protected override async run(context: JobContext): Promise<void> {
    if (!this.input?.service) throw new JobEngineError(JobErrorCode.Internal, 'Sale Snapshot job input is incomplete');
    context.reportProgress({ phase:'Validating Input', current:0, total:1, message:'Preparing Sale Snapshot execution' });
    context.cancellationToken.throwIfCancellationRequested();
    const control = {
      progress: (update: JobProgressUpdate) => context.reportProgress(this.weightedProgress(update)),
      heartbeat: () => context.heartbeatNow(),
      checkCancellation: () => context.cancellationToken.throwIfCancellationRequested()
    };
    const result = await this.input.service.buildSaleSnapshot(this.input.db, { ...this.input.request, jobControl:control });
    await this.input.onResult?.(result);
    this.captureMetrics(context, result);
    if (result.ok === false) throw new JobEngineError(JobErrorCode.Failed, String(result.error || 'Sale Snapshot execution failed'));
    context.reportProgress({ phase:'Completed', current:1, total:1, percent:100, message:'Sale Snapshot completed' });
  }

  private captureMetrics(context: JobContext, result: SaleSnapshotResult): void {
    const invoiceCount=Number(result.invoiceHeadersFound||0), itemCount=Number(result.saleLinesParsed||0);
    const sellers=result.sellerStats||[];
    const cashierCount=new Set(sellers.map(x=>String(x.cashboxAccountName||'')).filter(Boolean)).size;
    context.metrics.setCounter('invoiceCount', invoiceCount);
    context.metrics.setCounter('itemCount', itemCount);
    context.metrics.setCounter('salespersonCount', sellers.length);
    context.metrics.setCounter('cashierCount', cashierCount);
    context.metrics.setCounter('pageCount', Number(result.pagesScanned||0));
    context.metrics.setCounter('snapshotCount', result.snapshotId ? 1 : 0);
    context.metrics.addProcessedItems(invoiceCount+itemCount);
    if (result.errors?.length) context.metrics.recordError(result.errors.length);
  }

  private weightedProgress(update: JobProgressUpdate): JobProgressUpdate {
    const ranges: Readonly<Record<string, readonly [number,number]>>={
      'Validating Input':[0,2], 'Resolving Salespeople and Cashiers':[2,5],
      'Reading Sale Invoices':[5,70], 'Calculating Snapshot':[70,90],
      'Saving Snapshot':[90,99], 'Completed':[100,100]
    };
    const [start,end]=ranges[update.phase||'']||[0,99];
    const local=update.percent??((update.total||0)>0?Number(update.current||0)/Number(update.total)*100:0);
    return { ...update, percent:start+(end-start)*Math.min(100,Math.max(0,local))/100 };
  }
}
