import type { BackgroundJob } from './Job.js';
import { JobEngineError, JobErrorCode } from './JobError.js';

export type JobFactory = (input?: unknown) => BackgroundJob;

/** Versioned definition retained by the in-memory registry. */
export interface JobDefinition {
  readonly name: string;
  readonly version: number;
  readonly factory: JobFactory;
}

/** In-memory catalog of job factories, keyed by stable job type name. */
export class JobRegistry {
  private readonly definitions = new Map<string, JobDefinition>();

  register(definition: JobDefinition): void {
    const normalized = definition.name.trim();
    if (!normalized) throw new JobEngineError(JobErrorCode.Internal, 'Job name is required');
    if (!Number.isInteger(definition.version) || definition.version < 1) throw new JobEngineError(JobErrorCode.Internal, `Invalid job version: ${definition.version}`);
    if (this.definitions.has(normalized)) throw new JobEngineError(JobErrorCode.Internal, `Job already registered: ${normalized}`);
    this.definitions.set(normalized, Object.freeze({ ...definition, name: normalized }));
  }

  unregister(name: string): boolean { return this.definitions.delete(name); }
  has(name: string): boolean { return this.definitions.has(name); }
  names(): readonly string[] { return [...this.definitions.keys()]; }
  getDefinition(name: string): JobDefinition | undefined { return this.definitions.get(name); }

  create(name: string, input?: unknown): BackgroundJob {
    const definition = this.definitions.get(name);
    if (!definition) throw new JobEngineError(JobErrorCode.Internal, `Unknown job: ${name}`);
    let job: BackgroundJob;
    try { job = definition.factory(input); }
    catch (error) { throw new JobEngineError(JobErrorCode.Internal, `Job factory failed: ${name}`, error); }
    if (job.name !== name) throw new JobEngineError(JobErrorCode.Internal, `Registered job name mismatch: expected ${name}, received ${job.name}`);
    if (job.version !== definition.version) throw new JobEngineError(JobErrorCode.Internal, `Registered job version mismatch: expected ${definition.version}, received ${job.version}`);
    return job;
  }
}
