'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryDb } = require('./helpers/memory-mongo');
const fifo = require('../src/lib/fifo-shadow-engine');
const openingModule = require('../src/lib/opening-accounting-cost-basis');

function sale(itemCode, saleDate, qty, overrides={}) {
  return {
    snapshotId:'SALE-PINNED', saleLineId:`SL-${itemCode}-${saleDate}-${overrides.row||1}`,
    saleInvoiceType:2, saleInvoiceNo:overrides.saleInvoiceNo||1, saleGuid:`SALE-${itemCode}-${saleDate}`,
    saleDate, row:overrides.row||1, itemGuid:`GUID-${itemCode}`, itemCode, itemName:`Item ${itemCode}`,
    qty, saleValue:Number(overrides.saleValue||qty*1000), officialProductCategoryGuid:'MAIN-GUID',
    officialProductCategoryName:'NOTEBOOK', ...overrides
  };
}
function purchase(itemCode, date, qty, cost, overrides={}) {
  return {
    datasetId:'PURCHASE-PINNED', purchaseLineIdentity:`PUR-${itemCode}-${date}-${overrides.sourceRow||1}`,
    layerKind:'purchase', validationStatus:'valid', purchaseInvoiceDate:date,
    purchaseInvoiceNo:overrides.purchaseInvoiceNo||1, sourceRow:overrides.sourceRow||1,
    itemGuid:`GUID-${itemCode}`, itemCode, netPurchasedQuantity:qty, netUnitCost:String(cost), ...overrides
  };
}
function opening(itemCode, qty, cost, overrides={}) {
  return {
    datasetId:'OPENING-PINNED', evidenceId:`OPEN-${itemCode}`, status:'VALIDATED_CANDIDATE',
    extractionComplete:true, itemGuid:`GUID-${itemCode}`, itemCode, itemDescription:`Item ${itemCode}`,
    effectiveOpeningDate:'14050110', openingQuantityExact:Number(qty).toFixed(6),
    openingUnitCostExact:Number(cost).toFixed(6), openingTotalValueExact:(qty*cost).toFixed(2),
    sourceFingerprint:`source-${itemCode}`, recordFingerprint:`record-${itemCode}`, warehouseEvidence:[], ...overrides
  };
}
function source(overrides={}) {
  return {
    saleActive:{snapshotId:'SALE-PINNED',snapshot:{status:'completed'}},
    purchaseActive:{datasetId:'PURCHASE-PINNED',dataset:{status:'completed'}},
    openingActive:{datasetId:'OPENING-PINNED',dataset:{status:'completed',approvalStatus:'approved',revision:3},governance:{datasetFingerprint:'d'.repeat(64),sourceFingerprint:'s'.repeat(64),eligibilityFingerprint:'e'.repeat(64)}},
    saleHeaders:[], saleLines:[], purchaseLayers:[], openingRows:[], manuals:[],
    purchaseReturnResolutions:[], saleReturnResolutions:[], ...overrides
  };
}

test('approved Opening is a bounded chronological layer and never covers pre-opening quantity',()=>{
  const input=source({
    saleLines:[
      sale('A','14050109',1,{saleInvoiceNo:1}),
      sale('A','14050110',5,{saleInvoiceNo:2}),
      sale('B','14050110',3,{saleInvoiceNo:3}),
      sale('C','14050111',1,{saleInvoiceNo:4}),
      sale('C','14050112',1,{saleInvoiceNo:5}),
      sale('D','14050115',1,{saleInvoiceNo:6})
    ],
    purchaseLayers:[
      purchase('B','14050105',1,50),
      purchase('C','14050112',1,80)
    ],
    openingRows:[opening('A',4,100),opening('B',2,60),opening('C',1,70)]
  });
  const result=fifo._allocateSources('FIFO-OPENING',input,{});
  const rows=id=>result.allocations.filter(row=>row.saleLineId===id);
  assert.deepEqual(rows('SL-A-14050109-1').map(row=>[row.sourceType,row.unknownQty]),[['unknown_cost',1]]);
  assert.equal(rows('SL-A-14050109-1')[0].unknownReason,'PRE_OPENING_PERIOD');
  assert.deepEqual(rows('SL-A-14050110-1').map(row=>[row.sourceType,row.allocatedQty,row.unknownQty]),[
    ['approved_opening_accounting_cost',4,0],['unknown_cost',0,1]
  ]);
  assert.equal(rows('SL-A-14050110-1')[1].unknownReason,'OPENING_PARTIAL');
  assert.deepEqual(rows('SL-B-14050110-1').map(row=>[row.sourceType,row.allocatedQty]),[
    ['official_purchase_layer',1],['approved_opening_accounting_cost',2]
  ]);
  assert.equal(rows('SL-C-14050111-1')[0].sourceType,'approved_opening_accounting_cost');
  assert.equal(rows('SL-C-14050112-1')[0].sourceType,'official_purchase_layer');
  assert.equal(rows('SL-D-14050115-1')[0].sourceType,'unknown_cost');
  const openingRows=result.allocations.filter(row=>row.sourceType==='approved_opening_accounting_cost');
  assert.equal(openingRows.reduce((sum,row)=>sum+row.allocatedQty,0),7);
  assert.equal(openingRows.every(row=>row.openingDatasetId==='OPENING-PINNED'&&row.openingApprovalStatus==='approved'),true);
  const openingFacts=fifo._provenanceFacts(openingRows);
  assert.equal(openingFacts.every(row=>row.profitProvenanceStatus==='PROVEN'),true);
  assert.equal(openingFacts.every(row=>row.costSourceType==='APPROVED_OPENING_ACCOUNTING_COST'),true);
  assert.equal(openingFacts.every(row=>row.provenanceSources[0].sourceType==='APPROVED_OPENING_ACCOUNTING_COST'),true);
  assert.equal(openingFacts.every(row=>row.provenanceSources[0].openingDatasetId==='OPENING-PINNED'),true);
  const validation=fifo._reconcile(result);
  assert.equal(validation.valid,true);
  assert.equal(validation.openingOverConsumptionCount,0);
  assert.equal(validation.duplicateOpeningLayerCount,0);
});

test('candidate pins Opening fingerprints, verifies in-memory replay, and remains activation-blocked',async()=>{
  const db=new MemoryDb({fifoDatasets:[],fifoAllocations:[],fifoDiagnostics:[],fifoExceptions:[],fifoDatasetState:[]});
  const bundle=source({saleLines:[sale('A','14050110',1)],openingRows:[opening('A',1,100)]});
  const result=await fifo.buildShadowDataset(db,{
    saleSnapshotId:'SALE-PINNED',purchaseDatasetId:'PURCHASE-PINNED',openingDatasetId:'OPENING-PINNED',
    sourceLoader:async()=>bundle
  },{username:'accounting-review',role:'accounting'});
  assert.equal(result.ok,true);
  assert.equal(result.sourceOpeningDatasetId,'OPENING-PINNED');
  assert.equal(result.deterministicReplayVerified,true);
  const dataset=db.collection(fifo.DATASETS).rows.find(row=>row.datasetId===result.datasetId);
  assert.equal(dataset.sourceOpeningDatasetId,'OPENING-PINNED');
  assert.equal(dataset.openingDatasetFingerprint,'d'.repeat(64));
  assert.equal(dataset.openingSourceFingerprint,'s'.repeat(64));
  assert.equal(dataset.openingEligibilityFingerprint,'e'.repeat(64));
  assert.equal(dataset.finalFinancialActivationEligibility,'blocked');
  assert.deepEqual(dataset.finalFinancialActivationBlockers,[
    'OPENING_REVOCATION_SUPERSESSION_GOVERNANCE_NOT_IMPLEMENTED','HUMAN_FIFO_VALIDATION_REQUIRED'
  ]);
  assert.equal(dataset.profitActivationAllowed,false);
});

test('source loader fails closed unless the approved Opening immutable fingerprints match',async()=>{
  const evidence=opening('A',1,100,{canonicalIdentity:'code:A',recordFingerprint:'record-A',sourceFingerprint:'source-A'});
  const progress={datasetId:'OPENING-PINNED',progressId:'PROGRESS-A',status:'VALIDATED_CANDIDATE'};
  const eligibility={datasetId:'OPENING-PINNED',previewId:'PREVIEW-A',classification:'OPENING_ELIGIBLE',openingEligibleQuantityExact:'1.000000'};
  const datasetFingerprint=openingModule._hash([[evidence.canonicalIdentity,evidence.status,evidence.recordFingerprint]]);
  const sourceFingerprint=openingModule._sourceAggregateFingerprint([evidence]);
  const eligibilityFingerprint=openingModule._hash([[eligibility.previewId,eligibility.classification,eligibility.openingEligibleQuantityExact]]);
  const db=new MemoryDb({
    saleSnapshots:[{snapshotId:'SALE-PINNED',status:'completed'}],saleSnapshotDatasetLines:[],saleSnapshotDatasetHeaders:[],
    purchaseLayerDatasets:[{datasetId:'PURCHASE-PINNED',status:'completed'}],purchaseLayerDatasetState:[{scopeKey:'purchase-invoices-types-3-7',activeDatasetId:'PURCHASE-PINNED'}],supplierPurchaseLayers:[],
    openingAccountingEvidenceDatasets:[{datasetId:'OPENING-PINNED',status:'completed',approvalStatus:'approved',itemCount:1,statusCounts:{VALIDATED_CANDIDATE:1,NO_OPENING_STOCK:0,INCOMPLETE_SOURCE:0},datasetFingerprint,eligibilityPreview:{fingerprint:eligibilityFingerprint,fifoDatasetId:''}}],
    openingAccountingCostBasis:[evidence],openingAccountingEvidenceProgress:[progress],openingAccountingEligibilityPreview:[eligibility],
    fifoProfitFacts:[],fifoAllocations:[],manualCostResolutions:[],purchaseReturnResolutions:[],saleReturnResolutions:[]
  });
  const pinned={saleSnapshotId:'SALE-PINNED',purchaseDatasetId:'PURCHASE-PINNED',openingDatasetId:'OPENING-PINNED',openingFingerprints:{dataset:datasetFingerprint,source:sourceFingerprint,eligibility:eligibilityFingerprint}};
  const loaded=await fifo._loadSources(db,pinned);
  assert.equal(loaded.openingRows.length,1);
  assert.equal(loaded.openingActive.governance.sourceFingerprint,sourceFingerprint);
  await assert.rejects(fifo._loadSources(db,{...pinned,openingFingerprints:{...pinned.openingFingerprints,source:'f'.repeat(64)}}),error=>error.code==='FIFO_SOURCE_OPENING_FINGERPRINT_MISMATCH');
});

test('FIFO Audit UI exposes Purchase, Opening, Return and Unknown provenance with pinned lineage',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  const view=ui.slice(ui.indexOf("/* 0.9.19.66 FIFO Shadow Validation."),ui.indexOf("/* 0.9.19.67",ui.indexOf("/* 0.9.19.66 FIFO Shadow Validation.")));
  assert.match(view,/Opening Dataset/);
  assert.match(view,/Opening Accounting Cost مصوب/);
  assert.match(view,/openingEvidenceId/);
  assert.match(view,/openingBaseDate/);
  assert.match(view,/openingApprovalStatus/);
  assert.match(view,/NOT ELIGIBLE FOR FINAL FINANCIAL ACTIVATION/);
  assert.match(view,/approved_opening_accounting_cost/);
  assert.match(view,/sale_return_reversal/);
  assert.match(view,/unknown_cost/);
});
