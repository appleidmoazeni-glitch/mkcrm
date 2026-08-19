'use strict';

const crypto = require('crypto');
const { ObjectId } = require('mongodb');
const catalog = require('./canonical-item-catalog');

const AUDIT_COLLECTION = 'itemCatalogReconciliationAudit';
const REFERENCE_FIELDS = Object.freeze(['itemCatalogId','catalogItemId','itemCatalogAllId','canonicalItemId']);

function clean(value, max = 500) { return String(value == null ? '' : value).normalize('NFKC').trim().slice(0, max); }
function dateValue(value) { const number = new Date(value || 0).getTime(); return Number.isFinite(number) ? number : 0; }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    if (value._bsontype && typeof value.toString === 'function') return JSON.stringify(value.toString());
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function documentId(row) { return String(row?._id || ''); }
function codeKey(row) { return catalog.normalizedItemCode(row?.itemCode); }
function guidKey(row) { return catalog.canonicalItemGuid(row?.itemGuid); }
function earliest(rows, fields) {
  const values = rows.flatMap(row => fields.map(field => row[field])).filter(Boolean).sort((a,b) => dateValue(a) - dateValue(b));
  return values[0] || null;
}
function latestRow(rows) {
  return [...rows].sort((a,b) => Math.max(dateValue(b.updatedAt),dateValue(b.syncedAt),dateValue(b.lastDiscoveredAt))-Math.max(dateValue(a.updatedAt),dateValue(a.syncedAt),dateValue(a.lastDiscoveredAt)) || documentId(a).localeCompare(documentId(b)))[0];
}
function survivorScore(row, normalizedCode) {
  let score = 0;
  if (String(row.itemCode == null ? '' : row.itemCode) === normalizedCode) score += 100;
  if (row.normalizedItemCode === normalizedCode) score += 20;
  if (row.canonicalIdentity) score += 10;
  if (Array.isArray(row.discoverySources) && row.discoverySources.length) score += 5;
  if (row.raw) score += 1;
  return score;
}
function chooseSurvivor(rows, normalizedCode) {
  return [...rows].sort((a,b) => survivorScore(b,normalizedCode)-survivorScore(a,normalizedCode) || dateValue(a.createdAt||a.firstDiscoveredAt)-dateValue(b.createdAt||b.firstDiscoveredAt) || documentId(a).localeCompare(documentId(b)))[0];
}
async function referencesFor(db, rows) {
  const ids = rows.map(row => row._id).filter(Boolean);
  const stringIds = ids.map(String);
  const byDocumentId = new Map(stringIds.map(id => [id,[]]));
  if (!ids.length) return byDocumentId;
  const values = [...ids, ...stringIds];
  const names = (await db.listCollections().toArray()).map(row => row.name).filter(name => ![catalog.CATALOG,AUDIT_COLLECTION].includes(name));
  for (const name of names) {
    const clauses = REFERENCE_FIELDS.map(field => ({ [field]:{ $in:values } }));
    const matches = await db.collection(name).find({ $or:clauses }).project(Object.fromEntries(REFERENCE_FIELDS.map(field=>[field,1]))).limit(10000).toArray().catch(() => []);
    for (const row of matches) {
      for (const field of REFERENCE_FIELDS) {
        const id=String(row[field]||'');
        if (!byDocumentId.has(id)) continue;
        const refs=byDocumentId.get(id),existing=refs.find(ref=>ref.collection===name&&ref.field===field);
        if(existing)existing.count++;else refs.push({collection:name,field,count:1});
      }
    }
  }
  return byDocumentId;
}
function groupRows(rows, keyFn) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

async function plan(db) {
  const rows = await db.collection(catalog.CATALOG).find({}).toArray();
  const byGuid = groupRows(rows, guidKey), byCode = groupRows(rows, codeKey);
  const duplicateGuidGroups = [...byGuid.entries()].filter(([,list]) => list.length > 1);
  const duplicateCodeGroups = [...byCode.entries()].filter(([,list]) => list.length > 1);
  const codeOnlyPlaceholderGroups = duplicateCodeGroups.filter(([,list]) => {
    const guids=[...new Set(list.map(guidKey).filter(Boolean))];
    const placeholders=list.filter(row=>!guidKey(row));
    return guids.length===1 && placeholders.length>0 && placeholders.every(row=>!clean(row.itemDescription,500)&&!clean(row.groupNumber,100)&&!guidKey({itemGuid:row.groupGuid}));
  });
  const referenceMap = await referencesFor(db,[...duplicateGuidGroups.flatMap(([,list])=>list),...codeOnlyPlaceholderGroups.flatMap(([,list])=>list)]);
  const groups = [];
  for (const [guid, list] of duplicateGuidGroups) {
    const normalizedCodes = [...new Set(list.map(codeKey).filter(Boolean))];
    const normalizedCode = normalizedCodes.length === 1 ? normalizedCodes[0] : '';
    const safe = Boolean(guid && normalizedCode && normalizedCodes.length === 1 && list.every(row => guidKey(row) === guid));
    const survivor = safe ? chooseSurvivor(list, normalizedCode) : null;
    groups.push({
      guid,
      rawItemCodes:list.map(row => String(row.itemCode == null ? '' : row.itemCode)),
      normalizedCodes,
      normalizedItemCode:normalizedCode,
      documentIds:list.map(documentId),
      timestamps:list.map(row => ({ documentId:documentId(row), createdAt:row.createdAt||null, firstDiscoveredAt:row.firstDiscoveredAt||null, updatedAt:row.updatedAt||null, syncedAt:row.syncedAt||null })),
      references:list.flatMap(row=>(referenceMap.get(documentId(row))||[]).map(reference=>({documentId:documentId(row),...reference}))),
      safeNormalizationDuplicate:safe,
      classification:safe ? 'SAFE_WHITESPACE_NORMALIZATION_DUPLICATE' : 'IDENTITY_CONFLICT',
      proposedSurvivorId:survivor ? documentId(survivor) : '',
      proposedDuplicateIds:survivor ? list.filter(row => documentId(row)!==documentId(survivor)).map(documentId) : [],
      proposedAliasHandling:safe ? 'preserve normalized raw aliases and merged discovery metadata in survivor plus immutable reconciliation audit' : 'manual investigation required; no mutation'
    });
  }
  const alreadyPlanned=new Set(groups.flatMap(group=>group.documentIds));
  for(const [normalizedCode,list] of codeOnlyPlaceholderGroups){
    if(list.some(row=>alreadyPlanned.has(documentId(row))))continue;
    const survivor=list.find(row=>guidKey(row));
    groups.push({
      guid:guidKey(survivor),
      rawItemCodes:list.map(row=>String(row.itemCode==null?'':row.itemCode)),
      normalizedCodes:[normalizedCode],normalizedItemCode:normalizedCode,
      documentIds:list.map(documentId),
      timestamps:list.map(row=>({documentId:documentId(row),createdAt:row.createdAt||null,firstDiscoveredAt:row.firstDiscoveredAt||null,updatedAt:row.updatedAt||null,syncedAt:row.syncedAt||null})),
      references:list.flatMap(row=>(referenceMap.get(documentId(row))||[]).map(reference=>({documentId:documentId(row),...reference}))),
      safeNormalizationDuplicate:true,classification:'SAFE_CODE_ONLY_PLACEHOLDER_DUPLICATE',
      proposedSurvivorId:documentId(survivor),proposedDuplicateIds:list.filter(row=>documentId(row)!==documentId(survivor)).map(documentId),
      proposedAliasHandling:'attach empty code-only discovery placeholder to the single official GUID survivor and retain immutable reconciliation audit'
    });
  }
  const codeConflicts = duplicateCodeGroups.filter(([,list]) => new Set(list.map(guidKey).filter(Boolean)).size > 1).map(([normalizedCode,list]) => ({
    normalizedItemCode:normalizedCode,
    guids:[...new Set(list.map(guidKey).filter(Boolean))],
    documentIds:list.map(documentId),
    classification:'IDENTITY_CONFLICT_DIFFERENT_GUID_SAME_CODE'
  }));
  const unsafeGroups = groups.filter(group => !group.safeNormalizationDuplicate);
  const result = {
    generatedAt:new Date(),
    collection:catalog.CATALOG,
    sourceCount:rows.length,
    duplicateGuidGroupCount:duplicateGuidGroups.length,
    duplicateGuidDocumentCount:duplicateGuidGroups.reduce((sum,[,list]) => sum + list.length,0),
    duplicateNormalizedCodeGroupCount:duplicateCodeGroups.length,
    unsafeGuidGroupCount:unsafeGroups.length,
    codeConflictCount:codeConflicts.length,
    safeGroupCount:groups.filter(group => group.safeNormalizationDuplicate).length,
    safeToApply:unsafeGroups.length === 0 && codeConflicts.length === 0,
    safeGroupsReconciliationAllowed:unsafeGroups.length === 0 && groups.some(group => group.safeNormalizationDuplicate),
    groups,
    codeConflicts
  };
  result.planFingerprint = sha(stable({ sourceCount:result.sourceCount, groups:groups.map(group => ({ guid:group.guid, normalizedItemCode:group.normalizedItemCode, documentIds:[...group.documentIds].sort(), proposedSurvivorId:group.proposedSurvivorId, safe:group.safeNormalizationDuplicate })), codeConflicts }));
  return result;
}

function mergedDocument(rows, survivor, normalizedCode, now) {
  const latest = latestRow(rows);
  const sources = [...new Set(rows.flatMap(row => Array.isArray(row.discoverySources) ? row.discoverySources : []).filter(Boolean))];
  const rawAliases = rows.map(row => ({ documentId:documentId(row), itemCode:String(row.itemCode == null ? '' : row.itemCode), itemGuid:String(row.itemGuid == null ? '' : row.itemGuid), sourceHash:sha(stable(row.raw || { itemCode:row.itemCode, itemGuid:row.itemGuid, itemDescription:row.itemDescription })) }));
  return {
    itemCode:catalog.canonicalItemCode(normalizedCode),
    normalizedItemCode:normalizedCode,
    itemGuid:catalog.canonicalItemGuid(survivor.itemGuid),
    canonicalItemGuid:catalog.canonicalItemGuid(survivor.itemGuid),
    itemDescription:clean(latest.itemDescription || survivor.itemDescription,500),
    groupNumber:clean(latest.groupNumber || survivor.groupNumber,100),
    groupGuid:catalog.canonicalItemGuid(latest.groupGuid || survivor.groupGuid),
    canonicalIdentity:clean(survivor.canonicalIdentity,300) || catalog._identityOf(survivor),
    searchText:`${normalizedCode} ${clean(latest.itemDescription || survivor.itemDescription,500)}`.trim().toLocaleLowerCase('fa'),
    discoverySources:sources,
    firstDiscoveredAt:earliest(rows,['firstDiscoveredAt','createdAt']) || survivor.firstDiscoveredAt || survivor.createdAt || now,
    lastDiscoveredAt:latest.lastDiscoveredAt || latest.syncedAt || latest.updatedAt || now,
    syncedAt:latest.syncedAt || survivor.syncedAt || null,
    raw:latest.raw || survivor.raw || null,
    rawIdentityAliases:rawAliases,
    persistentIdentity:true,
    deletedByZeroStock:false,
    historyCompleteness:rows.some(row => row.historyCompleteness === 'complete') ? 'complete' : (survivor.historyCompleteness || 'incomplete'),
    moduleVersion:catalog.MODULE_VERSION,
    reconciliation:{ classification:'SAFE_WHITESPACE_NORMALIZATION_DUPLICATE', reconciledAt:now, mergedDocumentIds:rows.filter(row => documentId(row)!==documentId(survivor)).map(documentId) },
    updatedAt:now
  };
}

async function apply(db, options = {}) {
  const expectedFingerprint = clean(options.planFingerprint,128), backupEvidence = clean(options.backupEvidence,1000);
  if (!expectedFingerprint) throw Object.assign(new Error('planFingerprint is required'), { code:'CATALOG_RECONCILIATION_PLAN_REQUIRED' });
  if (!backupEvidence) throw Object.assign(new Error('fresh backup evidence is required'), { code:'CATALOG_RECONCILIATION_BACKUP_REQUIRED' });
  const current = await plan(db);
  if (current.planFingerprint !== expectedFingerprint) throw Object.assign(new Error('catalog changed after reconciliation plan'), { code:'CATALOG_RECONCILIATION_PLAN_STALE', currentFingerprint:current.planFingerprint });
  if (current.unsafeGuidGroupCount) throw Object.assign(new Error('unsafe duplicate-GUID group requires human review'), { code:'CATALOG_RECONCILIATION_UNSAFE_GUID_GROUP', unsafeGuidGroupCount:current.unsafeGuidGroupCount, codeConflictCount:current.codeConflictCount });
  if (!current.safeGroupCount) throw Object.assign(new Error('no safe duplicate groups require reconciliation'), { code:'CATALOG_RECONCILIATION_NOT_REQUIRED', codeConflictCount:current.codeConflictCount });
  await db.collection(AUDIT_COLLECTION).createIndex({ reconciliationId:1 }, { unique:true });
  await db.collection(AUDIT_COLLECTION).createIndex({ planFingerprint:1, status:1 });
  const reconciliationId = `ICR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const startedAt = new Date();
  await db.collection(AUDIT_COLLECTION).insertOne({ reconciliationId, planFingerprint:current.planFingerprint, backupEvidence, status:'running', sourceCount:current.sourceCount, groupCount:current.groups.length, groups:current.groups, createdAt:startedAt, immutableSourcePlan:true });
  let reconciledGroups = 0, removedDocuments = 0;
  try {
    for (const group of current.groups) {
      if (!group.safeNormalizationDuplicate) continue;
      const idCandidates = group.documentIds.flatMap(id => ObjectId.isValid(id) ? [id,new ObjectId(id)] : [id]);
      const rows = await db.collection(catalog.CATALOG).find({ _id:{ $in:idCandidates } }).toArray();
      // The fallback is read-only and filtered again below; it supports non-ObjectId test stores and legacy GUID formatting.
      const actualRows = rows.length === group.documentIds.length ? rows : await db.collection(catalog.CATALOG).find({}).toArray();
      const scopedRows = actualRows.filter(row => codeKey(row) === group.normalizedItemCode && (group.classification==='SAFE_CODE_ONLY_PLACEHOLDER_DUPLICATE' ? (!guidKey(row)||guidKey(row)===group.guid) : guidKey(row)===group.guid));
      if (scopedRows.length !== group.documentIds.length) throw Object.assign(new Error(`group changed for ${group.guid}`), { code:'CATALOG_RECONCILIATION_GROUP_STALE' });
      const survivor = scopedRows.find(row => documentId(row) === group.proposedSurvivorId);
      if (!survivor) throw Object.assign(new Error(`survivor missing for ${group.guid}`), { code:'CATALOG_RECONCILIATION_SURVIVOR_MISSING' });
      const duplicateIds = scopedRows.filter(row => documentId(row) !== group.proposedSurvivorId).map(row => row._id);
      const merged = mergedDocument(scopedRows,survivor,group.normalizedItemCode,new Date());
      await db.collection(AUDIT_COLLECTION).updateOne({ reconciliationId }, { $push:{ groupResults:{ guid:group.guid, normalizedItemCode:group.normalizedItemCode, survivorId:group.proposedSurvivorId, removedIds:duplicateIds.map(String), sourceDocuments:scopedRows, sourceDocumentsHash:sha(stable(scopedRows)), recordedAt:new Date() } } });
      await db.collection(catalog.CATALOG).updateOne({ _id:survivor._id }, { $set:merged });
      const removed = await db.collection(catalog.CATALOG).deleteMany({ _id:{ $in:duplicateIds } });
      if (Number(removed.deletedCount || 0) !== duplicateIds.length) throw Object.assign(new Error(`duplicate delete mismatch for ${group.guid}`), { code:'CATALOG_RECONCILIATION_DELETE_MISMATCH' });
      reconciledGroups++;
      removedDocuments += duplicateIds.length;
    }
    const after = await plan(db), completedAt = new Date();
    if (after.duplicateGuidGroupCount || after.unsafeGuidGroupCount) throw Object.assign(new Error('post-reconciliation safe-duplicate gate failed'), { code:'CATALOG_RECONCILIATION_POST_GATE_FAILED', after });
    const status=after.codeConflictCount ? 'completed_with_identity_conflicts' : 'completed';
    await db.collection(AUDIT_COLLECTION).updateOne({ reconciliationId }, { $set:{ status, completedAt, reconciledGroups, removedDocuments, unresolvedIdentityConflicts:after.codeConflicts, after:{ sourceCount:after.sourceCount, duplicateGuidGroupCount:after.duplicateGuidGroupCount, duplicateNormalizedCodeGroupCount:after.duplicateNormalizedCodeGroupCount, codeConflictCount:after.codeConflictCount, planFingerprint:after.planFingerprint } } });
    return { ok:true, releaseGatePass:after.codeConflictCount === 0, status, reconciliationId, reconciledGroups, removedDocuments, before:current.sourceCount, after:after.sourceCount, postGate:after };
  } catch (error) {
    await db.collection(AUDIT_COLLECTION).updateOne({ reconciliationId }, { $set:{ status:'failed', failedAt:new Date(), errorCode:clean(error.code||'CATALOG_RECONCILIATION_FAILED',100), error:clean(error.message,1000), reconciledGroups, removedDocuments } }).catch(() => {});
    throw error;
  }
}

module.exports = { AUDIT_COLLECTION, REFERENCE_FIELDS, plan, apply, _stable:stable, _chooseSurvivor:chooseSurvivor, _mergedDocument:mergedDocument };
