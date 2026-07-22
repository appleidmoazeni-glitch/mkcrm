import { BackgroundJob, type JobContext } from '../core/jobs/Job.js';
import { JobEngineError, JobErrorCode } from '../core/jobs/JobError.js';
import type { JobProgressUpdate } from '../core/jobs/JobProgress.js';

export type SupplierSleepOperation = 'read-selected-invoices' | 'build-selected-snapshot';

export interface SupplierSleepResult extends Record<string, unknown> {
  readonly ok?: boolean;
  readonly count?: number;
  readonly list?: readonly unknown[];
  readonly invoices?: readonly unknown[];
  readonly summary?: readonly unknown[];
  readonly errors?: readonly unknown[];
  readonly snapshot?: Record<string, unknown>;
}

export interface SupplierSleepService {
  readPurchaseInvoicesForSupplier(db: unknown, request: Record<string, unknown>): Promise<SupplierSleepResult>;
  buildSelectedSupplierSnapshot(db: unknown, request: Record<string, unknown>): Promise<SupplierSleepResult>;
}

export interface SupplierSleepJobInput {
  readonly operation: SupplierSleepOperation;
  readonly db: unknown;
  readonly request: Readonly<Record<string, unknown>>;
  readonly service: SupplierSleepService;
  readonly onResult?: (result: SupplierSleepResult) => void | Promise<void>;
}

interface SupplierSleepJobControl {
  progress(update: JobProgressUpdate): void;
  heartbeat(): void;
  checkCancellation(): void;
}

/** Execution adapter only; Supplier Sleep calculations remain in the existing service. */
export class SupplierSleepJob extends BackgroundJob {
  readonly name = 'supplier-sleep';
  readonly version = 1;

  constructor(private readonly input: SupplierSleepJobInput) { super(); }

  protected override async run(context: JobContext): Promise<void> {
    this.validateInput();
    const control: SupplierSleepJobControl = {
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
    if (result.ok === false) throw new JobEngineError(JobErrorCode.Failed, String(result.error || 'Supplier Sleep execution failed'));

    context.reportProgress({ phase: 'Completed', current: totalPhases, total: totalPhases, message: 'Supplier Sleep completed' });
  }

  private validateInput(): void {
    if (!this.input || !this.input.service || !this.input.operation) {
      throw new JobEngineError(JobErrorCode.Internal, 'Supplier Sleep job input is incomplete');
    }
  }

  private hasSupplier(request: Readonly<Record<string, unknown>>): boolean {
    return Boolean(request.supplierAccountNo || request.accountNumber || request.supplierGuid || request.accountGuid || request.supplierName || request.accountName);
  }

  private captureMetrics(context: JobContext, result: SupplierSleepResult): void {
    const snapshot = result.snapshot ?? {};
    const invoiceCount = Number(result.count ?? result.invoices?.length ?? snapshot.purchaseInvoicesSynced ?? 0);
    const layerCount = Number(snapshot.purchaseLayerCount ?? snapshot.allocatedLayerCount ?? 0);
    const errorCount = result.errors?.length ?? 0;
    context.metrics.setCounter('invoiceCount', invoiceCount);
    context.metrics.setCounter('layerCount', layerCount);
    context.metrics.addProcessedItems(invoiceCount + layerCount);
    if (errorCount) context.metrics.recordError(errorCount);
  }

  private weightedProgress(update: JobProgressUpdate): JobProgressUpdate {
    const ranges: Readonly<Record<string, readonly [number, number]>> = {
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
