'use strict';

const crypto = require('crypto');
const catalog = require('./canonical-item-catalog');

const AUDIT_COLLECTION = 'itemCatalogMasterRenameAudit';
const CONTRACT_VERSION = 'guid-stable-source-rename-1.0.0';

function clean(value, max = 500) { return String(value == null ? '' : value).normalize('NFKC').trim().slice(0, max); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    if (value._bsontype && typeof value.toString === 'function') return JSON.stringify(value.toString());
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function normalizeSource(inputs = []) {
  return inputs.map(input => {
    const item = catalog._sourceItem(input);
    return { ...item, normalizedItemCode:catalog.normalizedItemCode(item.itemCode), canonicalItemGuid:catalog.canonicalItemGuid(item.itemGuid), raw:input?.raw || input };
  }).filter(item => item.itemCode && item.canonicalItemGuid);
}
function groups(rows, key) {
  const result = new Map();
  for (const row of rows) {
    const value = row[key];
    if (!value) continue;
    if (!result.has(value)) result.set(value, []);
    result.get(value).push(row);
  }
  return result;
}
function sourceDiagnostics(rows) {
  const byGuid = groups(rows, 'canonicalItemGuid'), byCode = groups(rows, 'normalizedItemCode');
  const duplicateGuids = [...byGuid.entries()].filter(([,values]) => values.length > 1).map(([guid,values]) => ({ guid, occurrences:values.length, codes:[...new Set(values.map(row => row.normalizedItemCode))] }));
  const duplicateCodes = [...byCode.entries()].filter(([,values]) => values.length > 1).map(([code,values]) => ({ normalizedItemCode:code, occurrences:values.length, guids:[...new Set(values.map(row => row.canonicalItemGuid))] }));
  const normalized = rows.map(row => ({ guid:row.canonicalItemGuid, code:row.normalizedItemCode })).sort((a,b) => a.guid.localeCompare(b.guid) || a.code.localeCompare(b.code));
  return { sourceCount:rows.length, duplicateGuidCount:duplicateGuids.length, duplicateNormalizedCodeCount:duplicateCodes.length, duplicateGuids, duplicateCodes, sourceFingerprint:sha(stable(normalized)) };
}

async function plan(db, authoritativeRows = [], options = {}) {
  if (clean(options.source) !== 'shaygan-item-master-full') throw Object.assign(new Error('authoritative Shaygan full-master source is required'), { code:'AUTHORITATIVE_ITEM_MASTER_SOURCE_REQUIRED' });
  if (options.complete !== true) throw Object.assign(new Error('complete authoritative source evidence is required'), { code:'AUTHORITATIVE_ITEM_MASTER_INCOMPLETE' });
  const sourceRows = normalizeSource(authoritativeRows), diagnostics = sourceDiagnostics(sourceRows);
  if (!diagnostics.sourceCount) throw Object.assign(new Error('authoritative source is empty'), { code:'AUTHORITATIVE_ITEM_MASTER_EMPTY' });
  if (diagnostics.duplicateGuidCount || diagnostics.duplicateNormalizedCodeCount) throw Object.assign(new Error('authoritative source identity conflict'), { code:'AUTHORITATIVE_ITEM_MASTER_IDENTITY_CONFLICT', diagnostics });
  const catalogRows = await db.collection(catalog.CATALOG).find({}).toArray();
  const decorated = catalogRows.map(row => ({ ...row, canonicalItemGuid:catalog.canonicalItemGuid(row.canonicalItemGuid || row.itemGuid), normalizedItemCode:catalog.normalizedItemCode(row.normalizedItemCode || row.itemCode) }));
  const byGuid = groups(decorated, 'canonicalItemGuid'), byCode = groups(decorated, 'normalizedItemCode');
  const sourceByGuid = new Map(sourceRows.map(row => [row.canonicalItemGuid,row])), sourceByCode = new Map(sourceRows.map(row => [row.normalizedItemCode,row]));
  const renames = [], conflicts = [];
  for (const [guid,incoming] of sourceByGuid) {
    const current = byGuid.get(guid) || [];
    if (current.length > 1) { conflicts.push({ code:'CATALOG_IDENTITY_CONFLICT', guid, reason:'GUID_NOT_UNIQUE_IN_CATALOG', documentIds:current.map(row=>String(row._id||'')) }); continue; }
    if (!current.length || current[0].normalizedItemCode === incoming.normalizedItemCode) continue;
    const row = current[0], currentCodeOwners = (byCode.get(incoming.normalizedItemCode) || []).filter(owner => owner.canonicalItemGuid !== guid);
    if (currentCodeOwners.length) { conflicts.push({ code:'CATALOG_IDENTITY_CONFLICT', guid, oldCode:row.itemCode, newCode:incoming.itemCode, reason:'NEW_CODE_OWNED_BY_OTHER_CATALOG_GUID', ownerGuids:currentCodeOwners.map(owner=>owner.canonicalItemGuid) }); continue; }
    if (sourceByCode.get(incoming.normalizedItemCode)?.canonicalItemGuid !== guid) { conflicts.push({ code:'CATALOG_IDENTITY_CONFLICT', guid, reason:'NEW_CODE_NOT_OWNED_BY_GUID_IN_SOURCE' }); continue; }
    renames.push({ documentId:String(row._id || ''), guid, oldCode:catalog.canonicalItemCode(row.itemCode), oldNormalizedItemCode:row.normalizedItemCode, newCode:incoming.itemCode, newNormalizedItemCode:incoming.normalizedItemCode, canonicalIdentity:clean(row.canonicalIdentity,300) || catalog._identityOf(row), incoming:{ itemDescription:incoming.itemDescription, groupNumber:incoming.groupNumber, groupGuid:incoming.groupGuid, raw:incoming.raw } });
  }
  const catalogState = decorated.map(row => ({ id:String(row._id||''), guid:row.canonicalItemGuid, code:row.normalizedItemCode, canonicalIdentity:clean(row.canonicalIdentity,300) })).sort((a,b)=>a.id.localeCompare(b.id));
  const result={ contractVersion:CONTRACT_VERSION, generatedAt:new Date(), source:options.source, complete:true, ...diagnostics, catalogCount:catalogRows.length, plannedRenames:renames.length, conflicts, renames };
  result.planFingerprint=sha(stable({ contractVersion:CONTRACT_VERSION, sourceFingerprint:diagnostics.sourceFingerprint, catalogState, renames, conflicts }));
  result.safeToApply=conflicts.length===0;
  return result;
}

async function apply(db, authoritativeRows = [], options = {}) {
  const expected=clean(options.planFingerprint,128), backupEvidence=clean(options.backupEvidence,1000);
  if (!expected) throw Object.assign(new Error('planFingerprint is required'), { code:'CATALOG_MASTER_RENAME_PLAN_REQUIRED' });
  if (!backupEvidence) throw Object.assign(new Error('fresh backup evidence is required'), { code:'CATALOG_MASTER_RENAME_BACKUP_REQUIRED' });
  const current=await plan(db,authoritativeRows,options);
  if (current.planFingerprint!==expected) throw Object.assign(new Error('catalog or authoritative source changed after plan'), { code:'CATALOG_MASTER_RENAME_PLAN_STALE', currentFingerprint:current.planFingerprint, sourceFingerprint:current.sourceFingerprint });
  if (!current.safeToApply) throw Object.assign(new Error('catalog master rename conflict'), { code:'CATALOG_IDENTITY_CONFLICT', conflicts:current.conflicts });
  await db.collection(AUDIT_COLLECTION).createIndex({ reconciliationId:1 },{ unique:true });
  await db.collection(AUDIT_COLLECTION).createIndex({ sourceFingerprint:1, status:1 });
  const reconciliationId=`ICMR-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`, startedAt=new Date();
  await db.collection(AUDIT_COLLECTION).insertOne({ reconciliationId, contractVersion:CONTRACT_VERSION, status:'running', planFingerprint:current.planFingerprint, sourceFingerprint:current.sourceFingerprint, sourceCount:current.sourceCount, plannedRenames:current.plannedRenames, backupEvidence, immutableSourcePlan:true, renames:current.renames, createdAt:startedAt });
  const results=[];
  try {
    for (const rename of current.renames) {
      const before=await db.collection(catalog.CATALOG).findOne({ canonicalItemGuid:rename.guid });
      if (!before || catalog.normalizedItemCode(before.itemCode)!==rename.oldNormalizedItemCode) throw Object.assign(new Error(`catalog row changed for ${rename.guid}`),{ code:'CATALOG_MASTER_RENAME_ROW_STALE' });
      const changedAt=new Date(), history={ itemCode:rename.oldCode, normalizedItemCode:rename.oldNormalizedItemCode, replacedBy:rename.newCode, changedAt, source:'shaygan-item-master-full', sourceFingerprint:current.sourceFingerprint, activeAlias:false };
      const canonicalIdentity=clean(before.canonicalIdentity,300)||catalog._identityOf(before);
      const update={ itemCode:rename.newCode, normalizedItemCode:rename.newNormalizedItemCode, itemDescription:rename.incoming.itemDescription||before.itemDescription||'', groupNumber:rename.incoming.groupNumber||before.groupNumber||'', groupGuid:rename.incoming.groupGuid||before.groupGuid||'', canonicalIdentity, searchText:`${rename.newCode} ${rename.incoming.itemDescription||before.itemDescription||''}`.trim().toLocaleLowerCase('fa'), raw:rename.incoming.raw, syncedAt:changedAt, lastDiscoveredAt:changedAt, updatedAt:changedAt, moduleVersion:catalog.MODULE_VERSION, lastMasterRename:{ reconciliationId, oldCode:rename.oldCode, newCode:rename.newCode, changedAt, sourceFingerprint:current.sourceFingerprint } };
      const write=await db.collection(catalog.CATALOG).updateOne({ _id:before._id, canonicalItemGuid:rename.guid, normalizedItemCode:rename.oldNormalizedItemCode },{ $set:update,$push:{ codeHistory:history } });
      if (Number(write.matchedCount||0)!==1) throw Object.assign(new Error(`rename write mismatch for ${rename.guid}`),{ code:'CATALOG_MASTER_RENAME_WRITE_MISMATCH' });
      await db.collection('purchaseHistoryDiscoveryQueue').updateOne({ canonicalIdentity },{ $set:{ itemGuid:rename.guid,itemCode:rename.newCode,itemDescription:update.itemDescription,updatedAt:changedAt } });
      results.push({ guid:rename.guid, oldCode:rename.oldCode, newCode:rename.newCode, documentId:String(before._id), canonicalIdentityBefore:clean(before.canonicalIdentity,300), canonicalIdentityAfter:canonicalIdentity, result:'renamed', auditHistory:history });
      await db.collection(AUDIT_COLLECTION).updateOne({ reconciliationId },{ $push:{ results:results.at(-1) } });
    }
    const postPlan=await plan(db,authoritativeRows,options), completedAt=new Date();
    if (postPlan.conflicts.length || postPlan.plannedRenames) throw Object.assign(new Error('post-rename gate failed'),{ code:'CATALOG_MASTER_RENAME_POST_GATE_FAILED',postPlan });
    await db.collection(AUDIT_COLLECTION).updateOne({ reconciliationId },{ $set:{ status:'completed',completedAt,renamed:results.length,postPlanFingerprint:postPlan.planFingerprint,postSourceFingerprint:postPlan.sourceFingerprint } });
    return { ok:true,reconciliationId,renamed:results.length,results,sourceFingerprint:current.sourceFingerprint,postPlan };
  } catch(error) {
    await db.collection(AUDIT_COLLECTION).updateOne({ reconciliationId },{ $set:{ status:'failed',failedAt:new Date(),errorCode:clean(error.code||'CATALOG_MASTER_RENAME_FAILED',100),error:clean(error.message,1000),completedRenames:results.length } }).catch(()=>{});
    throw error;
  }
}

module.exports={ AUDIT_COLLECTION,CONTRACT_VERSION,sourceDiagnostics,plan,apply,_stable:stable,_normalizeSource:normalizeSource };
