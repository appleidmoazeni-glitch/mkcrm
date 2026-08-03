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
const { canonicalSaleDate } = require('./jalali-date');

const RUNS = 'sellerFinancialPerformanceRuns';
const LINES = 'sellerFinancialPerformanceLines';
const SUMMARIES = 'sellerFinancialPerformanceSummaries';
const STATE = 'sellerFinancialPerformanceState';
const LOCKS = 'sellerFinancialPerformanceLocks';
const SCOPE_KEY = 'seller-financial-performance-v1';
const SCHEMA_VERSION = 1;
const ALGORITHM_VERSION = 'seller-financial-performance-v1';
const MODULE_VERSION = 'seller-financial-performance-1.0.0';
const READ_ROLES = Object.freeze(['admin', 'accounting', 'manager', 'purchase']);
const BUILD_ROLES = Object.freeze(['admin', 'accounting']);
const COLLECTIONS = Object.freeze([RUNS, LINES, SUMMARIES, STATE, LOCKS]);
const MAX_PAGE_SIZE = 500;

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
  await db.collection(LINES).createIndex({runId:1,invoiceGrossSaleAmountNumeric:1});
  await db.collection(LINES).createIndex({runId:1,grossSaleAmountNumeric:1});
  await db.collection(LINES).createIndex({runId:1,actualFifoProfitNumeric:1});
  await db.collection(LINES).createIndex({runId:1,commissionableProfitNumeric:1});
  await db.collection(LINES).createIndex({runId:1,preliminaryCommissionNumeric:1});
  await db.collection(LINES).createIndex({runId:1,policyAvailability:1,categoryAvailability:1,rateAvailability:1});
  await db.collection(LINES).createIndex({runId:1,hasApprovedAdjustment:1,hasSavedProfitCredit:1,hasSavedProfitSubsidy:1});
  await db.collection(SUMMARIES).createIndex({runId:1,dimension:1,dimensionKey:1},{unique:true});
  await db.collection(SUMMARIES).createIndex({runId:1,dimension:1,saleValueNumeric:-1});
  await db.collection(STATE).createIndex({scopeKey:1},{unique:true});
  await db.collection(LOCKS).createIndex({scopeKey:1},{unique:true});
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
function sortedSourceRows(rows) { return rows.map(immutableSourceProjection).sort((a,b)=>stable(a).localeCompare(stable(b))); }
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
    db.collection('saleSnapshotDatasetHeaders').find({snapshotId:saleSnapshotId}).toArray(),
    db.collection('userShayganMappings').find({isActive:{$ne:false}}).toArray(),
    db.collection('users').find({isActive:{$ne:false}}).toArray(),
    db.collection(fifo.ALLOCATIONS).find({datasetId:fifoDatasetId}).toArray()
  ]);
  const mappings=await policies.attachPolicyBindings(db,'category_mapping',rawMappings);
  const rates=await policies.attachPolicyBindings(db,'rate_version',rawRates);
  const policyIds=new Set(approvedPolicies.map(row=>row.policyVersionId));
  const governedMappings=mappings.filter(row=>policyIds.has(row.policyVersionId));
  const governedRates=rates.filter(row=>policyIds.has(row.policyVersionId));
  const sourceProjection={
    fifoDatasetId,saleSnapshotId,catalogRunId:catalogMaps.run?.catalogRunId||'',
    fifoSourceFingerprint:fifoActive.dataset.sourceFingerprint||'',fifoAllocationFingerprint:fifoActive.dataset.allocationFingerprint||'',
    facts: facts.map(row=>[row.saleLineIdentity,row.factContentHash||sha(stable(immutableSourceProjection(row)))]),
    officialAssignments:sortedSourceRows(catalogMaps.rows),
    policy:sortedSourceRows(approvedPolicies),mappings:sortedSourceRows(governedMappings),rates:sortedSourceRows(governedRates),
    discounts:discountFacts.map(row=>[row.discountFactId,row.contentHash]).sort(),adjustments:adjustments.map(row=>[row.adjustmentId,row.revision,row.approvedAmountExact]).sort(),
    savedEntries:savedEntries.map(row=>[row.ledgerEntryId,row.contentHash]).sort(),
    saleHeaders:sortedSourceRows(headers),sellerMappings:sortedSourceRows(userMappings),users:users.map(row=>({username:row.username,fullName:row.fullName,role:row.role,isActive:row.isActive})).sort((a,b)=>stable(a).localeCompare(stable(b))),
    allocationFingerprint:fifoActive.dataset.allocationFingerprint||sha(stable(allocations.map(row=>row.allocationId).sort()))
  };
  return {fifoActive,fifoDatasetId,saleSnapshotId,facts,catalogMaps,approvedPolicies,governedMappings,governedRates,discountFacts,adjustments,savedEntries,headers,userMappings,users,allocations,sourceFingerprint:sha(stable(sourceProjection)),sourceProjection};
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

function buildProjectedLines(bundle,runId,calculatedAt) {
  const assignmentByGuid=bundle.catalogMaps.byGuid,assignmentByCode=bundle.catalogMaps.byCode;
  const discounts=new Map(bundle.discountFacts.map(row=>[row.saleInvoiceIdentity,row]));
  const adjustmentsByLine=new Map(); for(const row of bundle.adjustments){if(!adjustmentsByLine.has(row.saleLineIdentity))adjustmentsByLine.set(row.saleLineIdentity,[]);adjustmentsByLine.get(row.saleLineIdentity).push(row);}
  const savedSource=new Map(),savedBeneficiary=new Map();
  for(const row of bundle.savedEntries){if(row.sourceSaleLineIdentity){if(!savedSource.has(row.sourceSaleLineIdentity))savedSource.set(row.sourceSaleLineIdentity,[]);savedSource.get(row.sourceSaleLineIdentity).push(row);}if(row.beneficiarySaleLineIdentity){if(!savedBeneficiary.has(row.beneficiarySaleLineIdentity))savedBeneficiary.set(row.beneficiarySaleLineIdentity,[]);savedBeneficiary.get(row.beneficiarySaleLineIdentity).push(row);}}
  const invoiceFacts=new Map();for(const fact of bundle.facts){if(!invoiceFacts.has(fact.saleInvoiceIdentity))invoiceFacts.set(fact.saleInvoiceIdentity,[]);invoiceFacts.get(fact.saleInvoiceIdentity).push(fact);}
  const allocationIdsByLine=new Map();for(const row of bundle.allocations){if(!allocationIdsByLine.has(row.saleLineId))allocationIdsByLine.set(row.saleLineId,[]);allocationIdsByLine.get(row.saleLineId).push(row.allocationId);}
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
    const invoiceDiscount=discounts.get(fact.saleInvoiceIdentity);let allocatedInvoiceDiscountExact=null;let discountAvailability='unavailable';
    if(invoiceDiscount&&['not-applicable','resolved-single-category'].includes(invoiceDiscount.categoryAttributionStatus)){
      if(Number(invoiceDiscount.invoiceDiscountExact||0)===0){allocatedInvoiceDiscountExact='0.00';discountAvailability='available';}
      else{blockers.push('invoice-discount-allocation-not-materialized');warningFlags.push('invoice-discount-present');}
    }else blockers.push(invoiceDiscount?'invoice-discount-unresolved':'invoice-discount-fact-missing');
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
    const core={
      runId,schemaVersion:SCHEMA_VERSION,algorithmVersion:ALGORITHM_VERSION,sourceFingerprint:bundle.sourceFingerprint,
      fifoDatasetId:bundle.fifoDatasetId,saleSnapshotId:bundle.saleSnapshotId,officialCatalogRunId:bundle.catalogMaps.run?.catalogRunId||'',
      saleLineIdentity:fact.saleLineIdentity,saleInvoiceIdentity:fact.saleInvoiceIdentity,saleInvoiceType:Number(fact.saleInvoiceType),saleInvoiceNumber:Number(fact.saleInvoiceNumber),saleInvoiceNo:Number(fact.saleInvoiceNumber),saleDate:fact.saleDate,saleDateJalali:fact.saleDate,saleDateRaw:clean(fact.saleDateRaw||fact.saleDate,100),accountingMonth:monthOf(fact.saleDate),
      sellerIdentity:clean(fact.sellerIdentity,100),sellerName:clean(fact.sellerName||sellerActor.displayName,200),sellerDisplayName:clean(fact.sellerName||sellerActor.displayName,200),sellerUsername:sellerActor.username||'',storeIdentity,storeName,
      itemGuid:clean(fact.itemGuid,100),itemCode:clean(fact.itemCode,100),itemDescription:clean(fact.itemDescription,500),quantityExact:exact(fact.quantityExact||0,6),
      officialMainGroupGuid:classification.officialProductCategoryGuid||'',officialProductCategoryIdentity:classification.officialProductCategoryIdentity||'',officialProductCategoryGuid:classification.officialProductCategoryGuid||'',officialProductCategoryNumber:classification.officialProductCategoryNumber||'',officialProductCategoryName:classification.officialProductCategoryName||'UNRESOLVED',
      commissionRatePool:classification.commissionRatePool||'UNRESOLVED',categoryMappingId:classification.mappingId||'',categoryResolutionStatus:classification.status,categoryStatus:classification.status,
      policyVersionId:policy?.policyVersionId||'',policyResolutionStatus:policyState.status,policyAvailability,rateVersionId:rate.rateVersion?.rateVersionId||'',rateExact:rate.rateVersion?.rate||null,commissionRateExact:rate.rateVersion?.rate||null,appliedRateScope:rate.appliedRateScope||'',rateResolutionScope:rate.appliedRateScope||'',rateResolutionPrecedence:rate.precedence||'',rateResolutionStatus:rate.status,rateStatus:rate.status,categoryAvailability,rateAvailability,
      grossSaleAmountExact,lineDiscountExact,invoiceDiscountFactId:invoiceDiscount?.discountFactId||'',invoiceDiscountExact:invoiceDiscount?.invoiceDiscountExact??null,allocatedInvoiceDiscountExact,discountAvailability,netSaleAmountExact,
      fifoCostExact:fact.fifoCostExact==null?null:exact(fact.fifoCostExact),actualFifoProfitExact:fact.actualFifoProfitExact==null?null:exact(fact.actualFifoProfitExact),costCoverageStatus:fact.costCoverageStatus||'unknown',profitAvailability,
      approvedAdjustmentAmountExact,approvedAdjustmentIds:lineAdjustments.map(row=>row.adjustmentId).sort(),adjustmentIds:lineAdjustments.map(row=>row.adjustmentId).sort(),hasApprovedAdjustment:lineAdjustments.length>0,savedProfitCreditExact,savedProfitSubsidyExact,savedProfitLedgerEntryIds:[...savedCredits,...savedSubsidies].map(row=>row.ledgerEntryId).sort(),ledgerEntryIds:[...savedCredits,...savedSubsidies].map(row=>row.ledgerEntryId).sort(),hasSavedProfitCredit:savedCredits.length>0,hasSavedProfitSubsidy:savedSubsidies.length>0,
      commissionableProfitExact,preliminaryCommissionExact,draftCommissionExact:preliminaryCommissionExact,commissionStatus:lineAvailability(blockers),commissionAvailability,blockers:[...new Set(blockers)],warningFlags:[...new Set(warningFlags)],
      discountFactId:invoiceDiscount?.discountFactId||'',allocationIds:(allocationIdsByLine.get(fact.saleLineIdentity)||[]).filter(Boolean).sort(),
      invoiceGrossSaleAmountExact,calculatedAt,nonPayable:true,sellerFacing:false,immutableSource:true
    };
    const numericFields=['quantityExact','grossSaleAmountExact','lineDiscountExact','invoiceDiscountExact','allocatedInvoiceDiscountExact','netSaleAmountExact','fifoCostExact','actualFifoProfitExact','approvedAdjustmentAmountExact','savedProfitCreditExact','savedProfitSubsidyExact','commissionableProfitExact','preliminaryCommissionExact','invoiceGrossSaleAmountExact'];
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
  const current=requireRole(requestedBy,BUILD_ROLES);await ensureIndexes(db);const runId=clean(input.runId,100)||newId('SFPR');let lock=null;
  try{
    lock=await acquireLock(db,runId);progress(input.jobControl,'Reading Immutable Sources',0,1,'Reading approved source datasets');const bundle=await sourceBundle(db);
    const requestedMode=clean(input.mode||'full',30).toLowerCase();const currentBeforeBuild=await activeRun(db);if(requestedMode==='incremental'&&currentBeforeBuild?.run?.sourceFingerprint===bundle.sourceFingerprint)return {ok:true,runId:currentBeforeBuild.runId,lineCount:Number(currentBeforeBuild.run.lineCount||0),summaryCount:Number(currentBeforeBuild.run.summaryCount||0),retryCount:0,resumeCount:Number(currentBeforeBuild.run.resumeCount||0),sourceFingerprint:bundle.sourceFingerprint,resultFingerprint:currentBeforeBuild.run.resultFingerprint,active:true,duplicate:true,buildMode:'incremental-no-source-change',nonPayable:true};
    let run=await db.collection(RUNS).findOne({runId});const now=new Date();let resumeCount=0;
    if(run){if(!['building','failed'].includes(run.status))fail('SELLER_FINANCIAL_RUN_IMMUTABLE','فقط Run ناقص یا ناموفق قابل Resume است.',409);if(run.sourceFingerprint&&run.sourceFingerprint!==bundle.sourceFingerprint)fail('SELLER_FINANCIAL_SOURCE_CHANGED','منابع از زمان Run قبلی تغییر کرده‌اند؛ Resume مجاز نیست.',409);resumeCount=Number(run.resumeCount||0)+1;await db.collection(RUNS).updateOne({runId},{$set:{status:'building',sourceFingerprint:bundle.sourceFingerprint,resumeCount,updatedAt:now,lastError:''}});}else{const policyIds=bundle.approvedPolicies.map(row=>row.policyVersionId).sort();run={runId,schemaVersion:SCHEMA_VERSION,algorithmVersion:ALGORITHM_VERSION,moduleVersion:MODULE_VERSION,buildMode:requestedMode==='incremental'?'incremental-safe-full-rebuild':'full',status:'building',active:false,activationStatus:'candidate',sourceFingerprint:bundle.sourceFingerprint,sourceFifoDatasetId:bundle.fifoDatasetId,sourceSaleSnapshotId:bundle.saleSnapshotId,sourcePolicyVersionId:policyIds.length===1?policyIds[0]:'',sourcePolicyVersionIds:policyIds,sourceCategoryCatalogRunId:bundle.catalogMaps.run?.catalogRunId||'',sourceCatalogRunId:bundle.catalogMaps.run?.catalogRunId||'',sourceDiscountVersion:1,sourceDiscountFingerprint:sha(stable(bundle.sourceProjection.discounts)),sourceAdjustmentFingerprint:sha(stable(bundle.sourceProjection.adjustments)),sourceLedgerFingerprint:sha(stable(bundle.sourceProjection.savedEntries)),sourceSellerMappingFingerprint:sha(stable(bundle.sourceProjection.sellerMappings)),checkpoint:{linesWritten:0,lastSaleLineIdentity:''},retryCount:0,resumeCount:0,createdBy:current,startedAt:now,createdAt:now,updatedAt:now,diagnostics:[],immutable:true,nonPayable:true,sellerFacing:false};await db.collection(RUNS).insertOne(run);}
    progress(input.jobControl,'Projecting Seller Financial Lines',0,bundle.facts.length,'Resolving governed financial dimensions');const calculatedAt=new Date();const lines=buildProjectedLines(bundle,runId,calculatedAt);
    progress(input.jobControl,'Writing Seller Financial Lines',0,lines.length,'Writing isolated candidate rows');const write=await writeBatches(db,runId,lines,input);
    progress(input.jobControl,'Building Summaries',0,1,'Building deterministic summary dimensions');const summaries=buildSummaries(lines,runId,calculatedAt);await db.collection(SUMMARIES).deleteMany({runId});await insertMany(db.collection(SUMMARIES),summaries);
    const lineFingerprints=lines.map(row=>[row.saleLineIdentity,row.lineFingerprint]);const summaryFingerprints=summaries.map(row=>[row.dimension,row.dimensionKey,row.summaryFingerprint]);const lineFingerprint=sha(stable(lineFingerprints)),summaryFingerprint=sha(stable(summaryFingerprints));const resultFingerprint=sha(stable({lineFingerprint,summaryFingerprint}));
    const validation={valid:true,expectedLineCount:bundle.facts.length,lineCount:lines.length,uniqueLineCount:new Set(lines.map(row=>row.saleLineIdentity)).size,summaryCount:summaries.length,duplicateLineCount:lines.length-new Set(lines.map(row=>row.saleLineIdentity)).size,sourceFingerprint:bundle.sourceFingerprint,resultFingerprint};
    if(!validation.valid||validation.duplicateLineCount)fail('SELLER_FINANCIAL_VALIDATION_FAILED','اعتبارسنجی Candidate ناموفق بود.',409,{validation});
    const previous=await activeRun(db);const completedAt=new Date();await db.collection(RUNS).updateOne({runId},{$set:{status:'completed',activationStatus:'validated-candidate',lineCount:lines.length,summaryCount:summaries.length,availableCommissionLineCount:lines.filter(row=>row.commissionStatus==='available').length,unavailableCommissionLineCount:lines.filter(row=>row.commissionStatus!=='available').length,retryCount:write.retryCount,resumeCount,attemptDiagnostics:write.attempts.slice(-100),diagnostics:[{code:'SOURCE_VALIDATED',at:completedAt,sourceFingerprint:bundle.sourceFingerprint},{code:'CANDIDATE_VALIDATED',at:completedAt,validation}],validation,lineFingerprint,summaryFingerprint,resultFingerprint,completedAt,immutable:true,updatedAt:completedAt}});
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
  const range=(min,max,field)=>{if(min==null&&max==null)return;query[field]={};if(min!=null&&clean(min))query[field].$gte=Decimal128.fromString(exact(min));if(max!=null&&clean(max))query[field].$lte=Decimal128.fromString(exact(max));};range(filters.invoiceAmountMin,filters.invoiceAmountMax,'invoiceGrossSaleAmountNumeric');range(filters.fifoProfitMin,filters.fifoProfitMax,'actualFifoProfitNumeric');
  range(filters.lineAmountMin,filters.lineAmountMax,'grossSaleAmountNumeric');range(filters.commissionableProfitMin,filters.commissionableProfitMax,'commissionableProfitNumeric');range(filters.draftCommissionMin,filters.draftCommissionMax,'preliminaryCommissionNumeric');
  for(const [input,field]of [['policyAvailability','policyAvailability'],['categoryAvailability','categoryAvailability'],['rateAvailability','rateAvailability'],['discountAvailability','discountAvailability'],['profitAvailability','profitAvailability'],['commissionAvailability','commissionAvailability']])if(filters[input])query[field]={$in:listParam(filters[input])};
  const boolFilter=(input,field)=>{if(filters[input]==='true'||filters[input]===true)query[field]=true;else if(filters[input]==='false'||filters[input]===false)query[field]=false;};boolFilter('hasApprovedAdjustment','hasApprovedAdjustment');boolFilter('hasSavedProfitCredit','hasSavedProfitCredit');boolFilter('hasSavedProfitSubsidy','hasSavedProfitSubsidy');
  return query;
}
async function requireActive(db) { const active=await activeRun(db);if(!active)fail('SELLER_FINANCIAL_ACTIVE_RUN_MISSING','Read Model فعال موجود نیست.',409);return active; }
async function listLines(db,filters={},requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const query=queryFromFilters(active.runId,filters);const page=Math.max(1,Number(filters.page||1));const pageSize=Math.max(1,Math.min(Number(filters.pageSize||50),MAX_PAGE_SIZE));const sortFields={date:'saleDate',invoice:'saleInvoiceNumber',profit:'actualFifoProfitNumeric',sale:'grossSaleAmountNumeric'};const sortField=sortFields[filters.sortBy]||'saleDate';const direction=clean(filters.sortDirection).toLowerCase()==='asc'?1:-1;
  const [total,list]=await Promise.all([count(db.collection(LINES),query),db.collection(LINES).find(query).sort({[sortField]:direction,saleLineIdentity:1}).skip((page-1)*pageSize).limit(pageSize).toArray()]);return {ok:true,runId:active.runId,page,pageSize,total,list,serverSide:true,nonPayable:true,sellerFacing:false};
}
async function listInvoiceLines(db,saleInvoiceIdentity,filters={},requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const page=Math.max(1,Number(filters.page||1));const pageSize=Math.max(1,Math.min(Number(filters.pageSize||100),MAX_PAGE_SIZE));const query={runId:active.runId,saleInvoiceIdentity:clean(saleInvoiceIdentity,200)};const [total,list]=await Promise.all([count(db.collection(LINES),query),db.collection(LINES).find(query).sort({saleLineIdentity:1}).skip((page-1)*pageSize).limit(pageSize).toArray()]);if(!total)fail('SELLER_FINANCIAL_INVOICE_NOT_FOUND','فاکتور در Read Model فعال پیدا نشد.',404);return {ok:true,runId:active.runId,saleInvoiceIdentity,page,pageSize,total,list,serverSide:true,nonPayable:true};
}
async function listInvoices(db,filters={},requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const query=queryFromFilters(active.runId,filters);const page=Math.max(1,Number(filters.page||1)),pageSize=Math.max(1,Math.min(Number(filters.pageSize||50),MAX_PAGE_SIZE));const known=field=>({$sum:{$cond:[{$ne:[`$${field}`,null]},1,0]}});const group={$group:{_id:'$saleInvoiceIdentity',saleInvoiceIdentity:{$first:'$saleInvoiceIdentity'},saleInvoiceType:{$first:'$saleInvoiceType'},saleInvoiceNumber:{$first:'$saleInvoiceNumber'},saleDate:{$first:'$saleDate'},sellerIdentity:{$first:'$sellerIdentity'},sellerName:{$first:'$sellerName'},storeName:{$first:'$storeName'},lineCount:{$sum:1},grossSaleAmountNumeric:{$sum:'$grossSaleAmountNumeric'},netSaleAmountNumeric:{$sum:'$netSaleAmountNumeric'},actualFifoProfitNumeric:{$sum:'$actualFifoProfitNumeric'},commissionableProfitNumeric:{$sum:'$commissionableProfitNumeric'},preliminaryCommissionNumeric:{$sum:'$preliminaryCommissionNumeric'},netKnownCount:known('netSaleAmountNumeric'),profitKnownCount:known('actualFifoProfitNumeric'),commissionableKnownCount:known('commissionableProfitNumeric'),commissionKnownCount:known('preliminaryCommissionNumeric'),unavailableLineCount:{$sum:{$cond:[{$gt:[{$size:'$blockers'},0]},1,0]}},categories:{$addToSet:'$officialProductCategoryName'},ratePools:{$addToSet:'$commissionRatePool'}}};
  const collection=db.collection(LINES);const [countRows,list]=await Promise.all([collection.aggregate([{$match:query},group,{$count:'count'}]).toArray(),collection.aggregate([{$match:query},group,{$sort:{saleDate:-1,saleInvoiceNumber:-1}},{$skip:(page-1)*pageSize},{$limit:pageSize}]).toArray()]);
  return {ok:true,runId:active.runId,page,pageSize,total:Number(countRows[0]?.count||0),list:list.map(row=>({...row,grossSaleAmountExact:decimalText(row.grossSaleAmountNumeric)||'0.00',netSaleAmountExact:Number(row.netKnownCount||0)?decimalText(row.netSaleAmountNumeric):null,actualFifoProfitExact:Number(row.profitKnownCount||0)?decimalText(row.actualFifoProfitNumeric):null,commissionableProfitExact:Number(row.commissionableKnownCount||0)?decimalText(row.commissionableProfitNumeric):null,preliminaryCommissionExact:Number(row.commissionKnownCount||0)?decimalText(row.preliminaryCommissionNumeric):null,nonPayable:true})),serverSide:true,nonPayable:true};
}
async function listSummaries(db,filters={},requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const query={runId:active.runId};if(filters.dimension)query.dimension=clean(filters.dimension,100);if(filters.sellerIdentity)query.sellerIdentity={$in:listParam(filters.sellerIdentity)};if(filters.month)query.accountingMonth=clean(filters.month,6);if(filters.category)query.officialProductCategoryName={$in:listParam(filters.category)};if(filters.ratePool)query.commissionRatePool={$in:listParam(filters.ratePool)};const page=Math.max(1,Number(filters.page||1));const pageSize=Math.max(1,Math.min(Number(filters.pageSize||100),MAX_PAGE_SIZE));const [total,list]=await Promise.all([count(db.collection(SUMMARIES),query),db.collection(SUMMARIES).find(query).sort({saleValueNumeric:-1,dimensionKey:1}).skip((page-1)*pageSize).limit(pageSize).toArray()]);return {ok:true,runId:active.runId,page,pageSize,total,list,nonPayable:true};
}
function decimalText(value) { if(value==null)return null;if(typeof value==='number')return exact(value);if(typeof value.toString==='function')return exact(value.toString());return exact(value); }
async function totals(db,filters={},requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const query=queryFromFilters(active.runId,filters);const present=field=>({$sum:{$cond:[{$ne:[`$${field}`,null]},1,0]}});const rows=await db.collection(LINES).aggregate([{$match:query},{$group:{_id:null,lineCount:{$sum:1},saleQuantityNumeric:{$sum:'$quantityNumeric'},saleValueNumeric:{$sum:'$grossSaleAmountNumeric'},netSaleValueNumeric:{$sum:'$netSaleAmountNumeric'},fifoCostNumeric:{$sum:'$fifoCostNumeric'},actualFifoProfitNumeric:{$sum:'$actualFifoProfitNumeric'},approvedAdjustmentNumeric:{$sum:'$approvedAdjustmentAmountNumeric'},savedProfitCreditNumeric:{$sum:'$savedProfitCreditNumeric'},savedProfitSubsidyNumeric:{$sum:'$savedProfitSubsidyNumeric'},commissionableProfitNumeric:{$sum:'$commissionableProfitNumeric'},preliminaryCommissionNumeric:{$sum:'$preliminaryCommissionNumeric'},netKnownCount:present('netSaleAmountNumeric'),costKnownCount:present('fifoCostNumeric'),profitKnownCount:present('actualFifoProfitNumeric'),commissionableKnownCount:present('commissionableProfitNumeric'),commissionKnownCount:present('preliminaryCommissionNumeric')}}]).toArray();
  const invoiceGroups=await db.collection(LINES).aggregate([{$match:query},{$group:{_id:'$saleInvoiceIdentity'}},{$count:'count'}]).toArray();const unavailableQuery={$and:[query,{commissionStatus:'unavailable'}]};const unknownQuery={$and:[query,{costCoverageStatus:{$ne:'complete'}}]};const [unavailableLineCount,unknownCostLineCount]=await Promise.all([count(db.collection(LINES),unavailableQuery),count(db.collection(LINES),unknownQuery)]);const row=rows[0]||{};
  return {ok:true,runId:active.runId,lineCount:Number(row.lineCount||0),invoiceCount:Number(invoiceGroups[0]?.count||0),unavailableLineCount,unknownCostLineCount,saleQuantityExact:decimalText(row.saleQuantityNumeric)||'0.000000',saleValueExact:decimalText(row.saleValueNumeric)||'0.00',netSaleValueExact:Number(row.netKnownCount||0)?decimalText(row.netSaleValueNumeric):null,fifoCostExact:Number(row.costKnownCount||0)?decimalText(row.fifoCostNumeric):null,actualFifoProfitExact:Number(row.profitKnownCount||0)?decimalText(row.actualFifoProfitNumeric):null,approvedAdjustmentExact:decimalText(row.approvedAdjustmentNumeric)||'0.00',savedProfitCreditExact:decimalText(row.savedProfitCreditNumeric)||'0.00',savedProfitSubsidyExact:decimalText(row.savedProfitSubsidyNumeric)||'0.00',commissionableProfitExact:Number(row.commissionableKnownCount||0)?decimalText(row.commissionableProfitNumeric):null,preliminaryCommissionExact:Number(row.commissionKnownCount||0)?decimalText(row.preliminaryCommissionNumeric):null,nonPayable:true,serverSide:true};
}
async function filterOptions(db,requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const rows=await db.collection(SUMMARIES).find({runId:active.runId,dimension:'seller-category-month'}).toArray();const storeRows=await db.collection(SUMMARIES).find({runId:active.runId,dimension:'seller-store-month'}).toArray();return {ok:true,runId:active.runId,sellers:[...new Map(rows.map(row=>[row.sellerIdentity,{identity:row.sellerIdentity,name:row.sellerName}])).values()].sort((a,b)=>a.name.localeCompare(b.name,'fa')),categories:[...new Set(rows.map(row=>row.officialProductCategoryName).filter(Boolean))].sort(),ratePools:[...new Set((await db.collection(SUMMARIES).find({runId:active.runId,dimension:'seller-rate-pool-month'}).toArray()).map(row=>row.commissionRatePool).filter(Boolean))].sort(),stores:[...new Map(storeRows.map(row=>[row.storeIdentity,{identity:row.storeIdentity,name:row.storeName}])).values()],months:[...new Set(rows.map(row=>row.accountingMonth).filter(Boolean))].sort(),serverSide:true};
}
async function lineDrilldown(db,saleLineIdentity,requestedBy={}) {
  requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const line=await db.collection(LINES).findOne({runId:active.runId,saleLineIdentity:clean(saleLineIdentity,500)});if(!line)fail('SELLER_FINANCIAL_LINE_NOT_FOUND','ردیف گزارش پیدا نشد.',404);
  const [allocations,adjustments,savedEntries,discountFact]=await Promise.all([db.collection(fifo.ALLOCATIONS).find({datasetId:line.fifoDatasetId,saleLineId:line.saleLineIdentity}).sort({allocationSequence:1}).toArray(),db.collection(ledger.ADJUSTMENTS).find({fifoDatasetId:line.fifoDatasetId,saleLineIdentity:line.saleLineIdentity}).toArray(),db.collection(ledger.SAVED_LEDGER).find({$or:[{sourceSaleLineIdentity:line.saleLineIdentity},{beneficiarySaleLineIdentity:line.saleLineIdentity}]}).toArray(),line.invoiceDiscountFactId?db.collection(ledger.DISCOUNT_FACTS).findOne({discountFactId:line.invoiceDiscountFactId}):null]);
  return {ok:true,runId:active.runId,line,source:{allocations,adjustments,savedEntries,discountFact},immutableFifo:true,auditable:true,nonPayable:true};
}
async function listRuns(db,filters={},requestedBy={}) { requireRole(requestedBy,READ_ROLES);await ensureIndexes(db);const active=await activeRun(db);const page=Math.max(1,Number(filters.page||1)),pageSize=Math.max(1,Math.min(Number(filters.pageSize||20),100));const query={};if(filters.status)query.status=clean(filters.status,50);const [total,list]=await Promise.all([count(db.collection(RUNS),query),db.collection(RUNS).find(query).sort({createdAt:-1}).skip((page-1)*pageSize).limit(pageSize).toArray()]);return {ok:true,activeRunId:active?.runId||'',page,pageSize,total,list}; }
async function status(db,enabled,requestedBy={}) { requireRole(requestedBy,READ_ROLES);await ensureIndexes(db);const active=await activeRun(db);const lock=await db.collection(LOCKS).findOne({scopeKey:SCOPE_KEY});const latest=await db.collection(RUNS).findOne({}, {sort:{createdAt:-1}});return {ok:true,enabled:Boolean(enabled),activeRunId:active?.runId||'',activeRun:active?.run||null,latestRun:latest||null,buildLocked:Boolean(lock?.owner&&new Date(lock.expiresAt||0)>new Date()),moduleVersion:MODULE_VERSION,algorithmVersion:ALGORITHM_VERSION,nonPayable:true,sellerFacing:false}; }
async function freshness(db,requestedBy={}) { requireRole(requestedBy,READ_ROLES);const active=await requireActive(db);const current=await sourceBundle(db);return {ok:true,runId:active.runId,storedSourceFingerprint:active.run.sourceFingerprint,currentSourceFingerprint:current.sourceFingerprint,stale:active.run.sourceFingerprint!==current.sourceFingerprint,checkedAt:new Date()}; }

module.exports={RUNS,LINES,SUMMARIES,STATE,LOCKS,SCOPE_KEY,SCHEMA_VERSION,ALGORITHM_VERSION,MODULE_VERSION,READ_ROLES,BUILD_ROLES,COLLECTIONS,ensureIndexes,activeRun,buildReadModel,listLines,listInvoices,listInvoiceLines,listSummaries,totals,filterOptions,lineDrilldown,listRuns,status,freshness,_sourceBundle:sourceBundle,_buildProjectedLines:buildProjectedLines,_buildSummaries:buildSummaries,_queryFromFilters:queryFromFilters};
