'use strict';

const assert = require('node:assert/strict');
const { JobEngineError, JobErrorCode } = require('../dist/core/jobs/JobError.js');
const { JobHeartbeat } = require('../dist/core/jobs/JobHeartbeat.js');
const { JobStatus } = require('../dist/core/jobs/JobStatus.js');
const { createSupplierManager, deferred, delay } = require('./job-test-utils.js');

const supplierRequest = { supplierAccountNo:'SUP-1', supplierName:'Supplier' };
const successResult = {
  ok:true,
  count:2,
  list:[{}, {}],
  snapshot:{ purchaseInvoicesSynced:2, purchaseLayerCount:3, allocatedLayerCount:3 }
};

function inputFor(service, operation = 'build-selected-snapshot') {
  return { operation, db:{}, request:supplierRequest, service };
}

function immediateService(result = successResult) {
  return {
    async readPurchaseInvoicesForSupplier() { return result; },
    async buildSelectedSupplierSnapshot(_db, request) {
      const control = request.jobControl;
      control.progress({ phase:'Reading Purchase Invoices', current:2, total:2, message:'Invoices loaded' });
      control.progress({ phase:'Building Layers', current:3, total:3, message:'Layers built' });
      control.progress({ phase:'Calculating Remaining Stock', current:4, total:4, message:'Stock calculated' });
      control.progress({ phase:'Saving Snapshot', current:1, total:1, message:'Snapshot saved' });
      return result;
    }
  };
}

function assertFinalizedMetrics(snapshot) {
  assert.equal(snapshot.metrics.startedAt instanceof Date, true);
  assert.equal(snapshot.metrics.completedAt instanceof Date, true);
  assert.ok(snapshot.metrics.completedAt >= snapshot.metrics.startedAt);
  assert.ok(snapshot.metrics.duration >= 0);
  assert.equal(snapshot.metrics.updatedAt.getTime(), snapshot.metrics.completedAt.getTime());
}

async function testConcurrencyAndLockRelease() {
  const entered = deferred();
  const release = deferred();
  let workers = 0;
  let maxWorkers = 0;
  const service = {
    async readPurchaseInvoicesForSupplier() { throw new Error('wrong operation'); },
    async buildSelectedSupplierSnapshot() {
      workers += 1;
      maxWorkers = Math.max(maxWorkers, workers);
      entered.resolve();
      await release.promise;
      workers -= 1;
      return successResult;
    }
  };
  const { registry, manager } = createSupplierManager();
  const first = manager.start('supplier-sleep', inputFor(service));
  assert.throws(
    () => manager.start('supplier-sleep', inputFor(service)),
    error => error instanceof JobEngineError && error.code === JobErrorCode.Locked
  );
  await entered.promise;
  assert.equal(manager.listRunning().length, 1);
  assert.equal(registry.names().length, 1);
  assert.equal(maxWorkers, 1);
  release.resolve();
  assert.equal((await first.completion).status, JobStatus.Completed);
  assert.equal(manager.listRunning().length, 0);
  assert.equal((await manager.start('supplier-sleep', inputFor(immediateService())).completion).status, JobStatus.Completed);

  const cancelEntered = deferred();
  const cancelRelease = deferred();
  const cancellable = {
    async readPurchaseInvoicesForSupplier() { throw new Error('wrong operation'); },
    async buildSelectedSupplierSnapshot(_db, request) {
      cancelEntered.resolve();
      await cancelRelease.promise;
      request.jobControl.checkCancellation();
      return successResult;
    }
  };
  const cancelling = manager.start('supplier-sleep', inputFor(cancellable));
  await cancelEntered.promise;
  await cancelling.cancel('release lock after cancellation');
  cancelRelease.resolve();
  assert.equal((await cancelling.completion).status, JobStatus.Cancelled);
  assert.equal((await manager.start('supplier-sleep', inputFor(immediateService())).completion).status, JobStatus.Completed);

  const failing = manager.start('supplier-sleep', inputFor({
    async readPurchaseInvoicesForSupplier() { throw new Error('wrong operation'); },
    async buildSelectedSupplierSnapshot() { throw new Error('controlled failure'); }
  }));
  assert.equal((await failing.completion).status, JobStatus.Failed);
  assert.equal((await manager.start('supplier-sleep', inputFor(immediateService())).completion).status, JobStatus.Completed);
}

async function runCancellationScenario(target, immediate = false) {
  const entered = deferred();
  const release = deferred();
  const state = { completedWrites:0, writeInProgress:false };
  const service = {
    async readPurchaseInvoicesForSupplier() { throw new Error('wrong operation'); },
    async buildSelectedSupplierSnapshot(_db, request) {
      const control = request.jobControl;
      for (const stage of ['supplier-loop','invoice-loop','before-snapshot-save']) {
        control.progress({
          phase:stage === 'supplier-loop' ? 'Loading Suppliers' : stage === 'invoice-loop' ? 'Reading Purchase Invoices' : 'Saving Snapshot',
          current:stage === 'before-snapshot-save' ? 0 : 1,
          total:1,
          message:stage
        });
        if (stage === target) { entered.resolve(); await release.promise; }
        control.checkCancellation();
        if (stage !== 'before-snapshot-save') {
          state.writeInProgress = true;
          state.completedWrites += 1;
          state.writeInProgress = false;
        }
      }
      state.writeInProgress = true;
      state.completedWrites += 1;
      state.writeInProgress = false;
      return successResult;
    }
  };
  const { manager } = createSupplierManager();
  const eventNames = [];
  const unsubscribers = [
    manager.events.on('job.started', () => eventNames.push('job.started')),
    manager.events.on('job.progress', () => eventNames.push('job.progress')),
    manager.events.on('job.cancelled', () => eventNames.push('job.cancelled'))
  ];
  const handle = manager.start('supplier-sleep', inputFor(service));
  if (!immediate) await entered.promise;
  assert.equal(await handle.cancel(`cancel at ${target}`), true);
  release.resolve();
  const snapshot = await handle.completion;
  assert.equal(snapshot.status, JobStatus.Cancelled);
  assert.equal(state.writeInProgress, false);
  if (target === 'before-snapshot-save') assert.equal(state.completedWrites, 2);
  assertFinalizedMetrics(snapshot);
  assert.equal(snapshot.metrics.errors, 0);
  assert.equal(snapshot.metrics.retries, 0);
  assert.equal(eventNames.filter(name => name === 'job.cancelled').length, 1);
  assert.equal(eventNames.at(-1), 'job.cancelled');
  unsubscribers.forEach(unsubscribe => unsubscribe());
  assert.equal(manager.events.listenerCount(), 0);
}

async function testCancellationBoundaries() {
  await runCancellationScenario('supplier-loop', true);
  await runCancellationScenario('supplier-loop');
  await runCancellationScenario('invoice-loop');
  await runCancellationScenario('before-snapshot-save');
  const { manager } = createSupplierManager();
  const handle = manager.start('supplier-sleep', inputFor(immediateService()));
  assert.equal((await handle.completion).status, JobStatus.Completed);
  assert.equal(await handle.cancel('too late'), false);
}

async function testHeartbeatLifecycle() {
  const heartbeat = new JobHeartbeat(new Date(100));
  heartbeat.beat(new Date(200));
  heartbeat.beat(new Date(150));
  assert.equal(heartbeat.lastHeartbeatAt.getTime(), 200);

  const firstBeat = deferred();
  const secondBeat = deferred();
  const releaseFirst = deferred();
  const releaseSecond = deferred();
  const service = {
    async readPurchaseInvoicesForSupplier() { throw new Error('wrong operation'); },
    async buildSelectedSupplierSnapshot(_db, request) {
      await releaseFirst.promise;
      request.jobControl.heartbeat();
      firstBeat.resolve();
      await releaseSecond.promise;
      request.jobControl.heartbeat();
      secondBeat.resolve();
      return successResult;
    }
  };
  const { manager } = createSupplierManager();
  const handle = manager.start('supplier-sleep', inputFor(service));
  const initial = handle.snapshot().heartbeatAt;
  await delay(2); releaseFirst.resolve(); await firstBeat.promise;
  const first = handle.snapshot().heartbeatAt;
  await delay(2); releaseSecond.resolve(); await secondBeat.promise;
  const second = handle.snapshot().heartbeatAt;
  assert.ok(first >= initial);
  assert.ok(second >= first);
  const completed = await handle.completion;
  const stoppedAt = completed.heartbeatAt.getTime();
  await delay(5);
  assert.equal(handle.snapshot().heartbeatAt.getTime(), stoppedAt);

  for (const mode of ['cancelled','failed']) {
    const gate = deferred();
    const testService = {
      async readPurchaseInvoicesForSupplier() { throw new Error('wrong operation'); },
      async buildSelectedSupplierSnapshot(_db, request) {
        if (mode === 'cancelled') { await gate.promise; request.jobControl.checkCancellation(); }
        throw new Error('heartbeat failure');
      }
    };
    const execution = manager.start('supplier-sleep', inputFor(testService));
    if (mode === 'cancelled') { await execution.cancel('heartbeat cancellation'); gate.resolve(); }
    const terminal = await execution.completion;
    const terminalHeartbeat = terminal.heartbeatAt.getTime();
    await delay(5);
    assert.equal(execution.snapshot().heartbeatAt.getTime(), terminalHeartbeat);
  }
}

async function testProgressAndEvents() {
  const { manager } = createSupplierManager();
  const order = [];
  const progress = [];
  const unsubscribers = [
    manager.events.on('job.started', () => order.push('job.started')),
    manager.events.on('job.progress', payload => { order.push('job.progress'); progress.push(payload.progress); }),
    manager.events.on('job.completed', () => order.push('job.completed')),
    manager.events.on('job.failed', () => order.push('job.failed')),
    manager.events.on('job.cancelled', () => order.push('job.cancelled'))
  ];
  const snapshot = await manager.start('supplier-sleep', inputFor(immediateService())).completion;
  assert.equal(order[0], 'job.started');
  assert.equal(order.at(-1), 'job.completed');
  assert.equal(order.filter(event => event === 'job.completed').length, 1);
  assert.equal(order.filter(event => event === 'job.failed' || event === 'job.cancelled').length, 0);
  assert.deepEqual([...new Set(progress.map(item => item.phase))], [
    'Loading Suppliers','Reading Purchase Invoices','Building Layers','Calculating Remaining Stock','Saving Snapshot','Completed'
  ]);
  for (let index = 0; index < progress.length; index += 1) {
    assert.ok(progress[index].percent >= (progress[index - 1]?.percent ?? 0));
    assert.ok(progress[index].percent <= 100);
    assert.ok(progress[index].current <= progress[index].total);
  }
  assert.equal(snapshot.progress.percent, 100);
  unsubscribers.forEach(unsubscribe => unsubscribe());
  assert.equal(manager.events.listenerCount(), 0);
}

async function testMetricsFailureRecoveryAndRestart() {
  const { registry, manager } = createSupplierManager();
  let failedEvents = 0;
  const unsubscribe = manager.events.on('job.failed', snapshot => {
    failedEvents += 1;
    assert.equal(snapshot.error.code, JobErrorCode.Failed);
  });
  const failedHandle = manager.start('supplier-sleep', inputFor({
    async readPurchaseInvoicesForSupplier() { throw new Error('wrong operation'); },
    async buildSelectedSupplierSnapshot() { throw new Error('injected failure'); }
  }));
  const failed = await failedHandle.completion;
  assert.equal(failed.status, JobStatus.Failed);
  assert.equal(failed.metrics.errors, 1);
  assert.equal(failed.metrics.retries, 0);
  assertFinalizedMetrics(failed);
  assert.equal(failedEvents, 1);
  assert.equal(manager.listRunning().length, 0);
  assert.equal(registry.names().length, 1);
  assert.equal((await manager.start('supplier-sleep', inputFor(immediateService())).completion).status, JobStatus.Completed);
  unsubscribe();

  const restarted = createSupplierManager();
  assert.equal(restarted.manager.listRunning().length, 0);
  assert.equal((await restarted.manager.start('supplier-sleep', inputFor(immediateService())).completion).status, JobStatus.Completed);
}

async function testRepeatedExecutionsAndBoundedState() {
  const { registry, manager } = createSupplierManager();
  for (let index = 0; index < 50; index += 1) {
    let terminalEvents = 0;
    const unsubscribe = manager.events.on('job.completed', () => { terminalEvents += 1; });
    const snapshot = await manager.start('supplier-sleep', inputFor(immediateService())).completion;
    unsubscribe();
    assert.equal(snapshot.status, JobStatus.Completed);
    assert.equal(snapshot.metrics.processedItems, 5);
    assert.equal(snapshot.metrics.counters.supplierCount, 1);
    assert.equal(snapshot.metrics.counters.invoiceCount, 2);
    assert.equal(snapshot.metrics.counters.layerCount, 3);
    assert.equal(terminalEvents, 1);
    assert.equal(manager.listRunning().length, 0);
    assert.equal(manager.events.listenerCount(), 0);
    assert.equal(registry.names().length, 1);
  }
  assert.equal(manager.getLatest('supplier-sleep').status, JobStatus.Completed);
}

async function main() {
  await testConcurrencyAndLockRelease();
  await testCancellationBoundaries();
  await testHeartbeatLifecycle();
  await testProgressAndEvents();
  await testMetricsFailureRecoveryAndRestart();
  await testRepeatedExecutionsAndBoundedState();
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
