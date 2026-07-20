'use strict';

const assert = require('node:assert/strict');
const { JobManager } = require('../dist/core/jobs/JobManager.js');
const { JobRegistry } = require('../dist/core/jobs/JobRegistry.js');
const { JobStatus } = require('../dist/core/jobs/JobStatus.js');
const { SupplierSleepJob } = require('../dist/jobs/SupplierSleepJob.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function createManager() {
  const registry = new JobRegistry();
  registry.register({ name:'supplier-sleep', version:1, factory:input => new SupplierSleepJob(input) });
  return new JobManager(registry);
}

async function testExecutionProgressMetricsAndEvents() {
  const expectedResult = { ok:true, count:2, list:[{},{}], snapshot:{ purchaseInvoicesSynced:2, purchaseLayerCount:3 } };
  let receivedResult;
  const service = {
    async readPurchaseInvoicesForSupplier() { throw new Error('wrong operation'); },
    async buildSelectedSupplierSnapshot(_db, request) {
      request.jobControl.progress({ phase:'Reading Purchase Invoices', current:2, total:2, message:'Invoices read' });
      request.jobControl.heartbeat();
      request.jobControl.progress({ phase:'Building Layers', current:3, total:3, message:'Layers built' });
      return expectedResult;
    }
  };
  const manager = createManager();
  const input = {
    operation:'build-selected-snapshot', db:{}, request:{ supplierAccountNo:'10' }, service,
    onResult:result => { receivedResult = result; }
  };
  const events = [];
  for (const event of ['job.started','job.progress','job.completed','job.statusChanged']) {
    manager.events.on(event, payload => events.push({ event, payload }));
  }

  const handle = manager.start('supplier-sleep', input);
  const snapshot = await handle.completion;
  assert.equal(handle.version, 1);
  assert.equal(snapshot.status, JobStatus.Completed);
  assert.equal(receivedResult, expectedResult);
  assert.equal(snapshot.progress.phase, 'Completed');
  assert.equal(snapshot.metrics.completedAt instanceof Date, true);
  assert.equal(snapshot.metrics.counters.supplierCount, 1);
  assert.equal(snapshot.metrics.counters.invoiceCount, 2);
  assert.equal(snapshot.metrics.counters.layerCount, 3);
  assert.equal(snapshot.metrics.processedItems, 5);
  assert.ok(snapshot.metrics.duration >= 0);
  assert.ok(events.some(item => item.event === 'job.started'));
  assert.ok(events.some(item => item.event === 'job.progress' && item.payload.progress.phase === 'Building Layers'));
  assert.ok(events.some(item => item.event === 'job.completed'));
  assert.ok(events.some(item => item.event === 'job.statusChanged' && item.payload.current === JobStatus.Completed));
}

async function testCooperativeCancellation() {
  const entered = deferred();
  const release = deferred();
  const service = {
    async readPurchaseInvoicesForSupplier(_db, request) {
      entered.resolve();
      await release.promise;
      request.jobControl.checkCancellation();
      return { ok:true, count:0, list:[] };
    },
    async buildSelectedSupplierSnapshot() { throw new Error('wrong operation'); }
  };
  const manager = createManager();
  let cancelledEvent = false;
  manager.events.on('job.cancelled', () => { cancelledEvent = true; });
  const handle = manager.start('supplier-sleep', { operation:'read-selected-invoices', db:{}, request:{ supplierName:'Supplier' }, service });
  await entered.promise;
  assert.equal(await handle.cancel('test cancellation'), true);
  release.resolve();
  const snapshot = await handle.completion;
  assert.equal(snapshot.status, JobStatus.Cancelled);
  assert.equal(cancelledEvent, true);
}

async function main() {
  await testExecutionProgressMetricsAndEvents();
  await testCooperativeCancellation();
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
