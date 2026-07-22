import type { JobExecutionSnapshot } from './JobManager.js';
import type { JobProgressSnapshot } from './JobProgress.js';
import type { JobStatus } from './JobStatus.js';

export interface JobEventMap {
  'job.started': JobExecutionSnapshot;
  'job.progress': { readonly job: JobExecutionSnapshot; readonly progress: JobProgressSnapshot };
  'job.completed': JobExecutionSnapshot;
  'job.failed': JobExecutionSnapshot;
  'job.cancelled': JobExecutionSnapshot;
  'job.statusChanged': { readonly jobId: string; readonly jobName: string; readonly previous: JobStatus; readonly current: JobStatus };
}

export type JobEventName = keyof JobEventMap;
export type JobEventListener<K extends JobEventName> = (payload: JobEventMap[K]) => void;

/** Small synchronous event bus. Listener failures are isolated from the engine. */
export class JobEventEmitter {
  private readonly listeners = new Map<JobEventName, Set<(payload: never) => void>>();

  on<K extends JobEventName>(event: K, listener: JobEventListener<K>): () => void {
    const listeners = this.listeners.get(event) ?? new Set<(payload: never) => void>();
    listeners.add(listener as (payload: never) => void);
    this.listeners.set(event, listeners);
    return () => this.off(event, listener);
  }

  off<K extends JobEventName>(event: K, listener: JobEventListener<K>): void {
    this.listeners.get(event)?.delete(listener as (payload: never) => void);
  }

  emit<K extends JobEventName>(event: K, payload: JobEventMap[K]): void {
    for (const listener of [...(this.listeners.get(event) ?? [])]) {
      try { listener(payload as never); } catch { /* Event consumers cannot fail a job. */ }
    }
  }

  removeAllListeners(): void { this.listeners.clear(); }
  listenerCount(event?: JobEventName): number {
    if (event) return this.listeners.get(event)?.size ?? 0;
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}
