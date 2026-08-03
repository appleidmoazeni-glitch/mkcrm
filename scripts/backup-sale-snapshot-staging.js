'use strict';

const fs=require('node:fs');
const path=require('node:path');
const {EJSON}=require('bson');
const {connectMongo,closeMongo}=require(path.join(process.cwd(),'src/lib/mongo'));

const EXPECTED_DATABASE='mkcrm_staging';
const COLLECTIONS=[
  'saleSnapshots',
  'saleSnapshotState',
  'saleSnapshotDiagnostics',
  'saleInvoiceHeaders',
  'saleInvoiceLines',
  'saleSnapshotDatasetHeaders',
  'saleSnapshotDatasetLines',
  'sellerPerformanceHistory',
  'appJobs',
  'supplierPurchaseLayers'
];

function stamp(){
  return new Date().toISOString().replace(/[:.]/g,'-');
}

async function main(){
  const db=await connectMongo();
  if(db.databaseName!==EXPECTED_DATABASE)throw new Error(`Refusing backup for unexpected database: ${db.databaseName}`);
  const backupRoot=process.argv[2]||'C:\\backups\\mkcrm-staging\\phase5-2-3a';
  const folder=path.join(backupRoot,stamp());
  fs.mkdirSync(folder,{recursive:true});
  const manifest={
    database:db.databaseName,
    createdAt:new Date(),
    format:'MongoDB Extended JSON canonical',
    collections:{}
  };
  const existing=new Set((await db.listCollections().toArray()).map(item=>item.name));
  for(const name of COLLECTIONS){
    const docs=existing.has(name)?await db.collection(name).find({}).toArray():[];
    fs.writeFileSync(path.join(folder,`${name}.ejson`),EJSON.stringify(docs,{relaxed:false}));
    manifest.collections[name]={count:docs.length,file:`${name}.ejson`,existed:existing.has(name)};
  }
  fs.writeFileSync(path.join(folder,'manifest.ejson'),EJSON.stringify(manifest,{relaxed:false}));
  process.stdout.write(`${EJSON.stringify({ok:true,folder,manifest},{relaxed:true})}\n`);
  await closeMongo();
  process.exitCode=0;
}

main().catch(error=>{
  process.stderr.write(`${EJSON.stringify({ok:false,error:String(error?.message||error)},{relaxed:true})}\n`);
  closeMongo().catch(()=>{});
  process.exitCode=1;
});
