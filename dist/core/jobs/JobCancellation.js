"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobCancellationSource = exports.JobCancelledError = void 0;
const JobError_js_1 = require("./JobError.js");
/** Error used to acknowledge cooperative cancellation. */
class JobCancelledError extends JobError_js_1.JobEngineError {
    constructor(message = 'Job was cancelled') {
        super(JobError_js_1.JobErrorCode.Cancelled, message);
        this.name = 'JobCancelledError';
    }
}
exports.JobCancelledError = JobCancelledError;
/** Owns the mutable side of a cancellation token. Cancellation is cooperative. */
class JobCancellationSource {
    cancelled = false;
    cancellationReason;
    token = this;
    get isCancellationRequested() { return this.cancelled; }
    get reason() { return this.cancellationReason; }
    throwIfCancellationRequested() {
        if (this.cancelled)
            throw new JobCancelledError(this.cancellationReason);
    }
    cancel(reason = 'Job was cancelled') {
        if (this.cancelled)
            return false;
        this.cancelled = true;
        this.cancellationReason = reason;
        return true;
    }
}
exports.JobCancellationSource = JobCancellationSource;
