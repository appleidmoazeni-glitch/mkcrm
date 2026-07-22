"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobEngineError = exports.JobErrorCode = void 0;
/** Stable codes shared by engine infrastructure and future business jobs. */
var JobErrorCode;
(function (JobErrorCode) {
    JobErrorCode["Locked"] = "JOB_LOCKED";
    JobErrorCode["Cancelled"] = "JOB_CANCELLED";
    JobErrorCode["Timeout"] = "JOB_TIMEOUT";
    JobErrorCode["Failed"] = "JOB_FAILED";
    JobErrorCode["Internal"] = "JOB_INTERNAL";
})(JobErrorCode || (exports.JobErrorCode = JobErrorCode = {}));
/** Error boundary that preserves a machine-readable code and optional cause. */
class JobEngineError extends Error {
    code;
    cause;
    constructor(code, message, cause) {
        super(message, cause === undefined ? undefined : { cause });
        this.name = 'JobEngineError';
        this.code = code;
        this.cause = cause;
    }
}
exports.JobEngineError = JobEngineError;
