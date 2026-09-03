'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryDb}=require('./helpers/memory-mongo');
const opening=require('../src/lib/opening-accounting-cost-basis');
const fifo=require('../src/lib/fifo-shadow-engine');

const admin={userId:'U-ADMIN',username:'admin',name:'Admin',role:'admin'};

async function approved(db,itemCode,datasetSuffix){
  const built=await opening.buildCandidate(db,{openingDate:'14050110',createdBy:admin,items:[{itemGuid:`G-${itemCode}`,itemCode}]},{shaygan:{getKardexByItemCode:async()=>({ok:true,item:{itemGuid:`G-${itemCode}`,itemCode},openingBasis:{openingQuantity:2,openingTotalValue:200,sourceFields:{}},rows:[{date:'2026-03-30'}],meta:{reachedLimit:false}})}});
  const originalId=built.datasetId;
  if(datasetSuffix){
    const dataset=db.collection(opening.DATASETS).rows.find(row=>row.datasetId===originalId);
    dataset.datasetId=`OPEN-${datasetSuffix}`;
    for(const collection of [opening.COLLECTION,opening.PROGRESS,opening.ELIGIBILITY])for(const row of db.collection(collection).rows)if(row.datasetId===originalId)row.datasetId=dataset.datasetId;
    built.datasetId=dataset.datasetId;
  }
  const detail=await opening.candidateDetail(db,built.datasetId,{});
  const expectedFingerprints={dataset:built.datasetFingerprint,source:detail.authorityPreview.sourceAggregateFingerprint,eligibility:built.eligibilityPreview.fingerprint};
  await opening.submitCandidate(db,built.datasetId,{revision:1,reason:'test submit',expectedFingerprints,humanValidationCheckpoint:{assertedByManagement:true,passCards:['OPEN-P01'],source:'isolated test'}},admin);
  await opening.approveCandidate(db,built.datasetId,{revision:2,reason:'test approve',expectedFingerprints,managementAuthorizedSelfApproval:true},admin);
  return {datasetId:built.datasetId,expectedFingerprints};
}

test('APPROVED to REVOKED preserves evidence and blocks explicit future FIFO authority',async()=>{
  const db=new MemoryDb({settings:[{key:'inventory.activeWarehouseNumbers',value:['01']}],fifoDatasets:[{datasetId:'HISTORICAL',sourceOpeningDatasetId:'OPEN-A',candidateFingerprint:'immutable'}]});
  const a=await approved(db,'A','A'),evidence=structuredClone(db.collection(opening.COLLECTION).rows),historical=structuredClone(db.collection('fifoDatasets').rows);
  const result=await opening.revokeAuthority(db,a.datasetId,{revision:3,reason:'governed withdrawal',expectedFingerprints:a.expectedFingerprints},admin);
  assert.equal(result.lifecycleStatus,'REVOKED');
  assert.deepEqual(db.collection(opening.COLLECTION).rows,evidence);
  assert.deepEqual(db.collection('fifoDatasets').rows,historical);
  assert.equal(db.collection(opening.APPROVALS).rows.at(-1).action,'REVOKE');
  assert.equal(db.collection(opening.APPROVALS).rows.at(-1).financialApprovalSummary.totalOpeningAccountingValueExact,'200.00');
  await assert.rejects(opening.resolveOpeningAuthority(db,{datasetId:a.datasetId}),error=>error.code==='OPENING_AUTHORITY_REVOKED');
});

test('APPROVED A can be explicitly SUPERSEDED only by eligible APPROVED B',async()=>{
  const db=new MemoryDb({settings:[{key:'inventory.activeWarehouseNumbers',value:['01']}]});
  const a=await approved(db,'A','A'),b=await approved(db,'B','B');
  const aEvidence=structuredClone(db.collection(opening.COLLECTION).rows),bResolution=await opening.resolveOpeningAuthority(db,{datasetId:b.datasetId});
  assert.equal(bResolution.datasetId,b.datasetId);
  const result=await opening.supersedeAuthority(db,a.datasetId,{revision:3,reason:'explicit governed replacement',successorDatasetId:b.datasetId,expectedFingerprints:a.expectedFingerprints},admin);
  assert.equal(result.lifecycleStatus,'SUPERSEDED');
  assert.equal(result.successorDatasetId,b.datasetId);
  await assert.rejects(opening.resolveOpeningAuthority(db,{datasetId:a.datasetId}),error=>error.code==='OPENING_AUTHORITY_SUPERSEDED');
  assert.equal((await opening.resolveOpeningAuthority(db,{})).datasetId,b.datasetId);
  assert.deepEqual(db.collection(opening.COLLECTION).rows,aEvidence);
});

test('supersede fails closed for non-approved successor and multiple eligible authorities fail closed',async()=>{
  const db=new MemoryDb({settings:[{key:'inventory.activeWarehouseNumbers',value:['01']}]});
  const a=await approved(db,'A','A'),b=await approved(db,'B','B');
  await assert.rejects(opening.resolveOpeningAuthority(db,{}),error=>error.code==='OPENING_AUTHORITY_AMBIGUOUS');
  const successor=db.collection(opening.DATASETS).rows.find(row=>row.datasetId===b.datasetId);successor.approvalStatus='pending';successor.authorityLifecycleStatus='PENDING_APPROVAL';
  await assert.rejects(opening.supersedeAuthority(db,a.datasetId,{revision:3,reason:'invalid successor',successorDatasetId:b.datasetId,expectedFingerprints:a.expectedFingerprints},admin),error=>error.code==='OPENING_SUCCESSOR_INELIGIBLE');
  assert.equal(opening._authorityLifecycleStatus(db.collection(opening.DATASETS).rows.find(row=>row.datasetId===a.datasetId)),'APPROVED');
});

test('future FIFO source loading rejects a revoked pinned Opening before evidence consumption',async()=>{
  const db=new MemoryDb({
    saleSnapshots:[{snapshotId:'SALE',status:'completed'}],saleSnapshotDatasetLines:[],saleSnapshotDatasetHeaders:[],
    purchaseLayerDatasets:[{datasetId:'PURCHASE',status:'completed'}],supplierPurchaseLayers:[],
    openingAccountingEvidenceDatasets:[{datasetId:'OPEN',status:'completed',approvalStatus:'approved',authorityLifecycleStatus:'REVOKED'}]
  });
  await assert.rejects(fifo._loadSources(db,{saleSnapshotId:'SALE',purchaseDatasetId:'PURCHASE',openingDatasetId:'OPEN'}),error=>error.code==='OPENING_AUTHORITY_REVOKED');
});

test('authority resolution index supports bounded local lookup',async()=>{
  const db=new MemoryDb();
  const names=await opening.ensureResourceGovernorIndexes(db);
  assert.ok(names.includes('opening_authority_resolution'));
  const index=(await db.collection(opening.DATASETS).indexes()).find(row=>row.name==='opening_authority_resolution');
  assert.deepEqual(index.key,{status:1,approvalStatus:1,authorityLifecycleStatus:1,datasetId:1});
});

test('lifecycle actions require governed role and mandatory reason',async()=>{
  const db=new MemoryDb({settings:[{key:'inventory.activeWarehouseNumbers',value:['01']}]});
  const a=await approved(db,'A','A');
  await assert.rejects(opening.revokeAuthority(db,a.datasetId,{revision:3,reason:'manager attempt',expectedFingerprints:a.expectedFingerprints},{username:'manager',role:'manager'}),error=>error.code==='OPENING_LIFECYCLE_ROLE_FORBIDDEN');
  await assert.rejects(opening.revokeAuthority(db,a.datasetId,{revision:3,reason:'',expectedFingerprints:a.expectedFingerprints},admin),error=>error.code==='OPENING_LIFECYCLE_REASON_REQUIRED');
});

test('existing Opening UI exposes lifecycle controls and financial confirmation warning',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8');
  const server=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
  assert.match(ui,/لغو Authority/);
  assert.match(ui,/جایگزینی Authority/);
  assert.match(ui,/FIFOهای تاریخی بازنویسی نمی‌شوند/);
  assert.match(ui,/successorDatasetId/);
  assert.match(server,/revoke\|supersede/);
  assert.match(server,/resolveOpeningAuthority/);
});
