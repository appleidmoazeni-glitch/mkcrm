'use strict';

const { EJSON } = require('bson');
const { connectMongo,closeMongo } = require('../src/lib/mongo');
const shaygan = require('../src/lib/shaygan');
const reconciliation = require('../src/lib/authoritative-item-master-reconciliation');

function arg(name){const index=process.argv.indexOf(name);return index>=0?String(process.argv[index+1]||''):'';}
async function readCompleteSource(){
  const rows=[];let pages=0;
  for(let rowStart=0;pages<20000;pages++,rowStart+=100){
    const response=await shaygan.getItemsPage(rowStart,100);
    if(!response?.ok)throw Object.assign(new Error(String(response?.error||'Item/Get failed')),{code:'AUTHORITATIVE_ITEM_MASTER_READ_FAILED',page:pages,rowStart});
    const list=response.list||[];
    if(!list.length)return{rows,pages:pages+1,terminalCondition:'empty-page'};
    rows.push(...list);
  }
  throw Object.assign(new Error('authoritative Item/Get did not reach empty page'),{code:'AUTHORITATIVE_ITEM_MASTER_MAX_PAGES'});
}
async function main(){
  const db=await connectMongo(),apply=process.argv.includes('--apply');
  if(apply&&db.databaseName!=='mkcrm_staging')throw Object.assign(new Error(`Refusing master rename reconciliation for ${db.databaseName}`),{code:'STAGING_DATABASE_REQUIRED'});
  const source=await readCompleteSource(),options={source:'shaygan-item-master-full',complete:true};
  const result=apply?await reconciliation.apply(db,source.rows,{...options,planFingerprint:arg('--plan-fingerprint'),backupEvidence:arg('--backup-evidence')}):await reconciliation.plan(db,source.rows,options);
  process.stdout.write(`${EJSON.stringify({ok:true,mode:apply?'apply':'plan',database:db.databaseName,sourcePages:source.pages,terminalCondition:source.terminalCondition,result},{relaxed:true})}\n`);
}
main().catch(error=>{process.stderr.write(`${EJSON.stringify({ok:false,code:error.code||'CATALOG_MASTER_RENAME_FAILED',error:String(error.message||error),currentFingerprint:error.currentFingerprint||'',sourceFingerprint:error.sourceFingerprint||'',page:error.page,rowStart:error.rowStart},{relaxed:true})}\n`);process.exitCode=1;}).finally(()=>closeMongo().catch(()=>{}));
