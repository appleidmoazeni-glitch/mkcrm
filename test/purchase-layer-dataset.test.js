'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {MemoryDb}=require('./helpers/memory-mongo');
const purchaseLayers=require('../src/lib/purchase-layer-dataset');

function line(id,code,qty,price,extra={}){
  const amount=price==null?undefined:qty*price;
  return {LineItemId:id,ItemNumber:code,ItemDescription:`Item ${code}`,Quan:qty,Price:price,Amount:amount,...extra};
}
function invoice(type,no,body,extra={}){
  return {
    InvTyp:type,InvNo:no,InvDate:'14050101',GuId:`GUID-${type}-${no}`,
    InvHeaderId:`HEADER-${type}-${no}`,AccountNumber:'SUP-1',AccountName:'Supplier 1',
    Body:body,...extra
  };
}
function apiFor(rowsByType,options={}){
  const calls=[];
  let failed=false;
  return {
    calls,
    async getInvoicePageByTypeNumberRange(rowStart,type,from,_to,dateFrom,dateTo,rowCount){
      calls.push({rowStart,type,from,dateFrom,dateTo,rowCount});
      if(options.failOnce&&!failed){failed=true;return {ok:false,error:'request timeout'};}
      const pages=rowsByType[String(type)]||{};
      return {
        ok:true,
        result:pages[rowStart]||[],
        totalRecords:options.totalRecordsByType?.[String(type)]
      };
    }
  };
}

test('maps purchases and purchase returns with deterministic identities and unknown costs',()=>{
  const purchase=invoice(3,10,[line(11,'A',5,100),line(12,'B',2,null)]);
  const mapped=purchaseLayers._mapSourceLine(purchase,purchase.Body[0],1,'D1');
  const unknown=purchaseLayers._mapSourceLine(purchase,purchase.Body[1],2,'D1');
  const missingIdentity=purchaseLayers._mapSourceLine(
    invoice(3,11,[line('', '', 1, 10)],{AccountNumber:'',AccountName:''}),
    line('', '', 1, 10),1,'D1'
  );
  const missingSupplier=purchaseLayers._mapSourceLine(
    invoice(3,12,[line(13,'C',1,10)],{AccountNumber:'',AccountName:''}),
    line(13,'C',1,10),1,'D1'
  );
  const returned=purchaseLayers._mapSourceLine(invoice(7,20,[line(21,'A',2,100)],{RelatedInvHeaderId:'HEADER-3-10'}),line(21,'A',2,100),1,'D1');
  assert.equal(mapped.sourceInvoiceType,3);
  assert.equal(mapped.purchaseLineIdentity,'GUID-3-10:11');
  assert.equal(mapped.originalQuantity,5);
  assert.equal(mapped.netPurchasedQuantity,5);
  assert.equal(unknown.netUnitCost,null);
  assert.equal(unknown.costStatus,'unknown');
  assert.equal(missingIdentity.validationStatus,'rejected');
  assert.ok(missingIdentity.validationWarnings.includes('item-identifier'));
  assert.ok(missingIdentity.validationWarnings.includes('supplier'));
  assert.equal(missingSupplier.validationStatus,'warning');
  assert.deepEqual(missingSupplier.validationWarnings,['supplier']);
  assert.equal(returned.sourceInvoiceType,7);
  assert.equal(returned.layerKind,'purchase-return');
  assert.equal(returned.netPurchasedQuantity,null);
});

test('layer upsert keeps immutable createdAt out of $set',()=>{
  const createdAt=new Date('2026-07-29T00:00:00.000Z');
  const update=purchaseLayers._layerUpsertUpdate({
    datasetId:'PLAYER-1',
    purchaseLineIdentity:'invoice:line',
    createdAt,
    updatedAt:createdAt
  });
  assert.equal(Object.prototype.hasOwnProperty.call(update.$set,'createdAt'),false);
  assert.equal(update.$setOnInsert.createdAt,createdAt);
  assert.equal(update.$set.datasetId,'PLAYER-1');
});

test('a failed page does not advance its durable resume checkpoint',async()=>{
  const db=new MemoryDb();
  const layers=db.collection('supplierPurchaseLayers');
  const updateOne=layers.updateOne.bind(layers);
  layers.updateOne=async(filter,update,options)=>{
    if(filter.purchaseLineIdentity==='GUID-3-10:11')throw new Error('simulated write failure');
    return updateOne(filter,update,options);
  };
  const api=apiFor({'3':{0:[invoice(3,10,[line(11,'A',5,100)])]}});
  const failed=await purchaseLayers.buildPurchaseLayerDataset(db,{
    shaygan:api,mode:'full',reset:true,dateFrom:'14050101',pageSize:20,maxPages:3,maxPageAttempts:1
  });
  assert.equal(failed.ok,false);
  assert.equal(failed.status,'failed');
  assert.equal(failed.checkpoint.nextRowStartByType['3'],0);
});

test('TotalRecords stops exactly before Shaygan rejects an extra page',async()=>{
  const db=new MemoryDb();
  const api=apiFor({
    '3':{0:[invoice(3,10,[line(11,'A',5,100)])],20:[invoice(3,11,[line(12,'B',1,200)])]},
    '7':{0:[]}
  },{totalRecordsByType:{'3':40,'7':0}});
  const result=await purchaseLayers.buildPurchaseLayerDataset(db,{
    shaygan:api,mode:'full',reset:true,dateFrom:'14050101',pageSize:20,maxPages:10,maxPageAttempts:1
  });
  assert.equal(result.ok,true);
  assert.deepEqual(api.calls.filter(call=>call.type===3).map(call=>call.rowStart),[0,20]);
  assert.equal(result.pagingByType['3'].expectedPages,2);
  assert.equal(result.pagingByType['3'].pagesRead,2);
  assert.equal(result.pagingByType['3'].mode,'total-records');
});

test('TotalRecords tolerates a short middle page and zero-record invoice type',async()=>{
  const db=new MemoryDb();
  const api=apiFor({
    '3':{
      0:[invoice(3,10,[line(11,'A',5,100)])],
      20:[invoice(3,11,[line(12,'B',1,200)])],
      40:[invoice(3,12,[line(13,'C',1,300)])]
    },
    '7':{0:[]}
  },{totalRecordsByType:{'3':45,'7':0}});
  const result=await purchaseLayers.buildPurchaseLayerDataset(db,{
    shaygan:api,mode:'full',reset:true,dateFrom:'14050101',pageSize:20,maxPages:10,maxPageAttempts:1
  });
  assert.equal(result.ok,true);
  assert.deepEqual(api.calls.filter(call=>call.type===3).map(call=>call.rowStart),[0,20,40]);
  assert.deepEqual(api.calls.filter(call=>call.type===7).map(call=>call.rowStart),[0]);
  assert.equal(result.pagingByType['7'].expectedPages,0);
  assert.equal(result.validation.allTypesReachedEnd,true);
});

test('full backfill retries, represents returns, validates quantities, and activates atomically',async()=>{
  const db=new MemoryDb();
  const purchase=invoice(3,10,[line(11,'A',5,100)]);
  const returned=invoice(7,20,[line(21,'A',2,100)],{RelatedInvHeaderId:'HEADER-3-10'});
  const api=apiFor({'3':{0:[purchase],20:[]},'7':{0:[returned],20:[]}},{failOnce:true});
  const result=await purchaseLayers.buildPurchaseLayerDataset(db,{shaygan:api,mode:'full',reset:true,dateFrom:'14050101',pageSize:20,maxPages:3,maxPageAttempts:3});
  assert.equal(result.ok,true);
  assert.equal(result.status,'completed');
  assert.equal(result.activationStatus,'active');
  assert.equal(result.retryCount,1);
  assert.equal(result.duplicateCount,0);
  assert.equal(result.validation.quantityInvariantErrors,0);
  assert.equal(result.returnAudit.matchedReturnCount,1);
  const purchaseRow=await db.collection('supplierPurchaseLayers').findOne({datasetId:result.datasetId,layerKind:'purchase'});
  const returnRow=await db.collection('supplierPurchaseLayers').findOne({datasetId:result.datasetId,layerKind:'purchase-return'});
  assert.equal(purchaseRow.originalQuantity,5);
  assert.equal(purchaseRow.returnedQuantity,2);
  assert.equal(purchaseRow.netPurchasedQuantity,3);
  assert.equal(returnRow.matchedPurchaseLineIdentity,purchaseRow.purchaseLineIdentity);
  const active=await purchaseLayers.activeDataset(db);
  assert.equal(active.datasetId,result.datasetId);
});

test('bounded candidate remains inactive then resumes the same dataset without duplicates',async()=>{
  const db=new MemoryDb();
  const firstApi=apiFor({'3':{0:[invoice(3,10,[line(11,'A',5,100)])]},'7':{}});
  const bounded=await purchaseLayers.buildPurchaseLayerDataset(db,{shaygan:firstApi,mode:'full',reset:true,dateFrom:'14050101',pageSize:20,maxPages:1,maxPageAttempts:1});
  assert.equal(bounded.ok,false);
  assert.equal(bounded.status,'completed_with_errors');
  assert.equal((await purchaseLayers.activeDataset(db)),null);

  const resumeApi=apiFor({'3':{20:[]},'7':{0:[]}});
  const resumed=await purchaseLayers.buildPurchaseLayerDataset(db,{shaygan:resumeApi,resumeDatasetId:bounded.datasetId,maxPages:3,maxPageAttempts:1});
  assert.equal(resumed.ok,true);
  assert.equal(resumed.datasetId,bounded.datasetId);
  assert.equal(resumed.resumeCount,1);
  assert.equal(resumed.duplicateCount,0);
  assert.equal(await db.collection('supplierPurchaseLayers').estimatedDocumentCount(),1);
  assert.equal((await purchaseLayers.activeDataset(db)).datasetId,bounded.datasetId);
});

test('an interrupted running candidate can safely replay from page zero with the same id',async()=>{
  const db=new MemoryDb({
    purchaseLayerDatasets:[{
      datasetId:'PLAYER-INTERRUPTED',status:'running',activationStatus:'candidate',mode:'full',
      sourceDateFrom:'14050101',sourceDateTo:'',pageSize:20,maxPages:1000,maxPageAttempts:3,
      pageCount:16,resumeCount:1,
      checkpoint:{typeIndex:0,nextRowStartByType:{'3':320,'7':0},reachedEndByType:{'3':false,'7':false}}
    }]
  });
  const existing=purchaseLayers._mapSourceLine(invoice(3,11,[line(12,'B',1,200)]),line(12,'B',1,200),1,'PLAYER-INTERRUPTED');
  await db.collection('supplierPurchaseLayers').insertOne(existing);
  const api=apiFor({
    '3':{0:[invoice(3,10,[line(11,'A',5,100)])],20:[invoice(3,11,[line(12,'B',1,200)])],40:[]},
    '7':{0:[]}
  });
  const result=await purchaseLayers.buildPurchaseLayerDataset(db,{
    shaygan:api,resumeDatasetId:'PLAYER-INTERRUPTED',replayFromStart:true,maxPages:10,maxPageAttempts:1
  });
  assert.equal(result.ok,true);
  assert.equal(result.datasetId,'PLAYER-INTERRUPTED');
  assert.equal(result.resumeCount,2);
  assert.equal(result.replayFromStartCount,1);
  assert.equal(result.duplicateCount,0);
  assert.equal(api.calls[0].rowStart,0);
  assert.equal(db.collection('supplierPurchaseLayers').rows.filter(row=>row.datasetId==='PLAYER-INTERRUPTED').length,2);
});

test('failed candidate never replaces a prior active dataset',async()=>{
  const db=new MemoryDb();
  const goodApi=apiFor({'3':{0:[invoice(3,10,[line(11,'A',5,100)])],20:[]},'7':{0:[]}});
  const good=await purchaseLayers.buildPurchaseLayerDataset(db,{shaygan:goodApi,mode:'full',reset:true,dateFrom:'14050101',maxPages:3});
  assert.equal(good.ok,true);
  const badApi={getInvoicePageByTypeNumberRange:async()=>({ok:false,error:'permanent failure'})};
  const bad=await purchaseLayers.buildPurchaseLayerDataset(db,{shaygan:badApi,mode:'full',reset:true,dateFrom:'14050101',maxPages:3,maxPageAttempts:1});
  assert.equal(bad.ok,false);
  assert.equal((await purchaseLayers.activeDataset(db)).datasetId,good.datasetId);
});

test('incremental clone preserves legacy rows and coverage never activates FIFO or profit',async()=>{
  const db=new MemoryDb({
    supplierPurchaseLayers:[{snapshotId:'LEGACY',persistentLayerId:'OLD',itemCode:'LEGACY'}],
    saleInvoiceLines:[{saleInvoiceType:2,saleInvoiceNo:1,row:1,itemCode:'A',qty:3,saleValue:600}]
  });
  const fullApi=apiFor({'3':{0:[invoice(3,10,[line(11,'A',5,100)])],20:[]},'7':{0:[]}});
  const full=await purchaseLayers.buildPurchaseLayerDataset(db,{shaygan:fullApi,mode:'full',reset:true,dateFrom:'14050101',maxPages:3});
  const incrementalApi=apiFor({'3':{0:[invoice(3,11,[line(12,'B',1,200)])],20:[]},'7':{0:[]}});
  const incremental=await purchaseLayers.buildPurchaseLayerDataset(db,{shaygan:incrementalApi,mode:'incremental',dateFrom:'14050101',maxPages:3});
  assert.equal(incremental.ok,true);
  assert.equal(incremental.baseDatasetId,full.datasetId);
  assert.equal(db.collection('supplierPurchaseLayers').rows.filter(row=>row.snapshotId==='LEGACY').length,1);
  assert.equal(db.collection('supplierPurchaseLayers').rows.filter(row=>row.datasetId===incremental.datasetId&&row.layerKind==='purchase').length,2);
  const coverage=await purchaseLayers.coverage(db);
  assert.equal(coverage.profitActivationAllowed,false);
  assert.equal(coverage.fifoCalculationActivated,false);
  assert.equal(coverage.saleItemsWithPurchaseLayer,1);
  assert.equal(coverage.saleValueEligiblePercent,100);
  assert.equal(coverage.fifoReadiness.deterministicAllocationEligible,false);
  assert.equal((await purchaseLayers.activeDataset(db)).datasetId,incremental.datasetId);
  assert.notEqual(full.datasetId,incremental.datasetId);
});

test('a purchase return exceeding its directly linked purchase is rejected and never active',async()=>{
  const db=new MemoryDb();
  const api=apiFor({
    '3':{0:[invoice(3,10,[line(11,'A',1,100)])],20:[]},
    '7':{0:[invoice(7,20,[line(21,'A',2,100)],{RelatedInvHeaderId:'HEADER-3-10'})],20:[]}
  });
  const result=await purchaseLayers.buildPurchaseLayerDataset(db,{shaygan:api,mode:'full',reset:true,dateFrom:'14050101',maxPages:3});
  assert.equal(result.ok,false);
  assert.equal(result.validation.quantityInvariantErrors,0);
  assert.equal(result.returnAudit.quantityInvariantErrors,1);
  assert.equal(result.rejectedRowCount,1);
  assert.equal(await purchaseLayers.activeDataset(db),null);
});
