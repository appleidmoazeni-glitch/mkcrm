/** Tracks liveness without owning an interval or imposing a heartbeat policy. */
export class JobHeartbeat {
  private timestamp: Date;

  constructor(now: Date = new Date()) { this.timestamp = now; }

  beat(now: Date = new Date()): Date {
    this.timestamp = now;
    return this.lastHeartbeatAt;
  }

  get lastHeartbeatAt(): Date { return new Date(this.timestamp.getTime()); }
}
