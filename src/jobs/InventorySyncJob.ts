import { BackgroundJob, type JobContext } from '../core/jobs/Job.js';
import { JobEngineError, JobErrorCode } from '../core/jobs/JobError.js';
import type { JobProgressUpdate } from '../core/jobs/JobProgress.js';

export interface InventorySyncResult extends Record<string, unknown> {
  readonly ok?: boolean;
  readonly activeWarehouseNumbers?: readonly unknown[];
  readonly stockResults?: readonly Record<string, unknown>[];
  readonly stockRows?: number;
  readonly protectedFromStale?: number;
  readonly queuedForLiveVerify?: number;
}
export interface InventorySyncService {
  sync(request: Record<string, unknown>): Promise<InventorySyncResult>;
}
export interface InventorySyncJobInput {
  readonly request: Readonly<Record<string, unknown>>;
  readonly service: InventorySyncService;
  readonly onResult?: (result: InventorySyncResult) => void | Promise<void>;
}

/** Execution adapter only; inventory synchronization rules remain in the existing service. */
export class InventorySyncJob extends BackgroundJob {
  readonly name = 'inventory-sync';
  readonly version = 1;

  constructor(private readonly input: InventorySyncJobInput) { super(); }

  protected override async run(context: JobContext): Promise<void> {
    if (!this.input?.service) throw new JobEngineError(JobErrorCode.Internal, 'Inventory Sync job input is incomplete');
    context.reportProgress({ phase:'Preparing', current:0, total:1, message:'Preparing inventory synchronization' });
    context.cancellationToken.throwIfCancellationRequested();
    const control = {
      progress: (update: JobProgressUpdate) => context.reportProgress(this.weightedProgress(update)),
      heartbeat: () => context.heartbeatNow(),
      checkCancellation: () => context.cancellationToken.throwIfCancellationRequested()
    };
    const result=await this.input.service.sync({ ...this.input.request, jobControl:control });
    await this.input.onResult?.(result);
    this.captureMetrics(context,result);
    if(result.ok===false) throw new JobEngineError(JobErrorCode.Failed,String(result.error||'Inventory Sync failed'));
    context.reportProgress({ phase:'Finalize', current:1, total:1, percent:100, message:'Inventory synchronization completed' });
  }

  private captureMetrics(context: JobContext,result: InventorySyncResult): void {
    const stocks=result.stockResults||[];
    const pageCount=stocks.reduce((sum,row)=>sum+Number(row.pages||0),0);
    const inventoryRows=Number(result.stockRows||0);
    const errors=stocks.filter(row=>row.ok===false).length;
    context.metrics.setCounter('warehouseCount',result.activeWarehouseNumbers?.length||stocks.length);
    context.metrics.setCounter('pageCount',pageCount);
    context.metrics.setCounter('inventoryRows',inventoryRows);
    context.metrics.setCounter('mergedRows',Number(result.mergedRows??inventoryRows));
    context.metrics.setCounter('updatedRows',Number(result.updatedRows||0));
    context.metrics.setCounter('insertedRows',Number(result.insertedRows||0));
    context.metrics.setCounter('protectedRows',Number(result.protectedFromStale||0));
    context.metrics.setCounter('liveRepairQueued',Number(result.queuedForLiveVerify||0));
    context.metrics.addProcessedItems(inventoryRows);
    if(errors) context.metrics.recordError(errors);
  }

  private weightedProgress(update: JobProgressUpdate): JobProgressUpdate {
    const ranges: Readonly<Record<string,readonly [number,number]>>={
      'Preparing':[0,3], 'Reading warehouses':[3,8], 'Reading Shaygan pages':[8,55],
      'Merge inventory':[55,70], 'Live repair queue':[70,82],
      'Persist inventory':[82,97], 'Finalize':[97,100]
    };
    const [start,end]=ranges[update.phase||'']||[0,97];
    const local=update.percent??((update.total||0)>0?Number(update.current||0)/Number(update.total)*100:0);
    return {...update,percent:start+(end-start)*Math.min(100,Math.max(0,local))/100};
  }
}
