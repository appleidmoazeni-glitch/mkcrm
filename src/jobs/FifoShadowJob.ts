import { BackgroundJob, type JobContext } from '../core/jobs/Job.js';
import { JobEngineError, JobErrorCode } from '../core/jobs/JobError.js';
import type { JobProgressUpdate } from '../core/jobs/JobProgress.js';

export interface FifoShadowResult extends Record<string, unknown> {
  readonly ok?: boolean;
  readonly datasetId?: string;
  readonly allocationCount?: number;
  readonly exceptionCount?: number;
  readonly retryCount?: number;
  readonly resumeCount?: number;
  readonly error?: string;
}
export interface FifoShadowService {
  buildShadowDataset(
    db: unknown,
    request: Record<string, unknown>,
    requestedBy: Record<string, unknown>
  ): Promise<FifoShadowResult>;
}
export interface FifoShadowJobInput {
  readonly db: unknown;
  readonly request: Readonly<Record<string, unknown>>;
  readonly requestedBy: Readonly<Record<string, unknown>>;
  readonly service: FifoShadowService;
  readonly onResult?: (result: FifoShadowResult) => void | Promise<void>;
}

/** Execution adapter only. Accounting decisions remain in the isolated shadow engine. */
export class FifoShadowJob extends BackgroundJob {
  readonly name = 'fifo-shadow';
  readonly version = 1;

  constructor(private readonly input: FifoShadowJobInput) { super(); }

  protected override async run(context: JobContext): Promise<void> {
    if (!this.input?.service) throw new JobEngineError(JobErrorCode.Internal, 'FIFO Shadow job input is incomplete');
    context.reportProgress({ phase:'Validating Input', current:0, total:1, message:'Preparing FIFO Shadow execution' });
    context.cancellationToken.throwIfCancellationRequested();
    const control = {
      progress:(update: JobProgressUpdate) => context.reportProgress(this.weightedProgress(update)),
      heartbeat:() => context.heartbeatNow(),
      checkCancellation:() => context.cancellationToken.throwIfCancellationRequested()
    };
    const result = await this.input.service.buildShadowDataset(
      this.input.db,
      { ...this.input.request, jobControl:control },
      { ...this.input.requestedBy }
    );
    await this.input.onResult?.(result);
    context.metrics.setCounter('datasetCount', result.datasetId ? 1 : 0);
    context.metrics.setCounter('allocationCount', Number(result.allocationCount || 0));
    context.metrics.setCounter('exceptionCount', Number(result.exceptionCount || 0));
    context.metrics.setCounter('retryCount', Number(result.retryCount || 0));
    context.metrics.setCounter('resumeCount', Number(result.resumeCount || 0));
    context.metrics.addProcessedItems(Number(result.allocationCount || 0));
    if (result.ok === false) throw new JobEngineError(JobErrorCode.Failed, String(result.error || 'FIFO Shadow reconciliation failed'));
    context.reportProgress({ phase:'Completed', current:1, total:1, percent:100, message:'FIFO Shadow completed' });
  }

  private weightedProgress(update: JobProgressUpdate): JobProgressUpdate {
    const ranges: Readonly<Record<string, readonly [number, number]>> = {
      'Validating Input':[0, 2],
      'Reading Immutable Sources':[2, 20],
      'Allocating FIFO Shadow':[20, 72],
      'Writing Isolated Shadow Ledger':[72, 98],
      'Completed':[100, 100]
    };
    const [start, end] = ranges[update.phase || ''] || [0, 99];
    const local = update.percent ?? ((update.total || 0) > 0 ? Number(update.current || 0) / Number(update.total) * 100 : 0);
    return { ...update, percent:start + (end - start) * Math.min(100, Math.max(0, local)) / 100 };
  }
}
