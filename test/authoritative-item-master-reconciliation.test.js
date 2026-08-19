'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const {MemoryDb}=require('./helpers/memory-mongo');
const master=require('../src/lib/authoritative-item-master-reconciliation');
const catalog=require('../src/lib/canonical-item-catalog');

const options={source:'shaygan-item-master-full',complete:true};
const item=(guid,code,description='Item')=>({ItemGuId:guid,ItemCode:code,ItemDesc:description});
const row=(guid,code,extra={})=>({_id:`id-${guid}`,itemGuid:guid,canonicalItemGuid:guid.toLowerCase(),itemCode:code,normalizedItemCode:code.toUpperCase(),canonicalIdentity:`guid:${guid.toLowerCase().replaceAll('-','')}`,itemDescription:'Old',...extra});

test('authoritative full master accepts same-GUID rename and preserves identity with inactive history',async()=>{
  const database=new MemoryDb({itemCatalogAll:[row('G-1','OLD',{canonicalItemGuid:'G-1'})],purchaseHistoryDiscoveryQueue:[{canonicalIdentity:'guid:g1',itemGuid:'g-1',itemCode:'OLD'}]});
  const source=[item('G-1','NEW','New description')],plan=await master.plan(database,source,options);
  assert.equal(plan.safeToApply,true);assert.equal(plan.plannedRenames,1);
  const out=await master.apply(database,source,{...options,planFingerprint:plan.planFingerprint,backupEvidence:'fresh:test'});
  assert.equal(out.renamed,1);
  const stored=database.collection(catalog.CATALOG).rows[0];
  assert.equal(stored.itemCode,'NEW');assert.equal(stored.canonicalItemGuid,'g-1');assert.equal(stored.canonicalIdentity,'guid:g1');
  assert.equal(stored.codeHistory[0].itemCode,'OLD');assert.equal(stored.codeHistory[0].activeAlias,false);
  assert.equal(database.collection('purchaseHistoryDiscoveryQueue').rows[0].itemCode,'NEW');
  assert.equal(database.collection(master.AUDIT_COLLECTION).rows[0].status,'completed');
  const repeat=await master.plan(database,source,options);assert.equal(repeat.plannedRenames,0);assert.equal(repeat.conflicts.length,0);
  const fullSyncBatch=await catalog.ensureCatalogItems(database,source,{source:'all-items-catalog-bootstrap',retainRaw:true});
  assert.equal(fullSyncBatch.ok,true);assert.equal(fullSyncBatch.conflicts.length,0);
});

test('non-authoritative discovery still rejects same-GUID code changes',async()=>{
  const database=new MemoryDb({itemCatalogAll:[row('G-1','OLD')]});
  const result=await catalog.ensureCatalogItems(database,[item('G-1','NEW')],{source:'inventory-getremain'});
  assert.equal(result.ok,false);assert.equal(result.conflicts[0].code,'IDENTITY_CONFLICT_SAME_GUID_DIFFERENT_CODE');
  assert.equal(database.collection(catalog.CATALOG).rows[0].itemCode,'OLD');
});

test('authoritative contract rejects incomplete or unapproved source',async()=>{
  const database=new MemoryDb({itemCatalogAll:[row('G-1','OLD')]});
  await assert.rejects(master.plan(database,[item('G-1','NEW')],{source:'inventory-getremain',complete:true}),error=>error.code==='AUTHORITATIVE_ITEM_MASTER_SOURCE_REQUIRED');
  await assert.rejects(master.plan(database,[item('G-1','NEW')],{source:'shaygan-item-master-full',complete:false}),error=>error.code==='AUTHORITATIVE_ITEM_MASTER_INCOMPLETE');
});

test('new code owned by another catalog GUID blocks rename',async()=>{
  const database=new MemoryDb({itemCatalogAll:[row('G-1','OLD'),row('G-2','NEW')]});
  const plan=await master.plan(database,[item('G-1','NEW'),item('G-2','OTHER')],options);
  assert.equal(plan.safeToApply,false);assert.equal(plan.conflicts[0].reason,'NEW_CODE_OWNED_BY_OTHER_CATALOG_GUID');
});

test('different GUIDs claiming one authoritative code block before any write',async()=>{
  const database=new MemoryDb({itemCatalogAll:[row('G-1','A'),row('G-2','B')]});
  await assert.rejects(master.plan(database,[item('G-1','X'),item('G-2','X')],options),error=>error.code==='AUTHORITATIVE_ITEM_MASTER_IDENTITY_CONFLICT');
  assert.deepEqual(database.collection(catalog.CATALOG).rows.map(value=>value.itemCode),['A','B']);
});

test('even byte-equivalent duplicate source identities fail the zero-duplicate source gate',async()=>{
  const database=new MemoryDb({itemCatalogAll:[row('G-1','A')]});
  await assert.rejects(master.plan(database,[item('G-1','A'),item('G-1','A')],options),error=>error.code==='AUTHORITATIVE_ITEM_MASTER_IDENTITY_CONFLICT'&&error.diagnostics.duplicateGuidCount===1&&error.diagnostics.duplicateNormalizedCodeCount===1);
});

test('old code reused by current source owner is audit-only for renamed GUID',async()=>{
  const database=new MemoryDb({itemCatalogAll:[row('G-1','OLD'),row('G-2','OLD',{_id:'owner',normalizedItemCode:'OLD'})]});
  // Pre-remediation catalogs with two owners are permitted only when the incoming NEW code is unowned;
  // OLD remains operational for G-2 and becomes inactive history for G-1.
  const source=[item('G-1','NEW'),item('G-2','OLD')],plan=await master.plan(database,source,options);
  assert.equal(plan.safeToApply,true);assert.equal(plan.plannedRenames,1);
  await master.apply(database,source,{...options,planFingerprint:plan.planFingerprint,backupEvidence:'fresh:test'});
  const renamed=database.collection(catalog.CATALOG).rows.find(value=>value.canonicalItemGuid==='g-1');
  const owner=database.collection(catalog.CATALOG).rows.find(value=>value.canonicalItemGuid==='g-2');
  assert.equal(renamed.itemCode,'NEW');assert.equal(renamed.codeHistory[0].activeAlias,false);assert.equal(owner.itemCode,'OLD');
});

test('rename touches no historical financial fact and leaves code-only purchase evidence ambiguous',async()=>{
  const purchase={datasetId:'P1',purchaseLineIdentity:'INV:483',itemCode:'OLD',itemGuid:'',classification:'LEGACY_AMBIGUOUS_CODE_ONLY_EVIDENCE'};
  const database=new MemoryDb({itemCatalogAll:[row('G-1','OLD')],saleSnapshotDatasetLines:[{lineId:'S1',itemGuid:'G-1',itemCode:'OLD'}],supplierPurchaseLayers:[purchase],fifoProfitFacts:[{factId:'F1',itemGuid:'G-1',itemCode:'OLD'}],manualCostResolutions:[{resolutionId:'M1',itemGuid:'G-1',itemCode:'OLD'}]});
  const protectedNames=['saleSnapshotDatasetLines','supplierPurchaseLayers','fifoProfitFacts','manualCostResolutions'];
  const before=Object.fromEntries(protectedNames.map(name=>[name,structuredClone(database.collection(name).rows)]));
  const source=[item('G-1','NEW')],plan=await master.plan(database,source,options);
  await master.apply(database,source,{...options,planFingerprint:plan.planFingerprint,backupEvidence:'fresh:test'});
  for(const name of protectedNames)assert.deepEqual(database.collection(name).rows,before[name],name);
  assert.equal(database.collection('supplierPurchaseLayers').rows[0].classification,'LEGACY_AMBIGUOUS_CODE_ONLY_EVIDENCE');
});

test('zero-stock catalog rows persist through governed rename',async()=>{
  const database=new MemoryDb({itemCatalogAll:[row('G-1','OLD',{quantity:0,deletedByZeroStock:false})]});
  const source=[item('G-1','NEW')],plan=await master.plan(database,source,options);
  await master.apply(database,source,{...options,planFingerprint:plan.planFingerprint,backupEvidence:'fresh:test'});
  assert.equal(database.collection(catalog.CATALOG).rows.length,1);assert.equal(database.collection(catalog.CATALOG).rows[0].quantity,0);
});

test('runtime reconciliation script is staging-guarded and never targets Production port 1385',()=>{
  const fs=require('node:fs'),source=fs.readFileSync(require('node:path').join(__dirname,'../scripts/reconcile-authoritative-item-renames.js'),'utf8');
  assert.match(source,/STAGING_DATABASE_REQUIRED/);assert.doesNotMatch(source,/(?:127\.0\.0\.1|localhost):1385/);
});
