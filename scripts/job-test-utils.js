'use strict';

const { JobCancelledError } = require('../dist/core/jobs/JobCancellation.js');
const { JobManager } = require('../dist/core/jobs/JobManager.js');
const { JobRegistry } = require('../dist/core/jobs/JobRegistry.js');
const { SupplierSleepJob } = require('../dist/jobs/SupplierSleepJob.js');

class FakeHeartbeat {
  constructor(at = new Date(0)) { this.at = at; this.beats = []; }
  beat(at = new Date(this.at.getTime() + 1)) {
    if (at > this.at) this.at = at;
    this.beats.push(this.at);
    return this.at;
  }
  get lastHeartbeatAt() { return new Date(this.at); }
}

class FakeProgress {
  constructor() { this.updates = []; }
  update(value) { this.updates.push(Object.freeze({ ...value })); return this.snapshot(); }
  snapshot() { return this.updates.at(-1) || { phase:'pending', current:0, total:0, percent:0, message:'' }; }
}

class FakeCancellationToken {
  constructor() { this.isCancellationRequested = false; this.reason = undefined; }
  cancel(reason = 'Cancelled by test') { this.isCancellationRequested = true; this.reason = reason; }
  throwIfCancellationRequested() { if (this.isCancellationRequested) throw new JobCancelledError(this.reason); }
}

class FakeMetrics {
  constructor() { this.processedItems = 0; this.errors = 0; this.retries = 0; this.counters = {}; }
  addProcessedItems(count = 1) { this.processedItems += count; }
  recordError(count = 1) { this.errors += count; }
  recordRetry(count = 1) { this.retries += count; }
  setCounter(name, value) { this.counters[name] = value; }
}

class MockJobContext {
  constructor() {
    this.progress = new FakeProgress();
    this.heartbeat = new FakeHeartbeat();
    this.cancellationToken = new FakeCancellationToken();
    this.metrics = new FakeMetrics();
    this.logger = { debug(){}, info(){}, warn(){}, error(){}, log(){} };
    this.status = 'Running';
  }
  reportProgress(update) { this.heartbeatNow(); return this.progress.update(update); }
  heartbeatNow() { return this.heartbeat.beat(); }
}

class MockJobFactory {
  constructor(name, version, create) { this.name = name; this.version = version; this.create = create; }
  definition() { return { name:this.name, version:this.version, factory:this.create }; }
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function createSupplierManager() {
  const registry = new JobRegistry();
  registry.register(new MockJobFactory('supplier-sleep', 1, input => new SupplierSleepJob(input)).definition());
  return { registry, manager:new JobManager(registry) };
}

module.exports = {
  FakeHeartbeat,
  FakeProgress,
  FakeCancellationToken,
  FakeMetrics,
  MockJobContext,
  MockJobFactory,
  deferred,
  delay,
  createSupplierManager
};
