'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryDb}=require('./helpers/memory-mongo');
const shaygan=require('../src/lib/shaygan');
const saleSnapshot=require('../src/lib/sale-snapshot');

function invoice(no, body, extra={}) {
  return {InvTyp:2,InvNo:no,InvDate:'14050301',SAccountNumber:'117',SAccountName:'Seller',AccountNumber:'110',AccountName:'Cashbox',TotalAmount:body.reduce((sum,row)=>sum+Number(row.Amount||0),0),Body:body,...extra};
}
function line(code,qty,price,extra={}) { return {ItemCode:code,ItemDescription:code,Quan:qty,Price:price,Amount:qty*price,...extra}; }
function baseDb(extra={}) {
  return new MemoryDb({
    userShayganMappings:[{username:'seller',fullName:'Seller',employeeAccountNumber:'117',cashboxAccountNumber:'110',storeName:'Main'}],
    itemInventoryCatalog:[{itemCode:'A',raw:{ItemCode:'A',MainGroupCode:'10',MainGroupName:'CPU'}}],
    ...extra
  });
}

test('full scan excludes returns, records diagnostics, and reruns idempotently',async t=>{
  const original=shaygan.getInvoicePageByTypeNumberRange;
  t.after(()=>{shaygan.getInvoicePageByTypeNumberRange=original;});
  const db=baseDb();
  const sale=invoice(10,[line('A',1,100),line('B',2,100)],{TotalAmount:301});
  shaygan.getInvoicePageByTypeNumberRange=async rowStart=>({ok:true,result:rowStart===0?[sale,{...invoice(11,[line('A',1,1)]),InvTyp:6}]:[]});
  const first=await saleSnapshot.buildSaleSnapshot(db,{mode:'full',pageSize:2,maxPages:3,dateFrom:'14050101'});
  assert.equal(first.ok,true);
  assert.equal(first.invoiceHeadersFound,1);
  assert.equal(first.saleLinesParsed,2);
  assert.equal(first.insertedHeaders,1);
  assert.equal(first.insertedLines,2);
  assert.equal(first.groupFallbackLines,1);
  assert.equal(first.amountMismatchInvoices,1);
  assert.equal(first.unmappedSellerInvoices,0);
  assert.equal(first.startInvNo,0);
  assert.equal(first.endInvNo,10);
  assert.equal(first.nextInvNo,11);
  for(const field of ['invoiceHeadersFound','invoiceBodiesLoaded','saleLinesParsed','pagesScanned','insertedHeaders','updatedHeaders','insertedLines','updatedLines','removedOrReconciledLines','duplicatePrevented','emptyBodyInvoices','unmappedSellerInvoices','groupFallbackLines','amountMismatchInvoices','errors','startInvNo','endInvNo','nextInvNo','mode','scopeKey','durationMs']) assert.ok(Object.hasOwn(first,field),field);
  assert.equal(db.collection('saleSnapshotDatasetHeaders').rows.filter(x=>x.snapshotId===first.snapshotId).length,1);
  assert.equal(db.collection('saleSnapshotDatasetLines').rows.filter(x=>x.snapshotId===first.snapshotId).length,2);
  assert.equal(db.collection('saleSnapshotState').rows[0].latestType2,10);
  assert.equal(db.collection('saleSnapshotState').rows[0].activeSnapshotId,first.snapshotId);

  const rerun=await saleSnapshot.buildSaleSnapshot(db,{mode:'full',pageSize:2,maxPages:3,dateFrom:'14050101'});
  assert.equal(rerun.insertedHeaders,1);
  assert.equal(rerun.updatedHeaders,0);
  assert.equal(rerun.insertedLines,2);
  assert.equal(rerun.updatedLines,0);
  assert.equal(db.collection('saleSnapshotDatasetLines').rows.filter(x=>x.snapshotId===rerun.snapshotId).length,2);
  assert.equal(db.collection('saleSnapshotState').rows[0].activeSnapshotId,rerun.snapshotId);
});

test('seller mapping fallback is explicit and never inferred from account name alone',()=>{
  const header=saleSnapshot._saleHeaderDoc(invoice(12,[line('X',1,10)],{SAccountNumber:'999',SAccountName:'Unknown rep',AccountName:'Similar Name'}),'S',{byEmployee:new Map(),byCashbox:new Map()});
  assert.equal(header.sellerMappingStatus,'unmapped');
  assert.equal(header.sellerMappingSource,'shaygan-raw-fallback');
  assert.equal(header.sellerUsername,'');
});

test('incremental resumes committed state, appends, and reconciles changed bodies',async t=>{
  const original=shaygan.getInvoicePageByTypeNumberRange;
  t.after(()=>{shaygan.getInvoicePageByTypeNumberRange=original;});
  const scopeKey='sale-type2|14050101|';
  const db=baseDb({saleSnapshotState:[{scopeKey,latestType2:10}]});
  let expectedFrom='';
  shaygan.getInvoicePageByTypeNumberRange=async (rowStart,_typ,from)=>{
    expectedFrom=from;
    return {ok:true,result:rowStart===0?[invoice(11,[line('A',1,110),line('B',1,90)])]:[]};
  };
  const append=await saleSnapshot.buildSaleSnapshot(db,{mode:'incremental',pageSize:2,maxPages:3,dateFrom:'14050101'});
  assert.equal(expectedFrom,'11');
  assert.equal(append.insertedHeaders,1);
  assert.equal(db.collection('saleSnapshotState').rows[0].latestType2,11);

  shaygan.getInvoicePageByTypeNumberRange=async rowStart=>({ok:true,result:rowStart===0?[invoice(11,[line('A',1,120)])]:[]});
  const refresh=await saleSnapshot.buildSaleSnapshot(db,{mode:'full',pageSize:2,maxPages:3,dateFrom:'14050101'});
  assert.equal(refresh.removedOrReconciledLines,0);
  assert.equal(db.collection('saleSnapshotDatasetLines').rows.filter(x=>x.snapshotId===refresh.snapshotId&&x.saleInvoiceNo===11).length,1);
  assert.equal(db.collection('saleSnapshotState').rows[0].activeSnapshotId,refresh.snapshotId);
});

test('failure and cancellation never advance committed state',async t=>{
  const original=shaygan.getInvoicePageByTypeNumberRange;
  t.after(()=>{shaygan.getInvoicePageByTypeNumberRange=original;});
  const scopeKey='sale-type2|14050101|';
  const db=baseDb({saleSnapshotState:[{scopeKey,latestType2:20}]});
  shaygan.getInvoicePageByTypeNumberRange=async()=>({ok:false,error:'transport',result:[]});
  const failed=await saleSnapshot.buildSaleSnapshot(db,{mode:'incremental',pageSize:2,maxPages:2,dateFrom:'14050101'});
  assert.equal(failed.ok,false);
  assert.equal(db.collection('saleSnapshotState').rows[0].latestType2,20);

  shaygan.getInvoicePageByTypeNumberRange=async()=>({ok:true,result:[invoice(21,[line('A',1,100)])]});
  let checks=0;
  const cancelled=Object.assign(new Error('cancelled'),{code:'JOB_CANCELLED'});
  await assert.rejects(()=>saleSnapshot.buildSaleSnapshot(db,{mode:'incremental',pageSize:2,maxPages:2,dateFrom:'14050101',jobControl:{progress(){},heartbeat(){},checkCancellation(){if(++checks>3)throw cancelled;}}}),error=>error.code==='JOB_CANCELLED');
  assert.equal(db.collection('saleSnapshotState').rows[0].latestType2,20);
});

test('FIFO consumes prior sales, rejects future layers, deduplicates layers, and reports coverage',async()=>{
  const db=baseDb({
    saleInvoiceLines:[
      {saleInvoiceType:2,saleInvoiceNo:1,row:1,saleDate:'14050101',sellerAccountNumber:'OTHER',itemCode:'A',qty:1,saleValue:200},
      {saleInvoiceType:2,saleInvoiceNo:2,row:1,saleDate:'14050401',sellerAccountNumber:'117',sellerName:'Seller',sellerStoreName:'Main',itemCode:'A',qty:2,saleValue:500,mainGroupCode:'10',mainGroup:'CPU'},
      {saleInvoiceType:2,saleInvoiceNo:2,row:2,saleDate:'14050401',sellerAccountNumber:'117',sellerName:'Seller',sellerStoreName:'Main',itemCode:'B',qty:1,saleValue:300,mainGroupCode:'20',mainGroup:'Other'},
      {saleInvoiceType:6,saleInvoiceNo:3,row:1,saleDate:'14050402',sellerAccountNumber:'117',itemCode:'A',qty:1,saleValue:250}
    ],
    supplierPurchaseLayers:[
      {persistentLayerId:'L1',itemCode:'A',purchaseDate:'14041201',purchaseInvoiceNo:1,row:1,purchaseQty:2,unitCost:100,syncedAt:new Date('2026-01-01')},
      {persistentLayerId:'L1',itemCode:'A',purchaseDate:'14041201',purchaseInvoiceNo:1,row:1,purchaseQty:2,unitCost:100,syncedAt:new Date('2025-01-01')},
      {persistentLayerId:'FUTURE',itemCode:'A',purchaseDate:'14050501',purchaseInvoiceNo:2,row:1,purchaseQty:10,unitCost:50,syncedAt:new Date('2026-01-01')}
    ]
  });
  const fifo=await saleSnapshot._computeSellerProfitFifo(db,{sellerAccountNumber:'117',dateFrom:'14050401',dateTo:'14050430'});
  const a=fifo.resultByLine.get('2-2-1');
  const b=fifo.resultByLine.get('2-2-2');
  assert.equal(a.profitStatus,'partial');
  assert.equal(a.allocatedQty,1);
  assert.equal(a.allocations.length,1);
  assert.equal(a.allocations[0].layerId,'L1');
  assert.equal(b.profitStatus,'unknown');
  assert.equal(fifo.diagnostics.purchaseLayerPool,2);
  assert.ok(fifo.diagnostics.skippedFutureLayers>0);
  assert.equal(fifo.totals.coverage.totalLines,2);
  assert.equal(fifo.totals.coverage.partialLines,1);
  assert.equal(fifo.totals.coverage.unknownLines,1);
  assert.equal(fifo.totals.coverage.coveredQtyPercent,33.33);
  assert.equal(fifo.totals.profitStatus,'partial');
  assert.equal(fifo.totals.coverage.purchaseHistoryComplete,false);
});

test('a fully allocated line is calculated while report certainty remains coverage-only',async()=>{
  const db=baseDb({
    saleInvoiceLines:[{saleInvoiceType:2,saleInvoiceNo:4,row:1,saleDate:'1405/04/01',sellerAccountNumber:'117',sellerName:'Seller',sellerStoreName:'Main',itemCode:'A',qty:2,saleValue:500,mainGroupCode:'10',mainGroup:'CPU'}],
    supplierPurchaseLayers:[{persistentLayerId:'FULL',itemCode:'A',purchaseDate:'14040101',purchaseInvoiceNo:1,row:1,purchaseQty:2,unitCost:100,syncedAt:new Date()}]
  });
  const fifo=await saleSnapshot._computeSellerProfitFifo(db,{sellerAccountNumber:'117',dateFrom:'14050401',dateTo:'14050430'});
  assert.equal(fifo.resultByLine.get('2-4-1').profitStatus,'calculated');
  assert.equal(fifo.totals.coverage.coveredQtyPercent,100);
  assert.equal(fifo.totals.coverage.coveredSalesPercent,100);
  assert.equal(fifo.totals.profitStatus,'partial');
  const report=await saleSnapshot.sellerPerformance(db,{sellerAccountNumber:'117',dateFrom:'14050401',dateTo:'14050430'});
  assert.equal(report.lineCount,1);
  assert.equal(report.totalSales,500);
});

test('unknown profit stays null and seller/group totals remain consistent',async()=>{
  const db=baseDb({saleInvoiceLines:[{saleInvoiceType:2,saleInvoiceNo:9,row:1,saleDate:'14050401',sellerAccountNumber:'117',sellerName:'Seller',sellerStoreName:'Main',itemCode:'Z',itemName:'Unknown',qty:2,saleValue:400,mainGroupCode:'9',mainGroup:'Unknown'}]});
  const report=await saleSnapshot.sellerPerformance(db,{sellerAccountNumber:'117',dateFrom:'14050401',dateTo:'14050430'});
  assert.equal(report.fifoProfit,null);
  assert.equal(report.profitStatus,'unknown');
  assert.equal(report.invoices[0].fifoProfit,null);
  assert.equal(report.groups[0].fifoProfit,null);
  assert.equal(report.sellers[0].fifoProfit,null);
  assert.equal(report.totalSales,report.groups.reduce((sum,g)=>sum+g.amount,0));
  assert.equal(report.totalSales,report.invoices.reduce((sum,inv)=>sum+inv.amount,0));
});

test('seller report authorization and UI accounting warnings remain explicit',()=>{
  const server=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
  const app=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  assert.ok(server.includes("['admin','accounting','purchase'].includes(role)"));
  assert.match(server,/buildSellerSalesProfitReportFromSnapshot\(db,\s*reportQuery\)/);
  assert.match(app,/متوقف تا تکمیل پوشش/);
  assert.match(app,/نامشخص/);
  assert.match(app,/supplierPurchaseLayers|Supplier Sleep/);
});
