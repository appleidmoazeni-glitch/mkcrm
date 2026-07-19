/** Stable codes shared by engine infrastructure and future business jobs. */
export enum JobErrorCode {
  Locked = 'JOB_LOCKED',
  Cancelled = 'JOB_CANCELLED',
  Timeout = 'JOB_TIMEOUT',
  Failed = 'JOB_FAILED',
  Internal = 'JOB_INTERNAL'
}

/** Error boundary that preserves a machine-readable code and optional cause. */
export class JobEngineError extends Error {
  readonly code: JobErrorCode;
  override readonly cause: unknown;

  constructor(code: JobErrorCode, message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'JobEngineError';
    this.code = code;
    this.cause = cause;
  }
}
