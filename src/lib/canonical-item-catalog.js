'use strict';

const crypto = require('crypto');
const inventoryAutoSyncPolicy = require('./inventory-auto-sync-policy');

const CATALOG = 'itemCatalogAll';
const HISTORY_QUEUE = 'purchaseHistoryDiscoveryQueue';
const MODULE_VERSION = 'canonical-item-catalog-1.1.0';
const HISTORY_STATES = Object.freeze(['pending', 'in_progress', 'pending_review', 'complete', 'failed']);

function clean(value, max = 500) {
  return String(value == null ? '' : value).normalize('NFKC').trim().slice(0, max);
}
function canonicalItemCode(value) { return clean(value, 100); }
function normalizedItemCode(value) { return canonicalItemCode(value).toLocaleUpperCase('en-US'); }
function canonicalItemGuid(value) {
  return clean(value, 100).replace(/^\{(.+)\}$/, '$1').toLocaleLowerCase('en-US');
}
function legacyIdentityToken(value) {
  return clean(value, 300).toLocaleLowerCase('en-US').replace(/[\s_-]+/g, '');
}
function identityOf(item = {}) {
  const guid = canonicalItemGuid(item.itemGuid || item.ItemGuId || item.ItemGuid);
  const code = normalizedItemCode(item.itemCode || item.ItemCode || item.ItemNumber);
  return guid ? `guid:${legacyIdentityToken(guid)}` : (code ? `code:${legacyIdentityToken(code)}` : '');
}
function sourceItem(item = {}) {
  const raw = item.raw || item;
  return {
    itemGuid:canonicalItemGuid(item.itemGuid || item.ItemGuId || item.ItemGuid || raw.ItemGuId || raw.ItemGuid),
    itemCode:canonicalItemCode(item.itemCode || item.ItemCode || item.ItemNumber || raw.ItemCode || raw.ItemNumber),
    itemDescription:clean(item.itemDescription || item.ItemDescription || item.ItemDesc || item.ItemName || raw.ItemDescription || raw.ItemDesc, 500),
    groupNumber:clean(item.groupNumber || item.ItemGroupCode || raw.ItemGroupCode || raw.GroupNumber, 100),
    groupGuid:canonicalItemGuid(item.groupGuid || item.ItemGroupGuId || item.ItemGroupGuid || raw.ItemGroupGuId || raw.ItemGroupGuid)
  };
}
function queueId(identity) { return `PHQ-${crypto.createHash('sha256').update(identity).digest('hex').slice(0, 24)}`; }
function searchText(item) { return `${item.itemCode} ${item.itemDescription}`.trim().toLocaleLowerCase('fa'); }
function rowCodeKey(row = {}) { const value=row||{};return normalizedItemCode(value.normalizedItemCode || value.itemCode); }
function rowGuidKey(row = {}) { const value=row||{};return canonicalItemGuid(value.canonicalItemGuid || value.itemGuid); }
function uniqueRows(rows = []) {
  const seen = new Set();
  return rows.filter(row => {
    const key = row?._id == null ? `${rowGuidKey(row)}|${rowCodeKey(row)}|${clean(row.itemCode,100)}` : String(row._id);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function conflict(code, item, rows = [], details = {}) {
  return {
    code,
    itemGuid:item.itemGuid,
    itemCode:item.itemCode,
    normalizedItemCode:normalizedItemCode(item.itemCode),
    conflictingDocumentIds:uniqueRows(rows).map(row => String(row._id || '')).filter(Boolean),
    ...details
  };
}
function resolveExisting(item, guidRows = [], codeRows = []) {
  const guidKey = canonicalItemGuid(item.itemGuid);
  const codeKey = normalizedItemCode(item.itemCode);
  const candidates = uniqueRows([...guidRows, ...codeRows]);
  const sameGuidDifferentCode = guidKey ? guidRows.filter(row => rowCodeKey(row) && rowCodeKey(row) !== codeKey) : [];
  if (sameGuidDifferentCode.length) {
    return { existing:null, conflict:conflict('IDENTITY_CONFLICT_SAME_GUID_DIFFERENT_CODE', item, sameGuidDifferentCode, { existingCodes:[...new Set(sameGuidDifferentCode.map(row => canonicalItemCode(row.itemCode)))] }) };
  }
  const differentGuidSameCode = guidKey ? codeRows.filter(row => rowGuidKey(row) && rowGuidKey(row) !== guidKey) : [];
  if (differentGuidSameCode.length) {
    return { existing:null, conflict:conflict('IDENTITY_CONFLICT_DIFFERENT_GUID_SAME_CODE', item, differentGuidSameCode, { existingGuids:[...new Set(differentGuidSameCode.map(row => canonicalItemGuid(row.itemGuid)))] }) };
  }
  if (candidates.length > 1) {
    const safe = candidates.every(row => rowCodeKey(row) === codeKey && (!guidKey || rowGuidKey(row) === guidKey));
    return { existing:null, conflict:conflict(safe ? 'SAFE_NORMALIZATION_DUPLICATE_REQUIRES_RECONCILIATION' : 'IDENTITY_CONFLICT_MULTIPLE_CATALOG_ROWS', item, candidates) };
  }
  return { existing:candidates[0] || null, conflict:null };
}
function inputConflicts(items = []) {
  const byGuid = new Map(), byCode = new Map(), conflicts = new Map();
  for (const item of items) {
    const guid = canonicalItemGuid(item.itemGuid), code = normalizedItemCode(item.itemCode);
    if (guid) {
      const prior = byGuid.get(guid);
      if (prior && prior.code !== code) {
        conflicts.set(`${guid}|${code}`, conflict('IDENTITY_CONFLICT_SAME_GUID_DIFFERENT_CODE', item, [], { existingCodes:[prior.item.itemCode] }));
        conflicts.set(`${guid}|${prior.code}`, conflict('IDENTITY_CONFLICT_SAME_GUID_DIFFERENT_CODE', prior.item, [], { existingCodes:[item.itemCode] }));
      } else byGuid.set(guid, { code, item });
    }
    const prior = byCode.get(code);
    if (prior && prior.guid && guid && prior.guid !== guid) {
      conflicts.set(`${guid}|${code}`, conflict('IDENTITY_CONFLICT_DIFFERENT_GUID_SAME_CODE', item, [], { existingGuids:[prior.guid] }));
      conflicts.set(`${prior.guid}|${code}`, conflict('IDENTITY_CONFLICT_DIFFERENT_GUID_SAME_CODE', prior.item, [], { existingGuids:[guid] }));
    } else if (!prior) byCode.set(code, { guid, item });
  }
  return conflicts;
}
function itemKey(item = {}) { return `${canonicalItemGuid(item.itemGuid)}|${normalizedItemCode(item.itemCode)}`; }

async function ensureCatalogItems(db, inputs = [], options = {}) {
  const normalized = (inputs || []).map(sourceItem).filter(item => item.itemCode);
  const invalid = (inputs || []).length - normalized.length;
  const batchConflicts = inputConflicts(normalized);
  const unique = new Map();
  for (const item of normalized) {
    if (batchConflicts.has(itemKey(item))) continue;
    const key = normalizedItemCode(item.itemCode), prior = unique.get(key);
    if (!prior || (!prior.itemGuid && item.itemGuid)) unique.set(key,item);
  }
  const summary = { ok:true, seen:normalized.length, processed:unique.size, created:0, updated:0, unchanged:0, queued:0, invalid, conflicts:[...batchConflicts.values()] };
  if (!unique.size) { summary.ok = summary.conflicts.length === 0; return summary; }

  const source = clean(options.source || 'unknown', 100), now = options.now || new Date();
  const items = [...unique.values()];
  const codes = [...new Set(items.map(item => normalizedItemCode(item.itemCode)).filter(Boolean))];
  const rawCodes = [...new Set(items.map(item => item.itemCode).filter(Boolean))];
  const guids = [...new Set(items.map(item => canonicalItemGuid(item.itemGuid)).filter(Boolean))];
  const canonicalIdentities = [...new Set(items.map(identityOf).filter(Boolean))];
  const queryParts = [{ normalizedItemCode:{ $in:codes } }, { itemCode:{ $in:rawCodes } }];
  if (canonicalIdentities.length) queryParts.push({ canonicalIdentity:{ $in:canonicalIdentities } });
  if (guids.length) queryParts.push({ canonicalItemGuid:{ $in:guids } }, { itemGuid:{ $in:guids } });
  const existingRows = await db.collection(CATALOG).find({ $or:queryParts }).toArray();
  const byCode = new Map(), byGuid = new Map();
  for (const row of existingRows) {
    const code = rowCodeKey(row), guid = rowGuidKey(row);
    if (code) { if (!byCode.has(code)) byCode.set(code, []); byCode.get(code).push(row); }
    if (guid) { if (!byGuid.has(guid)) byGuid.set(guid, []); byGuid.get(guid).push(row); }
  }
  const identities = [...new Set(existingRows.map(row => clean(row.canonicalIdentity, 300)).filter(Boolean))];
  const queueRows = options.queueHistory === false || !identities.length ? [] : await db.collection(HISTORY_QUEUE).find({ canonicalIdentity:{ $in:identities } }).toArray();
  const queueByIdentity = new Map(queueRows.map(row => [clean(row.canonicalIdentity, 300), row]));
  const catalogOps = [], queueOps = [], inventoryQueueOps = [];

  for (const item of items) {
    const codeKey = normalizedItemCode(item.itemCode), guidKey = canonicalItemGuid(item.itemGuid);
    const resolved = resolveExisting(item, byGuid.get(guidKey) || [], byCode.get(codeKey) || []);
    if (resolved.conflict) { summary.conflicts.push(resolved.conflict); continue; }
    const existing = resolved.existing;
    const identity = clean(existing?.canonicalIdentity, 300) || identityOf(item);
    if (!identity) { summary.invalid++; continue; }
    const canonical = {
      itemCode:item.itemCode,
      normalizedItemCode:codeKey,
      itemGuid:item.itemGuid || canonicalItemGuid(existing?.itemGuid),
      canonicalItemGuid:guidKey || rowGuidKey(existing),
      itemDescription:item.itemDescription || clean(existing?.itemDescription, 500),
      groupNumber:item.groupNumber || clean(existing?.groupNumber, 100),
      groupGuid:item.groupGuid || canonicalItemGuid(existing?.groupGuid),
      canonicalIdentity:identity,
      searchText:searchText({ ...item, itemDescription:item.itemDescription || existing?.itemDescription || '' }),
      discoverySources:[...new Set([...(Array.isArray(existing?.discoverySources) ? existing.discoverySources : []), source].filter(Boolean))],
      lastDiscoveredAt:now,
      updatedAt:now,
      persistentIdentity:true,
      deletedByZeroStock:false,
      historyCompleteness:existing?.historyCompleteness || 'incomplete',
      moduleVersion:MODULE_VERSION
    };
    if (options.retainRaw === true) {
      const original = inputs.find(input => itemKey(sourceItem(input)) === itemKey(item));
      canonical.raw = original?.raw || original || existing?.raw || null;
      canonical.syncedAt = now;
    }
    const unchanged = existing && rowCodeKey(existing) === codeKey && rowGuidKey(existing) === canonical.canonicalItemGuid && clean(existing.itemDescription,500) === canonical.itemDescription && clean(existing.groupNumber,100) === canonical.groupNumber && canonicalItemGuid(existing.groupGuid) === canonical.groupGuid && clean(existing.canonicalIdentity,300) === identity && existing.persistentIdentity === true && existing.deletedByZeroStock === false && existing.moduleVersion === MODULE_VERSION && (existing.discoverySources || []).includes(source);
    if (!existing) summary.created++;
    else if (unchanged) summary.unchanged++;
    else summary.updated++;
    if (!unchanged) catalogOps.push({ updateOne:{ filter:existing ? { _id:existing._id } : { normalizedItemCode:codeKey }, update:{ $set:canonical, $setOnInsert:{ createdAt:now, firstDiscoveredAt:now } }, upsert:true } });

    // Newly discovered operational identities must not depend on a future Full
    // Catalog Sync or a human Kardex lookup to enter the inventory read model.
    // This queue is only a bounded exact-GetRemain trigger; it stores no stock.
    if (!existing && inventoryAutoSyncPolicy.isOperationalDiscoverySource(source)) {
      inventoryQueueOps.push({ updateOne:{
        filter:{ canonicalIdentity:identity },
        update:{
          $set:{ itemGuid:canonical.itemGuid, itemCode:item.itemCode, itemDescription:canonical.itemDescription, source, status:'pending', updatedAt:now },
          $setOnInsert:{ queueId:inventoryAutoSyncPolicy.discoveryQueueId(identity), attempts:0, createdAt:now }
        },
        upsert:true
      } });
    }

    if (options.queueHistory !== false && existing?.historyCompleteness !== 'complete') {
      const queue = queueByIdentity.get(identity);
      if (!queue) summary.queued++;
      const queueSources = [...new Set([...(Array.isArray(queue?.discoverySources) ? queue.discoverySources : []), source].filter(Boolean))];
      const queueUnchanged = queue && canonicalItemGuid(queue.itemGuid) === canonical.canonicalItemGuid && normalizedItemCode(queue.itemCode) === codeKey && clean(queue.itemDescription,500) === canonical.itemDescription && queueSources.length === (queue.discoverySources || []).length && queue.boundedRecoveryRequired === true && queue.canonicalPurchaseEngineOnly === true;
      if (!queueUnchanged) queueOps.push({ updateOne:{ filter:{ canonicalIdentity:identity }, update:{ $set:{ itemGuid:canonical.itemGuid, itemCode:item.itemCode, itemDescription:canonical.itemDescription, discoverySources:queueSources, lastDiscoveredAt:now, updatedAt:now, boundedRecoveryRequired:true, canonicalPurchaseEngineOnly:true }, $setOnInsert:{ queueId:queueId(identity), status:'pending', attempts:0, createdAt:now } }, upsert:true } });
    }
  }
  if (catalogOps.length) await db.collection(CATALOG).bulkWrite(catalogOps, { ordered:false });
  if (queueOps.length) await db.collection(HISTORY_QUEUE).bulkWrite(queueOps, { ordered:false });
  if (inventoryQueueOps.length) await db.collection(inventoryAutoSyncPolicy.INVENTORY_DISCOVERY_QUEUE).bulkWrite(inventoryQueueOps, { ordered:false });
  summary.ok = summary.conflicts.length === 0;
  return summary;
}

async function ensureCatalogItem(db, input = {}, options = {}) {
  const item = sourceItem(input);
  if (!item.itemCode || !identityOf(item)) return { ok:false, created:false, queued:false, code:'CATALOG_ITEM_IDENTITY_REQUIRED' };
  const result = await ensureCatalogItems(db, [input], options);
  if (result.conflicts.length) return { ok:false, created:false, queued:false, code:result.conflicts[0].code, conflict:result.conflicts[0] };
  const query = item.itemGuid ? { canonicalItemGuid:canonicalItemGuid(item.itemGuid) } : { normalizedItemCode:normalizedItemCode(item.itemCode) };
  const stored = await db.collection(CATALOG).findOne(query);
  return { ok:true, created:result.created === 1, queued:result.queued === 1, canonicalIdentity:clean(stored?.canonicalIdentity,300) || identityOf(item), itemCode:item.itemCode, historyCompleteness:stored?.historyCompleteness || 'incomplete' };
}

async function markHistoryComplete(db, input = {}, evidence = {}) {
  const item = sourceItem(input), derivedIdentity = identityOf(item);
  if (!derivedIdentity || !item.itemCode) throw Object.assign(new Error('Canonical item identity required'), { code:'CATALOG_ITEM_IDENTITY_REQUIRED' });
  const now = evidence.completedAt || new Date();
  const ensured = await ensureCatalogItem(db, item, { source:evidence.source || 'purchase-history-recovery', queueHistory:false, now });
  if (!ensured.ok) throw Object.assign(new Error('Canonical item identity conflict'), { code:ensured.code, conflict:ensured.conflict });
  const query = item.itemGuid ? { canonicalItemGuid:canonicalItemGuid(item.itemGuid) } : { normalizedItemCode:normalizedItemCode(item.itemCode) };
  const catalog = await db.collection(CATALOG).findOne(query);
  const identity = clean(catalog?.canonicalIdentity,300) || derivedIdentity;
  await db.collection(CATALOG).updateOne({ _id:catalog._id }, { $set:{ historyCompleteness:'complete', historyCompletedAt:now, historyEvidence:{ purchaseDatasetId:clean(evidence.purchaseDatasetId,100), sourceFingerprint:clean(evidence.sourceFingerprint,128), dateFrom:clean(evidence.dateFrom,8), dateTo:clean(evidence.dateTo,8), result:clean(evidence.result || 'reviewed',100) }, updatedAt:now } });
  await db.collection(HISTORY_QUEUE).updateOne({ canonicalIdentity:identity }, { $set:{ status:'complete', completedAt:now, updatedAt:now, completionEvidence:{ purchaseDatasetId:clean(evidence.purchaseDatasetId,100), sourceFingerprint:clean(evidence.sourceFingerprint,128), result:clean(evidence.result || 'reviewed',100) } } }, { upsert:true });
  return { ok:true, canonicalIdentity:identity, historyCompleteness:'complete' };
}

async function historyStatus(db, input = {}) {
  const item = sourceItem(input);
  const catalog = item.itemGuid
    ? await db.collection(CATALOG).findOne({ $or:[{ canonicalItemGuid:canonicalItemGuid(item.itemGuid) }, { itemGuid:item.itemGuid }, { canonicalIdentity:identityOf(item) }] })
    : (item.itemCode ? await db.collection(CATALOG).findOne({ $or:[{ normalizedItemCode:normalizedItemCode(item.itemCode) }, { itemCode:item.itemCode }, { canonicalIdentity:identityOf(item) }] }) : null);
  const identity = clean(catalog?.canonicalIdentity,300) || identityOf(item);
  const queue = identity ? await db.collection(HISTORY_QUEUE).findOne({ canonicalIdentity:identity }) : null;
  return { complete:catalog?.historyCompleteness === 'complete', state:catalog?.historyCompleteness || 'missing', catalog, queue };
}

module.exports = {
  CATALOG, HISTORY_QUEUE, MODULE_VERSION, HISTORY_STATES,
  ensureCatalogItem, ensureCatalogItems, markHistoryComplete, historyStatus,
  canonicalItemCode, normalizedItemCode, canonicalItemGuid,
  _identityOf:identityOf, _sourceItem:sourceItem, _resolveExisting:resolveExisting
};
