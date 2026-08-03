'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryDb } = require('./helpers/memory-mongo');
const decimal = require('../src/lib/accounting-decimal');
const readiness = require('../src/lib/accounting-evidence-confidence');
const fifo = require('../src/lib/fifo-shadow-engine');

const accounting = { username:'accountant-1', role:'accounting' };
const manager = { username:'manager-1', role:'manager' };

function sale(overrides = {}) {
  return {
    snapshotId:'SALE-ACTIVE',
    saleLineId:'SL-2-1-1-A',
    saleInvoiceType:2,
    saleInvoiceNo:1,
    saleGuid:'SALE-GUID-1',
    saleDate:'14050110',
    row:1,
    itemGuid:'GUID-A',
    itemCode:'A',
    itemName:'Item A',
    qty:3,
    saleValue:3000,
    ...overrides
  };
}
function layer(overrides = {}) {
  return {
    datasetId:'PURCHASE-ACTIVE',
    purchaseLineIdentity:'PL-A',
    layerKind:'purchase',
    validationStatus:'valid',
    returnMatchStatus:'not-applicable',
    purchaseInvoiceDate:'14050101',
    purchaseInvoiceNo:10,
    sourceRow:1,
    purchaseInvoiceGuid:'PURCHASE-GUID',
    supplierAccountNumber:'SUP-1',
    itemGuid:'GUID-A',
    itemCode:'A',
    originalQuantity:2,
    netPurchasedQuantity:2,
    netUnitCost:'951860416.64',
    ...overrides
  };
}
function seedDb() {
  return new MemoryDb({
    saleSnapshotState:[{ scopeKey:'sale-type2|14050101|', activeSnapshotId:'SALE-ACTIVE', activatedAt:new Date() }],
    saleSnapshots:[{ snapshotId:'SALE-ACTIVE', status:'completed', activationStatus:'active' }],
    saleSnapshotDatasetHeaders:[
      { snapshotId:'SALE-ACTIVE', invTyp:2, invNo:1, guId:'SALE-GUID-1' },
      { snapshotId:'SALE-ACTIVE', invTyp:2, invNo:2, guId:'SALE-GUID-2' },
      { snapshotId:'SALE-ACTIVE', invTyp:6, invNo:3, guId:'RETURN-GUID', relatedInvHeaderId:'SALE-GUID-1' }
    ],
    saleSnapshotDatasetLines:[
      sale(),
      sale({ saleLineId:'SL-2-2-1-B', saleInvoiceNo:2, saleGuid:'SALE-GUID-2', itemGuid:'GUID-B', itemCode:'B', itemName:'Item B', qty:4, saleValue:8000 }),
      sale({ saleLineId:'SL-6-3-1-A', saleInvoiceType:6, saleInvoiceNo:3, saleGuid:'RETURN-GUID', relatedInvHeaderId:'SALE-GUID-1', qty:1, saleValue:1000 })
    ],
    purchaseLayerDatasetState:[{ scopeKey:'purchase-invoices-types-3-7', activeDatasetId:'PURCHASE-ACTIVE' }],
    purchaseLayerDatasets:[{ datasetId:'PURCHASE-ACTIVE', status:'completed', activationStatus:'active' }],
    supplierPurchaseLayers:[
      layer(),
      layer({
        purchaseLineIdentity:'PR-A',
        layerKind:'purchase-return',
        purchaseInvoiceNo:11,
        purchaseInvoiceDate:'14050105',
        originalQuantity:1,
        netPurchasedQuantity:null,
        netUnitCost:null,
        returnMatchStatus:'unmatched',
        returnInvHeaderReference:'UNKNOWN'
      })
    ],
    manualCostResolutions:[],
    fifoDatasets:[{
      datasetId:'FIFO-V1',
      status:'completed',
      activationStatus:'validated-shadow',
      algorithmVersion:'fifo-shadow-1.0.0',
      sourceSaleSnapshotId:'SALE-ACTIVE',
      sourcePurchaseDatasetId:'PURCHASE-ACTIVE',
      deterministicReplayVerified:true,
      validation:{
        valid:true,duplicateAllocationCount:0,layerOverConsumptionCount:0,orphanLayerCount:0,
        inactiveSourceCount:0,monetaryReconciliationDifferenceExact:'0.00'
      }
    }],
    fifoDatasetState:[{ scopeKey:'fifo-shadow-v1', activeDatasetId:'FIFO-V1' }],
    fifoAllocations:[
      {
        datasetId:'FIFO-V1',allocationId:'A-1',allocationSequence:1,saleLineId:'SL-2-1-1-A',
        saleInvoiceType:2,saleInvoiceNo:1,saleDate:'14050110',itemGuid:'GUID-A',itemCode:'A',
        itemDescription:'Item A',sourceType:'official_purchase_layer',allocatedQty:2,unknownQty:0,
        allocatedSaleValue:2000,unitCost:100,allocatedCostAmount:200,purchaseLineIdentity:'PL-A'
      },
      {
        datasetId:'FIFO-V1',allocationId:'A-2',allocationSequence:2,saleLineId:'SL-2-1-1-A',
        saleInvoiceType:2,saleInvoiceNo:1,saleDate:'14050110',itemGuid:'GUID-A',itemCode:'A',
        itemDescription:'Item A',sourceType:'unknown_cost',allocatedQty:0,unknownQty:1,
        allocatedSaleValue:1000,unitCost:null,allocatedCostAmount:null,unknownReason:'official_layer_quantity_exhausted'
      },
      {
        datasetId:'FIFO-V1',allocationId:'B-1',allocationSequence:1,saleLineId:'SL-2-2-1-B',
        saleInvoiceType:2,saleInvoiceNo:2,saleDate:'14050110',itemGuid:'GUID-B',itemCode:'B',
        itemDescription:'Item B',sourceType:'unknown_cost',allocatedQty:0,unknownQty:4,
        allocatedSaleValue:8000,unitCost:null,allocatedCostAmount:null,unknownReason:'no_valid_cost_source'
      }
    ],
    fifoExceptions:[
      { datasetId:'FIFO-V1',exceptionKey:'E1',code:'UNKNOWN_COST',status:'unresolved',itemGuid:'GUID-A',itemCode:'A',saleLineId:'SL-2-1-1-A' },
      { datasetId:'FIFO-V1',exceptionKey:'E2',code:'UNKNOWN_COST',status:'unresolved',itemGuid:'GUID-B',itemCode:'B',saleLineId:'SL-2-2-1-B' },
      { datasetId:'FIFO-V1',exceptionKey:'E3',code:'PURCHASE_RETURN_STATUS',status:'unresolved',itemGuid:'GUID-A',itemCode:'A',purchaseLineIdentity:'PR-A' },
      { datasetId:'FIFO-V1',exceptionKey:'E4',code:'SALE_RETURN_NOT_ALLOCATED',status:'unresolved',itemGuid:'GUID-A',itemCode:'A',saleReturnLineId:'SL-6-3-1-A' }
    ],
    fifoDiagnostics:[],
    accountingCostEvidence:[],
    purchaseReturnResolutions:[],
    saleReturnResolutions:[],
    accountingValidationSamples:[],
    accountingReadinessState:[],
    itemInventoryCatalog:[{ itemCode:'A',stockNumber:1,quantity:5 },{ itemCode:'B',stockNumber:1,quantity:0 }]
  });
}

test('fixed-scale monetary model preserves large IRR and fractional quantities deterministically', () => {
  const first=decimal.allocation('0.333333','951860416.64');
  const second=decimal.allocation('0.333333','951860416.64');
  assert.deepEqual(first,second);
  assert.equal(first.quantityExact,'0.333333');
  assert.equal(first.unitCostExact,'951860416.640000');
  assert.equal(first.allocationValueExact,'317286488.26');
  assert.equal(decimal.allocation('-0.333333','951860416.64').allocationValueExact,'-317286488.26');
});

test('half-away-from-zero rounding is explicit for positive and negative allocation values', () => {
  assert.equal(decimal.allocation('0.005','1').allocationValueExact,'0.01');
  assert.equal(decimal.allocation('-0.005','1').allocationValueExact,'-0.01');
});

test('synchronization creates prioritized evidence, return queues and accounting samples without changing official sources', async () => {
  const db=seedDb();
  const officialBefore=structuredClone(db.collection('supplierPurchaseLayers').rows);
  const salesBefore=structuredClone(db.collection('saleSnapshotDatasetLines').rows);
  const result=await readiness.synchronize(db,accounting);
  assert.equal(result.ok,true);
  assert.equal(result.evidence.total,2);
  assert.equal(result.purchaseReturns.total,1);
  assert.equal(result.saleReturns.total,1);
  assert.deepEqual(db.collection('supplierPurchaseLayers').rows,officialBefore);
  assert.deepEqual(db.collection('saleSnapshotDatasetLines').rows,salesBefore);
  const evidence=db.collection(readiness.EVIDENCE).rows;
  assert.equal(evidence[0].auditLog.length,1);
  assert.ok(evidence.some(row=>row.priority==='P0'));
  assert.ok(db.collection(readiness.SAMPLES).rows.length>=1);
});

test('a new FIFO dataset preserves historical evidence but exposes only the active queue by default', async () => {
  const db=seedDb();
  await readiness.synchronize(db,accounting);
  db.collection('fifoDatasets').rows.push({
    ...structuredClone(db.collection('fifoDatasets').rows[0]),
    datasetId:'FIFO-V2',
    algorithmVersion:readiness.ALGORITHM_VERSION
  });
  db.collection('fifoDatasetState').rows.push({scopeKey:readiness.ALGORITHM_VERSION,activeDatasetId:'FIFO-V2'});
  db.collection('fifoAllocations').rows.push(...db.collection('fifoAllocations').rows
    .filter(row=>row.datasetId==='FIFO-V1')
    .map(row=>({...structuredClone(row),datasetId:'FIFO-V2',allocationId:`V2-${row.allocationId}`})));
  db.collection('fifoExceptions').rows.push(...db.collection('fifoExceptions').rows
    .filter(row=>row.datasetId==='FIFO-V1')
    .map(row=>({...structuredClone(row),datasetId:'FIFO-V2',exceptionKey:`V2-${row.exceptionKey}`})));
  await readiness.synchronize(db,accounting);
  const all=db.collection(readiness.EVIDENCE).rows;
  assert.equal(all.length,4);
  assert.equal(all.filter(row=>row.sourceDatasetId==='FIFO-V1'&&row.sourceActive===false).length,2);
  const active=await readiness.listEvidence(db,{pageSize:50});
  assert.equal(active.total,2);
  assert.equal(active.list.every(row=>row.sourceDatasetId==='FIFO-V2'),true);
});

test('priority uses financial impact before low-impact quantity', () => {
  const groups=new Map([
    ['high',{itemCode:'HIGH',affectedSaleValue:900,affectedQuantity:1,saleFrequency:1,affectedSaleCount:1,returnDependency:false}],
    ['return',{itemCode:'RETURN',affectedSaleValue:1,affectedQuantity:1,saleFrequency:1,affectedSaleCount:1,returnDependency:true}],
    ['low',{itemCode:'LOW',affectedSaleValue:99,affectedQuantity:50,saleFrequency:20,affectedSaleCount:20,returnDependency:false}]
  ]);
  const rows=readiness._priorityRows(groups,52,1000);
  assert.equal(rows.find(row=>row.itemCode==='HIGH').priority,'P0');
  assert.equal(rows.find(row=>row.itemCode==='RETURN').priority,'P0');
  assert.ok(['P1','P2'].includes(rows.find(row=>row.itemCode==='LOW').priority));
});

test('evidence workflow audits transitions and enforces optimistic revision', async () => {
  const db=seedDb();
  await readiness.synchronize(db,accounting);
  const row=db.collection(readiness.EVIDENCE).rows.find(item=>item.status==='unreviewed');
  const changed=await readiness.transitionEvidence(db,row.evidenceId,{status:'accounting_investigation',revision:row.revision,accountingNotes:'review'},accounting);
  assert.equal(changed.evidence.revision,2);
  assert.equal(changed.evidence.auditLog.at(-1).action,'status-transition');
  await assert.rejects(
    readiness.transitionEvidence(db,row.evidenceId,{status:'evidence_requested',revision:1},accounting),
    error=>error.code==='ACCOUNTING_EVIDENCE_CONFLICT'
  );
});

test('seller cannot update accounting evidence', async () => {
  const db=seedDb();
  await readiness.synchronize(db,accounting);
  const row=db.collection(readiness.EVIDENCE).rows[0];
  await assert.rejects(
    readiness.transitionEvidence(db,row.evidenceId,{status:'accounting_investigation',revision:row.revision},{username:'seller',role:'seller'}),
    error=>error.code==='ACCOUNTING_EVIDENCE_FORBIDDEN'&&error.statusCode===403
  );
});

test('purchase return confirmed linkage requires a selected layer and prevents self approval', async () => {
  const db=seedDb();
  await readiness.synchronize(db,accounting);
  const row=db.collection(readiness.PURCHASE_RETURNS).rows[0];
  row.createdBy=accounting;
  await assert.rejects(
    readiness.transitionReturn(db,'purchase',row.resolutionId,{status:'confirmed_linked',selectedPurchaseLayer:'PL-A',revision:row.revision},accounting),
    error=>error.code==='RETURN_RESOLUTION_SELF_APPROVAL'
  );
  const approved=await readiness.transitionReturn(db,'purchase',row.resolutionId,{status:'confirmed_linked',selectedPurchaseLayer:'PL-A',revision:row.revision,reason:'supplier invoice evidence',confidence:100},manager);
  assert.equal(approved.resolution.status,'confirmed_linked');
  assert.equal(approved.resolution.selectedPurchaseLayer,'PL-A');
});

test('purchase return may be formally confirmed unmatched with reason', async () => {
  const db=seedDb();
  await readiness.synchronize(db,accounting);
  const row=db.collection(readiness.PURCHASE_RETURNS).rows[0];
  const result=await readiness.transitionReturn(db,'purchase',row.resolutionId,{status:'confirmed_unmatched',revision:row.revision,reason:'legacy return predates available evidence'},accounting);
  assert.equal(result.resolution.status,'confirmed_unmatched');
});

test('confirmed sale return performs a deterministic partial reversal of original allocations', async () => {
  const db=seedDb();
  db.collection('fifoDatasets').rows=[];
  db.collection('fifoAllocations').rows=[];
  db.collection('fifoExceptions').rows=[];
  db.collection('fifoDatasetState').rows=[];
  db.collection(readiness.SALE_RETURNS).rows.push({
    resolutionId:'SRET-1',status:'confirmed_linked',sourceSaleSnapshotId:'SALE-ACTIVE',
    returnLineIdentity:'SL-6-3-1-A',selectedOriginalSaleLineId:'SL-2-1-1-A',returnQuantity:1,revision:2
  });
  const result=await fifo.buildShadowDataset(db,{},accounting);
  const reversals=db.collection(fifo.ALLOCATIONS).rows.filter(row=>row.datasetId===result.datasetId&&row.sourceType==='sale_return_reversal');
  assert.equal(reversals.length,1);
  assert.equal(reversals[0].allocatedQty,-1);
  assert.equal(reversals[0].originalSaleLineId,'SL-2-1-1-A');
  assert.equal(reversals[0].allocatedCostAmountExact,'-951860416.64');
});

test('unresolved sale return remains an exception and never invents a cost', async () => {
  const db=seedDb();
  db.collection('fifoDatasets').rows=[];
  db.collection('fifoAllocations').rows=[];
  db.collection('fifoExceptions').rows=[];
  db.collection('fifoDatasetState').rows=[];
  const result=await fifo.buildShadowDataset(db,{},accounting);
  assert.equal(db.collection(fifo.ALLOCATIONS).rows.some(row=>row.datasetId===result.datasetId&&row.saleInvoiceType===6),false);
  assert.ok(db.collection(fifo.EXCEPTIONS).rows.find(row=>row.datasetId===result.datasetId&&row.code==='SALE_RETURN_NOT_ALLOCATED'));
});

test('official layer still has priority over an approved manual resolution under precision v2', async () => {
  const db=seedDb();
  db.collection('fifoDatasets').rows=[];
  db.collection('fifoAllocations').rows=[];
  db.collection('fifoExceptions').rows=[];
  db.collection('fifoDatasetState').rows=[];
  db.collection('manualCostResolutions').rows.push({
    resolutionId:'MC-A',status:'approved',itemGuid:'GUID-A',itemCode:'A',manualCost:1,effectiveFrom:'14050101',effectiveTo:'',deleted:false
  });
  const result=await fifo.buildShadowDataset(db,{},accounting);
  const rows=db.collection(fifo.ALLOCATIONS).rows.filter(row=>row.datasetId===result.datasetId&&row.saleLineId==='SL-2-1-1-A');
  assert.equal(rows[0].sourceType,'official_purchase_layer');
  assert.equal(rows[0].unitCostExact,'951860416.640000');
  assert.equal(rows[1].sourceType,'approved_manual_cost');
});

test('future and expired manual effective dates remain excluded', async () => {
  const db=seedDb();
  db.collection('fifoDatasets').rows=[];
  db.collection('fifoAllocations').rows=[];
  db.collection('fifoExceptions').rows=[];
  db.collection('fifoDatasetState').rows=[];
  db.collection('manualCostResolutions').rows.push(
    {resolutionId:'FUTURE',status:'approved',itemGuid:'GUID-B',itemCode:'B',manualCost:5,effectiveFrom:'14060101',effectiveTo:'',deleted:false},
    {resolutionId:'EXPIRED',status:'approved',itemGuid:'GUID-B',itemCode:'B',manualCost:6,effectiveFrom:'14040101',effectiveTo:'14041229',deleted:false}
  );
  const result=await fifo.buildShadowDataset(db,{},accounting);
  const row=db.collection(fifo.ALLOCATIONS).rows.find(item=>item.datasetId===result.datasetId&&item.saleLineId==='SL-2-2-1-B');
  assert.equal(row.sourceType,'unknown_cost');
});

test('confidence exposes every component and does not hide readiness behind one index', () => {
  const dataset={datasetId:'D',validation:{}};
  const allocations=[
    {saleInvoiceType:2,saleLineId:'1',sourceType:'official_purchase_layer',allocatedQty:2,allocatedSaleValue:200},
    {saleInvoiceType:2,saleLineId:'2',sourceType:'unknown_cost',unknownQty:1,allocatedSaleValue:100}
  ];
  const confidence=readiness._confidenceFromRows(dataset,allocations,[],[],[],[]);
  assert.equal(confidence.components.quantityCostCoverage,66.67);
  assert.equal(confidence.components.saleValueCostCoverage,66.67);
  assert.equal(confidence.components.lineCoverage,50);
  assert.match(confidence.formula,/30% quantity/);
  assert.match(confidence.interpretation,/not proof/i);
});

test('approval gate is blocked when reconciliation fails', () => {
  const gate=readiness._approvalGate(
    {validation:{duplicateAllocationCount:1,layerOverConsumptionCount:0,orphanLayerCount:0,inactiveSourceCount:0,monetaryReconciliationDifferenceExact:'0.00'}},
    {components:{saleValueCostCoverage:99,returnLinkageCoverage:100}},
    {valid:true,total:1},
    Array.from({length:30},()=>({reviewStatus:'accounting_confirmed'}))
  );
  assert.equal(gate.status,'blocked');
  assert.equal(gate.profitActivationAllowed,false);
});

test('approval gate can become technically ready but never automatically activates profit', () => {
  const gate=readiness._approvalGate(
    {deterministicReplayVerified:true,validation:{duplicateAllocationCount:0,layerOverConsumptionCount:0,orphanLayerCount:0,inactiveSourceCount:0,monetaryReconciliationDifferenceExact:'0.00'}},
    {components:{saleValueCostCoverage:90,returnLinkageCoverage:50}},
    {valid:true,total:1},
    []
  );
  assert.equal(gate.status,'technically_ready');
  assert.equal(gate.automaticProfitApproval,false);
});

test('manual workflow validation requires distinct users and preserved evidence', () => {
  const valid=readiness._manualWorkflowValidation([{
    status:'approved',createdBy:accounting,approvedBy:manager,effectiveFrom:'14050101',reason:'historical invoice'
  }]);
  assert.equal(valid.valid,true);
  const invalid=readiness._manualWorkflowValidation([{
    status:'approved',createdBy:accounting,approvedBy:accounting,effectiveFrom:'14050101'
  }]);
  assert.equal(invalid.valid,false);
});

test('sample review is audited and concurrency protected', async () => {
  const db=seedDb();
  await readiness.synchronize(db,accounting);
  const sample=db.collection(readiness.SAMPLES).rows[0];
  const originalRevision=sample.revision;
  const result=await readiness.reviewSample(db,sample.sampleId,{reviewStatus:'needs_evidence',reviewNotes:'invoice copy required',revision:sample.revision},accounting);
  assert.equal(result.sample.reviewStatus,'needs_evidence');
  await assert.rejects(
    readiness.reviewSample(db,sample.sampleId,{reviewStatus:'accounting_confirmed',revision:originalRevision},manager),
    error=>error.code==='ACCOUNTING_SAMPLE_CONFLICT'
  );
});

test('dataset comparison keeps historical rows and reports material differences', async () => {
  const db=seedDb();
  db.collection('fifoDatasets').rows.push({
    datasetId:'FIFO-V2',status:'completed',activationStatus:'validated-shadow',algorithmVersion:readiness.ALGORITHM_VERSION
  });
  db.collection('fifoDatasetState').rows.push({scopeKey:readiness.ALGORITHM_VERSION,activeDatasetId:'FIFO-V2'});
  db.collection('fifoAllocations').rows.push({
    datasetId:'FIFO-V2',allocationId:'NEW',allocationSequence:1,saleLineId:'SL-2-1-1-A',
    saleInvoiceType:2,sourceType:'official_purchase_layer',purchaseLineIdentity:'PL-A',
    allocatedQty:2,unknownQty:0,unitCostExact:'100.000000',allocatedCostAmountExact:'200.00'
  });
  const result=await readiness.comparison(db);
  assert.equal(result.available,true);
  assert.equal(result.oldDatasetId,'FIFO-V1');
  assert.equal(result.newDatasetId,'FIFO-V2');
  assert.ok(result.materialDifferenceCount>0);
  assert.equal(db.collection('fifoAllocations').rows.some(row=>row.datasetId==='FIFO-V1'),true);
});

test('dataset comparison treats equivalent decimal formatting as unchanged', async () => {
  const db=seedDb();
  db.collection('fifoDatasets').rows.push({
    datasetId:'FIFO-V2',status:'completed',activationStatus:'validated-shadow',algorithmVersion:readiness.ALGORITHM_VERSION
  });
  db.collection('fifoDatasetState').rows.push({scopeKey:readiness.ALGORITHM_VERSION,activeDatasetId:'FIFO-V2'});
  const oldRow=db.collection('fifoAllocations').rows.find(row=>row.datasetId==='FIFO-V1');
  db.collection('fifoAllocations').rows.push({
    ...oldRow,
    _id:undefined,
    datasetId:'FIFO-V2',
    allocationId:'NEW-EQUIVALENT',
    unitCostExact:`${oldRow.unitCost}.000000`,
    allocatedCostAmountExact:Number(oldRow.allocatedCostAmount).toFixed(2)
  });
  const result=await readiness.comparison(db);
  assert.equal(result.counts.changedUnitCosts,0);
  assert.equal(result.counts.precisionOnlyDifferences,0);
});

test('route and source contracts deny seller, preserve warnings and contain no Shaygan business write call', () => {
  const root=path.join(__dirname,'..');
  const server=fs.readFileSync(path.join(root,'src/server.js'),'utf8');
  const moduleSource=fs.readFileSync(path.join(root,'src/lib/accounting-evidence-confidence.js'),'utf8');
  const ui=fs.readFileSync(path.join(root,'public/assets/app.js'),'utf8');
  assert.match(server,/\/api\/accounting\/fifo-readiness\/report/);
  assert.match(server,/requireRole\(req,res,\['admin','accounting','manager'\]\)/);
  assert.doesNotMatch(moduleSource,/PutSaleInvoice|PutBuyInvoice|Invoice\/Put|shaygan\./i);
  assert.match(ui,/SHADOW MODE/);
  assert.match(ui,/NOT APPROVED FOR PROFIT OR COMMISSION/);
  assert.match(ui,/Unknown Cost Is Not Zero/);
  const sellerPages=ui.match(/seller:\s*\[([^\]]*)\]/)?.[1]||'';
  assert.doesNotMatch(sellerPages,/accounting-fifo-readiness/);
});
