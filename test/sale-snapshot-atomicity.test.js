'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryDb}=require('./helpers/memory-mongo');
const shaygan=require('../src/lib/shaygan');
const saleSnapshot=require('../src/lib/sale-snapshot');

function line(code,qty=1,price=100){
  return {ItemCode:code,ItemDescription:code,Quan:qty,Price:price,Amount:qty*price};
}
function invoice(no, code, extra={}){
  return {
    InvTyp:2,
    InvNo:no,
    InvDate:'14050501',
    SAccountNumber:'11700001',
    SAccountName:'Test Seller',
    AccountNumber:'110',
    AccountName:'Cashbox',
    TotalAmount:100,
    Body:[line(code)],
    ...extra
  };
}
function db(){
  return new MemoryDb({
    userShayganMappings:[{
      username:'test-seller',
      fullName:'Test Seller',
      employeeAccountNumber:'11700001',
      cashboxAccountNumber:'110',
      storeName:'Main'
    }],
    itemInventoryCatalog:[
      {itemCode:'A',raw:{ItemCode:'A',MainGroupCode:'10',MainGroupName:'CPU'}},
      {itemCode:'B',raw:{ItemCode:'B',MainGroupCode:'10',MainGroupName:'CPU'}},
      {itemCode:'C',raw:{ItemCode:'C',MainGroupCode:'10',MainGroupName:'CPU'}}
    ]
  });
}
async function buildFull(database, rows, options={}){
  const original=shaygan.getInvoicePageByTypeNumberRange;
  shaygan.getInvoicePageByTypeNumberRange=async rowStart=>({ok:true,result:rowStart===0?rows:[]});
  try{
    return await saleSnapshot.buildSaleSnapshot(database,{mode:'full',dateFrom:'14050101',pageSize:20,maxPages:5,...options});
  }finally{
    shaygan.getInvoicePageByTypeNumberRange=original;
  }
}

test('completed A stays active while failed full B retries and remains isolated',async()=>{
  const database=db();
  const a=await buildFull(database,[invoice(1,'A')]);
  assert.equal(a.status,'completed'); // 1
  assert.equal((await saleSnapshot._activeDataset(database)).snapshotId,a.snapshotId); // 1

  const original=shaygan.getInvoicePageByTypeNumberRange;
  let page20Attempts=0;
  shaygan.getInvoicePageByTypeNumberRange=async rowStart=>{
    if(rowStart===0)return {ok:true,result:[invoice(2,'B')]};
    page20Attempts++;
    return {ok:false,error:'Shaygan request timeout',result:[]};
  };
  try{
    const b=await saleSnapshot.buildSaleSnapshot(database,{mode:'full',dateFrom:'14050101',pageSize:20,maxPages:5,maxPageAttempts:3});
    assert.equal(page20Attempts,3); // 3, 4
    assert.equal(b.retryCount,2);
    assert.equal(b.status,'completed_with_errors'); // 5
    assert.equal(b.activationStatus,'rejected');
    assert.equal(b.failedPages.length,1);
    assert.equal(b.nextRowStart,20);
    assert.equal((await saleSnapshot._activeDataset(database)).snapshotId,a.snapshotId); // 6
    assert.equal(database.collection('saleSnapshotDatasetHeaders').rows.filter(x=>x.snapshotId===a.snapshotId).length,1); // 16
    const report=await saleSnapshot.sellerPerformance(database,{sellerAccountNumber:'11700001',dateFrom:'14050501',dateTo:'14050506'});
    assert.equal(report.activeSnapshotId,a.snapshotId);
    assert.equal(report.invoiceCount,1); // 7, 14
    assert.equal(report.invoices[0].saleInvoiceNo,1);
  }finally{
    shaygan.getInvoicePageByTypeNumberRange=original;
  }
});

test('failed B resumes same candidate idempotently and activates only after validation',async()=>{
  const database=db();
  const a=await buildFull(database,[invoice(1,'A')]);
  const original=shaygan.getInvoicePageByTypeNumberRange;
  shaygan.getInvoicePageByTypeNumberRange=async rowStart=>rowStart===0
    ? {ok:true,result:[invoice(2,'B'),invoice(2,'B')]}
    : {ok:false,error:'transport timeout',result:[]};
  const b=await saleSnapshot.buildSaleSnapshot(database,{mode:'full',dateFrom:'14050101',pageSize:20,maxPages:5,maxPageAttempts:1});
  assert.equal(b.ok,false);
  assert.equal(database.collection('saleSnapshotDatasetHeaders').rows.filter(x=>x.snapshotId===b.snapshotId).length,1);
  assert.equal(database.collection('saleSnapshotDatasetLines').rows.filter(x=>x.snapshotId===b.snapshotId).length,1); // 17

  shaygan.getInvoicePageByTypeNumberRange=async rowStart=>rowStart===20
    ? {ok:true,result:[invoice(3,'C')]}
    : {ok:true,result:[]};
  try{
    const resumed=await saleSnapshot.buildSaleSnapshot(database,{resumeSnapshotId:b.snapshotId,maxPages:5,maxPageAttempts:1});
    assert.equal(resumed.snapshotId,b.snapshotId); // 8
    assert.equal(resumed.resumed,true);
    assert.equal(resumed.validation.valid,true); // 9
    assert.equal(resumed.validation.duplicatesAbsent,true);
    assert.equal(resumed.datasetHeaderCount,2);
    assert.equal(resumed.datasetLineCount,2);
    assert.equal((await saleSnapshot._activeDataset(database)).snapshotId,b.snapshotId); // 10
    const report=await saleSnapshot.sellerPerformance(database,{sellerAccountNumber:'11700001',dateFrom:'14050501',dateTo:'14050506'});
    assert.equal(report.activeSnapshotId,b.snapshotId); // 11
    assert.deepEqual(report.invoices.map(x=>x.saleInvoiceNo).sort((x,y)=>x-y),[2,3]);
    assert.notEqual(a.snapshotId,b.snapshotId);
  }finally{
    shaygan.getInvoicePageByTypeNumberRange=original;
  }
});

test('incremental creates a validated successor and leaves the prior dataset auditable',async()=>{
  const database=db();
  const a=await buildFull(database,[invoice(1,'A')]);
  const original=shaygan.getInvoicePageByTypeNumberRange;
  shaygan.getInvoicePageByTypeNumberRange=async rowStart=>({ok:true,result:rowStart===0?[invoice(2,'B')]:[]});
  try{
    const c=await saleSnapshot.buildSaleSnapshot(database,{mode:'incremental',dateFrom:'14050101',pageSize:20,maxPages:5});
    assert.equal(c.ok,true);
    assert.equal(c.datasetBaseCounts.headerCount,1);
    assert.equal(c.datasetHeaderCount,2);
    assert.equal(c.previousActiveSnapshotId,a.snapshotId);
    assert.equal(database.collection('saleSnapshotDatasetHeaders').rows.filter(x=>x.snapshotId===a.snapshotId).length,1);
    assert.equal(database.collection('saleSnapshotDatasetHeaders').rows.filter(x=>x.snapshotId===c.snapshotId).length,2);
  }finally{
    shaygan.getInvoicePageByTypeNumberRange=original;
  }
});

test('incremental base validation compares only sale type 2 while retaining other legacy rows',async()=>{
  const database=db();
  database.collection('saleInvoiceHeaders').rows.push(
    {invTyp:2,invNo:1,invDate:'14050501'},
    {invTyp:6,invNo:2,invDate:'14050501'}
  );
  database.collection('saleInvoiceLines').rows.push(
    {saleInvoiceType:2,saleInvoiceNo:1,row:1,saleDate:'14050501',sellerAccountNumber:'11700001',itemCode:'A',qty:1,saleValue:100},
    {saleInvoiceType:6,saleInvoiceNo:2,row:1,saleDate:'14050501',sellerAccountNumber:'11700001',itemCode:'A',qty:1,saleValue:100}
  );
  database.collection('saleSnapshotState').rows.push({scopeKey:'sale-type2|14050101|',latestType2:1});
  const original=shaygan.getInvoicePageByTypeNumberRange;
  shaygan.getInvoicePageByTypeNumberRange=async()=>({ok:true,result:[]});
  try{
    const result=await saleSnapshot.buildSaleSnapshot(database,{mode:'incremental',dateFrom:'14050101',pageSize:20,maxPages:2});
    assert.equal(result.ok,true);
    assert.deepEqual(result.datasetBaseCounts,{validationScope:'sale-type2',headerCount:1,lineCount:1,allHeaderCount:2,allLineCount:2});
    assert.equal(result.validation.preservesIncrementalBase,true);
    assert.equal(database.collection('saleSnapshotDatasetHeaders').rows.filter(x=>x.snapshotId===result.snapshotId).length,2);
  }finally{
    shaygan.getInvoicePageByTypeNumberRange=original;
  }
});

test('completed_with_errors metadata is never selected over a valid completed active snapshot',async()=>{
  const database=db();
  const a=await buildFull(database,[invoice(1,'A')]);
  database.collection('saleSnapshots').rows.push({snapshotId:'BROKEN',status:'completed_with_errors',activationStatus:'active'});
  database.collection('saleSnapshotState').rows.push({scopeKey:'corrupt',activeSnapshotId:'BROKEN',activatedAt:new Date('2099-01-01')});
  const active=await saleSnapshot._activeDataset(database);
  assert.equal(active.snapshotId,a.snapshotId); // 15
});

test('legacy Gregorian and canonical Jalali records remain readable before versioned activation',async()=>{
  const database=db();
  database.collection('saleInvoiceLines').rows.push(
    {saleInvoiceType:2,saleInvoiceNo:10,row:1,saleDate:'2026-07-23',sellerAccountNumber:'11700001',sellerName:'Test Seller',itemCode:'A',qty:1,saleValue:100},
    {saleInvoiceType:2,saleInvoiceNo:11,row:1,saleDate:'14050502',sellerAccountNumber:'11700001',sellerName:'Test Seller',itemCode:'B',qty:1,saleValue:100}
  );
  const report=await saleSnapshot.sellerPerformance(database,{sellerAccountNumber:'11700001',dateFrom:'14050501',dateTo:'14050506'});
  assert.equal(report.snapshotStatus,'legacy_unversioned');
  assert.equal(report.invoiceCount,2); // 12, 13
});

test('empty report is successful and distinct from the server internal-error path',async()=>{
  const database=db();
  const report=await saleSnapshot.sellerPerformance(database,{sellerAccountNumber:'11700001',dateFrom:'14050501',dateTo:'14050506'});
  assert.equal(report.ok,true);
  assert.equal(report.invoiceCount,0); // 19
  const server=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
  assert.match(server,/sendJson\(res,\s*500,\s*\{\s*ok:false/);
  const app=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  assert.match(app,/درخواست با موفقیت انجام شد، اما/);
  assert.match(app,/گزارش عملکرد فروشنده دریافت نشد/);
});

test('UI formats report timestamps explicitly and prevents concurrent duplicate full jobs',()=>{
  const app=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  const server=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
  assert.match(app,/function formatSellerReportTimestamp/);
  assert.match(app,/Intl\.DateTimeFormat\('fa-IR'.*timeZone:'Asia\/Tehran'/); // 18
  assert.match(server,/saleSnapshotJobManager\.isRunning\('sale-snapshot'\)/);
  assert.match(server,/code:'JOB_LOCKED'/); // 20
});

test('snapshot errors redact connection strings and credentials before audit or UI exposure',()=>{
  const text=saleSnapshot._safeError('mongodb://user:pass@host/db token=abc123 password:secret');
  assert.doesNotMatch(text,/user:pass|abc123|secret/);
  assert.match(text,/\[REDACTED\]/);
});
