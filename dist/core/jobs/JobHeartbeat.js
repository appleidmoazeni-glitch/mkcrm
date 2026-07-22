"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobHeartbeat = void 0;
/** Tracks liveness without owning an interval or imposing a heartbeat policy. */
class JobHeartbeat {
    timestamp;
    constructor(now = new Date()) { this.timestamp = now; }
    beat(now = new Date()) {
        if (now.getTime() > this.timestamp.getTime())
            this.timestamp = now;
        return this.lastHeartbeatAt;
    }
    get lastHeartbeatAt() { return new Date(this.timestamp.getTime()); }
}
exports.JobHeartbeat = JobHeartbeat;
