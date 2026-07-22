"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.JobRegistry = void 0;
const JobError_js_1 = require("./JobError.js");
/** In-memory catalog of job factories, keyed by stable job type name. */
class JobRegistry {
    definitions = new Map();
    register(definition) {
        const normalized = definition.name.trim();
        if (!normalized)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, 'Job name is required');
        if (!Number.isInteger(definition.version) || definition.version < 1)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, `Invalid job version: ${definition.version}`);
        if (this.definitions.has(normalized))
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, `Job already registered: ${normalized}`);
        this.definitions.set(normalized, Object.freeze({ ...definition, name: normalized }));
    }
    unregister(name) { return this.definitions.delete(name); }
    has(name) { return this.definitions.has(name); }
    names() { return [...this.definitions.keys()]; }
    getDefinition(name) { return this.definitions.get(name); }
    create(name, input) {
        const definition = this.definitions.get(name);
        if (!definition)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, `Unknown job: ${name}`);
        let job;
        try {
            job = definition.factory(input);
        }
        catch (error) {
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, `Job factory failed: ${name}`, error);
        }
        if (job.name !== name)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, `Registered job name mismatch: expected ${name}, received ${job.name}`);
        if (job.version !== definition.version)
            throw new JobError_js_1.JobEngineError(JobError_js_1.JobErrorCode.Internal, `Registered job version mismatch: expected ${definition.version}, received ${job.version}`);
        return job;
    }
}
exports.JobRegistry = JobRegistry;
