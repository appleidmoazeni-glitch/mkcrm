/** Opaque ownership token returned by a successful lock acquisition. */
export interface JobLockHandle { readonly jobName: string; readonly ownerId: symbol; }

/** Process-local lock that permits one execution per registered job name. */
export class JobLock {
  private readonly owners = new Map<string, symbol>();

  acquire(jobName: string): JobLockHandle | undefined {
    if (this.owners.has(jobName)) return undefined;
    const ownerId = Symbol(jobName);
    this.owners.set(jobName, ownerId);
    return { jobName, ownerId };
  }

  release(handle: JobLockHandle): boolean {
    if (this.owners.get(handle.jobName) !== handle.ownerId) return false;
    return this.owners.delete(handle.jobName);
  }

  isLocked(jobName: string): boolean { return this.owners.has(jobName); }
}
