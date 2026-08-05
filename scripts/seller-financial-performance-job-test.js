'use strict';

const assert=require('node:assert/strict');
const {JobManager}=require('../dist/core/jobs/JobManager.js');
const {JobRegistry}=require('../dist/core/jobs/JobRegistry.js');
const {JobStatus}=require('../dist/core/jobs/JobStatus.js');
const {SellerFinancialPerformanceJob}=require('../dist/jobs/SellerFinancialPerformanceJob.js');

async function execute(request){
  const calls=[];let stored=null;
  const service={
    async buildReadModel(){calls.push('build');return{ok:true,runId:'RUN-1',lineCount:2,summaryCount:1};},
    async deepVerify(){calls.push('deep-verify');return{ok:true,runId:'RUN-1',verificationId:'VERIFY-1'};}
  };
  const registry=new JobRegistry();
  registry.register({name:'seller-financial-performance',version:1,factory:input=>new SellerFinancialPerformanceJob(input)});
  const manager=new JobManager(registry);
  const handle=manager.start('seller-financial-performance',{db:{},request,requestedBy:{username:'accountant',role:'accounting'},service,onResult:value=>{stored=value;}});
  const result=await handle.completion;
  assert.equal(result.status,JobStatus.Completed);
  return{calls,stored};
}

(async()=>{
  const verification=await execute({operation:'deep-verify'});
  assert.deepEqual(verification.calls,['deep-verify']);
  assert.equal(verification.stored.verificationId,'VERIFY-1');
  const build=await execute({operation:'build'});
  assert.deepEqual(build.calls,['build']);
  assert.equal(build.stored.runId,'RUN-1');
  console.log('Seller Financial Performance background build/deep-verify routing: PASS');
})().catch(error=>{console.error(error);process.exitCode=1;});
