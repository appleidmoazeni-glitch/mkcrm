'use strict';

const crypto = require('crypto');

const CATALOG = 'itemCatalogAll';
const HISTORY_QUEUE = 'purchaseHistoryDiscoveryQueue';
const MODULE_VERSION = 'canonical-item-catalog-1.0.0';
const HISTORY_STATES = Object.freeze(['pending', 'in_progress', 'pending_review', 'complete', 'failed']);

function clean(value, max = 500) { return String(value == null ? '' : value).trim().slice(0, max); }
function normalize(value) { return clean(value, 300).toLocaleLowerCase('en-US').replace(/[\s_-]+/g, ''); }
function identityOf(item = {}) {
  const guid = clean(item.itemGuid || item.ItemGuId || item.ItemGuid, 100);
  const code = clean(item.itemCode || item.ItemCode || item.ItemNumber, 100);
  return guid ? `guid:${normalize(guid)}` : (code ? `code:${normalize(code)}` : '');
}
function sourceItem(item = {}) {
  const raw = item.raw || item;
  return {
    itemGuid:clean(item.itemGuid || item.ItemGuId || item.ItemGuid || raw.ItemGuId || raw.ItemGuid, 100),
    itemCode:clean(item.itemCode || item.ItemCode || item.ItemNumber || raw.ItemCode || raw.ItemNumber, 100),
    itemDescription:clean(item.itemDescription || item.ItemDescription || item.ItemDesc || item.ItemName || raw.ItemDescription || raw.ItemDesc, 500),
    groupNumber:clean(item.groupNumber || item.ItemGroupCode || raw.ItemGroupCode || raw.GroupNumber, 100),
    groupGuid:clean(item.groupGuid || item.ItemGroupGuId || item.ItemGroupGuid || raw.ItemGroupGuId || raw.ItemGroupGuid, 100)
  };
}
function queueId(identity) { return `PHQ-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`; }
function searchText(item) { return `${item.itemCode} ${item.itemDescription}`.trim().toLocaleLowerCase('fa'); }

async function ensureCatalogItem(db, input = {}, options = {}) {
  const item = sourceItem(input);
  const identity = identityOf(item);
  if (!identity || !item.itemCode) return { ok:false, created:false, queued:false, code:'CATALOG_ITEM_IDENTITY_REQUIRED' };
  const source = clean(options.source || input.discoverySource || 'unknown', 100);
  const now = options.now || new Date();
  const identityQuery = item.itemGuid ? { $or:[{ itemGuid:item.itemGuid }, { itemCode:item.itemCode }] } : { itemCode:item.itemCode };
  const existing = await db.collection(CATALOG).findOne(identityQuery);
  const stableIdentity=clean(existing?.canonicalIdentity,300)||identity;
  const sources = [...new Set([...(Array.isArray(existing?.discoverySources) ? existing.discoverySources : []), source].filter(Boolean))];
  const canonical = {
    itemCode:item.itemCode,
    itemGuid:item.itemGuid || clean(existing?.itemGuid, 100),
    itemDescription:item.itemDescription || clean(existing?.itemDescription, 500),
    groupNumber:item.groupNumber || clean(existing?.groupNumber, 100),
    groupGuid:item.groupGuid || clean(existing?.groupGuid, 100),
    canonicalIdentity:stableIdentity,
    searchText:searchText(item),
    discoverySources:sources,
    lastDiscoveredAt:now,
    updatedAt:now,
    persistentIdentity:true,
    deletedByZeroStock:false,
    historyCompleteness:existing?.historyCompleteness || 'incomplete',
    moduleVersion:MODULE_VERSION
  };
  const catalogFilter=existing?{itemCode:clean(existing.itemCode,100)}:{itemCode:item.itemCode};
  await db.collection(CATALOG).updateOne(
    catalogFilter,
    { $set:canonical, $setOnInsert:{ createdAt:now, firstDiscoveredAt:now } },
    { upsert:true }
  );
  let queued = false;
  if (options.queueHistory !== false && existing?.historyCompleteness !== 'complete') {
    const queue = await db.collection(HISTORY_QUEUE).findOne({ canonicalIdentity:stableIdentity });
    const discoverySources = [...new Set([...(Array.isArray(queue?.discoverySources) ? queue.discoverySources : []), source].filter(Boolean))];
    const result = await db.collection(HISTORY_QUEUE).updateOne(
      { canonicalIdentity:stableIdentity },
      { $set:{ itemGuid:canonical.itemGuid, itemCode:item.itemCode, itemDescription:canonical.itemDescription, discoverySources, lastDiscoveredAt:now, updatedAt:now, boundedRecoveryRequired:true, canonicalPurchaseEngineOnly:true }, $setOnInsert:{ queueId:queueId(stableIdentity), status:'pending', attempts:0, createdAt:now } },
      { upsert:true }
    );
    queued = Number(result.upsertedCount || 0) > 0 || queue?.status === 'failed';
  }
  return { ok:true, created:!existing, queued, canonicalIdentity:stableIdentity, itemCode:item.itemCode, historyCompleteness:existing?.historyCompleteness || 'incomplete' };
}

async function ensureCatalogItems(db, items = [], options = {}) {
  const unique = new Map();
  for (const input of items || []) {
    const item = sourceItem(input);
    if (item.itemCode) unique.set(identityOf(item) || `code:${normalize(item.itemCode)}`, input);
  }
  const summary = { ok:true, seen:unique.size, created:0, queued:0, invalid:0 };
  if(!unique.size)return summary;
  const source=clean(options.source||'unknown',100),now=options.now||new Date();
  const normalizedItems=[...unique.values()].map(sourceItem),codes=normalizedItems.map(row=>row.itemCode),guids=normalizedItems.map(row=>row.itemGuid).filter(Boolean);
  const existingRows=await db.collection(CATALOG).find({$or:[{itemCode:{$in:codes}},...(guids.length?[{itemGuid:{$in:guids}}]:[])]}).toArray();
  const existingByCode=new Map(existingRows.map(row=>[clean(row.itemCode,100),row]));
  const existingByGuid=new Map(existingRows.filter(row=>clean(row.itemGuid,100)).map(row=>[clean(row.itemGuid,100),row]));
  const identities=[...new Set(existingRows.map(row=>clean(row.canonicalIdentity,300)).filter(Boolean))];
  const queueRows=options.queueHistory===false||!identities.length?[]:await db.collection(HISTORY_QUEUE).find({canonicalIdentity:{$in:identities}}).toArray();
  const queueByIdentity=new Map(queueRows.map(row=>[clean(row.canonicalIdentity,300),row]));
  const catalogOps=[],queueOps=[];
  for(const input of unique.values()){
    const item=sourceItem(input),code=item.itemCode,derivedIdentity=identityOf(item),existing=(item.itemGuid&&existingByGuid.get(item.itemGuid))||existingByCode.get(code),identity=clean(existing?.canonicalIdentity,300)||derivedIdentity;
    if(!identity){summary.invalid++;continue;}
    if(!existing)summary.created++;
    const canonical={itemCode:code,itemGuid:item.itemGuid||clean(existing?.itemGuid,100),itemDescription:item.itemDescription||clean(existing?.itemDescription,500),groupNumber:item.groupNumber||clean(existing?.groupNumber,100),groupGuid:item.groupGuid||clean(existing?.groupGuid,100),canonicalIdentity:identity,searchText:searchText({...item,itemDescription:item.itemDescription||existing?.itemDescription||''}),discoverySources:[...new Set([...(existing?.discoverySources||[]),source].filter(Boolean))],lastDiscoveredAt:now,updatedAt:now,persistentIdentity:true,deletedByZeroStock:false,historyCompleteness:existing?.historyCompleteness||'incomplete',moduleVersion:MODULE_VERSION};
    const catalogUnchanged=existing&&existing.itemCode===canonical.itemCode&&clean(existing.itemGuid,100)===canonical.itemGuid&&clean(existing.itemDescription,500)===canonical.itemDescription&&clean(existing.groupNumber,100)===canonical.groupNumber&&clean(existing.groupGuid,100)===canonical.groupGuid&&clean(existing.canonicalIdentity,300)===identity&&existing.persistentIdentity===true&&existing.deletedByZeroStock===false&&existing.moduleVersion===MODULE_VERSION&&(existing.discoverySources||[]).includes(source);
    if(!catalogUnchanged)catalogOps.push({updateOne:{filter:existing?{itemCode:clean(existing.itemCode,100)}:{itemCode:code},update:{$set:canonical,$setOnInsert:{createdAt:now,firstDiscoveredAt:now}},upsert:true}});
    if(options.queueHistory!==false&&existing?.historyCompleteness!=='complete'){
      const queue=queueByIdentity.get(identity);if(!queue)summary.queued++;
      const queueUnchanged=queue&&queue.itemGuid===canonical.itemGuid&&queue.itemCode===code&&queue.itemDescription===canonical.itemDescription&&(queue.discoverySources||[]).includes(source)&&queue.boundedRecoveryRequired===true&&queue.canonicalPurchaseEngineOnly===true;
      if(!queueUnchanged)queueOps.push({updateOne:{filter:{canonicalIdentity:identity},update:{$set:{itemGuid:canonical.itemGuid,itemCode:code,itemDescription:canonical.itemDescription,discoverySources:[...new Set([...(queue?.discoverySources||[]),source].filter(Boolean))],lastDiscoveredAt:now,updatedAt:now,boundedRecoveryRequired:true,canonicalPurchaseEngineOnly:true},$setOnInsert:{queueId:queueId(identity),status:'pending',attempts:0,createdAt:now}},upsert:true}});
    }
  }
  if(catalogOps.length)await db.collection(CATALOG).bulkWrite(catalogOps,{ordered:false});
  if(queueOps.length)await db.collection(HISTORY_QUEUE).bulkWrite(queueOps,{ordered:false});
  return summary;
}

async function markHistoryComplete(db, input = {}, evidence = {}) {
  const item = sourceItem(input);
  const derivedIdentity = identityOf(item);
  if (!derivedIdentity || !item.itemCode) throw Object.assign(new Error('Canonical item identity required'), { code:'CATALOG_ITEM_IDENTITY_REQUIRED' });
  const now = evidence.completedAt || new Date();
  await ensureCatalogItem(db, item, { source:evidence.source || 'purchase-history-recovery', queueHistory:false, now });
  const catalog=await db.collection(CATALOG).findOne({itemCode:item.itemCode});
  const identity=clean(catalog?.canonicalIdentity,300)||derivedIdentity;
  await db.collection(CATALOG).updateOne({ itemCode:item.itemCode }, { $set:{ historyCompleteness:'complete', historyCompletedAt:now, historyEvidence:{ purchaseDatasetId:clean(evidence.purchaseDatasetId,100), sourceFingerprint:clean(evidence.sourceFingerprint,128), dateFrom:clean(evidence.dateFrom,8), dateTo:clean(evidence.dateTo,8), result:clean(evidence.result || 'reviewed',100) }, updatedAt:now } });
  await db.collection(HISTORY_QUEUE).updateOne({ canonicalIdentity:identity }, { $set:{ status:'complete', completedAt:now, updatedAt:now, completionEvidence:{ purchaseDatasetId:clean(evidence.purchaseDatasetId,100), sourceFingerprint:clean(evidence.sourceFingerprint,128), result:clean(evidence.result || 'reviewed',100) } } }, { upsert:true });
  return { ok:true, canonicalIdentity:identity, historyCompleteness:'complete' };
}

async function historyStatus(db, input = {}) {
  const item = sourceItem(input);
  const catalog = item.itemCode ? await db.collection(CATALOG).findOne({ itemCode:item.itemCode }) : (item.itemGuid?await db.collection(CATALOG).findOne({itemGuid:item.itemGuid}):null);
  const identity = clean(catalog?.canonicalIdentity,300)||identityOf(item);
  const queue = identity ? await db.collection(HISTORY_QUEUE).findOne({ canonicalIdentity:identity }) : null;
  return { complete:catalog?.historyCompleteness === 'complete', state:catalog?.historyCompleteness || 'missing', catalog, queue };
}

module.exports = { CATALOG, HISTORY_QUEUE, MODULE_VERSION, HISTORY_STATES, ensureCatalogItem, ensureCatalogItems, markHistoryComplete, historyStatus, _identityOf:identityOf, _sourceItem:sourceItem };
