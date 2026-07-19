import type { BackgroundJob } from './Job.js';

export type JobFactory = () => BackgroundJob;

/** In-memory catalog of job factories, keyed by stable job type name. */
export class JobRegistry {
  private readonly factories = new Map<string, JobFactory>();

  register(name: string, factory: JobFactory): void {
    const normalized = name.trim();
    if (!normalized) throw new Error('Job name is required');
    if (this.factories.has(normalized)) throw new Error(`Job already registered: ${normalized}`);
    this.factories.set(normalized, factory);
  }

  unregister(name: string): boolean { return this.factories.delete(name); }
  has(name: string): boolean { return this.factories.has(name); }
  names(): readonly string[] { return [...this.factories.keys()]; }

  create(name: string): BackgroundJob {
    const factory = this.factories.get(name);
    if (!factory) throw new Error(`Unknown job: ${name}`);
    const job = factory();
    if (job.name !== name) throw new Error(`Registered job name mismatch: expected ${name}, received ${job.name}`);
    return job;
  }
}
