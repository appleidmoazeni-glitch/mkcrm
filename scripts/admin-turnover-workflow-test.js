'use strict';
const assert=require('node:assert/strict');
const path=require('path');
const {config}=require('../src/lib/config');
const backup=require('../src/lib/mongo-backup');
const {JobManager}=require('../dist/core/jobs/JobManager.js');
const {JobRegistry}=require('../dist/core/jobs/JobRegistry.js');
const {MongoBackupJob}=require('../dist/jobs/MongoBackupJob.js');

async function main(){
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
  const app=require('fs').readFileSync(require.resolve('../public/assets/app.js'),'utf8');assert.match(app,/2:'فاکتور فروش'/);assert.match(app,/6:'برگشت از فروش'/);assert.match(app,/INVOICE_TYPE_REQUIRED|نوع و شماره معتبر سند/);assert.match(app,/searchAbort\?\.abort/);assert.match(app,/turnoverAbort\?\.abort/);
}
main().catch(e=>{process.stderr.write(`${e.stack||e}\n`);process.exitCode=1;});
