"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobLock = void 0;
/** Process-local lock that permits one execution per registered job name. */
class JobLock {
    owners = new Map();
    acquire(jobName) {
        if (this.owners.has(jobName))
            return undefined;
        const ownerId = Symbol(jobName);
        this.owners.set(jobName, ownerId);
        return { jobName, ownerId };
    }
    release(handle) {
        if (this.owners.get(handle.jobName) !== handle.ownerId)
            return false;
        return this.owners.delete(handle.jobName);
    }
    isLocked(jobName) { return this.owners.has(jobName); }
}
exports.JobLock = JobLock;
