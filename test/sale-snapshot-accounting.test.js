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

test('full scan stores sales and sale returns separately, records diagnostics, and reruns idempotently',async t=>{
  const original=shaygan.getInvoicePageByTypeNumberRange;
  t.after(()=>{shaygan.getInvoicePageByTypeNumberRange=original;});
  const db=baseDb();
  const sale=invoice(10,[line('A',1,100),line('B',2,100)],{TotalAmount:301});
  shaygan.getInvoicePageByTypeNumberRange=async (rowStart,typ)=>({ok:true,result:rowStart===0?(typ===2?[sale]:[{...invoice(11,[line('A',1,1)]),InvTyp:6}]):[]});
  const first=await saleSnapshot.buildSaleSnapshot(db,{mode:'full',pageSize:2,maxPages:3,dateFrom:'14050101'});
  assert.equal(first.ok,true);
  assert.equal(first.invoiceHeadersFound,2);
  assert.equal(first.saleLinesParsed,3);
  assert.equal(first.insertedHeaders,2);
  assert.equal(first.insertedLines,3);
  assert.equal(first.groupFallbackLines,1);
  assert.equal(first.amountMismatchInvoices,1);
  assert.equal(first.unmappedSellerInvoices,0);
  assert.equal(first.startInvNo,0);
  assert.equal(first.endInvNo,10);
  assert.equal(first.nextInvNo,11);
  for(const field of ['invoiceHeadersFound','invoiceBodiesLoaded','saleLinesParsed','pagesScanned','insertedHeaders','updatedHeaders','insertedLines','updatedLines','removedOrReconciledLines','duplicatePrevented','emptyBodyInvoices','unmappedSellerInvoices','groupFallbackLines','amountMismatchInvoices','errors','startInvNo','endInvNo','nextInvNo','mode','scopeKey','durationMs']) assert.ok(Object.hasOwn(first,field),field);
  assert.equal(db.collection('saleSnapshotDatasetHeaders').rows.filter(x=>x.snapshotId===first.snapshotId).length,2);
  assert.equal(db.collection('saleSnapshotDatasetLines').rows.filter(x=>x.snapshotId===first.snapshotId).length,3);
  assert.equal(db.collection('saleSnapshotDatasetLines').rows.filter(x=>x.snapshotId===first.snapshotId&&x.saleInvoiceType===6).length,1);
  assert.equal(db.collection('saleSnapshotState').rows[0].latestType2,10);
  assert.equal(db.collection('saleSnapshotState').rows[0].activeSnapshotId,first.snapshotId);

  const rerun=await saleSnapshot.buildSaleSnapshot(db,{mode:'full',pageSize:2,maxPages:3,dateFrom:'14050101'});
  assert.equal(rerun.insertedHeaders,2);
  assert.equal(rerun.updatedHeaders,0);
  assert.equal(rerun.insertedLines,3);
  assert.equal(rerun.updatedLines,0);
  assert.equal(db.collection('saleSnapshotDatasetLines').rows.filter(x=>x.snapshotId===rerun.snapshotId).length,3);
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
  const expectedFrom={};
  shaygan.getInvoicePageByTypeNumberRange=async (rowStart,typ,from)=>{
    expectedFrom[String(typ)]=from;
    return {ok:true,result:rowStart===0&&typ===2?[invoice(11,[line('A',1,110),line('B',1,90)])]:[]};
  };
  const append=await saleSnapshot.buildSaleSnapshot(db,{mode:'incremental',pageSize:2,maxPages:3,dateFrom:'14050101'});
  assert.equal(expectedFrom['2'],'11');
  assert.equal(expectedFrom['6'],'');
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
  assert.equal(report.profitStatus,'unavailable');
  assert.equal(report.invoices[0].fifoProfit,null);
  assert.equal(report.groups[0].fifoProfit,null);
  assert.equal(report.sellers[0].fifoProfit,null);
  assert.equal(report.totalSales,report.groups.reduce((sum,g)=>sum+g.amount,0));
  assert.equal(report.totalSales,report.invoices.reduce((sum,inv)=>sum+inv.amount,0));
});

test('seller identity is account-based, returns are separate, and accounting metrics reconcile to rows',async()=>{
  const db=baseDb({
    userShayganMappings:[
      {username:'seller-a',fullName:'علی رضايي',employeeAccountName:'علی رضایی',employeeAccountNumber:' ۱۱۷ ',cashboxAccountNumber:'110',storeName:'Main'},
      {username:'seller-a-copy',fullName:' علی  رضایی ',employeeAccountName:'علي رضايي',employeeAccountNumber:'117',cashboxAccountNumber:'110',storeName:'Main'}
    ],
    saleInvoiceHeaders:[
      {invTyp:2,invNo:10,invDate:'14050502',discountAmount:20,accountNumber:'C1'},
      {invTyp:6,invNo:20,invDate:'14050503',discountAmount:0,accountNumber:'C1'}
    ],
    saleInvoiceLines:[
      {saleInvoiceType:2,saleInvoiceNo:10,row:1,saleDate:'14050502',sellerAccountNumber:' ۱۱۷ ',sellerName:'علی رضایی',sellerStoreName:'Main',accountNumber:'C1',itemCode:'A',qty:2,saleValue:200,mainGroupCode:'10',mainGroup:'CPU'},
      {saleInvoiceType:2,saleInvoiceNo:10,row:2,saleDate:'14050502',sellerAccountNumber:'117',sellerName:'علی رضایی',sellerStoreName:'Main',accountNumber:'C1',itemCode:'B',qty:1,saleValue:100,mainGroupCode:'20',mainGroup:'Other'},
      {saleInvoiceType:6,saleInvoiceNo:20,row:1,saleDate:'14050503',sellerAccountNumber:'117',sellerName:'علی رضایی',sellerStoreName:'Main',accountNumber:'C1',itemCode:'A',qty:1,saleValue:80}
    ],
    supplierPurchaseLayers:[{persistentLayerId:'SHOULD-NOT-ACTIVATE-PROFIT',itemCode:'A',purchaseDate:'14040101',purchaseQty:99,unitCost:1}]
  });
  const report=await saleSnapshot.sellerPerformance(db,{sellerAccountNumber:'۱۱۷',dateFrom:'14050501',dateTo:'14050506'});
  assert.equal(report.sellerAccountNumber,'117');
  assert.equal(report.invoiceCount,1);
  assert.equal(report.lineCount,2);
  assert.equal(report.saleReturnInvoiceCount,1);
  assert.equal(report.saleReturnLineCount,1);
  assert.equal(report.netSaleAmount,300);
  assert.equal(report.grossSaleAmount,320);
  assert.equal(report.discountAmount,20);
  assert.equal(report.discountPercent,6.25);
  assert.equal(report.saleReturnAmount,80);
  assert.equal(report.netSalesAfterReturns,220);
  assert.equal(report.uniqueCustomerCount,1);
  assert.equal(report.averageInvoiceAmount,300);
  assert.equal(report.sellers.length,1);
  assert.equal(report.fifoProfit,null);
  assert.equal(report.roiPercent,null);
  assert.equal(report.profitStatus,'unavailable');
  assert.equal(report.commissionStatus,'disabled');
  assert.equal(report.returnsPolicy.linkageGuessed,false);
  assert.equal(report.lines.reduce((sum,row)=>sum+row.saleValue,0),report.netSaleAmount);
  assert.equal(report.returnLines.reduce((sum,row)=>sum+row.saleValue,0),report.saleReturnAmount);
});

test('seller performance no-data and previous equivalent period states are explicit',async()=>{
  const db=baseDb({
    saleInvoiceLines:[
      {saleInvoiceType:2,saleInvoiceNo:1,row:1,saleDate:'14050431',sellerAccountNumber:'117',itemCode:'A',qty:1,saleValue:100},
      {saleInvoiceType:2,saleInvoiceNo:2,row:1,saleDate:'14050501',sellerAccountNumber:'117',itemCode:'A',qty:1,saleValue:150}
    ]
  });
  const report=await saleSnapshot.sellerPerformance(db,{sellerAccountNumber:'117',dateFrom:'14050501',dateTo:'14050501'});
  assert.equal(report.dataState,'ready');
  assert.deepEqual(report.previousPeriod.dateFrom,'14050431');
  assert.deepEqual(report.previousPeriod.dateTo,'14050431');
  assert.equal(report.previousPeriod.netSalesAfterReturns,100);
  assert.equal(report.previousPeriod.differenceAmount,50);
  const empty=await saleSnapshot.sellerPerformance(db,{sellerAccountNumber:'999',dateFrom:'14050501',dateTo:'14050501'});
  assert.equal(empty.dataState,'no-data');
  assert.equal(empty.invoiceCount,0);
  assert.equal(empty.fifoProfit,null);
});

test('seller report authorization and UI accounting warnings remain explicit',()=>{
  const server=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
  const access=fs.readFileSync(path.join(__dirname,'../src/lib/seller-performance-access.js'),'utf8');
  const app=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  assert.match(server,/authorizedSellerScope/);
  assert.match(access,/SELLER_SCOPE_FORBIDDEN/);
  assert.match(server,/buildSellerSalesProfitReportFromSnapshot\(db,\s*reportQuery\)/);
  assert.match(app,/سود، ROI و پورسانت در نسخه جاری عمداً غیرفعال است/);
  assert.match(app,/مرجوعی فروش/);
});
