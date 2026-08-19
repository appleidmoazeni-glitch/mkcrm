'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryDb}=require('./helpers/memory-mongo');
const operational=require('../src/lib/accounting-operational-review');

const admin={username:'admin-1',role:'admin'};
const accountant={username:'accountant-1',role:'accounting'};
const manager={username:'manager-1',role:'manager'};
const seller={username:'seller-1',role:'seller'};

function seedDb(){
  return new MemoryDb({
    saleSnapshotState:[{scopeKey:'sale-type2|14050101|',activeSnapshotId:'SALE-ACTIVE',activatedAt:new Date()}],
    saleSnapshots:[{snapshotId:'SALE-ACTIVE',status:'completed',activationStatus:'active'}],
    saleSnapshotDatasetHeaders:[
      {snapshotId:'SALE-ACTIVE',invTyp:2,invNo:1,guId:'SALE-GUID-1'},
      {snapshotId:'SALE-ACTIVE',invTyp:6,invNo:2,guId:'RETURN-GUID-1'}
    ],
    saleSnapshotDatasetLines:[
      {snapshotId:'SALE-ACTIVE',saleLineId:'SL-2-1-1-A',saleInvoiceType:2,saleInvoiceNo:1,saleGuid:'SALE-GUID-1',saleDate:'14050101',row:1,itemGuid:'GUID-A',itemCode:'A',itemName:'A',qty:1,saleValue:1000,accountNumber:'CUSTOMER-1',sellerStoreName:'STORE-1',sellerAccountNumber:'SELLER-1'},
      {snapshotId:'SALE-ACTIVE',saleLineId:'SL-2-3-1-B',saleInvoiceType:2,saleInvoiceNo:3,saleGuid:'SALE-GUID-3',saleDate:'14050102',row:1,itemGuid:'GUID-B',itemCode:'B',itemName:'B',qty:3,saleValue:6000,accountNumber:'CUSTOMER-2',sellerStoreName:'STORE-2',sellerAccountNumber:'SELLER-2'},
      {snapshotId:'SALE-ACTIVE',saleLineId:'SL-6-2-1-A',saleInvoiceType:6,saleInvoiceNo:2,saleGuid:'RETURN-GUID-1',saleDate:'14050103',row:1,itemGuid:'GUID-A',itemCode:'A',itemName:'A',qty:2,saleValue:2000,accountNumber:'CUSTOMER-1',sellerStoreName:'STORE-1',sellerAccountNumber:'SELLER-1',generalRef:'SALE-GUID-1'}
    ],
    purchaseLayerDatasetState:[{scopeKey:'purchase-invoices-types-3-7',activeDatasetId:'PURCHASE-ACTIVE'}],
    purchaseLayerDatasets:[{datasetId:'PURCHASE-ACTIVE',status:'completed',activationStatus:'active'}],
    supplierPurchaseLayers:[
      {datasetId:'PURCHASE-ACTIVE',datasetSchemaVersion:1,purchaseLineIdentity:'PL-A',layerKind:'purchase',validationStatus:'valid',purchaseInvoiceDate:'14041220',purchaseInvoiceNo:10,supplierAccountNumber:'SUP-1',itemGuid:'GUID-A',itemCode:'A',originalQuantity:1,remainingQuantity:0,unitCostExact:'500.00'},
      {datasetId:'PURCHASE-ACTIVE',datasetSchemaVersion:1,purchaseLineIdentity:'PR-A',layerKind:'purchase-return',validationStatus:'valid',purchaseInvoiceDate:'14050103',purchaseInvoiceNo:11,supplierAccountNumber:'SUP-1',itemGuid:'GUID-A',itemCode:'A',originalQuantity:1}
    ],
    supplierPurchaseInvoices:[
      {invNo:20,guId:'PURCHASE-GUID-20',invDate:'14041210',invTyp:3,supplierAccountNo:'SUP-2',supplierName:'Supplier 2',items:[
        {row:1,itemCode:'B',itemName:'B',qty:5,unitCost:800,lineAmount:4000,raw:{LineItemId:200,ItemGuId:'GUID-B'}}
      ]}
    ],
    itemCatalogAll:[
      {itemCode:'C',itemGuid:'GUID-C-NEW',itemDescription:'Changed identity'}
    ],
    accountingCostEvidence:[
      {evidenceId:'E-A',sourceActive:true,sourceDatasetId:'FIFO-V2',priority:'P0',itemGuid:'GUID-A',itemCode:'A',itemDescription:'A',affectedSaleValue:1000,affectedQuantity:2,affectedSaleCount:1,firstSaleDate:'14050101',lastSaleDate:'14050103',status:'return_dependency'},
      {evidenceId:'E-B',sourceActive:true,sourceDatasetId:'FIFO-V2',priority:'P0',itemGuid:'GUID-B',itemCode:'B',itemDescription:'B',affectedSaleValue:6000,affectedQuantity:3,affectedSaleCount:1,firstSaleDate:'14050102',lastSaleDate:'14050102',status:'unreviewed'},
      {evidenceId:'E-C',sourceActive:true,sourceDatasetId:'FIFO-V2',priority:'P0',itemGuid:'GUID-C-OLD',itemCode:'C',itemDescription:'C',affectedSaleValue:500,affectedQuantity:1,affectedSaleCount:1,firstSaleDate:'14050102',lastSaleDate:'14050102',status:'unreviewed'}
    ],
    purchaseReturnResolutions:[{
      resolutionId:'PRET-1',sourcePurchaseDatasetId:'PURCHASE-ACTIVE',returnInvoiceIdentity:'7-11',returnLineIdentity:'PR-A',
      itemGuid:'GUID-A',itemCode:'A',supplierIdentity:'SUP-1',returnDate:'14050103',returnQuantity:1,
      candidatePurchaseLayers:[{purchaseLineIdentity:'PL-A',score:90}],status:'candidate_found',revision:1
    }],
    saleReturnResolutions:[{
      resolutionId:'SRET-1',sourceSaleSnapshotId:'SALE-ACTIVE',returnInvoiceIdentity:'6-2',returnLineIdentity:'SL-6-2-1-A',
      itemGuid:'GUID-A',itemCode:'A',customerIdentity:'CUSTOMER-1',store:'STORE-1',sellerIdentity:'SELLER-1',
      returnDate:'14050103',returnQuantity:2,explicitReference:'SALE-GUID-1',status:'unresolved',revision:1
    }],
    manualCostResolutions:[],
    accountingValidationSamples:[],
    fifoDatasetState:[{scopeKey:'fifo-shadow-v2-precision-evidence',activeDatasetId:'FIFO-V2'}],
    fifoDatasets:[{
      datasetId:'FIFO-V2',status:'completed',activationStatus:'validated-shadow',
      algorithmVersion:'fifo-shadow-v2-precision-evidence',sourceSaleSnapshotId:'SALE-ACTIVE',
      sourcePurchaseDatasetId:'PURCHASE-ACTIVE',deterministicReplayVerified:true,
      summary:{saleValue:7500},
      validation:{valid:true,duplicateAllocationCount:0,layerOverConsumptionCount:0,orphanLayerCount:0,inactiveSourceCount:0,monetaryReconciliationDifferenceExact:'0.00'}
    }],
    fifoAllocations:[
      {datasetId:'FIFO-V2',allocationId:'F-A',allocationSequence:1,saleLineId:'SL-2-1-1-A',saleInvoiceType:2,saleInvoiceNo:1,saleDate:'14050101',itemGuid:'GUID-A',itemCode:'A',sourceType:'official_purchase_layer',quantityExact:'1.000000',allocatedQty:1,unknownQty:0,allocatedSaleValueExact:'1000.00',allocatedCostAmountExact:'500.00',unitCostExact:'500.000000',purchaseLineIdentity:'PL-A'},
      {datasetId:'FIFO-V2',allocationId:'F-B',allocationSequence:1,saleLineId:'SL-2-3-1-B',saleInvoiceType:2,saleInvoiceNo:3,saleDate:'14050102',itemGuid:'GUID-B',itemCode:'B',sourceType:'unknown_cost',quantityExact:'3.000000',allocatedQty:0,unknownQty:3,allocatedSaleValueExact:'6000.00',allocatedCostAmountExact:null,unitCostExact:null}
    ],
    fifoExceptions:[],
    accountingEvidenceInvestigations:[],
    purchaseLayerRecoveryCandidates:[],
    accountingItemIdentityResolutions:[],
    accountingReturnReviewCases:[],
    manualCostEvidencePackages:[],
    accountingReviewBatches:[],
    users:[
      {username:'accountant-1',role:'accounting',isActive:true},
      {username:'manager-1',role:'manager',isActive:true}
    ]
  });
}

test('P0 evidence classifier keeps return, official, recovery, identity and unknown cases explicit',()=>{
  const maps={layerMap:new Map([['a',[{itemCode:'A'}]]]),invoiceMap:new Map([['b',[{itemCode:'B'}]]]),purchaseReturnMap:new Map(),saleReturnMap:new Map()};
  assert.equal(operational._classifyEvidence({itemCode:'A'},{...maps,identityCandidates:[]}).classification,'official_evidence_found');
  assert.equal(operational._classifyEvidence({itemCode:'B'},{...maps,identityCandidates:[]}).classification,'official_layer_rebuild_candidate');
  assert.equal(operational._classifyEvidence({itemCode:'C'},{...maps,identityCandidates:[{targetItemCode:'C2'}]}).classification,'item_identity_repair_candidate');
  assert.equal(operational._classifyEvidence({itemCode:'D'},{...maps,identityCandidates:[]}).classification,'insufficient_evidence');
});

test('synchronization investigates every P0 and writes only audit-owned collections',async()=>{
  const db=seedDb();
  const officialLayers=structuredClone(db.collection('supplierPurchaseLayers').rows);
  const saleLines=structuredClone(db.collection('saleSnapshotDatasetLines').rows);
  const invoices=structuredClone(db.collection('supplierPurchaseInvoices').rows);
  const result=await operational.synchronize(db,admin);
  assert.equal(result.investigations.total,3);
  assert.equal(db.collection(operational.INVESTIGATIONS).rows.length,3);
  assert.equal(db.collection(operational.RECOVERY).rows.length,1);
  assert.equal(db.collection(operational.IDENTITIES).rows.length,1);
  assert.equal(result.businessDocumentWrites,0);
  assert.equal(result.sourceCollectionWrites,0);
  assert.deepEqual(db.collection('supplierPurchaseLayers').rows,officialLayers);
  assert.deepEqual(db.collection('saleSnapshotDatasetLines').rows,saleLines);
  assert.deepEqual(db.collection('supplierPurchaseInvoices').rows,invoices);
});

test('official recovery candidate contains immutable invoice evidence and is never auto-approved',async()=>{
  const db=seedDb();await operational.synchronize(db,admin);
  const row=db.collection(operational.RECOVERY).rows[0];
  assert.equal(row.purchaseInvoiceIdentity,'3-20-PURCHASE-GUID-20');
  assert.equal(row.purchaseLineIdentity,'PURCHASE-GUID-20:200');
  assert.equal(row.unitCostExact,'800.000000');
  assert.equal(row.status,'detected');
  assert.equal(row.approvedBy,null);
});

test('identity candidate remains independent from catalog and requires human workflow',async()=>{
  const db=seedDb();const before=structuredClone(db.collection('itemCatalogAll').rows);
  await operational.synchronize(db,admin);
  const row=db.collection(operational.IDENTITIES).rows[0];
  assert.equal(row.sourceItemGuid,'GUID-C-OLD');
  assert.equal(row.targetItemGuid,'GUID-C-NEW');
  assert.equal(row.status,'detected');
  assert.deepEqual(db.collection('itemCatalogAll').rows,before);
});

test('purchase return candidate exposes item, supplier, quantity, date and remaining impact',async()=>{
  const db=seedDb();await operational.synchronize(db,admin);
  const row=db.collection(operational.RETURN_CASES).rows.find(value=>value.kind==='purchase');
  assert.equal(row.candidates[0].itemConsistent,true);
  assert.equal(row.candidates[0].supplierConsistent,true);
  assert.equal(row.candidates[0].quantityConsistent,true);
  assert.equal(row.reviewStatus,'prepared');
  assert.equal(db.collection('purchaseReturnResolutions').rows[0].status,'candidate_found');
});

test('sale return explicit linkage with excess quantity remains high confidence and proposes a bounded reversal',async()=>{
  const db=seedDb();await operational.synchronize(db,admin);
  const row=db.collection(operational.RETURN_CASES).rows.find(value=>value.kind==='sale');
  assert.equal(row.confidenceBand,'high_confidence');
  assert.equal(row.proposedLink,'SL-2-1-1-A');
  assert.equal(row.reversalProposal.proposedReversedQuantityExact,'1.000000');
  assert.equal(row.reversalProposal.proposedReversedCostExact,'500.00');
  assert.equal(row.reversalProposal.overAllocationPrevented,true);
  assert.equal(db.collection('saleReturnResolutions').rows[0].status,'unresolved');
});

test('sale return is deterministic only when one exact compatible candidate exists',async()=>{
  const db=seedDb();
  db.collection('saleReturnResolutions').rows[0].returnQuantity=1;
  db.collection('saleSnapshotDatasetLines').rows.find(row=>row.saleInvoiceType===6).qty=1;
  await operational.synchronize(db,admin);
  const row=db.collection(operational.RETURN_CASES).rows.find(value=>value.kind==='sale');
  assert.equal(row.deterministicCandidateCount,1);
  assert.equal(row.confidenceBand,'deterministic');
  assert.ok(row.confidence<=100);
});

test('manual cost evidence package rejects missing amount and accepts only an explicit documented draft',async()=>{
  const db=seedDb();await operational.synchronize(db,admin);
  await assert.rejects(
    operational.createManualPackage(db,{evidenceId:'E-C',documentedSource:'supplier-statement',evidenceReference:'DOC-1'},accountant),
    error=>error.code==='MANUAL_PACKAGE_AMOUNT_REQUIRED'
  );
  const result=await operational.createManualPackage(db,{
    evidenceId:'E-C',sourceAmount:'951860416.64',documentedSource:'supplier-statement',
    evidenceReference:'DOC-1',officialEvidenceUnavailableReason:'no official importable invoice'
  },accountant);
  assert.equal(result.package.sourceAmountExact,'951860416.64');
  assert.equal(result.package.status,'draft');
  assert.equal(result.automaticApproval,false);
  assert.equal(result.manualCostResolutionCreated,false);
  assert.equal(db.collection('manualCostResolutions').rows.length,0);
});

test('review batch preserves item-level references and completion implies no approval',async()=>{
  const db=seedDb();await operational.synchronize(db,admin);
  const created=await operational.createBatch(db,{
    title:'Human review',batchKey:'human-1',recordIds:['E-A','SRET-1'],
    assignedAccountingUser:'accountant-1',assignedManagerUser:'manager-1'
  },accountant);
  assert.equal(created.batch.status,'prepared');
  const completed=await operational.transitionBatch(db,created.batch.batchId,{status:'completed',revision:1,note:'session ended'},manager);
  assert.equal(completed.batch.status,'completed');
  assert.equal(completed.itemApprovalsImplied,false);
  assert.equal(db.collection('saleReturnResolutions').rows[0].status,'unresolved');
});

test('stale revision and creator self approval are rejected',async()=>{
  const db=seedDb();await operational.synchronize(db,accountant);
  const recovery=db.collection(operational.RECOVERY).rows[0];
  await operational.transitionReview(db,'recovery',recovery.candidateId,{status:'pending_accounting_review',revision:1,reason:'inspect'},manager);
  await assert.rejects(
    operational.transitionReview(db,'recovery',recovery.candidateId,{status:'evidence_verified',revision:1},manager),
    error=>error.code==='ACCOUNTING_REVIEW_CONFLICT'
  );
  await assert.rejects(
    operational.transitionReview(db,'recovery',recovery.candidateId,{status:'approved_for_dataset_rebuild',revision:2,reason:'ok',evidenceReference:'DOC'},accountant),
    error=>error.code==='ACCOUNTING_REVIEW_SELF_APPROVAL'
  );
});

test('seller cannot synchronize, transition, package or batch accounting review work',async()=>{
  const db=seedDb();
  await assert.rejects(operational.synchronize(db,seller),error=>error.code==='ACCOUNTING_REVIEW_FORBIDDEN');
  await assert.rejects(operational.createManualPackage(db,{},seller),error=>error.code==='ACCOUNTING_REVIEW_FORBIDDEN');
  await assert.rejects(operational.createBatch(db,{},seller),error=>error.code==='ACCOUNTING_REVIEW_FORBIDDEN');
});

test('validation package prepares required invoice and return categories without human confirmation',async()=>{
  const db=seedDb();await operational.synchronize(db,admin);
  const samples=db.collection('accountingValidationSamples').rows;
  assert.ok(samples.some(row=>row.category==='operational_highest_value_fully_allocated'));
  assert.ok(samples.some(row=>row.category==='operational_sale_return'));
  assert.ok(samples.some(row=>row.category==='operational_purchase_return'));
  assert.ok(samples.every(row=>row.reviewStatus==='not_reviewed'));
});

test('impact report separates actual approvals from projected candidates and preserves gate thresholds',async()=>{
  const db=seedDb();await operational.synchronize(db,admin);
  const report=await operational.impactReport(db);
  assert.equal(report.actualApproved.recoveryCandidates,0);
  assert.equal(report.actualApproved.returnLinks,0);
  assert.ok(report.projected.p0ValueUnderReview>0);
  assert.equal(report.projected.recoverableUnknownValue,6500);
  assert.equal(report.gate.thresholds.unknownSaleValueMaximumPercent,5);
  assert.equal(report.gate.thresholds.returnLinkageMinimumPercent,95);
  assert.equal(report.gate.thresholds.accountingSampleMinimumReviewed,30);
  assert.equal(report.safeguards.profitCalculated,false);
  assert.equal(report.safeguards.importImplemented,false);
});

test('safe export carries immutable IDs and revisions but cannot import decisions',async()=>{
  const db=seedDb();await operational.synchronize(db,admin);
  const output=await operational.exportReview(db,{priority:'P0'});
  assert.equal(output.decisionImportAllowed,false);
  assert.deepEqual(output.immutableColumns,['investigationId','evidenceId','sourceFifoDatasetId','revision']);
  assert.equal(output.rows.length,3);
  assert.ok(output.rows.every(row=>row.investigationId&&row.evidenceId&&row.revision===1));
});

test('source contracts contain no invoice issuance, Shaygan write, direct layer update or profit activation',()=>{
  const root=path.join(__dirname,'..');
  const source=fs.readFileSync(path.join(root,'src/lib/accounting-operational-review.js'),'utf8');
  const server=fs.readFileSync(path.join(root,'src/server.js'),'utf8');
  const ui=fs.readFileSync(path.join(root,'public/assets/app.js'),'utf8');
  assert.doesNotMatch(source,/PutSaleInvoice|PutBuyInvoice|Invoice\s*\/\s*Put|shaygan\.|issueSale|issuePurchase/i);
  assert.doesNotMatch(source,/collection\(['"]supplierPurchaseLayers['"]\)\.update|collection\(['"]saleInvoiceLines['"]\)\.update/i);
  assert.match(server,/\/api\/accounting\/operational-review\/synchronize/);
  assert.match(server,/X-Accounting-Decision-Import/);
  assert.match(ui,/HUMAN ACCOUNTING REVIEW REQUIRED/);
  const sellerPages=ui.match(/seller:\s*\[([^\]]*)\]/)?.[1]||'';
  assert.doesNotMatch(sellerPages,/accounting-review-workbench/);
});
