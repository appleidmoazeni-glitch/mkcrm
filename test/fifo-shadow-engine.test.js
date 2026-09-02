'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryDb } = require('./helpers/memory-mongo');
const engine = require('../src/lib/fifo-shadow-engine');

function sale(overrides = {}) {
  return {
    snapshotId:'SALE-ACTIVE',
    saleLineId:'SL-2-1-001-A',
    saleInvoiceType:2,
    saleInvoiceNo:1,
    saleGuid:'SALE-GUID-1',
    saleDate:'14050110',
    row:1,
    itemGuid:'GUID-A',
    itemCode:'A',
    itemName:'Item A',
    qty:5,
    saleValue:5000,
    ...overrides
  };
}
function layer(overrides = {}) {
  return {
    datasetId:'PURCHASE-ACTIVE',
    datasetSchemaVersion:1,
    purchaseLineIdentity:'P-A-1',
    layerKind:'purchase',
    validationStatus:'valid',
    returnMatchStatus:'not-applicable',
    purchaseInvoiceDate:'14050101',
    purchaseInvoiceNo:10,
    sourceRow:1,
    purchaseInvoiceGuid:'PURCHASE-GUID-1',
    itemGuid:'GUID-A',
    itemCode:'A',
    itemDescription:'Item A',
    netPurchasedQuantity:2,
    netUnitCost:100,
    ...overrides
  };
}
function seedDb() {
  return new MemoryDb({
    saleSnapshotState:[{ scopeKey:'sale-type2|14050101|', activeSnapshotId:'SALE-ACTIVE', activatedAt:new Date('2026-07-29T00:00:00Z') }],
    saleSnapshots:[{ snapshotId:'SALE-ACTIVE', status:'completed', activationStatus:'active', createdAt:new Date('2026-07-29T00:00:00Z') }],
    saleSnapshotDatasetHeaders:[
      { snapshotId:'SALE-ACTIVE', invTyp:2, invNo:1, guId:'SALE-GUID-1' },
      { snapshotId:'SALE-ACTIVE', invTyp:2, invNo:2, guId:'SALE-GUID-2' },
      { snapshotId:'SALE-ACTIVE', invTyp:2, invNo:3, guId:'SALE-GUID-3' },
      { snapshotId:'SALE-ACTIVE', invTyp:6, invNo:4, guId:'SALE-RETURN-GUID', relatedInvHeaderId:'SALE-GUID-1' }
    ],
    saleSnapshotDatasetLines:[
      sale(),
      sale({ saleLineId:'SL-2-2-001-B', saleInvoiceNo:2, saleGuid:'SALE-GUID-2', saleDate:'14050111', itemGuid:'GUID-B', itemCode:'B', itemName:'Item B', qty:3, saleValue:6000 }),
      sale({ saleLineId:'SL-2-3-001-C', saleInvoiceNo:3, saleGuid:'SALE-GUID-3', saleDate:'14050112', itemGuid:'GUID-C', itemCode:'C', itemName:'Item C', qty:4, saleValue:8000 }),
      sale({ saleLineId:'SL-6-4-001-A', saleInvoiceType:6, saleInvoiceNo:4, saleGuid:'SALE-RETURN-GUID', relatedInvHeaderId:'SALE-GUID-1', saleDate:'14050120', qty:1, saleValue:1000 })
    ],
    purchaseLayerDatasetState:[{ scopeKey:'purchase-invoices-types-3-7', activeDatasetId:'PURCHASE-ACTIVE' }],
    purchaseLayerDatasets:[{
      datasetId:'PURCHASE-ACTIVE',
      status:'completed',
      activationStatus:'active',
      sourceDateFrom:'14040101'
    }],
    supplierPurchaseLayers:[
      layer(),
      layer({ purchaseLineIdentity:'P-A-2', purchaseInvoiceNo:11, purchaseInvoiceDate:'14050105', netPurchasedQuantity:4, netUnitCost:200 }),
      layer({
        purchaseLineIdentity:'PR-UNRESOLVED',
        layerKind:'purchase-return',
        purchaseInvoiceNo:12,
        sourceRow:1,
        returnedQuantity:1,
        netPurchasedQuantity:null,
        netUnitCost:null,
        returnMatchStatus:'unmatched',
        returnInvHeaderReference:'UNKNOWN'
      })
    ],
    manualCostResolutions:[
      {
        resolutionId:'MC-B',
        revision:3,
        status:'approved',
        deleted:false,
        itemGuid:'GUID-B',
        itemCode:'B',
        manualCost:300,
        effectiveFrom:'14050101',
        effectiveTo:''
      },
      {
        resolutionId:'MC-A',
        revision:3,
        status:'approved',
        deleted:false,
        itemGuid:'GUID-A',
        itemCode:'A',
        manualCost:999,
        effectiveFrom:'14050101',
        effectiveTo:''
      }
    ],
    fifoDatasets:[],
    fifoAllocations:[],
    fifoDiagnostics:[],
    fifoExceptions:[],
    fifoDatasetState:[]
  });
}
const accountant = { username:'accountant-1', role:'accounting' };

test('FIFO allocates oldest official layers first and represents partial allocations as separate rows', async () => {
  const db=seedDb();
  const result=await engine.buildShadowDataset(db,{},accountant);
  assert.equal(result.ok,true);
  const rows=db.collection(engine.ALLOCATIONS).rows.filter(row=>row.saleLineId==='SL-2-1-001-A');
  assert.equal(rows.length,2);
  assert.deepEqual(rows.map(row=>row.purchaseLineIdentity),['P-A-1','P-A-2']);
  assert.deepEqual(rows.map(row=>row.allocatedQty),[2,3]);
  assert.deepEqual(rows.map(row=>row.layerRemainingQuantity),[0,1]);
  assert.equal(rows.every(row=>row.sourceType==='official_purchase_layer'),true);
});

test('approved manual follows official priority and unknown cost is explicit, never zero', async () => {
  const db=seedDb();
  const result=await engine.buildShadowDataset(db,{},accountant);
  const rows=db.collection(engine.ALLOCATIONS).rows.filter(row=>row.datasetId===result.datasetId);
  const manual=rows.find(row=>row.saleLineId==='SL-2-2-001-B');
  const unknown=rows.find(row=>row.saleLineId==='SL-2-3-001-C');
  assert.equal(manual.sourceType,'approved_manual_cost');
  assert.equal(manual.manualResolutionId,'MC-B');
  assert.equal(manual.unitCost,300);
  assert.equal(unknown.sourceType,'unknown_cost');
  assert.equal(unknown.unitCost,null);
  assert.equal(unknown.allocatedCostAmount,null);
  assert.equal(unknown.allocatedQty,0);
  assert.equal(unknown.unknownQty,4);
  assert.equal(result.summary.official.quantity,5);
  assert.equal(result.summary.manual.quantity,3);
  assert.equal(result.summary.unknown.quantity,4);
});

test('pending one-rial purchase price never creates PROVEN FIFO profit',async()=>{
  const db=seedDb();
  const pending=db.collection('supplierPurchaseLayers').rows.find(row=>row.purchaseLineIdentity==='P-A-1');
  Object.assign(pending,{netUnitCost:1,grossUnitCost:1,costStatus:'pending-purchase-price-correction',validationStatus:'warning'});
  const layers=db.collection('supplierPurchaseLayers').rows;
  for(const identity of ['P-A-2','PR-UNRESOLVED']){
    const index=layers.findIndex(row=>row.purchaseLineIdentity===identity);
    if(index>=0)layers.splice(index,1);
  }
  db.collection('manualCostResolutions').rows.length=0;
  const result=await engine.buildShadowDataset(db,{},accountant);
  const rows=db.collection(engine.ALLOCATIONS).rows.filter(row=>row.datasetId===result.datasetId&&row.saleLineId==='SL-2-1-001-A');
  assert.equal(rows.length,1);
  assert.equal(rows[0].sourceType,'unknown_cost');
  assert.equal(rows[0].unknownReason,'purchase_price_pending_correction');
  assert.equal(rows[0].unitCost,null);
  assert.equal(rows[0].allocatedCostAmountExact,null);
  const facts=engine._provenanceFacts(rows,[]);
  assert.equal(facts[0].profitProvenanceStatus,'UNKNOWN');
  assert.equal(facts[0].fifoProfitExact,null);
});

test('purchase-line-scoped manual evidence costs only its targeted invalid layer',async()=>{
  const db=seedDb();db.collection('saleSnapshotDatasetLines').rows.push(sale({saleLineId:'SL-2-5-001-D',saleInvoiceNo:5,saleDate:'14050113',itemGuid:'GUID-D',itemCode:'D',qty:2,saleValue:1000}));db.collection('supplierPurchaseLayers').rows.push(layer({purchaseLineIdentity:'P-D-1',purchaseInvoiceNo:20,purchaseInvoiceDate:'14050102',itemGuid:'GUID-D',itemCode:'D',netPurchasedQuantity:2,netUnitCost:null,validationStatus:'warning'}));db.collection('manualCostResolutions').rows.push({resolutionId:'MC-D-LAYER',revision:3,status:'approved',deleted:false,resolutionScope:'purchase_layer',purchaseDatasetId:'PURCHASE-ACTIVE',purchaseLineIdentity:'P-D-1',targetQuantityExact:'2.000000',itemGuid:'GUID-D',itemCode:'D',manualCostExact:'125.500000',effectiveFrom:'14050101',effectiveTo:''});await engine.buildShadowDataset(db,{},accountant);const rows=db.collection(engine.ALLOCATIONS).rows.filter(row=>row.saleLineId==='SL-2-5-001-D');assert.equal(rows.length,1);assert.equal(rows[0].sourceType,'approved_manual_purchase_layer');assert.equal(rows[0].purchaseLineIdentity,'P-D-1');assert.equal(rows[0].manualResolutionId,'MC-D-LAYER');assert.equal(rows[0].allocatedCostAmountExact,'251.00');
});

test('partial official exhaustion uses approved manual only after official layers', async () => {
  const db=seedDb();
  db.collection('saleSnapshotDatasetLines').rows.push(sale({
    saleLineId:'SL-2-5-001-A',
    saleInvoiceNo:5,
    saleGuid:'SALE-GUID-5',
    saleDate:'14050113',
    qty:2,
    saleValue:2000
  }));
  db.collection('saleSnapshotDatasetHeaders').rows.push({snapshotId:'SALE-ACTIVE',invTyp:2,invNo:5,guId:'SALE-GUID-5'});
  const result=await engine.buildShadowDataset(db,{},accountant);
  const rows=db.collection(engine.ALLOCATIONS).rows.filter(row=>row.datasetId===result.datasetId&&row.saleLineId==='SL-2-5-001-A');
  assert.deepEqual(rows.map(row=>row.sourceType),['official_purchase_layer','approved_manual_cost']);
  assert.deepEqual(rows.map(row=>row.allocatedQty),[1,1]);
  assert.equal(rows[0].unitCost,200);
  assert.equal(rows[1].unitCost,999);
});

test('source-linked partial multi-layer sale return remains ambiguous and purchase return quarantine is preserved', async () => {
  const db=seedDb();
  const result=await engine.buildShadowDataset(db,{},accountant);
  const allocations=db.collection(engine.ALLOCATIONS).rows.filter(row=>row.datasetId===result.datasetId);
  assert.equal(allocations.some(row=>row.saleInvoiceType===6),false);
  assert.equal(allocations.some(row=>row.purchaseLineIdentity==='PR-UNRESOLVED'),false);
  const exceptions=db.collection(engine.EXCEPTIONS).rows.filter(row=>row.datasetId===result.datasetId);
  assert.equal(exceptions.find(row=>row.code==='SALE_RETURN_ALLOCATION_AMBIGUOUS').status,'unresolved');
  assert.equal(exceptions.find(row=>row.code==='PURCHASE_RETURN_STATUS').status,'unresolved');
  assert.equal(result.summary.purchaseReturns.unresolved,1);
});

test('rebuild is deterministic while historical runs coexist', async () => {
  const db=seedDb();
  const first=await engine.buildShadowDataset(db,{},accountant);
  const second=await engine.buildShadowDataset(db,{},accountant);
  assert.notEqual(first.datasetId,second.datasetId);
  assert.equal(first.sourceFingerprint,second.sourceFingerprint);
  assert.equal(first.allocationFingerprint,second.allocationFingerprint);
  assert.equal(db.collection(engine.DATASETS).rows.filter(row=>row.status==='completed').length,2);
  assert.equal(db.collection(engine.STATE).rows[0].activeDatasetId,'');
  assert.equal(db.collection(engine.DATASETS).rows.every(row=>row.activationStatus==='validated-candidate'),true);
});

test('dateFrom never truncates earlier sales needed to consume FIFO history', async () => {
  const db=seedDb();
  const result=await engine.buildShadowDataset(db,{dateFrom:'14050111',dateTo:'14050112'},accountant);
  const rows=db.collection(engine.ALLOCATIONS).rows.filter(row=>row.datasetId===result.datasetId);
  assert.equal(rows.some(row=>row.saleLineId==='SL-2-1-001-A'),true);
  assert.equal(result.summary.soldLineCount,3);
});

test('bounded source retry succeeds and records evidence', async () => {
  const db=seedDb();
  let attempts=0;
  const result=await engine.buildShadowDataset(db,{
    maxAttempts:2,
    retryDelayMs:0,
    sourceLoader:async (...args)=>{
      attempts++;
      if(attempts===1)throw new Error('transient Mongo timeout');
      return engine._loadSources(...args);
    }
  },accountant);
  assert.equal(result.ok,true);
  assert.equal(result.retryCount,1);
  assert.equal(result.summary.reconciliation.valid,true);
  const dataset=db.collection(engine.DATASETS).rows.find(row=>row.datasetId===result.datasetId);
  assert.deepEqual(dataset.sourceReadAttempts.map(row=>row.ok),[false,true]);
});

test('failed candidate can resume by deterministic replay without changing the active dataset', async () => {
  const db=seedDb();
  const active=await engine.buildShadowDataset(db,{},accountant);
  await assert.rejects(
    engine.buildShadowDataset(db,{
      maxAttempts:1,
      sourceLoader:async()=>{throw new Error('controlled read failure');}
    },accountant),
    /controlled read failure/
  );
  const failed=db.collection(engine.DATASETS).rows.find(row=>row.status==='failed');
  assert.ok(failed);
  assert.equal(db.collection(engine.STATE).rows[0].activeDatasetId,'');
  const resumed=await engine.buildShadowDataset(db,{resumeDatasetId:failed.datasetId},accountant);
  assert.equal(resumed.ok,true);
  assert.equal(resumed.datasetId,failed.datasetId);
  assert.equal(resumed.resumeCount,1);
  assert.equal(db.collection(engine.STATE).rows[0].activeDatasetId,'');
});

test('completed datasets are immutable and cannot be resumed', async () => {
  const db=seedDb();
  const result=await engine.buildShadowDataset(db,{},accountant);
  await assert.rejects(
    engine.buildShadowDataset(db,{resumeDatasetId:result.datasetId},accountant),
    error=>error.code==='FIFO_DATASET_IMMUTABLE'&&error.statusCode===409
  );
});

test('a completed immutable candidate cannot be activated through resume', async () => {
  const db=seedDb();
  const result=await engine.buildShadowDataset(db,{},accountant);
  db.collection(engine.STATE).rows[0].activeDatasetId='';
  await assert.rejects(engine.buildShadowDataset(db,{resumeDatasetId:result.datasetId},accountant),error=>error.code==='FIFO_DATASET_IMMUTABLE');
  assert.equal(db.collection(engine.STATE).rows[0].activeDatasetId,'');
  const dataset=db.collection(engine.DATASETS).rows.find(row=>row.datasetId===result.datasetId);
  assert.equal(dataset.status,'completed');
  assert.equal(dataset.activationStatus,'validated-candidate');
});

test('database lease prevents concurrent FIFO shadow builds', async () => {
  const db=seedDb();
  await engine.ensureIndexes(db);
  await db.collection(engine.STATE).updateOne(
    {scopeKey:engine.SCOPE_KEY},
    {$set:{scopeKey:engine.SCOPE_KEY,buildLockOwner:'OTHER',buildLockExpiresAt:new Date(Date.now()+60_000)}},
    {upsert:true}
  );
  await assert.rejects(
    engine.buildShadowDataset(db,{},accountant),
    error=>error.code==='FIFO_BUILD_LOCKED'&&error.statusCode===409
  );
  assert.equal(db.collection(engine.DATASETS).rows.length,0);
});

test('validation report provides business samples, confidence and reconciliation without profit', async () => {
  const db=seedDb();
  const result=await engine.buildShadowDataset(db,{},accountant);
  const report=await engine.validationReport(db,result.datasetId);
  assert.equal(report.available,true);
  assert.equal(report.reconciliation.valid,true);
  assert.equal(report.businessValidation.topInvoicesByValue.length,3);
  assert.equal(report.businessValidation.purchaseReturns.length,1);
  assert.equal(report.businessValidation.manualSamples.length,1);
  assert.equal(report.businessValidation.unknownSamples.length,1);
  assert.equal(report.profitCalculated,false);
  assert.equal(report.roiCalculated,false);
  assert.equal(report.commissionCalculated,false);
  assert.equal(report.accountingApproved,false);
});

test('route, schema and UI contracts remain isolated from official datasets and financial activation', () => {
  const root=path.join(__dirname,'..');
  const moduleSource=fs.readFileSync(path.join(root,'src/lib/fifo-shadow-engine.js'),'utf8');
  const serverSource=fs.readFileSync(path.join(root,'src/server.js'),'utf8');
  const uiSource=fs.readFileSync(path.join(root,'public/assets/app.js'),'utf8');
  assert.match(serverSource,/\/api\/accounting\/fifo-shadow\/start/);
  assert.match(serverSource,/\/api\/accounting\/fifo-shadow\/allocations/);
  assert.match(serverSource,/\/api\/accounting\/fifo-shadow\/exceptions/);
  assert.match(uiSource,/SHADOW MODE — NOT ACCOUNTING APPROVED/);
  assert.match(uiSource,/id="fifoClear"/);
  assert.match(uiSource,/normalizedItemCodeInput/);
  assert.match(uiSource,/فیلترهای اعمال‌شده/);
  assert.doesNotMatch(moduleSource,/collection\(purchaseLayerDataset\.LAYERS\)\.(?:insert|update|delete|bulkWrite)/);
  assert.doesNotMatch(moduleSource,/collection\(['"]saleSnapshotDatasetLines['"]\)\.(?:insert|update|delete|bulkWrite)/);
  assert.doesNotMatch(moduleSource,/PutSaleInvoice|Invoice\/Put|putInvoice/);
  assert.match(moduleSource,/profitActivationAllowed:false/);
  assert.match(moduleSource,/profitCalculated:false/);
  assert.match(moduleSource,/commissionCalculated:false/);
});

test('allocation read path binds the requested candidate and normalizes ItemCode without hiding combined filters', async () => {
  const db=seedDb();
  const result=await engine.buildShadowDataset(db,{},accountant);
  const exact=await engine.listAllocations(db,{datasetId:result.datasetId,itemCode:'A'});
  const lower=await engine.listAllocations(db,{datasetId:result.datasetId,itemCode:'a'});
  const padded=await engine.listAllocations(db,{datasetId:result.datasetId,itemCode:'  a  '});
  assert.equal(exact.total,lower.total);
  assert.equal(lower.total,padded.total);
  assert.equal(lower.appliedFilters.datasetId,result.datasetId);
  assert.equal(lower.appliedFilters.itemCode,'A');
  const invoiceOnly=await engine.listAllocations(db,{datasetId:result.datasetId,invoiceNo:'2'});
  const combined=await engine.listAllocations(db,{datasetId:result.datasetId,invoiceNo:'2',itemCode:'b'});
  assert.equal(invoiceOnly.total,1);
  assert.equal(combined.total,1);
  assert.equal(combined.appliedFilters.invoiceNo,'2');
  assert.equal(combined.appliedFilters.itemCode,'B');
  const wrongCandidate=await engine.listAllocations(db,{datasetId:'FIFO-NOT-SELECTED',itemCode:'a'});
  assert.equal(wrongCandidate.total,0);
  assert.equal(wrongCandidate.datasetId,'FIFO-NOT-SELECTED');
});
