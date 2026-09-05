'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryDb}=require('./helpers/memory-mongo');
const fifo=require('../src/lib/fifo-shadow-engine');

const actors={admin:{userId:'U-1',username:'admin',displayName:'Admin',role:'admin'},accounting:{userId:'U-2',username:'accounting',displayName:'Accounting',role:'accounting'},purchase:{userId:'U-3',username:'purchase',displayName:'Commercial',role:'purchase'},manager:{userId:'U-4',username:'manager',role:'manager'}};
function source(){return {saleActive:{snapshotId:'SALE-A',snapshot:{status:'completed'}},purchaseActive:{datasetId:'PUR-A',dataset:{status:'completed'}},openingActive:{datasetId:'OPEN-A',dataset:{status:'completed',approvalStatus:'approved',revision:3},governance:{datasetFingerprint:'d'.repeat(64),sourceFingerprint:'s'.repeat(64),eligibilityFingerprint:'e'.repeat(64)}},saleHeaders:[],saleLines:[{snapshotId:'SALE-A',saleLineId:'SL-1',saleInvoiceType:2,saleInvoiceNo:1,saleDate:'14050111',row:1,itemGuid:'G-1',itemCode:'I-1',qty:1,saleValue:200}],purchaseLayers:[{datasetId:'PUR-A',purchaseLineIdentity:'PL-1',layerKind:'purchase',validationStatus:'valid',purchaseInvoiceDate:'14050110',purchaseInvoiceNo:1,sourceRow:1,itemGuid:'G-1',itemCode:'I-1',netPurchasedQuantity:1,netUnitCost:'100'}],openingRows:[],manuals:[],purchaseReturnResolutions:[],saleReturnResolutions:[]};}
function dbSeed(){return new MemoryDb({saleSnapshots:[{snapshotId:'SALE-A',status:'completed'}],saleSnapshotState:[{scopeKey:'sale',activeSnapshotId:'SALE-A',activatedAt:new Date()}],saleSnapshotDatasetLines:[],saleSnapshotDatasetHeaders:[],purchaseLayerDatasets:[{datasetId:'PUR-A',status:'completed'}],purchaseLayerDatasetState:[{scopeKey:'purchase-invoices-types-3-7',activeDatasetId:'PUR-A'}],supplierPurchaseLayers:[],openingAccountingEvidenceDatasets:[{datasetId:'OPEN-A',status:'completed',approvalStatus:'approved',authorityLifecycleStatus:'APPROVED',revision:3,datasetFingerprint:'d'.repeat(64),sourceAggregateFingerprint:'s'.repeat(64),eligibilityPreview:{fingerprint:'e'.repeat(64)}}],openingAccountingCostBasis:[],openingAccountingEvidenceProgress:[],openingAccountingEligibilityPreview:[],manualCostResolutions:[],purchaseReturnResolutions:[],saleReturnResolutions:[],fifoDatasets:[],fifoAllocations:[],fifoDiagnostics:[],fifoExceptions:[],fifoDatasetState:[],fifoHumanValidationAudits:[]});}
async function candidateFixture(){const db=dbSeed(),bundle=source();const built=await fifo.buildShadowDataset(db,{saleSnapshotId:'SALE-A',purchaseDatasetId:'PUR-A',openingDatasetId:'OPEN-A',sourceLoader:async()=>structuredClone(bundle)},actors.accounting);const dataset=db.collection(fifo.DATASETS).rows.find(row=>row.datasetId===built.datasetId);return {db,bundle,built,dataset,input:{expectedFingerprints:{candidate:dataset.candidateFingerprint,source:dataset.sourceFingerprint,allocation:dataset.allocationFingerprint}}};}

test('fingerprint-bound Human PASS is immutable, role-governed, and invalidated by Candidate drift',async()=>{
  const {db,built,dataset,input}=await candidateFixture();
  await assert.rejects(fifo.recordHumanValidation(db,built.datasetId,{...input,result:'PASS',reason:'x',humanTests:fifo.REQUIRED_HUMAN_TESTS},actors.manager),error=>error.code==='FIFO_ACTIVATION_FORBIDDEN');
  const recorded=await fifo.recordHumanValidation(db,built.datasetId,{...input,result:'PASS',reason:'Management Human validation completed',humanTests:fifo.REQUIRED_HUMAN_TESTS},actors.accounting);
  assert.equal(recorded.humanValidated,true);assert.equal(recorded.validation.immutable,true);assert.equal(recorded.validation.actor.username,'accounting');assert.equal(db.collection(fifo.HUMAN_VALIDATIONS).rows.length,1);
  assert.equal((await fifo._qualifyingHumanValidation(db,dataset)).validationId,recorded.validation.validationId);
  const changed={...dataset,candidateFingerprint:'f'.repeat(64)};assert.equal(await fifo._qualifyingHumanValidation(db,changed),null);
});

test('incomplete Human population records evidence but cannot qualify activation',async()=>{
  const {db,built,dataset,input}=await candidateFixture();
  const recorded=await fifo.recordHumanValidation(db,built.datasetId,{...input,result:'PASS',reason:'Only one supplied test',humanTests:[fifo.REQUIRED_HUMAN_TESTS[0]]},actors.purchase);
  assert.equal(recorded.humanValidated,false);assert.equal(await fifo._qualifyingHumanValidation(db,dataset),null);
});

test('activation performs read-only deterministic replay then atomically selects authority without Candidate mutation',async()=>{
  const {db,bundle,built,dataset,input}=await candidateFixture();
  const beforeDataset=structuredClone(dataset),beforeAllocations=structuredClone(db.collection(fifo.ALLOCATIONS).rows);
  const recorded=await fifo.recordHumanValidation(db,built.datasetId,{...input,result:'PASS',reason:'Management Human validation completed',humanTests:fifo.REQUIRED_HUMAN_TESTS},actors.admin);
  const gate=await fifo.activationGate(db,built.datasetId,{sourceLoader:async()=>structuredClone(bundle)});
  assert.equal(gate.eligible,true);assert.equal(gate.currentActiveDatasetId,'');assert.equal(gate.revalidation.validation.valid,true);assert.equal(gate.revalidation.safety.futurePurchaseLeakage,0);
  const activated=await fifo.activateDataset(db,built.datasetId,{...input,reason:'Management-authorized activation after canonical authority reconciliation',humanValidationId:recorded.validation.validationId,expectedPreviousActiveDatasetId:'',authorityRevision:0},actors.admin,{sourceLoader:async()=>structuredClone(bundle)});
  assert.equal(activated.activeDatasetId,built.datasetId);assert.equal(activated.activationAudit.action,'ACTIVATE_FIFO');assert.equal(activated.activationAudit.humanValidationId,recorded.validation.validationId);
  assert.deepEqual(db.collection(fifo.DATASETS).rows.find(row=>row.datasetId===built.datasetId),beforeDataset);assert.deepEqual(db.collection(fifo.ALLOCATIONS).rows,beforeAllocations);
  const active=await fifo.activeDataset(db);assert.equal(active.datasetId,built.datasetId);assert.equal(active.authorityContractVersion,1);
  const state=db.collection(fifo.STATE).rows[0];assert.equal(state.activationAuditLog.length,1);assert.equal(state.authorityRevision,1);
});

test('activation fails closed for stale state, fingerprint, Human audit, or changed canonical authorities',async()=>{
  const {db,bundle,built,dataset,input}=await candidateFixture();
  const recorded=await fifo.recordHumanValidation(db,built.datasetId,{...input,result:'PASS',reason:'Management Human validation completed',humanTests:fifo.REQUIRED_HUMAN_TESTS},actors.admin);
  const base={...input,reason:'Authorized',humanValidationId:recorded.validation.validationId,expectedPreviousActiveDatasetId:'',authorityRevision:0};
  await assert.rejects(fifo.activateDataset(db,built.datasetId,{...base,expectedFingerprints:{...input.expectedFingerprints,allocation:'f'.repeat(64)}},actors.admin,{sourceLoader:async()=>structuredClone(bundle)}),error=>error.code==='FIFO_ACTIVATION_FINGERPRINT_STALE');
  await assert.rejects(fifo.activateDataset(db,built.datasetId,{...base,humanValidationId:'wrong'},actors.admin,{sourceLoader:async()=>structuredClone(bundle)}),error=>error.code==='FIFO_HUMAN_VALIDATION_STALE');
  db.collection('purchaseLayerDatasetState').rows[0].activeDatasetId='PUR-B';
  await assert.rejects(fifo.activateDataset(db,built.datasetId,base,actors.admin,{sourceLoader:async()=>structuredClone(bundle)}),error=>error.code==='FIFO_ACTIVATION_PURCHASE_AUTHORITY_CHANGED');
  assert.equal(db.collection(fifo.STATE).rows[0]?.activeDatasetId||'','');assert.equal(dataset.candidateFingerprint,input.expectedFingerprints.candidate);
});

test('UI and API expose governed Human validation and activation without financial rebuild controls',()=>{
  const ui=fs.readFileSync(path.join(__dirname,'../public/assets/app.js'),'utf8'),server=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
  assert.match(ui,/ثبت Human PASS/);assert.match(ui,/ACTIVE FIFO/);assert.match(ui,/fifo-shadow\/human-validation/);assert.match(ui,/fifo-shadow\/activate/);
  assert.match(server,/fifo-shadow\/activation-gate/);assert.match(server,/fifoShadowEngine\.recordHumanValidation/);assert.match(server,/fifoShadowEngine\.activateDataset/);
});
