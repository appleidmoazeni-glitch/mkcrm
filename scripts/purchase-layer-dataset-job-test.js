'use strict';

const assert=require('node:assert/strict');
const {JobManager}=require('../dist/core/jobs/JobManager.js');
const {JobRegistry}=require('../dist/core/jobs/JobRegistry.js');
const {JobStatus}=require('../dist/core/jobs/JobStatus.js');
const {PurchaseLayerDatasetJob}=require('../dist/jobs/PurchaseLayerDatasetJob.js');

function deferred(){
  let resolve;
  const promise=new Promise(done=>{resolve=done;});
  return {promise,resolve};
}
function manager(){
  const registry=new JobRegistry();
  registry.register({name:'purchase-layer-dataset',version:1,factory:input=>new PurchaseLayerDatasetJob(input)});
  return new JobManager(registry);
}

async function execution(){
  const jobs=manager();
  let received;
  const expected={ok:true,datasetId:'PLAYER-1',purchaseInvoiceCount:2,purchaseLineCount:3,layerCount:4,pageCount:5,errorCount:0};
  const handle=jobs.start('purchase-layer-dataset',{
    db:{},request:{mode:'full'},
    service:{async buildPurchaseLayerDataset(_db,request){
      assert.equal(request.mode,'full');
      request.jobControl.progress({phase:'Reading Purchase Invoices',current:1,total:2,message:'page'});
      return expected;
    }},
    onResult:value=>{received=value;}
  });
  const snapshot=await handle.completion;
  assert.equal(snapshot.status,JobStatus.Completed);
  assert.equal(received,expected);
  assert.equal(snapshot.metrics.counters.invoiceCount,2);
  assert.equal(snapshot.metrics.counters.itemCount,3);
  assert.equal(snapshot.metrics.counters.layerCount,4);
  assert.equal(snapshot.metrics.counters.pageCount,5);
}

async function lock(){
  const jobs=manager();
  const entered=deferred(),release=deferred();
  const service={async buildPurchaseLayerDataset(){entered.resolve();await release.promise;return {ok:true};}};
  const first=jobs.start('purchase-layer-dataset',{db:{},request:{},service});
  await entered.promise;
  assert.throws(()=>jobs.start('purchase-layer-dataset',{db:{},request:{},service}),error=>error.code==='JOB_LOCKED');
  release.resolve();
  assert.equal((await first.completion).status,JobStatus.Completed);
}

(async()=>{await execution();await lock();})().catch(error=>{process.stderr.write(`${error.stack||error}\n`);process.exitCode=1;});
