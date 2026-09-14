'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryDb}=require('./helpers/memory-mongo');
const service=require('../src/lib/seller-financial-performance');
const fifo=require('../src/lib/fifo-shadow-engine');

const accounting={username:'accountant',role:'accounting'};
const manager={username:'manager',role:'manager'};
const purchase={username:'buyer',role:'purchase'};
const seller={username:'seller',role:'seller'};

function bindActiveCandidate(db,{datasetId='FIFO-A',revision=7}={}){
  const dataset=db.collection('fifoDatasets').rows.find(row=>row.datasetId===datasetId);
  Object.assign(dataset,{activationStatus:'validated-candidate',sourceFingerprint:'1'.repeat(64),allocationFingerprint:'2'.repeat(64),candidateFingerprint:'3'.repeat(64),sourcePurchaseDatasetId:'PURCHASE-A',sourceOpeningDatasetId:'OPENING-A',immutable:true});
  const state=db.collection('fifoDatasetState').rows[0];Object.assign(state,{activeDatasetId:datasetId,authorityRevision:revision});
  return {fifoDatasetId:datasetId,expectedActiveFifoDatasetId:datasetId,expectedFifoAuthorityRevision:revision,expectedFifoSourceFingerprint:dataset.sourceFingerprint,expectedFifoAllocationFingerprint:dataset.allocationFingerprint,expectedFifoCandidateFingerprint:dataset.candidateFingerprint,candidateOnly:true};
}

function dbSeed(){return new MemoryDb({
  saleSnapshotState:[{scopeKey:'sale-type2|14050101|',activeSnapshotId:'SALE-A',activatedAt:new Date('2026-08-02T00:00:00Z')}],
  saleSnapshots:[{snapshotId:'SALE-A',status:'completed',createdAt:new Date('2026-08-02T00:00:00Z')}],
  fifoDatasetState:[{scopeKey:fifo.SCOPE_KEY,activeDatasetId:'FIFO-A'}],
  fifoDatasets:[{datasetId:'FIFO-A',status:'completed',activationStatus:'validated-shadow',sourceSaleSnapshotId:'SALE-A',sourceFingerprint:'SOURCE-A',allocationFingerprint:'ALLOC-A'}],
  fifoProfitFacts:[
    {factId:'F1',factContentHash:'HF1',fifoDatasetId:'FIFO-A',saleSnapshotId:'SALE-A',saleLineIdentity:'LINE-1',saleInvoiceIdentity:'2:4691',saleInvoiceType:2,saleInvoiceNumber:4691,saleDate:'14050410',sellerIdentity:'11701013',sellerName:'امیر ممیزی',itemGuid:'ITEM-NB',itemCode:'NB-1',itemDescription:'Notebook',quantityExact:'1.000000',saleAmountExact:'2500000000.00',invoiceDiscountExact:'1000000.00',fifoCostExact:'2100000000.00',actualFifoProfitExact:'400000000.00',costCoverageStatus:'complete'},
    {factId:'F2',factContentHash:'HF2',fifoDatasetId:'FIFO-A',saleSnapshotId:'SALE-A',saleLineIdentity:'LINE-2',saleInvoiceIdentity:'2:4692',saleInvoiceType:2,saleInvoiceNumber:4692,saleDate:'14050411',sellerIdentity:'11701013',sellerName:'امیر ممیزی',itemGuid:'ITEM-CPU',itemCode:'CPU-1',itemDescription:'CPU',quantityExact:'2.000000',saleAmountExact:'100000000.00',invoiceDiscountExact:'0.00',fifoCostExact:null,actualFifoProfitExact:null,costCoverageStatus:'unknown'}
  ],
  fifoAllocations:[{datasetId:'FIFO-A',allocationId:'A1',saleLineId:'LINE-1',allocationSequence:1,sourceType:'official_purchase_layer',purchaseLayerId:'PL-1',purchaseInvoiceNo:7001,supplierAccountNumber:'SUP-1',supplierName:'Supplier One',quantityExact:'1.000000',allocatedCostAmountExact:'2100000000.00'}],
  manualCostResolutions:[],
  commissionPolicyVersions:[{policyVersionId:'POL-TIR',status:'approved',name:'Tir',accountingPeriod:'140504',effectiveFrom:'14050401',effectiveTo:'14050431'}],
  commissionCategoryMappings:[
    {mappingId:'MAP-NB',policyVersionId:'POL-TIR',status:'approved',identityType:'itemGuid',identityValue:'ITEM-NB',officialProductCategoryIdentity:'guid:NB',officialProductCategoryGuid:'NB',officialProductCategoryNumber:'1',officialProductCategoryName:'NOTEBOOK',commissionRatePool:'NOTEBOOK',effectiveFrom:'14050401',effectiveTo:'14050431'},
    {mappingId:'MAP-CPU',policyVersionId:'POL-TIR',status:'approved',identityType:'itemGuid',identityValue:'ITEM-CPU',officialProductCategoryIdentity:'guid:CPU',officialProductCategoryGuid:'CPU',officialProductCategoryNumber:'84',officialProductCategoryName:'CPU',commissionRatePool:'COMPONENT',effectiveFrom:'14050401',effectiveTo:'14050431'}
  ],
  commissionRateVersions:[
    {rateVersionId:'RATE-NB',policyVersionId:'POL-TIR',status:'approved',sellerIdentity:'*',rateScope:'rate_pool',commissionRatePool:'NOTEBOOK',rate:'0.14000000',effectiveFrom:'14050401',effectiveTo:'14050431'},
    {rateVersionId:'RATE-CP',policyVersionId:'POL-TIR',status:'approved',sellerIdentity:'*',rateScope:'rate_pool',commissionRatePool:'COMPONENT',rate:'0.20000000',effectiveFrom:'14050401',effectiveTo:'14050431'}
  ],
  invoiceDiscountFacts:[
    {discountFactId:'D1',saleSnapshotId:'SALE-A',saleInvoiceIdentity:'2:4691',invoiceDiscountExact:'0.00',categoryAttributionStatus:'not-applicable',contentHash:'HD1'},
    {discountFactId:'D2',saleSnapshotId:'SALE-A',saleInvoiceIdentity:'2:4692',invoiceDiscountExact:'0.00',categoryAttributionStatus:'not-applicable',contentHash:'HD2'}
  ],
  accountingOfficialGroupCatalogRuns:[{catalogRunId:'CAT-A',fetchedAt:new Date('2026-08-01T00:00:00Z')}],
  accountingOfficialItemGroupAssignments:[
    {catalogRunId:'CAT-A',itemGuid:'ITEM-NB',itemCode:'NB-1',isOfficialEvidence:true,resolvedMainGroupIdentity:'guid:NB',resolvedMainGroupGuid:'NB',resolvedMainGroupNumber:'1',resolvedMainGroupName:'NOTEBOOK'},
    {catalogRunId:'CAT-A',itemGuid:'ITEM-CPU',itemCode:'CPU-1',isOfficialEvidence:true,resolvedMainGroupIdentity:'guid:CPU',resolvedMainGroupGuid:'CPU',resolvedMainGroupNumber:'84',resolvedMainGroupName:'CPU'}
  ],
  saleSnapshotDatasetHeaders:[
    {snapshotId:'SALE-A',invTyp:2,invNo:4691,storeName:'مشهد کالا',stockNumber:'1'},
    {snapshotId:'SALE-A',invTyp:2,invNo:4692,storeName:'مشهد کالا',stockNumber:'1'}
  ],
  saleSnapshotDatasetLines:[
    {snapshotId:'SALE-A',saleInvoiceType:2,saleInvoiceNo:4691,row:1,saleDate:'14050410',saleValue:2500000000},
    {snapshotId:'SALE-A',saleInvoiceType:2,saleInvoiceNo:4692,row:1,saleDate:'14050411',saleValue:100000000}
  ],
  userShayganMappings:[{username:'seller-user',employeeAccountNumber:'11701013',storeName:'مشهد کالا',isActive:true,updatedAt:new Date('2026-08-01T00:00:00Z')}],
  users:[{username:'seller-user',fullName:'امیر ممیزی',role:'seller',isActive:true,updatedAt:new Date('2026-08-01T00:00:00Z')}],
  profitAdjustments:[],savedProfitLedgerEntries:[]
});}

test('build creates an isolated active projection with exact values and explicit unavailable cost',async()=>{
  const db=dbSeed();const result=await service.buildReadModel(db,{batchSize:50},accounting);assert.equal(result.ok,true);assert.equal(result.lineCount,2);assert.equal((await service.activeRun(db)).runId,result.runId);
  const line=db.collection(service.LINES).rows.find(row=>row.saleLineIdentity==='LINE-1');assert.equal(line.actualFifoProfitExact,'400000000.00');assert.equal(line.commissionableProfitExact,'400000000.00');assert.equal(line.preliminaryCommissionExact,'56000000.00');assert.equal(line.officialProductCategoryName,'NOTEBOOK');assert.equal(line.commissionRatePool,'NOTEBOOK');assert.equal(line.policyVersionId,'POL-TIR');assert.equal(line.rateVersionId,'RATE-NB');assert.match(line.policyContentHash,/^[a-f0-9]{64}$|^HASH-/);assert.match(line.categoryMappingContentHash,/^[a-f0-9]{64}$/);assert.match(line.rateContentHash,/^[a-f0-9]{64}$/);assert.match(line.governanceSourceFingerprint,/^[a-f0-9]{64}$/);assert.equal(line.nonPayable,true);
  const unknown=db.collection(service.LINES).rows.find(row=>row.saleLineIdentity==='LINE-2');assert.equal(unknown.actualFifoProfitExact,null);assert.equal(unknown.preliminaryCommissionExact,null);assert.equal(unknown.commissionStatus,'unavailable');assert.ok(unknown.blockers.includes('cost-unknown'));
  const totals=await service.totals(db,{dateFrom:'14050401',dateTo:'14050431'},manager);assert.equal(totals.lineCount,2);assert.equal(totals.invoiceCount,2);assert.equal(totals.unknownCostLineCount,1);assert.equal(totals.knownFifoProfitExact,'400000000.00');assert.equal(totals.actualFifoProfitExact,null);assert.equal(totals.profitCoverageComplete,false);assert.equal(totals.nonPayable,true);
  const invoices=await service.listInvoices(db,{dateFrom:'14050401',dateTo:'14050431'},manager);assert.equal(invoices.total,2);const invoiceLines=await service.listInvoiceLines(db,'2:4691',{},manager);assert.equal(invoiceLines.total,1);const drill=await service.lineDrilldown(db,'LINE-1',manager);assert.equal(drill.source.allocations[0].purchaseLayerId,'PL-1');assert.deepEqual(line.allocationIds,['A1']);
  const summary=db.collection(service.SUMMARIES).rows.find(row=>row.dimension==='seller-month');assert.equal(summary.saleValueExact,'2600000000.00');assert.equal(summary.unknownCostLineCount,1);assert.equal(summary.knownFifoProfitExact,'400000000.00');
  assert.equal(db.collection('fifoProfitFacts').rows[0].actualFifoProfitExact,'400000000.00');
});

test('server-side filters support Tir, canonical seller/category identity, invoice value and FIFO profit thresholds',async()=>{
  const db=dbSeed();await service.buildReadModel(db,{},accounting);const report=await service.listLines(db,{dateFrom:'۱۴۰۵/۰۴/۰۱',dateTo:'1405-04-31',sellerIdentity:'11701013',categoryGuid:'NB',invoiceAmountMin:'2000000000',fifoProfitMin:'300000000',pageSize:10},manager);assert.equal(report.total,1);assert.equal(report.list[0].saleInvoiceNumber,4691);assert.equal(report.list[0].canonicalSellerId,'11701013');assert.equal(report.list[0].canonicalCategoryGuid,'NB');assert.equal(report.serverSide,true);
  const below=await service.listLines(db,{categoryGuid:'NB',fifoProfitMax:'50000000'},purchase);assert.equal(below.total,0);
  await assert.rejects(service.listLines(db,{category:'NOTEBOOK'},manager),error=>error.code==='SELLER_FINANCIAL_CATEGORY_GUID_REQUIRED');
  const sourceFiltered=await service.listLines(db,{purchaseInvoiceNumber:7001,supplier:'Supplier One'},manager);assert.equal(sourceFiltered.total,1);
  const marginFiltered=await service.listLines(db,{marginMin:'0.15',marginMax:'0.17'},manager);assert.equal(marginFiltered.total,1);assert.equal(marginFiltered.list[0].fifoMarginExact,'0.16000000');
});

test('cashbox-mapped source identities collapse to the canonical employee seller without name deduplication',async()=>{
  const db=dbSeed();
  const facts=db.collection('fifoProfitFacts').rows;
  facts[0].sellerIdentity='11009999';facts[0].sellerName='نام نمایشی مشترک';
  facts[1].sellerIdentity='11709998';facts[1].sellerName='نام نمایشی مشترک';
  Object.assign(db.collection('saleSnapshotDatasetHeaders').rows[0],{sellerAccountNumber:'11009999',sellerName:'فروشنده واقعی',sellerUsername:'seller-user',sellerMappingStatus:'mapped',sellerMappingSource:'cashboxAccountNumber',cashboxAccountNumber:'11009999'});
  Object.assign(db.collection('saleSnapshotDatasetHeaders').rows[1],{sellerAccountNumber:'11709998',sellerName:'فروشنده واقعی',sellerUsername:'seller-user',sellerMappingStatus:'mapped',sellerMappingSource:'cashboxAccountNumber',cashboxAccountNumber:'11009999'});
  db.collection('userShayganMappings').rows[0].cashboxAccountNumber='11009999';
  db.collection('userShayganMappings').rows.push({username:'other-user',employeeAccountNumber:'11709998',cashboxAccountNumber:'11008888',isActive:true});
  db.collection('users').rows.push({username:'other-user',fullName:'شخص دیگر',role:'seller',isActive:true});
  const built=await service.buildReadModel(db,{},accounting);
  const lines=db.collection(service.LINES).rows.filter(row=>row.runId===built.runId);
  assert.deepEqual([...new Set(lines.map(row=>row.sellerIdentity))],['11701013']);
  assert.deepEqual(lines.map(row=>row.sourceSellerIdentity).sort(),['11009999','11709998']);
  assert.ok(lines.every(row=>row.sellerIdentityResolutionSource==='sale-snapshot-mapped-username'));
  const options=await service.filterOptions(db,{},manager);
  assert.deepEqual(options.sellers,[{identity:'11701013',name:'امیر ممیزی'}]);
  const sellerSummary=db.collection(service.SUMMARIES).rows.find(row=>row.dimension==='seller-month');
  assert.equal(sellerSummary.sellerIdentity,'11701013');assert.equal(sellerSummary.lineCount,2);
});

test('two real sellers with the same display name remain separate selector identities',async()=>{
  const db=dbSeed();
  const duplicate={...db.collection('fifoProfitFacts').rows[0],factId:'F3',factContentHash:'HF3',saleLineIdentity:'LINE-3',saleInvoiceIdentity:'2:4693',saleInvoiceNumber:4693,sellerIdentity:'11701099',sellerName:'امیر ممیزی'};
  db.collection('fifoProfitFacts').rows.push(duplicate);
  db.collection('saleSnapshotDatasetHeaders').rows.push({snapshotId:'SALE-A',invTyp:2,invNo:4693,sellerAccountNumber:'11701099',sellerName:'امیر ممیزی'});
  db.collection('invoiceDiscountFacts').rows.push({discountFactId:'D3',saleSnapshotId:'SALE-A',saleInvoiceIdentity:'2:4693',invoiceDiscountExact:'0.00',categoryAttributionStatus:'not-applicable',contentHash:'HD3'});
  await service.buildReadModel(db,{},accounting);
  const options=await service.filterOptions(db,{},manager);
  assert.deepEqual(options.sellers.map(row=>row.identity).sort(),['11701013','11701099']);
});

test('category selector is unique by official GUID and disambiguates equal names without name authority',async()=>{
  const db=dbSeed();
  const duplicate={...db.collection('fifoProfitFacts').rows[0],factId:'F3',factContentHash:'HF3',saleLineIdentity:'LINE-3',saleInvoiceIdentity:'2:4693',saleInvoiceNumber:4693,itemGuid:'ITEM-NB-OTHER',itemCode:'NB-OTHER'};
  db.collection('fifoProfitFacts').rows.push(duplicate);
  db.collection('accountingOfficialItemGroupAssignments').rows.push({catalogRunId:'CAT-A',itemGuid:'ITEM-NB-OTHER',itemCode:'NB-OTHER',isOfficialEvidence:true,resolvedMainGroupIdentity:'guid:NB-OTHER',resolvedMainGroupGuid:'NB-OTHER',resolvedMainGroupNumber:'99',resolvedMainGroupName:'NOTEBOOK'});
  db.collection('commissionCategoryMappings').rows.push({mappingId:'MAP-NB-OTHER',policyVersionId:'POL-TIR',status:'approved',identityType:'itemGuid',identityValue:'ITEM-NB-OTHER',officialProductCategoryIdentity:'guid:NB-OTHER',officialProductCategoryGuid:'NB-OTHER',officialProductCategoryNumber:'99',officialProductCategoryName:'NOTEBOOK',commissionRatePool:'NOTEBOOK',effectiveFrom:'14050401',effectiveTo:'14050431'});
  db.collection('saleSnapshotDatasetHeaders').rows.push({snapshotId:'SALE-A',invTyp:2,invNo:4693,storeName:'مشهد کالا',stockNumber:'1'});
  db.collection('invoiceDiscountFacts').rows.push({discountFactId:'D3',saleSnapshotId:'SALE-A',saleInvoiceIdentity:'2:4693',invoiceDiscountExact:'0.00',categoryAttributionStatus:'not-applicable',contentHash:'HD3'});
  await service.buildReadModel(db,{},accounting);
  const options=await service.filterOptions(db,{},manager);const notebooks=options.categories.filter(row=>row.name==='NOTEBOOK');
  assert.equal(notebooks.length,2);assert.deepEqual(notebooks.map(row=>row.guid).sort(),['NB','NB-OTHER']);assert.ok(notebooks.every(row=>row.label.includes('—')));assert.equal(options.categoryAuthority,'official-shaygan-category-guid');
  const first=await service.listLines(db,{categoryGuid:'NB'},manager),second=await service.listLines(db,{categoryGuid:'NB-OTHER'},manager);assert.equal(first.total,1);assert.equal(second.total,1);
});

test('invoice with incomplete lines exposes known profit separately and never labels it total actual profit',async()=>{
  const db=dbSeed();Object.assign(db.collection('fifoProfitFacts').rows[1],{saleInvoiceIdentity:'2:4691',saleInvoiceNumber:4691});await service.buildReadModel(db,{},accounting);const result=await service.listInvoices(db,{},manager);assert.equal(result.total,1);assert.equal(result.list[0].knownFifoProfitExact,'400000000.00');assert.equal(result.list[0].actualFifoProfitExact,null);assert.equal(result.list[0].profitCoverageComplete,false);
});

test('line drill-down includes referenced approved manual-cost evidence without changing FIFO facts',async()=>{
  const db=dbSeed();Object.assign(db.collection('fifoAllocations').rows[0],{sourceType:'approved_manual_cost',manualResolutionId:'MC-1'});db.collection('manualCostResolutions').rows.push({resolutionId:'MC-1',status:'approved',contentHash:'abc',manualCostExact:'2100000000.000000'});const before=structuredClone(db.collection('fifoProfitFacts').rows);await service.buildReadModel(db,{},accounting);const drill=await service.lineDrilldown(db,'LINE-1',manager);assert.equal(drill.source.manualCostEvidence[0].resolutionId,'MC-1');assert.deepEqual(db.collection('fifoProfitFacts').rows,before);
});

test('replay is deterministic and historical runs coexist while only state pointer is authoritative',async()=>{
  const db=dbSeed();const first=await service.buildReadModel(db,{},accounting);const unchanged=await service.buildReadModel(db,{mode:'incremental'},accounting);assert.equal(unchanged.duplicate,true);assert.equal(unchanged.runId,first.runId);const second=await service.buildReadModel(db,{},accounting);assert.notEqual(first.runId,second.runId);assert.equal(first.resultFingerprint,second.resultFingerprint);assert.equal((await service.activeRun(db)).runId,second.runId);assert.equal(db.collection(service.RUNS).rows.find(row=>row.runId===first.runId).active,false);assert.equal(db.collection(service.RUNS).rows.find(row=>row.runId===first.runId).status,'superseded');assert.equal(db.collection(service.RUNS).rows.filter(row=>row.status==='completed').length,1);assert.equal(new Set(db.collection(service.LINES).rows.filter(row=>row.runId===second.runId).map(row=>row.saleLineIdentity)).size,2);
});

test('failed candidate never replaces the previous active run',async()=>{
  const db=dbSeed();const first=await service.buildReadModel(db,{},accounting);db.collection('fifoProfitFacts').rows.push({...db.collection('fifoProfitFacts').rows[0],factId:'F3',factContentHash:'HF3',saleLineIdentity:'LINE-3',saleInvoiceIdentity:'2:4693',saleInvoiceNumber:4693});const collection=db.collection(service.LINES);const original=collection.bulkWrite.bind(collection);collection.bulkWrite=async()=>{throw new Error('controlled projection write failure');};await assert.rejects(service.buildReadModel(db,{maxAttempts:1},accounting),/controlled projection/);collection.bulkWrite=original;assert.equal((await service.activeRun(db)).runId,first.runId);const failed=db.collection(service.RUNS).rows.find(row=>row.status==='failed'&&row.active===false);assert.ok(failed);const resumed=await service.buildReadModel(db,{runId:failed.runId,maxAttempts:2},accounting);assert.equal(resumed.resumeCount,1);assert.equal((await service.activeRun(db)).runId,failed.runId);
});

test('missing governed policy, mapping, rate and discount remain explicit unavailable values',async()=>{
  for(const scenario of ['policy','mapping','rate','discount']){const db=dbSeed();if(scenario==='policy')db.collection('commissionPolicyVersions').rows=[];if(scenario==='mapping')db.collection('commissionCategoryMappings').rows=db.collection('commissionCategoryMappings').rows.filter(row=>row.identityValue!=='ITEM-NB');if(scenario==='rate')db.collection('commissionRateVersions').rows=db.collection('commissionRateVersions').rows.filter(row=>row.commissionRatePool!=='NOTEBOOK');if(scenario==='discount')Object.assign(db.collection('invoiceDiscountFacts').rows[0],{invoiceDiscountExact:'100.00',categoryAttributionStatus:'unresolved-multi-category'});await service.buildReadModel(db,{},accounting);const line=db.collection(service.LINES).rows.find(row=>row.saleLineIdentity==='LINE-1');assert.equal(line.commissionAvailability,'unavailable',scenario);assert.equal(line.draftCommissionExact,null,scenario);assert.ok(line.blockers.length,scenario);}
});

test('bounded retry succeeds, freshness notices mapping changes, and required query indexes exist',async()=>{
  const db=dbSeed();const collection=db.collection(service.LINES);const original=collection.bulkWrite.bind(collection);let attempts=0;collection.bulkWrite=async operations=>{attempts++;if(attempts===1)throw new Error('transient');return original(operations);};const built=await service.buildReadModel(db,{maxAttempts:2},accounting);assert.equal(built.retryCount,1);const initial=await service.freshness(db,manager);assert.equal(initial.stale,false);assert.equal(initial.mode,'fast-metadata');db.collection('userShayganMappings').rows[0].storeName='Changed Store';db.collection('userShayganMappings').rows[0].updatedAt=new Date('2026-08-02T00:00:00Z');assert.equal((await service.freshness(db,manager)).stale,true);const indexes=await db.collection(service.LINES).indexes();for(const field of ['saleLineIdentity','actualFifoProfitNumeric','invoiceGrossSaleAmountNumeric','policyAvailability','hasApprovedAdjustment','discountStatus','adjustmentEligibility'])assert.ok(indexes.some(index=>Object.keys(index.key).includes(field)),field);
});

test('partial cost and sale returns remain separately classified without source or adjustment writes',async()=>{
  const db=dbSeed();db.collection('fifoProfitFacts').rows.find(row=>row.saleLineIdentity==='LINE-2').costCoverageStatus='partial';db.collection('fifoProfitFacts').rows.push({factId:'FR',factContentHash:'HFR',fifoDatasetId:'FIFO-A',saleSnapshotId:'SALE-A',saleLineIdentity:'RETURN-1',saleInvoiceIdentity:'6:10',saleInvoiceType:6,saleInvoiceNumber:10,saleDate:'14050412',sellerIdentity:'11701013',sellerName:'امیر ممیزی',itemGuid:'ITEM-NB',itemCode:'NB-1',itemDescription:'Notebook return',quantityExact:'-1.000000',saleAmountExact:'-100000000.00',invoiceDiscountExact:'0.00',fifoCostExact:'-80000000.00',actualFifoProfitExact:'-20000000.00',costCoverageStatus:'complete'});db.collection('invoiceDiscountFacts').rows.push({discountFactId:'DR',saleSnapshotId:'SALE-A',saleInvoiceIdentity:'6:10',invoiceDiscountExact:'0.00',categoryAttributionStatus:'not-applicable',contentHash:'HDR'});db.collection('saleSnapshotDatasetHeaders').rows.push({snapshotId:'SALE-A',invTyp:6,invNo:10,storeName:'مشهد کالا',stockNumber:'1'});const beforeFacts=structuredClone(db.collection('fifoProfitFacts').rows);await service.buildReadModel(db,{},accounting);const costSummary=db.collection(service.SUMMARIES).rows.find(row=>row.dimension==='cost-status'&&row.costCoverageStatus==='partial');assert.equal(costSummary.partialCostLineCount,1);const sellerSummary=db.collection(service.SUMMARIES).rows.find(row=>row.dimension==='seller-month');assert.equal(sellerSummary.saleReturnQuantityExact,'-1.000000');assert.equal(sellerSummary.saleReturnValueExact,'-100000000.00');const returnTotals=await service.totals(db,{invoiceNumber:'10'},manager);assert.equal(returnTotals.provenProfitCoveragePercent,100);assert.deepEqual(db.collection('fifoProfitFacts').rows,beforeFacts);assert.equal(db.collection('profitAdjustments').rows.length,0);assert.equal(db.collection('savedProfitLedgerEntries').rows.length,0);
});

test('fingerprints are strict SHA-256 hex and canonical replay survives storage order changes',async()=>{
  const db=dbSeed();const built=await service.buildReadModel(db,{},accounting);for(const value of [built.sourceFingerprint,built.resultFingerprint])assert.match(value,/^[a-f0-9]{64}$/);const run=(await service.activeRun(db)).run;for(const field of ['sourceFingerprint','lineFingerprint','summaryFingerprint','resultFingerprint']){assert.equal(run[field].length,64,field);assert.match(run[field],/^[a-f0-9]{64}$/,field);}db.collection(service.SUMMARIES).rows.reverse();db.collection(service.LINES).rows.reverse();const integrity=await service.fingerprintIntegrity(db,manager);assert.equal(integrity.ok,true);assert.equal(integrity.details.summaryFingerprint.replayMatch,true);const deep=await service.deepVerify(db,{},accounting);assert.equal(deep.ok,true);assert.equal(deep.sourceReplayMatch,true);assert.equal(db.collection(service.VERIFICATIONS).rows[0].status,'completed');
});

test('discount states are exclusive and zero is never confused with unavailable',async()=>{
  const db=dbSeed(),facts=db.collection('fifoProfitFacts').rows,headers=db.collection('saleSnapshotDatasetHeaders').rows,discounts=db.collection('invoiceDiscountFacts').rows;const template=facts[0];
  for(let n=3;n<=7;n++){facts.push({...template,factId:`F${n}`,factContentHash:`HF${n}`,saleLineIdentity:`LINE-${n}`,saleInvoiceIdentity:`2:469${n}`,saleInvoiceNumber:4690+n,invoiceDiscountExact:'0.00',saleAmountExact:'1000.00'});headers.push({snapshotId:'SALE-A',invTyp:2,invNo:4690+n,storeName:'مشهد کالا',stockNumber:'1'});}
  discounts.push({discountFactId:'D3',saleSnapshotId:'SALE-A',saleInvoiceIdentity:'2:4693',invoiceDiscountExact:'25.00',categoryAttributionStatus:'resolved-single-category',contentHash:'HD3'});
  discounts.push({discountFactId:'D4',saleSnapshotId:'SALE-A',saleInvoiceIdentity:'2:4694',invoiceDiscountExact:'25.00',allocatedInvoiceDiscountExact:'25.00',allocationStatus:'completed',categoryAttributionStatus:'resolved-single-category',contentHash:'HD4'});
  discounts.push({discountFactId:'D5',saleSnapshotId:'SALE-A',saleInvoiceIdentity:'2:4695',invoiceDiscountExact:'25.00',categoryAttributionStatus:'unresolved-multi-category',contentHash:'HD5'});
  discounts.push({discountFactId:'D7',saleSnapshotId:'SALE-A',saleInvoiceIdentity:'2:4697',invoiceDiscountExact:'25.00',categoryAttributionStatus:'source-conflict',contentHash:'HD7'});
  await service.buildReadModel(db,{},accounting);const byLine=new Map(db.collection(service.LINES).rows.map(row=>[row.saleLineIdentity,row.discountStatus]));assert.equal(byLine.get('LINE-1'),'official_line_discount');assert.equal(byLine.get('LINE-2'),'official_zero_discount');assert.equal(byLine.get('LINE-3'),'official_nonzero_invoice_discount');assert.equal(byLine.get('LINE-4'),'allocation_completed');assert.equal(byLine.get('LINE-5'),'allocation_unresolved');assert.equal(byLine.get('LINE-6'),'source_unavailable');assert.equal(byLine.get('LINE-7'),'source_conflict');const report=await service.discountStatusReport(db,manager);assert.equal(report.states.length,7);assert.equal(report.totalLines,7);
});

test('adjustment eligibility blocks incomplete governance, incomplete cost and stale runs',async()=>{
  const db=dbSeed();await service.buildReadModel(db,{},accounting);let report=await service.listLines(db,{pageSize:10},manager);const complete=report.list.find(row=>row.saleLineIdentity==='LINE-1'),unknown=report.list.find(row=>row.saleLineIdentity==='LINE-2');assert.equal(complete.adjustmentEligibility,'eligible_candidate');assert.deepEqual(complete.adjustmentBlockers,[]);assert.equal(unknown.adjustmentEligibility,'ineligible');assert.ok(unknown.adjustmentBlockers.includes('cost-unknown'));db.collection('commissionRateVersions').rows[0].updatedAt=new Date('2026-08-03T00:00:00Z');report=await service.listLines(db,{pageSize:10},manager);assert.equal(report.readModelStale,true);assert.ok(report.list.find(row=>row.saleLineIdentity==='LINE-1').adjustmentBlockers.includes('stale-read-model-run'));
});

test('governance coverage and source recency use approved rows and keep financial and sales dates separate',async()=>{
  const db=dbSeed();db.collection('commissionCategoryMappings').rows.push({...db.collection('commissionCategoryMappings').rows[0],mappingId:'DRAFT',status:'draft'});db.collection('saleSnapshots').rows.push({snapshotId:'SALE-B',status:'completed',createdAt:new Date('2026-08-04T00:00:00Z')});db.collection('saleSnapshotState').rows.push({scopeKey:'sale-type2|14050101|14050514',activeSnapshotId:'SALE-B',activatedAt:new Date('2026-08-04T00:00:00Z')});db.collection('saleSnapshotDatasetHeaders').rows.push({snapshotId:'SALE-B',invTyp:2,invNo:5000});db.collection('saleSnapshotDatasetLines').rows.push({snapshotId:'SALE-B',saleInvoiceType:2,saleInvoiceNo:5000,row:1,saleDate:'14050514',saleValue:3000000000});await service.buildReadModel(db,{},accounting);const run=(await service.activeRun(db)).run;assert.equal(run.sourceRecency.fifoLinkedSaleSnapshotId,'SALE-A');assert.equal(run.sourceRecency.latestLiveSaleSnapshotId,'SALE-B');assert.equal(run.sourceRecency.financialDataThrough,'14050411');assert.equal(run.sourceRecency.salesDataThrough,'14050514');const coverage=await service.governanceCoverage(db,manager);assert.equal(coverage.approvedMappings,2);assert.equal(coverage.approvedOnly,true);assert.equal(coverage.automaticApproval,false);
});

test('two deterministic rebuilds record bounded process memory samples without retaining source arrays',async()=>{
  const db=dbSeed();const first=await service.buildReadModel(db,{},accounting);const second=await service.buildReadModel(db,{},accounting);assert.equal(first.resultFingerprint,second.resultFingerprint);const run=(await service.activeRun(db)).run;assert.ok(run.memorySamples.length>=5);assert.ok(run.peakRssBytes>=run.memorySamples[0].rssBytes);assert.ok(run.memorySamples.every(sample=>Number.isFinite(sample.heapUsedBytes)&&Number.isFinite(sample.externalBytes)));
});

test('seller is denied and projection source contract has no forbidden write integration',async()=>{
  const db=dbSeed();await assert.rejects(service.status(db,true,seller),error=>error.code==='SELLER_FINANCIAL_FORBIDDEN');const source=fs.readFileSync(path.join(__dirname,'../src/lib/seller-financial-performance.js'),'utf8');for(const forbidden of ['Invoice/Put','PutSaleInvoice','PutBuyInvoice','supplierPurchaseLayers.update','fifoProfitFacts.update','saleSnapshotDatasetLines.update','itemInventoryCatalog.update'])assert.equal(source.includes(forbidden),false,forbidden);
});

test('validated FIFO candidate builds a non-active non-payroll Seller Financial candidate selectable by runId',async()=>{
  const db=dbSeed(),binding=bindActiveCandidate(db);for(const fact of db.collection('fifoProfitFacts').rows)Object.assign(fact,{candidateOnly:true,active:false,nonPayable:true,profitFactsDatasetId:'PFACT-CANDIDATE'});
  const built=await service.buildReadModel(db,binding,accounting);
  assert.equal(built.candidateOnly,true);assert.equal(built.active,false);assert.equal(built.activationStatus,'validated-candidate');assert.equal(await service.activeRun(db),null);
  const run=db.collection(service.RUNS).rows.find(row=>row.runId===built.runId);assert.equal(run.active,false);assert.equal(run.nonPayable,true);assert.equal(run.sourceProfitFactsDatasetId,'PFACT-CANDIDATE');assert.equal(run.commissionCreated,false);assert.equal(run.payrollAuthority,false);
  const report=await service.listLines(db,{runId:built.runId,provenanceStatus:'PROVEN'},manager);assert.equal(report.total,1);assert.equal(report.candidateOnly,true);assert.equal(report.list[0].purchaseInvoiceNumbers[0],7001);
  const totals=await service.totals(db,{runId:built.runId},manager);assert.equal(totals.active,false);assert.equal(totals.nonPayroll,true);assert.equal(totals.unknownExposureLineCount,1);
  const categories=await service.categoryTotals(db,{runId:built.runId,provenanceStatus:'PROVEN',categoryGuid:'NB'},manager);assert.equal(categories.total,1);assert.equal(categories.list[0].officialProductCategoryName,'NOTEBOOK');assert.equal(categories.list[0].canonicalCategoryGuid,'NB');assert.equal(categories.list[0].unknownOrPartialSaleValueExact,'0.00');
  const drill=await service.lineDrilldown(db,'LINE-1',manager,{runId:built.runId});assert.equal(drill.candidateOnly,true);assert.equal(drill.source.costProvenance[0].purchaseInvoiceNumber,7001);
});

test('completed Candidate remains an explicit read target when no Active Seller Financial exists',async()=>{
  const db=dbSeed(),binding=bindActiveCandidate(db);for(const fact of db.collection('fifoProfitFacts').rows)Object.assign(fact,{candidateOnly:true,active:false,nonPayable:true,profitFactsDatasetId:'PFACT-CANDIDATE'});
  const built=await service.buildReadModel(db,binding,accounting),status=await service.status(db,true,manager),runs=await service.listRuns(db,{pageSize:100},manager);
  assert.equal(status.activeRunId,'');assert.equal(status.latestRun.runId,built.runId);assert.equal(runs.activeRunId,'');assert.equal(runs.list[0].runId,built.runId);assert.equal(runs.list[0].status,'completed');assert.equal(runs.list[0].candidateOnly,true);
  await assert.rejects(service.totals(db,{},manager),error=>error.code==='SELLER_FINANCIAL_ACTIVE_RUN_MISSING');
  const totals=await service.totals(db,{runId:built.runId},manager),filters=await service.filterOptions(db,{runId:built.runId},manager),summaries=await service.listSummaries(db,{runId:built.runId},manager);
  assert.equal(totals.runId,built.runId);assert.equal(filters.runId,built.runId);assert.equal(summaries.runId,built.runId);assert.equal(totals.active,false);assert.equal(totals.candidateOnly,true);assert.equal(totals.nonPayable,true);
});

test('canonical build context resolves immutable lineage from FIFO authority and aligns build roles',async()=>{
  const db=dbSeed(),binding=bindActiveCandidate(db);const adminContext=await service.buildContext(db,{username:'admin',role:'admin'}),managerContext=await service.buildContext(db,manager);
  assert.deepEqual(adminContext.activeFifo,{datasetId:'FIFO-A',authorityRevision:7,saleSnapshotId:'SALE-A',purchaseDatasetId:'PURCHASE-A',openingDatasetId:'OPENING-A',sourceFingerprint:binding.expectedFifoSourceFingerprint,allocationFingerprint:binding.expectedFifoAllocationFingerprint,candidateFingerprint:binding.expectedFifoCandidateFingerprint,status:'completed',activationStatus:'validated-candidate',immutable:true});
  assert.equal(adminContext.canBuild,true);assert.equal(managerContext.canBuild,false);assert.deepEqual(adminContext.buildRoles,['admin','accounting']);assert.deepEqual(adminContext.resultContract,{active:false,candidateOnly:true,nonPayable:true,activationStatus:'validated-candidate',commissionCreated:false,activationSeparate:true});
});

test('canonical Candidate build fails closed without Active FIFO and rejects stale or changed authority binding',async()=>{
  const db=dbSeed(),binding=bindActiveCandidate(db);
  db.collection('fifoDatasetState').rows=[];
  await assert.rejects(service.assertCanonicalBuildBinding(db,binding),error=>error.code==='SELLER_FINANCIAL_ACTIVE_FIFO_MISSING');
  db.collection('fifoDatasetState').rows=[{scopeKey:fifo.SCOPE_KEY,activeDatasetId:'FIFO-A',authorityRevision:7}];
  await assert.rejects(service.assertCanonicalBuildBinding(db,{...binding,fifoDatasetId:'FIFO-OLD'}),error=>error.code==='SELLER_FINANCIAL_ACTIVE_FIFO_STALE');
  const pageContext=await service.buildContext(db,accounting);db.collection('fifoDatasetState').rows[0].authorityRevision=8;
  await assert.rejects(service.assertCanonicalBuildBinding(db,{fifoDatasetId:pageContext.activeFifo.datasetId,expectedActiveFifoDatasetId:pageContext.activeFifo.datasetId,expectedFifoAuthorityRevision:pageContext.activeFifo.authorityRevision,expectedFifoSourceFingerprint:pageContext.activeFifo.sourceFingerprint,expectedFifoAllocationFingerprint:pageContext.activeFifo.allocationFingerprint,expectedFifoCandidateFingerprint:pageContext.activeFifo.candidateFingerprint,candidateOnly:true}),error=>error.code==='SELLER_FINANCIAL_ACTIVE_FIFO_STALE');
});

test('canonical Candidate duplicate guard returns the existing immutable Candidate',async()=>{
  const db=dbSeed(),binding=bindActiveCandidate(db);for(const fact of db.collection('fifoProfitFacts').rows)Object.assign(fact,{candidateOnly:true,active:false,nonPayable:true,profitFactsDatasetId:'PFACT-CANDIDATE'});
  const first=await service.buildReadModel(db,binding,accounting),second=await service.buildReadModel(db,binding,accounting);
  assert.equal(second.duplicate,true);assert.equal(second.runId,first.runId);assert.equal(db.collection(service.RUNS).rows.filter(row=>row.candidateOnly===true&&row.status==='completed').length,1);assert.equal(await service.activeRun(db),null);
});

test('separate activation requires independent fingerprint-bound Human PASS and immutable audit',async()=>{
  const db=dbSeed(),binding=bindActiveCandidate(db);for(const fact of db.collection('fifoProfitFacts').rows)Object.assign(fact,{candidateOnly:true,active:false,nonPayable:true,profitFactsDatasetId:'PFACT-CANDIDATE'});
  const admin={username:'admin',role:'admin'},built=await service.buildReadModel(db,binding,admin);
  await assert.rejects(service.activateCandidate(db,built.runId,{candidateFingerprint:built.candidateFingerprint,humanValidationId:'missing',expectedPreviousActiveSellerFinancialId:'',reason:'activate'},manager),error=>error.code==='SELLER_FINANCIAL_HUMAN_VALIDATION_REQUIRED');
  await assert.rejects(service.recordHumanValidation(db,built.runId,{candidateFingerprint:built.candidateFingerprint,result:'PASS',reason:'self validation'},admin),error=>error.code==='SELLER_FINANCIAL_SELF_VALIDATION_FORBIDDEN');
  const validation=await service.recordHumanValidation(db,built.runId,{candidateFingerprint:built.candidateFingerprint,result:'PASS',reason:'Human validation cards completed independently'},manager);
  db.collection('fifoDatasetState').rows[0].authorityRevision=8;
  await assert.rejects(service.activateCandidate(db,built.runId,{candidateFingerprint:built.candidateFingerprint,humanValidationId:validation.validation.validationId,expectedPreviousActiveSellerFinancialId:'',reason:'activate stale Candidate'},manager),error=>error.code==='SELLER_FINANCIAL_ACTIVATION_FIFO_AUTHORITY_CHANGED');
  db.collection('fifoDatasetState').rows[0].authorityRevision=7;
  const activated=await service.activateCandidate(db,built.runId,{candidateFingerprint:built.candidateFingerprint,humanValidationId:validation.validation.validationId,expectedPreviousActiveSellerFinancialId:'',reason:'Management-authorized authority transition'},manager);
  assert.equal(activated.newActiveSellerFinancialId,built.runId);assert.equal(activated.nonPayable,true);assert.equal(activated.commissionCreated,false);assert.equal(db.collection(service.ACTIVATION_AUDITS).rows.length,1);assert.equal(db.collection(service.ACTIVATION_AUDITS).rows[0].immutable,true);
  const run=db.collection(service.RUNS).rows.find(row=>row.runId===built.runId);assert.equal(run.active,true);assert.equal(run.nonPayable,true);assert.equal(run.payrollAuthority,false);assert.equal(run.commissionCreated,false);
});

test('existing seller-profit UI is upgraded without a duplicate page and keeps financial safety labels',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');const phase=ui.slice(ui.lastIndexOf('/* Phase C final registry'));
  assert.match(phase,/const PAGE='seller-profit'/);assert.match(phase,/عملکرد مالی فروشندگان/);assert.match(phase,/officialProductCategoryName/);assert.match(phase,/commissionRatePool/);assert.match(phase,/PRELIMINARY \/ NON-PAYABLE/);assert.match(phase,/invoiceAmountMin/);assert.match(phase,/fifoProfitMin/);assert.match(phase,/mkcrm-seller-financial-presets/);assert.match(phase,/ALLOWED=\['admin','accounting','manager','purchase'\]/);assert.doesNotMatch(phase,/ALLOWED=.*seller/);
});

test('canonical UI has read-only Active FIFO lineage, explicit Candidate confirmation, and no legacy rebuild call',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');const phase=ui.slice(ui.lastIndexOf('/* Phase C final registry'));
  for(const contract of ['sfCandidateBuild','ساخت Read Model کاندیدا','seller-financial-performance/build-context','expectedActiveFifoDatasetId','expectedFifoAuthorityRevision','expectedFifoSourceFingerprint','expectedFifoAllocationFingerprint','expectedFifoCandidateFingerprint','Inactive','Candidate Only','Non-Payable','Commission','Separate governed action','CURRENT ACTIVE SELLER FINANCIAL','LATEST CANDIDATE'])assert.match(phase,new RegExp(contract));
  assert.match(phase,/\['admin','accounting'\]\.includes\(userRole\(\)\)/);assert.doesNotMatch(phase,/seller-financial-performance\/rebuild/);assert.doesNotMatch(phase,/sfFifoCandidate/);
});

test('canonical seller financial renderer remains the final seller-profit route authority',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  const phaseStart=ui.lastIndexOf('/* Phase C final registry');
  assert.ok(phaseStart>=0);
  const afterCanonicalAssignment=ui.slice(ui.indexOf('window.pageSellerProfit=pageRenderer;',phaseStart));
  assert.doesNotMatch(afterCanonicalAssignment,/window\.pageSellerProfit\s*=\s*window\.__candidateSellerFinancialPage/);
  assert.doesNotMatch(afterCanonicalAssignment,/return window\.__candidateSellerFinancialPage\(\)/);
});

test('canonical Seller Financial read path selects and preserves an explicit completed run',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');const phase=ui.slice(ui.lastIndexOf('/* Phase C final registry'));
  for(const contract of ['id="sfRun"','SELECTED READ MODEL','CANDIDATE / INACTIVE / NON-PAYABLE','mkcrm-seller-financial-selected-run','runId:selectedReadRun()','provenanceStatus:selected(\'#sfProvenance\')','validStored||active||latestCandidate','seller-financial-performance/filters','runScopedUrl','sourceFifoDatasetId'])assert.ok(phase.includes(contract),`missing ${contract}`);
  assert.match(phase,/control\.onchange=async\(\)=>\{rememberSelectedRun\(control\.value\);[\s\S]*?await loadOptions\(\);await refresh\(\);\}/);
  assert.match(phase,/invoices\/\$\{encodeURIComponent\(invoice\)\}\/lines\?pageSize=500/);
  assert.match(phase,/lines\/\$\{encodeURIComponent\(line\)\}\/drilldown/);
  assert.match(phase,/__sellerFinancialRenderGeneration/);assert.match(phase,/requestKey!==params\(\)\.toString\(\)/);assert.match(phase,/if\(!isCurrent\(\)\)return/);
  const selectorHandler=phase.match(/control\.onchange=async\(\)=>\{([\s\S]*?)\};return r;/)?.[1]||'';
  assert.doesNotMatch(selectorHandler,/candidate-build|buildCandidate|activate|commission/i);
});

test('seller financial UI uses stable category GUID and idempotent selector rendering',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  assert.match(ui,/categoryGuid:q\('#csfCategory'\)/);assert.match(ui,/categoryGuid:selected\('#sfCategory'\)/);assert.match(ui,/optionRows\(r\.categories,'guid','label'\)/);
  assert.doesNotMatch(ui,/csfCategory'\)\.innerHTML\+=/);assert.doesNotMatch(ui,/csfSeller'\)\.innerHTML\+=/);
});
