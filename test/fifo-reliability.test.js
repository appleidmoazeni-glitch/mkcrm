'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const crypto=require('crypto');
const {MemoryDb}=require('./helpers/memory-mongo');
const reliability=require('../src/lib/fifo-reliability');
const manual=require('../src/lib/manual-cost-resolution');

function emptyManualFingerprint(){return crypto.createHash('sha256').update('[]').digest('hex');}
function seed(){return new MemoryDb({
  fifoDatasetState:[{scopeKey:'fifo-shadow-v2-precision-evidence',activeDatasetId:'FIFO-R'}],
  fifoDatasets:[{datasetId:'FIFO-R',status:'completed',activationStatus:'validated-shadow',algorithmVersion:'fifo-shadow-v2-precision-evidence',sourceSaleSnapshotId:'SALE-R',sourcePurchaseDatasetId:'BUY-R',sourceFingerprint:'S',allocationFingerprint:'A',manualResolutionSetFingerprint:emptyManualFingerprint(),validation:{valid:true}}],
  fifoAllocations:[
    {datasetId:'FIFO-R',allocationId:'A1',saleLineId:'L1',sourceType:'official_purchase_layer',quantityExact:'2.000000',allocatedSaleValueExact:'200.00',allocatedCostAmountExact:'120.00',layerAvailableBefore:'5.000000',itemCode:'A',sellerAccountNumber:'S1'},
    {datasetId:'FIFO-R',allocationId:'A2',saleLineId:'L2',sourceType:'unknown_cost',quantityExact:'1.000000',unknownQty:1,allocatedSaleValueExact:'150.00',allocatedCostAmountExact:null,unknownReason:'no_valid_cost_source',itemCode:'B',sellerAccountNumber:'S1'}
  ],
  fifoProfitFacts:[
    {fifoDatasetId:'FIFO-R',saleLineIdentity:'L1',saleInvoiceType:2,quantityExact:'2.000000',saleAmountExact:'200.00',fifoCostExact:'120.00',actualFifoProfitExact:'80.00',costCoverageStatus:'complete',sellerIdentity:'S1',officialProductCategoryName:'NOTEBOOK'},
    {fifoDatasetId:'FIFO-R',saleLineIdentity:'L2',saleInvoiceType:2,quantityExact:'1.000000',saleAmountExact:'150.00',fifoCostExact:null,actualFifoProfitExact:null,costCoverageStatus:'unknown',sellerIdentity:'S1',officialProductCategoryName:'CPU'}
  ],
  fifoExceptions:[{datasetId:'FIFO-R',code:'UNKNOWN_COST'}],manualCostResolutions:[]
});}

test('read-only reliability report reconciles exact quantity and money and exposes multidimensional coverage',async()=>{
  const db=seed();
  const report=await reliability.report(db,{});
  assert.equal(report.quantityConservation.pass,true);assert.equal(report.moneyConservation.pass,true);
  assert.equal(report.coverage.line.percent,'50.0000');assert.equal(report.coverage.quantity.percent,'66.6667');assert.equal(report.coverage.saleValue.percent,'57.1429');
  assert.equal(report.unknownRootCauses[0].bucket,'no_purchase_history_available');assert.equal(report.payableCommission,false);assert.equal(report.readOnly,true);
});

test('manual-cost set change marks active FIFO stale without mutating the historical dataset',async()=>{
  const db=seed();const old=structuredClone(db.collection('fifoDatasets').rows[0]);
  db.collection(manual.COLLECTION).rows.push({resolutionId:'M1',revision:1,status:'approved',deleted:false,itemCode:'B',manualCost:50,effectiveFrom:'14050101',effectiveTo:'',currency:'IRR',sourceType:'manual'});
  const report=await reliability.report(db,{});assert.equal(report.source.stale,true);assert.ok(report.source.staleReasons.includes('approved-manual-cost-set-changed'));assert.deepEqual(db.collection('fifoDatasets').rows[0],old);
});

test('conservation mismatches and duplicate allocation identities make FIFO unreliable',async()=>{
  const db=seed();db.collection('fifoAllocations').rows[0].allocatedCostAmountExact='119.99';db.collection('fifoAllocations').rows.push(structuredClone(db.collection('fifoAllocations').rows[0]));
  const report=await reliability.report(db,{});assert.equal(report.reliable,false);assert.ok(report.counts.duplicateAllocationIds>0);assert.equal(report.moneyConservation.pass,false);
});

test('purchase source freshness compares Gregorian read-model dates as canonical Jalali dates',async()=>{
  const db=seed();
  db.collection('supplierPurchaseLayers').rows.push({datasetId:'BUY-R',layerKind:'purchase',purchaseInvoiceNo:1,purchaseInvoiceDate:'14050501'});
  db.collection('supplierPurchaseInvoices').rows.push({invTyp:3,invNo:1,invDate:'2026-07-26',items:[]});
  const report=await reliability.report(db,{});
  assert.equal(report.sourceCompleteness.latestPurchaseDateInDataset,'14050501');
  assert.equal(report.sourceCompleteness.latestAvailableOfficialPurchaseDate,'14050504');
});
