'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryDb}=require('./helpers/memory-mongo');
const fifo=require('../src/lib/fifo-shadow-engine');
const manual=require('../src/lib/manual-cost-resolution');

const H='a'.repeat(64),S='b'.repeat(64),A='c'.repeat(64),C='d'.repeat(64);
const accountant={username:'accountant',userId:'U-A',role:'accounting'};

function seed(){
  const active={datasetId:'FIFO-A',status:'completed',activationStatus:'validated-candidate',validation:{valid:true},dateTo:'14050531',calculationCutoff:'14050531',sourceSaleSnapshotId:'SALE-A',sourcePurchaseDatasetId:'PUR-A',sourceOpeningDatasetId:'OPEN-A',openingApprovalRevision:2,openingDatasetFingerprint:H,openingSourceFingerprint:S,openingEligibilityFingerprint:A,manualResolutionSetFingerprint:manual._approvedRowsFingerprint([]).fingerprint,sourceFingerprint:S,allocationFingerprint:A,candidateFingerprint:C,immutable:true};
  return new MemoryDb({
    saleSnapshotState:[{scopeKey:'sale-type2',activeSnapshotId:'SALE-A',activatedAt:new Date('2026-09-01T08:00:00Z')}],
    saleSnapshots:[{snapshotId:'SALE-A',status:'completed',activationStatus:'active',dateTo:'14050631'}],
    saleSnapshotDatasetHeaders:[{snapshotId:'SALE-A',invTyp:2,invNo:1}],
    saleSnapshotDatasetLines:[{snapshotId:'SALE-A',saleLineId:'SL-2-1-1-X',saleInvoiceType:2,saleInvoiceNo:1,saleDate:'14050110',row:1,itemGuid:'G-X',itemCode:'X',qty:1,saleValue:500}],
    purchaseLayerDatasetState:[{scopeKey:'purchase-invoices-types-3-7',activeDatasetId:'PUR-A',activatedAt:new Date('2026-09-01T08:00:00Z')}],
    purchaseLayerDatasets:[{datasetId:'PUR-A',status:'completed',activationStatus:'active',sourceDateFrom:'12000101',sourceDateTo:'14050631',sourceFingerprint:'p'.repeat(64),layerFingerprint:'l'.repeat(64)}],
    supplierPurchaseLayers:[{datasetId:'PUR-A',datasetSchemaVersion:1,purchaseLineIdentity:'PL-X',layerKind:'purchase',validationStatus:'valid',costStatus:'known-from-shaygan-line',returnMatchStatus:'not-applicable',purchaseInvoiceDate:'14050101',purchaseInvoiceNo:10,sourceRow:1,itemGuid:'G-X',itemCode:'X',netPurchasedQuantity:1,netUnitCost:100,sourceHash:'PX'}],
    openingAccountingEvidenceDatasets:[{datasetId:'OPEN-A',status:'completed',approvalStatus:'approved',authorityLifecycleStatus:'APPROVED',revision:2,datasetFingerprint:H,sourceAggregateFingerprint:S,eligibilityPreview:{fingerprint:A}}],
    openingAccountingCostBasis:[],openingAccountingEligibilityPreview:[],
    manualCostResolutions:[],purchaseReturnResolutions:[],saleReturnResolutions:[],
    fifoDatasets:[active],fifoAllocations:[],fifoDiagnostics:[],fifoExceptions:[],
    fifoHumanValidationAudits:[{validationId:'HV-A',datasetId:'FIFO-A',candidateFingerprint:C,sourceFingerprint:S,allocationFingerprint:A,result:'PASS',completePopulation:true,humanTests:[...fifo.REQUIRED_HUMAN_TESTS],actor:{userId:'U-H',username:'human'},createdAt:new Date('2026-09-01T09:00:00Z')}],
    fifoDatasetState:[{scopeKey:fifo.SCOPE_KEY,activeDatasetId:'FIFO-A',authorityContractVersion:1,authorityRevision:4,activatedAt:new Date('2026-09-01T09:00:00Z'),humanValidationId:'HV-A',activeCandidateFingerprint:C,activeSourceFingerprint:S,activeAllocationFingerprint:A}],
    fifoBuildContexts:[],commissionDraftRuns:[],commissionDraftLines:[]
  });
}

test('A/D/P/Q canonical forward cutoff update replays full history into a new inactive immutable Candidate only',async()=>{
  const db=seed(),before=structuredClone(db.collection(fifo.DATASETS).rows[0]);
  const context=await fifo.resolveBuildContext(db,{calculationCutoff:'14050631'});
  const sourceLoader=async()=>({saleActive:{snapshotId:'SALE-A',snapshot:{status:'completed'}},purchaseActive:{datasetId:'PUR-A',dataset:{status:'completed',sourceDateFrom:'12000101'}},openingActive:{datasetId:'OPEN-A',dataset:{revision:2,approvalStatus:'approved'},governance:{datasetFingerprint:H,sourceFingerprint:S,eligibilityFingerprint:A}},saleHeaders:[],saleLines:structuredClone(db.collection('saleSnapshotDatasetLines').rows),purchaseLayers:structuredClone(db.collection('supplierPurchaseLayers').rows),openingRows:[],manuals:[],purchaseReturnResolutions:[],saleReturnResolutions:[]});
  const result=await fifo.buildShadowDataset(db,{canonicalUpdate:true,dateTo:'14050631',fifoBuildContext:context,sourceLoader},accountant);
  assert.equal(result.ok,true);assert.notEqual(result.datasetId,'FIFO-A');
  const created=db.collection(fifo.DATASETS).rows.find(row=>row.datasetId===result.datasetId);
  assert.equal(created.dateFrom,'');assert.equal(created.calculationCutoff,'14050631');
  assert.equal(created.fifoBuildContextVersion,1);assert.equal(created.activationStatus,'validated-candidate');
  assert.equal(created.accountingApproved,false);assert.equal(created.commissionCalculated,false);
  assert.deepEqual(db.collection(fifo.DATASETS).rows.find(row=>row.datasetId==='FIFO-A'),before);
  assert.equal(db.collection('commissionDraftRuns').rows.length,0);assert.equal(db.collection('commissionDraftLines').rows.length,0);
});

test('I canonical Build Context rejects an old Purchase authority after page-load',async()=>{
  const db=seed(),context=await fifo.resolveBuildContext(db,{calculationCutoff:'14050631'});
  db.collection('purchaseLayerDatasets').rows.push({datasetId:'PUR-B',status:'completed',activationStatus:'active',sourceDateTo:'14050631',sourceFingerprint:'q'.repeat(64),layerFingerprint:'m'.repeat(64)});
  db.collection('purchaseLayerDatasetState').rows[0].activeDatasetId='PUR-B';
  await assert.rejects(fifo.assertBuildContextCurrent(db,context),error=>error.code==='FIFO_BUILD_CONTEXT_STALE');
});

test('K/L/M freshness uses authoritative activation time, separate cutoff, and all governed source dimensions',async()=>{
  const db=seed(),fresh=await fifo.fifoFreshness(db);
  assert.equal(fresh.lastFifoUpdatedAt.toISOString(),'2026-09-01T09:00:00.000Z');
  assert.equal(fresh.calculationCutoff,'14050531');assert.equal(fresh.sourceFreshnessStatus,'CURRENT');
  db.collection('saleSnapshotState').rows[0].activeSnapshotId='SALE-B';
  db.collection('saleSnapshots').rows.push({snapshotId:'SALE-B',status:'completed',activationStatus:'active',dateTo:'14050631'});
  const stale=await fifo.fifoFreshness(db);assert.ok(stale.staleReasons.includes('SALE_CHANGED'));
  assert.equal(db.collection(fifo.DATASETS).rows[0].activationStatus,'validated-candidate');
});

test('N/O old Seller Financial remains immutable and is flagged when pinned FIFO differs',async()=>{
  const db=seed();db.collection('sellerFinancialPerformanceRuns').rows.push({runId:'SF-OLD',sourceFifoDatasetId:'FIFO-OLD',status:'completed',immutable:true});
  const before=structuredClone(db.collection('sellerFinancialPerformanceRuns').rows[0]);
  const fresh=await fifo.fifoFreshness(db,{consumerFifoDatasetId:'FIFO-OLD'});
  assert.equal(fresh.sellerFinancialStale,true);assert.ok(fresh.staleReasons.includes('SELLER_FINANCIAL_FIFO_STALE'));
  assert.deepEqual(db.collection('sellerFinancialPerformanceRuns').rows[0],before);
});

test('B/C/E/F/G/H historical Purchase correction is a full canonical Candidate change and never mutates old versions',async()=>{
  const db=seed(),oldPurchase=structuredClone(db.collection('purchaseLayerDatasets').rows[0]),oldFifo=structuredClone(db.collection(fifo.DATASETS).rows[0]);
  const source={saleActive:{snapshotId:'SALE-A'},purchaseActive:{datasetId:'PUR-B',dataset:{sourceDateFrom:'12000101'}},openingActive:null,saleHeaders:[],saleLines:[{saleLineId:'SL-X',saleInvoiceType:2,saleInvoiceNo:1,saleDate:'14050110',row:1,itemGuid:'G-X',itemCode:'X',qty:1,saleValue:500}],purchaseLayers:[{datasetId:'PUR-B',datasetSchemaVersion:1,purchaseLineIdentity:'PL-X',layerKind:'purchase',validationStatus:'valid',costStatus:'known-from-shaygan-line',returnMatchStatus:'not-applicable',purchaseInvoiceDate:'14050101',purchaseInvoiceNo:10,sourceRow:1,itemGuid:'G-X',itemCode:'X',netPurchasedQuantity:1,netUnitCost:250}],openingRows:[],manuals:[],purchaseReturnResolutions:[],saleReturnResolutions:[]};
  const oldResult=fifo._allocateSources('OLD',{...source,purchaseLayers:[{...source.purchaseLayers[0],costStatus:require('../src/lib/canonical-purchase-layer-contract').PENDING_PURCHASE_PRICE,netUnitCost:1}]},{dateTo:'14050631'});
  const nextResult=fifo._allocateSources('NEW',source,{dateTo:'14050631'});
  assert.equal(oldResult.allocations[0].sourceType,'unknown_cost');assert.equal(nextResult.allocations[0].sourceType,'official_purchase_layer');assert.equal(nextResult.allocations[0].unitCost,250);
  assert.notEqual(fifo._sourceFingerprintFor(oldResult,{...source,purchaseLayers:oldResult.officialRows},{saleSnapshotId:'SALE-A',purchaseDatasetId:'PUR-A',openingDatasetId:''}),fifo._sourceFingerprintFor(nextResult,source,{saleSnapshotId:'SALE-A',purchaseDatasetId:'PUR-B',openingDatasetId:''}));
  assert.deepEqual(db.collection('purchaseLayerDatasets').rows[0],oldPurchase);assert.deepEqual(db.collection(fifo.DATASETS).rows[0],oldFifo);
});

test('J and Management UI expose canonical authority, freshness, cutoff and full Purchase refresh without technical ID inputs',()=>{
  const root=path.join(__dirname,'..'),server=fs.readFileSync(path.join(root,'src/server.js'),'utf8'),ui=fs.readFileSync(path.join(root,'public/assets/app.js'),'utf8');
  for(const contract of ['/api/accounting/fifo-shadow/build-context','/api/accounting/fifo-shadow/freshness','expectedBuildContextFingerprint','canonicalUpdate:true'])assert.ok(server.includes(contract));
  for(const contract of ['آخرین به‌روزرسانی FIFO','محاسبات FIFO تا تاریخ','به‌روزرسانی FIFO','بازخوانی کامل تاریخی خرید','mode:\'full\'','sellerFinancialMessage'])assert.ok(ui.includes(contract),contract);
  assert.doesNotMatch(ui,/id="fifoFrom"/);assert.doesNotMatch(ui,/reviewSessionId.*fifo-shadow\/start/);
});
