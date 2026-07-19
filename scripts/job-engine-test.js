'use strict';

const assert = require('node:assert/strict');
const { BackgroundJob } = require('../dist/core/jobs/Job.js');
const { JobEngineError, JobErrorCode } = require('../dist/core/jobs/JobError.js');
const { JobManager, JobAlreadyRunningError } = require('../dist/core/jobs/JobManager.js');
const { JobRegistry } = require('../dist/core/jobs/JobRegistry.js');
const { JobStatus, JobStatusMachine } = require('../dist/core/jobs/JobStatus.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function testStatusTransitionsAndErrors() {
  const changes = [];
  const machine = new JobStatusMachine((previous, current) => changes.push(`${previous}->${current}`));
  machine.transition(JobStatus.Running);
  machine.transition(JobStatus.Cancelling);
  machine.transition(JobStatus.Cancelled);
  assert.deepEqual(changes, ['Pending->Running', 'Running->Cancelling', 'Cancelling->Cancelled']);
  assert.throws(
    () => machine.transition(JobStatus.Running),
    error => error instanceof JobEngineError && error.code === JobErrorCode.Internal
  );

  const cause = new Error('root cause');
  for (const code of Object.values(JobErrorCode)) {
    const error = new JobEngineError(code, 'message', cause);
    assert.equal(error.code, code);
    assert.equal(error.message, 'message');
    assert.equal(error.cause, cause);
  }
}

async function testVersionContextHooksAndEvents() {
  const gate = deferred();
  const hooks = [];
  let receivedContext;

  class ControlledJob extends BackgroundJob {
    name = 'controlled';
    version = 2;
    beforeStart = context => { hooks.push(`beforeStart:${context.status}`); };
    afterStart = context => { hooks.push(`afterStart:${context.status}`); throw new Error('isolated hook failure'); };
    beforeCancel = context => { hooks.push(`beforeCancel:${context.status}`); };
    afterCancel = context => { hooks.push(`afterCancel:${context.status}`); };

    async run(context) {
      receivedContext = context;
      context.reportProgress({ phase: 'processing', current: 1, total: 2, message: 'Started' });
      await gate.promise;
      context.cancellationToken.throwIfCancellationRequested();
    }
  }

  const registry = new JobRegistry();
  registry.register({ name: 'controlled', version: 2, factory: () => new ControlledJob() });
  assert.equal(registry.getDefinition('controlled')?.version, 2);
  assert.equal(Object.isFrozen(registry.getDefinition('controlled')), true);

  const manager = new JobManager(registry);
  const events = [];
  const started = deferred();
  for (const event of ['job.started', 'job.progress', 'job.completed', 'job.failed', 'job.cancelled', 'job.statusChanged']) {
    manager.events.on(event, payload => { events.push({ event, payload }); });
  }
  manager.events.on('job.started', () => { throw new Error('isolated event listener failure'); });
  manager.events.on('job.started', () => started.resolve());

  const handle = manager.start('controlled');
  await started.promise;
  assert.equal(handle.version, 2);
  assert.equal(handle.snapshot().status, JobStatus.Running);
  assert.equal(handle.snapshot().progress.percent, 50);
  assert.equal(Object.isFrozen(receivedContext), true);
  assert.equal(receivedContext.status, JobStatus.Running);
  assert.throws(
    () => manager.start('controlled'),
    error => error instanceof JobAlreadyRunningError && error.code === JobErrorCode.Locked
  );

  assert.equal(await handle.cancel('test cancellation'), true);
  assert.equal(await handle.cancel('duplicate cancellation'), false);
  gate.resolve();
  const cancelled = await handle.completion;
  assert.equal(cancelled.status, JobStatus.Cancelled);
  assert.equal(cancelled.error.code, JobErrorCode.Cancelled);
  assert.deepEqual(hooks, [
    'beforeStart:Pending',
    'afterStart:Running',
    'beforeCancel:Running',
    'afterCancel:Cancelling'
  ]);
  assert.ok(events.some(item => item.event === 'job.started'));
  assert.ok(events.some(item => item.event === 'job.progress'));
  assert.ok(events.some(item => item.event === 'job.cancelled'));
  assert.ok(events.some(item => item.event === 'job.statusChanged' && item.payload.current === JobStatus.Cancelling));
}

async function testCompletionAndFailureLifecycle() {
  const completeHooks = [];
  class CompleteJob extends BackgroundJob {
    name = 'complete';
    version = 1;
    beforeComplete = context => { completeHooks.push(`beforeComplete:${context.status}`); };
    afterComplete = context => { completeHooks.push(`afterComplete:${context.status}`); };
    async run(context) { context.metrics.addProcessedItems(3); }
  }

  let onErrorCode;
  class FailedJob extends BackgroundJob {
    name = 'failed';
    version = 1;
    async run() { throw new Error('business failure'); }
    onError = error => { onErrorCode = error.code; throw new Error('isolated onError failure'); };
  }

  const registry = new JobRegistry();
  registry.register({ name: 'complete', version: 1, factory: () => new CompleteJob() });
  registry.register({ name: 'failed', version: 1, factory: () => new FailedJob() });
  const manager = new JobManager(registry);
  const emitted = [];
  manager.events.on('job.completed', snapshot => emitted.push(`completed:${snapshot.status}`));
  manager.events.on('job.failed', snapshot => emitted.push(`failed:${snapshot.error.code}`));

  const completed = await manager.start('complete').completion;
  assert.equal(completed.status, JobStatus.Completed);
  assert.equal(completed.metrics.processedItems, 3);
  assert.deepEqual(completeHooks, ['beforeComplete:Running', 'afterComplete:Completed']);

  const failed = await manager.start('failed').completion;
  assert.equal(failed.status, JobStatus.Failed);
  assert.equal(failed.error.code, JobErrorCode.Failed);
  assert.equal(failed.error.cause.message, 'business failure');
  assert.equal(onErrorCode, JobErrorCode.Failed);
  assert.deepEqual(emitted, ['completed:Completed', 'failed:JOB_FAILED']);
}

async function testVersionValidation() {
  class VersionedJob extends BackgroundJob {
    name = 'versioned';
    version = 2;
    async run() {}
  }
  const registry = new JobRegistry();
  registry.register({ name: 'versioned', version: 1, factory: () => new VersionedJob() });
  assert.throws(
    () => registry.create('versioned'),
    error => error instanceof JobEngineError && error.code === JobErrorCode.Internal
  );
}

async function main() {
  await testStatusTransitionsAndErrors();
  await testVersionContextHooksAndEvents();
  await testCompletionAndFailureLifecycle();
  await testVersionValidation();
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
