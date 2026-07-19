'use strict';

const assert = require('node:assert/strict');
const { BackgroundJob } = require('../dist/core/jobs/Job.js');
const { JobManager, JobAlreadyRunningError } = require('../dist/core/jobs/JobManager.js');
const { JobRegistry } = require('../dist/core/jobs/JobRegistry.js');

let releaseJob;

class ControlledJob extends BackgroundJob {
  name = 'controlled';

  async run(context) {
    context.reportProgress({ phase: 'processing', current: 1, total: 2, message: 'Started' });
    await new Promise(resolve => { releaseJob = resolve; });
    context.cancellation.throwIfCancellationRequested();
    context.metrics.addProcessedItems();
  }
}

async function main() {
  const registry = new JobRegistry();
  registry.register('controlled', () => new ControlledJob());
  assert.deepEqual(registry.names(), ['controlled']);

  const manager = new JobManager(registry);
  const first = manager.start('controlled');
  assert.equal(manager.isRunning('controlled'), true);
  assert.equal(first.snapshot().progress.percent, 50);
  assert.throws(() => manager.start('controlled'), JobAlreadyRunningError);

  assert.equal(first.cancel('test cancellation'), true);
  assert.equal(first.cancel('duplicate cancellation'), false);
  releaseJob();
  const cancelled = await first.completion;
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.metrics.processedItems, 0);
  assert.equal(manager.isRunning('controlled'), false);

  const second = manager.start('controlled');
  releaseJob();
  const completed = await second.completion;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.metrics.processedItems, 1);
  assert.ok(completed.metrics.duration >= 0);
  assert.equal(manager.getLatest('controlled')?.id, second.id);
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
