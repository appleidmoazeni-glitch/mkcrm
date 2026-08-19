'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryDb}=require('./helpers/memory-mongo');
const reconciliation=require('../src/lib/item-catalog-reconciliation');
const layerContract=require('../src/lib/canonical-purchase-layer-contract');
const purchase=require('../src/lib/purchase-layer-dataset');

function canonicalLayer(overrides={}){return {datasetId:'P1',datasetSchemaVersion:1,purchaseLineIdentity:'L1',layerKind:'purchase',itemCode:'A',...overrides};}

test('safe whitespace duplicate plan selects clean survivor and preserves audit on reconciliation',async()=>{
  const db=new MemoryDb({itemCatalogAll:[
    {_id:'clean',itemCode:'CODE',itemGuid:'GUID-1',itemDescription:'old',createdAt:new Date('2026-01-01'),discoverySources:['sale']},
    {_id:'raw',itemCode:' CODE ',itemGuid:'GUID-1',itemDescription:'new',updatedAt:new Date('2026-02-01'),raw:{ItemCode:' CODE '},discoverySources:['all-items']}
  ]});
  const plan=await reconciliation.plan(db);
  assert.equal(plan.safeToApply,true);assert.equal(plan.duplicateGuidGroupCount,1);assert.equal(plan.groups[0].proposedSurvivorId,'clean');
  const out=await reconciliation.apply(db,{planFingerprint:plan.planFingerprint,backupEvidence:'fresh-backup:test'});
  assert.equal(out.ok,true);assert.equal(out.removedDocuments,1);assert.equal(db.collection('itemCatalogAll').rows.length,1);
  const survivor=db.collection('itemCatalogAll').rows[0];
  assert.equal(survivor.itemCode,'CODE');assert.equal(survivor.rawIdentityAliases.length,2);assert.deepEqual(survivor.discoverySources,['sale','all-items']);
  const audit=db.collection(reconciliation.AUDIT_COLLECTION).rows[0];
  assert.equal(audit.status,'completed');assert.equal(audit.groupResults[0].sourceDocuments.length,2);
});

test('genuine same-GUID code conflict blocks automatic catalog reconciliation',async()=>{
  const db=new MemoryDb({itemCatalogAll:[{_id:'a',itemCode:'A',itemGuid:'G'},{_id:'b',itemCode:'B',itemGuid:'G'}]});
  const plan=await reconciliation.plan(db);
  assert.equal(plan.safeToApply,false);assert.equal(plan.unsafeGuidGroupCount,1);
  await assert.rejects(reconciliation.apply(db,{planFingerprint:plan.planFingerprint,backupEvidence:'fresh'}),error=>error.code==='CATALOG_RECONCILIATION_UNSAFE_GUID_GROUP');
  assert.equal(db.collection('itemCatalogAll').rows.length,2);
});

test('different GUID same normalized code blocks automatic catalog reconciliation',async()=>{
  const db=new MemoryDb({itemCatalogAll:[{_id:'a',itemCode:'A',itemGuid:'G1'},{_id:'b',itemCode:' A ',itemGuid:'G2'}]});
  const plan=await reconciliation.plan(db);
  assert.equal(plan.safeToApply,false);assert.equal(plan.codeConflictCount,1);
});

test('safe duplicate groups reconcile while unrelated code conflicts remain untouched and block release',async()=>{
  const db=new MemoryDb({itemCatalogAll:[
    {_id:'safe-a',itemCode:' CODE-SAFE',itemGuid:'GUID-SAFE'},
    {_id:'safe-b',itemCode:'CODE-SAFE',itemGuid:'guid-safe'},
    {_id:'conflict-a',itemCode:'CODE-CONFLICT',itemGuid:'GUID-A',itemDescription:'A'},
    {_id:'conflict-b',itemCode:'CODE-CONFLICT',itemGuid:'GUID-B',itemDescription:'B'}
  ]});
  const plan=await reconciliation.plan(db);
  assert.equal(plan.safeToApply,false);assert.equal(plan.safeGroupsReconciliationAllowed,true);
  const out=await reconciliation.apply(db,{planFingerprint:plan.planFingerprint,backupEvidence:'fresh-staging-backup'});
  assert.equal(out.status,'completed_with_identity_conflicts');assert.equal(out.releaseGatePass,false);
  assert.equal(out.reconciledGroups,1);assert.equal(out.removedDocuments,1);
  assert.equal(db.collection('itemCatalogAll').rows.filter(row=>row.itemCode==='CODE-CONFLICT').length,2);
});

test('canonical purchase contract classifies and excludes legacy Supplier Sleep rows',()=>{
  const canonical=canonicalLayer(),legacy={snapshotId:'S1',persistentLayerId:'OLD',itemCode:'A',purchaseQty:2,unitCost:100};
  assert.equal(layerContract.isCanonicalPurchaseLayer(canonical),true);
  assert.equal(layerContract.classifyPurchaseLayer(legacy),'LEGACY_NONCANONICAL_PURCHASE_RECORD');
  assert.equal(layerContract.isCanonicalPurchaseLayer(legacy),false);
});

test('purchase diagnostics separate active candidate historical and legacy populations',async()=>{
  const db=new MemoryDb({
    purchaseLayerDatasetState:[{scopeKey:'purchase-invoices-types-3-7',activeDatasetId:'P-A'}],
    purchaseLayerDatasets:[{datasetId:'P-A',status:'completed',activationStatus:'active'},{datasetId:'P-C',status:'completed',activationStatus:'validated-candidate'}],
    supplierPurchaseLayers:[canonicalLayer({datasetId:'P-A',purchaseLineIdentity:'A1'}),canonicalLayer({datasetId:'P-C',purchaseLineIdentity:'C1'}),{snapshotId:'LEGACY',persistentLayerId:'OLD'}]
  });
  const out=await purchase.populationDiagnostics(db);
  assert.equal(out.collectionTotal,3);assert.equal(out.canonicalCount,2);assert.equal(out.legacyNoncanonicalCount,1);
  assert.deepEqual(out.canonicalDatasets.map(row=>row.classification).sort(),['active','candidate']);
  assert.equal(out.withinDatasetDuplicateCount,0);assert.equal(out.orphanCanonicalCount,0);
});

test('FIFO Manual Cost FSC and source-review consumers import the shared canonical layer guard',()=>{
  for(const file of ['fifo-shadow-engine.js','manual-cost-resolution.js','financial-source-control.js','accounting-operational-review.js','accounting-evidence-confidence.js','purchase-history-recovery.js','fifo-reliability.js','purchase-layer-dataset.js']){
    const source=fs.readFileSync(path.join(__dirname,'../src/lib',file),'utf8');
    assert.match(source,/canonical-purchase-layer-contract/,file);
    assert.match(source,/canonicalLayerContract\.(?:canonicalLayerQuery|canonicalPurchaseQuery|canonicalPurchaseReturnQuery)/,file);
  }
});

test('legacy diagnostic remains classification-only and no fake canonical identifiers are assigned',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/lib/canonical-purchase-layer-contract.js'),'utf8');
  assert.match(source,/LEGACY_NONCANONICAL_PURCHASE_RECORD/);
  assert.doesNotMatch(source,/updateOne|insertOne|bulkWrite|fake/i);
});

test('canonical layer query excludes legacy rows even when item and cost fields look usable',async()=>{
  const db=new MemoryDb({supplierPurchaseLayers:[canonicalLayer(),{snapshotId:'S1',persistentLayerId:'OLD',itemCode:'A',purchaseQty:99,unitCost:1}]});
  const rows=await db.collection('supplierPurchaseLayers').find(layerContract.canonicalLayerQuery({datasetId:'P1'})).toArray();
  assert.equal(rows.length,1);assert.equal(rows[0].purchaseLineIdentity,'L1');
});

test('catalog reconciliation changes no Sale Purchase FIFO or Manual Cost fact',async()=>{
  const db=new MemoryDb({
    itemCatalogAll:[{_id:'clean',itemCode:'A',itemGuid:'G-A'},{_id:'space',itemCode:' A ',itemGuid:'G-A'}],
    saleSnapshotDatasetLines:[{saleLineId:'S1',itemCode:'A'}],supplierPurchaseLayers:[canonicalLayer()],
    fifoAllocations:[{allocationId:'F1',datasetId:'F1'}],fifoProfitFacts:[{factId:'PF1'}],manualCostResolutions:[{resolutionId:'M1',status:'approved'}]
  });
  const protectedCollections=['saleSnapshotDatasetLines','supplierPurchaseLayers','fifoAllocations','fifoProfitFacts','manualCostResolutions'];
  const before=Object.fromEntries(protectedCollections.map(name=>[name,structuredClone(db.collection(name).rows)]));
  const plan=await reconciliation.plan(db);await reconciliation.apply(db,{planFingerprint:plan.planFingerprint,backupEvidence:'fresh'});
  for(const name of protectedCollections)assert.deepEqual(db.collection(name).rows,before[name],name);
});

test('every approved item discovery producer routes through canonical catalog service',()=>{
  const server=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
  const sale=fs.readFileSync(path.join(__dirname,'../src/lib/sale-snapshot.js'),'utf8');
  const purchaseSource=fs.readFileSync(path.join(__dirname,'../src/lib/purchase-layer-dataset.js'),'utf8');
  for(const source of ['inventory-getremain','all-items-catalog-bootstrap','kardex-exact-code-lookup','kardex-last-purchase-lookup'])assert.match(server,new RegExp(source));
  assert.match(sale,/canonical-sale-snapshot/);assert.match(purchaseSource,/canonical-purchase-engine/);
});

test('startup index strategy stays non-unique until runtime reconciliation proves safety',()=>{
  const source=fs.readFileSync(path.join(__dirname,'../src/lib/mongo.js'),'utf8');
  assert.match(source,/createIndex\(\{ normalizedItemCode:1 \}\)/);
  assert.match(source,/createIndex\(\{ canonicalItemGuid:1 \}\)/);
  assert.doesNotMatch(source,/createIndex\(\{ (?:normalizedItemCode|canonicalItemGuid):1 \}, \{ unique:true \}\)/);
});

test('test and runtime scripts do not target Production port 1385',()=>{
  const files=['scripts/reconcile-item-catalog.js','scripts/audit-canonical-data-integrity.js'];
  for(const file of files)assert.doesNotMatch(fs.readFileSync(path.join(__dirname,'..',file),'utf8'),/(?:127\.0\.0\.1|localhost):1385/);
});
