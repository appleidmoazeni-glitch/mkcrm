'use strict';
const assert=require('node:assert/strict');
const path=require('path');
const {config}=require('../src/lib/config');
const backup=require('../src/lib/mongo-backup');
const invoiceTypes=require('../public/assets/invoice-types');
const {createInvoiceResolver}=require('../src/lib/invoice-resolution');
const {JobManager}=require('../dist/core/jobs/JobManager.js');
const {JobRegistry}=require('../dist/core/jobs/JobRegistry.js');
const {MongoBackupJob}=require('../dist/jobs/MongoBackupJob.js');

async function main(){
  const expected={2:'sale',3:'purchase',4:'warehouse-transfer',5:'warehouse-transfer',6:'sale-return',7:'purchase-return',10:'warehouse-transfer'};
  for(const [type,family] of Object.entries(expected)){assert.equal(invoiceTypes.getInvoiceFamily(type),family);assert.equal(invoiceTypes.isSupportedInvoiceType(type),true);}
  assert.equal(invoiceTypes.normalizeInvTyp(undefined),null);assert.equal(invoiceTypes.getInvoiceFamily(99),'unknown');assert.equal(invoiceTypes.isSupportedInvoiceType(99),false);
  let calls=0;const resolver=createInvoiceResolver({supportedTypes:[2,6],getInvoice:async(no,type)=>{calls++;return {ok:true,list:type===6?[{InvNo:no,InvTyp:6,AccountName:'صندوق'}]:[]};}});
  const one=await resolver.resolve(137);assert.deepEqual(one.map(x=>x.invType),[6]);await resolver.resolve(137);assert.equal(calls,2);
  const none=await createInvoiceResolver({supportedTypes:[2],getInvoice:async()=>({ok:true,list:[]})}).resolve(999);assert.deepEqual(none,[]);
  const multiple=await createInvoiceResolver({supportedTypes:[2,7],getInvoice:async(no,type)=>({ok:true,list:[{InvNo:no,InvTyp:type}]})}).resolve(500);assert.deepEqual(multiple.map(x=>x.invType),[2,7]);
  await assert.rejects(()=>createInvoiceResolver({supportedTypes:[2,6],getInvoice:async(no,type)=>type===2?{ok:true,list:[]}:{ok:false,list:[]}}).resolve(1),/INVOICE_RESOLUTION_SERVICE_FAILED/);
  const original=config.mongoBackupAllowedRoots;config.mongoBackupAllowedRoots=[path.resolve('/tmp/mkcrm-backups')];
  assert.equal(backup.resolveDestination('0','daily').resolved,path.resolve('/tmp/mkcrm-backups/daily'));
  for(const unsafe of ['../escape','/absolute','..','\\\\server'])assert.throws(()=>backup.resolveDestination('0',unsafe));
  assert.throws(()=>backup.resolveDestination('99',''));
  config.mongoBackupAllowedRoots=original;
  const backupSource=require('fs').readFileSync(require.resolve('../src/lib/mongo-backup.js'),'utf8');
  assert.match(backupSource,/spawn\(config\.mongoDumpBinary,\['--uri',config\.mongoUri,'--db',db,'--out',output\],\{shell:false/);
  assert.doesNotMatch(backupSource,/\bexec(?:File)?\s*\(/);
  const registry=new JobRegistry();registry.register({name:'mongo-backup',version:1,factory:i=>new MongoBackupJob(i)});const manager=new JobManager(registry);
  let release;const gate=new Promise(r=>{release=r;});const service={async run(request){request.jobControl.progress({phase:'running',percent:50,message:'mock'});await gate;return {ok:true,sizeBytes:12};}};
  const first=manager.start('mongo-backup',{request:{},service});assert.throws(()=>manager.start('mongo-backup',{request:{},service}),e=>e.code==='JOB_LOCKED');release();const done=await first.completion;assert.equal(done.status,'Completed');assert.equal(done.metrics.counters.backupSizeBytes,12);assert.equal(manager.events.listenerCount(),0);
  const app=require('fs').readFileSync(require.resolve('../public/assets/app.js'),'utf8');assert.match(app,/MKCRMInvoiceTypes/);assert.match(app,/DocumentNumber/);assert.match(app,/api\/invoices\/\$\{encodeURIComponent\(invNo\)\}\/resolve/);assert.match(app,/candidates\.length>1/);assert.match(app,/data-resolving|dataset\.resolving/);assert.match(app,/searchAbort\?\.abort/);assert.match(app,/turnoverAbort\?\.abort/);assert.match(app,/invoice-item-kardex/);
  const server=require('fs').readFileSync(require.resolve('../src/server.js'),'utf8');assert.match(server,/invoiceResolver\.resolve/);assert.match(server,/\[2,6\]\.includes\(invType\)/);
}
main().catch(e=>{process.stderr.write(`${e.stack||e}\n`);process.exitCode=1;});
