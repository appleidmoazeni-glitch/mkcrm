import { BackgroundJob, type JobContext } from '../core/jobs/Job.js';
import { JobEngineError, JobErrorCode } from '../core/jobs/JobError.js';
import type { JobProgressUpdate } from '../core/jobs/JobProgress.js';

export interface SellerFinancialPerformanceResult extends Record<string, unknown> {
  readonly ok?: boolean;
  readonly runId?: string;
  readonly lineCount?: number;
  readonly summaryCount?: number;
  readonly retryCount?: number;
  readonly resumeCount?: number;
}
export interface SellerFinancialPerformanceService {
  buildReadModel(db: unknown, request: Record<string, unknown>, requestedBy: Record<string, unknown>): Promise<SellerFinancialPerformanceResult>;
}
export interface SellerFinancialPerformanceJobInput {
  readonly db: unknown;
  readonly request: Readonly<Record<string, unknown>>;
  readonly requestedBy: Readonly<Record<string, unknown>>;
  readonly service: SellerFinancialPerformanceService;
  readonly onResult?: (result: SellerFinancialPerformanceResult) => void | Promise<void>;
}

/** Background execution adapter; all accounting rules remain in the service. */
export class SellerFinancialPerformanceJob extends BackgroundJob {
  readonly name = 'seller-financial-performance';
  readonly version = 1;
  constructor(private readonly input: SellerFinancialPerformanceJobInput) { super(); }

  protected override async run(context: JobContext): Promise<void> {
    if (!this.input?.service) throw new JobEngineError(JobErrorCode.Internal, 'Seller Financial Performance job input is incomplete');
    context.reportProgress({ phase:'Validating Input', current:0, total:1, message:'Preparing seller financial read model' });
    context.cancellationToken.throwIfCancellationRequested();
    const result=await this.input.service.buildReadModel(this.input.db,{
      ...this.input.request,
      jobControl:{
        progress:(update:JobProgressUpdate)=>context.reportProgress(this.weighted(update)),
        heartbeat:()=>context.heartbeatNow(),
        checkCancellation:()=>context.cancellationToken.throwIfCancellationRequested()
      }
    },{...this.input.requestedBy});
    await this.input.onResult?.(result);
    context.metrics.setCounter('runCount',result.runId?1:0);
    context.metrics.setCounter('lineCount',Number(result.lineCount||0));
    context.metrics.setCounter('summaryCount',Number(result.summaryCount||0));
    context.metrics.setCounter('retryCount',Number(result.retryCount||0));
    context.metrics.setCounter('resumeCount',Number(result.resumeCount||0));
    context.metrics.addProcessedItems(Number(result.lineCount||0));
    if(result.ok===false)throw new JobEngineError(JobErrorCode.Failed,'Seller Financial Performance build failed');
    context.reportProgress({phase:'Completed',current:1,total:1,percent:100,message:'Seller Financial Performance completed'});
  }
  private weighted(update:JobProgressUpdate):JobProgressUpdate {
    const ranges:Readonly<Record<string,readonly [number,number]>>={
      'Validating Input':[0,2],
      'Reading Immutable Sources':[2,18],
      'Projecting Seller Financial Lines':[18,50],
      'Writing Seller Financial Lines':[50,85],
      'Building Summaries':[85,99],
      'Completed':[100,100]
    };
    const [start,end]=ranges[update.phase||'']||[0,99];
    const local=update.percent??((update.total||0)>0?Number(update.current||0)/Number(update.total)*100:0);
    return {...update,percent:start+(end-start)*Math.min(100,Math.max(0,local))/100};
  }
}
