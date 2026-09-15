'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {MemoryDb}=require('./helpers/memory-mongo');
const manual=require('../src/lib/manual-cost-resolution');
const fifo=require('../src/lib/fifo-shadow-engine');

const accounting={username:'accounting-a',role:'accounting'};
const manager={username:'manager-b',role:'manager'};
function input(overrides={}){
  return {itemGuid:'GUID-X',itemCode:'X',manualCostExact:'125.500000',targetQuantityExact:'2.000000',effectiveFrom:'14050101',effectiveTo:'14050131',sourceType:'commercial_announced_cost',resolutionScope:'commercial_announced_quantity',commercialReference:'COM-42',reason:'اعلام مکتوب بازرگانی',...overrides};
}
function db(){
  return new MemoryDb({
    manualCostResolutions:[],fifoSourceInvalidations:[],
    fifoDatasetState:[{scopeKey:'fifo-shadow-v2-precision-evidence',activeDatasetId:'FIFO-A'}],
    fifoAllocations:[{datasetId:'FIFO-A',allocationId:'U1',saleLineId:'SL-1',saleInvoiceType:2,saleInvoiceNo:1,saleRow:1,saleDate:'14050110',sourceType:'unknown_cost',itemGuid:'GUID-X',itemCode:'X',quantityExact:'3.000000',allocatedSaleValueExact:'3000.00',allocatedCostAmountExact:null,sellerAccountNumber:'S1',sellerName:'Seller',storeName:'Store'}],
    openingAccountingEvidenceDatasets:[],openingAccountingCostBasis:[],itemCatalogAll:[]
  });
}
async function pending(store,overrides={}){
  const created=await manual.createDraft(store,input(overrides),accounting);
  return manual.transition(store,created.resolution.resolutionId,'submit',accounting,{revision:created.resolution.revision});
}

test('new item-scope and incomplete commercial evidence fail closed',async()=>{
  const store=db();
  await assert.rejects(manual.createDraft(store,{...input(),resolutionScope:'item'},accounting),error=>error.code==='MANUAL_COST_UNBOUNDED_SCOPE_FORBIDDEN');
  await assert.rejects(manual.createDraft(store,input({itemGuid:''}),accounting),error=>error.code==='MANUAL_COST_STABLE_IDENTITY_REQUIRED');
  await assert.rejects(manual.createDraft(store,input({targetQuantityExact:''}),accounting),error=>error.code==='MANUAL_COST_TARGET_QUANTITY_INVALID');
  await assert.rejects(manual.createDraft(store,input({effectiveTo:''}),accounting),error=>error.code==='MANUAL_COST_EFFECTIVE_TO_REQUIRED');
  await assert.rejects(manual.createDraft(store,input({commercialReference:''}),accounting),error=>error.code==='MANUAL_COST_COMMERCIAL_REFERENCE_REQUIRED');
});

test('conflicting canonical ItemCode and ItemGuid fail closed',async()=>{
  const store=db();
  store.collection('itemCatalogAll').rows.push({itemGuid:'GUID-OTHER',canonicalItemGuid:'guid-other',itemCode:'X',normalizedItemCode:'X',canonicalIdentity:'guid:guid-other'});
  await assert.rejects(manual.createDraft(store,input(),accounting),error=>error.code==='MANUAL_COST_ITEM_IDENTITY_CONFLICT');
});

test('impact preview is line-bounded, immutable, and approval is bound to its fingerprint',async()=>{
  const store=db(),before=structuredClone(store.collection('fifoAllocations').rows);
  const submitted=await pending(store);
  await assert.rejects(manual.transition(store,submitted.resolution.resolutionId,'approve',manager,{revision:submitted.resolution.revision}),error=>error.code==='MANUAL_COST_IMPACT_PREVIEW_REQUIRED');
  const preview=await manual.impactPreview(store,submitted.resolution.resolutionId,manager);
  assert.equal(preview.affectedLines.length,1);
  assert.equal(preview.affectedLines[0].potentiallyCoveredQuantityExact,'2.000000');
  assert.equal(preview.affectedLines[0].currentProvenance,'UNKNOWN');
  assert.equal(preview.affectedLines[0].currentFifoCostExact,'0.00');
  assert.equal(preview.projectedResolvedCostExact,'251.00');
  assert.deepEqual(store.collection('fifoAllocations').rows,before);
  const approved=await manual.transition(store,submitted.resolution.resolutionId,'approve',manager,{revision:submitted.resolution.revision,previewFingerprint:preview.previewFingerprint});
  assert.equal(approved.resolution.status,'approved');
  assert.equal(approved.resolution.approvedImpactPreview.fingerprint,preview.previewFingerprint);
  assert.equal(store.collection('fifoSourceInvalidations').rows.length,1);
  assert.deepEqual(store.collection('fifoAllocations').rows,before);
});

test('approved impact preview matches the next FIFO candidate allocation effect',async()=>{
  const store=db();
  const submitted=await pending(store);
  const preview=await manual.impactPreview(store,submitted.resolution.resolutionId,manager);
  const approved=await manual.transition(store,submitted.resolution.resolutionId,'approve',manager,{revision:submitted.resolution.revision,previewFingerprint:preview.previewFingerprint});
  const source=fifoSource([approved.resolution]);
  source.saleLines=source.saleLines.slice(0,1);
  source.saleLines[0].qty=3;
  source.saleLines[0].saleValue=3000;
  const allocations=fifo._allocateSources('FIFO-N',source).allocations;
  const commercial=allocations.find(row=>row.costSourceType==='COMMERCIAL_ANNOUNCED_COST');
  const unresolved=allocations.find(row=>row.sourceType==='unknown_cost');
  assert.equal(commercial.saleLineId,preview.affectedLines[0].saleLineId);
  assert.equal(commercial.quantityExact,preview.affectedLines[0].potentiallyCoveredQuantityExact);
  assert.equal(commercial.allocatedCostAmountExact,preview.projectedResolvedCostExact);
  assert.equal(commercial.manualResolutionId,approved.resolution.resolutionId);
  assert.equal(commercial.manualRevision,approved.resolution.revision);
  assert.equal(commercial.manualContentHash,approved.resolution.contentHash);
  assert.equal(unresolved.quantityExact,'1.000000');
});

test('preview becomes stale when active FIFO lineage changes',async()=>{
  const store=db(),submitted=await pending(store),preview=await manual.impactPreview(store,submitted.resolution.resolutionId,manager);
  store.collection('fifoDatasetState').rows[0].activeDatasetId='FIFO-B';
  await assert.rejects(manual.transition(store,submitted.resolution.resolutionId,'approve',manager,{revision:submitted.resolution.revision,previewFingerprint:preview.previewFingerprint}),error=>error.code==='MANUAL_COST_IMPACT_PREVIEW_STALE');
});

test('approved Opening authority blocks overlapping Manual capacity',async()=>{
  const store=db();
  store.collection('openingAccountingEvidenceDatasets').rows.push({datasetId:'OPEN-A',status:'completed',approvalStatus:'approved',authorityLifecycleStatus:'APPROVED',revision:1});
  store.collection('openingAccountingCostBasis').rows.push({datasetId:'OPEN-A',evidenceId:'OE-1',status:'VALIDATED_CANDIDATE',extractionComplete:true,itemGuid:'GUID-X',itemCode:'X',openingQuantityExact:'5.000000',effectiveOpeningDate:'14040101'});
  const created=await manual.createDraft(store,input(),accounting);
  await assert.rejects(manual.transition(store,created.resolution.resolutionId,'submit',accounting,{revision:1}),error=>error.code==='MANUAL_COST_OPENING_CAPACITY_COLLISION');
});

function fifoSource(manualRows,purchaseLayers=[]){
  return {
    saleActive:{snapshotId:'SALE-A'},purchaseActive:{datasetId:'PUR-A'},openingActive:null,
    saleHeaders:[],saleReturns:[],purchaseReturnResolutions:[],saleReturnResolutions:[],openingRows:[],
    saleLines:[
      {snapshotId:'SALE-A',saleLineId:'SL-1',saleInvoiceType:2,saleInvoiceNo:1,saleDate:'14050110',row:1,itemGuid:'GUID-X',itemCode:'X',itemName:'X',qty:1,saleValue:500},
      {snapshotId:'SALE-A',saleLineId:'SL-2',saleInvoiceType:2,saleInvoiceNo:2,saleDate:'14050210',row:1,itemGuid:'GUID-X',itemCode:'X',itemName:'X',qty:1,saleValue:500}
    ],purchaseLayers,manuals:manualRows
  };
}

test('commercial evidence is GUID/date/quantity bounded and cannot leak outside its period',()=>{
  const rows=fifo._allocateSources('FIFO-N',fifoSource([{resolutionId:'M1',schemaVersion:4,revision:3,contentHash:'abc123',status:'approved',itemGuid:'GUID-X',itemCode:'X',manualCostExact:'100.000000',targetQuantityExact:'1.000000',effectiveFrom:'14050101',effectiveTo:'14050131',sourceType:'commercial_announced_cost',resolutionScope:'commercial_announced_quantity',evidenceClass:'COMMERCIAL_ANNOUNCED_COST'}])).allocations;
  const first=rows.find(row=>row.saleLineId==='SL-1'),second=rows.find(row=>row.saleLineId==='SL-2');
  assert.equal(first.costSourceType,'COMMERCIAL_ANNOUNCED_COST');
  assert.equal(first.allocatedCostAmountExact,'100.00');
  assert.equal(first.manualResolutionId,'M1');
  assert.equal(first.manualRevision,3);
  assert.equal(first.manualContentHash,'abc123');
  assert.equal(second.sourceType,'unknown_cost');
});

test('commercial capacity cannot cover a later in-period sale after target quantity is exhausted',()=>{
  const source=fifoSource([{resolutionId:'M1',schemaVersion:4,revision:1,contentHash:'bounded',status:'approved',itemGuid:'GUID-X',itemCode:'X',manualCostExact:'100.000000',targetQuantityExact:'1.000000',effectiveFrom:'14050101',effectiveTo:'14050131',sourceType:'commercial_announced_cost',resolutionScope:'commercial_announced_quantity',evidenceClass:'COMMERCIAL_ANNOUNCED_COST'}]);
  source.saleLines[1].saleDate='14050111';
  const rows=fifo._allocateSources('FIFO-N',source).allocations;
  assert.equal(rows.find(row=>row.saleLineId==='SL-1').costSourceType,'COMMERCIAL_ANNOUNCED_COST');
  assert.equal(rows.find(row=>row.saleLineId==='SL-2').sourceType,'unknown_cost');
});

test('next FIFO candidate moves UNKNOWN to PROVEN and PARTIAL to PROVEN without mutating control allocations',()=>{
  const commercial={resolutionId:'M1',schemaVersion:4,revision:2,contentHash:'propagation',status:'approved',itemGuid:'GUID-X',itemCode:'X',manualCostExact:'100.000000',targetQuantityExact:'2.000000',effectiveFrom:'14050101',effectiveTo:'14050131',sourceType:'commercial_announced_cost',resolutionScope:'commercial_announced_quantity',evidenceClass:'COMMERCIAL_ANNOUNCED_COST'};
  const unknownControlSource=fifoSource([]);unknownControlSource.saleLines=unknownControlSource.saleLines.slice(0,1);
  const unknownControl=fifo._allocateSources('FIFO-C1',unknownControlSource).allocations;
  const unknownCandidateSource=fifoSource([commercial]);unknownCandidateSource.saleLines=unknownCandidateSource.saleLines.slice(0,1);
  const unknownCandidate=fifo._allocateSources('FIFO-N1',unknownCandidateSource).allocations;
  assert.equal(unknownControl.some(row=>row.sourceType==='unknown_cost'),true);
  assert.equal(unknownCandidate.every(row=>row.sourceType!=='unknown_cost'),true);
  const purchase={datasetId:'PUR-A',purchaseLineIdentity:'P1',layerKind:'purchase',validationStatus:'valid',purchaseInvoiceDate:'14050101',purchaseInvoiceNo:1,sourceRow:1,itemGuid:'GUID-X',itemCode:'X',netPurchasedQuantity:1,netUnitCost:80};
  const partialControlSource=fifoSource([],[purchase]);partialControlSource.saleLines=partialControlSource.saleLines.slice(0,1);partialControlSource.saleLines[0].qty=2;partialControlSource.saleLines[0].saleValue=1000;
  const partialControl=fifo._allocateSources('FIFO-C2',partialControlSource).allocations;
  const partialCandidateSource=fifoSource([commercial],[purchase]);partialCandidateSource.saleLines=partialCandidateSource.saleLines.slice(0,1);partialCandidateSource.saleLines[0].qty=2;partialCandidateSource.saleLines[0].saleValue=1000;
  const partialCandidate=fifo._allocateSources('FIFO-N2',partialCandidateSource).allocations;
  assert.equal(partialControl.some(row=>row.sourceType==='unknown_cost'),true);
  assert.equal(partialControl.some(row=>row.costSourceType==='OFFICIAL_PURCHASE_LAYER'),true);
  assert.equal(partialCandidate.some(row=>row.costSourceType==='OFFICIAL_PURCHASE_LAYER'),true);
  assert.equal(partialCandidate.some(row=>row.costSourceType==='COMMERCIAL_ANNOUNCED_COST'),true);
  assert.equal(partialCandidate.some(row=>row.sourceType==='unknown_cost'),false);
  assert.equal(unknownControl[0].datasetId,'FIFO-C1');
});

test('official Purchase remains authoritative ahead of commercial evidence',()=>{
  const purchase={datasetId:'PUR-A',purchaseLineIdentity:'P1',layerKind:'purchase',validationStatus:'valid',purchaseInvoiceDate:'14050101',purchaseInvoiceNo:1,sourceRow:1,itemGuid:'GUID-X',itemCode:'X',netPurchasedQuantity:1,netUnitCost:80};
  const commercial={resolutionId:'M1',schemaVersion:4,revision:3,status:'approved',itemGuid:'GUID-X',itemCode:'X',manualCostExact:'100.000000',targetQuantityExact:'1.000000',effectiveFrom:'14050101',effectiveTo:'14050131',sourceType:'commercial_announced_cost',resolutionScope:'commercial_announced_quantity',evidenceClass:'COMMERCIAL_ANNOUNCED_COST'};
  const row=fifo._allocateSources('FIFO-N',fifoSource([commercial],[purchase])).allocations.find(item=>item.saleLineId==='SL-1');
  assert.equal(row.costSourceType,'OFFICIAL_PURCHASE_LAYER');
  assert.equal(row.allocatedCostAmountExact,'80.00');
});

test('legacy item records are auditable and excluded from future FIFO without explicit review',async()=>{
  const store=db();
  store.collection('manualCostResolutions').rows.push({resolutionId:'LEGACY-1',schemaVersion:3,status:'approved',deleted:false,itemGuid:'GUID-X',itemCode:'X',resolutionScope:'item',manualCostExact:'90.000000',effectiveFrom:'14050101',effectiveTo:''});
  store.collection('fifoAllocations').rows.push({datasetId:'FIFO-A',saleLineId:'OLD',manualResolutionId:'LEGACY-1',quantityExact:'1.000000'});
  const audit=await manual.legacyItemScopeAudit(store,manager);
  assert.equal(audit.list[0].legacyClass,'LEGACY_UNBOUNDED_MANUAL_COST');
  assert.equal(audit.list[0].classification,'REQUIRES_MANAGEMENT_REVIEW');
  assert.equal(audit.list[0].futureFifoEligible,false);
  const future=fifo._allocateSources('FIFO-N',fifoSource(store.collection('manualCostResolutions').rows)).allocations;
  assert.equal(future.find(row=>row.saleLineId==='SL-1').sourceType,'unknown_cost');
});
