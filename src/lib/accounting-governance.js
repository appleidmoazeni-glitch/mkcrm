'use strict';

/*
 * Phase 5.3.1 — accounting governance boundary.
 *
 * This module owns evidence catalogues and human approval workflow only. It
 * reads official Shaygan Item/Get and immutable accounting facts; it never
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
  await db.collection(GROUP_CATALOG).createIndex({groupNumber:1,parentGroupGuid:1});
  await db.collection(ITEM_GROUP_ASSIGNMENTS).createIndex({itemIdentity:1},{unique:true});
  await db.collection(ITEM_GROUP_ASSIGNMENTS).createIndex({itemGuid:1});
  await db.collection(ITEM_GROUP_ASSIGNMENTS).createIndex({itemCode:1});
  await db.collection(GROUP_CATALOG_RUNS).createIndex({catalogRunId:1},{unique:true});
  await db.collection(OPENING_BALANCES).createIndex({openingBalanceId:1},{unique:true});
  await db.collection(OPENING_BALANCES).createIndex({pool:1,accountingPeriod:1,status:1});
  await db.collection(OPENING_BALANCES).createIndex({pool:1,accountingPeriod:1,entryKind:1,approvedSlot:1},{unique:true,sparse:true});
  await db.collection(OPENING_LOCKS).createIndex({lockKey:1},{unique:true});
  await db.collection(EXPORT_OVERRIDES).createIndex({overrideId:1},{unique:true});
  return {ok:true,collections:COLLECTIONS};
}

function first(row, keys) { for(const key of keys)if(clean(row?.[key]))return clean(row[key],500); return ''; }
function normalizeOfficialItem(row={}) {
  const itemGuid=first(row,['ItemGuId','ItemGuid','GuId','itemGuid']);
  const itemCode=first(row,['ItemCode','ProductCode','itemCode']);
  const groupGuid=first(row,['ItemGroupGuId','ItemGroupGuid','ProductGroupGuId','groupGuid']);
  const groupNumber=first(row,['ItemGroupNumber','ProductGroupNumber','groupNumber']);
  const groupName=first(row,['ItemGroupName','ProductGroupName','groupName']);
  const parentGroupGuid=first(row,['ParentItemGroupGuId','ParentGroupGuId','MainItemGroupGuId','ItemMainGroupGuId','parentGroupGuid']);
  const parentGroupNumber=first(row,['ParentItemGroupNumber','ParentGroupNumber','MainItemGroupNumber','ItemMainGroupNumber','parentGroupNumber']);
  const parentGroupName=first(row,['ParentItemGroupName','ParentGroupName','MainItemGroupName','ItemMainGroupName','parentGroupName']);
  const itemIdentity=itemGuid?`guid:${itemGuid}`:`code:${itemCode}`;
  const groupIdentity=groupGuid?`guid:${groupGuid}`:`number:${groupNumber}|parent:${parentGroupGuid||parentGroupNumber||'UNRESOLVED'}`;
  const hierarchyStatus=parentGroupGuid||parentGroupNumber?'resolved':'parent-unavailable-from-official-response';
  return {itemIdentity,itemGuid,itemCode,itemDescription:first(row,['ItemDesc','ProductDesc','ItemDescription','itemDescription']),groupIdentity,groupGuid,groupNumber,groupName,parentGroupGuid,parentGroupNumber,parentGroupName,hierarchyStatus,sourceEndpoint:'Invoice-independent Item/Get'};
}

async function refreshOfficialGroupCatalog(db, shaygan, input={}, requestedBy={}) {
  const current=requireRole(requestedBy,EDIT_ROLES); await ensureIndexes(db);
  const pageSize=Math.max(1,Math.min(Number(input.pageSize||100),100));
  const maxPages=Math.max(1,Math.min(Number(input.maxPages||1000),2000));
  const catalogRunId=newId('IGCAT'); const fetchedAt=new Date(); let pagesRead=0,totalRows=0,totalRecords=null;
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
  const groups=new Map();
  const assignments=[];
  for(const item of items){
    const assignment={...item,catalogRunId,source:'shaygan-official-read',fetchedAt,active:true};assignments.push(assignment);
    if(!groups.has(item.groupIdentity))groups.set(item.groupIdentity,{groupIdentity:item.groupIdentity,groupGuid:item.groupGuid,groupNumber:item.groupNumber,groupName:item.groupName,parentGroupGuid:item.parentGroupGuid,parentGroupNumber:item.parentGroupNumber,parentGroupName:item.parentGroupName,hierarchyStatus:item.hierarchyStatus,source:'shaygan-official-read',sourceEndpoint:'Item/Get',fetchedAt,catalogRunId,active:true});
  }
  await bulkUpsert(db.collection(ITEM_GROUP_ASSIGNMENTS),assignments,'itemIdentity');await bulkUpsert(db.collection(GROUP_CATALOG),[...groups.values()],'groupIdentity');
  const ambiguousNumbers=[]; const byNumber=new Map();
  for(const group of groups.values()){if(!byNumber.has(group.groupNumber))byNumber.set(group.groupNumber,new Set());byNumber.get(group.groupNumber).add(group.groupIdentity);}
  for(const [groupNumber,identities] of byNumber)if(groupNumber&&identities.size>1)ambiguousNumbers.push({groupNumber,groupIdentities:[...identities]});
  const run={catalogRunId,source:'shaygan-official-read',sourceEndpoint:'Item/Get',fetchedAt,pagesRead,totalRows,totalRecords,groupCount:groups.size,hierarchyResolvedCount:[...groups.values()].filter(row=>row.hierarchyStatus==='resolved').length,hierarchyUnresolvedCount:[...groups.values()].filter(row=>row.hierarchyStatus!=='resolved').length,ambiguousNumbers,createdBy:current,readOnlySource:true};
  await db.collection(GROUP_CATALOG_RUNS).insertOne(run);
  return {ok:true,run,inventoryWrites:0,snapshotWrites:0,fifoWrites:0,invoiceWrites:0,automaticMappingsApproved:0};
}

async function assignmentMaps(db){const latest=await db.collection(GROUP_CATALOG_RUNS).findOne({}, {sort:{fetchedAt:-1}});const query=latest?.catalogRunId?{catalogRunId:latest.catalogRunId}:{active:true};const rows=await db.collection(ITEM_GROUP_ASSIGNMENTS).find(query).toArray();return{byGuid:new Map(rows.filter(r=>r.itemGuid).map(r=>[r.itemGuid,r])),byCode:new Map(rows.filter(r=>r.itemCode).map(r=>[r.itemCode,r]))};}
function assignmentFor(maps,fact){return maps.byGuid.get(clean(fact.itemGuid))||maps.byCode.get(clean(fact.itemCode))||null;}
function enrichFact(fact,assignment){return assignment?{...fact,groupGuid:assignment.groupGuid,groupPathIdentity:assignment.groupIdentity,mainGroupCode:assignment.parentGroupNumber||''}:fact;}

async function groupReviewMatrix(db, filters={}, requestedBy={}) {
  requireRole(requestedBy,READ_ROLES); await ensureIndexes(db);
  const fifoDatasetId=clean(filters.fifoDatasetId)||(await db.collection(ledger.FIFO_FACTS).findOne({}, {sort:{createdAt:-1}}))?.fifoDatasetId||'';
  let facts=await db.collection(ledger.FIFO_FACTS).find({fifoDatasetId}).toArray();
  const periodFrom=filters.periodFrom?date8(filters.periodFrom,'periodFrom'):''; const periodTo=filters.periodTo?date8(filters.periodTo,'periodTo'):'';
  if(periodFrom)facts=facts.filter(r=>r.saleDate>=periodFrom);if(periodTo)facts=facts.filter(r=>r.saleDate<=periodTo);
  const maps=await assignmentMaps(db); const mappings=await db.collection(ledger.CATEGORY_MAPPINGS).find({}).toArray();
  const grouped=new Map();
  for(const fact of facts){const assignment=assignmentFor(maps,fact);const key=assignment?.groupIdentity||'UNRESOLVED';const row=grouped.get(key)||{groupIdentity:key,groupGuid:assignment?.groupGuid||'',groupNumber:assignment?.groupNumber||'',groupName:assignment?.groupName||'Unresolved official group',parentGroupGuid:assignment?.parentGroupGuid||'',parentGroupNumber:assignment?.parentGroupNumber||'',parentGroupName:assignment?.parentGroupName||'',hierarchyStatus:assignment?.hierarchyStatus||'item-not-in-official-catalog',saleLineCount:0,saleQuantity:'0.000000',saleValue:'0.00',knownFifoProfit:'0.00',unknownCostValue:'0.00',_items:new Set(),_invoices:new Set()};
    row.saleLineCount++;row._items.add(fact.itemGuid||fact.itemCode);row._invoices.add(fact.saleInvoiceIdentity);row.saleQuantity=add([row.saleQuantity,fact.quantityExact||0],6);row.saleValue=add([row.saleValue,fact.saleAmountExact||0]);if(fact.actualFifoProfitExact!=null)row.knownFifoProfit=add([row.knownFifoProfit,fact.actualFifoProfitExact]);else row.unknownCostValue=add([row.unknownCostValue,fact.saleAmountExact||0]);grouped.set(key,row);}
  const totalSaleValue=add(facts.map(row=>row.saleAmountExact||0));
  for(const row of grouped.values()){
    const relevant=mappings.filter(m=>['groupPathIdentity','groupGuid'].includes(m.identityType)&&(m.identityValue===row.groupIdentity||m.identityValue===row.groupGuid));
    row.currentMappingStatus=relevant.some(m=>m.status==='approved')?'approved':relevant.some(m=>m.status==='pending')?'pending':relevant.some(m=>m.status==='draft')?'draft':'missing';
    row.currentCommissionCategory=relevant.find(m=>m.status==='approved')?.commissionCategory||'UNKNOWN';
    const haystack=`${row.groupName} ${row.parentGroupName}`.toLowerCase();
    row.suggestedCommissionCategory=/notebook|laptop|نوت|لپ/.test(haystack)?'NOTEBOOK':row.hierarchyStatus==='resolved'?'COMPONENT':'UNKNOWN';
    row.suggestionEvidence=row.suggestedCommissionCategory==='UNKNOWN'?'Official parent hierarchy unavailable; human evidence required.':'Name-based review suggestion only; never auto-approved.';
    row.itemCount=row._items.size;row.representativeItems=[...row._items].slice(0,10);row.representativeInvoices=[...row._invoices].slice(0,10);row.projectedSaleValueGain=row.currentMappingStatus==='approved'?'0.00':row.saleValue;row.projectedCoverageGainPercent=row.currentMappingStatus==='approved'?0:pct(row.saleValue,totalSaleValue);delete row._items;delete row._invoices;
  }
  let rows=[...grouped.values()].sort((a,b)=>Number(b.saleValue)-Number(a.saleValue));if(filters.minSaleValue)rows=rows.filter(row=>Number(row.saleValue)>=Number(filters.minSaleValue));if(filters.search){const query=clean(filters.search).toLowerCase();rows=rows.filter(row=>[row.groupIdentity,row.groupNumber,row.groupName,row.parentGroupName,...row.representativeItems,...row.representativeInvoices].some(value=>clean(value).toLowerCase().includes(query)));}
  return {ok:true,fifoDatasetId,periodFrom,periodTo,...pageRows(rows,filters),catalog:{assignmentCount:maps.byGuid.size||maps.byCode.size,unresolvedLineCount:rows.filter(r=>r.groupIdentity==='UNRESOLVED').reduce((n,r)=>n+r.saleLineCount,0)},automaticApproval:false};
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
  for(const fact of facts){const assignment=assignmentFor(maps,fact);if(assignment){metrics.officialGroupLineCount++;metrics.officialGroupSaleValue=add([metrics.officialGroupSaleValue,fact.saleAmountExact||0]);}const enriched=enrichFact(fact,assignment);const approved=ledger._resolveCategoryFromMappings(mappings.filter(m=>m.status==='approved'),enriched,fact.saleDate);const projected=approved.status==='resolved'?approved:ledger._resolveCategoryFromMappings(mappings.filter(m=>['pending','draft'].includes(m.status)),enriched,fact.saleDate);if(approved.status==='resolved'&&approved.category!=='UNKNOWN'){metrics.mappedLineCount++;metrics.mappedSaleValue=add([metrics.mappedSaleValue,fact.saleAmountExact||0]);const rate=ledger._resolveRateFromRows(rates.filter(r=>r.status==='approved'),fact.sellerIdentity,approved.category,fact.saleDate);if(rate.status==='resolved')metrics.approvedRateLineCount++;else missingRates.add(`${fact.sellerIdentity}|${approved.category}`);}else{metrics.unknownCategoryLineCount++;metrics.unknownCategoryValue=add([metrics.unknownCategoryValue,fact.saleAmountExact||0]);}if(projected.status==='resolved'&&projected.category!=='UNKNOWN'){metrics.projectedMappedLineCount++;metrics.projectedMappedSaleValue=add([metrics.projectedMappedSaleValue,fact.saleAmountExact||0]);}const kind=fact.costCoverageStatus==='complete'?'complete':fact.costCoverageStatus==='partial'?'partial':'unknown';metrics[`${kind}CostLineCount`]++;metrics[`${kind}CostValue`]=add([metrics[`${kind}CostValue`],fact.saleAmountExact||0]);if(fact.invoiceDiscountAttributionStatus==='unresolved-invoice-level')metrics.unresolvedDiscountLineCount++;if(!clean(fact.sellerIdentity))metrics.unresolvedSellerLineCount++;}
  metrics.officialGroupLinePercent=pct(metrics.officialGroupLineCount,metrics.lineCount);metrics.officialGroupSaleValuePercent=pct(metrics.officialGroupSaleValue,metrics.saleValue);metrics.mappedLinePercent=pct(metrics.mappedLineCount,metrics.lineCount);metrics.mappedSaleValuePercent=pct(metrics.mappedSaleValue,metrics.saleValue);metrics.pendingMappedLineCount=Math.max(0,metrics.projectedMappedLineCount-metrics.mappedLineCount);metrics.pendingMappedSaleValue=ledger._subtract(metrics.projectedMappedSaleValue,metrics.mappedSaleValue);metrics.projectedMappedLinePercent=pct(metrics.projectedMappedLineCount,metrics.lineCount);metrics.projectedMappedSaleValuePercent=pct(metrics.projectedMappedSaleValue,metrics.saleValue);metrics.approvedRateCoveragePercent=pct(metrics.approvedRateLineCount,metrics.mappedLineCount);metrics.unknownCategoryLinePercent=pct(metrics.unknownCategoryLineCount,metrics.lineCount);metrics.unknownCategoryValuePercent=pct(metrics.unknownCategoryValue,metrics.saleValue);for(const kind of ['complete','partial','unknown']){metrics[`${kind}CostLinePercent`]=pct(metrics[`${kind}CostLineCount`],metrics.lineCount);metrics[`${kind}CostValuePercent`]=pct(metrics[`${kind}CostValue`],metrics.saleValue);}
  const openingReadiness=Object.fromEntries(POOLS.map(pool=>{const rows=openings.filter(r=>r.pool===pool&&r.entryKind==='OPENING');return[pool,{approved:rows.some(r=>r.status==='approved'),pending:rows.some(r=>r.status==='pending'),draft:rows.some(r=>r.status==='draft'),count:rows.length}];}));const blockers=[];if(metrics.mappedSaleValuePercent<policy.mappedSaleValueMinimumPercent)blockers.push({code:'MAPPED_SALE_VALUE_BELOW_THRESHOLD',actual:metrics.mappedSaleValuePercent,required:policy.mappedSaleValueMinimumPercent});if(policy.requireMappedLines&&metrics.mappedLineCount<metrics.lineCount)blockers.push({code:'UNMAPPED_LINES',count:metrics.lineCount-metrics.mappedLineCount});if(policy.requireApprovedRates&&metrics.approvedRateLineCount<metrics.mappedLineCount)blockers.push({code:'MISSING_APPROVED_RATES',count:metrics.mappedLineCount-metrics.approvedRateLineCount,identities:[...missingRates].slice(0,100)});if(policy.requireNotebookOpening&&!openingReadiness.NOTEBOOK.approved)blockers.push({code:'NOTEBOOK_OPENING_BALANCE_NOT_APPROVED'});if(policy.requireComponentOpening&&!openingReadiness.COMPONENT.approved)blockers.push({code:'COMPONENT_OPENING_BALANCE_NOT_APPROVED'});if(policy.requireCompleteCostCoverage&&(metrics.partialCostLineCount||metrics.unknownCostLineCount))blockers.push({code:'COST_COVERAGE_INCOMPLETE',partial:metrics.partialCostLineCount,unknown:metrics.unknownCostLineCount});if(policy.requireResolvedDiscounts&&metrics.unresolvedDiscountLineCount)blockers.push({code:'DISCOUNT_ATTRIBUTION_UNRESOLVED',count:metrics.unresolvedDiscountLineCount});if(policy.requireSellerIdentity&&metrics.unresolvedSellerLineCount)blockers.push({code:'SELLER_IDENTITY_UNRESOLVED',count:metrics.unresolvedSellerLineCount});
  const exceptionalRateCandidates=rates.filter(row=>row.sellerIdentity!=='*'&&['draft','pending'].includes(row.status)&&row.effectiveFrom<=periodTo&&(!row.effectiveTo||row.effectiveTo>=periodFrom)).map(row=>({rateVersionId:row.rateVersionId,sellerIdentity:row.sellerIdentity,commissionCategory:row.commissionCategory,rate:row.rate,status:row.status}));return{ok:true,fifoDatasetId,periodFrom,periodTo,policy,metrics,openingReadiness,missingRateSellers:[...missingRates],exceptionalRateCandidates,blockers,normalExportReady:blockers.length===0,diagnosticExportPayable:false,profitRoiCommissionEnabled:false};
}
async function authorizeDiagnosticExport(db,input={},requestedBy={}){const current=requireRole(requestedBy,['admin']);const ev=evidence(input);requireEvidence(ev,'DIAGNOSTIC_EXPORT_EVIDENCE_REQUIRED');const override={overrideId:newId('XOVR'),schemaVersion:1,exportMode:'diagnostic',reason:ev.reason,sourceReference:ev.sourceReference,attachmentMetadata:ev.attachmentMetadata,evidenceUnavailableReason:ev.evidenceUnavailableReason,createdBy:current,createdAt:new Date(),audited:true,payable:false};await db.collection(EXPORT_OVERRIDES).insertOne(override);return override;}

module.exports={GROUP_CATALOG,ITEM_GROUP_ASSIGNMENTS,GROUP_CATALOG_RUNS,OPENING_BALANCES,OPENING_LOCKS,EXPORT_OVERRIDES,COLLECTIONS,ensureIndexes,normalizeOfficialItem,refreshOfficialGroupCatalog,groupReviewMatrix,rateReviewMatrix,createOpeningBalance,listOpeningBalances,updateOpeningBalance,transitionOpeningBalance,readiness,authorizeDiagnosticExport,enrichFact,_assignmentMaps:assignmentMaps};
