'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryDb } = require('./helpers/memory-mongo');
const service = require('../src/lib/manual-cost-resolution');

function seedDb() {
  return new MemoryDb({
    saleSnapshotState:[{
      scopeKey:'sale-type2|14050101|',
      activeSnapshotId:'SALE-ACTIVE',
      activatedAt:new Date('2026-07-29T00:00:00Z')
    }],
    saleSnapshots:[{
      snapshotId:'SALE-ACTIVE',
      status:'completed',
      activationStatus:'active',
      createdAt:new Date('2026-07-29T00:00:00Z')
    }],
    saleSnapshotDatasetHeaders:[
      { snapshotId:'SALE-ACTIVE', invTyp:2, invNo:1 },
      { snapshotId:'SALE-ACTIVE', invTyp:2, invNo:2 },
      { snapshotId:'SALE-ACTIVE', invTyp:2, invNo:3 }
    ],
    saleSnapshotDatasetLines:[
      { snapshotId:'SALE-ACTIVE', saleLineId:'SL-1', saleInvoiceType:2, saleInvoiceNo:1, saleDate:'14050110', itemCode:'OFFICIAL', itemGuid:'GUID-O', itemName:'Intel Official', qty:2, saleValue:2000, sellerStoreName:'Store A', mainGroup:'CPU' },
      { snapshotId:'SALE-ACTIVE', saleLineId:'SL-2', saleInvoiceType:2, saleInvoiceNo:2, saleDate:'14050111', itemCode:'MANUAL', itemGuid:'GUID-M', itemName:'Patriot Manual', qty:3, saleValue:3000, sellerStoreName:'Store B', mainGroup:'RAM' },
      { snapshotId:'SALE-ACTIVE', saleLineId:'SL-3', saleInvoiceType:2, saleInvoiceNo:3, saleDate:'14050112', itemCode:'UNKNOWN', itemGuid:'GUID-U', itemName:'Adata Unknown', qty:4, saleValue:4000, sellerStoreName:'Store A', mainGroup:'SSD' }
    ],
    purchaseLayerDatasetState:[{
      scopeKey:'purchase-invoices-types-3-7',
      activeDatasetId:'PURCHASE-ACTIVE'
    }],
    purchaseLayerDatasets:[{
      datasetId:'PURCHASE-ACTIVE',
      status:'completed',
      activationStatus:'active',
      sourceDateFrom:'14050101',
      purchaseInvoiceCount:1
    }],
    supplierPurchaseLayers:[{
      datasetId:'PURCHASE-ACTIVE',
      purchaseLineIdentity:'P-1',
      layerKind:'purchase',
      validationStatus:'valid',
      costStatus:'known-from-shaygan-line',
      itemCode:'OFFICIAL',
      itemGuid:'GUID-O',
      itemDescription:'Intel Official',
      supplierAccountNumber:'SUP-1',
      supplierName:'Supplier One',
      netUnitCost:700,
      grossUnitCost:700
    }],
    itemInventoryCatalog:[
      { itemCode:'OFFICIAL', stockNumber:'1', quantity:5 },
      { itemCode:'MANUAL', stockNumber:'1', quantity:7 },
      { itemCode:'UNKNOWN', stockNumber:'1', quantity:9 }
    ],
    manualCostResolutions:[],
    appJobs:[
      { jobId:'J1', status:'completed', result:{ retryCount:1 } },
      { jobId:'J2', status:'completed', result:{ resumeCount:1 } }
    ],
    appLogs:[{ type:'mongo_backup', status:'completed', database:'mkcrm_staging', at:new Date('2026-07-29T00:00:00Z') }]
  });
}

const accounting = { username:'accountant-1', role:'accounting' };
const manager = { username:'manager-1', role:'manager' };

async function approvedManual(db, overrides = {}) {
  const created = await service.createDraft(db, {
    itemGuid:'GUID-M',
    itemCode:'MANUAL',
    manualCost:800.5,
    effectiveFrom:'14050101',
    effectiveTo:'',
    currency:'IRR',
    sourceType:'historical_purchase',
    reason:'سند تاریخی بررسی شد',
    notes:'reference 42',
    ...overrides
  }, accounting);
  const pending=await service.transition(db, created.resolution.resolutionId, 'submit', accounting, { revision:created.resolution.revision });
  return service.transition(db, created.resolution.resolutionId, 'approve', manager, { revision:pending.resolution.revision });
}

test('draft -> pending -> approved preserves immutable audit evidence', async () => {
  const db=seedDb();
  const created=await service.createDraft(db,{
    itemCode:'MANUAL',itemGuid:'GUID-M',manualCost:'800.50',effectiveFrom:'۱۴۰۵/۰۱/۰۱',
    currency:'irr',sourceType:'historical_purchase',reason:'historical document',
    attachment:{name:'invoice.pdf',reference:'DOC-42',sha256:'a'.repeat(64)}
  },accounting);
  assert.equal(created.resolution.status,'draft');
  assert.equal(created.resolution.effectiveFrom,'14050101');
  assert.equal(created.resolution.manualCost,800.5);
  assert.equal(created.resolution.manualCostExact,'800.500000');
  assert.match(created.resolution.contentHash,/^[a-f0-9]{64}$/);
  assert.equal(created.resolution.currency,'IRR');
  assert.equal(created.resolution.auditLog[0].action,'created-draft');
  const pending=await service.transition(db,created.resolution.resolutionId,'submit',accounting,{revision:created.resolution.revision});
  assert.equal(pending.resolution.status,'pending');
  const approved=await service.transition(db,created.resolution.resolutionId,'approve',manager,{revision:pending.resolution.revision});
  assert.equal(approved.resolution.status,'approved');
  assert.equal(approved.resolution.approvedBy.username,'manager-1');
  assert.deepEqual(approved.resolution.auditLog.map(row=>row.action),['created-draft','submit','approve']);
  assert.equal(approved.resolution.auditLog[0].details.oldValue,null);
  assert.equal(approved.resolution.auditLog[0].details.newValue.manualCost,800.5);
  assert.equal(approved.resolution.auditLog[2].details.oldValue.status,'pending');
  assert.equal(approved.resolution.auditLog[2].details.newValue.status,'approved');
});

test('approved manual-cost fingerprint is canonical and changes only when approved evidence changes',async()=>{
  const db=seedDb();const empty=await service.approvedSetFingerprint(db);const created=await service.createDraft(db,{itemCode:'X',manualCost:'951860416.64',effectiveFrom:'14050101',sourceType:'manual',reason:'evidence'},accounting);const draft=await service.approvedSetFingerprint(db);assert.equal(draft.fingerprint,empty.fingerprint);await service.transition(db,created.resolution.resolutionId,'submit',accounting,{revision:1});await service.transition(db,created.resolution.resolutionId,'approve',manager,{revision:2});const approved=await service.approvedSetFingerprint(db);assert.notEqual(approved.fingerprint,empty.fingerprint);assert.equal(approved.count,1);
});

test('impact preview is read-only and bounds affected unresolved FIFO rows before activation',async()=>{
  const db=seedDb();db.collection('fifoDatasetState').rows.push({scopeKey:'fifo-shadow-v2-precision-evidence',activeDatasetId:'FIFO-A'});db.collection('fifoAllocations').rows.push({datasetId:'FIFO-A',allocationId:'A-U',saleLineId:'SL-3',saleInvoiceType:2,saleInvoiceNo:3,saleDate:'14050112',sourceType:'unknown_cost',itemGuid:'GUID-U',itemCode:'UNKNOWN',quantityExact:'4.000000',allocatedSaleValueExact:'4000.00',allocatedCostAmountExact:null,sellerAccountNumber:'SELLER-1'});const created=await service.createDraft(db,{itemGuid:'GUID-U',itemCode:'UNKNOWN',manualCost:'750.25',effectiveFrom:'14050101',sourceType:'manual',reason:'documented'},accounting);const before=structuredClone(db.collection('fifoAllocations').rows);const preview=await service.impactPreview(db,created.resolution.resolutionId,manager);assert.equal(preview.affected.saleLines,1);assert.equal(preview.projectedResolvedCostExact,'3001.00');assert.equal(preview.fifoProfitDeltaExact,null);assert.equal(preview.historicalDatasetMutated,false);assert.deepEqual(db.collection('fifoAllocations').rows,before);
});

test('purchase-layer scope requires exact target identity and quantity while item scope stays backward compatible',async()=>{
  const db=seedDb();db.collection('supplierPurchaseLayers').rows[0].originalQuantity=2;const created=await service.createDraft(db,{resolutionScope:'purchase_layer',purchaseDatasetId:'PURCHASE-ACTIVE',purchaseLineIdentity:'P-1',targetQuantityExact:'1.250000',itemGuid:'GUID-O',itemCode:'OFFICIAL',manualCost:'700.125',effectiveFrom:'14050101',sourceType:'historical_purchase'},accounting);assert.equal(created.resolution.resolutionScope,'purchase_layer');assert.equal(created.resolution.targetQuantityExact,'1.250000');await assert.rejects(service.createDraft(db,{resolutionScope:'purchase_layer',purchaseDatasetId:'PURCHASE-ACTIVE',purchaseLineIdentity:'P-1',targetQuantityExact:'99',itemGuid:'GUID-O',manualCost:1,effectiveFrom:'14050101'},accounting),error=>error.code==='MANUAL_COST_TARGET_QUANTITY_EXCEEDS_LAYER');
});

test('optimistic revision prevents silent overwrite', async () => {
  const db=seedDb();
  const created=await service.createDraft(db,{itemCode:'X',manualCost:1,effectiveFrom:'14050101',sourceType:'manual'},accounting);
  const updated=await service.updateDraft(db,created.resolution.resolutionId,{revision:1,manualCost:2},accounting);
  assert.equal(updated.resolution.manualCost,2);
  assert.equal(updated.resolution.revision,2);
  await assert.rejects(
    service.updateDraft(db,created.resolution.resolutionId,{revision:1,manualCost:3},accounting),
    error=>error.code==='MANUAL_COST_CONCURRENT_CHANGE'
  );
});

test('seller cannot create or approve and creator cannot self-approve', async () => {
  const db=seedDb();
  await assert.rejects(
    service.createDraft(db,{itemCode:'X',manualCost:1,effectiveFrom:'14050101',sourceType:'manual'},{username:'seller',role:'seller'}),
    error=>error.code==='MANUAL_COST_FORBIDDEN'&&error.statusCode===403
  );
  const created=await service.createDraft(db,{itemCode:'X',manualCost:1,effectiveFrom:'14050101',sourceType:'manual'},accounting);
  const pending=await service.transition(db,created.resolution.resolutionId,'submit',accounting,{revision:created.resolution.revision});
  await assert.rejects(
    service.transition(db,created.resolution.resolutionId,'approve',accounting,{revision:pending.resolution.revision}),
    error=>error.code==='MANUAL_COST_FORBIDDEN'&&error.statusCode===403
  );
  const approved=await service.transition(db,created.resolution.resolutionId,'approve',{username:'manager',role:'manager'},{revision:pending.resolution.revision});
  assert.equal(approved.resolution.status,'approved');
});

test('overlapping active resolutions are rejected and no physical delete API exists', async () => {
  const db=seedDb();
  await service.createDraft(db,{itemCode:'X',manualCost:1,effectiveFrom:'14050101',effectiveTo:'14050131',sourceType:'manual'},accounting);
  await assert.rejects(
    service.createDraft(db,{itemCode:'X',manualCost:2,effectiveFrom:'14050115',effectiveTo:'14050201',sourceType:'manual'},accounting),
    error=>error.code==='MANUAL_COST_OVERLAP'&&error.statusCode===409
  );
  assert.equal(service.delete,undefined);
  const list=await service.list(db,{});
  assert.equal(list.list[0].deleted,false);
});

test('official source always has priority over approved manual source', async () => {
  const db=seedDb();
  await approvedManual(db,{itemCode:'OFFICIAL',itemGuid:'GUID-O',manualCost:1});
  const readiness=await service.readiness(db,{dateFrom:'14050101',dateTo:'14050131'});
  const official=readiness.list.find(row=>row.itemCode==='OFFICIAL');
  assert.equal(official.coverage,'official');
  assert.equal(official.officialLines,1);
  assert.equal(official.manualLines,0);
  assert.equal(readiness.profitActivationAllowed,false);
  assert.equal(readiness.fifoCalculationActivated,false);
});

test('only approved and effective manual cost changes readiness and coverage', async () => {
  const db=seedDb();
  const before=await service.coverage(db,{dateFrom:'14050101',dateTo:'14050131'});
  assert.equal(before.beforeManual.itemCount,1);
  assert.equal(before.afterManual.itemCount,1);
  await approvedManual(db);
  const after=await service.coverage(db,{dateFrom:'14050101',dateTo:'14050131'});
  assert.equal(after.official.itemCount,1);
  assert.equal(after.manual.itemCount,1);
  assert.equal(after.unknown.itemCount,1);
  assert.equal(after.beforeManual.itemCount,1);
  assert.equal(after.afterManual.itemCount,2);
  assert.equal(after.safety.officialPriority,true);
  assert.equal(after.safety.unknownIsZero,false);
  assert.equal(after.safety.manualIsOfficial,false);
});

test('future, expired and rejected manual costs are not eligible', async () => {
  const db=seedDb();
  const future=await service.createDraft(db,{itemCode:'MANUAL',itemGuid:'GUID-M',manualCost:5,effectiveFrom:'14050201',sourceType:'manual'},accounting);
  const futurePending=await service.transition(db,future.resolution.resolutionId,'submit',accounting,{revision:future.resolution.revision});
  const futureApproved=await service.transition(db,future.resolution.resolutionId,'approve',manager,{revision:futurePending.resolution.revision});
  let readiness=await service.readiness(db,{});
  assert.equal(readiness.list.find(row=>row.itemCode==='MANUAL').coverage,'unknown');
  await service.transition(db,future.resolution.resolutionId,'expire',manager,{reason:'replaced',revision:futureApproved.resolution.revision});
  const rejected=await service.createDraft(db,{itemCode:'UNKNOWN',itemGuid:'GUID-U',manualCost:5,effectiveFrom:'14050101',sourceType:'manual'},accounting);
  const rejectedPending=await service.transition(db,rejected.resolution.resolutionId,'submit',accounting,{revision:rejected.resolution.revision});
  await service.transition(db,rejected.resolution.resolutionId,'reject',manager,{reason:'insufficient evidence',revision:rejectedPending.resolution.revision});
  readiness=await service.readiness(db,{});
  assert.equal(readiness.list.find(row=>row.itemCode==='MANUAL').coverage,'unknown');
  assert.equal(readiness.list.find(row=>row.itemCode==='UNKNOWN').coverage,'unknown');
});

test('missing queue classifies unknown cost, supports paging and reports current inventory', async () => {
  const db=seedDb();
  const queue=await service.missingQueue(db,{coverage:'unknown',sort:'saleAmount',direction:'desc',page:1,pageSize:1});
  assert.equal(queue.total,2);
  assert.equal(queue.list.length,1);
  assert.equal(queue.list[0].itemCode,'UNKNOWN');
  assert.equal(queue.list[0].currentInventory,9);
  assert.equal(queue.list[0].saleAmount,4000);
  assert.equal(queue.list[0].reason,'no_purchase_found');
  assert.equal(queue.list[0].profitCalculated,false);
  assert.equal(queue.list[0].fifoAllocationCreated,false);
});

test('data health reports active datasets, retries, resumes and zero duplicates', async () => {
  const db=seedDb();
  await approvedManual(db);
  const health=await service.dataHealth(db,{gitSha:'abc123',buildTime:'2026-07-29T00:00:00Z'});
  assert.equal(health.activeDataset.saleSnapshotId,'SALE-ACTIVE');
  assert.equal(health.activeDataset.purchaseLayerDatasetId,'PURCHASE-ACTIVE');
  assert.equal(health.purchaseLayer.duplicateRows,0);
  assert.equal(health.manualCost.byStatus.approved,1);
  assert.equal(health.retry.jobsWithRetry,1);
  assert.equal(health.resume.jobsWithResume,1);
  assert.equal(health.gitSha,'abc123');
  assert.equal(health.profitActivationAllowed,false);
});

test('invalid amount, unsafe number, invalid date range and source type fail clearly', () => {
  assert.throws(()=>service._validateDraft({itemCode:'X',manualCost:'NaN',effectiveFrom:'14050101',sourceType:'manual'}),error=>error.code==='MANUAL_COST_INVALID_AMOUNT');
  assert.throws(()=>service._validateDraft({itemCode:'X',manualCost:Number.MAX_SAFE_INTEGER*2,effectiveFrom:'14050101',sourceType:'manual'}),error=>error.code==='MANUAL_COST_INVALID_AMOUNT');
  assert.throws(()=>service._validateDraft({itemCode:'X',manualCost:1,effectiveFrom:'14050201',effectiveTo:'14050101',sourceType:'manual'}),error=>error.code==='MANUAL_COST_INVALID_RANGE');
  assert.throws(()=>service._validateDraft({itemCode:'X',manualCost:1,effectiveFrom:'14050101',sourceType:'fifo'}),error=>error.code==='MANUAL_COST_INVALID_SOURCE');
});

test('route and UI contracts expose the governed module without purchase-layer mutation or financial activation', () => {
  const root=path.join(__dirname,'..');
  const moduleSource=fs.readFileSync(path.join(root,'src/lib/manual-cost-resolution.js'),'utf8');
  const serverSource=fs.readFileSync(path.join(root,'src/server.js'),'utf8');
  const uiSource=fs.readFileSync(path.join(root,'public/assets/app.js'),'utf8');
  assert.match(serverSource,/\/api\/manual-cost-resolutions/);
  assert.match(serverSource,/\/api\/accounting\/missing-purchase-costs/);
  assert.match(serverSource,/\/api\/accounting\/fifo-readiness/);
  assert.match(serverSource,/\/api\/accounting\/cost-coverage/);
  assert.match(serverSource,/\/api\/accounting\/data-health/);
  assert.doesNotMatch(serverSource,/req\.method\s*===\s*['"]DELETE['"][^\n]*manual-cost/);
  assert.doesNotMatch(moduleSource,/collection\(purchaseLayerDataset\.LAYERS\)\.(?:insert|update|delete|bulkWrite)/);
  assert.match(uiSource,/رفع هزینه خرید نامشخص/);
  assert.match(moduleSource,/profitActivationAllowed:false/);
  assert.match(moduleSource,/fifoCalculationActivated:false/);
});

test('governed supersession preserves legacy evidence and resolves only inside the explicitly bounded period',async()=>{
  const db=seedDb();
  const legacy={
    resolutionId:'MCOST-1785779703360-79333248',schemaVersion:2,status:'approved',revision:3,deleted:false,
    itemGuid:'GUID-M',itemCode:'MANUAL',manualCost:612310000,manualCostExact:'612310000.000000',
    effectiveFrom:'',effectiveTo:'',reason:'legacy evidence',sourceType:'legacy_cost',resolutionScope:'item',
    createdBy:{username:'khedmati',role:'accounting'},approvedBy:{username:'admin',role:'admin'},auditLog:[{action:'approve'}]
  };
  db.collection('manualCostResolutions').rows.push(structuredClone(legacy));
  await assert.rejects(
    service.createDraft(db,{itemGuid:'GUID-M',itemCode:'MANUAL',manualCost:'612310000',effectiveFrom:'14050501',effectiveTo:'14050531',sourceType:'legacy_cost',reason:'bounded correction'},accounting),
    error=>error.code==='MANUAL_COST_OVERLAP'
  );
  await assert.rejects(
    service.createDraft(db,{itemGuid:'GUID-M',itemCode:'MANUAL',manualCost:'612310000',effectiveFrom:'14050501',sourceType:'legacy_cost',reason:'bounded correction',supersedesResolutionId:legacy.resolutionId},accounting),
    error=>error.code==='MANUAL_COST_SUPERSESSION_EFFECTIVE_TO_REQUIRED'
  );
  const created=await service.createDraft(db,{itemGuid:'GUID-M',itemCode:'MANUAL',manualCost:'612310000',effectiveFrom:'14050501',effectiveTo:'14050531',sourceType:'legacy_cost',reason:'بازه تیر ۱۴۰۵ طبق تصمیم انسانی',supersedesResolutionId:legacy.resolutionId},accounting);
  assert.equal(created.resolution.supersedesResolutionId,legacy.resolutionId);
  assert.match(created.resolution.contentHash,/^[a-f0-9]{64}$/);
  const pending=await service.transition(db,created.resolution.resolutionId,'submit',accounting,{revision:1});
  await assert.rejects(service.transition(db,created.resolution.resolutionId,'approve',accounting,{revision:2}),error=>error.code==='MANUAL_COST_FORBIDDEN');
  const approved=await service.transition(db,created.resolution.resolutionId,'approve',manager,{revision:pending.resolution.revision});
  const unchanged=await service.getById(db,legacy.resolutionId);
  assert.deepEqual(unchanged,legacy);
  assert.deepEqual(service._effectiveRowsAt([unchanged,approved.resolution],'14050515').map(row=>row.resolutionId),[approved.resolution.resolutionId]);
  assert.deepEqual(service._effectiveRowsAt([unchanged,approved.resolution],'14050430'),[]);
  assert.deepEqual(service._effectiveRowsAt([unchanged,approved.resolution],'14050601'),[]);
  assert.deepEqual(approved.resolution.auditLog.map(row=>row.action),['created-draft','submit','approve']);
  assert.equal(approved.resolution.approvedBy.username,'manager-1');
});
