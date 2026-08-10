'use strict';

/*
 * Phase C — Seller Financial Performance Read Model.
 *
 * This module is a rebuildable, read-only projection.  It consumes immutable
 * accounting sources and writes only its three owned projection collections
 * plus run state.  It never mutates FIFO, snapshots, purchase layers,
 * inventory, invoices, governance records or Shaygan.
 */
const crypto = require('crypto');
const { Decimal128 } = require('mongodb');
const ledger = require('./profit-commission-ledger');
const fifo = require('./fifo-shadow-engine');
const governance = require('./accounting-governance');
const policies = require('./commission-policy-governance');
const saleSnapshot = require('./sale-snapshot');
const accountingDecimal = require('./accounting-decimal');
const manualCostResolution = require('./manual-cost-resolution');
const { canonicalSaleDate } = require('./jalali-date');

const RUNS = 'sellerFinancialPerformanceRuns';
const LINES = 'sellerFinancialPerformanceLines';
const SUMMARIES = 'sellerFinancialPerformanceSummaries';
const STATE = 'sellerFinancialPerformanceState';
const LOCKS = 'sellerFinancialPerformanceLocks';
const VERIFICATIONS = 'sellerFinancialPerformanceVerificationRuns';
const SCOPE_KEY = 'seller-financial-performance-v1';
const SCHEMA_VERSION = 2;
const ALGORITHM_VERSION = 'seller-financial-performance-v2-canonical-fingerprints';
const MODULE_VERSION = 'seller-financial-performance-1.1.0';
const READ_ROLES = Object.freeze(['admin', 'accounting', 'manager', 'purchase']);
const BUILD_ROLES = Object.freeze(['admin', 'accounting']);
const COLLECTIONS = Object.freeze([RUNS, LINES, SUMMARIES, STATE, LOCKS, VERIFICATIONS]);
const MAX_PAGE_SIZE = 500;
const SHA256_HEX = /^[a-f0-9]{64}$/;

function clean(value, max = 1000) { return String(value == null ? '' : value).trim().slice(0, max); }
function actor(value = {}) { return { username:clean(value.username || value.user || 'system', 100), role:clean(value.role || 'system', 50) }; }
function fail(code, message, statusCode = 400, details = {}) { const error=new Error(message); Object.assign(error,{code,statusCode,...details}); throw error; }
function requireRole(value, allowed) { const current=actor(value); if(!allowed.includes(current.role))fail('SELLER_FINANCIAL_FORBIDDEN','دسترسی به گزارش مالی فروشندگان مجاز نیست.',403); return current; }
function sha(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function stable(value) {
  if(value instanceof Date)return JSON.stringify(value.toISOString());
  if(value && typeof value.toHexString==='function')return JSON.stringify(value.toHexString());
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function newId(prefix) { return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`; }
function exact(value, scale=2) { return ledger._exact(value,scale); }
function add(values, scale=2) { return ledger._add(values,scale); }
function subtract(left,right,scale=2) { return ledger._subtract(left,right,scale); }
function numeric(value) { return value == null || value === '' ? null : Decimal128.fromString(exact(value)); }
function date8(value, field, optional=false) { if(optional&&!clean(value))return ''; return canonicalSaleDate(value,{field}); }
function monthOf(value) { const date=clean(value,8); return /^\d{8}$/.test(date)?date.slice(0,6):''; }
function escapeRegex(value) { return clean(value,100).replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
function count(collection, query={}) { return typeof collection.countDocuments==='function'?collection.countDocuments(query):collection.find(query).toArray().then(rows=>rows.length); }
async function insertMany(collection, rows) { if(!rows.length)return 0; if(typeof collection.insertMany==='function')return Number((await collection.insertMany(rows,{ordered:true})).insertedCount||rows.length); for(const row of rows)await collection.insertOne(row); return rows.length; }
async function bulkUpsert(collection, rows, keys) {
  if(!rows.length)return;
  if(typeof collection.bulkWrite==='function'){
    await collection.bulkWrite(rows.map(row=>({updateOne:{filter:Object.fromEntries(keys.map(key=>[key,row[key]])),update:{$set:row},upsert:true}})),{ordered:false}); return;
  }
  for(const row of rows)await collection.updateOne(Object.fromEntries(keys.map(key=>[key,row[key]])),{$set:row},{upsert:true});
}

async function ensureIndexes(db) {
  const names=new Set((await db.listCollections().toArray()).map(row=>row.name));
  for(const name of COLLECTIONS)if(!names.has(name))await db.createCollection(name).catch(()=>{});
  await db.collection(RUNS).createIndex({runId:1},{unique:true});
  await db.collection(RUNS).createIndex({status:1,createdAt:-1});
  await db.collection(LINES).createIndex({runId:1,saleLineIdentity:1},{unique:true});
  await db.collection(LINES).createIndex({runId:1,saleDate:1,sellerIdentity:1});
  await db.collection(LINES).createIndex({runId:1,sellerIdentity:1,officialProductCategoryName:1,saleDate:1});
  await db.collection(LINES).createIndex({runId:1,officialProductCategoryName:1,saleDate:1});
  await db.collection(LINES).createIndex({runId:1,commissionRatePool:1,saleDate:1});
  await db.collection(LINES).createIndex({runId:1,storeIdentity:1,saleDate:1});
  await db.collection(LINES).createIndex({runId:1,saleInvoiceNumber:1});
  await db.collection(LINES).createIndex({runId:1,saleInvoiceIdentity:1});
  await db.collection(LINES).createIndex({runId:1,itemCode:1});
  await db.collection(LINES).createIndex({runId:1,costCoverageStatus:1,saleDate:1});
  await db.collection(LINES).createIndex({runId:1,discountStatus:1,saleDate:1});
  await db.collection(LINES).createIndex({runId:1,adjustmentEligibility:1,saleDate:1});
  await db.collection(LINES).createIndex({runId:1,invoiceGrossSaleAmountNumeric:1});
  await db.collection(LINES).createIndex({runId:1,grossSaleAmountNumeric:1});
  await db.collection(LINES).createIndex({runId:1,actualFifoProfitNumeric:1});
  await db.collection(LINES).createIndex({runId:1,fifoMarginNumeric:1});
  await db.collection(LINES).createIndex({runId:1,purchaseInvoiceNumbers:1});
  await db.collection(LINES).createIndex({runId:1,supplierAccountNumbers:1});
  await db.collection(LINES).createIndex({runId:1,supplierNames:1});
  await db.collection(LINES).createIndex({runId:1,commissionableProfitNumeric:1});
  await db.collection(LINES).createIndex({runId:1,preliminaryCommissionNumeric:1});
  await db.collection(LINES).createIndex({runId:1,policyAvailability:1,categoryAvailability:1,rateAvailability:1});
  await db.collection(LINES).createIndex({runId:1,hasApprovedAdjustment:1,hasSavedProfitCredit:1,hasSavedProfitSubsidy:1});
  await db.collection(SUMMARIES).createIndex({runId:1,dimension:1,dimensionKey:1},{unique:true});
  await db.collection(SUMMARIES).createIndex({runId:1,dimension:1,saleValueNumeric:-1});
  await db.collection(STATE).createIndex({scopeKey:1},{unique:true});
  await db.collection(LOCKS).createIndex({scopeKey:1},{unique:true});
  await db.collection(VERIFICATIONS).createIndex({verificationId:1},{unique:true});
  await db.collection(VERIFICATIONS).createIndex({status:1,createdAt:-1});
  return {ok:true,moduleVersion:MODULE_VERSION,collections:COLLECTIONS};
}

async function activeRun(db) {
  await ensureIndexes(db);
  const state=await db.collection(STATE).findOne({scopeKey:SCOPE_KEY});
  if(!state?.activeRunId)return null;
  const run=await db.collection(RUNS).findOne({runId:state.activeRunId,status:'completed'});
  return run?{runId:run.runId,run,state}:null;
}

function immutableSourceProjection(row) {
  const copy={...row}; for(const key of ['_id','createdAt','createdBy','updatedAt'])delete copy[key]; return copy;
}
function rowSetFingerprint(rows,project=immutableSourceProjection) {
  const hashes=rows.map(row=>sha(stable(project(row)))).sort();
  return {count:hashes.length,fingerprint:sha(stable(hashes))};
}
function canonicalLineFingerprint(rows) {
  return sha(stable(rows.map(row=>[row.saleLineIdentity,row.lineFingerprint]).sort((a,b)=>clean(a[0],500).localeCompare(clean(b[0],500)))));
}
function canonicalSummaryFingerprint(rows) {
  return sha(stable(rows.map(row=>[row.dimension,row.dimensionKey,row.summaryFingerprint]).sort((a,b)=>clean(a[0],100).localeCompare(clean(b[0],100))||clean(a[1],1000).localeCompare(clean(b[1],1000)))));
}
function fingerprintDetails(value) {
  return {raw:value??null,length:typeof value==='string'?value.length:null,encoding:'lowercase-hex',expectedAlgorithm:'SHA-256',regex:'^[a-f0-9]{64}$',valid:SHA256_HEX.test(value||'')};
}
function assertFingerprintSet(values) {
  const invalid=Object.entries(values).filter(([,value])=>!SHA256_HEX.test(value||'')).map(([field])=>field);
  if(invalid.length)fail('SELLER_FINANCIAL_FINGERPRINT_INVALID',`Fingerprint نامعتبر است: ${invalid.join(', ')}`,409,{invalid});
}
function memorySample(stage) {
  const value=process.memoryUsage();
  return {stage,at:new Date(),rssBytes:value.rss,heapTotalBytes:value.heapTotal,heapUsedBytes:value.heapUsed,externalBytes:value.external,arrayBuffersBytes:value.arrayBuffers||0};
}
async function sourceBundle(db) {
  const fifoActive=await fifo.activeDataset(db);
  if(!fifoActive?.datasetId||fifoActive.dataset?.status!=='completed')fail('SELLER_FINANCIAL_FIFO_SOURCE_MISSING','FIFO Dataset فعال و کامل پیدا نشد.',409);
  const fifoDatasetId=fifoActive.datasetId;
  const facts=await db.collection(ledger.FIFO_FACTS).find({fifoDatasetId}).sort({saleLineIdentity:1}).toArray();
  if(!facts.length)fail('SELLER_FINANCIAL_FACTS_MISSING','FIFO Profit Facts فعال پیدا نشد.',409);
  const saleSnapshotId=clean(facts[0].saleSnapshotId||fifoActive.dataset.sourceSaleSnapshotId,100);
  const [catalogMaps,approvedPolicies,rawMappings,rawRates,discountFacts,adjustments,savedEntries,headers,userMappings,users,allocations]=await Promise.all([
    governance._assignmentMaps(db),
    db.collection(policies.POLICIES).find({status:'approved'}).toArray(),
    db.collection(ledger.CATEGORY_MAPPINGS).find({status:'approved'}).toArray(),
    db.collection(ledger.RATE_VERSIONS).find({status:'approved'}).toArray(),
    db.collection(ledger.DISCOUNT_FACTS).find({saleSnapshotId}).toArray(),
    db.collection(ledger.ADJUSTMENTS).find({fifoDatasetId,status:'approved'}).toArray(),
    db.collection(ledger.SAVED_LEDGER).find({}).toArray(),
    db.collection('saleSnapshotDatasetHeaders').find({snapshotId:saleSnapshotId},{projection:{_id:0,invTyp:1,invNo:1,saleInvoiceType:1,saleInvoiceNumber:1,storeName:1,StockName:1,stockName:1,storeIdentity:1,StockNo:1,stockNumber:1,sellerAccountNumber:1,invDate:1}}).toArray(),
    db.collection('userShayganMappings').find({isActive:{$ne:false}}).toArray(),
    db.collection('users').find({isActive:{$ne:false}}).toArray(),
    db.collection(fifo.ALLOCATIONS).find({datasetId:fifoDatasetId},{projection:{_id:0,saleLineId:1,allocationId:1}}).toArray()
  ]);
  const mappings=await policies.attachPolicyBindings(db,'category_mapping',rawMappings);
  const rates=await policies.attachPolicyBindings(db,'rate_version',rawRates);
  const policyIds=new Set(approvedPolicies.map(row=>row.policyVersionId));
  const governedMappings=mappings.filter(row=>policyIds.has(row.policyVersionId));
  const governedRates=rates.filter(row=>policyIds.has(row.policyVersionId));
  const sourceProjection={
    fifoDatasetId,saleSnapshotId,catalogRunId:catalogMaps.run?.catalogRunId||'',
    fifoSourceFingerprint:fifoActive.dataset.sourceFingerprint||'',fifoAllocationFingerprint:fifoActive.dataset.allocationFingerprint||'',
    facts:rowSetFingerprint(facts,row=>[row.saleLineIdentity,row.factContentHash||sha(stable(immutableSourceProjection(row)))]),
    officialAssignments:rowSetFingerprint(catalogMaps.rows),
    policy:rowSetFingerprint(approvedPolicies),mappings:rowSetFingerprint(governedMappings),rates:rowSetFingerprint(governedRates),
    discounts:rowSetFingerprint(discountFacts,row=>[row.discountFactId,row.contentHash]),adjustments:rowSetFingerprint(adjustments,row=>[row.adjustmentId,row.revision,row.approvedAmountExact]),
    savedEntries:rowSetFingerprint(savedEntries,row=>[row.ledgerEntryId,row.contentHash]),
    saleHeaders:rowSetFingerprint(headers),sellerMappings:rowSetFingerprint(userMappings),users:rowSetFingerprint(users,row=>({username:row.username,fullName:row.fullName,role:row.role,isActive:row.isActive})),
    allocationFingerprint:fifoActive.dataset.allocationFingerprint||sha(stable(allocations.map(row=>row.allocationId).sort()))
  };
  return {fifoActive,fifoDatasetId,saleSnapshotId,facts,catalogMaps,approvedPolicies,governedMappings,governedRates,discountFacts,adjustments,savedEntries,headers,userMappings,users,allocations,sourceFingerprint:sha(stable(sourceProjection)),sourceProjection};
}

async function collectionMarker(db,name,query={},idFields=[]) {
  const collection=db.collection(name);
  const [total,latest]=await Promise.all([count(collection,query),collection.findOne(query,{sort:{updatedAt:-1,createdAt:-1,_id:-1}})]);
  const identity=Object.fromEntries(idFields.map(field=>[field,latest?.[field]??'']));
  return {count:total,latestUpdatedAt:latest?.updatedAt||latest?.approvedAt||latest?.createdAt||null,latestRevision:Number(latest?.revision||0),...identity};
}
async function fastSourceMetadata(db) {
  const fifoActive=await fifo.activeDataset(db);
  if(!fifoActive?.datasetId||fifoActive.dataset?.status!=='completed')fail('SELLER_FINANCIAL_FIFO_SOURCE_MISSING','FIFO Dataset فعال و کامل پیدا نشد.',409);
  const fifoDatasetId=fifoActive.datasetId,saleSnapshotId=clean(fifoActive.dataset.sourceSaleSnapshotId,100);
  const catalogRun=await db.collection('accountingOfficialGroupCatalogRuns').findOne({}, {sort:{fetchedAt:-1,createdAt:-1}});
  const [policy,mappings,rates,bindings,discounts,adjustments,savedEntries,headers,sellerMappings,users]=await Promise.all([
    collectionMarker(db,policies.POLICIES,{status:'approved'},['policyVersionId']),
    collectionMarker(db,ledger.CATEGORY_MAPPINGS,{status:'approved'},['mappingId','policyVersionId']),
    collectionMarker(db,ledger.RATE_VERSIONS,{status:'approved'},['rateVersionId','policyVersionId']),
    collectionMarker(db,policies.BINDINGS,{},['bindingId']),
    collectionMarker(db,ledger.DISCOUNT_FACTS,{saleSnapshotId},['discountFactId']),
    collectionMarker(db,ledger.ADJUSTMENTS,{fifoDatasetId,status:'approved'},['adjustmentId']),
    collectionMarker(db,ledger.SAVED_LEDGER,{},['ledgerEntryId']),
    collectionMarker(db,'saleSnapshotDatasetHeaders',{snapshotId:saleSnapshotId},['snapshotId']),
    collectionMarker(db,'userShayganMappings',{isActive:{$ne:false}},['username']),
    collectionMarker(db,'users',{isActive:{$ne:false}},['username'])
  ]);
  const metadata={schemaVersion:1,fifoDatasetId,saleSnapshotId,fifoSourceFingerprint:fifoActive.dataset.sourceFingerprint||'',fifoAllocationFingerprint:fifoActive.dataset.allocationFingerprint||'',catalogRunId:catalogRun?.catalogRunId||'',catalogFetchedAt:catalogRun?.fetchedAt||catalogRun?.createdAt||null,policy,mappings,rates,bindings,discounts,adjustments,savedEntries,headers,sellerMappings,users};
  return {metadata,fingerprint:sha(stable(metadata))};
}
async function snapshotMetrics(db,snapshotId) {
  const id=clean(snapshotId,100);if(!id)return {snapshotId:'',invoiceCount:0,lineCount:0,newestSaleDate:'',saleValueExact:'0.00'};
  const lineQuery={snapshotId:id,saleInvoiceType:2};
  const [invoiceCount,lineCount,newest,totalRows]=await Promise.all([
    count(db.collection('saleSnapshotDatasetHeaders'),{snapshotId:id,invTyp:2}),
    count(db.collection('saleSnapshotDatasetLines'),lineQuery),
    db.collection('saleSnapshotDatasetLines').findOne(lineQuery,{sort:{saleDate:-1,saleInvoiceNo:-1,row:-1}}),
    db.collection('saleSnapshotDatasetLines').aggregate([{$match:lineQuery},{$group:{_id:null,saleValue:{$sum:'$saleValue'}}}]).toArray()
  ]);
  return {snapshotId:id,invoiceCount,lineCount,newestSaleDate:clean(newest?.saleDate,8),saleValueExact:exact(totalRows[0]?.saleValue||0)};
}
async function sourceRecency(db,fifoSnapshotId) {
  const latest=await saleSnapshot._activeDataset(db);
  const [financial,sales]=await Promise.all([snapshotMetrics(db,fifoSnapshotId),snapshotMetrics(db,latest?.snapshotId)]);
  return {fifoLinkedSaleSnapshotId:financial.snapshotId,latestLiveSaleSnapshotId:sales.snapshotId,financialDataThrough:financial.newestSaleDate,salesDataThrough:sales.newestSaleDate,financial,sales,gap:{invoiceCount:sales.invoiceCount-financial.invoiceCount,lineCount:sales.lineCount-financial.lineCount,saleValueExact:subtract(sales.saleValueExact,financial.saleValueExact)},newerSalesExcludedFromFifoProfit:financial.snapshotId!==sales.snapshotId};
}

function applicablePolicy(rows,date) {
  const matches=rows.filter(row=>row.effectiveFrom<=date&&(!row.effectiveTo||row.effectiveTo>=date));
  matches.sort((a,b)=>clean(b.effectiveFrom).localeCompare(clean(a.effectiveFrom))||clean(b.policyVersionId).localeCompare(clean(a.policyVersionId)));
  return matches.length===1?{status:'resolved',policy:matches[0]}:matches.length>1?{status:'ambiguous',policy:null}:{status:'missing',policy:null};
}
function adjustmentEffect(row) {
  const amount=row.approvedAmountExact||'0.00';
  if(row.adjustmentType==='saved_profit_credit'||row.adjustmentType==='invoice_discount')return subtract('0.00',amount);
  if(['saved_profit_subsidy','accounting_correction','management_adjustment'].includes(row.adjustmentType))return exact(amount);
  return '0.00';
}
function sourceActorMap(userMappings,users) {
  const userByName=new Map(users.map(row=>[clean(row.username,100),row])); const output=new Map();
  for(const mapping of userMappings){const identity=clean(mapping.employeeAccountNumber||mapping.sellerAccountNumber,100);if(!identity)continue;const user=userByName.get(clean(mapping.username,100));output.set(identity,{username:clean(mapping.username,100),displayName:clean(user?.fullName||mapping.fullName,200),storeName:clean(mapping.storeName,200),storeIdentity:clean(mapping.storeNumber||mapping.storeName,200)});}
  return output;
}
function headerMaps(headers) {
  return new Map(headers.map(row=>[`${Number(row.invTyp??row.saleInvoiceType)}:${Number(row.invNo??row.saleInvoiceNumber)}`,row]));
}
function lineAvailability(blockers) { return blockers.length?'unavailable':'available'; }
function sumLineEntries(entries, field) { return add(entries.map(row=>row[field]||0)); }
function discountState(fact,invoiceDiscount) {
  const lineDiscount=fact.invoiceDiscountExact==null?null:Number(fact.invoiceDiscountExact);
  if(Number.isFinite(lineDiscount)&&lineDiscount>0)return 'official_line_discount';
  if(!invoiceDiscount||invoiceDiscount.sourceField==='missing'||invoiceDiscount.invoiceDiscountExact==null)return 'source_unavailable';
  const categoryStatus=clean(invoiceDiscount.categoryAttributionStatus,100).toLowerCase();
  const allocationStatus=clean(invoiceDiscount.allocationStatus,100).toLowerCase();
  if(['conflict','source-conflict','mismatch'].some(value=>categoryStatus.includes(value)||allocationStatus.includes(value)))return 'source_conflict';
  if(allocationStatus==='completed'||invoiceDiscount.allocatedInvoiceDiscountExact!=null)return 'allocation_completed';
  const invoiceValue=Number(invoiceDiscount.invoiceDiscountExact);
  if(Number.isFinite(invoiceValue)&&invoiceValue===0)return 'official_zero_discount';
  if(Number.isFinite(invoiceValue)&&invoiceValue>0&&categoryStatus==='resolved-single-category')return 'official_nonzero_invoice_discount';
  if(Number.isFinite(invoiceValue)&&invoiceValue>0)return 'allocation_unresolved';
  return 'source_unavailable';
}

function buildProjectedLines(bundle,runId,calculatedAt) {
  const assignmentByGuid=bundle.catalogMaps.byGuid,assignmentByCode=bundle.catalogMaps.byCode;
  const discounts=new Map(bundle.discountFacts.map(row=>[row.saleInvoiceIdentity,row]));
  const adjustmentsByLine=new Map(); for(const row of bundle.adjustments){if(!adjustmentsByLine.has(row.saleLineIdentity))adjustmentsByLine.set(row.saleLineIdentity,[]);adjustmentsByLine.get(row.saleLineIdentity).push(row);}
  const savedSource=new Map(),savedBeneficiary=new Map();
  for(const row of bundle.savedEntries){if(row.sourceSaleLineIdentity){if(!savedSource.has(row.sourceSaleLineIdentity))savedSource.set(row.sourceSaleLineIdentity,[]);savedSource.get(row.sourceSaleLineIdentity).push(row);}if(row.beneficiarySaleLineIdentity){if(!savedBeneficiary.has(row.beneficiarySaleLineIdentity))savedBeneficiary.set(row.beneficiarySaleLineIdentity,[]);savedBeneficiary.get(row.beneficiarySaleLineIdentity).push(row);}}
  const invoiceFacts=new Map();for(const fact of bundle.facts){if(!invoiceFacts.has(fact.saleInvoiceIdentity))invoiceFacts.set(fact.saleInvoiceIdentity,[]);invoiceFacts.get(fact.saleInvoiceIdentity).push(fact);}
  const allocationsByLine=new Map();for(const row of bundle.allocations){if(!allocationsByLine.has(row.saleLineId))allocationsByLine.set(row.saleLineId,[]);allocationsByLine.get(row.saleLineId).push(row);}
  const headerByInvoice=headerMaps(bundle.headers),sellerActors=sourceActorMap(bundle.userMappings,bundle.users);
  const lines=[];
  for(const fact of bundle.facts){
    const blockers=[];const warningFlags=[];const assignment=assignmentByGuid.get(clean(fact.itemGuid,100))||assignmentByCode.get(clean(fact.itemCode,100));
    const enriched=governance.enrichFact(fact,assignment);const policyState=applicablePolicy(bundle.approvedPolicies,fact.saleDate);const policy=policyState.policy;
    if(policyState.status!=='resolved')blockers.push(`policy-${policyState.status}`);
    const policyMappings=policy?bundle.governedMappings.filter(row=>row.policyVersionId===policy.policyVersionId):[];
    const classification=ledger._resolveCategoryFromMappings(policyMappings,enriched,fact.saleDate);
    if(!classification.officialProductCategoryIdentity)blockers.push('official-product-category-missing');
    if(classification.status!=='resolved'||classification.commissionRatePool==='UNRESOLVED')blockers.push(`category-${classification.status||'unresolved'}`);
    const rateClassification={...classification,policyVersionId:policy?.policyVersionId||''};
    const rate=ledger._resolveRateFromRows(policy?bundle.governedRates.filter(row=>row.policyVersionId===policy.policyVersionId):[],fact.sellerIdentity,rateClassification,fact.saleDate);
    if(rate.status!=='resolved')blockers.push(`rate-${rate.status}`);
    if(fact.costCoverageStatus!=='complete'||fact.actualFifoProfitExact==null)blockers.push(`cost-${fact.costCoverageStatus||'unknown'}`);
    const invoiceDiscount=discounts.get(fact.saleInvoiceIdentity);const discountStatus=discountState(fact,invoiceDiscount);let allocatedInvoiceDiscountExact=null;let discountAvailability='unavailable';
    if(discountStatus==='official_zero_discount'){allocatedInvoiceDiscountExact='0.00';discountAvailability='available';}
    else if(discountStatus==='allocation_completed'){allocatedInvoiceDiscountExact=exact(invoiceDiscount.allocatedInvoiceDiscountExact||0);discountAvailability='available';}
    else if(discountStatus==='official_line_discount'){allocatedInvoiceDiscountExact=Number(invoiceDiscount?.invoiceDiscountExact||0)===0?'0.00':null;if(allocatedInvoiceDiscountExact!=null)discountAvailability='available';else blockers.push('invoice-discount-allocation-not-materialized');}
    else if(discountStatus==='official_nonzero_invoice_discount'){blockers.push('invoice-discount-allocation-not-materialized');warningFlags.push('invoice-discount-present');}
    else if(discountStatus==='allocation_unresolved')blockers.push('invoice-discount-unresolved');
    else if(discountStatus==='source_conflict')blockers.push('invoice-discount-source-conflict');
    else blockers.push('invoice-discount-fact-missing');
    const lineDiscountExact=fact.invoiceDiscountExact==null?null:exact(fact.invoiceDiscountExact);
    if(lineDiscountExact==null)blockers.push('line-discount-unavailable');
    const grossSaleAmountExact=exact(fact.saleAmountExact||0);const netSaleAmountExact=lineDiscountExact!=null&&allocatedInvoiceDiscountExact!=null?subtract(subtract(grossSaleAmountExact,lineDiscountExact),allocatedInvoiceDiscountExact):null;
    const lineAdjustments=adjustmentsByLine.get(fact.saleLineIdentity)||[];const adjustmentEffects=lineAdjustments.map(adjustmentEffect);const approvedAdjustmentAmountExact=add(adjustmentEffects);
    const savedCredits=savedSource.get(fact.saleLineIdentity)||[];const savedSubsidies=savedBeneficiary.get(fact.saleLineIdentity)||[];
    const savedProfitCreditExact=add(savedCredits.map(row=>row.creditAmountExact||0));const savedProfitSubsidyExact=add(savedSubsidies.map(row=>row.debitAmountExact||0));
    const commissionableProfitExact=fact.actualFifoProfitExact==null?null:add([fact.actualFifoProfitExact,approvedAdjustmentAmountExact]);
    const preliminaryCommissionExact=commissionableProfitExact!=null&&rate.status==='resolved'&&!blockers.length?ledger._multiplyMoneyRate(commissionableProfitExact,rate.rateVersion.rate):null;
    const header=headerByInvoice.get(fact.saleInvoiceIdentity)||{};const sellerActor=sellerActors.get(clean(fact.sellerIdentity,100))||{};
    const invoiceRows=invoiceFacts.get(fact.saleInvoiceIdentity)||[];const invoiceGrossSaleAmountExact=add(invoiceRows.map(row=>row.saleAmountExact||0));
    const storeName=clean(header.storeName||header.StockName||header.stockName||sellerActor.storeName,200);const storeIdentity=clean(header.storeIdentity||header.StockNo||header.stockNumber||sellerActor.storeIdentity||storeName,200);
    const policyAvailability=policyState.status==='resolved'?'available':'unavailable';const categoryAvailability=classification.status==='resolved'&&classification.commissionRatePool!=='UNRESOLVED'?'available':'unavailable';const rateAvailability=rate.status==='resolved'?'available':'unavailable';const profitAvailability=fact.actualFifoProfitExact!=null&&fact.costCoverageStatus==='complete'?'available':'unavailable';const commissionAvailability=preliminaryCommissionExact!=null&&!blockers.length?'available':'unavailable';
    const adjustmentBlockers=[];
    if(fact.costCoverageStatus!=='complete'||fact.actualFifoProfitExact==null)adjustmentBlockers.push(`cost-${fact.costCoverageStatus||'unknown'}`);
    if(policyAvailability!=='available')adjustmentBlockers.push(`policy-${policyState.status}`);
    if(categoryAvailability!=='available')adjustmentBlockers.push(`category-${classification.status||'unresolved'}`);
    if(rateAvailability!=='available')adjustmentBlockers.push(`rate-${rate.status}`);
    if(fact.fifoDatasetId!==bundle.fifoDatasetId||!clean(fact.saleLineIdentity,500))adjustmentBlockers.push('line-not-in-active-fifo-backed-run');
    const lineAllocations=allocationsByLine.get(fact.saleLineIdentity)||[];
    const marginExact=fact.actualFifoProfitExact!=null&&accountingDecimal.parse(grossSaleAmountExact,accountingDecimal.MONEY_SCALE)!==0n
      ? accountingDecimal.format(accountingDecimal.divideRounded(accountingDecimal.parse(fact.actualFifoProfitExact,accountingDecimal.MONEY_SCALE)*100000000n,accountingDecimal.parse(grossSaleAmountExact,accountingDecimal.MONEY_SCALE)),8)
      : null;
    const core={
      runId,schemaVersion:SCHEMA_VERSION,algorithmVersion:ALGORITHM_VERSION,sourceFingerprint:bundle.sourceFingerprint,
      fifoDatasetId:bundle.fifoDatasetId,saleSnapshotId:bundle.saleSnapshotId,officialCatalogRunId:bundle.catalogMaps.run?.catalogRunId||'',
      saleLineIdentity:fact.saleLineIdentity,saleInvoiceIdentity:fact.saleInvoiceIdentity,saleInvoiceType:Number(fact.saleInvoiceType),saleInvoiceNumber:Number(fact.saleInvoiceNumber),saleInvoiceNo:Number(fact.saleInvoiceNumber),saleDate:fact.saleDate,saleDateJalali:fact.saleDate,saleDateRaw:clean(fact.saleDateRaw||fact.saleDate,100),accountingMonth:monthOf(fact.saleDate),
      sellerIdentity:clean(fact.sellerIdentity,100),sellerName:clean(fact.sellerName||sellerActor.displayName,200),sellerDisplayName:clean(fact.sellerName||sellerActor.displayName,200),sellerUsername:sellerActor.username||'',storeIdentity,storeName,
      itemGuid:clean(fact.itemGuid,100),itemCode:clean(fact.itemCode,100),itemDescription:clean(fact.itemDescription,500),quantityExact:exact(fact.quantityExact||0,6),
      officialMainGroupGuid:classification.officialProductCategoryGuid||'',officialProductCategoryIdentity:classification.officialProductCategoryIdentity||'',officialProductCategoryGuid:classification.officialProductCategoryGuid||'',officialProductCategoryNumber:classification.officialProductCategoryNumber||'',officialProductCategoryName:classification.officialProductCategoryName||'UNRESOLVED',
      commissionRatePool:classification.commissionRatePool||'UNRESOLVED',categoryMappingId:classification.mappingId||'',categoryResolutionStatus:classification.status,categoryStatus:classification.status,
      policyVersionId:policy?.policyVersionId||'',policyContentHash:policy?.contentHash||sha(stable({policyVersionId:policy?.policyVersionId||'',effectiveFrom:policy?.effectiveFrom||'',effectiveTo:policy?.effectiveTo||''})),policyResolutionStatus:policyState.status,policyAvailability,categoryMappingContentHash:classification.mappingContentHash||'',rateVersionId:rate.rateVersion?.rateVersionId||'',rateContentHash:rate.rateContentHash||rate.rateVersion?.contentHash||'',governanceSourceFingerprint:sha(stable({policyContentHash:policy?.contentHash||'',mappingContentHash:classification.mappingContentHash||'',rateContentHash:rate.rateContentHash||''})),rateExact:rate.rateVersion?.rate||null,commissionRateExact:rate.rateVersion?.rate||null,appliedRateScope:rate.appliedRateScope||'',rateResolutionScope:rate.appliedRateScope||'',rateResolutionPrecedence:rate.precedence||'',rateResolutionStatus:rate.status,rateStatus:rate.status,categoryAvailability,rateAvailability,
      grossSaleAmountExact,lineDiscountExact,invoiceDiscountFactId:invoiceDiscount?.discountFactId||'',invoiceDiscountExact:invoiceDiscount?.invoiceDiscountExact??null,allocatedInvoiceDiscountExact,discountAvailability,discountStatus,netSaleAmountExact,
      fifoCostExact:fact.fifoCostExact==null?null:exact(fact.fifoCostExact),actualFifoProfitExact:fact.actualFifoProfitExact==null?null:exact(fact.actualFifoProfitExact),fifoMarginExact:marginExact,costCoverageStatus:fact.costCoverageStatus||'unknown',profitAvailability,
      approvedAdjustmentAmountExact,approvedAdjustmentIds:lineAdjustments.map(row=>row.adjustmentId).sort(),adjustmentIds:lineAdjustments.map(row=>row.adjustmentId).sort(),hasApprovedAdjustment:lineAdjustments.length>0,savedProfitCreditExact,savedProfitSubsidyExact,savedProfitLedgerEntryIds:[...savedCredits,...savedSubsidies].map(row=>row.ledgerEntryId).sort(),ledgerEntryIds:[...savedCredits,...savedSubsidies].map(row=>row.ledgerEntryId).sort(),hasSavedProfitCredit:savedCredits.length>0,hasSavedProfitSubsidy:savedSubsidies.length>0,
      commissionableProfitExact,preliminaryCommissionExact,draftCommissionExact:preliminaryCommissionExact,commissionStatus:lineAvailability(blockers),commissionAvailability,blockers:[...new Set(blockers)],warningFlags:[...new Set(warningFlags)],adjustmentEligibility:adjustmentBlockers.length?'ineligible':'eligible_candidate',adjustmentBlockers:[...new Set(adjustmentBlockers)],
      discountFactId:invoiceDiscount?.discountFactId||'',allocationIds:lineAllocations.map(row=>row.allocationId).filter(Boolean).sort(),
      purchaseInvoiceNumbers:[...new Set(lineAllocations.map(row=>Number(row.purchaseInvoiceNo||0)).filter(Boolean))].sort((a,b)=>a-b),
      supplierAccountNumbers:[...new Set(lineAllocations.map(row=>clean(row.supplierAccountNumber,100)).filter(Boolean))].sort(),
      supplierNames:[...new Set(lineAllocations.map(row=>clean(row.supplierName,200)).filter(Boolean))].sort(),
      manualResolutionIds:[...new Set(lineAllocations.map(row=>clean(row.manualResolutionId,100)).filter(Boolean))].sort(),
      invoiceGrossSaleAmountExact,calculatedAt,nonPayable:true,sellerFacing:false,immutableSource:true
    };
    const numericFields=['quantityExact','grossSaleAmountExact','lineDiscountExact','invoiceDiscountExact','allocatedInvoiceDiscountExact','netSaleAmountExact','fifoCostExact','actualFifoProfitExact','fifoMarginExact','approvedAdjustmentAmountExact','savedProfitCreditExact','savedProfitSubsidyExact','commissionableProfitExact','preliminaryCommissionExact','invoiceGrossSaleAmountExact'];
    for(const field of numericFields)core[field.replace(/Exact$/,'Numeric')]=numeric(core[field]);
    core.lineFingerprint=sha(stable({...core,runId:undefined,calculatedAt:undefined}));
    core.lineId=`SFPL-${sha(`${runId}|${fact.saleLineIdentity}`).slice(0,24)}`;lines.push(core);
  }
  return lines;
}

function createSummary(runId,dimension,dimensionKey,labels,rows,calculatedAt) {
  const knownProfit=rows.filter(row=>row.actualFifoProfitExact!=null);const knownCommissionable=rows.filter(row=>row.commissionableProfitExact!=null);const knownCommission=rows.filter(row=>row.preliminaryCommissionExact!=null);
  const blockerCounts={};for(const row of rows)for(const blocker of row.blockers||[])blockerCounts[blocker]=(blockerCounts[blocker]||0)+1;
  const summary={summaryId:`SFPS-${sha(`${runId}|${dimension}|${dimensionKey}`).slice(0,24)}`,runId,schemaVersion:SCHEMA_VERSION,dimension,dimensionKey,...labels,
    lineCount:rows.length,invoiceCount:new Set(rows.map(row=>row.saleInvoiceIdentity)).size,saleQuantityExact:add(rows.map(row=>row.quantityExact),6),saleValueExact:sumLineEntries(rows,'grossSaleAmountExact'),lineDiscountExact:sumLineEntries(rows.filter(row=>row.lineDiscountExact!=null),'lineDiscountExact'),allocatedInvoiceDiscountExact:rows.every(row=>row.allocatedInvoiceDiscountExact!=null)?sumLineEntries(rows,'allocatedInvoiceDiscountExact'):null,netSaleValueExact:rows.some(row=>row.netSaleAmountExact!=null)?sumLineEntries(rows.filter(row=>row.netSaleAmountExact!=null),'netSaleAmountExact'):null,
    saleReturnQuantityExact:add(rows.filter(row=>row.saleInvoiceType===6).map(row=>row.quantityExact),6),saleReturnValueExact:sumLineEntries(rows.filter(row=>row.saleInvoiceType===6),'grossSaleAmountExact'),knownFifoCostExact:rows.some(row=>row.fifoCostExact!=null)?sumLineEntries(rows.filter(row=>row.fifoCostExact!=null),'fifoCostExact'):null,
    knownFifoProfitExact:knownProfit.length?sumLineEntries(knownProfit,'actualFifoProfitExact'):null,unknownCostSaleValueExact:sumLineEntries(rows.filter(row=>row.costCoverageStatus!=='complete'),'grossSaleAmountExact'),unavailableProfitSaleValueExact:sumLineEntries(rows.filter(row=>row.profitAvailability!=='available'),'grossSaleAmountExact'),unavailableCommissionSaleValueExact:sumLineEntries(rows.filter(row=>row.commissionAvailability!=='available'),'grossSaleAmountExact'),
    approvedAdjustmentAmountExact:sumLineEntries(rows,'approvedAdjustmentAmountExact'),savedProfitCreditExact:sumLineEntries(rows,'savedProfitCreditExact'),savedProfitSubsidyExact:sumLineEntries(rows,'savedProfitSubsidyExact'),
    commissionableProfitExact:knownCommissionable.length?sumLineEntries(knownCommissionable,'commissionableProfitExact'):null,preliminaryCommissionExact:knownCommission.length?sumLineEntries(knownCommission,'preliminaryCommissionExact'):null,
    knownProfitLineCount:knownProfit.length,availableCommissionLineCount:knownCommission.length,unavailableLineCount:rows.filter(row=>row.blockers?.length).length,unavailableCommissionLineCount:rows.length-knownCommission.length,partialCostLineCount:rows.filter(row=>row.costCoverageStatus==='partial').length,unknownCostLineCount:rows.filter(row=>row.costCoverageStatus==='unknown').length,profitCoveragePercent:Number((knownProfit.length*100/Math.max(1,rows.length)).toFixed(4)),commissionCoveragePercent:Number((knownCommission.length*100/Math.max(1,rows.length)).toFixed(4)),blockerCounts,calculatedAt,nonPayable:true};
  for(const field of ['saleValueExact','lineDiscountExact','allocatedInvoiceDiscountExact','netSaleValueExact','saleReturnValueExact','knownFifoCostExact','knownFifoProfitExact','unknownCostSaleValueExact','unavailableProfitSaleValueExact','unavailableCommissionSaleValueExact','approvedAdjustmentAmountExact','savedProfitCreditExact','savedProfitSubsidyExact','commissionableProfitExact','preliminaryCommissionExact'])summary[field.replace(/Exact$/,'Numeric')]=numeric(summary[field]);
  summary.summaryFingerprint=sha(stable({...summary,runId:undefined,summaryId:undefined,calculatedAt:undefined}));return summary;
}
function buildSummaries(lines,runId,calculatedAt) {
  const dimensions=[
    ['seller-month',row=>`${row.sellerIdentity}|${row.accountingMonth}`,row=>({sellerIdentity:row.sellerIdentity,sellerName:row.sellerName,accountingMonth:row.accountingMonth})],
    ['seller-category-month',row=>`${row.sellerIdentity}|${row.officialProductCategoryIdentity}|${row.accountingMonth}`,row=>({sellerIdentity:row.sellerIdentity,sellerName:row.sellerName,officialProductCategoryIdentity:row.officialProductCategoryIdentity,officialProductCategoryName:row.officialProductCategoryName,accountingMonth:row.accountingMonth})],
    ['seller-rate-pool-month',row=>`${row.sellerIdentity}|${row.commissionRatePool}|${row.accountingMonth}`,row=>({sellerIdentity:row.sellerIdentity,sellerName:row.sellerName,commissionRatePool:row.commissionRatePool,accountingMonth:row.accountingMonth})],
    ['seller-store-month',row=>`${row.sellerIdentity}|${row.storeIdentity}|${row.accountingMonth}`,row=>({sellerIdentity:row.sellerIdentity,sellerName:row.sellerName,storeIdentity:row.storeIdentity,storeName:row.storeName,accountingMonth:row.accountingMonth})],
    ['invoice',row=>row.saleInvoiceIdentity,row=>({saleInvoiceIdentity:row.saleInvoiceIdentity,saleInvoiceType:row.saleInvoiceType,saleInvoiceNumber:row.saleInvoiceNumber,saleDate:row.saleDate,sellerIdentity:row.sellerIdentity,sellerName:row.sellerName})],
    ['cost-status',row=>`${row.costCoverageStatus}|${row.accountingMonth}`,row=>({costCoverageStatus:row.costCoverageStatus,accountingMonth:row.accountingMonth})]
  ];
  const output=[];for(const [dimension,keyOf,labelOf] of dimensions){const grouped=new Map();for(const row of lines){const key=keyOf(row);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(row);}for(const [key,rows] of grouped)output.push(createSummary(runId,dimension,key,labelOf(rows[0]),rows,calculatedAt));}return output;
}

async function acquireLock(db,runId) {
  const now=new Date(),expiresAt=new Date(now.getTime()+10*60*1000);const collection=db.collection(LOCKS);const existing=await collection.findOne({scopeKey:SCOPE_KEY});
  if(existing?.owner&&new Date(existing.expiresAt||0)>now)fail('SELLER_FINANCIAL_BUILD_LOCKED','ساخت Read Model دیگری در حال اجراست.',409,{activeRunId:existing.runId||''});
  try{const result=await collection.updateOne({scopeKey:SCOPE_KEY,$or:[{owner:''},{expiresAt:{$lte:now}},{owner:runId}]},{$set:{scopeKey:SCOPE_KEY,owner:runId,runId,expiresAt,updatedAt:now},$setOnInsert:{createdAt:now}},{upsert:true});if(!(result.matchedCount||result.upsertedCount))fail('SELLER_FINANCIAL_BUILD_LOCKED','ساخت Read Model دیگری در حال اجراست.',409);return {collection,runId};}catch(error){if(error?.code===11000)fail('SELLER_FINANCIAL_BUILD_LOCKED','ساخت Read Model دیگری در حال اجراست.',409);throw error;}
}
async function releaseLock(lock) { if(lock)await lock.collection.updateOne({scopeKey:SCOPE_KEY,owner:lock.runId},{$set:{owner:'',expiresAt:new Date(0),updatedAt:new Date()}}).catch(()=>{}); }
function progress(control,phase,current,total,message) { control?.checkCancellation?.();control?.heartbeat?.();control?.progress?.({phase,current,total,percent:total?current/total*100:0,message}); }
async function writeBatches(db,runId,lines,options={}) {
  const batchSize=Math.max(50,Math.min(Number(options.batchSize||500),1000));const maxAttempts=Math.max(1,Math.min(Number(options.maxAttempts||3),5));let written=0,retryCount=0;const attempts=[];
  for(let offset=0;offset<lines.length;offset+=batchSize){const batch=lines.slice(offset,offset+batchSize);let complete=false;for(let attempt=1;attempt<=maxAttempts&&!complete;attempt++){const started=Date.now();try{await bulkUpsert(db.collection(LINES),batch,['runId','saleLineIdentity']);attempts.push({offset,count:batch.length,attempt,ok:true,durationMs:Date.now()-started});complete=true;}catch(error){retryCount++;attempts.push({offset,count:batch.length,attempt,ok:false,durationMs:Date.now()-started,error:clean(error.message,500)});if(attempt===maxAttempts)throw error;}}written+=batch.length;progress(options.jobControl,'Writing Seller Financial Lines',written,lines.length,`${written}/${lines.length}`);await db.collection(RUNS).updateOne({runId},{$set:{'checkpoint.linesWritten':written,'checkpoint.lastSaleLineIdentity':batch.at(-1)?.saleLineIdentity||'',retryCount,updatedAt:new Date()}});}
  return {written,retryCount,attempts};
}

async function buildReadModel(db,input={},requestedBy={}) {
  const current=requireRole(requestedBy,BUILD_ROLES);await ensureIndexes(db);const runId=clean(input.runId,100)||newId('SFPR');let lock=null;const memorySamples=[memorySample('before-rebuild')];
  try{
    lock=await acquireLock(db,runId);progress(input.jobControl,'Reading Immutable Sources',0,1,'Reading approved source datasets');const bundle=await sourceBundle(db);memorySamples.push(memorySample('after-source-read'));
    const [fastMetadata,recency]=await Promise.all([fastSourceMetadata(db),sourceRecency(db,bundle.saleSnapshotId)]);
    const requestedMode=clean(input.mode||'full',30).toLowerCase();const currentBeforeBuild=await activeRun(db);if(requestedMode==='incremental'&&currentBeforeBuild?.run?.sourceFingerprint===bundle.sourceFingerprint)return {ok:true,runId:currentBeforeBuild.runId,lineCount:Number(currentBeforeBuild.run.lineCount||0),summaryCount:Number(currentBeforeBuild.run.summaryCount||0),retryCount:0,resumeCount:Number(currentBeforeBuild.run.resumeCount||0),sourceFingerprint:bundle.sourceFingerprint,resultFingerprint:currentBeforeBuild.run.resultFingerprint,active:true,duplicate:true,buildMode:'incremental-no-source-change',nonPayable:true};
    let run=await db.collection(RUNS).findOne({runId});const now=new Date();let resumeCount=0;
    if(run){if(!['building','failed'].includes(run.status))fail('SELLER_FINANCIAL_RUN_IMMUTABLE','فقط Run ناقص یا ناموفق قابل Resume است.',409);if(run.sourceFingerprint&&run.sourceFingerprint!==bundle.sourceFingerprint)fail('SELLER_FINANCIAL_SOURCE_CHANGED','منابع از زمان Run قبلی تغییر کرده‌اند؛ Resume مجاز نیست.',409);resumeCount=Number(run.resumeCount||0)+1;await db.collection(RUNS).updateOne({runId},{$set:{status:'building',sourceFingerprint:bundle.sourceFingerprint,fastSourceMetadata:fastMetadata.metadata,fastSourceMetadataFingerprint:fastMetadata.fingerprint,sourceRecency:recency,resumeCount,updatedAt:now,lastError:''}});}else{const policyIds=bundle.approvedPolicies.map(row=>row.policyVersionId).sort();run={runId,schemaVersion:SCHEMA_VERSION,algorithmVersion:ALGORITHM_VERSION,moduleVersion:MODULE_VERSION,buildMode:requestedMode==='incremental'?'incremental-safe-full-rebuild':'full',status:'building',active:false,activationStatus:'candidate',sourceFingerprint:bundle.sourceFingerprint,fastSourceMetadata:fastMetadata.metadata,fastSourceMetadataFingerprint:fastMetadata.fingerprint,sourceRecency:recency,sourceFifoDatasetId:bundle.fifoDatasetId,sourceSaleSnapshotId:bundle.saleSnapshotId,sourcePolicyVersionId:policyIds.length===1?policyIds[0]:'',sourcePolicyVersionIds:policyIds,sourceCategoryCatalogRunId:bundle.catalogMaps.run?.catalogRunId||'',sourceCatalogRunId:bundle.catalogMaps.run?.catalogRunId||'',sourceDiscountVersion:1,sourceDiscountFingerprint:bundle.sourceProjection.discounts.fingerprint,sourceAdjustmentFingerprint:bundle.sourceProjection.adjustments.fingerprint,sourceLedgerFingerprint:bundle.sourceProjection.savedEntries.fingerprint,sourceSellerMappingFingerprint:bundle.sourceProjection.sellerMappings.fingerprint,checkpoint:{linesWritten:0,lastSaleLineIdentity:''},retryCount:0,resumeCount:0,createdBy:current,startedAt:now,createdAt:now,updatedAt:now,diagnostics:[],immutable:true,nonPayable:true,sellerFacing:false};await db.collection(RUNS).insertOne(run);}
    progress(input.jobControl,'Projecting Seller Financial Lines',0,bundle.facts.length,'Resolving governed financial dimensions');const calculatedAt=new Date();const lines=buildProjectedLines(bundle,runId,calculatedAt);memorySamples.push(memorySample('after-line-projection'));
    progress(input.jobControl,'Writing Seller Financial Lines',0,lines.length,'Writing isolated candidate rows');const write=await writeBatches(db,runId,lines,input);
    memorySamples.push(memorySample('after-line-write'));progress(input.jobControl,'Building Summaries',0,1,'Building deterministic summary dimensions');const summaries=buildSummaries(lines,runId,calculatedAt);await db.collection(SUMMARIES).deleteMany({runId});await insertMany(db.collection(SUMMARIES),summaries);memorySamples.push(memorySample('after-summary-write'));
    const lineFingerprint=canonicalLineFingerprint(lines),summaryFingerprint=canonicalSummaryFingerprint(summaries);const resultFingerprint=sha(stable({lineFingerprint,summaryFingerprint}));assertFingerprintSet({sourceFingerprint:bundle.sourceFingerprint,lineFingerprint,summaryFingerprint,resultFingerprint});
    const [storedLines,storedSummaries]=await Promise.all([db.collection(LINES).find({runId},{projection:{_id:0,saleLineIdentity:1,lineFingerprint:1}}).toArray(),db.collection(SUMMARIES).find({runId},{projection:{_id:0,dimension:1,dimensionKey:1,summaryFingerprint:1}}).toArray()]);
    const replayLineFingerprint=canonicalLineFingerprint(storedLines),replaySummaryFingerprint=canonicalSummaryFingerprint(storedSummaries),replayResultFingerprint=sha(stable({lineFingerprint:replayLineFingerprint,summaryFingerprint:replaySummaryFingerprint}));
    if(replayLineFingerprint!==lineFingerprint||replaySummaryFingerprint!==summaryFingerprint||replayResultFingerprint!==resultFingerprint)fail('SELLER_FINANCIAL_FINGERPRINT_REPLAY_FAILED','Fingerprint ذخیره‌شده پس از replay یکسان نیست.',409,{lineMatch:replayLineFingerprint===lineFingerprint,summaryMatch:replaySummaryFingerprint===summaryFingerprint,resultMatch:replayResultFingerprint===resultFingerprint});
    const validation={valid:true,expectedLineCount:bundle.facts.length,lineCount:lines.length,uniqueLineCount:new Set(lines.map(row=>row.saleLineIdentity)).size,summaryCount:summaries.length,duplicateLineCount:lines.length-new Set(lines.map(row=>row.saleLineIdentity)).size,sourceFingerprint:bundle.sourceFingerprint,resultFingerprint};
    if(!validation.valid||validation.duplicateLineCount)fail('SELLER_FINANCIAL_VALIDATION_FAILED','اعتبارسنجی Candidate ناموفق بود.',409,{validation});
    const previous=await activeRun(db);const completedAt=new Date();memorySamples.push(memorySample('immediately-after-rebuild'));const peakRssBytes=Math.max(...memorySamples.map(row=>row.rssBytes));await db.collection(RUNS).updateOne({runId},{$set:{status:'completed',activationStatus:'validated-candidate',lineCount:lines.length,summaryCount:summaries.length,availableCommissionLineCount:lines.filter(row=>row.commissionStatus==='available').length,unavailableCommissionLineCount:lines.filter(row=>row.commissionStatus!=='available').length,retryCount:write.retryCount,resumeCount,attemptDiagnostics:write.attempts.slice(-100),diagnostics:[{code:'SOURCE_VALIDATED',at:completedAt,sourceFingerprint:bundle.sourceFingerprint},{code:'FINGERPRINT_REPLAY_VALIDATED',at:completedAt,lineFingerprint,summaryFingerprint,resultFingerprint},{code:'CANDIDATE_VALIDATED',at:completedAt,validation}],validation,lineFingerprint,summaryFingerprint,resultFingerprint,fingerprintContract:{algorithm:'SHA-256',encoding:'lowercase-hex',length:64,canonicalOrdering:true,replayValidated:true},memorySamples,peakRssBytes,completedAt,immutable:true,updatedAt:completedAt}});
    await db.collection(STATE).updateOne({scopeKey:SCOPE_KEY},{$set:{scopeKey:SCOPE_KEY,activeRunId:runId,previousActiveRunId:previous?.runId||'',sourceFingerprint:bundle.sourceFingerprint,activatedAt:completedAt,updatedAt:completedAt},$setOnInsert:{createdAt:completedAt}},{upsert:true});
    if(previous?.runId&&previous.runId!==runId)await db.collection(RUNS).updateOne({runId:previous.runId},{$set:{status:'superseded',active:false,activationStatus:'superseded',supersededAt:completedAt,updatedAt:completedAt}});
    await db.collection(RUNS).updateOne({runId},{$set:{active:true,activationStatus:'active',activatedAt:completedAt,updatedAt:completedAt}});
    progress(input.jobControl,'Completed',1,1,'Seller Financial Performance is active');return {ok:true,runId,lineCount:lines.length,summaryCount:summaries.length,retryCount:write.retryCount,resumeCount,sourceFingerprint:bundle.sourceFingerprint,resultFingerprint,previousActiveRunId:previous?.runId||'',active:true,nonPayable:true};
  }catch(error){await db.collection(RUNS).updateOne({runId},{$set:{status:'failed',active:false,activationStatus:'failed-never-active',lastError:clean(error.message,1000),failedAt:new Date(),updatedAt:new Date()}},{upsert:false}).catch(()=>{});throw error;}finally{await releaseLock(lock);}
}

function listParam(value,max=20) { return clean(value,2000).split(',').map(item=>clean(item,300)).filter(Boolean).slice(0,max); }
function queryFromFilters(runId,filters={}) {
  const query={runId};const from=filters.dateFrom?date8(filters.dateFrom,'dateFrom'):'';const to=filters.dateTo?date8(filters.dateTo,'dateTo'):'';if(from||to){query.saleDate={};if(from)query.saleDate.$gte=from;if(to)query.saleDate.$lte=to;if(from&&to&&to<from)fail('SELLER_FINANCIAL_DATE_RANGE_INVALID','بازه تاریخ معکوس است.');}
  const matchList=(input,field)=>{const values=listParam(input);if(values.length)query[field]={$in:values};};matchList(filters.sellerIdentity,'sellerIdentity');matchList(filters.category,'officialProductCategoryName');matchList(filters.ratePool,'commissionRatePool');matchList(filters.store,'storeIdentity');matchList(filters.costStatus,'costCoverageStatus');
  if(filters.invoiceNumber)query.saleInvoiceNumber=Number(filters.invoiceNumber);const itemSearch=clean(filters.itemSearch||filters.itemCode,100);if(itemSearch){const pattern=escapeRegex(itemSearch);query.$or=[{itemCode:{$regex:pattern,$options:'i'}},{itemDescription:{$regex:pattern,$options:'i'}}];}
  if(filters.purchaseInvoiceNumber)query.purchaseInvoiceNumbers=Number(filters.purchaseInvoiceNumber);
  if(filters.supplier){const pattern=escapeRegex(filters.supplier);query.$and=[...(query.$and||[]),{$or:[{supplierAccountNumbers:{$regex:pattern,$options:'i'}},{supplierNames:{$regex:pattern,$options:'i'}}]}];}
  const range=(min,max,field)=>{if(min==null&&max==null)return;query[field]={};if(min!=null&&clean(min))query[field].$gte=Decimal128.fromString(exact(min));if(max!=null&&clean(max))query[field].$lte=Decimal128.fromString(exact(max));};range(filters.invoiceAmountMin,filters.invoiceAmountMax,'invoiceGrossSaleAmountNumeric');range(filters.fifoProfitMin,filters.fifoProfitMax,'actualFifoProfitNumeric');
  range(filters.lineAmountMin,filters.lineAmountMax,'grossSaleAmountNumeric');range(filters.commissionableProfitMin,filters.commissionableProfitMax,'commissionableProfitNumeric');range(filters.draftCommissionMin,filters.draftCommissionMax,'preliminaryCommissionNumeric');
  range(filters.marginMin,filters.marginMax,'fifoMarginNumeric');
  for(const [input,field]of [['policyAvailability','policyAvailability'],['categoryAvailability','categoryAvailability'],['rateAvailability','rateAvailability'],['discountAvailability','discountAvailability'],['profitAvailability','profitAvailability'],['commissionAvailability','commissionAvailability']])if(filters[input])query[field]={$in:listParam(filters[input])};
  const boolFilter=(input,field)=>{if(filters[input]==='true'||filters[input]===true)query[field]=true;else if(filters[input]==='false'||filters[input]===false)query[field]=false;};boolFilter('hasApprovedAdjustment','hasApprovedAdjustment');boolFilter('hasSavedProfitCredit','hasSavedProfitCredit');boolFilter('hasSavedProfitSubsidy','hasSavedProfitSubsidy');
  return query;
}
async function requireActive(db) { const active=await activeRun(db);if(!active)fail('SELLER_FINANCIAL_ACTIVE_RUN_MISSING','Read Model فعال موجود نیست.',409);return active; }
function decorateAdjustmentEligibility(row,stale) {
  const blockers=[...(row.adjustmentBlockers||[])];if(stale&&!blockers.includes('stale-read-model-run'))blockers.push('stale-read-model-run');
  return {...row,adjustmentEligibility:blockers.length?'ineligible':'eligible_candidate',adjustmentBlockers:blockers};
}
async function listLines(db,filters={},requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const query=queryFromFilters(active.runId,filters);const page=Math.max(1,Number(filters.page||1));const pageSize=Math.max(1,Math.min(Number(filters.pageSize||50),MAX_PAGE_SIZE));const sortFields={date:'saleDate',invoice:'saleInvoiceNumber',profit:'actualFifoProfitNumeric',sale:'grossSaleAmountNumeric'};const sortField=sortFields[filters.sortBy]||'saleDate';const direction=clean(filters.sortDirection).toLowerCase()==='asc'?1:-1;
  const [total,list,status]=await Promise.all([count(db.collection(LINES),query),db.collection(LINES).find(query).sort({[sortField]:direction,saleLineIdentity:1}).skip((page-1)*pageSize).limit(pageSize).toArray(),freshness(db,requestedBy)]);return {ok:true,runId:active.runId,page,pageSize,total,list:list.map(row=>decorateAdjustmentEligibility(row,status.stale)),readModelStale:status.stale,serverSide:true,nonPayable:true,sellerFacing:false};
}
async function listInvoiceLines(db,saleInvoiceIdentity,filters={},requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const page=Math.max(1,Number(filters.page||1));const pageSize=Math.max(1,Math.min(Number(filters.pageSize||100),MAX_PAGE_SIZE));const query={runId:active.runId,saleInvoiceIdentity:clean(saleInvoiceIdentity,200)};const [total,list,status]=await Promise.all([count(db.collection(LINES),query),db.collection(LINES).find(query).sort({saleLineIdentity:1}).skip((page-1)*pageSize).limit(pageSize).toArray(),freshness(db,requestedBy)]);if(!total)fail('SELLER_FINANCIAL_INVOICE_NOT_FOUND','فاکتور در Read Model فعال پیدا نشد.',404);return {ok:true,runId:active.runId,saleInvoiceIdentity,page,pageSize,total,list:list.map(row=>decorateAdjustmentEligibility(row,status.stale)),readModelStale:status.stale,serverSide:true,nonPayable:true};
}
async function listInvoices(db,filters={},requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const query=queryFromFilters(active.runId,filters);const page=Math.max(1,Number(filters.page||1)),pageSize=Math.max(1,Math.min(Number(filters.pageSize||50),MAX_PAGE_SIZE));const known=field=>({$sum:{$cond:[{$ne:[`$${field}`,null]},1,0]}});const group={$group:{_id:'$saleInvoiceIdentity',saleInvoiceIdentity:{$first:'$saleInvoiceIdentity'},saleInvoiceType:{$first:'$saleInvoiceType'},saleInvoiceNumber:{$first:'$saleInvoiceNumber'},saleDate:{$first:'$saleDate'},sellerIdentity:{$first:'$sellerIdentity'},sellerName:{$first:'$sellerName'},storeName:{$first:'$storeName'},lineCount:{$sum:1},grossSaleAmountNumeric:{$sum:'$grossSaleAmountNumeric'},netSaleAmountNumeric:{$sum:'$netSaleAmountNumeric'},actualFifoProfitNumeric:{$sum:'$actualFifoProfitNumeric'},commissionableProfitNumeric:{$sum:'$commissionableProfitNumeric'},preliminaryCommissionNumeric:{$sum:'$preliminaryCommissionNumeric'},netKnownCount:known('netSaleAmountNumeric'),profitKnownCount:known('actualFifoProfitNumeric'),commissionableKnownCount:known('commissionableProfitNumeric'),commissionKnownCount:known('preliminaryCommissionNumeric'),unavailableLineCount:{$sum:{$cond:[{$gt:[{$size:'$blockers'},0]},1,0]}},categories:{$addToSet:'$officialProductCategoryName'},ratePools:{$addToSet:'$commissionRatePool'}}};
  const collection=db.collection(LINES);const [countRows,list]=await Promise.all([collection.aggregate([{$match:query},group,{$count:'count'}]).toArray(),collection.aggregate([{$match:query},group,{$sort:{saleDate:-1,saleInvoiceNumber:-1}},{$skip:(page-1)*pageSize},{$limit:pageSize}]).toArray()]);
  return {ok:true,runId:active.runId,page,pageSize,total:Number(countRows[0]?.count||0),list:list.map(row=>{const complete=Number(row.profitKnownCount||0)===Number(row.lineCount||0);const known=Number(row.profitKnownCount||0)?decimalText(row.actualFifoProfitNumeric):null;return {...row,grossSaleAmountExact:decimalText(row.grossSaleAmountNumeric)||'0.00',netSaleAmountExact:Number(row.netKnownCount||0)===Number(row.lineCount||0)?decimalText(row.netSaleAmountNumeric):null,knownFifoProfitExact:known,actualFifoProfitExact:complete?known:null,profitCoverageComplete:complete,commissionableProfitExact:Number(row.commissionableKnownCount||0)===Number(row.lineCount||0)?decimalText(row.commissionableProfitNumeric):null,preliminaryCommissionExact:Number(row.commissionKnownCount||0)===Number(row.lineCount||0)?decimalText(row.preliminaryCommissionNumeric):null,nonPayable:true};}),serverSide:true,nonPayable:true};
}
async function listSummaries(db,filters={},requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const query={runId:active.runId};if(filters.dimension)query.dimension=clean(filters.dimension,100);if(filters.sellerIdentity)query.sellerIdentity={$in:listParam(filters.sellerIdentity)};if(filters.month)query.accountingMonth=clean(filters.month,6);if(filters.category)query.officialProductCategoryName={$in:listParam(filters.category)};if(filters.ratePool)query.commissionRatePool={$in:listParam(filters.ratePool)};const page=Math.max(1,Number(filters.page||1));const pageSize=Math.max(1,Math.min(Number(filters.pageSize||100),MAX_PAGE_SIZE));const [total,list]=await Promise.all([count(db.collection(SUMMARIES),query),db.collection(SUMMARIES).find(query).sort({saleValueNumeric:-1,dimensionKey:1}).skip((page-1)*pageSize).limit(pageSize).toArray()]);return {ok:true,runId:active.runId,page,pageSize,total,list,nonPayable:true};
}
function decimalText(value) { if(value==null)return null;if(typeof value==='number')return exact(value);if(typeof value.toString==='function')return exact(value.toString());return exact(value); }
async function totals(db,filters={},requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const query=queryFromFilters(active.runId,filters);const present=field=>({$sum:{$cond:[{$ne:[`$${field}`,null]},1,0]}});const rows=await db.collection(LINES).aggregate([{$match:query},{$group:{_id:null,lineCount:{$sum:1},saleQuantityNumeric:{$sum:'$quantityNumeric'},saleValueNumeric:{$sum:'$grossSaleAmountNumeric'},netSaleValueNumeric:{$sum:'$netSaleAmountNumeric'},fifoCostNumeric:{$sum:'$fifoCostNumeric'},actualFifoProfitNumeric:{$sum:'$actualFifoProfitNumeric'},approvedAdjustmentNumeric:{$sum:'$approvedAdjustmentAmountNumeric'},savedProfitCreditNumeric:{$sum:'$savedProfitCreditNumeric'},savedProfitSubsidyNumeric:{$sum:'$savedProfitSubsidyNumeric'},commissionableProfitNumeric:{$sum:'$commissionableProfitNumeric'},preliminaryCommissionNumeric:{$sum:'$preliminaryCommissionNumeric'},netKnownCount:present('netSaleAmountNumeric'),costKnownCount:present('fifoCostNumeric'),profitKnownCount:present('actualFifoProfitNumeric'),commissionableKnownCount:present('commissionableProfitNumeric'),commissionKnownCount:present('preliminaryCommissionNumeric')}}]).toArray();
  const invoiceGroups=await db.collection(LINES).aggregate([{$match:query},{$group:{_id:'$saleInvoiceIdentity'}},{$count:'count'}]).toArray();const unavailableQuery={$and:[query,{commissionStatus:'unavailable'}]};const unknownQuery={$and:[query,{costCoverageStatus:{$ne:'complete'}}]};const [unavailableLineCount,unknownCostLineCount]=await Promise.all([count(db.collection(LINES),unavailableQuery),count(db.collection(LINES),unknownQuery)]);const row=rows[0]||{};
  const lineCount=Number(row.lineCount||0);const completeProfit=Number(row.profitKnownCount||0)===lineCount;const knownProfit=Number(row.profitKnownCount||0)?decimalText(row.actualFifoProfitNumeric):null;
  return {ok:true,runId:active.runId,lineCount,invoiceCount:Number(invoiceGroups[0]?.count||0),unavailableLineCount,unknownCostLineCount,saleQuantityExact:decimalText(row.saleQuantityNumeric)||'0.000000',saleValueExact:decimalText(row.saleValueNumeric)||'0.00',netSaleValueExact:Number(row.netKnownCount||0)===lineCount?decimalText(row.netSaleValueNumeric):null,knownFifoCostExact:Number(row.costKnownCount||0)?decimalText(row.fifoCostNumeric):null,fifoCostExact:Number(row.costKnownCount||0)===lineCount?decimalText(row.fifoCostNumeric):null,knownFifoProfitExact:knownProfit,actualFifoProfitExact:completeProfit?knownProfit:null,profitCoverageComplete:completeProfit,approvedAdjustmentExact:decimalText(row.approvedAdjustmentNumeric)||'0.00',savedProfitCreditExact:decimalText(row.savedProfitCreditNumeric)||'0.00',savedProfitSubsidyExact:decimalText(row.savedProfitSubsidyNumeric)||'0.00',commissionableProfitExact:Number(row.commissionableKnownCount||0)===lineCount?decimalText(row.commissionableProfitNumeric):null,preliminaryCommissionExact:Number(row.commissionKnownCount||0)===lineCount?decimalText(row.preliminaryCommissionNumeric):null,nonPayable:true,serverSide:true};
}
async function filterOptions(db,requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const rows=await db.collection(SUMMARIES).find({runId:active.runId,dimension:'seller-category-month'}).toArray();const storeRows=await db.collection(SUMMARIES).find({runId:active.runId,dimension:'seller-store-month'}).toArray();return {ok:true,runId:active.runId,sellers:[...new Map(rows.map(row=>[row.sellerIdentity,{identity:row.sellerIdentity,name:row.sellerName}])).values()].sort((a,b)=>a.name.localeCompare(b.name,'fa')),categories:[...new Set(rows.map(row=>row.officialProductCategoryName).filter(Boolean))].sort(),ratePools:[...new Set((await db.collection(SUMMARIES).find({runId:active.runId,dimension:'seller-rate-pool-month'}).toArray()).map(row=>row.commissionRatePool).filter(Boolean))].sort(),stores:[...new Map(storeRows.map(row=>[row.storeIdentity,{identity:row.storeIdentity,name:row.storeName}])).values()],months:[...new Set(rows.map(row=>row.accountingMonth).filter(Boolean))].sort(),serverSide:true};
}
async function lineDrilldown(db,saleLineIdentity,requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const line=await db.collection(LINES).findOne({runId:active.runId,saleLineIdentity:clean(saleLineIdentity,500)});if(!line)fail('SELLER_FINANCIAL_LINE_NOT_FOUND','ردیف گزارش پیدا نشد.',404);
  const [allocations,adjustments,savedEntries,discountFact,fresh]=await Promise.all([db.collection(fifo.ALLOCATIONS).find({datasetId:line.fifoDatasetId,saleLineId:line.saleLineIdentity}).sort({allocationSequence:1}).toArray(),db.collection(ledger.ADJUSTMENTS).find({fifoDatasetId:line.fifoDatasetId,saleLineIdentity:line.saleLineIdentity}).toArray(),db.collection(ledger.SAVED_LEDGER).find({$or:[{sourceSaleLineIdentity:line.saleLineIdentity},{beneficiarySaleLineIdentity:line.saleLineIdentity}]}).toArray(),line.invoiceDiscountFactId?db.collection(ledger.DISCOUNT_FACTS).findOne({discountFactId:line.invoiceDiscountFactId}):null,freshness(db,requestedBy)]);
  const manualResolutionIds=[...new Set(allocations.map(row=>clean(row.manualResolutionId,100)).filter(Boolean))];
  const manualCostEvidence=manualResolutionIds.length?await db.collection(manualCostResolution.COLLECTION).find({resolutionId:{$in:manualResolutionIds}}).toArray():[];
  return {ok:true,runId:active.runId,line:decorateAdjustmentEligibility(line,fresh.stale),readModelStale:fresh.stale,source:{allocations,manualCostEvidence,adjustments,savedEntries,discountFact},immutableFifo:true,auditable:true,nonPayable:true};
}
async function listRuns(db,filters={},requestedBy={}) { requireRole(requestedBy,READ_ROLES);await ensureIndexes(db);const active=await activeRun(db);const page=Math.max(1,Number(filters.page||1)),pageSize=Math.max(1,Math.min(Number(filters.pageSize||20),100));const query={};if(filters.status)query.status=clean(filters.status,50);const [total,list]=await Promise.all([count(db.collection(RUNS),query),db.collection(RUNS).find(query).sort({createdAt:-1}).skip((page-1)*pageSize).limit(pageSize).toArray()]);return {ok:true,activeRunId:active?.runId||'',page,pageSize,total,list}; }
async function status(db,enabled,requestedBy={}) { requireRole(requestedBy,READ_ROLES);await ensureIndexes(db);const active=await activeRun(db);const lock=await db.collection(LOCKS).findOne({scopeKey:SCOPE_KEY});const latest=await db.collection(RUNS).findOne({}, {sort:{createdAt:-1}});return {ok:true,enabled:Boolean(enabled),activeRunId:active?.runId||'',activeRun:active?.run||null,latestRun:latest||null,buildLocked:Boolean(lock?.owner&&new Date(lock.expiresAt||0)>new Date()),moduleVersion:MODULE_VERSION,algorithmVersion:ALGORITHM_VERSION,nonPayable:true,sellerFacing:false}; }
async function freshness(db,requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const started=Date.now();const active=await requireActive(db);const current=await fastSourceMetadata(db);const latestSale=await saleSnapshot._activeDataset(db);const newestSales=latestSale?.snapshotId?await db.collection('saleSnapshotDatasetLines').findOne({snapshotId:latestSale.snapshotId,saleInvoiceType:2},{sort:{saleDate:-1,saleInvoiceNo:-1,row:-1}}):null;
  const stored=active.run.fastSourceMetadataFingerprint||'';const stale=!stored||stored!==current.fingerprint;const reasons=[];if(!stored)reasons.push('legacy-run-without-fast-metadata');else if(stale)reasons.push('fast-source-metadata-changed');
  return {ok:true,mode:'fast-metadata',runId:active.runId,storedSourceFingerprint:active.run.sourceFingerprint,currentSourceFingerprint:null,storedFastMetadataFingerprint:stored,currentFastMetadataFingerprint:current.fingerprint,stale,reasons,financialDataThrough:active.run.sourceRecency?.financialDataThrough||'',salesDataThrough:clean(newestSales?.saleDate,8)||active.run.sourceRecency?.salesDataThrough||'',sourceRecency:active.run.sourceRecency||null,durationMs:Date.now()-started,targetMs:500,deepVerificationRequired:stale,checkedAt:new Date()};
}
async function fingerprintIntegrity(db,requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const [lines,summaries]=await Promise.all([db.collection(LINES).find({runId:active.runId},{projection:{_id:0,saleLineIdentity:1,lineFingerprint:1}}).toArray(),db.collection(SUMMARIES).find({runId:active.runId},{projection:{_id:0,dimension:1,dimensionKey:1,summaryFingerprint:1}}).toArray()]);
  const replay={lineFingerprint:canonicalLineFingerprint(lines),summaryFingerprint:canonicalSummaryFingerprint(summaries)};replay.resultFingerprint=sha(stable(replay));const stored={sourceFingerprint:active.run.sourceFingerprint,lineFingerprint:active.run.lineFingerprint,summaryFingerprint:active.run.summaryFingerprint,resultFingerprint:active.run.resultFingerprint};
  const details=Object.fromEntries(Object.entries(stored).map(([field,value])=>[field,{...fingerprintDetails(value),replayValue:replay[field]||null,replayMatch:field==='sourceFingerprint'?null:replay[field]===value}]));return {ok:Object.values(details).every(row=>row.valid)&&details.lineFingerprint.replayMatch&&details.summaryFingerprint.replayMatch&&details.resultFingerprint.replayMatch,runId:active.runId,stored,replay,details,canonicalOrdering:true};
}
async function deepVerify(db,input={},requestedBy={}) {
  const current=requireRole(requestedBy,BUILD_ROLES);await ensureIndexes(db);const active=await requireActive(db);const verificationId=clean(input.verificationId,100)||newId('SFPV');const startedAt=new Date();const base={verificationId,runId:active.runId,status:'running',progress:{phase:'Reading Immutable Sources',current:0,total:3},createdBy:current,createdAt:startedAt,startedAt,updatedAt:startedAt,readOnly:true};await db.collection(VERIFICATIONS).insertOne(base);
  try{progress(input.jobControl,'Reading Immutable Sources',0,3,'Deep source fingerprint replay');const bundle=await sourceBundle(db);await db.collection(VERIFICATIONS).updateOne({verificationId},{$set:{progress:{phase:'Replaying Stored Fingerprints',current:1,total:3},updatedAt:new Date()}});progress(input.jobControl,'Replaying Stored Fingerprints',1,3,'Replaying line and summary fingerprints');const integrity=await fingerprintIntegrity(db,current);const exactSourceMatch=bundle.sourceFingerprint===active.run.sourceFingerprint;const result={ok:exactSourceMatch&&integrity.ok,verificationId,runId:active.runId,storedSourceFingerprint:active.run.sourceFingerprint,currentSourceFingerprint:bundle.sourceFingerprint,sourceReplayMatch:exactSourceMatch,fingerprintIntegrity:integrity,sourceCounts:Object.fromEntries(Object.entries(bundle.sourceProjection).filter(([,value])=>value&&typeof value==='object'&&'count'in value).map(([key,value])=>[key,value.count])),readOnly:true,completedAt:new Date()};await db.collection(VERIFICATIONS).updateOne({verificationId},{$set:{status:result.ok?'completed':'completed_with_errors',progress:{phase:'Completed',current:3,total:3},result,completedAt:result.completedAt,updatedAt:result.completedAt}});progress(input.jobControl,'Completed',3,3,'Deep verification stored');return result;}catch(error){await db.collection(VERIFICATIONS).updateOne({verificationId},{$set:{status:'failed',error:clean(error.message,1000),failedAt:new Date(),updatedAt:new Date()}}).catch(()=>{});throw error;}
}
async function listVerifications(db,filters={},requestedBy={}) {requireRole(requestedBy,READ_ROLES);const pageSize=Math.max(1,Math.min(Number(filters.pageSize||20),100));const list=await db.collection(VERIFICATIONS).find({}).sort({createdAt:-1}).limit(pageSize).toArray();return {ok:true,list,total:await count(db.collection(VERIFICATIONS),{}),readOnly:true};}
async function discountStatusReport(db,requestedBy={}) {requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const rows=await db.collection(LINES).aggregate([{$match:{runId:active.runId}},{$group:{_id:'$discountStatus',lineCount:{$sum:1},saleValueNumeric:{$sum:'$grossSaleAmountNumeric'}}},{$sort:{saleValueNumeric:-1}}]).toArray();return {ok:true,runId:active.runId,totalLines:rows.reduce((sum,row)=>sum+Number(row.lineCount||0),0),states:rows.map(row=>({status:row._id||'source_unavailable',lineCount:Number(row.lineCount||0),saleValueExact:decimalText(row.saleValueNumeric)||'0.00'})),allowedStates:['official_zero_discount','official_nonzero_invoice_discount','official_line_discount','allocation_completed','allocation_unresolved','source_unavailable','source_conflict']};}
async function governanceCoverage(db,requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const collection=db.collection(LINES);const aggregate=async query=>(await collection.aggregate([{$match:{runId:active.runId,...query}},{$group:{_id:null,lineCount:{$sum:1},saleValueNumeric:{$sum:'$grossSaleAmountNumeric'}}}]).toArray())[0]||{};
  const [all,mapped,rated,approvedPolicies,approvedMappings,approvedRates,lines]=await Promise.all([aggregate({}),aggregate({categoryAvailability:'available'}),aggregate({rateAvailability:'available'}),count(db.collection(policies.POLICIES),{status:'approved'}),count(db.collection(ledger.CATEGORY_MAPPINGS),{status:'approved'}),count(db.collection(ledger.RATE_VERSIONS),{status:'approved'}),collection.find({runId:active.runId},{projection:{sellerIdentity:1,officialProductCategoryGuid:1,grossSaleAmountExact:1,rateAvailability:1}}).toArray()]);
  const allValueExact=decimalText(all.saleValueNumeric)||'0.00',ratedValueExact=decimalText(rated.saleValueNumeric)||'0.00',allValue=Number(allValueExact),totalLines=Number(all.lineCount||0);const percent=value=>Number((Number(decimalText(value)||0)*100/Math.max(1,allValue)).toFixed(4));const totalSellers=new Set(lines.map(row=>row.sellerIdentity).filter(Boolean)),unratedSellers=new Set(lines.filter(row=>row.rateAvailability!=='available').map(row=>row.sellerIdentity).filter(Boolean)),totalGroups=new Set(lines.map(row=>row.officialProductCategoryGuid).filter(Boolean)),unratedGroups=new Set(lines.filter(row=>row.rateAvailability!=='available').map(row=>row.officialProductCategoryGuid).filter(Boolean));const fullyRatedSellerCount=Math.max(0,totalSellers.size-unratedSellers.size),fullyRatedGroupCount=Math.max(0,totalGroups.size-unratedGroups.size);
  return {ok:true,runId:active.runId,approvedSelectablePolicies:approvedPolicies,approvedMappings,approvedRates,totalLines,totalSaleValueExact:allValueExact,approvedMappedLines:Number(mapped.lineCount||0),approvedMappedLineCoveragePercent:Number((Number(mapped.lineCount||0)*100/Math.max(1,totalLines)).toFixed(4)),approvedMappedSaleValueExact:decimalText(mapped.saleValueNumeric)||'0.00',approvedMappedSaleValueCoveragePercent:percent(mapped.saleValueNumeric),approvedRateLines:Number(rated.lineCount||0),missingRateLines:Math.max(0,totalLines-Number(rated.lineCount||0)),approvedRateLineCoveragePercent:Number((Number(rated.lineCount||0)*100/Math.max(1,totalLines)).toFixed(4)),approvedRateSaleValueExact:ratedValueExact,missingRateSaleValueExact:subtract(allValueExact,ratedValueExact),approvedRateSaleValueCoveragePercent:percent(rated.saleValueNumeric),approvedRateCoveragePercent:percent(rated.saleValueNumeric),approvedRateSellerCoveragePercent:Number((fullyRatedSellerCount*100/Math.max(1,totalSellers.size)).toFixed(4)),approvedRateGroupCoveragePercent:Number((fullyRatedGroupCount*100/Math.max(1,totalGroups.size)).toFixed(4)),approvedOnly:true,projectedIncluded:false,automaticApproval:false};
}

module.exports={RUNS,LINES,SUMMARIES,STATE,LOCKS,VERIFICATIONS,SCOPE_KEY,SCHEMA_VERSION,ALGORITHM_VERSION,MODULE_VERSION,READ_ROLES,BUILD_ROLES,COLLECTIONS,ensureIndexes,activeRun,buildReadModel,listLines,listInvoices,listInvoiceLines,listSummaries,totals,filterOptions,lineDrilldown,listRuns,status,freshness,fingerprintIntegrity,deepVerify,listVerifications,discountStatusReport,governanceCoverage,_sourceBundle:sourceBundle,_fastSourceMetadata:fastSourceMetadata,_sourceRecency:sourceRecency,_buildProjectedLines:buildProjectedLines,_buildSummaries:buildSummaries,_queryFromFilters:queryFromFilters,_canonicalLineFingerprint:canonicalLineFingerprint,_canonicalSummaryFingerprint:canonicalSummaryFingerprint};
