'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryDb } = require('./helpers/memory-mongo');
const ledger = require('../src/lib/profit-commission-ledger');

const accountant={username:'accountant-1',role:'accounting'};
const manager={username:'manager-1',role:'manager'};
const admin={username:'admin-1',role:'admin'};
const seller={username:'seller-1',role:'seller'};

function seedDb(){
  return new MemoryDb({
    fifoDatasetState:[{scopeKey:'fifo-shadow-v2-precision-evidence',activeDatasetId:'FIFO-APPROVED'}],
    fifoDatasets:[{datasetId:'FIFO-APPROVED',status:'completed',activationStatus:'validated-shadow',algorithmVersion:'fifo-shadow-v2-precision-evidence',sourceSaleSnapshotId:'SALE-1',sourceFingerprint:'SOURCE-FP',allocationFingerprint:'ALLOC-FP',validation:{valid:true}}],
    fifoAllocations:[
      {datasetId:'FIFO-APPROVED',allocationId:'A1',globalSequence:1,saleLineId:'SL-2-4691-001-NB',saleInvoiceType:2,saleInvoiceNo:4691,saleDate:'14050410',sellerAccountNumber:'11701013',sellerName:'Seller A',itemGuid:'GUID-NB',itemCode:'NB-1',itemDescription:'Notebook',sourceType:'official_purchase_layer',soldQuantity:2,quantityExact:'1.000000',allocatedQty:1,unknownQty:0,allocatedSaleValueExact:'600.00',allocatedCostAmountExact:'400.00'},
      {datasetId:'FIFO-APPROVED',allocationId:'A2',globalSequence:2,saleLineId:'SL-2-4691-001-NB',saleInvoiceType:2,saleInvoiceNo:4691,saleDate:'14050410',sellerAccountNumber:'11701013',sellerName:'Seller A',itemGuid:'GUID-NB',itemCode:'NB-1',itemDescription:'Notebook',sourceType:'official_purchase_layer',soldQuantity:2,quantityExact:'1.000000',allocatedQty:1,unknownQty:0,allocatedSaleValueExact:'600.00',allocatedCostAmountExact:'500.00'},
      {datasetId:'FIFO-APPROVED',allocationId:'A3',globalSequence:3,saleLineId:'SL-2-5000-001-CP',saleInvoiceType:2,saleInvoiceNo:5000,saleDate:'14050411',sellerAccountNumber:'11701013',sellerName:'Seller A',itemGuid:'GUID-CP',itemCode:'CP-1',itemDescription:'Component',sourceType:'official_purchase_layer',soldQuantity:1,quantityExact:'1.000000',allocatedQty:1,unknownQty:0,allocatedSaleValueExact:'700.00',allocatedCostAmountExact:'500.00'},
      {datasetId:'FIFO-APPROVED',allocationId:'A4',globalSequence:4,saleLineId:'SL-2-5001-001-X',saleInvoiceType:2,saleInvoiceNo:5001,saleDate:'14050412',sellerAccountNumber:'11701013',sellerName:'Seller A',itemGuid:'GUID-X',itemCode:'X-1',itemDescription:'Unknown',sourceType:'unknown_cost',soldQuantity:1,quantityExact:'1.000000',allocatedQty:0,unknownQty:1,allocatedSaleValueExact:'100.00',allocatedCostAmountExact:null}
    ],
    saleSnapshotDatasetLines:[
      {snapshotId:'SALE-1',saleLineId:'SL-2-4691-001-NB',saleInvoiceType:2,saleInvoiceNo:4691,saleDate:'14050410',itemGuid:'GUID-NB',itemCode:'NB-1',mainGroupCode:'NB',lineDiscountAmount:10,sellerAccountNumber:'11701013'},
      {snapshotId:'SALE-1',saleLineId:'SL-2-5000-001-CP',saleInvoiceType:2,saleInvoiceNo:5000,saleDate:'14050411',itemGuid:'GUID-CP',itemCode:'CP-1',mainGroupCode:'CP',lineDiscountAmount:null,sellerAccountNumber:'11701013'},
      {snapshotId:'SALE-1',saleLineId:'SL-2-5001-001-X',saleInvoiceType:2,saleInvoiceNo:5001,saleDate:'14050412',itemGuid:'GUID-X',itemCode:'X-1',mainGroupCode:'X',lineDiscountAmount:null,sellerAccountNumber:'11701013'}
    ],
    saleSnapshotDatasetHeaders:[
      {snapshotId:'SALE-1',invTyp:2,invNo:4691,sellerAccountNumber:'11701013',discountAmount:10},
      {snapshotId:'SALE-1',invTyp:2,invNo:5000,sellerAccountNumber:'11701013',discountAmount:20},
      {snapshotId:'SALE-1',invTyp:2,invNo:5001,sellerAccountNumber:'11701013',discountAmount:0}
    ],
    commissionCategoryMappings:[
      {mappingId:'MAP-NB',identityType:'itemGuid',identityValue:'GUID-NB',commissionCategory:'NOTEBOOK',effectiveFrom:'14050101',effectiveTo:'',status:'approved'},
      {mappingId:'MAP-CP',identityType:'itemGuid',identityValue:'GUID-CP',commissionCategory:'COMPONENT',effectiveFrom:'14050101',effectiveTo:'',status:'approved'}
    ],
    commissionRateVersions:[
      {rateVersionId:'RATE-NB',policyVersionId:'POLICY-1',sellerIdentity:'11701013',commissionCategory:'NOTEBOOK',effectiveFrom:'14050401',effectiveTo:'14050431',rate:'0.14000000',status:'approved'},
      {rateVersionId:'RATE-CP',policyVersionId:'POLICY-1',sellerIdentity:'11701013',commissionCategory:'COMPONENT',effectiveFrom:'14050401',effectiveTo:'14050431',rate:'0.20000000',status:'approved'}
    ],
    commissionPolicyVersions:[{policyVersionId:'POLICY-1',name:'Tir governed policy',accountingPeriod:'140504',effectiveFrom:'14050401',effectiveTo:'14050531',status:'approved',revision:3,createdBy:{username:'policy-owner',role:'accounting'},approvedBy:manager}],
    accountingOfficialGroupCatalogRuns:[{catalogRunId:'RUN-OFFICIAL',fetchedAt:new Date('2026-08-01T00:00:00Z')}],
    accountingOfficialItemGroups:[
      {catalogRunId:'RUN-OFFICIAL',groupIdentity:'guid:MAIN-NB',sourceGroupGuid:'MAIN-NB',groupNumber:'1',groupName:'NOTEBOOK',resolvedMainGroupIdentity:'guid:MAIN-NB',resolvedMainGroupGuid:'MAIN-NB',resolvedMainGroupNumber:'1',resolvedMainGroupName:'NOTEBOOK'},
      {catalogRunId:'RUN-OFFICIAL',groupIdentity:'guid:MAIN-CPU',sourceGroupGuid:'MAIN-CPU',groupNumber:'84',groupName:'CPU',resolvedMainGroupIdentity:'guid:MAIN-CPU',resolvedMainGroupGuid:'MAIN-CPU',resolvedMainGroupNumber:'84',resolvedMainGroupName:'CPU'},
      {catalogRunId:'RUN-OFFICIAL',groupIdentity:'guid:MAIN-OTHER',sourceGroupGuid:'MAIN-OTHER',groupNumber:'99',groupName:'OTHER',resolvedMainGroupIdentity:'guid:MAIN-OTHER',resolvedMainGroupGuid:'MAIN-OTHER',resolvedMainGroupNumber:'99',resolvedMainGroupName:'OTHER'}
    ],
    accountingOfficialItemGroupAssignments:[
      {catalogRunId:'RUN-OFFICIAL',itemGuid:'GUID-NB',itemCode:'NB-1',isOfficialEvidence:true,resolvedMainGroupIdentity:'guid:MAIN-NB',resolvedMainGroupGuid:'MAIN-NB',resolvedMainGroupNumber:'1',resolvedMainGroupName:'NOTEBOOK'},
      {catalogRunId:'RUN-OFFICIAL',itemGuid:'GUID-CP',itemCode:'CP-1',isOfficialEvidence:true,resolvedMainGroupIdentity:'guid:MAIN-CPU',resolvedMainGroupGuid:'MAIN-CPU',resolvedMainGroupNumber:'84',resolvedMainGroupName:'CPU'},
      {catalogRunId:'RUN-OFFICIAL',itemGuid:'GUID-X',itemCode:'X-1',isOfficialEvidence:true,resolvedMainGroupIdentity:'guid:MAIN-OTHER',resolvedMainGroupGuid:'MAIN-OTHER',resolvedMainGroupNumber:'99',resolvedMainGroupName:'OTHER'}
    ]
  });
}

async function materialized(){const db=seedDb();const result=await ledger.materializeFifoProfitFacts(db,{},accountant);return{db,result};}

test('immutable FIFO facts aggregate partial allocations and keep unknown cost null',async()=>{
  const{db,result}=await materialized();assert.equal(result.factCount,3);
  const fact=db.collection(ledger.FIFO_FACTS).rows.find(row=>row.saleLineIdentity==='SL-2-4691-001-NB');
  assert.equal(fact.quantityExact,'2.000000');assert.equal(fact.saleAmountExact,'1200.00');assert.equal(fact.fifoCostExact,'900.00');assert.equal(fact.actualFifoProfitExact,'300.00');assert.equal(fact.costCoverageStatus,'complete');assert.equal(fact.profitProvenanceStatus,'PROVEN');assert.equal(fact.costSourceType,'MULTI_PURCHASE_LAYER');assert.equal(fact.provenanceSources.length,2);assert.equal(fact.provenanceReconciliation.moneyConserved,true);assert.equal(fact.invoiceDiscountExact,'10.00');assert.equal(fact.officialProductCategoryName,'NOTEBOOK');assert.equal(fact.commissionRatePool,'NOTEBOOK');
  const unknown=db.collection(ledger.FIFO_FACTS).rows.find(row=>row.itemCode==='X-1');assert.equal(unknown.fifoCostExact,null);assert.equal(unknown.actualFifoProfitExact,null);assert.equal(unknown.costCoverageStatus,'unknown');assert.equal(unknown.profitProvenanceStatus,'UNKNOWN');assert.equal(unknown.provenanceSources[0].sourceType,'UNKNOWN');
  const replay=await ledger.materializeFifoProfitFacts(db,{},accountant);assert.equal(replay.duplicate,true);assert.equal(replay.factsFingerprint,result.factsFingerprint);assert.equal(db.collection(ledger.FIFO_FACTS).rows.length,3);
});

test('saved-profit credit preserves company FIFO profit and changes only commissionable profit',async()=>{
  const{db}=await materialized();
  const created=await ledger.createAdjustment(db,{fifoDatasetId:'FIFO-APPROVED',saleLineIdentity:'SL-2-4691-001-NB',adjustmentType:'saved_profit_credit',categoryPool:'NOTEBOOK',proposedAmountExact:'100',effectivePeriod:'140504',reasonCode:'HIGH_PROFIT',reasonText:'management decision'},accountant);
  const submitted=await ledger.transitionAdjustment(db,created.adjustment.adjustmentId,'submit',{revision:1},accountant);
  const approved=await ledger.transitionAdjustment(db,created.adjustment.adjustmentId,'approve',{revision:submitted.adjustment.revision,approvedAmountExact:'100'},manager);
  assert.equal(approved.actualFifoProfitChanged,false);assert.equal(approved.companyProfitChanged,false);assert.equal(approved.ledgerEntry.creditAmountExact,'100.00');assert.equal((await ledger.savedBalance(db,'NOTEBOOK')).balanceExact,'100.00');
  const fact=db.collection(ledger.FIFO_FACTS).rows.find(row=>row.saleLineIdentity==='SL-2-4691-001-NB');assert.equal(fact.actualFifoProfitExact,'300.00');
  const draft=await ledger.calculateDraftCommission(db,{fifoDatasetId:'FIFO-APPROVED',periodFrom:'14050401',periodTo:'14050431'},accountant);const line=db.collection(ledger.COMMISSION_LINES).rows.find(row=>row.saleLineIdentity===fact.saleLineIdentity);assert.equal(line.actualFifoProfitExact,'300.00');assert.equal(line.commissionableProfitExact,'200.00');assert.equal(line.draftCommissionExact,'28.00');assert.equal(draft.payable,false);
});

test('subsidy debits only matching pool, cross-pool and insufficient reserve are rejected',async()=>{
  const{db}=await materialized();
  async function approve(input){const c=await ledger.createAdjustment(db,input,accountant);const s=await ledger.transitionAdjustment(db,c.adjustment.adjustmentId,'submit',{revision:1},accountant);return ledger.transitionAdjustment(db,c.adjustment.adjustmentId,'approve',{revision:s.adjustment.revision},manager);}
  await approve({fifoDatasetId:'FIFO-APPROVED',saleLineIdentity:'SL-2-4691-001-NB',adjustmentType:'saved_profit_credit',categoryPool:'NOTEBOOK',proposedAmountExact:'150',effectivePeriod:'140504'});
  const subsidy=await approve({fifoDatasetId:'FIFO-APPROVED',saleLineIdentity:'SL-2-4691-001-NB',adjustmentType:'saved_profit_subsidy',categoryPool:'NOTEBOOK',proposedAmountExact:'40',effectivePeriod:'140504'});assert.equal(subsidy.ledgerEntry.debitAmountExact,'40.00');assert.equal((await ledger.savedBalance(db,'NOTEBOOK')).balanceExact,'110.00');assert.equal((await ledger.savedBalance(db,'COMPONENT')).balanceExact,'0.00');
  await assert.rejects(approve({fifoDatasetId:'FIFO-APPROVED',saleLineIdentity:'SL-2-5000-001-CP',adjustmentType:'saved_profit_subsidy',categoryPool:'COMPONENT',proposedAmountExact:'1',effectivePeriod:'140504'}),e=>e.code==='SAVED_POOL_INSUFFICIENT');
  await assert.rejects(ledger.createAdjustment(db,{fifoDatasetId:'FIFO-APPROVED',saleLineIdentity:'SL-2-4691-001-NB',adjustmentType:'saved_profit_credit',categoryPool:'OTHER',proposedAmountExact:'1',effectivePeriod:'140504'},accountant),e=>e.code==='ADJUSTMENT_POOL_REQUIRED');
});

test('adjustment workflow enforces creator separation, optimistic revision and append-only reversal',async()=>{
  const{db}=await materialized();const c=await ledger.createAdjustment(db,{fifoDatasetId:'FIFO-APPROVED',saleLineIdentity:'SL-2-4691-001-NB',adjustmentType:'saved_profit_credit',categoryPool:'NOTEBOOK',proposedAmountExact:'50',effectivePeriod:'140504'},accountant);
  await assert.rejects(ledger.updateAdjustmentDraft(db,c.adjustment.adjustmentId,{...c.adjustment,revision:99},accountant),e=>e.code==='ADJUSTMENT_CONFLICT');const s=await ledger.transitionAdjustment(db,c.adjustment.adjustmentId,'submit',{revision:1},accountant);await assert.rejects(ledger.transitionAdjustment(db,c.adjustment.adjustmentId,'approve',{revision:2},accountant),e=>e.code==='PROFIT_LEDGER_FORBIDDEN');const a=await ledger.transitionAdjustment(db,c.adjustment.adjustmentId,'approve',{revision:s.adjustment.revision},manager);const reversed=await ledger.reverseAdjustment(db,c.adjustment.adjustmentId,{revision:a.adjustment.revision,reason:'void'},manager);assert.equal(reversed.adjustment.status,'reversed');assert.equal(db.collection(ledger.SAVED_LEDGER).rows.length,2);assert.equal((await ledger.savedBalance(db,'NOTEBOOK')).balanceExact,'0.00');
});

test('legacy generic adjustment cannot bypass the dedicated opening-balance workflow',async()=>{
  const db=seedDb();await assert.rejects(ledger.createAdjustment(db,{adjustmentType:'management_adjustment',sourceType:'opening_balance',categoryPool:'COMPONENT',proposedAmountExact:'500',effectivePeriod:'140503',reasonCode:'OPENING_EVIDENCE',sourceReference:'MGMT-PACKET-1'},accountant),error=>error.code==='OPENING_BALANCE_DEDICATED_WORKFLOW_REQUIRED');assert.equal(db.collection(ledger.SAVED_LEDGER).rows.length,0);
});

test('approved rate overlap is rejected and missing/exceptional resolution stays explicit',async()=>{
  const db=seedDb();const created=await ledger.createRateVersion(db,{policyVersionId:'POLICY-1',sellerIdentity:'11701013',commissionCategory:'NOTEBOOK',effectiveFrom:'14050415',effectiveTo:'14050501',rate:'0.15',sourceReference:'contract',reason:'contract evidence',evidenceMetadata:{document:'contract'}},accountant);const submitted=await ledger.transitionRateVersion(db,created.rateVersion.rateVersionId,'submit',{revision:1,reason:'contract evidence',sourceReference:'contract',evidenceMetadata:{document:'contract'}},accountant);await assert.rejects(ledger.approveRateVersion(db,created.rateVersion.rateVersionId,{revision:submitted.rateVersion.revision,reason:'reviewed',sourceReference:'contract',evidenceMetadata:{document:'contract'}},manager),e=>e.code==='RATE_OVERLAP');const missing=await ledger.resolveRate(db,'OTHER','NOTEBOOK','14050410');assert.equal(missing.status,'missing');const resolved=await ledger.resolveRate(db,'11701013','NOTEBOOK','14050410');assert.equal(resolved.rateVersion.rate,'0.14000000');
});

test('missing rates keep draft commission unavailable and total null rather than zero',async()=>{
  const db=seedDb();db.collection(ledger.RATE_VERSIONS).rows=[];await ledger.materializeFifoProfitFacts(db,{},accountant);const result=await ledger.calculateDraftCommission(db,{fifoDatasetId:'FIFO-APPROVED',periodFrom:'14050401',periodTo:'14050431'},accountant);const knownCostLines=db.collection(ledger.COMMISSION_LINES).rows.filter(row=>row.actualFifoProfitExact!=null);assert.equal(knownCostLines.length,2);assert.equal(knownCostLines.every(row=>row.status==='unavailable'&&row.draftCommissionExact===null),true);assert.equal(knownCostLines.some(row=>row.unavailableReason==='rate-missing'),true);assert.equal(result.totals.draftCommissionExact,null);
});

test('rate approval is serialized per seller and category',async()=>{
  const db=seedDb();const created=await ledger.createRateVersion(db,{policyVersionId:'POLICY-1',sellerIdentity:'OTHER',commissionRatePool:'NOTEBOOK',effectiveFrom:'14050401',effectiveTo:'14050431',rate:'0.15',sourceReference:'contract',reason:'contract evidence',evidenceMetadata:{document:'contract'}},accountant);const submitted=await ledger.transitionRateVersion(db,created.rateVersion.rateVersionId,'submit',{revision:1,reason:'contract evidence',sourceReference:'contract',evidenceMetadata:{document:'contract'}},accountant);db.collection(ledger.RATE_APPROVAL_LOCKS).rows.push({lockKey:'OTHER|rate_pool|NOTEBOOK',owner:'another-manager',expiresAt:new Date(Date.now()+10000)});await assert.rejects(ledger.approveRateVersion(db,created.rateVersion.rateVersionId,{revision:submitted.rateVersion.revision,reason:'reviewed',sourceReference:'contract',evidenceMetadata:{document:'contract'}},manager),e=>e.code==='RATE_APPROVAL_LOCKED');assert.equal(db.collection(ledger.RATE_VERSIONS).rows.find(row=>row.rateVersionId===created.rateVersion.rateVersionId).status,'pending');
});

test('invoice discounts come from official snapshot and multi-category attribution is unresolved',async()=>{
  const db=seedDb();const result=await ledger.extractInvoiceDiscountFacts(db,{saleSnapshotId:'SALE-1'},accountant);assert.equal(result.created,3);const resolved=db.collection(ledger.DISCOUNT_FACTS).rows.find(row=>row.saleInvoiceIdentity==='2:4691');assert.equal(resolved.invoiceDiscountExact,'10.00');assert.equal(resolved.sourceField,'DiscAmount/DiscountAmount');const unresolved=db.collection(ledger.DISCOUNT_FACTS).rows.find(row=>row.saleInvoiceIdentity==='2:5000');assert.equal(unresolved.categoryAttributionStatus,'resolved-single-category');
  db.collection('saleSnapshotDatasetLines').rows.push({snapshotId:'SALE-1',saleLineId:'SL-X',saleInvoiceType:2,saleInvoiceNo:5000,saleDate:'14050411',itemGuid:'UNKNOWN',itemCode:'UNKNOWN'});const db2=seedDb();db2.collection('saleSnapshotDatasetLines').rows.push({snapshotId:'SALE-1',saleLineId:'SL-X',saleInvoiceType:2,saleInvoiceNo:5000,saleDate:'14050411',itemGuid:'UNKNOWN',itemCode:'UNKNOWN'});await ledger.extractInvoiceDiscountFacts(db2,{saleSnapshotId:'SALE-1'},accountant);assert.equal(db2.collection(ledger.DISCOUNT_FACTS).rows.find(row=>row.saleInvoiceIdentity==='2:5000').categoryAttributionStatus,'unresolved-multi-category');
});

test('diagnostic Excel export is admin-only, clearly incomplete, and imports pending adjustments only',async()=>{
  const{db}=await materialized();const exported=await ledger.createExcelExport(db,{fifoDatasetId:'FIFO-APPROVED',exportMode:'diagnostic',reason:'controlled diagnostic',sourceReference:'TEST-EVIDENCE',evidenceUnavailableReason:'automated fixture'},admin);assert.equal(exported.content.includes('actualFifoProfitExact'),true);assert.equal(exported.content.includes('officialProductCategoryName'),true);assert.equal(exported.content.includes('commissionRatePool'),true);assert.equal(exported.content.includes('rateResolutionPrecedence'),true);assert.equal(exported.content.includes('INCOMPLETE DIAGNOSTIC ONLY'),true);assert.equal(exported.payable,false);assert.match(exported.filename,/\.xml$/);const batch=db.collection(ledger.EXPORT_BATCHES).rows[0];const original=batch.rows[0];assert.equal(original.officialProductCategoryName,'NOTEBOOK');assert.equal(original.commissionRatePool,'NOTEBOOK');assert.equal(original.commissionRateVersionId,'RATE-NB');const edited={...original,proposedAdjustmentAmountExact:'25',adjustmentType:'saved_profit_credit',proposedSavedProfitPool:'NOTEBOOK',reasonCode:'REVIEW',reasonText:'reviewed',originalExcelRowNumber:2};const imported=await ledger.importExcelEdits(db,{exportBatchId:batch.exportBatchId,sourceWorkbookHash:batch.sourceWorkbookHash,effectivePeriod:'140504',rows:[edited]},accountant);assert.equal(imported.pendingAdjustmentsCreated,1);assert.equal(imported.approvedAdjustmentsCreated,0);assert.equal(db.collection(ledger.ADJUSTMENTS).rows[0].status,'pending');assert.equal(imported.fifoFactsChanged,0);await assert.rejects(ledger.importExcelEdits(db,{exportBatchId:batch.exportBatchId,sourceWorkbookHash:batch.sourceWorkbookHash,effectivePeriod:'140504',rows:[edited]},accountant),e=>e.code==='EXCEL_IMPORT_DUPLICATE');
});

test('legacy exported workbooks retain their original immutable-field contract on import',async()=>{
  const{db}=await materialized();const fields=ledger.LEGACY_IMMUTABLE_EXPORT_FIELDS;const row={exportBatchId:'LEGACY-EXPORT',rowId:'LEGACY-ROW',fifoDatasetId:'FIFO-APPROVED',fifoAlgorithmVersion:'fifo-shadow-v2-precision-evidence',saleInvoiceIdentity:'2:4691',saleLineIdentity:'SL-2-4691-001-NB',itemGuid:'GUID-NB',itemCode:'NB-1',sellerIdentity:'11701013',commissionCategory:'NOTEBOOK',quantityExact:'2.000000',saleAmountExact:'1200.00',invoiceDiscountExact:'10.00',fifoCostExact:'900.00',actualFifoProfitExact:'300.00',costCoverageStatus:'complete',currentApprovedAdjustmentsExact:'0.00',savedProfitPool:'NOTEBOOK',commissionRateVersionId:'RATE-NB'};row.integrityHash=ledger._sha256(ledger._stable(ledger._immutableExportProjection(row,fields)));const hash='a'.repeat(64);db.collection(ledger.EXPORT_BATCHES).rows.push({exportBatchId:'LEGACY-EXPORT',sourceWorkbookHash:hash,immutableFields:fields,rows:[row]});const edited={...row,proposedAdjustmentAmountExact:'5',adjustmentType:'saved_profit_credit',proposedSavedProfitPool:'NOTEBOOK',reasonCode:'LEGACY',reasonText:'legacy workbook import',originalExcelRowNumber:2};const result=await ledger.importExcelEdits(db,{exportBatchId:'LEGACY-EXPORT',sourceWorkbookHash:hash,effectivePeriod:'140504',rows:[edited]},accountant);assert.equal(result.pendingAdjustmentsCreated,1);assert.equal(result.import.rejectedCount,0);
});

test('Excel altered identity and formula errors reject affected rows',async()=>{
  const{db}=await materialized();await ledger.createExcelExport(db,{fifoDatasetId:'FIFO-APPROVED',exportMode:'diagnostic',reason:'controlled diagnostic',sourceReference:'TEST-EVIDENCE',evidenceUnavailableReason:'automated fixture'},admin);const batch=db.collection(ledger.EXPORT_BATCHES).rows[0];const [one,two]=batch.rows;const result=await ledger.importExcelEdits(db,{exportBatchId:batch.exportBatchId,sourceWorkbookHash:batch.sourceWorkbookHash,effectivePeriod:'140504',rows:[{...one,itemCode:'ALTERED',proposedAdjustmentAmountExact:'1',adjustmentType:'saved_profit_credit',proposedSavedProfitPool:'NOTEBOOK'},{...two,proposedAdjustmentAmountExact:'#VALUE!',adjustmentType:'saved_profit_credit',proposedSavedProfitPool:'COMPONENT'}]},accountant);assert.equal(result.import.rejectedCount,2);assert.equal(result.rows[0].code,'IMMUTABLE_FIELD_CHANGED');assert.equal(result.rows[1].code,'FORMULA_ERROR');assert.equal(db.collection(ledger.ADJUSTMENTS).rows.length,0);
});

test('Tir reconstruction excludes four confirmed transfer errors from rule inference',async()=>{
  const{db}=await materialized();const preview=await ledger.readTirReconstruction(db,{},accountant);assert.equal(preview.readOnly,true);assert.equal(db.collection(ledger.TIR_RECONSTRUCTION).rows.length,0);const report=await ledger.buildTirReconstruction(db,{},accountant);const errors=report.issues.filter(row=>row.classification==='confirmed_accounting_transfer_error');assert.equal(errors.length,4);assert.equal(errors.every(row=>row.excludedFromRuleInference),true);assert.deepEqual(errors.map(row=>`${row.invoiceNumber}/${row.lineNumber}`).sort(),['3917/1502','4031/483','4079/51','4691/2357']);assert.equal(report.comparisonDimensions.length,6);
});

test('seller is denied and module/source contracts prohibit invoices, inventory and Shaygan writes',async()=>{
  const db=seedDb();await assert.rejects(ledger.materializeFifoProfitFacts(db,{},seller),e=>e.code==='PROFIT_LEDGER_FORBIDDEN');const source=fs.readFileSync(path.join(__dirname,'../src/lib/profit-commission-ledger.js'),'utf8');for(const forbidden of ['PutSaleInvoice','PutBuyInvoice','supplierPurchaseLayers.update','saleSnapshotDatasetLines.update','inventory.update'])assert.equal(source.includes(forbidden),false,forbidden);const health=await ledger.health(db);assert.equal(health.safety.shayganWrites,0);assert.equal(health.safety.inventoryWrites,0);assert.equal(health.safety.payrollEnabled,false);
});

test('deterministic draft recalculation pins facts, rates and adjustments without seller/payroll activation',async()=>{
  const projection=({_id,commissionRunId,commissionLineId,createdAt,...row})=>row;
  const{db}=await materialized();const first=await ledger.calculateDraftCommission(db,{fifoDatasetId:'FIFO-APPROVED',periodFrom:'14050401',periodTo:'14050431'},accountant);const firstLines=db.collection(ledger.COMMISSION_LINES).rows.filter(row=>row.commissionRunId===first.run.commissionRunId).map(projection);const second=await ledger.calculateDraftCommission(db,{fifoDatasetId:'FIFO-APPROVED',periodFrom:'14050401',periodTo:'14050431'},accountant);const secondLines=db.collection(ledger.COMMISSION_LINES).rows.filter(row=>row.commissionRunId===second.run.commissionRunId).map(projection);assert.deepEqual(firstLines,secondLines);assert.equal(first.run.nonPayable,true);assert.equal(first.run.sellerFacing,false);assert.equal(first.run.payrollApproved,false);assert.equal(first.run.unavailableLineCount,2);
});

test('later approved pool mapping resolves without mutating the historical official Product Category fact',async()=>{
  const{db}=await materialized();const fact=db.collection(ledger.FIFO_FACTS).rows.find(row=>row.itemCode==='X-1');assert.equal(fact.officialProductCategoryName,'OTHER');assert.equal(fact.commissionRatePool,'UNRESOLVED');db.collection(ledger.CATEGORY_MAPPINGS).rows.push({mappingId:'MAP-X',schemaVersion:2,identityType:'itemGuid',identityValue:'GUID-X',officialProductCategoryIdentity:'guid:MAIN-OTHER',officialProductCategoryGuid:'MAIN-OTHER',officialProductCategoryNumber:'99',officialProductCategoryName:'OTHER',commissionRatePool:'COMPONENT',effectiveFrom:'14050101',effectiveTo:'',status:'approved'});const draft=await ledger.calculateDraftCommission(db,{fifoDatasetId:'FIFO-APPROVED',periodFrom:'14050401',periodTo:'14050431'},accountant);const line=db.collection(ledger.COMMISSION_LINES).rows.find(row=>row.commissionRunId===draft.run.commissionRunId&&row.saleLineIdentity===fact.saleLineIdentity);assert.equal(line.officialProductCategoryName,'OTHER');assert.equal(line.commissionRatePool,'COMPONENT');assert.equal(line.unavailableReason,'unknown-or-partial-cost');assert.equal(fact.commissionRatePool,'UNRESOLVED');
});

test('historical FIFO facts receive official Product Category and approved Rate Pool only in the read projection',async()=>{
  const db=seedDb();
  const historical={factId:'PF-HISTORICAL',fifoDatasetId:'FIFO-APPROVED',saleDate:'14050410',saleLineIdentity:'SL-HISTORICAL',saleInvoiceIdentity:'2:1',itemGuid:'GUID-CP',itemCode:'CP-1',commissionCategory:'COMPONENT',categoryResolutionStatus:'resolved',costCoverageStatus:'complete',immutable:true,factContentHash:'historical-hash'};
  db.collection(ledger.FIFO_FACTS).rows.push(structuredClone(historical));
  Object.assign(db.collection(ledger.CATEGORY_MAPPINGS).rows.find(row=>row.mappingId==='MAP-CP'),{schemaVersion:2,officialProductCategoryIdentity:'guid:MAIN-CPU',officialProductCategoryGuid:'MAIN-CPU',officialProductCategoryNumber:'84',officialProductCategoryName:'CPU',commissionRatePool:'COMPONENT'});
  const result=await ledger.listFacts(db,{fifoDatasetId:'FIFO-APPROVED'});
  assert.equal(result.list[0].officialProductCategoryName,'CPU');
  assert.equal(result.list[0].commissionRatePool,'COMPONENT');
  assert.equal(result.readProjectionOnly,true);
  assert.deepEqual(db.collection(ledger.FIFO_FACTS).rows[0],historical);
});
