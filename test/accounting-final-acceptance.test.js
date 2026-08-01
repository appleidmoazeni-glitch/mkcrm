'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryDb } = require('./helpers/memory-mongo');
const fat = require('../src/lib/accounting-final-acceptance');

const admin = { username:'admin-1', role:'admin' };
const accountant = { username:'accountant-1', role:'accounting' };
const manager = { username:'manager-1', role:'manager' };
const seller = { username:'seller-1', role:'seller' };
const SHA = 'c9a6c017d882b236ca5e46add4d32e6eedf04e4e';

function seedDb() {
  const investigations = Array.from({ length:10 }, (_, index) => ({
    investigationId:`INV-${index + 1}`, evidenceId:`E-${index + 1}`,
    sourceFifoDatasetId:'FIFO-V2', priority:'P0', affectedSaleValue:(10 - index) * 1000,
    affectedQuantity:index + 1, systemClassification:'sale_return_dependency',
    reviewStatus:'prepared', revision:1, auditLog:[]
  }));
  const saleCases = Array.from({ length:20 }, (_, index) => ({
    caseId:`SC-${index + 1}`, resolutionId:`SR-${index + 1}`,
    sourceFifoDatasetId:'FIFO-V2', kind:'sale', confidenceBand:'deterministic',
    confidence:100, financialImpact:(20 - index) * 500, reviewStatus:'prepared', revision:1
  }));
  const purchaseCases = Array.from({ length:5 }, (_, index) => ({
    caseId:`PC-${index + 1}`, resolutionId:`PR-${index + 1}`,
    sourceFifoDatasetId:'FIFO-V2', kind:'purchase', confidenceBand:'medium_confidence',
    confidence:70, financialImpact:(5 - index) * 100, reviewStatus:'prepared', revision:1
  }));
  const samples = Array.from({ length:30 }, (_, index) => ({
    sampleId:`SAMPLE-${index + 1}`, sampleKey:`K-${index + 1}`, datasetId:'FIFO-V2',
    category:index < 10 ? 'highest_value_fully_allocated_invoice' : index < 20 ? 'highest_value_partially_allocated_invoice' : 'unresolved_return_invoice',
    saleValueExact:`${30000 - index}.00`, reviewStatus:'not_reviewed', revision:1, auditLog:[]
  }));
  return new MemoryDb({
    users:[
      { username:'accountant-1', role:'accounting', isActive:true, fullName:'Accountant' },
      { username:'manager-1', role:'manager', isActive:true, fullName:'Manager' },
      { username:'admin-1', role:'admin', isActive:true, fullName:'Admin' },
      { username:'seller-1', role:'seller', isActive:true, fullName:'Seller' }
    ],
    saleSnapshotState:[{ scopeKey:'sale-type2|14050101|', activeSnapshotId:'SALE-A', activatedAt:new Date() }],
    saleSnapshots:[{ snapshotId:'SALE-A', status:'completed', activationStatus:'active' }],
    saleSnapshotDatasetHeaders:[{ snapshotId:'SALE-A', invTyp:2, invNo:1 }],
    saleSnapshotDatasetLines:[{
      snapshotId:'SALE-A', saleLineId:'SL-1', saleInvoiceType:2, saleInvoiceNo:1,
      saleDate:'14050501', row:1, itemCode:'ITEM-A', itemGuid:'GUID-A', qty:2,
      saleValue:2000, sellerAccountNumber:'11701013'
    }],
    purchaseLayerDatasetState:[{ scopeKey:'purchase-invoices-types-3-7', activeDatasetId:'PURCHASE-A' }],
    purchaseLayerDatasets:[{ datasetId:'PURCHASE-A', status:'completed', activationStatus:'active' }],
    supplierPurchaseLayers:[{
      datasetId:'PURCHASE-A', purchaseLineIdentity:'PL-1', layerKind:'purchase',
      validationStatus:'valid', itemCode:'ITEM-A', itemGuid:'GUID-A', originalQuantity:1,
      unitCostExact:'500.000000', remainingQuantity:0
    }],
    fifoDatasetState:[{ scopeKey:'fifo-shadow-v2-precision-evidence', activeDatasetId:'FIFO-V2' }],
    fifoDatasets:[{
      datasetId:'FIFO-V2', status:'completed', activationStatus:'validated-shadow',
      algorithmVersion:'fifo-shadow-v2-precision-evidence', sourceSaleSnapshotId:'SALE-A',
      sourcePurchaseDatasetId:'PURCHASE-A', sourceFingerprint:'SOURCE-FP', allocationFingerprint:'ALLOC-FP',
      deterministicReplayVerified:true, deterministicPeerDatasetId:'FIFO-PEER',
      summary:{ saleValue:2000 },
      validation:{ valid:true, duplicateAllocationCount:0, layerOverConsumptionCount:0, orphanLayerCount:0, inactiveSourceCount:0, monetaryReconciliationDifferenceExact:'0.00' }
    }],
    fifoAllocations:[{
      datasetId:'FIFO-V2', allocationId:'ALLOC-1', allocationSequence:1, saleLineId:'SL-1',
      saleInvoiceType:2, saleInvoiceNo:1, itemCode:'ITEM-A', sourceType:'official_purchase_layer',
      quantityExact:'1.000000', allocatedQty:1, unknownQty:0,
      allocatedSaleValueExact:'1000.00', allocatedCostAmountExact:'500.00', unitCostExact:'500.000000'
    },{
      datasetId:'FIFO-V2', allocationId:'ALLOC-2', allocationSequence:2, saleLineId:'SL-1',
      saleInvoiceType:2, saleInvoiceNo:1, itemCode:'ITEM-A', sourceType:'unknown_cost',
      quantityExact:'1.000000', allocatedQty:0, unknownQty:1,
      allocatedSaleValueExact:'1000.00', allocatedCostAmountExact:null, unitCostExact:null
    }],
    fifoExceptions:[],
    accountingCostEvidence:investigations.map((row, index) => ({
      evidenceId:row.evidenceId, sourceDatasetId:'FIFO-V2', sourceActive:true, priority:'P0',
      itemCode:`ITEM-${index}`, affectedSaleValue:row.affectedSaleValue, affectedQuantity:row.affectedQuantity,
      status:'return_dependency'
    })),
    purchaseReturnResolutions:purchaseCases.map(row => ({
      resolutionId:row.resolutionId, sourcePurchaseDatasetId:'PURCHASE-A', status:'candidate_found',
      returnLineIdentity:row.resolutionId, revision:1
    })),
    saleReturnResolutions:saleCases.map(row => ({
      resolutionId:row.resolutionId, sourceSaleSnapshotId:'SALE-A', status:'unresolved',
      returnLineIdentity:row.resolutionId, revision:1
    })),
    accountingValidationSamples:samples,
    manualCostResolutions:[],
    accountingEvidenceInvestigations:investigations,
    accountingReturnReviewCases:[...saleCases, ...purchaseCases],
    purchaseLayerRecoveryCandidates:[], accountingItemIdentityResolutions:[], manualCostEvidencePackages:[],
    accountingReviewBatches:[{
      batchId:'BATCH-1', sourceFifoDatasetId:'FIFO-V2', revision:1, status:'prepared',
      itemCounts:{ evidenceIds:10, saleReturnCaseIds:20, purchaseReturnCaseIds:5, validationSampleIds:30 },
      financialImpact:55000, references:{}, auditLog:[]
    }]
  });
}

async function createSession(db=seedDb(), overrides={}) {
  const result = await fat.createSession(db, {
    reviewBatchId:'BATCH-1', assignedAccountingUser:'accountant-1',
    assignedManagerUser:'manager-1', ...overrides
  }, admin, { gitSha:SHA });
  return { db, result, session:result.session };
}

const mapping = {
  invoiceType:'نوع فاکتور', invoiceNumber:'شماره فاکتور', invoiceDate:'تاریخ',
  itemCode:'کد کالا', quantity:'تعداد', saleAmount:'مبلغ فروش', sellerIdentity:'فروشنده'
};
const sourceValues = {
  'نوع فاکتور':'2', 'شماره فاکتور':'1', 'تاریخ':'۱۴۰۵/۰۵/۰۱',
  'کد کالا':'ITEM-A', 'تعداد':'2.000000', 'مبلغ فروش':'2000', 'فروشنده':'11701013'
};

test('review session freezes exact Sale, Purchase, FIFO, algorithm, batch, version and SHA', async()=>{
  const { session }=await createSession();
  assert.deepEqual(session.frozen,{
    saleSnapshotId:'SALE-A',purchaseDatasetId:'PURCHASE-A',fifoDatasetId:'FIFO-V2',
    fifoAlgorithmVersion:'fifo-shadow-v2-precision-evidence',reviewBatchId:'BATCH-1',
    reviewBatchRevision:1,applicationVersion:'0.9.19.69-dev.1',gitSha:SHA,
    sourceFingerprint:'SOURCE-FP',allocationFingerprint:'ALLOC-FP'
  });
  assert.equal(session.status,'prepared');
  assert.equal(session.profitActivationAllowed,false);
});

test('active source changes never retarget a frozen session',async()=>{
  const { db,session }=await createSession();
  db.collection('saleSnapshotState').rows[0].activeSnapshotId='SALE-B';
  db.collection('purchaseLayerDatasetState').rows[0].activeDatasetId='PURCHASE-B';
  db.collection('fifoDatasetState').rows[0].activeDatasetId='FIFO-B';
  const saved=await fat.getSession(db,session.sessionId);
  assert.equal(saved.frozen.saleSnapshotId,'SALE-A');
  assert.equal(saved.frozen.purchaseDatasetId,'PURCHASE-A');
  assert.equal(saved.frozen.fifoDatasetId,'FIFO-V2');
});

test('session rejects missing users, same-person assignments and duplicate creation',async()=>{
  const db=seedDb();
  await assert.rejects(fat.createSession(db,{reviewBatchId:'BATCH-1',assignedAccountingUser:'missing',assignedManagerUser:'manager-1'},admin,{gitSha:SHA}),error=>error.code==='ACCOUNTING_SESSION_ACCOUNTING_USER_INVALID');
  await assert.rejects(fat.createSession(db,{reviewBatchId:'BATCH-1',assignedAccountingUser:'accountant-1',assignedManagerUser:'accountant-1'},admin,{gitSha:SHA}),error=>['ACCOUNTING_SESSION_MANAGER_USER_INVALID','ACCOUNTING_SESSION_SEPARATION_REQUIRED'].includes(error.code));
  await createSession(db);
  await assert.rejects(createSession(db),error=>error.code==='ACCOUNTING_SESSION_DUPLICATE');
});

test('seller cannot prepare a session or initialize FAT definitions',async()=>{
  const db=seedDb();
  await assert.rejects(fat.createSession(db,{},seller,{gitSha:SHA}),error=>error.code==='ACCOUNTING_FAT_FORBIDDEN');
  await assert.rejects(fat.initializeFatDefinitions(db,seller),error=>error.code==='ACCOUNTING_FAT_FORBIDDEN');
});

test('only assigned Accounting can start review and stale revision returns conflict',async()=>{
  const { db,session }=await createSession();
  await assert.rejects(fat.transitionSession(db,session.sessionId,{status:'in_progress',revision:1},manager),error=>error.code==='ACCOUNTING_SESSION_ACCOUNTING_ASSIGNEE_REQUIRED');
  const started=await fat.transitionSession(db,session.sessionId,{status:'in_progress',revision:1,reason:'begin'},accountant);
  assert.equal(started.session.status,'in_progress');
  await assert.rejects(fat.transitionSession(db,session.sessionId,{status:'waiting_evidence',revision:1},accountant),error=>error.code==='ACCOUNTING_SESSION_CONFLICT');
});

test('minimum human target blocks manager handoff until real records are reviewed',async()=>{
  const { db,session }=await createSession();
  await fat.transitionSession(db,session.sessionId,{status:'in_progress',revision:1,reason:'begin'},accountant);
  await assert.rejects(fat.transitionSession(db,session.sessionId,{status:'ready_for_manager_review',revision:2,reason:'submit'},accountant),error=>error.code==='ACCOUNTING_SESSION_MINIMUM_TARGET_NOT_MET');
  db.collection('accountingValidationSamples').rows.forEach(row=>{row.reviewStatus='accounting_confirmed';});
  db.collection('accountingEvidenceInvestigations').rows.forEach(row=>{row.reviewStatus='ready_for_human_decision';});
  db.collection('accountingReturnReviewCases').rows.forEach(row=>{row.reviewStatus='ready_for_human_decision';});
  const progress=await fat.minimumTargetProgress(db,session);
  assert.equal(progress.met,true);
  const submitted=await fat.transitionSession(db,session.sessionId,{status:'ready_for_manager_review',revision:2,reason:'reviewed'},accountant);
  assert.equal(submitted.session.status,'ready_for_manager_review');
});

test('completed session is immutable and requires Manager evidence',async()=>{
  const { db,session }=await createSession();
  db.collection('accountingValidationSamples').rows.forEach(row=>{row.reviewStatus='accounting_confirmed';});
  db.collection('accountingEvidenceInvestigations').rows.forEach(row=>{row.reviewStatus='ready_for_human_decision';});
  db.collection('accountingReturnReviewCases').rows.forEach(row=>{row.reviewStatus='ready_for_human_decision';});
  await fat.transitionSession(db,session.sessionId,{status:'in_progress',revision:1},accountant);
  await fat.transitionSession(db,session.sessionId,{status:'ready_for_manager_review',revision:2},accountant);
  await assert.rejects(fat.transitionSession(db,session.sessionId,{status:'completed',revision:3},manager),error=>error.code==='ACCOUNTING_SESSION_MANAGER_EVIDENCE_REQUIRED');
  const done=await fat.transitionSession(db,session.sessionId,{status:'completed',revision:3,reason:'approved after review',evidenceReference:'PACKET-1'},manager);
  assert.equal(done.session.status,'completed');
  await assert.rejects(fat.transitionSession(db,session.sessionId,{status:'waiting_evidence',revision:4},manager),error=>error.code==='ACCOUNTING_SESSION_IMMUTABLE');
});

test('explicit Persian/English mapping validates required fields and rejects ambiguity',()=>{
  assert.equal(fat.validateMapping(mapping).invoiceDate,'تاریخ');
  assert.throws(()=>fat.validateMapping({...mapping,itemCode:'شماره فاکتور'}),error=>error.code==='ACCOUNTING_COMPARISON_MAPPING_AMBIGUOUS');
  const incomplete={...mapping};delete incomplete.quantity;
  assert.throws(()=>fat.validateMapping(incomplete),error=>error.code==='ACCOUNTING_COMPARISON_MAPPING_MISSING_REQUIRED');
});

test('reference import hashes source bytes and never stores binary or writes operational datasets',async()=>{
  const { db,session }=await createSession();
  const bytes=Buffer.from('accounting reference file');
  const created=await fat.createComparisonImport(db,{sessionId:session.sessionId,sourceFileName:'reference.xlsx',sourceFileBase64:bytes.toString('base64'),mapping},accountant);
  assert.equal(created.import.sourceFileHash,crypto.createHash('sha256').update(bytes).digest('hex'));
  assert.equal(created.import.binaryStored,false);
  assert.equal(created.import.operationalDatasetWrites,0);
  assert.equal(Object.hasOwn(created.import,'sourceFileBase64'),false);
});

test('comparison rows preserve source row/value, fixed precision and Jalali YYYYMMDD',async()=>{
  const { db,session }=await createSession();
  const imported=(await fat.createComparisonImport(db,{sessionId:session.sessionId,sourceFileName:'reference.csv',sourceFileBase64:Buffer.from('a').toString('base64'),mapping},accountant)).import;
  const result=await fat.ingestComparisonRows(db,imported.importId,{revision:1,final:true,rows:[{sourceRowNumber:2,sourceValues}]},accountant);
  assert.equal(result.batch.accepted,1);
  const row=db.collection(fat.COMPARISON_ROWS).rows[0];
  assert.equal(row.normalized.invoiceDate,'14050501');
  assert.equal(row.normalized.quantityExact,'2.000000');
  assert.equal(row.normalized.saleAmountExact,'2000.00');
  assert.equal(row.sourceValues['شماره فاکتور'],'1');
});

test('duplicate reference identity is explicit and never silently dropped',async()=>{
  const { db,session }=await createSession();
  const imported=(await fat.createComparisonImport(db,{sessionId:session.sessionId,sourceFileName:'d.csv',sourceFileBase64:Buffer.from('d').toString('base64'),mapping},accountant)).import;
  const result=await fat.ingestComparisonRows(db,imported.importId,{revision:1,final:true,rows:[{sourceRowNumber:2,sourceValues},{sourceRowNumber:3,sourceValues}]},accountant);
  assert.equal(result.batch.duplicateRows,1);
  assert.equal(db.collection(fat.COMPARISON_ROWS).rows.filter(row=>row.duplicateReferenceRow).length,1);
});

test('invalid Jalali reference row is counted invalid instead of becoming a zero-result match',async()=>{
  const { db,session }=await createSession();
  const imported=(await fat.createComparisonImport(db,{sessionId:session.sessionId,sourceFileName:'bad.csv',sourceFileBase64:Buffer.from('b').toString('base64'),mapping},accountant)).import;
  const result=await fat.ingestComparisonRows(db,imported.importId,{revision:1,final:true,rows:[{sourceRowNumber:2,sourceValues:{...sourceValues,'تاریخ':'1405/05'}}]},accountant);
  assert.equal(result.batch.invalidRows,1);
  assert.equal(db.collection(fat.COMPARISON_ROWS).rows.length,0);
});

test('import recovery preserves accepted rows and checkpoint after expired lock',async()=>{
  const { db,session }=await createSession();
  const imported=(await fat.createComparisonImport(db,{sessionId:session.sessionId,sourceFileName:'resume.csv',sourceFileBase64:Buffer.from('r').toString('base64'),mapping},accountant)).import;
  await fat.ingestComparisonRows(db,imported.importId,{revision:1,final:false,rows:[{sourceRowNumber:2,sourceValues}]},accountant);
  const stored=db.collection(fat.COMPARISON_IMPORTS).rows[0];stored.lock={token:'expired',expiresAt:new Date(0)};stored.status='paused';
  const before=db.collection(fat.COMPARISON_ROWS).rows.length;
  const recovered=await fat.recoverComparisonImport(db,stored.importId,{revision:stored.revision},accountant);
  assert.equal(recovered.rowsPreserved,true);
  assert.equal(db.collection(fat.COMPARISON_ROWS).rows.length,before);
  assert.equal(recovered.import.progress.nextRowNumber,3);
});

test('difference classification covers required financial and identity cases',()=>{
  assert.equal(fat.classifyDifference('row','',1,{missingInCrm:true}),'missing_in_crm');
  assert.equal(fat.classifyDifference('quantity','1','2'),'quantity_difference');
  assert.equal(fat.classifyDifference('purchaseCost','1','2'),'cost_difference');
  assert.equal(fat.classifyDifference('invoiceDate','14050101','14050102'),'date_normalization_difference');
  assert.equal(fat.classifyDifference('row',1,1,{duplicateReferenceRow:true}),'duplicate_reference_row');
  assert.ok(fat.DIFFERENCE_TYPES.includes('unexplained_difference'));
});

test('count, quantity and IRR comparisons are exact while unit-cost tolerance is explicit',()=>{
  assert.equal(fat.compareExact('count',2,2).equal,true);
  assert.equal(fat.compareExact('count',2,3).equal,false);
  assert.equal(fat.compareExact('quantity','1.000000','1.000001').equal,false);
  assert.equal(fat.compareExact('saleAmount','951860416.64','951860416.64').equal,true);
  assert.equal(fat.compareExact('unitCost','1.000001','1.000002').equal,false);
  const tolerated=fat.compareExact('unitCost','1.000001','1.000002',{approved:true,amount:'0.000001'});
  assert.equal(tolerated.equal,true);assert.equal(tolerated.toleranceUsed,true);
});

test('comparison execution is paginated, records drillable differences and remains human-blocked',async()=>{
  const { db,session }=await createSession();
  const imported=(await fat.createComparisonImport(db,{sessionId:session.sessionId,sourceFileName:'compare.csv',sourceFileBase64:Buffer.from('c').toString('base64'),mapping},accountant)).import;
  const ingested=await fat.ingestComparisonRows(db,imported.importId,{revision:1,final:true,rows:[{sourceRowNumber:2,sourceValues:{...sourceValues,'مبلغ فروش':'2100'}}]},accountant);
  const run=(await fat.prepareComparisonRun(db,{sessionId:session.sessionId,importId:imported.importId},accountant)).run;
  const executed=await fat.executeComparisonBatch(db,run.comparisonRunId,{revision:1,pageSize:100},accountant);
  assert.equal(executed.hasMore,false);
  assert.equal(executed.run.status,'blocked_human_review');
  assert.equal(executed.accountingPass,false);
  assert.equal(db.collection(fat.COMPARISON_DIFFERENCES).rows[0].classification,'sale_amount_difference');
  assert.equal(ingested.import.sourceFileHash,executed.run.sourceFileHash);
  const report=await fat.listComparisonDifferences(db,{comparisonRunId:run.comparisonRunId,classification:'sale_amount_difference'});
  assert.equal(report.total,1);assert.equal(report.classificationCounts.sale_amount_difference,1);
  assert.equal(report.list[0].sourceRowNumber,2);assert.equal(report.decisionImportAllowed,false);
});

test('interrupted comparison recovery preserves checkpoint and differences',async()=>{
  const { db,session }=await createSession();
  const imported=(await fat.createComparisonImport(db,{sessionId:session.sessionId,sourceFileName:'recover-run.csv',sourceFileBase64:Buffer.from('rr').toString('base64'),mapping},accountant)).import;
  await fat.ingestComparisonRows(db,imported.importId,{revision:1,final:true,rows:[{sourceRowNumber:2,sourceValues}]},accountant);
  const run=(await fat.prepareComparisonRun(db,{sessionId:session.sessionId,importId:imported.importId},accountant)).run;
  const stored=db.collection(fat.COMPARISON_RUNS).rows[0];stored.status='paused';stored.lock={token:'old',expiresAt:new Date(0)};stored.progress.checkpointRowNumber=1;
  const recovered=await fat.recoverComparisonRun(db,run.comparisonRunId,{revision:stored.revision},accountant);
  assert.equal(recovered.checkpointPreserved,true);assert.equal(recovered.run.progress.checkpointRowNumber,1);
});

test('FAT definitions are versioned and include all 12 required scenarios plus disabled future Commission',async()=>{
  const db=seedDb();const result=await fat.initializeFatDefinitions(db,admin);
  assert.equal(result.total,13);
  const definitions=(await fat.listFatDefinitions(db)).list;
  for(let index=1;index<=12;index++)assert.ok(definitions.some(row=>row.scenarioCode===`FAT-${String(index).padStart(2,'0')}`));
  assert.equal(definitions.find(row=>row.scenarioCode==='FAT-COMMISSION-FUTURE').enabled,false);
});

test('technical FAT execution cannot create accounting pass or Profit activation',async()=>{
  const { db,session }=await createSession();await fat.initializeFatDefinitions(db,admin);
  const run=(await fat.prepareFatRun(db,{sessionId:session.sessionId,backupEvidence:{path:'backup',sourceSha:SHA},rollbackEvidence:{pm2:'documented'}},admin)).run;
  const result=await fat.executeTechnicalFat(db,run.fatRunId,admin);
  assert.equal(result.automatedTechnicalChecksOnly,true);
  assert.equal(result.accountingPass,false);
  assert.notEqual(result.run.status,'passed');
  assert.equal(result.run.profitActivationAllowed,false);
  const report=await fat.fatRunReport(db,run.fatRunId);
  assert.equal(report.run.fatRunId,run.fatRunId);assert.equal(report.automaticApproval,false);
  assert.equal(report.profitActivationAllowed,false);
});

test('FAT evidence is immutable and does not imply approval',async()=>{
  const { db,session }=await createSession();await fat.initializeFatDefinitions(db,admin);
  const run=(await fat.prepareFatRun(db,{sessionId:session.sessionId},admin)).run;
  const evidence=await fat.recordFatEvidence(db,run.fatRunId,{scenarioCode:'FAT-07',evidenceType:'fingerprint',evidenceReference:'FIFO-V2',payload:{source:'SOURCE-FP'}},accountant);
  assert.equal(evidence.approvalImplied,false);assert.equal(evidence.evidence.immutable,true);
  const duplicate=await fat.recordFatEvidence(db,run.fatRunId,{scenarioCode:'FAT-07',evidenceType:'fingerprint',evidenceReference:'FIFO-V2',payload:{source:'SOURCE-FP'}},accountant);
  assert.equal(duplicate.duplicate,true);
});

test('FAT differences remain immutable, classified and drillable without automatic approval',async()=>{
  const { db,session }=await createSession();await fat.initializeFatDefinitions(db,admin);
  const run=(await fat.prepareFatRun(db,{sessionId:session.sessionId},admin)).run;
  const recorded=await fat.recordFatDifference(db,run.fatRunId,{
    scenarioCode:'FAT-03',classification:'seller_mapping_difference',field:'sellerIdentity',
    crmValue:'11701013',referenceValue:'11701999',differenceExact:'',
    evidenceReference:'REFERENCE-ROW-22',notes:'Requires authorized accounting review.'
  },accountant);
  assert.equal(recorded.difference.immutable,true);assert.equal(recorded.automaticApproval,false);
  assert.equal(recorded.run.scenarios.find(row=>row.scenarioCode==='FAT-03').differences,1);
  const report=await fat.fatRunReport(db,run.fatRunId,{scenarioCode:'FAT-03'});
  assert.equal(report.totals.differences,1);assert.equal(report.differences[0].classification,'seller_mapping_difference');
  assert.equal(report.run.accountingApproved,false);
});

test('coverage simulator keeps actual/projected separate and never invents cost recovery',async()=>{
  const { db,session }=await createSession();
  const baseline=await fat.coverageSimulator(db,session.sessionId,{decisions:[]});
  const projected=await fat.coverageSimulator(db,session.sessionId,{decisions:[{type:'return',id:'SC-1',decision:'confirmed_linked'}]});
  assert.equal(baseline.mode,'PROJECTED_READ_ONLY');
  assert.equal(projected.projected.saleValueCoverage,projected.actual.saleValueCoverage);
  assert.equal(projected.projected.unknownSaleValue,projected.actual.unknownSaleValue);
  assert.ok(projected.projected.returnLinkageCoverage>projected.actual.returnLinkageCoverage);
  assert.equal(projected.workflowWrites,0);
});

test('FIFO rerun is blocked without an authorized decision and enabled after a real approved record',async()=>{
  const { db,session }=await createSession();
  const blocked=await fat.fifoRerunGate(db,session.sessionId);
  assert.equal(blocked.allowed,false);
  db.collection('manualCostResolutions').rows.push({resolutionId:'MC-1',status:'approved',approvedAt:new Date(Date.now()+1000)});
  const allowed=await fat.fifoRerunGate(db,session.sessionId);
  assert.equal(allowed.allowed,true);assert.deepEqual(allowed.approvedDecisionIds,['MC-1']);assert.equal(allowed.shadowOnly,true);
});

test('FAT scenario approval requires assigned human role, evidence and creator separation',async()=>{
  const { db,session }=await createSession();await fat.initializeFatDefinitions(db,admin);
  const run=(await fat.prepareFatRun(db,{sessionId:session.sessionId},admin)).run;
  await assert.rejects(fat.approveFatScenario(db,run.fatRunId,{scenarioCode:'FAT-01',decision:'approved'},accountant),error=>error.code==='FAT_APPROVAL_EVIDENCE_REQUIRED');
  const approved=await fat.approveFatScenario(db,run.fatRunId,{scenarioCode:'FAT-01',decision:'approved',reason:'reference reconciled',evidenceReference:'PACKET-1'},accountant);
  assert.equal(approved.runAutomaticallyPassed,false);assert.equal(approved.profitActivationAllowed,false);
  await assert.rejects(fat.approveFatScenario(db,run.fatRunId,{scenarioCode:'FAT-01',decision:'approved',reason:'x',evidenceReference:'y'},seller),error=>error.code==='ACCOUNTING_FAT_FORBIDDEN');
});

test('assigned Admin may represent Manager only with explicit manager scope',async()=>{
  const db=seedDb();
  db.collection('users').rows.push({username:'admin-manager',role:'admin',isActive:true,fullName:'Admin Manager'});
  const {session}=await createSession(db,{assignedManagerUser:'admin-manager'});
  await fat.initializeFatDefinitions(db,admin);
  const run=(await fat.prepareFatRun(db,{sessionId:session.sessionId},admin)).run;
  const managerAdmin={username:'admin-manager',role:'admin'};
  await assert.rejects(
    fat.approveFatScenario(db,run.fatRunId,{scenarioCode:'FAT-01',decision:'approved',reason:'reviewed',evidenceReference:'PACKET-ADMIN'},managerAdmin),
    error=>error.code==='FAT_ADMIN_MANAGER_SCOPE_REQUIRED'
  );
  const approved=await fat.approveFatScenario(db,run.fatRunId,{scenarioCode:'FAT-01',decision:'approved',reason:'reviewed',evidenceReference:'PACKET-ADMIN',authorizedScope:'manager'},managerAdmin);
  assert.equal(approved.approval.role,'manager');assert.equal(approved.approval.actualRole,'admin');
  assert.equal(approved.approval.authorizedScope,'manager');assert.equal(approved.runAutomaticallyPassed,false);
});

test('source contracts prohibit invoices, Shaygan writes, source mutation, auto approval and seller access',()=>{
  const root=path.join(__dirname,'..');
  const source=fs.readFileSync(path.join(root,'src/lib/accounting-final-acceptance.js'),'utf8');
  const server=fs.readFileSync(path.join(root,'src/server.js'),'utf8');
  const ui=fs.readFileSync(path.join(root,'public/assets/app.js'),'utf8');
  assert.doesNotMatch(source,/PutSaleInvoice|PutBuyInvoice|Invoice\s*\/\s*Put|shaygan\.|issueSale|issuePurchase/i);
  assert.doesNotMatch(source,/collection\(['"](?:saleSnapshotDatasetLines|saleInvoiceLines|supplierPurchaseLayers)['"]\)\.(?:update|insert|delete)/i);
  assert.match(server,/FIFO_AUTHORIZED_ACCOUNTING_DECISION_REQUIRED/);
  assert.match(server,/accountingFinalAcceptance\.fifoRerunGate/);
  assert.match(ui,/HUMAN ACCOUNTING AUTHORITY REQUIRED/);
  const sellerPages=ui.match(/seller:\s*\[([^\]]*)\]/)?.[1]||'';
  assert.doesNotMatch(sellerPages,/accounting-fat/);
});

test('new FIFO candidate records frozen review context and remains Shadow-only',()=>{
  const root=path.join(__dirname,'..');
  const engine=fs.readFileSync(path.join(root,'src/lib/fifo-shadow-engine.js'),'utf8');
  assert.match(engine,/accountingReviewContext:accountingReviewContext\(options\.accountingReviewContext\)/);
  assert.match(engine,/shadowOnly:true/);
  assert.match(engine,/profitActivationAllowed:false/);
});
