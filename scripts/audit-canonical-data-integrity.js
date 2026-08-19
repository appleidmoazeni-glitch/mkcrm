'use strict';

const { EJSON } = require('bson');
const { connectMongo, closeMongo } = require('../src/lib/mongo');
const catalog = require('../src/lib/canonical-item-catalog');
const reconciliation = require('../src/lib/item-catalog-reconciliation');
const purchase = require('../src/lib/purchase-layer-dataset');
const layerContract = require('../src/lib/canonical-purchase-layer-contract');

async function main() {
  const db = await connectMongo();
  const catalogPlan = await reconciliation.plan(db);
  const allLayers = await db.collection(purchase.LAYERS).find({}).toArray();
  const datasets = await db.collection(purchase.DATASETS).find({}).toArray();
  const state = await db.collection(purchase.STATE).findOne({ scopeKey:purchase.SCOPE_KEY || 'purchase-invoices-types-3-7' });
  const canonicalRows = allLayers.filter(layerContract.isCanonicalPurchaseLayer);
  const legacyRows = allLayers.filter(row => !layerContract.isCanonicalPurchaseLayer(row));
  const datasetIds = new Set(datasets.map(row => String(row.datasetId || '')).filter(Boolean));
  const byDataset = new Map();
  for (const row of canonicalRows) {
    const id = String(row.datasetId);
    if (!byDataset.has(id)) byDataset.set(id, []);
    byDataset.get(id).push(row);
  }
  const canonicalDatasets = [...byDataset.entries()].map(([datasetId,rows]) => {
    const dataset = datasets.find(value => value.datasetId === datasetId) || null;
    const identities = new Map();
    for (const row of rows) identities.set(String(row.purchaseLineIdentity || ''), (identities.get(String(row.purchaseLineIdentity || '')) || 0) + 1);
    return {
      datasetId,
      classification:datasetId === state?.activeDatasetId ? 'active' : (dataset?.activationStatus === 'validated-candidate' || dataset?.activationStatus === 'candidate' ? 'candidate' : 'historical'),
      status:dataset?.status || 'orphan',
      activationStatus:dataset?.activationStatus || '',
      count:rows.length,
      withinDatasetDuplicateCount:[...identities.values()].filter(count => count > 1).reduce((sum,count) => sum + count - 1,0),
      orphan:!datasetIds.has(datasetId)
    };
  }).sort((a,b) => a.datasetId.localeCompare(b.datasetId));
  const output = {
    ok:true,
    readOnly:true,
    generatedAt:new Date(),
    database:db.databaseName,
    catalog:{
      source:catalogPlan.sourceCount,
      canonical:catalogPlan.sourceCount-catalogPlan.groups.reduce((sum,group) => sum + Math.max(0,group.documentIds.length-1),0),
      matched:catalogPlan.sourceCount,
      missing:0,
      duplicateGuid:catalogPlan.duplicateGuidGroupCount,
      duplicateNormalizedCode:catalogPlan.duplicateNormalizedCodeGroupCount,
      identityConflict:catalogPlan.unsafeGuidGroupCount+catalogPlan.codeConflictCount,
      deleted:0,
      moduleVersion:catalog.MODULE_VERSION
    },
    purchase:{
      collectionTotal:allLayers.length,
      canonicalCount:canonicalRows.length,
      canonicalDatasets,
      legacyNoncanonicalCount:legacyRows.length,
      legacyClassification:layerContract.CLASSIFICATION.LEGACY,
      orphanCanonicalCount:canonicalDatasets.filter(row => row.orphan).reduce((sum,row) => sum + row.count,0),
      withinDatasetDuplicateCount:canonicalDatasets.reduce((sum,row) => sum + row.withinDatasetDuplicateCount,0)
    },
    gate:{
      pass:catalogPlan.unsafeGuidGroupCount===0 && catalogPlan.codeConflictCount===0 && catalogPlan.duplicateGuidGroupCount===0 && catalogPlan.duplicateNormalizedCodeGroupCount===0 && canonicalDatasets.every(row => row.withinDatasetDuplicateCount===0) && canonicalDatasets.every(row => !row.orphan),
      candidateActivationPerformed:false
    }
  };
  process.stdout.write(`${EJSON.stringify(output,{relaxed:true})}\n`);
}

main().catch(error => {
  process.stderr.write(`${EJSON.stringify({ok:false,error:String(error.message||error)},{relaxed:true})}\n`);
  process.exitCode=1;
}).finally(() => closeMongo().catch(() => {}));
