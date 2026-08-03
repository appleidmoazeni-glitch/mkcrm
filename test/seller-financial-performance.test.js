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

function dbSeed(){return new MemoryDb({
  fifoDatasetState:[{scopeKey:fifo.SCOPE_KEY,activeDatasetId:'FIFO-A'}],
  fifoDatasets:[{datasetId:'FIFO-A',status:'completed',activationStatus:'validated-shadow',sourceSaleSnapshotId:'SALE-A',sourceFingerprint:'SOURCE-A',allocationFingerprint:'ALLOC-A'}],
  fifoProfitFacts:[
    {factId:'F1',factContentHash:'HF1',fifoDatasetId:'FIFO-A',saleSnapshotId:'SALE-A',saleLineIdentity:'LINE-1',saleInvoiceIdentity:'2:4691',saleInvoiceType:2,saleInvoiceNumber:4691,saleDate:'14050410',sellerIdentity:'11701013',sellerName:'امیر ممیزی',itemGuid:'ITEM-NB',itemCode:'NB-1',itemDescription:'Notebook',quantityExact:'1.000000',saleAmountExact:'2500000000.00',invoiceDiscountExact:'1000000.00',fifoCostExact:'2100000000.00',actualFifoProfitExact:'400000000.00',costCoverageStatus:'complete'},
    {factId:'F2',factContentHash:'HF2',fifoDatasetId:'FIFO-A',saleSnapshotId:'SALE-A',saleLineIdentity:'LINE-2',saleInvoiceIdentity:'2:4692',saleInvoiceType:2,saleInvoiceNumber:4692,saleDate:'14050411',sellerIdentity:'11701013',sellerName:'امیر ممیزی',itemGuid:'ITEM-CPU',itemCode:'CPU-1',itemDescription:'CPU',quantityExact:'2.000000',saleAmountExact:'100000000.00',invoiceDiscountExact:'0.00',fifoCostExact:null,actualFifoProfitExact:null,costCoverageStatus:'unknown'}
  ],
  fifoAllocations:[{datasetId:'FIFO-A',allocationId:'A1',saleLineId:'LINE-1',allocationSequence:1,sourceType:'official_purchase_layer',purchaseLayerId:'PL-1',quantityExact:'1.000000',allocatedCostAmountExact:'2100000000.00'}],
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
  userShayganMappings:[{username:'seller-user',employeeAccountNumber:'11701013',storeName:'مشهد کالا',isActive:true}],
  users:[{username:'seller-user',fullName:'امیر ممیزی',role:'seller',isActive:true}],
  profitAdjustments:[],savedProfitLedgerEntries:[]
});}

test('build creates an isolated active projection with exact values and explicit unavailable cost',async()=>{
  const db=dbSeed();const result=await service.buildReadModel(db,{batchSize:50},accounting);assert.equal(result.ok,true);assert.equal(result.lineCount,2);assert.equal((await service.activeRun(db)).runId,result.runId);
  const line=db.collection(service.LINES).rows.find(row=>row.saleLineIdentity==='LINE-1');assert.equal(line.actualFifoProfitExact,'400000000.00');assert.equal(line.commissionableProfitExact,'400000000.00');assert.equal(line.preliminaryCommissionExact,'56000000.00');assert.equal(line.officialProductCategoryName,'NOTEBOOK');assert.equal(line.commissionRatePool,'NOTEBOOK');assert.equal(line.policyVersionId,'POL-TIR');assert.equal(line.rateVersionId,'RATE-NB');assert.equal(line.nonPayable,true);
  const unknown=db.collection(service.LINES).rows.find(row=>row.saleLineIdentity==='LINE-2');assert.equal(unknown.actualFifoProfitExact,null);assert.equal(unknown.preliminaryCommissionExact,null);assert.equal(unknown.commissionStatus,'unavailable');assert.ok(unknown.blockers.includes('cost-unknown'));
  const totals=await service.totals(db,{dateFrom:'14050401',dateTo:'14050431'},manager);assert.equal(totals.lineCount,2);assert.equal(totals.invoiceCount,2);assert.equal(totals.unknownCostLineCount,1);assert.equal(totals.nonPayable,true);
  const invoices=await service.listInvoices(db,{dateFrom:'14050401',dateTo:'14050431'},manager);assert.equal(invoices.total,2);const invoiceLines=await service.listInvoiceLines(db,'2:4691',{},manager);assert.equal(invoiceLines.total,1);const drill=await service.lineDrilldown(db,'LINE-1',manager);assert.equal(drill.source.allocations[0].purchaseLayerId,'PL-1');assert.deepEqual(line.allocationIds,['A1']);
  const summary=db.collection(service.SUMMARIES).rows.find(row=>row.dimension==='seller-month');assert.equal(summary.saleValueExact,'2600000000.00');assert.equal(summary.unknownCostLineCount,1);assert.equal(summary.knownFifoProfitExact,'400000000.00');
  assert.equal(db.collection('fifoProfitFacts').rows[0].actualFifoProfitExact,'400000000.00');
});

test('server-side filters support Tir, seller, category, invoice value and FIFO profit thresholds',async()=>{
  const db=dbSeed();await service.buildReadModel(db,{},accounting);const report=await service.listLines(db,{dateFrom:'۱۴۰۵/۰۴/۰۱',dateTo:'1405-04-31',sellerIdentity:'11701013',category:'NOTEBOOK',invoiceAmountMin:'2000000000',fifoProfitMin:'300000000',pageSize:10},manager);assert.equal(report.total,1);assert.equal(report.list[0].saleInvoiceNumber,4691);assert.equal(report.serverSide,true);
  const below=await service.listLines(db,{category:'NOTEBOOK',fifoProfitMax:'50000000'},purchase);assert.equal(below.total,0);
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
  const db=dbSeed();const collection=db.collection(service.LINES);const original=collection.bulkWrite.bind(collection);let attempts=0;collection.bulkWrite=async operations=>{attempts++;if(attempts===1)throw new Error('transient');return original(operations);};const built=await service.buildReadModel(db,{maxAttempts:2},accounting);assert.equal(built.retryCount,1);assert.equal((await service.freshness(db,manager)).stale,false);db.collection('userShayganMappings').rows[0].storeName='Changed Store';assert.equal((await service.freshness(db,manager)).stale,true);const indexes=await db.collection(service.LINES).indexes();for(const field of ['saleLineIdentity','actualFifoProfitNumeric','invoiceGrossSaleAmountNumeric','policyAvailability','hasApprovedAdjustment'])assert.ok(indexes.some(index=>Object.keys(index.key).includes(field)),field);
});

test('partial cost and sale returns remain separately classified without source or adjustment writes',async()=>{
  const db=dbSeed();db.collection('fifoProfitFacts').rows.find(row=>row.saleLineIdentity==='LINE-2').costCoverageStatus='partial';db.collection('fifoProfitFacts').rows.push({factId:'FR',factContentHash:'HFR',fifoDatasetId:'FIFO-A',saleSnapshotId:'SALE-A',saleLineIdentity:'RETURN-1',saleInvoiceIdentity:'6:10',saleInvoiceType:6,saleInvoiceNumber:10,saleDate:'14050412',sellerIdentity:'11701013',sellerName:'امیر ممیزی',itemGuid:'ITEM-NB',itemCode:'NB-1',itemDescription:'Notebook return',quantityExact:'-1.000000',saleAmountExact:'-100000000.00',invoiceDiscountExact:'0.00',fifoCostExact:'-80000000.00',actualFifoProfitExact:'-20000000.00',costCoverageStatus:'complete'});db.collection('invoiceDiscountFacts').rows.push({discountFactId:'DR',saleSnapshotId:'SALE-A',saleInvoiceIdentity:'6:10',invoiceDiscountExact:'0.00',categoryAttributionStatus:'not-applicable',contentHash:'HDR'});db.collection('saleSnapshotDatasetHeaders').rows.push({snapshotId:'SALE-A',invTyp:6,invNo:10,storeName:'مشهد کالا',stockNumber:'1'});const beforeFacts=structuredClone(db.collection('fifoProfitFacts').rows);await service.buildReadModel(db,{},accounting);const costSummary=db.collection(service.SUMMARIES).rows.find(row=>row.dimension==='cost-status'&&row.costCoverageStatus==='partial');assert.equal(costSummary.partialCostLineCount,1);const sellerSummary=db.collection(service.SUMMARIES).rows.find(row=>row.dimension==='seller-month');assert.equal(sellerSummary.saleReturnQuantityExact,'-1.000000');assert.equal(sellerSummary.saleReturnValueExact,'-100000000.00');assert.deepEqual(db.collection('fifoProfitFacts').rows,beforeFacts);assert.equal(db.collection('profitAdjustments').rows.length,0);assert.equal(db.collection('savedProfitLedgerEntries').rows.length,0);
});

test('seller is denied and projection source contract has no forbidden write integration',async()=>{
  const db=dbSeed();await assert.rejects(service.status(db,true,seller),error=>error.code==='SELLER_FINANCIAL_FORBIDDEN');const source=fs.readFileSync(path.join(__dirname,'../src/lib/seller-financial-performance.js'),'utf8');for(const forbidden of ['Invoice/Put','PutSaleInvoice','PutBuyInvoice','supplierPurchaseLayers.update','fifoProfitFacts.update','saleSnapshotDatasetLines.update','itemInventoryCatalog.update'])assert.equal(source.includes(forbidden),false,forbidden);
});

test('existing seller-profit UI is upgraded without a duplicate page and keeps financial safety labels',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');const phase=ui.slice(ui.lastIndexOf('/* Phase C final registry'));
  assert.match(phase,/const PAGE='seller-profit'/);assert.match(phase,/عملکرد مالی فروشندگان/);assert.match(phase,/officialProductCategoryName/);assert.match(phase,/commissionRatePool/);assert.match(phase,/PRELIMINARY \/ NON-PAYABLE/);assert.match(phase,/invoiceAmountMin/);assert.match(phase,/fifoProfitMin/);assert.match(phase,/mkcrm-seller-financial-presets/);assert.match(phase,/ALLOWED=\['admin','accounting','manager','purchase'\]/);assert.doesNotMatch(phase,/ALLOWED=.*seller/);
});
