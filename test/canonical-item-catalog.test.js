'use strict';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {MemoryDb}=require('./helpers/memory-mongo');
const catalog=require('../src/lib/canonical-item-catalog');
const purchase=require('../src/lib/purchase-layer-dataset');

test('inventory sale and purchase discovery share one persistent canonical item identity',async()=>{
  const db=new MemoryDb({itemCatalogAll:[],purchaseHistoryDiscoveryQueue:[]});
  const inventory=await catalog.ensureCatalogItem(db,{itemCode:'A',itemGuid:'G-A',itemDescription:'Alpha'},{source:'inventory-getremain'});
  const sale=await catalog.ensureCatalogItem(db,{itemCode:'A',itemGuid:'G-A',itemDescription:'Alpha'},{source:'canonical-sale-snapshot'});
  const purchaseResult=await catalog.ensureCatalogItem(db,{itemCode:'A',itemGuid:'G-A',itemDescription:'Alpha'},{source:'canonical-purchase-engine'});
  assert.equal(inventory.created,true);assert.equal(sale.created,false);assert.equal(purchaseResult.created,false);
  assert.equal(db.collection('itemCatalogAll').rows.length,1);
  assert.equal(db.collection('purchaseHistoryDiscoveryQueue').rows.length,1);
  assert.deepEqual(db.collection('itemCatalogAll').rows[0].discoverySources,['inventory-getremain','canonical-sale-snapshot','canonical-purchase-engine']);
});

test('catalog identity persists when inventory becomes zero and repeated discovery is idempotent',async()=>{
  const db=new MemoryDb({itemCatalogAll:[],itemInventoryCatalog:[{itemCode:'A',stockNumber:'01',quantity:1}],purchaseHistoryDiscoveryQueue:[]});
  await catalog.ensureCatalogItem(db,{itemCode:'A',itemGuid:'G-A'},{source:'inventory-getremain'});
  db.collection('itemInventoryCatalog').rows[0].quantity=0;
  await catalog.ensureCatalogItems(db,[{itemCode:'A',itemGuid:'G-A'},{itemCode:'A',itemGuid:'G-A'}],{source:'exact-code-repair'});
  assert.equal(db.collection('itemCatalogAll').rows.length,1);
  assert.equal(db.collection('itemCatalogAll').rows[0].persistentIdentity,true);
  assert.equal(db.collection('itemCatalogAll').rows[0].deletedByZeroStock,false);
  assert.equal(db.collection('purchaseHistoryDiscoveryQueue').rows.length,1);
});

test('same GUID with genuinely different normalized ItemCode is an explicit conflict',async()=>{
  const db=new MemoryDb({itemCatalogAll:[],purchaseHistoryDiscoveryQueue:[]});
  await catalog.ensureCatalogItem(db,{itemCode:'OLD-CODE',itemGuid:'G-STABLE',itemDescription:'Alpha'},{source:'inventory-getremain'});
  const result=await catalog.ensureCatalogItems(db,[{itemCode:'NEW-CODE',itemGuid:'G-STABLE',itemDescription:'Alpha renamed'}],{source:'canonical-sale-snapshot'});
  assert.equal(result.ok,false);
  assert.equal(result.conflicts[0].code,'IDENTITY_CONFLICT_SAME_GUID_DIFFERENT_CODE');
  assert.equal(db.collection('itemCatalogAll').rows.length,1);
  assert.equal(db.collection('itemCatalogAll').rows[0].itemCode,'OLD-CODE');
  assert.equal(db.collection('purchaseHistoryDiscoveryQueue').rows.length,1);
});

test('leading and trailing whitespace use one normalized catalog identity',async()=>{
  const db=new MemoryDb({itemCatalogAll:[],purchaseHistoryDiscoveryQueue:[]});
  const first=await catalog.ensureCatalogItem(db,{itemCode:'  CODE',itemGuid:'{ABC-123}'},{source:'all-items-catalog-bootstrap'});
  const second=await catalog.ensureCatalogItem(db,{itemCode:'CODE  ',itemGuid:'abc-123'},{source:'inventory-getremain'});
  assert.equal(first.ok,true);assert.equal(second.ok,true);assert.equal(second.created,false);
  assert.equal(db.collection('itemCatalogAll').rows.length,1);
  assert.equal(db.collection('itemCatalogAll').rows[0].itemCode,'CODE');
  assert.equal(db.collection('itemCatalogAll').rows[0].normalizedItemCode,'CODE');
  assert.equal(db.collection('itemCatalogAll').rows[0].canonicalItemGuid,'abc-123');
});

test('different GUID with the same normalized ItemCode is an explicit conflict',async()=>{
  const db=new MemoryDb({itemCatalogAll:[],purchaseHistoryDiscoveryQueue:[]});
  await catalog.ensureCatalogItem(db,{itemCode:'CODE',itemGuid:'GUID-1'},{source:'inventory-getremain'});
  const result=await catalog.ensureCatalogItems(db,[{itemCode:' CODE ',itemGuid:'GUID-2'}],{source:'canonical-sale-snapshot'});
  assert.equal(result.ok,false);
  assert.equal(result.conflicts[0].code,'IDENTITY_CONFLICT_DIFFERENT_GUID_SAME_CODE');
  assert.equal(db.collection('itemCatalogAll').rows.length,1);
});

test('code-only discovery enriches the existing GUID identity without creating a duplicate',async()=>{
  const db=new MemoryDb({itemCatalogAll:[],purchaseHistoryDiscoveryQueue:[]});
  await catalog.ensureCatalogItem(db,{itemCode:'CODE',itemGuid:'GUID-1',itemDescription:'Alpha'},{source:'canonical-sale-snapshot'});
  const result=await catalog.ensureCatalogItems(db,[{itemCode:' CODE ',itemDescription:'Alpha'}],{source:'inventory-getremain'});
  assert.equal(result.ok,true);assert.equal(db.collection('itemCatalogAll').rows.length,1);
  assert.equal(db.collection('itemCatalogAll').rows[0].canonicalItemGuid,'guid-1');
});

test('repeated canonical batch discovery is idempotent and does not delete zero-stock identity',async()=>{
  const db=new MemoryDb({itemCatalogAll:[],purchaseHistoryDiscoveryQueue:[]});
  const input=[{itemCode:' A ',itemGuid:'G-A',itemDescription:'Alpha'}];
  const first=await catalog.ensureCatalogItems(db,input,{source:'all-items-catalog-bootstrap',retainRaw:true});
  const second=await catalog.ensureCatalogItems(db,input,{source:'all-items-catalog-bootstrap',retainRaw:true});
  assert.equal(first.created,1);assert.equal(second.created,0);assert.equal(db.collection('itemCatalogAll').rows.length,1);
  assert.equal(db.collection('itemCatalogAll').rows[0].deletedByZeroStock,false);
});

test('reviewed history completion changes only catalog and queue state',async()=>{
  const db=new MemoryDb({itemCatalogAll:[],purchaseHistoryDiscoveryQueue:[],supplierPurchaseLayers:[]});
  await catalog.ensureCatalogItem(db,{itemCode:'A',itemGuid:'G-A'},{source:'sale'});
  const before=structuredClone(db.collection('supplierPurchaseLayers').rows);
  await catalog.markHistoryComplete(db,{itemCode:'A',itemGuid:'G-A'},{purchaseDatasetId:'P1',sourceFingerprint:'f'.repeat(64),result:'no-official-history-after-reviewed-recovery'});
  assert.equal((await catalog.historyStatus(db,{itemCode:'A',itemGuid:'G-A'})).complete,true);
  assert.deepEqual(db.collection('supplierPurchaseLayers').rows,before);
});

test('canonical Purchase Engine alone materializes reviewed recovery into inactive candidate',async()=>{
  const layer={datasetId:'',datasetSchemaVersion:1,purchaseLineIdentity:'INV:1',layerKind:'purchase',sourceInvoiceType:3,purchaseInvoiceGuid:'INV',purchaseInvoiceNo:1,purchaseInvoiceDate:'14050101',sourceLineItemId:'1',sourceRow:1,itemGuid:'G-A',itemCode:'A',itemDescription:'Alpha',supplierGuid:'S',supplierAccountNumber:'1',supplierName:'Supplier',originalQuantity:2,returnedQuantity:0,netPurchasedQuantity:2,remainingQuantity:2,grossUnitCost:100,netUnitCost:100,validationStatus:'valid',validationWarnings:[],returnMatchStatus:'not-applicable',sourceHash:'a'.repeat(64)};
  const db=new MemoryDb({purchaseLayerDatasetState:[{scopeKey:'purchase-invoices-types-3-7',activeDatasetId:'P-ACTIVE'}],purchaseLayerDatasets:[{datasetId:'P-ACTIVE',status:'completed',activationStatus:'active',sourceDateFrom:'12000101'}],supplierPurchaseLayers:[{...layer,datasetId:'P-ACTIVE',purchaseLineIdentity:'OLD:1'}],purchaseLayerDiagnostics:[],purchaseLayerRecoveryCandidates:[{candidateId:'R1',approvedForDatasetRebuild:true,canonicalLayer:layer,reviewedBy:{username:'admin'},reviewedAt:new Date()}]});
  const result=await purchase.buildRecoveryCandidate(db,{candidateIds:['R1']});
  assert.equal(result.ok,true);assert.equal(result.activationPerformed,false);assert.equal(result.activeDatasetId,'P-ACTIVE');assert.equal(result.recoveredLayerCount,1);
  assert.equal(db.collection('purchaseLayerDatasetState').rows[0].activeDatasetId,'P-ACTIVE');
  assert.equal(db.collection('supplierPurchaseLayers').rows.filter(row=>row.datasetId===result.datasetId).length,2);
});

test('recovery module cannot privately materialize purchase layers',()=>{
  const recovery=fs.readFileSync(path.join(__dirname,'../src/lib/purchase-history-recovery.js'),'utf8');
  assert.doesNotMatch(recovery,/collection\(['"]supplierPurchaseLayers['"]\)\.(?:insert|update|bulkWrite)/);
  assert.match(recovery,/canonicalPurchaseEngineOnly:true|canonicalLayer/);
});

test('canonical paths are wired for inventory sale purchase and exact repair',()=>{
  const server=fs.readFileSync(path.join(__dirname,'../src/server.js'),'utf8');
  const sale=fs.readFileSync(path.join(__dirname,'../src/lib/sale-snapshot.js'),'utf8');
  const purchaseSource=fs.readFileSync(path.join(__dirname,'../src/lib/purchase-layer-dataset.js'),'utf8');
  assert.match(server,/ensureCatalogItems\(db, arr/);
  assert.match(server,/exact-code-repair/);
  assert.match(sale,/source:'canonical-sale-snapshot'/);
  assert.match(purchaseSource,/source:'canonical-purchase-engine'/);
  const fullSyncIngest=server.slice(server.indexOf('async function upsertAllItemRows'),server.indexOf('async function searchAllItems'));
  assert.doesNotMatch(fullSyncIngest,/bulkWrite|itemCode:\s*x\.itemCode/);
  assert.match(server,/retainRaw:true/);
});
