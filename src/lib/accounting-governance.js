'use strict';

/*
 * Phase 5.3.1 — accounting governance boundary.
 *
 * This module owns evidence catalogues and human approval workflow only. It
 * reads official Shaygan ItemGroup/GetList, Item/Get and immutable accounting facts; it never
 * writes inventory, snapshots, purchase layers, FIFO datasets or invoices.
 */
const crypto = require('crypto');
const ledger = require('./profit-commission-ledger');
const { canonicalSaleDate } = require('./jalali-date');

const GROUP_CATALOG = 'accountingOfficialItemGroups';
const ITEM_GROUP_ASSIGNMENTS = 'accountingOfficialItemGroupAssignments';
const GROUP_CATALOG_RUNS = 'accountingOfficialGroupCatalogRuns';
const OPENING_BALANCES = 'savedProfitOpeningBalances';
const OPENING_LOCKS = 'savedProfitOpeningBalanceLocks';
const EXPORT_OVERRIDES = 'accountingExportDiagnosticOverrides';
const COLLECTIONS = Object.freeze([GROUP_CATALOG, ITEM_GROUP_ASSIGNMENTS, GROUP_CATALOG_RUNS, OPENING_BALANCES, OPENING_LOCKS, EXPORT_OVERRIDES]);
const EDIT_ROLES = Object.freeze(['admin', 'accounting']);
const APPROVE_ROLES = Object.freeze(['admin', 'manager']);
const READ_ROLES = Object.freeze(['admin', 'accounting', 'manager']);
const POOLS = Object.freeze(['NOTEBOOK', 'COMPONENT']);
let lastCatalogFetchMs = 0;

function clean(value, max = 1000) { return String(value == null ? '' : value).trim().slice(0, max); }
function actor(value = {}) { return { username:clean(value.username || value.user || 'system', 100), role:clean(value.role || 'system', 50) }; }
function fail(code, message, statusCode = 400, details = {}) { const error = new Error(message); Object.assign(error, { code, statusCode, ...details }); throw error; }
function requireRole(value, roles) { const current=actor(value); if(!roles.includes(current.role)) fail('ACCOUNTING_GOVERNANCE_FORBIDDEN','دسترسی به حاکمیت حسابداری مجاز نیست.',403); return current; }
function newId(prefix) { return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`; }
function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function date8(value, field, optional=false) { if(optional&&!clean(value))return ''; return canonicalSaleDate(value,{field}); }
function audit(action, by, details={}) { return { action:clean(action,100), by:actor(by), at:new Date(), details:JSON.parse(JSON.stringify(details)) }; }
function exact(value, scale=2) { return ledger._exact(value,scale); }
function add(values, scale=2) { return ledger._add(values,scale); }
function pct(numerator, denominator) { const n=Number(numerator||0), d=Number(denominator||0); return d>0?Number((n*100/d).toFixed(4)):0; }
function pageRows(rows, filters={}) { const page=Math.max(1,Number(filters.page||1)); const pageSize=Math.max(1,Math.min(Number(filters.pageSize||100),500)); return {page,pageSize,total:rows.length,list:rows.slice((page-1)*pageSize,page*pageSize)}; }
async function count(collection, query={}) { return typeof collection.countDocuments==='function'?Number(await collection.countDocuments(query)):(await collection.find(query).toArray()).length; }
async function bulkUpsert(collection,rows,key){if(!rows.length)return;if(typeof collection.bulkWrite==='function'){await collection.bulkWrite(rows.map(row=>({updateOne:{filter:{[key]:row[key]},update:{$set:row},upsert:true}})),{ordered:false});return;}for(const row of rows)await collection.updateOne({[key]:row[key]},{$set:row},{upsert:true});}

async function ensureIndexes(db) {
  const existing=new Set((await db.listCollections().toArray()).map(row=>row.name));
  for(const name of COLLECTIONS)if(!existing.has(name))await db.createCollection(name).catch(()=>{});
  await db.collection(GROUP_CATALOG).createIndex({groupIdentity:1},{unique:true});
  await db.collection(GROUP_CATALOG).createIndex({sourceGroupGuid:1},{unique:true,partialFilterExpression:{sourceGroupGuid:{$gt:''}}});
  await db.collection(GROUP_CATALOG).createIndex({groupNumber:1,parentGroupGuid:1});
  await db.collection(ITEM_GROUP_ASSIGNMENTS).createIndex({itemIdentity:1},{unique:true});
  await db.collection(ITEM_GROUP_ASSIGNMENTS).createIndex({itemGuid:1});
  await db.collection(ITEM_GROUP_ASSIGNMENTS).createIndex({itemCode:1});
  await db.collection(ITEM_GROUP_ASSIGNMENTS).createIndex({resolvedMainGroupGuid:1,resolutionStatus:1});
  await db.collection(GROUP_CATALOG_RUNS).createIndex({catalogRunId:1},{unique:true});
  await db.collection(OPENING_BALANCES).createIndex({openingBalanceId:1},{unique:true});
  await db.collection(OPENING_BALANCES).createIndex({pool:1,accountingPeriod:1,status:1});
  await db.collection(OPENING_BALANCES).createIndex({pool:1,accountingPeriod:1,entryKind:1,approvedSlot:1},{unique:true,sparse:true});
  await db.collection(OPENING_LOCKS).createIndex({lockKey:1},{unique:true});
  await db.collection(EXPORT_OVERRIDES).createIndex({overrideId:1},{unique:true});
  return {ok:true,collections:COLLECTIONS};
}

function first(row, keys) { for(const key of keys)if(clean(row?.[key]))return clean(row[key],500); return ''; }
function bool(value) { return value===true||value===1||/^(true|1|yes)$/i.test(clean(value)); }
function groupIdentity(row={}) {
  const sourceGroupGuid=first(row,['GroupGuid','GroupGuId','sourceGroupGuid','groupGuid']);
  const groupNumber=first(row,['GroupNumber','groupNumber']);
  const parentGroupGuid=first(row,['ParentGroupGuId','ParentGroupGuid','parentGroupGuid']);
  const parentGroupNumber=first(row,['ParentGroupNumber','parentGroupNumber']);
  const parentGroupName=first(row,['ParentGroupName','parentGroupName']);
  const groupName=first(row,['GroupName','groupName']);
  if(sourceGroupGuid)return `guid:${sourceGroupGuid}`;
  if(parentGroupGuid&&groupNumber)return `parent-guid:${parentGroupGuid}|number:${groupNumber}`;
  if(parentGroupNumber&&groupNumber)return `parent-number:${parentGroupNumber}|parent-name:${parentGroupName||'UNKNOWN'}|number:${groupNumber}`;
  return groupNumber?`number:${groupNumber}|name:${groupName||'UNKNOWN'}|parent:UNRESOLVED`:'';
}
function normalizeOfficialGroup(row={}) {
  const sourceGroupGuid=first(row,['GroupGuid','GroupGuId','sourceGroupGuid','groupGuid']);
  const normalized={
    sourceGroupGuid,
    groupNumber:first(row,['GroupNumber','groupNumber']),
    groupName:first(row,['GroupName','groupName']),
    isMainGroup:bool(row.IsMainGroup??row.isMainGroup),
    parentGroupGuid:first(row,['ParentGroupGuId','ParentGroupGuid','parentGroupGuid']),
    parentGroupNumber:first(row,['ParentGroupNumber','parentGroupNumber']),
    parentGroupName:first(row,['ParentGroupName','parentGroupName']),
    sourceVersion:first(row,['SourceVersion','sourceVersion'])
  };
  normalized.groupIdentity=groupIdentity(normalized);
  return normalized;
}
function resolveGroupHierarchy(sourceRows=[], metadata={}) {
  const unique=new Map();const duplicateGuidIdentities=[];const missingIdentity=[];
  for(const raw of sourceRows){const row=normalizeOfficialGroup(raw);if(!row.groupIdentity){missingIdentity.push(row);continue;}if(row.sourceGroupGuid&&unique.has(row.groupIdentity)){duplicateGuidIdentities.push(row.sourceGroupGuid);continue;}unique.set(row.groupIdentity,row);}
  const rows=[...unique.values()];const byGuid=new Map(rows.filter(r=>r.sourceGroupGuid).map(r=>[r.sourceGroupGuid.toLowerCase(),r]));const byNumber=new Map();
  for(const row of rows){if(!row.groupNumber)continue;const key=row.groupNumber;if(!byNumber.has(key))byNumber.set(key,[]);byNumber.get(key).push(row);}
  const ambiguousNumbers=[...byNumber.entries()].filter(([,list])=>list.length>1).map(([number,list])=>({groupNumber:number,groupIdentities:list.map(x=>x.groupIdentity)}));
  function parentFor(row){if(row.parentGroupGuid)return byGuid.get(row.parentGroupGuid.toLowerCase())||null;if(!row.parentGroupNumber)return null;const candidates=byNumber.get(row.parentGroupNumber)||[];if(candidates.length===1)return candidates[0];const named=candidates.filter(x=>row.parentGroupName&&x.groupName===row.parentGroupName);return named.length===1?named[0]:null;}
  const resolved=[];let cycleCount=0,orphanParentCount=0,ambiguousParentCount=0;
  for(const row of rows){const seen=new Set();const path=[];let cursor=row,main=null,status='valid-child';
    while(cursor){if(seen.has(cursor.groupIdentity)){status='cycle';cycleCount++;break;}seen.add(cursor.groupIdentity);path.unshift({groupIdentity:cursor.groupIdentity,groupGuid:cursor.sourceGroupGuid,groupNumber:cursor.groupNumber,groupName:cursor.groupName,isMainGroup:cursor.isMainGroup});if(cursor.isMainGroup){main=cursor;status=cursor===row?'valid-main':'valid-child';break;}const parent=parentFor(cursor);if(!parent){const candidates=cursor.parentGroupNumber?(byNumber.get(cursor.parentGroupNumber)||[]):[];if(candidates.length>1){status='ambiguous-parent-number';ambiguousParentCount++;}else{status='orphan-parent';orphanParentCount++;}break;}cursor=parent;}
    resolved.push({...row,resolvedMainGroupGuid:main?.sourceGroupGuid||'',resolvedMainGroupNumber:main?.groupNumber||'',resolvedMainGroupName:main?.groupName||'',resolvedMainGroupIdentity:main?.groupIdentity||'',hierarchyDepth:Math.max(0,path.length-1),hierarchyPath:path,sourceVersion:row.sourceVersion||clean(metadata.sourceVersion),fetchedAt:metadata.fetchedAt||new Date(),sourceEndpoint:'ItemGroup/GetList',validationStatus:status,hierarchyStatus:main?'resolved':status,active:true});
  }
  return{rows:resolved,diagnostics:{sourceRowCount:sourceRows.length,groupCount:resolved.length,mainGroupCount:resolved.filter(r=>r.isMainGroup).length,childGroupCount:resolved.filter(r=>!r.isMainGroup).length,parentResolvedCount:resolved.filter(r=>r.resolvedMainGroupIdentity).length,orphanParentCount,ambiguousParentCount,cycleCount,duplicateGuidCount:duplicateGuidIdentities.length,duplicateGuidIdentities:[...new Set(duplicateGuidIdentities)],ambiguousNumbers,missingIdentityCount:missingIdentity.length}};
}
function normalizeOfficialItem(row={}) {
  const itemGuid=first(row,['ItemGuId','ItemGuid','GuId','itemGuid']);
  const itemCode=first(row,['ItemCode','ProductCode','itemCode']);
  const groupGuid=first(row,['ItemGroupGuId','ItemGroupGuid','ProductGroupGuId','groupGuid']);
  const groupNumber=first(row,['ItemGroupNumber','ProductGroupNumber','groupNumber']);
  const groupName=first(row,['ItemGroupName','ProductGroupName','groupName']);
  const itemIdentity=itemGuid?`guid:${itemGuid}`:`code:${itemCode}`;
  return {itemIdentity,itemGuid,itemCode,itemDescription:first(row,['ItemDesc','ProductDesc','ItemDescription','itemDescription']),groupGuid,groupNumber,groupName,sourceEndpoint:'Item/Get'};
}

function resolveItemGroup(item, hierarchy) {
  const byGuid=new Map(hierarchy.rows.filter(r=>r.sourceGroupGuid).map(r=>[r.sourceGroupGuid.toLowerCase(),r]));const byNumber=new Map();for(const row of hierarchy.rows){if(!row.groupNumber)continue;if(!byNumber.has(row.groupNumber))byNumber.set(row.groupNumber,[]);byNumber.get(row.groupNumber).push(row);}
  let group=null,resolutionStatus='missing-group-identity';
  if(item.groupGuid){group=byGuid.get(item.groupGuid.toLowerCase())||null;resolutionStatus=group?'guid-resolved':'orphan';}
  else if(item.groupNumber){const candidates=byNumber.get(item.groupNumber)||[];if(candidates.length===1){group=candidates[0];resolutionStatus='number-resolved-with-parent-evidence';}else resolutionStatus=candidates.length>1?'ambiguous':'orphan';}
  const valid=Boolean(group?.resolvedMainGroupIdentity&&['valid-main','valid-child'].includes(group.validationStatus));
  if(group&&!valid&&resolutionStatus.endsWith('resolved'))resolutionStatus=group.validationStatus==='cycle'?'cycle':group.validationStatus.startsWith('ambiguous')?'ambiguous':'orphan';
  return{...item,groupIdentity:group?.groupIdentity||'',groupGuid:group?.sourceGroupGuid||item.groupGuid||'',groupNumber:group?.groupNumber||item.groupNumber||'',groupName:group?.groupName||item.groupName||'',parentGroupGuid:group?.parentGroupGuid||'',parentGroupNumber:group?.parentGroupNumber||'',parentGroupName:group?.parentGroupName||'',resolvedMainGroupGuid:group?.resolvedMainGroupGuid||'',resolvedMainGroupNumber:group?.resolvedMainGroupNumber||'',resolvedMainGroupName:group?.resolvedMainGroupName||'',resolvedMainGroupIdentity:group?.resolvedMainGroupIdentity||'',hierarchyDepth:group?.hierarchyDepth??null,hierarchyPath:group?.hierarchyPath||[],validationStatus:group?.validationStatus||resolutionStatus,resolutionStatus,isOfficialEvidence:valid,prefixFallbackOnly:!valid&&Boolean(item.itemCode),sourceEndpoint:'Item/Get + ItemGroup/GetList'};
}

async function refreshOfficialGroupCatalog(db, shaygan, input={}, requestedBy={}) {
  const current=requireRole(requestedBy,EDIT_ROLES); await ensureIndexes(db);
  const pageSize=Math.max(1,Math.min(Number(input.pageSize||100),100));
  const maxPages=Math.max(1,Math.min(Number(input.maxPages||1000),2000));
  const maxGroupPages=Math.max(1,Math.min(Number(input.maxGroupPages||100),500));
  const catalogRunId=newId('IGCAT');
  const fetchMs=Math.max(Date.now(),lastCatalogFetchMs+1);lastCatalogFetchMs=fetchMs;
  const fetchedAt=new Date(fetchMs); let pagesRead=0,totalRows=0,totalRecords=null,groupPagesRead=0,groupTotalRows=0,groupTotalRecords=null,groupSourceVersion='';
  if(typeof shaygan.getItemGroupsPage!=='function')fail('OFFICIAL_ITEM_GROUP_CONTRACT_MISSING','Wrapper رسمی ItemGroup/GetList در دسترس نیست.',500);
  const sourceGroups=[];
  for(let page=0;page<maxGroupPages;page++){
    const response=await shaygan.getItemGroupsPage(page*pageSize,pageSize);
    if(!response?.ok)fail('OFFICIAL_ITEM_GROUP_READ_FAILED','خواندن read-only سلسله‌مراتب از ItemGroup/GetList ناموفق بود.',502,{details:{endpoint:'ItemGroup/GetList',page,status:response?.status||0,error:clean(response?.error,500)}});
    const list=Array.isArray(response.list)?response.list:[];groupPagesRead++;groupTotalRows+=list.length;sourceGroups.push(...list);groupSourceVersion=clean(response.raw?.CurrentVersion||response.currentVersion||groupSourceVersion);
    const candidate=Number(response.totalRecords??response.TotalRecords??response.raw?.TotalRecords??response.result?.[0]?.TotalRecords??response.raw?.Result?.[0]?.TotalRecords);
    if(Number.isFinite(candidate)&&candidate>=0)groupTotalRecords=candidate;
    if(groupTotalRecords!=null&&groupTotalRows>=groupTotalRecords)break;
    if(groupTotalRecords==null&&list.length<pageSize)break;
  }
  const hierarchy=resolveGroupHierarchy(sourceGroups,{fetchedAt,sourceVersion:groupSourceVersion});
  const items=[];
  for(let page=0;page<maxPages;page++){
    const response=await shaygan.getItemsPage(page*pageSize,pageSize);
    if(!response?.ok)fail('OFFICIAL_ITEM_GROUP_READ_FAILED','خواندن read-only گروه کالا از Item/Get ناموفق بود.',502,{details:{page,error:clean(response?.error,500)}});
    const list=Array.isArray(response.list)?response.list:[]; pagesRead++; totalRows+=list.length;
    const candidate=Number(response.totalRecords??response.TotalRecords??response.raw?.TotalRecords??response.result?.[0]?.TotalRecords??response.raw?.Result?.[0]?.TotalRecords);
    if(Number.isFinite(candidate)&&candidate>=0)totalRecords=candidate;
    for(const mapped of list){const raw=mapped.raw||mapped;const item=normalizeOfficialItem({...raw,...mapped});if(item.itemGuid||item.itemCode)items.push(item);}
    if(totalRecords!=null&&totalRows>=totalRecords)break;
    if(totalRecords==null&&list.length<pageSize)break;
  }
  const assignments=[];
  for(const item of items){
    const assignment={...resolveItemGroup(item,hierarchy),catalogRunId,source:'shaygan-official-read',fetchedAt,active:true};assignments.push(assignment);
  }
  const groupRows=hierarchy.rows.map(row=>({...row,catalogRunId,source:'shaygan-official-read'}));
  await bulkUpsert(db.collection(ITEM_GROUP_ASSIGNMENTS),assignments,'itemIdentity');await bulkUpsert(db.collection(GROUP_CATALOG),groupRows,'groupIdentity');
  const resolutionCounts={};for(const row of assignments)resolutionCounts[row.resolutionStatus]=(resolutionCounts[row.resolutionStatus]||0)+1;
  const run={catalogRunId,source:'shaygan-official-read',sourceEndpoint:'ItemGroup/GetList + Item/Get',sourceVersion:groupSourceVersion,fetchedAt,groupPagesRead,groupTotalRows,groupTotalRecords,groupExpectedPages:groupTotalRecords==null?null:Math.ceil(groupTotalRecords/pageSize),itemPagesRead:pagesRead,pagesRead,totalRows,totalRecords,...hierarchy.diagnostics,hierarchyResolvedCount:hierarchy.diagnostics.parentResolvedCount,hierarchyUnresolvedCount:hierarchy.diagnostics.groupCount-hierarchy.diagnostics.parentResolvedCount,itemCount:assignments.length,itemOfficialResolutionCount:assignments.filter(r=>r.isOfficialEvidence).length,itemResolutionCounts:resolutionCounts,endpointDiagnostics:[{route:'/api/ItemGroup/GetList',method:'POST',requestShape:{StartVersion:'0',EndVersion:'',Domain:['Sort','SortOnAuxId','GroupNumber'],Config:'ConnectionName redacted'},status:200,responseShape:['GroupGuid','GroupNumber','GroupName','ParentGroupNumber','ParentGroupName','ParentGroupGuId','IsMainGroup']}],createdBy:current,readOnlySource:true};
  await db.collection(GROUP_CATALOG_RUNS).insertOne(run);
  return {ok:true,run,inventoryWrites:0,snapshotWrites:0,fifoWrites:0,invoiceWrites:0,automaticMappingsApproved:0};
}

async function assignmentMaps(db){const latest=await db.collection(GROUP_CATALOG_RUNS).findOne({}, {sort:{fetchedAt:-1}});const query=latest?.catalogRunId?{catalogRunId:latest.catalogRunId}:{active:true};const rows=await db.collection(ITEM_GROUP_ASSIGNMENTS).find(query).toArray();return{run:latest,rows,byGuid:new Map(rows.filter(r=>r.itemGuid).map(r=>[r.itemGuid,r])),byCode:new Map(rows.filter(r=>r.itemCode).map(r=>[r.itemCode,r]))};}
function assignmentFor(maps,fact){return maps.byGuid.get(clean(fact.itemGuid))||maps.byCode.get(clean(fact.itemCode))||null;}
function enrichFact(fact,assignment){return assignment?.isOfficialEvidence?{...fact,groupGuid:assignment.resolvedMainGroupGuid,groupPathIdentity:assignment.resolvedMainGroupIdentity,mainGroupCode:assignment.resolvedMainGroupNumber||''}:fact;}

async function groupReviewMatrix(db, filters={}, requestedBy={}) {
  requireRole(requestedBy,READ_ROLES); await ensureIndexes(db);
  const fifoDatasetId=clean(filters.fifoDatasetId)||(await db.collection(ledger.FIFO_FACTS).findOne({}, {sort:{createdAt:-1}}))?.fifoDatasetId||'';
  let facts=await db.collection(ledger.FIFO_FACTS).find({fifoDatasetId}).toArray();
  const periodFrom=filters.periodFrom?date8(filters.periodFrom,'periodFrom'):''; const periodTo=filters.periodTo?date8(filters.periodTo,'periodTo'):'';
  if(periodFrom)facts=facts.filter(r=>r.saleDate>=periodFrom);if(periodTo)facts=facts.filter(r=>r.saleDate<=periodTo);
  const maps=await assignmentMaps(db); const mappings=await db.collection(ledger.CATEGORY_MAPPINGS).find({}).toArray();
  const grouped=new Map();let resolvedLineCount=0,resolvedSaleValue='0.00',prefixOnlyLineCount=0,prefixOnlySaleValue='0.00';const resolutionCounts={};
  for(const fact of facts){const assignment=assignmentFor(maps,fact);const official=Boolean(assignment?.isOfficialEvidence);const status=official?assignment.resolutionStatus:(assignment?.resolutionStatus||((fact.itemCode||'')?'prefix-fallback-only':'missing-group-identity'));resolutionCounts[status]=(resolutionCounts[status]||0)+1;if(official){resolvedLineCount++;resolvedSaleValue=add([resolvedSaleValue,fact.saleAmountExact||0]);}else if(status==='prefix-fallback-only'||assignment?.prefixFallbackOnly){prefixOnlyLineCount++;prefixOnlySaleValue=add([prefixOnlySaleValue,fact.saleAmountExact||0]);}
    const key=official?assignment.resolvedMainGroupIdentity:`UNRESOLVED:${status}`;const row=grouped.get(key)||{groupIdentity:official?assignment.resolvedMainGroupIdentity:'UNRESOLVED',groupGuid:official?assignment.resolvedMainGroupGuid:'',groupNumber:official?assignment.resolvedMainGroupNumber:'',groupName:official?assignment.resolvedMainGroupName:'Unresolved official group',mainGroupIdentity:official?assignment.resolvedMainGroupIdentity:'',mainGroupGuid:official?assignment.resolvedMainGroupGuid:'',mainGroupNumber:official?assignment.resolvedMainGroupNumber:'',mainGroupName:official?assignment.resolvedMainGroupName:'',hierarchyStatus:official?'resolved':status,validationStatus:official?'official-main-resolved':status,resolutionStatus:status,officialEvidence:official,saleLineCount:0,saleQuantity:'0.000000',saleValue:'0.00',knownFifoProfit:'0.00',unknownCostValue:'0.00',unresolvedGroupValue:'0.00',_items:new Set(),_invoices:new Set(),_children:new Map()};
    row.saleLineCount++;row._items.add(fact.itemGuid||fact.itemCode);row._invoices.add(fact.saleInvoiceIdentity);if(assignment?.groupIdentity)row._children.set(assignment.groupIdentity,{groupIdentity:assignment.groupIdentity,groupGuid:assignment.groupGuid,groupNumber:assignment.groupNumber,groupName:assignment.groupName,resolutionStatus:assignment.resolutionStatus});row.saleQuantity=add([row.saleQuantity,fact.quantityExact||0],6);row.saleValue=add([row.saleValue,fact.saleAmountExact||0]);if(!official)row.unresolvedGroupValue=add([row.unresolvedGroupValue,fact.saleAmountExact||0]);if(fact.actualFifoProfitExact!=null)row.knownFifoProfit=add([row.knownFifoProfit,fact.actualFifoProfitExact]);else row.unknownCostValue=add([row.unknownCostValue,fact.saleAmountExact||0]);grouped.set(key,row);}
  const totalSaleValue=add(facts.map(row=>row.saleAmountExact||0));
  for(const row of grouped.values()){
    const relevant=mappings.filter(m=>['groupPathIdentity','groupGuid'].includes(m.identityType)&&(m.identityValue===row.groupIdentity||m.identityValue===row.groupGuid));
    row.currentMappingStatus=relevant.some(m=>m.status==='approved')?'approved':relevant.some(m=>m.status==='pending')?'pending':relevant.some(m=>m.status==='draft')?'draft':'missing';
    row.currentCommissionCategory=relevant.find(m=>m.status==='approved')?.commissionCategory||'UNKNOWN';
    row.childGroups=[...row._children.values()];row.childGroupCount=row.childGroups.length;const haystack=`${row.groupName} ${row.childGroups.map(x=>x.groupName).join(' ')}`.toLowerCase();
    row.suggestedCommissionCategory=/notebook|laptop|نوت|لپ/.test(haystack)?'NOTEBOOK':row.officialEvidence?'COMPONENT':'UNKNOWN';
    row.suggestionEvidence=row.suggestedCommissionCategory==='UNKNOWN'?'Official hierarchy unresolved; prefix fallback is diagnostic-only and human evidence is required.':'Suggestion derived from official main/child group names; never auto-approved.';
    row.itemCount=row._items.size;row.representativeItems=[...row._items].slice(0,10);row.representativeInvoices=[...row._invoices].slice(0,10);row.projectedSaleValueGain=row.currentMappingStatus==='approved'?'0.00':row.saleValue;row.projectedCoverageGainPercent=row.currentMappingStatus==='approved'?0:pct(row.saleValue,totalSaleValue);delete row._items;delete row._invoices;delete row._children;
  }
  let rows=[...grouped.values()].sort((a,b)=>Number(b.saleValue)-Number(a.saleValue));if(filters.minSaleValue)rows=rows.filter(row=>Number(row.saleValue)>=Number(filters.minSaleValue));if(filters.search){const query=clean(filters.search).toLowerCase();rows=rows.filter(row=>[row.groupIdentity,row.groupNumber,row.groupName,...row.childGroups.map(x=>`${x.groupNumber} ${x.groupName}`),...row.representativeItems,...row.representativeInvoices].some(value=>clean(value).toLowerCase().includes(query)));}
  const coverage={factLineCount:facts.length,factSaleValue:totalSaleValue,officialResolvedLineCount:resolvedLineCount,officialResolvedSaleValue:resolvedSaleValue,officialResolvedLinePercent:pct(resolvedLineCount,facts.length),officialResolvedSaleValuePercent:pct(resolvedSaleValue,totalSaleValue),unresolvedLineCount:facts.length-resolvedLineCount,unresolvedSaleValue:ledger._subtract(totalSaleValue,resolvedSaleValue),prefixOnlyLineCount,prefixOnlySaleValue,prefixOnlyLinePercent:pct(prefixOnlyLineCount,facts.length),prefixOnlySaleValuePercent:pct(prefixOnlySaleValue,totalSaleValue),resolutionCounts};
  return {ok:true,fifoDatasetId,periodFrom,periodTo,...pageRows(rows,filters),coverage,catalog:{catalogRunId:maps.run?.catalogRunId||'',assignmentCount:maps.rows.length,groupCount:maps.run?.groupCount||0,mainGroupCount:maps.run?.mainGroupCount||0,childGroupCount:maps.run?.childGroupCount||0,parentResolvedCount:maps.run?.parentResolvedCount||0,orphanParentCount:maps.run?.orphanParentCount||0,cycleCount:maps.run?.cycleCount||0,ambiguousNumbers:maps.run?.ambiguousNumbers||[],unresolvedLineCount:coverage.unresolvedLineCount},automaticApproval:false};
}

async function rateReviewMatrix(db,filters={},requestedBy={}){
  requireRole(requestedBy,READ_ROLES);await ensureIndexes(db);
  const fifoDatasetId=clean(filters.fifoDatasetId)||(await db.collection(ledger.FIFO_FACTS).findOne({}, {sort:{createdAt:-1}}))?.fifoDatasetId||'';
  const periodFrom=date8(filters.periodFrom||'14050401','periodFrom');
  const periodTo=date8(filters.periodTo||'14050431','periodTo');
  const facts=(await db.collection(ledger.FIFO_FACTS).find({fifoDatasetId}).toArray()).filter(row=>row.saleDate>=periodFrom&&row.saleDate<=periodTo);
  const maps=await assignmentMaps(db);const mappings=await db.collection(ledger.CATEGORY_MAPPINGS).find({}).toArray();const rates=await db.collection(ledger.RATE_VERSIONS).find({}).toArray();const matrix=new Map();
  for(const fact of facts){
    const enriched=enrichFact(fact,assignmentFor(maps,fact));
    const approved=ledger._resolveCategoryFromMappings(mappings.filter(row=>row.status==='approved'),enriched,fact.saleDate);
    const projected=approved.status==='resolved'?approved:ledger._resolveCategoryFromMappings(mappings.filter(row=>['pending','draft'].includes(row.status)),enriched,fact.saleDate);
    const category=projected.status==='resolved'?projected.category:'UNKNOWN';const key=(fact.sellerIdentity||'UNRESOLVED')+'|'+category;
    const row=matrix.get(key)||{sellerIdentity:fact.sellerIdentity||'UNRESOLVED',sellerName:fact.sellerName||'',commissionCategory:category,saleLineCount:0,saleValue:'0.00',mappingStatus:approved.status==='resolved'?'approved':projected.status==='resolved'?'projected':'missing'};
    row.saleLineCount++;row.saleValue=add([row.saleValue,fact.saleAmountExact||0]);matrix.set(key,row);
  }
  for(const row of matrix.values()){
    const eligible=rates.filter(rate=>rate.commissionCategory===row.commissionCategory&&(rate.sellerIdentity===row.sellerIdentity||rate.sellerIdentity==='*')&&rate.effectiveFrom<=periodTo&&(!rate.effectiveTo||rate.effectiveTo>=periodFrom));
    const rank={approved:0,pending:1,draft:2};const preferred=eligible.sort((a,b)=>(a.sellerIdentity==='*')-(b.sellerIdentity==='*')||(rank[a.status]??9)-(rank[b.status]??9))[0];
    row.proposedRate=preferred?.rate??null;row.rateVersionId=preferred?.rateVersionId||'';row.rateStatus=preferred?.status||'missing';row.rateClassification=preferred?(preferred.sellerIdentity==='*'?'standard-global':'seller-exception'):'missing';row.evidence=preferred?.sourceReference||'';row.ambiguityNotes=eligible.filter(rate=>rate.sellerIdentity===preferred?.sellerIdentity&&rate.status===preferred?.status).length>1?'multiple-candidates':'';
  }
  const rows=[...matrix.values()].sort((a,b)=>Number(b.saleValue)-Number(a.saleValue)||a.sellerIdentity.localeCompare(b.sellerIdentity));
  return{ok:true,fifoDatasetId,periodFrom,periodTo,...pageRows(rows,filters),blankRateIsZero:false,automaticApproval:false};
}

function evidence(input={}) { return {sourceDocumentType:clean(input.sourceDocumentType,100),sourceReference:clean(input.sourceReference,500),attachmentMetadata:input.attachmentMetadata&&typeof input.attachmentMetadata==='object'?JSON.parse(JSON.stringify(input.attachmentMetadata)):null,evidenceUnavailableReason:clean(input.evidenceUnavailableReason,1000),reason:clean(input.reason,2000)}; }
function requireEvidence(value, code='EVIDENCE_REQUIRED') { if(!value.sourceReference||!value.reason||(!value.attachmentMetadata&&!value.evidenceUnavailableReason))fail(code,'دلیل، مرجع منبع و attachment یا دلیل نبود مدرک الزامی است.'); }
function normalizeOpening(input={}) { const pool=clean(input.pool).toUpperCase();if(!POOLS.includes(pool))fail('OPENING_POOL_INVALID','Pool باید NOTEBOOK یا COMPONENT باشد.');const accountingPeriod=clean(input.accountingPeriod,6);if(!/^\d{6}$/.test(accountingPeriod))fail('OPENING_PERIOD_INVALID','دوره شمسی YYYYMM الزامی است.');const openingAmountExact=exact(input.openingAmountExact??input.amountExact);if(Number(openingAmountExact)<=0)fail('OPENING_AMOUNT_INVALID','مبلغ opening balance باید مثبت باشد.');const ev=evidence(input);requireEvidence(ev,'OPENING_EVIDENCE_REQUIRED');return{pool,accountingPeriod,openingAmountExact,...ev,entryKind:clean(input.entryKind||'OPENING').toUpperCase(),reversalOf:clean(input.reversalOf,100)};}
async function createOpeningBalance(db,input={},requestedBy={}){const current=requireRole(requestedBy,EDIT_ROLES);await ensureIndexes(db);const value=normalizeOpening(input);if(value.entryKind==='REVERSAL'){const original=await db.collection(OPENING_BALANCES).findOne({openingBalanceId:value.reversalOf,status:'approved'});if(!original)fail('OPENING_REVERSAL_SOURCE_INVALID','Opening balance approved برای reversal پیدا نشد.',409);if(original.pool!==value.pool||original.accountingPeriod!==value.accountingPeriod||original.openingAmountExact!==value.openingAmountExact)fail('OPENING_REVERSAL_MISMATCH','Reversal باید دقیقاً به همان pool، period و amount متصل باشد.',409);}const now=new Date();const row={openingBalanceId:newId(value.entryKind==='REVERSAL'?'SPOBR':'SPOB'),schemaVersion:1,...value,status:'draft',revision:1,createdBy:current,approvedBy:null,auditLog:[audit('opening-created',current,{pool:value.pool,period:value.accountingPeriod,entryKind:value.entryKind})],createdAt:now,updatedAt:now,softDeleteOnly:true};row.contentHash=sha(JSON.stringify({pool:row.pool,accountingPeriod:row.accountingPeriod,openingAmountExact:row.openingAmountExact,sourceDocumentType:row.sourceDocumentType,sourceReference:row.sourceReference,entryKind:row.entryKind,reversalOf:row.reversalOf,createdBy:row.createdBy}));await db.collection(OPENING_BALANCES).insertOne(row);return{ok:true,openingBalance:row,ledgerPosted:false,automaticApproval:false};}
async function listOpeningBalances(db,filters={},requestedBy={}){requireRole(requestedBy,READ_ROLES);await ensureIndexes(db);let rows=await db.collection(OPENING_BALANCES).find({}).toArray();if(filters.pool)rows=rows.filter(r=>r.pool===clean(filters.pool).toUpperCase());if(filters.status)rows=rows.filter(r=>r.status===clean(filters.status));rows.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));return{ok:true,...pageRows(rows,filters),pools:POOLS,physicalDeleteAllowed:false};}
async function updateOpeningBalance(db,id,input={},requestedBy={}){const current=requireRole(requestedBy,EDIT_ROLES);const row=await db.collection(OPENING_BALANCES).findOne({openingBalanceId:clean(id,100)});if(!row)fail('OPENING_NOT_FOUND','Opening balance پیدا نشد.',404);if(!['draft','returned'].includes(row.status))fail('OPENING_EDIT_INVALID','فقط draft یا returned قابل ویرایش است.',409);if(Number(input.revision)!==Number(row.revision))fail('OPENING_CONFLICT','Revision تغییر کرده است.',409);const value=normalizeOpening({...row,...input});const patch={...value,status:'draft',revision:Number(row.revision)+1,updatedAt:new Date(),auditLog:[...(row.auditLog||[]),audit('opening-updated',current,{reason:value.reason})].slice(-300)};const result=await db.collection(OPENING_BALANCES).updateOne({openingBalanceId:row.openingBalanceId,revision:row.revision,status:row.status},{$set:patch});if(!result.matchedCount)fail('OPENING_CONFLICT','Revision هم‌زمان تغییر کرده است.',409);return{ok:true,openingBalance:{...row,...patch}};}
async function ensureOpeningLedger(db,row,current){const sourceAdjustmentId=`OPENING:${row.openingBalanceId}`;const existing=await db.collection(ledger.SAVED_LEDGER).findOne({sourceAdjustmentId});if(existing)return existing;const credit=row.entryKind==='REVERSAL'?'0.00':row.openingAmountExact;const debit=row.entryKind==='REVERSAL'?row.openingAmountExact:'0.00';const entry={ledgerEntryId:`SPL-OPEN-${sha(row.openingBalanceId).slice(0,24)}`,schemaVersion:1,pool:row.pool,entryType:row.entryKind==='REVERSAL'?'REVERSAL':'OPENING_BALANCE',debitAmountExact:debit,creditAmountExact:credit,sourceSaleLineIdentity:'',beneficiarySaleLineIdentity:'',sourceAdjustmentId,accountingPeriod:row.accountingPeriod,description:row.reason,createdBy:row.createdBy,approvedBy:current,postedAt:new Date(),reversalOf:row.reversalOf?`SPL-OPEN-${sha(row.reversalOf).slice(0,24)}`:'',auditMetadata:{sourceDocumentType:row.sourceDocumentType,sourceReference:row.sourceReference,attachmentMetadata:row.attachmentMetadata,evidenceUnavailableReason:row.evidenceUnavailableReason},appendOnly:true};entry.contentHash=sha(JSON.stringify({...entry,postedAt:entry.postedAt.toISOString()}));await db.collection(ledger.SAVED_LEDGER).insertOne(entry);return entry;}
async function transitionOpeningBalance(db,id,action,input={},requestedBy={}){const approve=['approve','reject','return'].includes(action);const current=requireRole(requestedBy,approve?APPROVE_ROLES:EDIT_ROLES);await ensureIndexes(db);let row=await db.collection(OPENING_BALANCES).findOne({openingBalanceId:clean(id,100)});if(!row)fail('OPENING_NOT_FOUND','Opening balance پیدا نشد.',404);if(action==='approve'&&row.status==='approved'){const ledgerEntry=await ensureOpeningLedger(db,row,current);return{ok:true,openingBalance:row,ledgerEntry,idempotent:true};}if(Number(input.revision)!==Number(row.revision))fail('OPENING_CONFLICT','Revision تغییر کرده است.',409);const rules={submit:{from:['draft','returned'],to:'pending'},cancel:{from:['draft','returned'],to:'cancelled'},approve:{from:['pending'],to:'approved'},reject:{from:['pending'],to:'rejected'},return:{from:['pending'],to:'returned'}};const rule=rules[action];if(!rule||!rule.from.includes(row.status))fail('OPENING_TRANSITION_INVALID','انتقال وضعیت Opening مجاز نیست.',409);if(action==='approve'&&row.createdBy?.username===current.username)fail('OPENING_SELF_APPROVAL','ایجادکننده نمی‌تواند Opening خود را تأیید کند.',403);if(approve){const ev=evidence(input);requireEvidence({...ev,sourceReference:ev.sourceReference||row.sourceReference},'OPENING_APPROVAL_EVIDENCE_REQUIRED');}
  if(action==='approve'){const other=(await db.collection(OPENING_BALANCES).find({pool:row.pool,accountingPeriod:row.accountingPeriod,status:'approved'}).toArray()).find(x=>x.openingBalanceId!==row.openingBalanceId&&x.entryKind===row.entryKind);if(other)fail('OPENING_APPROVED_DUPLICATE','برای این pool و period قبلاً Opening approved وجود دارد.',409);}
  const now=new Date();const patch={status:rule.to,revision:Number(row.revision)+1,updatedAt:now,auditLog:[...(row.auditLog||[]),audit(`opening-${action}`,current,{reason:input.reason,evidenceReference:input.sourceReference})].slice(-300)};if(action==='approve')Object.assign(patch,{approvedBy:current,approvedAt:now,approvalReason:clean(input.reason,2000),approvalEvidenceReference:clean(input.sourceReference||row.sourceReference,500),approvedSlot:'approved'});if(action==='submit')patch.submittedBy=current;if(action==='reject')patch.rejectedBy=current;if(action==='return')patch.returnedBy=current;
  let result;try{result=await db.collection(OPENING_BALANCES).updateOne({openingBalanceId:row.openingBalanceId,status:row.status,revision:row.revision},{$set:patch});}catch(error){if(error?.code===11000)fail('OPENING_APPROVED_DUPLICATE','برای این pool و period قبلاً Opening approved وجود دارد.',409);throw error;}if(!result.matchedCount)fail('OPENING_CONFLICT','Revision هم‌زمان تغییر کرده است.',409);row={...row,...patch};const ledgerEntry=action==='approve'?await ensureOpeningLedger(db,row,current):null;return{ok:true,openingBalance:row,ledgerEntry,automaticApproval:false};}

async function readiness(db,input={},requestedBy={}) {
  requireRole(requestedBy,READ_ROLES); await ensureIndexes(db);
  const configuredThreshold=Number(process.env.ACCOUNTING_EXPORT_MIN_MAPPED_SALE_VALUE_PERCENT||95);const policy={mappedSaleValueMinimumPercent:Math.max(95,Math.min(100,Number.isFinite(configuredThreshold)?configuredThreshold:95)),requireMappedLines:true,requireApprovedRates:true,requireNotebookOpening:true,requireComponentOpening:true,requireCompleteCostCoverage:true,requireResolvedDiscounts:true,requireSellerIdentity:true};
  const fifoDatasetId=clean(input.fifoDatasetId)||(await db.collection(ledger.FIFO_FACTS).findOne({}, {sort:{createdAt:-1}}))?.fifoDatasetId||'';
  const periodFrom=date8(input.periodFrom||'14050401','periodFrom');const periodTo=date8(input.periodTo||'14050431','periodTo');
  const facts=(await db.collection(ledger.FIFO_FACTS).find({fifoDatasetId}).toArray()).filter(r=>r.saleDate>=periodFrom&&r.saleDate<=periodTo);
  const maps=await assignmentMaps(db);const mappings=await db.collection(ledger.CATEGORY_MAPPINGS).find({}).toArray();const rates=await db.collection(ledger.RATE_VERSIONS).find({}).toArray();const openings=await db.collection(OPENING_BALANCES).find({accountingPeriod:periodFrom.slice(0,6)}).toArray();
  const metrics={lineCount:facts.length,saleValue:add(facts.map(r=>r.saleAmountExact||0)),officialGroupLineCount:0,officialGroupSaleValue:'0.00',mappedLineCount:0,mappedSaleValue:'0.00',projectedMappedLineCount:0,projectedMappedSaleValue:'0.00',approvedRateLineCount:0,completeCostLineCount:0,partialCostLineCount:0,unknownCostLineCount:0,completeCostValue:'0.00',partialCostValue:'0.00',unknownCostValue:'0.00',unknownCategoryLineCount:0,unknownCategoryValue:'0.00',unresolvedDiscountLineCount:0,unresolvedSellerLineCount:0};const missingRates=new Set();
  for(const fact of facts){const assignment=assignmentFor(maps,fact);if(assignment?.isOfficialEvidence){metrics.officialGroupLineCount++;metrics.officialGroupSaleValue=add([metrics.officialGroupSaleValue,fact.saleAmountExact||0]);}const enriched=enrichFact(fact,assignment);const approved=ledger._resolveCategoryFromMappings(mappings.filter(m=>m.status==='approved'),enriched,fact.saleDate);const projected=approved.status==='resolved'?approved:ledger._resolveCategoryFromMappings(mappings.filter(m=>['pending','draft'].includes(m.status)),enriched,fact.saleDate);if(approved.status==='resolved'&&approved.category!=='UNKNOWN'){metrics.mappedLineCount++;metrics.mappedSaleValue=add([metrics.mappedSaleValue,fact.saleAmountExact||0]);const rate=ledger._resolveRateFromRows(rates.filter(r=>r.status==='approved'),fact.sellerIdentity,approved.category,fact.saleDate);if(rate.status==='resolved')metrics.approvedRateLineCount++;else missingRates.add(`${fact.sellerIdentity}|${approved.category}`);}else{metrics.unknownCategoryLineCount++;metrics.unknownCategoryValue=add([metrics.unknownCategoryValue,fact.saleAmountExact||0]);}if(projected.status==='resolved'&&projected.category!=='UNKNOWN'){metrics.projectedMappedLineCount++;metrics.projectedMappedSaleValue=add([metrics.projectedMappedSaleValue,fact.saleAmountExact||0]);}const kind=fact.costCoverageStatus==='complete'?'complete':fact.costCoverageStatus==='partial'?'partial':'unknown';metrics[`${kind}CostLineCount`]++;metrics[`${kind}CostValue`]=add([metrics[`${kind}CostValue`],fact.saleAmountExact||0]);if(fact.invoiceDiscountAttributionStatus==='unresolved-invoice-level')metrics.unresolvedDiscountLineCount++;if(!clean(fact.sellerIdentity))metrics.unresolvedSellerLineCount++;}
  metrics.officialGroupLinePercent=pct(metrics.officialGroupLineCount,metrics.lineCount);metrics.officialGroupSaleValuePercent=pct(metrics.officialGroupSaleValue,metrics.saleValue);metrics.mappedLinePercent=pct(metrics.mappedLineCount,metrics.lineCount);metrics.mappedSaleValuePercent=pct(metrics.mappedSaleValue,metrics.saleValue);metrics.pendingMappedLineCount=Math.max(0,metrics.projectedMappedLineCount-metrics.mappedLineCount);metrics.pendingMappedSaleValue=ledger._subtract(metrics.projectedMappedSaleValue,metrics.mappedSaleValue);metrics.projectedMappedLinePercent=pct(metrics.projectedMappedLineCount,metrics.lineCount);metrics.projectedMappedSaleValuePercent=pct(metrics.projectedMappedSaleValue,metrics.saleValue);metrics.approvedRateCoveragePercent=pct(metrics.approvedRateLineCount,metrics.mappedLineCount);metrics.unknownCategoryLinePercent=pct(metrics.unknownCategoryLineCount,metrics.lineCount);metrics.unknownCategoryValuePercent=pct(metrics.unknownCategoryValue,metrics.saleValue);for(const kind of ['complete','partial','unknown']){metrics[`${kind}CostLinePercent`]=pct(metrics[`${kind}CostLineCount`],metrics.lineCount);metrics[`${kind}CostValuePercent`]=pct(metrics[`${kind}CostValue`],metrics.saleValue);}
  const openingReadiness=Object.fromEntries(POOLS.map(pool=>{const rows=openings.filter(r=>r.pool===pool&&r.entryKind==='OPENING');return[pool,{approved:rows.some(r=>r.status==='approved'),pending:rows.some(r=>r.status==='pending'),draft:rows.some(r=>r.status==='draft'),count:rows.length}];}));const blockers=[];if(metrics.mappedSaleValuePercent<policy.mappedSaleValueMinimumPercent)blockers.push({code:'MAPPED_SALE_VALUE_BELOW_THRESHOLD',actual:metrics.mappedSaleValuePercent,required:policy.mappedSaleValueMinimumPercent});if(policy.requireMappedLines&&metrics.mappedLineCount<metrics.lineCount)blockers.push({code:'UNMAPPED_LINES',count:metrics.lineCount-metrics.mappedLineCount});if(policy.requireApprovedRates&&metrics.approvedRateLineCount<metrics.mappedLineCount)blockers.push({code:'MISSING_APPROVED_RATES',count:metrics.mappedLineCount-metrics.approvedRateLineCount,identities:[...missingRates].slice(0,100)});if(policy.requireNotebookOpening&&!openingReadiness.NOTEBOOK.approved)blockers.push({code:'NOTEBOOK_OPENING_BALANCE_NOT_APPROVED'});if(policy.requireComponentOpening&&!openingReadiness.COMPONENT.approved)blockers.push({code:'COMPONENT_OPENING_BALANCE_NOT_APPROVED'});if(policy.requireCompleteCostCoverage&&(metrics.partialCostLineCount||metrics.unknownCostLineCount))blockers.push({code:'COST_COVERAGE_INCOMPLETE',partial:metrics.partialCostLineCount,unknown:metrics.unknownCostLineCount});if(policy.requireResolvedDiscounts&&metrics.unresolvedDiscountLineCount)blockers.push({code:'DISCOUNT_ATTRIBUTION_UNRESOLVED',count:metrics.unresolvedDiscountLineCount});if(policy.requireSellerIdentity&&metrics.unresolvedSellerLineCount)blockers.push({code:'SELLER_IDENTITY_UNRESOLVED',count:metrics.unresolvedSellerLineCount});
  const exceptionalRateCandidates=rates.filter(row=>row.sellerIdentity!=='*'&&['draft','pending'].includes(row.status)&&row.effectiveFrom<=periodTo&&(!row.effectiveTo||row.effectiveTo>=periodFrom)).map(row=>({rateVersionId:row.rateVersionId,sellerIdentity:row.sellerIdentity,commissionCategory:row.commissionCategory,rate:row.rate,status:row.status}));return{ok:true,fifoDatasetId,periodFrom,periodTo,policy,metrics,openingReadiness,missingRateSellers:[...missingRates],exceptionalRateCandidates,blockers,normalExportReady:blockers.length===0,diagnosticExportPayable:false,profitRoiCommissionEnabled:false};
}
async function authorizeDiagnosticExport(db,input={},requestedBy={}){const current=requireRole(requestedBy,['admin']);const ev=evidence(input);requireEvidence(ev,'DIAGNOSTIC_EXPORT_EVIDENCE_REQUIRED');const override={overrideId:newId('XOVR'),schemaVersion:1,exportMode:'diagnostic',reason:ev.reason,sourceReference:ev.sourceReference,attachmentMetadata:ev.attachmentMetadata,evidenceUnavailableReason:ev.evidenceUnavailableReason,createdBy:current,createdAt:new Date(),audited:true,payable:false};await db.collection(EXPORT_OVERRIDES).insertOne(override);return override;}

module.exports={GROUP_CATALOG,ITEM_GROUP_ASSIGNMENTS,GROUP_CATALOG_RUNS,OPENING_BALANCES,OPENING_LOCKS,EXPORT_OVERRIDES,COLLECTIONS,ensureIndexes,normalizeOfficialGroup,resolveGroupHierarchy,normalizeOfficialItem,resolveItemGroup,refreshOfficialGroupCatalog,groupReviewMatrix,rateReviewMatrix,createOpeningBalance,listOpeningBalances,updateOpeningBalance,transitionOpeningBalance,readiness,authorizeDiagnosticExport,enrichFact,_assignmentMaps:assignmentMaps};
