'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryDb}=require('./helpers/memory-mongo');
const manual=require('../src/lib/manual-cost-resolution');

const actors={
  admin:{username:'admin',role:'admin'},
  accounting:{username:'accounting',role:'accounting'},
  purchase:{username:'purchase',role:'purchase'},
  manager:{username:'manager',role:'manager'}
};

function fixture({fullyCovered=false}={}){
  const secondRemaining=fullyCovered?'0.000000':'1.000000';
  const secondCovered=fullyCovered?'1.000000':'0.000000';
  return new MemoryDb({
    saleSnapshotState:[{scopeKey:'sale-type2|14050101|',activeSnapshotId:'SALE-A'}],
    saleSnapshots:[{snapshotId:'SALE-A',status:'completed',activationStatus:'active'}],
    saleSnapshotDatasetHeaders:[{snapshotId:'SALE-A',invTyp:2,invNo:10},{snapshotId:'SALE-A',invTyp:2,invNo:11}],
    saleSnapshotDatasetLines:[
      {snapshotId:'SALE-A',saleLineId:'SL-10',saleInvoiceType:2,saleInvoiceNo:10,saleDate:'14050110',itemGuid:'GUID-X',itemCode:'X',itemName:'کالای X',qty:15,saleValue:15000},
      {snapshotId:'SALE-A',saleLineId:'SL-11',saleInvoiceType:2,saleInvoiceNo:11,saleDate:'14050111',itemGuid:'GUID-X',itemCode:'X',itemName:'کالای X',qty:1,saleValue:1000}
    ],
    purchaseLayerDatasetState:[{scopeKey:'purchase-invoices-types-3-7',activeDatasetId:'PUR-A'}],
    purchaseLayerDatasets:[{datasetId:'PUR-A',status:'completed',activationStatus:'active'}],
    supplierPurchaseLayers:[],
    itemCatalogAll:[{itemGuid:'GUID-X',canonicalItemGuid:'guid-x',itemCode:'X',normalizedItemCode:'X',canonicalIdentity:'guid:guid-x',historyCompleteness:'complete'}],
    itemInventoryCatalog:[],purchaseHistoryDiscoveryQueue:[],openingInventoryEvidence:[],
    openingAccountingEvidenceDatasets:[{datasetId:'OPEN-A',status:'completed',approvalStatus:'approved',authorityLifecycleStatus:'APPROVED',revision:3,datasetFingerprint:'a'.repeat(64),eligibilityPreview:{fingerprint:'b'.repeat(64)}}],
    openingAccountingCostBasis:[{datasetId:'OPEN-A',evidenceId:'OE-X',status:'VALIDATED_CANDIDATE',approvalStatus:'approved',extractionComplete:true,itemGuid:'GUID-X',itemCode:'X',effectiveOpeningDate:'14050101',openingQuantityExact:'15.000000',openingUnitCostExact:'63203927.170000',openingTotalValueExact:'948058907.55',sourceFingerprint:'c'.repeat(64)}],
    openingAccountingEligibilityPreview:[
      {datasetId:'OPEN-A',saleLineIdentity:'SL-10',saleInvoiceNo:10,saleRow:1,saleDate:'14050110',itemGuid:'GUID-X',itemCode:'X',unknownQuantityExact:'15.000000',openingEligibleQuantityExact:'15.000000',remainingUnknownQuantityExact:'0.000000'},
      {datasetId:'OPEN-A',saleLineIdentity:'SL-11',saleInvoiceNo:11,saleRow:1,saleDate:'14050111',itemGuid:'GUID-X',itemCode:'X',unknownQuantityExact:'1.000000',openingEligibleQuantityExact:secondCovered,remainingUnknownQuantityExact:secondRemaining}
    ],
    manualCostResolutions:[],fifoSourceInvalidations:[],
    fifoDatasetState:[{scopeKey:'fifo-shadow-v2-precision-evidence',activeDatasetId:'FIFO-A'}],
    fifoDatasets:[{datasetId:'FIFO-A',status:'completed',activationStatus:'active',calculationCutoff:'14050531',activatedAt:new Date('2026-09-15T10:00:00Z')}],
    fifoAllocations:[{datasetId:'FIFO-A',allocationId:'U-11',saleLineId:'SL-11',saleInvoiceType:2,saleInvoiceNo:11,saleRow:1,saleDate:'14050111',sourceType:'unknown_cost',itemGuid:'GUID-X',itemCode:'X',quantityExact:'1.000000',allocatedSaleValueExact:'1000.00',allocatedCostAmountExact:null}]
  });
}

test('management review derives only the unresolved remainder and preserves approved Opening authority',async()=>{
  const db=fixture(),review=await manual.managementReview(db,{itemGuid:'GUID-X',itemCode:'X'},actors.admin);
  assert.equal(review.actionAllowed,true);
  assert.equal(review.proposal.sourceClass,'OPENING_ACCOUNTING_COST');
  assert.equal(review.proposal.suggestedCostExact,'63203927.170000');
  assert.equal(review.exposure.requiredQuantityExact,'16.000000');
  assert.equal(review.exposure.openingCoveredQuantityExact,'15.000000');
  assert.equal(review.exposure.unresolvedQuantityExact,'1.000000');
  assert.equal(review.scope.targetQuantityExact,'1.000000');
  assert.equal(review.scope.effectiveFrom,'14050111');
  assert.equal(review.scope.effectiveTo,'14050111');
  assert.equal(db.collection('manualCostResolutions').rows.length,0);
});

test('management review resolves a legacy Sale Snapshot code to one unambiguous canonical ItemGuid',async()=>{
  const db=fixture();
  db.collection('saleSnapshotDatasetLines').rows.forEach(row=>{row.itemGuid='';});
  const review=await manual.managementReview(db,{itemCode:' x '},actors.admin);
  assert.equal(review.item.itemGuid,'guid-x');
  assert.equal(review.item.itemCode,'X');
  assert.equal(review.actionAllowed,true);
  assert.equal(review.scope.targetQuantityExact,'1.000000');
});

test('management review fails closed when ItemCode does not resolve to one canonical ItemGuid',async()=>{
  const db=fixture();
  db.collection('saleSnapshotDatasetLines').rows.forEach(row=>{row.itemGuid='';});
  db.collection('itemCatalogAll').rows.push({itemGuid:'GUID-Y',canonicalItemGuid:'guid-y',itemCode:'X',normalizedItemCode:'X',canonicalIdentity:'guid:guid-y'});
  await assert.rejects(manual.managementReview(db,{itemCode:'X'},actors.admin),error=>error.code==='MANUAL_COST_ITEM_IDENTITY_CONFLICT');
});

for(const role of ['admin','accounting','purchase'])test(`${role} may complete the same governed management workflow with self approval`,async()=>{
  const db=fixture(),before=structuredClone(db.collection('fifoAllocations').rows),review=await manual.managementReview(db,{itemGuid:'GUID-X',itemCode:'X'},actors[role]);
  const result=await manual.managementApprove(db,{itemGuid:'GUID-X',itemCode:'X',reviewFingerprint:review.reviewFingerprint,finalCost:'63203927.17'},actors[role]);
  const stored=db.collection('manualCostResolutions').rows[0];
  assert.equal(result.message,'هزینه ثبت و تایید شد.');
  assert.equal(stored.status,'approved');
  assert.equal(stored.createdBy.role,role);
  assert.equal(stored.approvedBy.role,role);
  assert.equal(stored.targetQuantityExact,'1.000000');
  assert.equal(stored.openingCoveredQuantityExact,'15.000000');
  assert.equal(stored.managementDecisionClass,'COMMERCIAL_ANNOUNCED_COST_REFERENCING_OPENING');
  assert.deepEqual(stored.auditLog.map(row=>row.action),['created-draft','submit','approve']);
  assert.equal(db.collection('fifoSourceInvalidations').rows.length,1);
  assert.deepEqual(db.collection('fifoAllocations').rows,before);
});

test('fully covered Opening exposure and non-operational role fail closed',async()=>{
  const db=fixture({fullyCovered:true}),review=await manual.managementReview(db,{itemGuid:'GUID-X',itemCode:'X'},actors.admin);
  assert.equal(review.actionAllowed,false);
  assert.ok(review.blockers.includes('OPENING_AUTHORITY_ALREADY_COVERS_EXPOSURE'));
  await assert.rejects(manual.managementReview(db,{itemGuid:'GUID-X',itemCode:'X'},actors.manager),error=>error.code==='MANUAL_COST_FORBIDDEN');
});

test('stale review and retry with a different amount are rejected',async()=>{
  const db=fixture(),review=await manual.managementReview(db,{itemGuid:'GUID-X',itemCode:'X'},actors.accounting);
  db.collection('saleSnapshotDatasetLines').rows[1].saleValue=1200;
  await assert.rejects(manual.managementApprove(db,{itemGuid:'GUID-X',itemCode:'X',reviewFingerprint:review.reviewFingerprint,finalCost:'100'},actors.accounting),error=>error.code==='MANUAL_COST_MANAGEMENT_REVIEW_STALE');
  db.collection('saleSnapshotDatasetLines').rows[1].saleValue=1000;
  const current=await manual.managementReview(db,{itemGuid:'GUID-X',itemCode:'X'},actors.accounting);
  await manual.managementApprove(db,{itemGuid:'GUID-X',itemCode:'X',reviewFingerprint:current.reviewFingerprint,finalCost:'100'},actors.accounting);
  await assert.rejects(manual.managementApprove(db,{itemGuid:'GUID-X',itemCode:'X',reviewFingerprint:current.reviewFingerprint,finalCost:'101'},actors.accounting),error=>error.code==='MANUAL_COST_MANAGEMENT_RETRY_AMOUNT_MISMATCH');
});

test('editing an approved amount creates an immutable superseding resolution',async()=>{
  const db=fixture(),initial=await manual.managementReview(db,{itemGuid:'GUID-X',itemCode:'X'},actors.purchase);
  const first=await manual.managementApprove(db,{itemGuid:'GUID-X',itemCode:'X',reviewFingerprint:initial.reviewFingerprint,finalCost:'100'},actors.purchase);
  const oldBefore=structuredClone(await manual.getById(db,first.resolutionId));
  const correction=await manual.managementReview(db,{supersedesResolutionId:first.resolutionId},actors.admin);
  const second=await manual.managementApprove(db,{supersedesResolutionId:first.resolutionId,reviewFingerprint:correction.reviewFingerprint,finalCost:'110'},actors.admin);
  assert.notEqual(second.resolutionId,first.resolutionId);
  assert.equal(second.supersedesResolutionId,first.resolutionId);
  assert.deepEqual(await manual.getById(db,first.resolutionId),oldBefore);
  assert.deepEqual(manual._effectiveRowsAt(db.collection('manualCostResolutions').rows,'14050111').map(row=>row.resolutionId),[second.resolutionId]);
  const archive=await manual.managementArchive(db,{},actors.manager);
  assert.equal(archive.total,2);
  assert.equal(archive.list.find(row=>row.resolutionId===first.resolutionId).fifoImpactState,'جایگزین‌شده');
});

test('canonical UI exposes one editable financial field and keeps technical scope collapsed',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  assert.match(source,/Review → Set Cost → Approve → FIFO Update/);
  assert.match(source,/مبلغ نهایی مورد تایید/);
  assert.match(source,/ItemCode \/ ItemGuid/);
  assert.match(source,/جزئیات فنی و ممیزی/);
  assert.match(source,/manual-cost-resolutions\/management\/review/);
  assert.match(source,/manual-cost-resolutions\/management\/approve/);
  assert.match(source,/manual-cost-resolutions\/management\/archive/);
  assert.doesNotMatch(source,/id="mcTargetQuantity"/);
  assert.doesNotMatch(source,/id="mcCommercialReference"/);
  assert.doesNotMatch(source,/id="mcFrom"/);
  assert.doesNotMatch(source,/id="mcTo"/);
});
