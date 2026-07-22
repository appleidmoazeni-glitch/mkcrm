'use strict';
const assert=require('node:assert/strict');
const {JobStatus}=require('../dist/core/jobs/JobStatus.js');
const {createInventorySyncManager,deferred,delay}=require('./job-test-utils.js');

const success={ok:true,activeWarehouseNumbers:['1','2'],stockRows:12,protectedFromStale:3,queuedForLiveVerify:2,stockResults:[{ok:true,pages:2,total:7},{ok:true,pages:1,total:5}],updatedRows:8,insertedRows:4};
function input(service,onResult){return {request:{pages:20,options:{source:'test'}},service,onResult};}
function immediate(result=success){return {async sync(request){const c=request.jobControl;c.progress({phase:'Reading warehouses',current:0,total:2,message:'warehouses'});c.progress({phase:'Reading Shaygan pages',current:1,total:3,message:'pages'});c.heartbeat();c.progress({phase:'Merge inventory',current:2,total:2,message:'merge'});c.progress({phase:'Live repair queue',current:1,total:1,message:'repair'});c.progress({phase:'Persist inventory',current:3,total:3,message:'persist'});return result;}};}

async function successAndMetrics(){
  const {manager}=createInventorySyncManager();const events=[];let received;
  for(const name of ['job.started','job.progress','job.completed','job.statusChanged'])manager.events.on(name,p=>events.push({name,p}));
  const handle=manager.start('inventory-sync',input(immediate(),r=>{received=r;}));const snapshot=await handle.completion;
  assert.equal(handle.version,1);assert.equal(snapshot.status,JobStatus.Completed);assert.equal(received,success);assert.equal(snapshot.progress.phase,'Finalize');
  assert.equal(snapshot.metrics.counters.warehouseCount,2);assert.equal(snapshot.metrics.counters.pageCount,3);assert.equal(snapshot.metrics.counters.inventoryRows,12);
  assert.equal(snapshot.metrics.counters.mergedRows,12);assert.equal(snapshot.metrics.counters.updatedRows,8);assert.equal(snapshot.metrics.counters.insertedRows,4);
  assert.equal(snapshot.metrics.counters.protectedRows,3);assert.equal(snapshot.metrics.counters.liveRepairQueued,2);assert.equal(snapshot.metrics.processedItems,12);
  assert.ok(events.some(x=>x.name==='job.started'));assert.ok(events.some(x=>x.name==='job.progress'));assert.ok(events.some(x=>x.name==='job.completed'));
}
async function lockCancellationAndRecovery(){
  const {manager}=createInventorySyncManager();const entered=deferred(),release=deferred();let writeInProgress=false;
  const service={async sync(request){entered.resolve();await release.promise;request.jobControl.checkCancellation();writeInProgress=true;writeInProgress=false;return success;}};
  const first=manager.start('inventory-sync',input(service));await entered.promise;
  assert.throws(()=>manager.start('inventory-sync',input(service)),e=>e.code==='JOB_LOCKED');
  assert.equal(await first.cancel('test'),true);release.resolve();assert.equal((await first.completion).status,JobStatus.Cancelled);assert.equal(writeInProgress,false);
  assert.equal((await manager.start('inventory-sync',input(immediate())).completion).status,JobStatus.Completed);
  const failed=await manager.start('inventory-sync',input({async sync(){throw new Error('controlled');}})).completion;assert.equal(failed.status,JobStatus.Failed);
  assert.equal((await manager.start('inventory-sync',input(immediate())).completion).status,JobStatus.Completed);
}
async function heartbeatAndListeners(){
  const {manager}=createInventorySyncManager();const gate=deferred();const release=deferred();
  const unsubscribe=manager.events.on('job.progress',()=>{});assert.equal(manager.events.listenerCount(),1);
  const handle=manager.start('inventory-sync',input({async sync(request){gate.resolve();await release.promise;request.jobControl.heartbeat();return success;}}));
  await gate.promise;const before=handle.snapshot().heartbeatAt;await delay(2);release.resolve();const terminal=await handle.completion;assert.ok(terminal.heartbeatAt>=before);
  const stopped=terminal.heartbeatAt.getTime();await delay(5);assert.equal(handle.snapshot().heartbeatAt.getTime(),stopped);unsubscribe();assert.equal(manager.events.listenerCount(),0);
}
(async()=>{await successAndMetrics();await lockCancellationAndRecovery();await heartbeatAndListeners();})().catch(e=>{process.stderr.write(`${e.stack||e}\n`);process.exitCode=1;});
