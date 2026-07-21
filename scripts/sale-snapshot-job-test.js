'use strict';
const assert=require('node:assert/strict');
const {JobStatus}=require('../dist/core/jobs/JobStatus.js');
const {createSaleSnapshotManager,deferred}=require('./job-test-utils.js');
const {_saleInvoicesOnly}=require('../src/lib/sale-snapshot.js');

function invoiceTypeMapping(){
  const rows=[{InvTyp:2,id:'sale'},{InvTyp:6,id:'sale-return'},{InvoiceType:7,id:'purchase-return'}];
  assert.deepEqual(_saleInvoicesOnly(rows,2).map(x=>x.id),['sale']);
}

async function execution(mode){
  const {manager}=createSaleSnapshotManager(); const events=[]; let received;
  for(const name of ['job.started','job.progress','job.completed','job.statusChanged']) manager.events.on(name,payload=>events.push({name,payload}));
  const expected={ok:true,snapshotId:'SNAP-1',mode,invoiceHeadersFound:2,saleLinesParsed:3,pagesScanned:1,sellerStats:[{cashboxAccountName:'Cashier'}],errors:[]};
  const service={async buildSaleSnapshot(_db,request){assert.equal(request.mode,mode);request.jobControl.progress({phase:'Reading Sale Invoices',current:1,total:2,message:'page'});request.jobControl.heartbeat();request.jobControl.progress({phase:'Saving Snapshot',current:1,total:1,message:'save'});return expected;}};
  const handle=manager.start('sale-snapshot',{db:{},request:{mode,reset:mode==='full'},service,onResult:r=>{received=r;}});
  const snapshot=await handle.completion;
  assert.equal(handle.version,1); assert.equal(snapshot.status,JobStatus.Completed); assert.equal(received,expected);
  assert.equal(snapshot.progress.phase,'Completed'); assert.equal(snapshot.metrics.counters.invoiceCount,2); assert.equal(snapshot.metrics.counters.itemCount,3);
  assert.equal(snapshot.metrics.counters.salespersonCount,1); assert.equal(snapshot.metrics.counters.cashierCount,1); assert.equal(snapshot.metrics.counters.pageCount,1);
  assert.equal(snapshot.metrics.counters.snapshotCount,1); assert.equal(snapshot.metrics.processedItems,5);
  assert.ok(events.some(x=>x.name==='job.started')); assert.ok(events.some(x=>x.name==='job.progress')); assert.ok(events.some(x=>x.name==='job.completed'));
}
async function lockAndCancellation(){
  const {manager}=createSaleSnapshotManager(); const entered=deferred(),release=deferred();
  const service={async buildSaleSnapshot(_db,request){entered.resolve();await release.promise;request.jobControl.checkCancellation();return {ok:true};}};
  const first=manager.start('sale-snapshot',{db:{},request:{},service}); await entered.promise;
  assert.throws(()=>manager.start('sale-snapshot',{db:{},request:{},service}),e=>e.code==='JOB_LOCKED');
  assert.equal(await first.cancel('test'),true); release.resolve(); assert.equal((await first.completion).status,JobStatus.Cancelled);
  const next=manager.start('sale-snapshot',{db:{},request:{},service:{async buildSaleSnapshot(){return {ok:true,snapshotId:'S2'};}}});
  assert.equal((await next.completion).status,JobStatus.Completed);
}
async function failure(){const {manager}=createSaleSnapshotManager();const s=await manager.start('sale-snapshot',{db:{},request:{},service:{async buildSaleSnapshot(){return {ok:false,error:'failed'};}}}).completion;assert.equal(s.status,JobStatus.Failed);assert.equal(s.error.code,'JOB_FAILED');}
(async()=>{invoiceTypeMapping();await execution('full');await execution('incremental');await lockAndCancellation();await failure();})().catch(e=>{process.stderr.write(`${e.stack||e}\n`);process.exitCode=1;});
