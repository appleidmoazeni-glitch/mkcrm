"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobStatusMachine = exports.JobStatus = void 0;
const JobError_js_1 = require("./JobError.js");
/** Canonical lifecycle states for every engine execution. */
var JobStatus;
(function (JobStatus) {
    JobStatus["Pending"] = "Pending";
    JobStatus["Running"] = "Running";
    JobStatus["Cancelling"] = "Cancelling";
    JobStatus["Completed"] = "Completed";
    JobStatus["Failed"] = "Failed";
    JobStatus["Cancelled"] = "Cancelled";
})(JobStatus || (exports.JobStatus = JobStatus = {}));
const transitions = {
    [JobStatus.Pending]: new Set([JobStatus.Running, JobStatus.Cancelling, JobStatus.Failed, JobStatus.Cancelled]),
    [JobStatus.Running]: new Set([JobStatus.Cancelling, JobStatus.Completed, JobStatus.Failed, JobStatus.Cancelled]),
    [JobStatus.Cancelling]: new Set([JobStatus.Completed, JobStatus.Cancelled, JobStatus.Failed]),
    [JobStatus.Completed]: new Set(),
    [JobStatus.Failed]: new Set(),
    [JobStatus.Cancelled]: new Set()
};
/** Validates and owns status transitions for one execution. */
class JobStatusMachine {
    onTransition;
    currentStatus = JobStatus.Pending;
    constructor(onTransition) {
        this.onTransition = onTransition;
    }
    get current() { return this.currentStatus; }
    canTransition(next) { return transitions[this.currentStatus].has(next); }
    transition(next) {
        const previous = this.currentStatus;
        if (!this.canTransition(next)) {
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, `Illegal job status transition: ${previous} -> ${next}`);
        }
        this.currentStatus = next;
        this.onTransition?.(previous, next);
    }
}
exports.JobStatusMachine = JobStatusMachine;
