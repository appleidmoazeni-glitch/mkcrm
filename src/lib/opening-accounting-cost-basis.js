'use strict';

const crypto = require('crypto');
const shaygan = require('./shaygan');
const decimal = require('./accounting-decimal');
const { canonicalSaleDate } = require('./jalali-date');
const openingResourceGovernor = require('./opening-extraction-resource-governor');

const COLLECTION = 'openingAccountingCostBasis';
const DATASETS = 'openingAccountingEvidenceDatasets';
const STATE = 'openingAccountingEvidenceState';
const PROGRESS = 'openingAccountingEvidenceProgress';
const APPROVALS = 'openingAccountingEvidenceApprovals';
const ELIGIBILITY = 'openingAccountingEligibilityPreview';
const MODULE_VERSION = 'opening-accounting-cost-basis-1.3.0';
const SCHEMA_VERSION = 3;
const SOURCE_CLASS = 'OPENING_ACCOUNTING_COST';
const GOVERNANCE_ROLES = Object.freeze(['admin','accounting','purchase']);
const INDEPENDENT_LEGACY_APPROVER_ROLES = Object.freeze(['manager']);
const APPROVAL_PRECEDENCE = Object.freeze(['EXACT_OFFICIAL_PURCHASE_LAYER','APPROVED_OPENING_ACCOUNTING_COST','LOWER_CONFIDENCE_GOVERNED_SOURCE']);
const AUTHORITY_LIFECYCLE = Object.freeze({APPROVED:'APPROVED',REVOKED:'REVOKED',SUPERSEDED:'SUPERSEDED'});

function clean(value, max=500) { return String(value == null ? '' : value).trim().slice(0,max); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${stable(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
function hash(value) { return crypto.createHash('sha256').update(stable(value)).digest('hex'); }
function exact(value, scale) { return decimal.format(decimal.parse(value, scale), scale); }
function sourceDate(value) {
  const raw=clean(value,50);
  return canonicalSaleDate(/^\d{4}-\d{2}-\d{2}T/.test(raw)?raw.slice(0,10):raw,{field:'openingDate',required:true});
}

function fromKardex(result={}, extractedAt=new Date()) {
  const basis=result.openingBasis;
  const movements=Array.isArray(result.rows)?result.rows:[];
  if (!result.ok || !basis || result.meta?.reachedLimit) return null;
  const first=movements.slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||'')))[0];
  const openingDate=result.meta?.openingDate?sourceDate(result.meta.openingDate):(first?.date?sourceDate(first.date):'');
  if (!openingDate) return null;
  const quantityExact=exact(basis.openingQuantity,decimal.QUANTITY_SCALE);
  const totalValueExact=exact(basis.openingTotalValue,decimal.MONEY_SCALE);
  const unitCostExact=exact(basis.openingUnitCost || Number(basis.openingTotalValue)/Number(basis.openingQuantity),decimal.UNIT_COST_SCALE);
  const evidence={
    sourceClass:SOURCE_CLASS,
    sourceEndpoint:'Item/GetKardex',
    itemGuid:clean(result.item?.itemGuid,100),
    itemCode:clean(result.item?.itemCode,100),
    itemDescription:clean(result.item?.itemDescription,500),
    effectiveOpeningDate:openingDate,
    openingQuantityExact:quantityExact,
    openingUnitCostExact:unitCostExact,
    openingTotalValueExact:totalValueExact,
    evidenceScope:clean(result.meta?.stockNumber,100)?'warehouse':'unrestricted-source-response',
    warehouseNumber:clean(result.meta?.stockNumber,100),
    sourceFields:basis.sourceFields,
    earliestMovement:first?{date:sourceDate(first.date),invoiceType:Number(first.invoiceType||0),invoiceNumber:Number(first.invoiceNumber||0),inQuantityExact:exact(first.inQty||0,decimal.QUANTITY_SCALE),outQuantityExact:exact(first.outQty||0,decimal.QUANTITY_SCALE),remainingQuantityExact:exact(first.remainQty||0,decimal.QUANTITY_SCALE),costPriceExact:exact(first.costPrice||0,decimal.UNIT_COST_SCALE)}:null,
    evidenceQuality:'PROVEN_SOURCE_SUMMARY_AND_FIRST_MOVEMENT',
    extractionComplete:true,
    extractedAt
  };
  evidence.sourceFingerprint=hash({...evidence,extractedAt:undefined});
  evidence.evidenceId=`OACB-${evidence.sourceFingerprint.slice(0,24)}`;
  return evidence;
}

function roundedRial(value) {
  return decimal.rescale(decimal.parse(value,decimal.UNIT_COST_SCALE),decimal.UNIT_COST_SCALE,0);
}

function aggregateWarehouseKardex(entries=[], extractedAt=new Date()) {
  const byWarehouse=new Map();
  const duplicates=[];
  for(const entry of entries||[]){
    const warehouseNumber=clean(entry.warehouseNumber??entry.stockNumber??entry.result?.meta?.stockNumber,100);
    const identity=warehouseNumber||'__UNRESTRICTED__';
    const result=entry.result||entry;
    if(!result?.ok||result?.meta?.reachedLimit)return {ok:false,sourceClass:SOURCE_CLASS,code:'OPENING_WAREHOUSE_EXTRACTION_INCOMPLETE',failedWarehouse:warehouseNumber,failureReason:result?.meta?.reachedLimit?'kardex-row-limit-reached':clean(result?.error||'source-request-failed',500),warehouseEvidence:[...byWarehouse.values()],duplicates,extractionComplete:false};
    const evidence=fromKardex(result,extractedAt);
    const row=evidence
      ? {...evidence,warehouseNumber,warehouseName:clean(entry.warehouseName,300),included:entry.included!==false,exclusionReason:entry.included===false?clean(entry.reason||'warehouse-not-operationally-relevant',300):''}
      : {sourceClass:SOURCE_CLASS,sourceEndpoint:'Item/GetKardex',itemGuid:clean(result.item?.itemGuid,100),itemCode:clean(result.item?.itemCode,100),itemDescription:clean(result.item?.itemDescription,500),effectiveOpeningDate:clean(result.meta?.openingDate,8),openingQuantityExact:'0.000000',openingUnitCostExact:'0.000000',openingTotalValueExact:'0.00',evidenceScope:'warehouse',warehouseNumber,warehouseName:clean(entry.warehouseName,300),sourceFields:{quantity:'BeginDurationRemainQuan1',totalValue:'BeginDurationRemainPrice1'},earliestMovement:null,evidenceQuality:'AUTHORITATIVE_ZERO_OPENING_RESPONSE',extractionComplete:true,sourceFingerprint:hash({warehouseNumber,openingDate:clean(result.meta?.openingDate,8),openingQuantityExact:'0.000000',openingTotalValueExact:'0.00'}),included:false,exclusionReason:entry.included===false?clean(entry.reason||'warehouse-not-operationally-relevant',300):'no-positive-authoritative-opening-basis',extractedAt};
    if(byWarehouse.has(identity)){
      const existing=byWarehouse.get(identity);
      duplicates.push({warehouseNumber,identical:existing.sourceFingerprint===row.sourceFingerprint,keptFingerprint:existing.sourceFingerprint,ignoredFingerprint:row.sourceFingerprint});
      if(existing.sourceFingerprint!==row.sourceFingerprint)return {ok:false,sourceClass:SOURCE_CLASS,code:'OPENING_DUPLICATE_WAREHOUSE_CONFLICT',duplicates,warehouseEvidence:[...byWarehouse.values(),row],extractionComplete:false};
      continue;
    }
    byWarehouse.set(identity,row);
  }
  const warehouseEvidence=[...byWarehouse.values()].sort((a,b)=>a.warehouseNumber.localeCompare(b.warehouseNumber,'en'));
  const included=warehouseEvidence.filter(row=>row.included);
  if(!included.length){
    const dates=[...new Set(warehouseEvidence.map(row=>clean(row.effectiveOpeningDate,8)).filter(Boolean))];
    return {ok:true,sourceClass:SOURCE_CLASS,status:'NO_OPENING_STOCK',effectiveOpeningDate:dates.length===1?dates[0]:'',openingQuantityExact:'0.000000',openingUnitCostExact:'0.000000',openingTotalValueExact:'0.00',evidenceScope:'global-active-warehouses',warehouseEvidence,warehouseCount:0,queriedWarehouseCount:warehouseEvidence.length,excludedWarehouseCount:warehouseEvidence.length,duplicateWarehouseCount:duplicates.length,duplicates,evidenceQuality:'PROVEN_GLOBAL_ZERO_OPENING',aggregationMethod:'SUM_QUANTITY_AND_VALUE_WEIGHTED_UNIT_COST',extractionComplete:true,extractedAt};
  }
  const dates=[...new Set(included.map(row=>row.effectiveOpeningDate))];
  if(dates.length!==1)return {ok:false,sourceClass:SOURCE_CLASS,code:'OPENING_PERIOD_MISMATCH',openingDates:dates,warehouseEvidence,duplicates,extractionComplete:false};
  const roundedCosts=[...new Set(included.map(row=>roundedRial(row.openingUnitCostExact).toString()))];
  let quantity=0n,totalValue=0n;
  for(const row of included){quantity+=decimal.parse(row.openingQuantityExact,decimal.QUANTITY_SCALE);totalValue+=decimal.parse(row.openingTotalValueExact,decimal.MONEY_SCALE);}
  if(quantity<=0n||totalValue<=0n)return null;
  const quantityExact=decimal.format(quantity,decimal.QUANTITY_SCALE);
  const totalValueExact=decimal.format(totalValue,decimal.MONEY_SCALE);
  const unitCostScaleFactor=10n**BigInt(decimal.UNIT_COST_SCALE+decimal.QUANTITY_SCALE-decimal.MONEY_SCALE);
  const unitCostExact=decimal.format(decimal.divideRounded(totalValue*unitCostScaleFactor,quantity),decimal.UNIT_COST_SCALE);
  const first=included.map(row=>row.earliestMovement).filter(Boolean).sort((a,b)=>String(a.date).localeCompare(String(b.date)))[0]||null;
  const evidence={sourceClass:SOURCE_CLASS,sourceEndpoint:'Item/GetKardex',itemGuid:included.find(row=>row.itemGuid)?.itemGuid||'',itemCode:included.find(row=>row.itemCode)?.itemCode||'',itemDescription:included.find(row=>row.itemDescription)?.itemDescription||'',effectiveOpeningDate:dates[0],openingQuantityExact:quantityExact,openingUnitCostExact:unitCostExact,openingTotalValueExact:totalValueExact,sourceFields:{quantity:'BeginDurationRemainQuan1',totalValue:'BeginDurationRemainPrice1',aggregation:'sum-by-distinct-operational-warehouse'},earliestMovement:first,evidenceScope:'global-active-warehouses',warehouseEvidence,warehouseCount:included.length,queriedWarehouseCount:warehouseEvidence.length,excludedWarehouseCount:warehouseEvidence.length-included.length,duplicateWarehouseCount:duplicates.length,duplicates,evidenceQuality:'PROVEN_GLOBAL_WAREHOUSE_AGGREGATION',aggregationMethod:'SUM_QUANTITY_AND_VALUE_WEIGHTED_UNIT_COST',warehouseUnitCostVariation:roundedCosts.length>1,warehouseRoundedUnitCosts:roundedCosts,extractionComplete:true,extractedAt};
  evidence.sourceFingerprint=hash({...evidence,extractedAt:undefined});
  evidence.evidenceId=`OACB-${evidence.sourceFingerprint.slice(0,24)}`;
  return evidence;
}

async function materialize(db,input={},options={}) {
  const itemCode=clean(input.itemCode,100);
  if(!itemCode) throw Object.assign(new Error('itemCode required'),{code:'OPENING_BASIS_ITEM_REQUIRED'});
  const openingDate=input.openingDate?sourceDate(input.openingDate):'';
  if(!openingDate)return {ok:false,itemCode,materialized:false,code:'OPENING_DATE_REQUIRED',readOnlySource:true};
  const api=options.shaygan||shaygan;
  const maxRows=Math.max(1,Math.min(Number(options.maxRows||100),200));
  const timeoutMs=Math.max(500,Math.min(Number(options.timeoutMs||5000),15000));
  const configured=Array.isArray(options.stockNumbers)?options.stockNumbers:(await db.collection('settings').findOne({key:'inventory.activeWarehouseNumbers'}).catch(()=>null))?.value;
  const stockNumbers=[...new Set((Array.isArray(configured)?configured:[]).map(value=>clean(value,100)).filter(Boolean))].slice(0,Math.max(1,Math.min(Number(options.maxWarehouses||100),200)));
  if(!stockNumbers.length&&options.allowUnrestrictedScope!==true)return {ok:false,itemCode,materialized:false,code:'OPENING_WAREHOUSE_SCOPE_UNPROVEN',readOnlySource:true};
  const entries=[];
  if(stockNumbers.length){
    for(const stockNumber of stockNumbers){
      const result=await api.getKardexByItemCode(itemCode,stockNumber,{maxRows,hardMaxRows:maxRows,timeoutMs,dateFrom:openingDate});
      result.meta={...(result.meta||{}),stockNumber,openingDate};
      entries.push({warehouseNumber:stockNumber,result,included:true});
    }
  }else{
    const result=await api.getKardexByItemCode(itemCode,'',{maxRows,hardMaxRows:maxRows,timeoutMs,dateFrom:openingDate});
    result.meta={...(result.meta||{}),openingDate};
    entries.push({warehouseNumber:'',result,included:true});
  }
  const evidence=aggregateWarehouseKardex(entries,new Date());
  if(evidence.ok===false)return {ok:false,itemCode,materialized:false,code:evidence.code,details:evidence,readOnlySource:true};
  if(evidence.status==='NO_OPENING_STOCK')return {ok:true,itemCode,materialized:false,status:evidence.status,evidence,readOnlySource:true,purchaseLayerWrites:0,fifoWrites:0};
  const now=new Date();
  await db.collection(COLLECTION).updateOne({itemCode:evidence.itemCode,sourceFingerprint:evidence.sourceFingerprint},{$setOnInsert:{...evidence,moduleVersion:MODULE_VERSION,status:'available',createdAt:now},$set:{lastVerifiedAt:now,updatedAt:now}},{upsert:true});
  return {ok:true,itemCode,evidenceId:evidence.evidenceId,sourceFingerprint:evidence.sourceFingerprint,warehouseCount:evidence.warehouseCount,queriedWarehouseCount:evidence.queriedWarehouseCount,openingQuantityExact:evidence.openingQuantityExact,materialized:true,readOnlySource:true,purchaseLayerWrites:0,fifoWrites:0};
}

function candidateId(now=new Date()){return `OACD-${now.toISOString().replace(/[-:.TZ]/g,'').slice(0,14)}-${crypto.randomBytes(4).toString('hex')}`;}
function itemIdentity(value={}){return clean(value.itemGuid,100)?`guid:${clean(value.itemGuid,100).toLowerCase()}`:`code:${clean(value.itemCode,100).toUpperCase()}`;}
async function governedWarehouses(db,provided){
  const configured=Array.isArray(provided)?provided:(await db.collection('settings').findOne({key:'inventory.activeWarehouseNumbers'}).catch(()=>null))?.value;
  return [...new Set((Array.isArray(configured)?configured:[]).map(value=>clean(value,100)).filter(Boolean))];
}
async function extractItem(item,openingDate,stockNumbers,options={}){
  const api=options.shaygan||shaygan,maxRows=Math.max(1,Math.min(Number(options.maxRows||200),500));
  const timeoutMs=Math.max(500,Math.min(Number(options.timeoutMs||15000),30000));
  const entries=[];const started=Date.now();
  for(const stockNumber of stockNumbers){
    let result;
    try{result=await api.getKardexByItemCode(clean(item.itemCode,100),stockNumber,{maxRows,hardMaxRows:maxRows,timeoutMs,dateFrom:openingDate});}
    catch(error){result={ok:false,error:clean(error?.message||error,500),meta:{reachedLimit:false}};}
    result.meta={...(result.meta||{}),stockNumber,openingDate};
    entries.push({warehouseNumber:stockNumber,result,included:true});
  }
  const evidence=aggregateWarehouseKardex(entries,new Date());
  if(evidence?.ok===false)return {...evidence,itemGuid:clean(item.itemGuid,100),itemCode:clean(item.itemCode,100),itemDescription:clean(item.itemDescription,500),status:'INCOMPLETE_SOURCE',durationMs:Date.now()-started,sourceCallCount:stockNumbers.length};
  const normalized=evidence||{ok:false,status:'OTHER_EXPLICIT_QUARANTINE',code:'OPENING_BASIS_NOT_DETERMINISTIC',warehouseEvidence:[],extractionComplete:false};
  return {...normalized,itemGuid:clean(normalized.itemGuid||item.itemGuid,100),itemCode:clean(normalized.itemCode||item.itemCode,100),itemDescription:clean(normalized.itemDescription||item.itemDescription,500),status:normalized.status==='NO_OPENING_STOCK'?'NO_OPENING_STOCK':'VALIDATED_CANDIDATE',durationMs:Date.now()-started,sourceCallCount:stockNumbers.length};
}
async function buildCandidateLegacy(db,input={},options={}){
  const openingDate=sourceDate(input.openingDate);const items=(Array.isArray(input.items)?input.items:[]).map(item=>({itemGuid:clean(item.itemGuid,100),itemCode:clean(item.itemCode,100),itemDescription:clean(item.itemDescription,500),requiredQuantityExact:clean(item.requiredQuantityExact??item.saleQuantity,100),saleLineCount:Number(item.saleLineCount||0),saleExposure:Number((item.saleExposure??item.saleAmount)||0),firstSaleDate:clean(item.firstSaleDate,8),lastSaleDate:clean(item.lastSaleDate,8)})).filter(item=>item.itemCode);
  if(!items.length)throw Object.assign(new Error('opening candidate items required'),{code:'OPENING_CANDIDATE_ITEMS_REQUIRED'});
  const stockNumbers=await governedWarehouses(db,input.stockNumbers);if(!stockNumbers.length)throw Object.assign(new Error('governed warehouse scope required'),{code:'OPENING_WAREHOUSE_SCOPE_UNPROVEN'});
  const now=new Date(),datasetId=candidateId(now),creator={username:clean(input.createdBy?.username||input.createdBy?.user||'',100),role:clean(input.createdBy?.role||'',50)};
  const dataset={datasetId,schemaVersion:SCHEMA_VERSION,algorithmVersion:MODULE_VERSION,status:'building',approvalStatus:'not-approved',active:false,openingDate,governedWarehouses:stockNumbers,itemCount:items.length,createdBy:creator,createdAt:now,updatedAt:now,immutableAfterCompletion:true,sourceContract:{endpoint:'Item/GetKardex',quantityField:'BeginDurationRemainQuan1',valueField:'BeginDurationRemainPrice1',readOnly:true}};
  await db.collection(DATASETS).insertOne(dataset);
  const concurrency=Math.max(1,Math.min(Number(options.concurrency||input.concurrency||3),8));let cursor=0;const results=new Array(items.length);
  async function worker(){while(true){const index=cursor++;if(index>=items.length)return;results[index]=await extractItem(items[index],openingDate,stockNumbers,options);}}
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},worker));
  const records=results.map((result,index)=>{const base={...result,datasetId,schemaVersion:SCHEMA_VERSION,algorithmVersion:MODULE_VERSION,openingDate,canonicalIdentity:itemIdentity(result),requiredQuantityExact:items[index].requiredQuantityExact,saleLineCount:items[index].saleLineCount,saleExposure:items[index].saleExposure,firstSaleDate:items[index].firstSaleDate,lastSaleDate:items[index].lastSaleDate,approvalStatus:'not-approved',active:false,createdAt:now,immutable:true};const recordFingerprint=hash({...base,createdAt:undefined,durationMs:undefined});return {...base,recordFingerprint,sourceFingerprint:clean(result.sourceFingerprint||recordFingerprint,64),sourceEvidenceId:clean(result.evidenceId,100),evidenceId:`OACB-${datasetId.slice(5)}-${recordFingerprint.slice(0,16)}`};});
  if(records.length)await db.collection(COLLECTION).insertMany(records);
  const statusCounts=records.reduce((map,row)=>(map[row.status]=(map[row.status]||0)+1,map),{});const sourceCallCount=records.reduce((sum,row)=>sum+Number(row.sourceCallCount||0),0);const completedAt=new Date();
  const datasetFingerprint=hash(records.map(row=>[row.canonicalIdentity,row.status,row.recordFingerprint]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  await db.collection(DATASETS).updateOne({datasetId,status:'building'},{$set:{status:'completed',approvalStatus:'not-approved',active:false,statusCounts,sourceCallCount,datasetFingerprint,completedAt,updatedAt:completedAt,durationMs:completedAt-now}});
  await db.collection(STATE).updateOne({scopeKey:'opening-accounting-evidence'},{$set:{scopeKey:'opening-accounting-evidence',latestCandidateId:datasetId,latestCandidateFingerprint:datasetFingerprint,updatedAt:completedAt},$setOnInsert:{createdAt:completedAt}},{upsert:true});
  return {ok:true,datasetId,status:'completed',approvalStatus:'not-approved',active:false,itemCount:records.length,statusCounts,sourceCallCount,datasetFingerprint,durationMs:completedAt-now,purchaseLayerWrites:0,fifoWrites:0,manualCostWrites:0};
}
function actor(value={}) {
  const username=clean(value.username||value.user,100);
  return {userId:clean(value.userId||value.id||username,100),username,displayName:clean(value.displayName||value.fullName||username,200),role:clean(value.role,50)};
}
function fail(code,message,statusCode=400){throw Object.assign(new Error(message),{code,statusCode});}
function percent(value,total){return total===0n?'0.0000':decimal.format(decimal.divideRounded(value*1000000n,total),4);}
function sourceAggregateFingerprint(evidence=[]){return hash(evidence.map(row=>[row.canonicalIdentity,row.status,row.sourceFingerprint]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));}
function normalizeHumanValidation(input={}){
  const checkpoint=input.humanValidationCheckpoint||{};
  if(checkpoint.assertedByManagement!==true)fail('OPENING_HUMAN_VALIDATION_REQUIRED','Management Human validation checkpoint is required before submission.',409);
  const passCards=[...new Set((Array.isArray(checkpoint.passCards)?checkpoint.passCards:[]).map(value=>clean(value,30)).filter(Boolean))].sort();
  if(!passCards.length||passCards.some(value=>!/^OPEN-P\d{2}$/.test(value)))fail('OPENING_HUMAN_VALIDATION_INVALID','Human validation card list is invalid.',409);
  return {assertedByManagement:true,passCards,explicitlyNotAsserted:[...new Set((Array.isArray(checkpoint.explicitlyNotAsserted)?checkpoint.explicitlyNotAsserted:[]).map(value=>clean(value,30)).filter(Boolean))].sort(),source:clean(checkpoint.source||'management-human-validation',200),note:clean(checkpoint.note,1000)};
}
async function immutableGovernanceSnapshot(db,dataset){
  const [evidence,progress,eligibility,purchaseState,facts,allocations]=await Promise.all([
    db.collection(COLLECTION).find({datasetId:dataset.datasetId}).toArray(),
    db.collection(PROGRESS).find({datasetId:dataset.datasetId}).toArray(),
    db.collection(ELIGIBILITY).find({datasetId:dataset.datasetId}).toArray(),
    db.collection('purchaseLayerDatasetState').findOne({scopeKey:'purchase-invoices-types-3-7'}).catch(()=>null),
    db.collection('fifoProfitFacts').find({fifoDatasetId:clean(dataset.eligibilityPreview?.fifoDatasetId,100)}).toArray(),
    db.collection('fifoAllocations').find({datasetId:clean(dataset.eligibilityPreview?.fifoDatasetId,100)}).toArray()
  ]);
  const duplicateCount=(rows,key)=>rows.length-new Set(rows.map(row=>clean(row[key],500))).size;
  const datasetFingerprint=hash(evidence.map(row=>[row.canonicalIdentity,row.status,row.recordFingerprint]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  const sourceFingerprint=sourceAggregateFingerprint(evidence);
  const eligibilityFingerprint=hash(eligibility.map(row=>[row.previewId,row.classification,row.openingEligibleQuantityExact]));
  const terminalProgress=progress.filter(row=>['VALIDATED_CANDIDATE','NO_OPENING_STOCK'].includes(row.status));
  const storedEligibility=clean(dataset.eligibilityPreview?.fingerprint,64);
  if(dataset.status!=='completed'||evidence.length!==Number(dataset.itemCount||0)||progress.length!==Number(dataset.itemCount||0)||terminalProgress.length!==progress.length||Number(dataset.statusCounts?.INCOMPLETE_SOURCE||0)!==0)fail('OPENING_GOVERNANCE_SOURCE_INCOMPLETE','Opening Dataset source population is not fully terminal.',409);
  if(duplicateCount(evidence,'evidenceId')||duplicateCount(progress,'progressId')||duplicateCount(eligibility,'previewId'))fail('OPENING_GOVERNANCE_DUPLICATE_IDENTITY','Opening Dataset contains duplicate governed identities.',409);
  if(datasetFingerprint!==clean(dataset.datasetFingerprint,64)||eligibilityFingerprint!==storedEligibility)fail('OPENING_GOVERNANCE_FINGERPRINT_MISMATCH','Opening Dataset fingerprint changed before governance transition.',409);
  let openingQuantity=0n,openingValue=0n;for(const row of evidence){openingQuantity+=decimal.parse(row.openingQuantityExact||0,decimal.QUANTITY_SCALE);openingValue+=decimal.parse(row.openingTotalValueExact||0,decimal.MONEY_SCALE);}
  const eligibilityByLine=new Map();let coveredQuantity=0n,affectedExposure=0n;
  for(const row of eligibility){const eligible=decimal.parse(row.openingEligibleQuantityExact||0,decimal.QUANTITY_SCALE),unknown=decimal.parse(row.unknownQuantityExact||0,decimal.QUANTITY_SCALE),sale=decimal.parse(row.saleExposureExact||0,decimal.MONEY_SCALE);coveredQuantity+=eligible;if(unknown>0n&&eligible>0n)affectedExposure+=decimal.divideRounded(sale*eligible,unknown);const key=clean(row.saleLineIdentity,500);const current=eligibilityByLine.get(key)||0n;eligibilityByLine.set(key,current+eligible);}
  const knownByLine=new Map();for(const row of allocations){const key=clean(row.saleLineId||row.originalSaleLineId,500);if(!key||row.sourceType==='unknown_cost')continue;const quantity=decimal.parse(row.quantityExact??row.allocatedQty??0,decimal.QUANTITY_SCALE);knownByLine.set(key,(knownByLine.get(key)||0n)+quantity);}
  let totalQuantity=0n,currentCoveredQuantity=0n,totalSaleValue=0n,currentCoveredSaleValue=0n,currentCoveredLines=0,totalLines=0,provenLines=0,provenQuantity=0n,provenSaleValue=0n,projectedFullyProvenLines=0;
  for(const fact of facts){const key=clean(fact.saleLineIdentity,500),quantity=decimal.parse(fact.quantityExact||0,decimal.QUANTITY_SCALE),sale=decimal.parse(fact.saleAmountExact||0,decimal.MONEY_SCALE);if(quantity<=0n)continue;totalLines++;totalQuantity+=quantity;totalSaleValue+=sale;const knownRaw=knownByLine.get(key)||0n,known=knownRaw<0n?0n:knownRaw>quantity?quantity:knownRaw,projectedRaw=known+(eligibilityByLine.get(key)||0n),projected=projectedRaw>quantity?quantity:projectedRaw;if(known>0n)currentCoveredLines++;currentCoveredQuantity+=known;currentCoveredSaleValue+=decimal.divideRounded(sale*known,quantity);if(fact.profitProvenanceStatus==='PROVEN'){provenLines++;provenQuantity+=quantity;provenSaleValue+=sale;}if(projected===quantity)projectedFullyProvenLines++;}
  const projectedLineSet=new Set([...knownByLine.entries()].filter(([,value])=>value>0n).map(([key])=>key));for(const [key,value] of eligibilityByLine)if(value>0n)projectedLineSet.add(key);const projectedCoveredLines=Math.min(totalLines,projectedLineSet.size),projectedCoveredQuantity=currentCoveredQuantity+coveredQuantity>totalQuantity?totalQuantity:currentCoveredQuantity+coveredQuantity,projectedCoveredSaleValue=currentCoveredSaleValue+affectedExposure>totalSaleValue?totalSaleValue:currentCoveredSaleValue+affectedExposure;
  const summary={datasetId:dataset.datasetId,baseDate:clean(dataset.openingDate,8),schemaVersion:Number(dataset.schemaVersion||SCHEMA_VERSION),algorithmVersion:clean(dataset.algorithmVersion||MODULE_VERSION,100),itemCount:Number(dataset.itemCount||0),validatedItemCount:Number(dataset.statusCounts?.VALIDATED_CANDIDATE||0),noOpeningStockCount:Number(dataset.statusCounts?.NO_OPENING_STOCK||0),incompleteItemCount:Number(dataset.statusCounts?.INCOMPLETE_SOURCE||0),totalOpeningQuantityExact:decimal.format(openingQuantity,decimal.QUANTITY_SCALE),totalOpeningAccountingValueExact:decimal.format(openingValue,decimal.MONEY_SCALE),potentiallyCoveredSaleLines:[...eligibilityByLine.entries()].filter(([,value])=>value>0n).length,potentiallyCoveredSaleQuantityExact:decimal.format(coveredQuantity,decimal.QUANTITY_SCALE),affectedSaleExposureExact:decimal.format(affectedExposure,decimal.MONEY_SCALE),controlFifoDatasetId:clean(dataset.eligibilityPreview?.fifoDatasetId,100),activePurchaseDatasetId:clean(purchaseState?.activeDatasetId,100),coverageDefinition:'quantity-weighted authoritative source coverage on immutable control FIFO; partial lines count as source-covered',currentCoverage:{linePercent:percent(BigInt(currentCoveredLines),BigInt(totalLines)),quantityPercent:percent(currentCoveredQuantity,totalQuantity),saleValuePercent:percent(currentCoveredSaleValue,totalSaleValue)},projectedCoverage:{linePercent:percent(BigInt(projectedCoveredLines),BigInt(totalLines)),quantityPercent:percent(projectedCoveredQuantity,totalQuantity),saleValuePercent:percent(projectedCoveredSaleValue,totalSaleValue)},provenProfitCoverage:{currentLinePercent:percent(BigInt(provenLines),BigInt(totalLines)),currentQuantityPercent:percent(provenQuantity,totalQuantity),currentSaleValuePercent:percent(provenSaleValue,totalSaleValue),projectedFullyProvenLinePercent:percent(BigInt(projectedFullyProvenLines),BigInt(totalLines))}};
  return {evidence,progress,eligibility,datasetFingerprint,sourceFingerprint,eligibilityFingerprint,summary,duplicates:{evidenceIds:0,progressIds:0,eligibilityIds:0},terminalRecordCount:terminalProgress.length,financialAuthority:false};
}
function delay(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function terminalWarehouse(status){return status==='SUCCESS_POSITIVE'||status==='SUCCESS_ZERO';}
function classifyFailure(result,error){
  const message=clean(error?.message||result?.error||result?.message,500).toLowerCase();
  if(/timeout|timed out|abort/.test(message))return 'TRANSIENT_TIMEOUT';
  if(result?.meta?.reachedLimit)return 'PAGE_TRUNCATION';
  if(/kardex page \d+ failed/.test(message))return 'HTTP_FAILURE';
  if(/http|status\s*[45]\d\d|econn|socket|network/.test(message))return 'HTTP_FAILURE';
  if(/parse|json|syntax/.test(message))return 'PARSER_FAILURE';
  if(/empty|no response/.test(message))return 'EMPTY_UNEXPECTED_RESPONSE';
  if(/warehouse|stock/.test(message))return 'WAREHOUSE_SPECIFIC_FAILURE';
  if(result?.permanent===true)return 'PERMANENT_SOURCE_FAILURE';
  return 'OTHER';
}
function normalizeItem(item={}){return {itemGuid:clean(item.itemGuid,100),itemCode:clean(item.itemCode,100),itemDescription:clean(item.itemDescription,500),requiredQuantityExact:clean(item.requiredQuantityExact??item.saleQuantity,100),saleLineCount:Number(item.saleLineCount||0),saleExposure:Number((item.saleExposure??item.saleAmount)||0),firstSaleDate:clean(item.firstSaleDate,8),lastSaleDate:clean(item.lastSaleDate,8)};}
function compactKardexResult(result={}){
  const rows=Array.isArray(result.rows)?result.rows:[],earliest=rows.slice().sort((a,b)=>String(a.date||'').localeCompare(String(b.date||''))||Number(a.invoiceNumber||0)-Number(b.invoiceNumber||0))[0];
  return {ok:Boolean(result.ok),item:result.item?{itemGuid:clean(result.item.itemGuid,100),itemCode:clean(result.item.itemCode,100),itemDescription:clean(result.item.itemDescription,500)}:null,openingBasis:result.openingBasis?{openingQuantity:result.openingBasis.openingQuantity,openingTotalValue:result.openingBasis.openingTotalValue,openingUnitCost:result.openingBasis.openingUnitCost,sourceFields:result.openingBasis.sourceFields||{}}:null,rows:earliest?[earliest]:[],meta:{reachedLimit:Boolean(result.meta?.reachedLimit),stockNumber:clean(result.meta?.stockNumber,100),openingDate:clean(result.meta?.openingDate,8),rawRowCount:Number(result.meta?.rawRowCount||rows.length)}};
}
function progressId(datasetId,item){return `${datasetId}:${itemIdentity(item)}`;}
async function seedProgress(db,datasetId,items,warehouses,openingDate,now){
  for(const item of items){
    const id=progressId(datasetId,item),existing=await db.collection(PROGRESS).findOne({progressId:id});if(existing)continue;
    await db.collection(PROGRESS).insertOne({progressId:id,datasetId,canonicalIdentity:itemIdentity(item),item,openingDate,status:'pending',selectionState:'queued',firstQueuedAt:now,nextEligibleAt:now,warehouseStates:warehouses.map(warehouseNumber=>({warehouseNumber,status:'pending',attemptCount:0,attempts:[]})),sourceCallCount:0,createdAt:now,updatedAt:now});
  }
}

const RESUMABLE_PROGRESS_STATUSES = ['pending','INCOMPLETE_SOURCE'];
const DETERMINISTIC_PROGRESS_SORT = {nextEligibleAt:1,firstQueuedAt:1,createdAt:1,progressId:1};
const RECOVERY_PROGRESS_SORT = {selectionStartedAt:1,firstQueuedAt:1,createdAt:1,progressId:1};
function progressEligibility(datasetId,now=new Date()){
  return {datasetId,status:{$in:RESUMABLE_PROGRESS_STATUSES},$and:[{$or:[{nextEligibleAt:{$exists:false}},{nextEligibleAt:null},{nextEligibleAt:{$lte:now}}]}]};
}
function explicitResumeSelector(options={}){
  const fields=[['progressId',clean(options.targetProgressId,250)],['canonicalIdentity',clean(options.targetCanonicalIdentity,200)],['item.itemCode',clean(options.targetItemCode,100)]].filter(([,value])=>value);
  if(fields.length>1)fail('OPENING_RESUME_TARGET_SELECTOR_INVALID','Only one explicit Opening target selector is allowed.');
  return fields[0]||null;
}
async function selectResumeProgress(db,datasetId,options={},limit=1,now=new Date()){
  const eligible=progressEligibility(datasetId,now),selector=explicitResumeSelector(options);
  if(selector){
    const [field,value]=selector,query={...eligible,[field]:value};
    const rows=await db.collection(PROGRESS).find(query).sort(DETERMINISTIC_PROGRESS_SORT).limit(2).toArray();
    if(rows.length!==1)fail(rows.length?'OPENING_RESUME_TARGET_AMBIGUOUS':'OPENING_RESUME_TARGET_NOT_ELIGIBLE',rows.length?'Explicit Opening target is ambiguous.':'Explicit Opening target is not part of this Dataset or is not currently eligible.',409);
    return rows;
  }
  const recovering=await db.collection(PROGRESS).find({...eligible,selectionState:'in_progress'}).sort(RECOVERY_PROGRESS_SORT).limit(1).toArray();
  if(recovering.length)return recovering;
  return db.collection(PROGRESS).find({...eligible,selectionState:{$ne:'in_progress'}}).sort(DETERMINISTIC_PROGRESS_SORT).limit(limit).toArray();
}
async function markProgressInFlight(db,row,ownerId,now=new Date()){
  const result=await db.collection(PROGRESS).updateOne({progressId:row.progressId,datasetId:row.datasetId,status:{$in:RESUMABLE_PROGRESS_STATUSES}},{$set:{selectionState:'in_progress',selectionOwnerId:clean(ownerId,200),selectionStartedAt:row.selectionState==='in_progress'?(row.selectionStartedAt||now):now,updatedAt:now}});
  if(!result.matchedCount)fail('OPENING_RESUME_PROGRESS_CLAIM_CONFLICT','Opening progress changed before it could be claimed.',409);
  return {...row,selectionState:'in_progress',selectionOwnerId:clean(ownerId,200),selectionStartedAt:row.selectionState==='in_progress'?(row.selectionStartedAt||now):now,updatedAt:now};
}
async function attemptWarehouse(db,progress,warehouseState,options={}){
  const api=options.shaygan||shaygan,maxRows=Math.max(1,Math.min(Number(options.maxRows||200),500)),timeoutMs=Math.max(500,Math.min(Number(options.timeoutMs||15000),30000));
  const maxAttempts=Math.max(1,Math.min(Number(options.maxAttempts||3),5)),backoffMs=Math.max(0,Math.min(Number(options.backoffMs??2000),10000));
  let state={...warehouseState,attempts:Array.isArray(warehouseState.attempts)?warehouseState.attempts:[]};
  const firstAttempt=state.attemptCount,stopAt=firstAttempt+maxAttempts;
  for(let n=firstAttempt;n<stopAt&&!terminalWarehouse(state.status);n++){
    if(n>firstAttempt&&backoffMs)await delay(backoffMs*(2**Math.min(n-firstAttempt-1,3)));
    const startedAt=new Date(),started=Date.now();let result,error;
    try{result=await api.getKardexByItemCode(progress.item.itemCode,state.warehouseNumber,{maxRows,hardMaxRows:maxRows,timeoutMs,dateFrom:progress.openingDate,beforeSourceCall:options.resourceGovernor?context=>options.resourceGovernor.beforeCall({...context,progressId:progress.progressId}):undefined,afterSourceCall:options.resourceGovernor?observation=>options.resourceGovernor.afterCall(observation):undefined});}
    catch(caught){if(caught?.openingPaused)throw caught;error=caught;result={ok:false,error:clean(caught?.message||caught,500),meta:{}};}
    result.meta={...(result.meta||{}),stockNumber:state.warehouseNumber,openingDate:progress.openingDate};
    const basis=result?.openingBasis,success=result?.ok===true&&!result?.meta?.reachedLimit;
    const status=success&&(basis&&Number(basis.openingQuantity)>0&&Number(basis.openingTotalValue)>0)?'SUCCESS_POSITIVE':success?'SUCCESS_ZERO':'failed';
    const failureClass=success?'':classifyFailure(result,error);
    const attempt={attemptNumber:n+1,startedAt,completedAt:new Date(),durationMs:Date.now()-started,success,terminalStatus:success?status:'',failureClass,error:success?'':clean(error?.message||result?.error||'source-request-failed',500),sourceMeta:{reachedLimit:Boolean(result?.meta?.reachedLimit),stockNumber:state.warehouseNumber}};
    state={...state,status:success?status:failureClass,attemptCount:n+1,lastAttemptAt:attempt.completedAt,nextEligibleRetry:success?null:new Date(Date.now()+backoffMs*(2**Math.min(n-firstAttempt,3))),lastFailureClass:failureClass,lastError:attempt.error,attempts:[...state.attempts,attempt],result:success?compactKardexResult(result):undefined};
    await db.collection(PROGRESS).updateOne({progressId:progress.progressId},{$set:{warehouseStates:progress.warehouseStates.map(row=>row.warehouseNumber===state.warehouseNumber?state:row),updatedAt:new Date()},$inc:{sourceCallCount:1}});
    progress.warehouseStates=progress.warehouseStates.map(row=>row.warehouseNumber===state.warehouseNumber?state:row);
    if(options.resourceGovernor?.breakerState==='open')throw openingResourceGovernor._pauseError('OPENING_BREAKER_OPEN','Opening extraction circuit breaker is open.');
    if(success)break;
  }
  if(!terminalWarehouse(state.status))state={...state,status:'INCOMPLETE_SOURCE'};
  return state;
}
async function processProgress(db,progress,options={}){
  const started=Date.now();
  for(const warehouse of progress.warehouseStates){
    if(terminalWarehouse(warehouse.status))continue;
    const updated=await attemptWarehouse(db,progress,warehouse,options);
    progress.warehouseStates=progress.warehouseStates.map(row=>row.warehouseNumber===updated.warehouseNumber?updated:row);
    const interval=Math.max(0,Math.min(Number(options.requestIntervalMs??100),5000));if(interval)await delay(interval);
  }
  const complete=progress.warehouseStates.every(row=>terminalWarehouse(row.status));
  const entries=progress.warehouseStates.filter(row=>terminalWarehouse(row.status)).map(row=>({warehouseNumber:row.warehouseNumber,result:row.result,included:true}));
  const aggregate=complete?aggregateWarehouseKardex(entries,new Date()):null;
  const status=!complete?'INCOMPLETE_SOURCE':aggregate?.status==='NO_OPENING_STOCK'?'NO_OPENING_STOCK':aggregate?.ok===false?'INCOMPLETE_SOURCE':'VALIDATED_CANDIDATE';
  const incompleteRetries=progress.warehouseStates.filter(row=>!terminalWarehouse(row.status)&&row.nextEligibleRetry).map(row=>new Date(row.nextEligibleRetry)).sort((a,b)=>a-b),updatedAt=new Date();
  await db.collection(PROGRESS).updateOne({progressId:progress.progressId},{$set:{warehouseStates:progress.warehouseStates,status,selectionState:status==='INCOMPLETE_SOURCE'?'queued':'completed',selectionOwnerId:'',selectionCompletedAt:updatedAt,nextEligibleAt:status==='INCOMPLETE_SOURCE'?(incompleteRetries[0]||updatedAt):null,completedWarehouseCount:progress.warehouseStates.filter(row=>terminalWarehouse(row.status)).length,incompleteWarehouseCount:progress.warehouseStates.filter(row=>!terminalWarehouse(row.status)).length,lastRunDurationMs:Date.now()-started,updatedAt}});
  return {status,aggregate};
}
function evidenceRecord(dataset,progress,aggregate,now){
  const result=aggregate?.status==='NO_OPENING_STOCK'?aggregate:{...aggregate,status:'VALIDATED_CANDIDATE'};
  const base={...result,datasetId:dataset.datasetId,schemaVersion:SCHEMA_VERSION,algorithmVersion:MODULE_VERSION,openingDate:dataset.openingDate,canonicalIdentity:progress.canonicalIdentity,itemGuid:clean(result.itemGuid||progress.item.itemGuid,100),itemCode:clean(result.itemCode||progress.item.itemCode,100),itemDescription:clean(result.itemDescription||progress.item.itemDescription,500),requiredQuantityExact:progress.item.requiredQuantityExact,saleLineCount:progress.item.saleLineCount,saleExposure:progress.item.saleExposure,firstSaleDate:progress.item.firstSaleDate,lastSaleDate:progress.item.lastSaleDate,approvalStatus:'draft',active:false,createdAt:now,immutable:true};
  const recordFingerprint=hash({...base,createdAt:undefined,extractedAt:undefined,warehouseEvidence:(base.warehouseEvidence||[]).map(row=>({...row,extractedAt:undefined}))});
  return {...base,recordFingerprint,sourceFingerprint:clean(result.sourceFingerprint||recordFingerprint,64),sourceEvidenceId:clean(result.evidenceId,100),evidenceId:`OACB-${dataset.datasetId.slice(5)}-${recordFingerprint.slice(0,16)}`};
}
async function latestFifoDatasetId(db,input={}){
  if(clean(input.fifoDatasetId,100))return clean(input.fifoDatasetId,100);
  const state=await db.collection('fifoDatasetState').findOne({scopeKey:'sale-fifo'}).catch(()=>null);
  if(clean(state?.activeDatasetId,100))return clean(state.activeDatasetId,100);
  const latest=await db.collection('fifoDatasets').findOne({status:'completed'},{sort:{completedAt:-1,createdAt:-1}}).catch(()=>null);return clean(latest?.datasetId,100);
}
async function buildEligibilityPreview(db,dataset,input={}){
  const fifoDatasetId=await latestFifoDatasetId(db,input),now=new Date();if(!fifoDatasetId)return {rowCount:0,itemCount:0,fingerprint:hash([]),fifoDatasetId:'',reason:'FIFO_SOURCE_UNAVAILABLE'};
  const purchaseState=await db.collection('purchaseLayerDatasetState').findOne({scopeKey:'purchase-invoices-types-3-7'}).catch(()=>null),purchaseDatasetId=clean(purchaseState?.activeDatasetId,100);
  const [evidence,allocations,purchaseLayers]=await Promise.all([db.collection(COLLECTION).find({datasetId:dataset.datasetId,status:'VALIDATED_CANDIDATE'}).toArray(),db.collection('fifoAllocations').find({datasetId:fifoDatasetId}).sort({saleDate:1,saleInvoiceNo:1,saleRow:1,allocationSequence:1}).toArray(),purchaseDatasetId?db.collection('supplierPurchaseLayers').find({datasetId:purchaseDatasetId,layerKind:'purchase'}).toArray():[]]);
  const rows=[];
  for(const opening of evidence){
    const matching=allocations.filter(row=>{
      const openingGuid=clean(opening.itemGuid,100),allocationGuid=clean(row.itemGuid,100);
      if(openingGuid&&allocationGuid)return openingGuid===allocationGuid;
      return clean(row.itemCode,100)===clean(opening.itemCode,100);
    });
    const groups=new Map();for(const row of matching){const id=clean(row.saleLineId,500)||`${row.saleInvoiceType}:${row.saleInvoiceNo}:${row.saleRow||row.row}`;if(!groups.has(id))groups.set(id,[]);groups.get(id).push(row);}
    let remaining=decimal.parse(opening.openingQuantityExact,decimal.QUANTITY_SCALE);
    for(const [saleLineIdentity,lineRows] of [...groups].sort((a,b)=>String(a[1][0]?.saleDate||'').localeCompare(String(b[1][0]?.saleDate||''))||Number(a[1][0]?.saleInvoiceNo||0)-Number(b[1][0]?.saleInvoiceNo||0))){
      const first=lineRows[0],unknownRows=lineRows.filter(row=>row.sourceType==='unknown_cost'),unknownQty=unknownRows.reduce((sum,row)=>sum+decimal.parse(row.quantityExact||row.unknownQty||0,decimal.QUANTITY_SCALE),0n);
      if(unknownQty<=0n)continue;
      const saleDate=clean(first.saleDate,8);let classification,eligible=0n;
      if(saleDate<dataset.openingDate)classification='PRE_OPENING_PERIOD';
      else if(remaining<=0n)classification='OPENING_CAPACITY_EXHAUSTED';
      else{eligible=unknownQty<remaining?unknownQty:remaining;remaining-=eligible;classification=eligible===unknownQty?'OPENING_ELIGIBLE':'OPENING_PARTIAL';}
      const itemPurchases=purchaseLayers.filter(layer=>{
        const openingGuid=clean(opening.itemGuid,100),layerGuid=clean(layer.itemGuid,100);
        if(openingGuid&&layerGuid)return openingGuid===layerGuid;
        return clean(layer.itemCode,100)===clean(opening.itemCode,100);
      }).filter(layer=>clean(layer.costStatus,100)!=='pending-purchase-price-correction'&&!['rejected','invalid'].includes(clean(layer.validationStatus,100)));
      const earlier=itemPurchases.filter(layer=>clean(layer.purchaseInvoiceDate,8)<=saleDate),later=itemPurchases.filter(layer=>clean(layer.purchaseInvoiceDate,8)>saleDate);
      const saleExposureExact=lineRows.reduce((sum,row)=>sum+decimal.parse(row.allocatedSaleValueExact||row.allocatedSaleValue||0,decimal.MONEY_SCALE),0n);
      rows.push({previewId:`OEL-${hash(`${dataset.datasetId}|${saleLineIdentity}`).slice(0,24)}`,datasetId:dataset.datasetId,fifoDatasetId,purchaseDatasetId,saleLineIdentity,saleInvoiceNo:Number(first.saleInvoiceNo||0),saleRow:Number(first.saleRow||first.row||0),saleDate,itemGuid:opening.itemGuid,itemCode:opening.itemCode,unknownQuantityExact:decimal.format(unknownQty,decimal.QUANTITY_SCALE),openingEligibleQuantityExact:decimal.format(eligible,decimal.QUANTITY_SCALE),remainingUnknownQuantityExact:decimal.format(unknownQty-eligible,decimal.QUANTITY_SCALE),saleExposureExact:decimal.format(saleExposureExact,decimal.MONEY_SCALE),earlierOfficialPurchaseAvailable:earlier.length>0,earlierOfficialPurchaseCount:earlier.length,laterPurchaseAvailable:later.length>0,laterPurchaseCount:later.length,officialPurchaseAllocationPreserved:lineRows.some(row=>row.sourceType!=='unknown_cost'),classification,openingEvidenceId:opening.evidenceId,openingSourceFingerprint:opening.sourceFingerprint,approvalStatus:'draft',readOnlyPreview:true,createdAt:now});
    }
  }
  const fingerprint=hash(rows.map(row=>[row.previewId,row.classification,row.openingEligibleQuantityExact]));
  if(rows.length)await db.collection(ELIGIBILITY).insertMany(rows.map(row=>({...row,previewFingerprint:fingerprint})));
  return {rowCount:rows.length,itemCount:new Set(rows.map(row=>row.itemGuid||row.itemCode)).size,fingerprint,fifoDatasetId};
}
async function finalizeDataset(db,dataset,options={}){
  const progress=await db.collection(PROGRESS).find({datasetId:dataset.datasetId}).toArray(),now=new Date();
  for(const row of progress){
    if(row.status==='INCOMPLETE_SOURCE'||row.status==='pending')continue;
    const existing=await db.collection(COLLECTION).findOne({datasetId:dataset.datasetId,canonicalIdentity:row.canonicalIdentity});if(existing)continue;
    const entries=row.warehouseStates.map(state=>({warehouseNumber:state.warehouseNumber,result:state.result,included:true}));const aggregate=aggregateWarehouseKardex(entries,now);if(aggregate?.ok===false)continue;
    await db.collection(COLLECTION).insertOne(evidenceRecord(dataset,row,aggregate,now));
  }
  const refreshed=await db.collection(PROGRESS).find({datasetId:dataset.datasetId}).toArray(),statusCounts=refreshed.reduce((map,row)=>(map[row.status]=(map[row.status]||0)+1,map),{}),complete=refreshed.every(row=>['VALIDATED_CANDIDATE','NO_OPENING_STOCK'].includes(row.status));
  const records=await db.collection(COLLECTION).find({datasetId:dataset.datasetId}).toArray(),datasetFingerprint=hash(records.map(row=>[row.canonicalIdentity,row.status,row.recordFingerprint]).sort((a,b)=>String(a[0]).localeCompare(String(b[0]))));
  let eligibility={rowCount:0,itemCount:0,fingerprint:hash([]),fifoDatasetId:'',reason:'DATASET_INCOMPLETE'};if(complete)eligibility=await buildEligibilityPreview(db,dataset,options);
  const status=complete?'completed':'incomplete',approvalStatus=complete?'validated':'incomplete';
  await db.collection(DATASETS).updateOne({datasetId:dataset.datasetId},{$set:{status,approvalStatus,active:false,statusCounts,sourceCallCount:refreshed.reduce((sum,row)=>sum+Number(row.sourceCallCount||0),0),completedItemCount:records.length,incompleteItemCount:refreshed.filter(row=>row.status==='INCOMPLETE_SOURCE').length,datasetFingerprint,eligibilityPreview:eligibility,completedAt:complete?now:null,updatedAt:now}});
  await db.collection(STATE).updateOne({scopeKey:'opening-accounting-evidence'},{$set:{scopeKey:'opening-accounting-evidence',latestCandidateId:dataset.datasetId,latestCandidateFingerprint:datasetFingerprint,updatedAt:now},$setOnInsert:{createdAt:now}},{upsert:true});
  return {ok:true,datasetId:dataset.datasetId,status,approvalStatus,active:false,itemCount:records.length,statusCounts,sourceCallCount:refreshed.reduce((sum,row)=>sum+Number(row.sourceCallCount||0),0),datasetFingerprint,eligibilityPreview:eligibility,purchaseLayerWrites:0,fifoWrites:0,manualCostWrites:0};
}
async function runCandidate(db,dataset,options={}){
  const governorOptions={...options,testMode:options.testMode===true||Boolean(options.shaygan&&options.shaygan!==shaygan)};
  const resourceGovernor=options.resourceGovernor||openingResourceGovernor.createGovernor(db,dataset.datasetId,governorOptions),config=resourceGovernor.config;
  await resourceGovernor.acquire();
  try{
    await resourceGovernor.preflight();
    const targetSelector=explicitResumeSelector(options);
    if(targetSelector&&(config.batchSize!==1||config.maxBatchesPerRun!==1||config.maxConcurrency!==1))fail('OPENING_RESUME_TARGET_REQUIRES_SINGLE_ITEM_GOVERNOR','Explicit Opening target requires concurrency=1, batchSize=1 and maxBatchesPerRun=1.',409);
    let explicitPending=targetSelector?await selectResumeProgress(db,dataset.datasetId,options,1):null;
    if(options.incrementResume===true){const resumedAt=new Date();await db.collection(DATASETS).updateOne({datasetId:dataset.datasetId},{$set:{status:'building',lastResumedBy:actor(options.resumeRequestedBy),lastResumedAt:resumedAt,updatedAt:resumedAt},$inc:{resumeCount:1}});}
    let batches=0,processed=0;
    while(batches<config.maxBatchesPerRun){
      const pending=explicitPending||await selectResumeProgress(db,dataset.datasetId,options,config.batchSize);explicitPending=null;
      if(!pending.length)break;
      for(const row of pending){const claimed=await markProgressInFlight(db,row,resourceGovernor.ownerId);await processProgress(db,claimed,{...options,concurrency:1,resourceGovernor});processed++;}
      batches++;const [pendingItems,incompleteItems,completedItems]=await Promise.all([db.collection(PROGRESS).countDocuments({datasetId:dataset.datasetId,status:'pending'}),db.collection(PROGRESS).countDocuments({datasetId:dataset.datasetId,status:'INCOMPLETE_SOURCE'}),db.collection(PROGRESS).countDocuments({datasetId:dataset.datasetId,status:{$in:['VALIDATED_CANDIDATE','NO_OPENING_STOCK']}})]);
      await resourceGovernor.batchCheckpoint({batchNumber:batches,batchSize:pending.length,processedItems:processed,pendingItems,incompleteItems,completedItems,worstCaseRepeatedWork:'one in-flight warehouse Kardex path; completed warehouse checkpoints are never repeated'});
      if(targetSelector||pendingItems===0)break;
    }
    const pendingItems=await db.collection(PROGRESS).countDocuments({datasetId:dataset.datasetId,status:'pending'});
    if(pendingItems>0){const now=new Date(),progress=await db.collection(PROGRESS).find({datasetId:dataset.datasetId}).toArray(),statusCounts=progress.reduce((map,row)=>(map[row.status]=(map[row.status]||0)+1,map),{});await db.collection(DATASETS).updateOne({datasetId:dataset.datasetId},{$set:{status:'paused',approvalStatus:'draft',active:false,pauseReason:'BATCH_LIMIT_REACHED',statusCounts,updatedAt:now}});await resourceGovernor.persist({state:'paused',pauseReason:'BATCH_LIMIT_REACHED',batchProgress:{batches,processedItems:processed,pendingItems}});return {ok:true,datasetId:dataset.datasetId,status:'paused',approvalStatus:'draft',active:false,pauseReason:'BATCH_LIMIT_REACHED',processedItems:processed,pendingItems,resourceGovernor:{config,ownerId:resourceGovernor.ownerId},purchaseLayerWrites:0,fifoWrites:0,manualCostWrites:0};}
    return finalizeDataset(db,dataset,options);
  }catch(error){
    if(!error?.openingPaused)throw error;
    const now=new Date(),progress=await db.collection(PROGRESS).find({datasetId:dataset.datasetId}).toArray(),statusCounts=progress.reduce((map,row)=>(map[row.status]=(map[row.status]||0)+1,map),{});
    await db.collection(DATASETS).updateOne({datasetId:dataset.datasetId},{$set:{status:'paused',approvalStatus:'draft',active:false,pauseReason:clean(error.code||'OPENING_RESOURCE_GOVERNOR_PAUSED',200),statusCounts,updatedAt:now}});
    await resourceGovernor.persist({state:'paused',pauseReason:clean(error.code||'OPENING_RESOURCE_GOVERNOR_PAUSED',200)});
    return {ok:true,datasetId:dataset.datasetId,status:'paused',approvalStatus:'draft',active:false,pauseReason:clean(error.code||'OPENING_RESOURCE_GOVERNOR_PAUSED',200),resourceGovernor:{config,ownerId:resourceGovernor.ownerId},purchaseLayerWrites:0,fifoWrites:0,manualCostWrites:0};
  }finally{await resourceGovernor.release('paused','run-ended');}
}
async function buildCandidate(db,input={},options={}){
  const openingDate=sourceDate(input.openingDate),items=(Array.isArray(input.items)?input.items:[]).map(normalizeItem).filter(item=>item.itemCode);if(!items.length)fail('OPENING_CANDIDATE_ITEMS_REQUIRED','opening candidate items required');
  const warehouses=await governedWarehouses(db,input.stockNumbers);if(!warehouses.length)fail('OPENING_WAREHOUSE_SCOPE_UNPROVEN','governed warehouse scope required');
  const now=new Date(),datasetId=candidateId(now),createdBy=actor(input.createdBy),dataset={datasetId,schemaVersion:SCHEMA_VERSION,algorithmVersion:MODULE_VERSION,status:'building',approvalStatus:'draft',revision:1,active:false,openingDate,governedWarehouses:warehouses,itemCount:items.length,createdBy,createdAt:now,updatedAt:now,immutableEvidence:true,resumable:true,sourceContract:{endpoint:'Item/GetKardex',quantityField:'BeginDurationRemainQuan1',valueField:'BeginDurationRemainPrice1',readOnly:true,retry:{maxAttempts:Math.max(1,Math.min(Number(options.maxAttempts||3),5)),boundedBackoff:true},terminalWarehouseStatuses:['SUCCESS_POSITIVE','SUCCESS_ZERO']}};
  await db.collection(DATASETS).insertOne(dataset);await seedProgress(db,datasetId,items,warehouses,openingDate,now);return runCandidate(db,dataset,options);
}
async function resumeCandidate(db,datasetId,input={},requestedBy={},options={}){
  const dataset=await db.collection(DATASETS).findOne({datasetId:clean(datasetId,100)});if(!dataset)fail('OPENING_CANDIDATE_NOT_FOUND','Opening Candidate یافت نشد.',404);if(dataset.status==='completed')fail('OPENING_CANDIDATE_IMMUTABLE','Candidate کامل و immutable است.',409);if(!['building','paused','incomplete','failed'].includes(dataset.status))fail('OPENING_CANDIDATE_NOT_RESUMABLE','وضعیت Candidate قابل Resume نیست.',409);
  return runCandidate(db,{...dataset,status:'building'},{...options,...input,incrementResume:true,resumeRequestedBy:requestedBy});
}
async function ensureResourceGovernorIndexes(db){
  const names=await openingResourceGovernor.ensureIndexes(db);
  names.push(await db.collection(PROGRESS).createIndex({datasetId:1,status:1,selectionState:1,nextEligibleAt:1,firstQueuedAt:1,createdAt:1,progressId:1},{name:'opening_resume_deterministic_selection'}));
  names.push(await db.collection(DATASETS).createIndex({status:1,approvalStatus:1,authorityLifecycleStatus:1,datasetId:1},{name:'opening_authority_resolution'}));
  return names;
}

function authorityLifecycleStatus(dataset={}){
  const explicit=clean(dataset.authorityLifecycleStatus,50).toUpperCase();
  if(Object.values(AUTHORITY_LIFECYCLE).includes(explicit))return explicit;
  return clean(dataset.approvalStatus,50)==='approved'?AUTHORITY_LIFECYCLE.APPROVED:clean(dataset.approvalStatus,50).toUpperCase();
}
function storedAuthoritySnapshot(dataset={}){
  return {
    datasetFingerprint:clean(dataset.datasetFingerprint,64),
    sourceFingerprint:clean(dataset.lastGovernanceEvent?.sourceAggregateFingerprint||dataset.sourceAggregateFingerprint,64),
    eligibilityFingerprint:clean(dataset.eligibilityPreview?.fingerprint||dataset.lastGovernanceEvent?.eligibilityFingerprint,64),
    summary:dataset.financialApprovalSummary||dataset.lastGovernanceEvent?.financialApprovalSummary||null
  };
}
function evaluateAuthorityDataset(dataset={}){
  const lifecycleStatus=authorityLifecycleStatus(dataset);
  const eligible=dataset.status==='completed'&&dataset.approvalStatus==='approved'&&lifecycleStatus===AUTHORITY_LIFECYCLE.APPROVED;
  return {eligible,lifecycleStatus,reason:eligible?'ELIGIBLE':dataset.status!=='completed'?'SOURCE_NOT_COMPLETED':dataset.approvalStatus!=='approved'?'NOT_APPROVED':lifecycleStatus};
}
async function resolveOpeningAuthority(db,input={}){
  const requestedDatasetId=clean(input.datasetId,100);
  let candidates=[];
  if(requestedDatasetId){
    const dataset=await db.collection(DATASETS).findOne({datasetId:requestedDatasetId});
    if(!dataset)fail('OPENING_AUTHORITY_NOT_FOUND','Opening authority یافت نشد.',409);
    candidates=[dataset];
  }else{
    candidates=await db.collection(DATASETS).find({status:'completed',approvalStatus:'approved',$or:[{authorityLifecycleStatus:{$exists:false}},{authorityLifecycleStatus:{$in:['APPROVED','approved']}}]}).sort({datasetId:1}).limit(3).toArray();
  }
  const eligible=candidates.filter(dataset=>evaluateAuthorityDataset(dataset).eligible);
  if(requestedDatasetId&&!eligible.length){
    const state=evaluateAuthorityDataset(candidates[0]);
    fail(state.lifecycleStatus==='REVOKED'?'OPENING_AUTHORITY_REVOKED':state.lifecycleStatus==='SUPERSEDED'?'OPENING_AUTHORITY_SUPERSEDED':'OPENING_AUTHORITY_INELIGIBLE',`Opening authority برای ساخت مالی جدید مجاز نیست: ${state.reason}`,409);
  }
  if(!requestedDatasetId&&eligible.length===0)fail('OPENING_AUTHORITY_NOT_FOUND','Opening authority مصوب و واجد شرایط وجود ندارد.',409);
  if(!requestedDatasetId&&eligible.length!==1)fail('OPENING_AUTHORITY_AMBIGUOUS','بیش از یک Opening authority مصوب و واجد شرایط وجود دارد؛ انتخاب خودکار ممنوع است.',409);
  const dataset=eligible[0],snapshot=storedAuthoritySnapshot(dataset);
  return {ok:true,readOnly:true,datasetId:dataset.datasetId,approvalStatus:dataset.approvalStatus,lifecycleStatus:AUTHORITY_LIFECYCLE.APPROVED,revision:Number(dataset.revision||1),fingerprints:{dataset:snapshot.datasetFingerprint,source:snapshot.sourceFingerprint,eligibility:snapshot.eligibilityFingerprint},financialApprovalSummary:snapshot.summary,dataset};
}

async function lifecycleAction(db,datasetId,action,input={},requestedBy={}){
  const dataset=await db.collection(DATASETS).findOne({datasetId:clean(datasetId,100)});
  if(!dataset)fail('OPENING_CANDIDATE_NOT_FOUND','Opening Candidate یافت نشد.',404);
  const current=actor(requestedBy);
  if(!GOVERNANCE_ROLES.includes(current.role))fail('OPENING_LIFECYCLE_ROLE_FORBIDDEN','Revoke/Supersede فقط توسط Admin/Accounting/Purchase مجاز است.',403);
  const reason=clean(input.reason,1000);
  if(!reason)fail('OPENING_LIFECYCLE_REASON_REQUIRED','دلیل اقدام حاکمیتی الزامی است.');
  const expectedRevision=Number(input.revision||dataset.revision||1);
  if(Number(dataset.revision||1)!==expectedRevision)fail('OPENING_APPROVAL_REVISION_CONFLICT','نسخه Dataset تغییر کرده است.',409);
  const state=evaluateAuthorityDataset(dataset);
  if(!state.eligible)fail('OPENING_LIFECYCLE_NOT_APPROVED','فقط Opening authority مصوب و فعال قابل Revoke/Supersede است.',409);
  const snapshot=await immutableGovernanceSnapshot(db,dataset),expected=input.expectedFingerprints||{};
  if(clean(expected.dataset,64)&&clean(expected.dataset,64)!==snapshot.datasetFingerprint)fail('OPENING_GOVERNANCE_EXPECTED_FINGERPRINT_MISMATCH','Dataset fingerprint mismatch.',409);
  if(clean(expected.source,64)&&clean(expected.source,64)!==snapshot.sourceFingerprint)fail('OPENING_GOVERNANCE_EXPECTED_FINGERPRINT_MISMATCH','Source fingerprint mismatch.',409);
  if(clean(expected.eligibility,64)&&clean(expected.eligibility,64)!==snapshot.eligibilityFingerprint)fail('OPENING_GOVERNANCE_EXPECTED_FINGERPRINT_MISMATCH','Eligibility fingerprint mismatch.',409);
  let successor=null,successorSnapshot=null;
  if(action==='supersede'){
    const successorDatasetId=clean(input.successorDatasetId,100);
    if(!successorDatasetId||successorDatasetId===dataset.datasetId)fail('OPENING_SUCCESSOR_REQUIRED','یک successor مستقل و صریح الزامی است.',409);
    successor=await db.collection(DATASETS).findOne({datasetId:successorDatasetId});
    if(!successor||!evaluateAuthorityDataset(successor).eligible)fail('OPENING_SUCCESSOR_INELIGIBLE','Successor باید مستقلاً authority مصوب و فعال باشد.',409);
    successorSnapshot=storedAuthoritySnapshot(successor);
  }
  const now=new Date(),nextRevision=expectedRevision+1,newState=action==='revoke'?AUTHORITY_LIFECYCLE.REVOKED:AUTHORITY_LIFECYCLE.SUPERSEDED;
  const event={approvalEventId:`OAPA-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,datasetId:dataset.datasetId,action:action.toUpperCase(),fromStatus:AUTHORITY_LIFECYCLE.APPROVED,toStatus:newState,previousAuthorityState:AUTHORITY_LIFECYCLE.APPROVED,newAuthorityState:newState,actor:current,reason,at:now,revisionBefore:expectedRevision,revision:nextRevision,datasetFingerprint:snapshot.datasetFingerprint,sourceAggregateFingerprint:snapshot.sourceFingerprint,eligibilityFingerprint:snapshot.eligibilityFingerprint,financialApprovalSummary:snapshot.summary,supersededDatasetId:action==='supersede'?dataset.datasetId:'',successorDatasetId:successor?.datasetId||'',successorAuthorityState:successor?authorityLifecycleStatus(successor):'',successorFingerprints:successorSnapshot?{dataset:successorSnapshot.datasetFingerprint,source:successorSnapshot.sourceFingerprint,eligibility:successorSnapshot.eligibilityFingerprint}:null,immutable:true};
  const set={authorityLifecycleStatus:newState,authorityLifecycleUpdatedAt:now,authorityLifecycleUpdatedBy:current,authorityLifecycleReason:reason,revision:nextRevision,updatedAt:now,lastGovernanceEvent:event};
  if(action==='revoke'){set.revokedAt=now;set.revokedBy=current;set.revocationReason=reason;}
  else{set.supersededAt=now;set.supersededBy=current;set.supersessionReason=reason;set.successorDatasetId=successor.datasetId;}
  const result=await db.collection(DATASETS).updateOne({datasetId:dataset.datasetId,revision:expectedRevision},{$set:set,$push:{governanceAuditLog:event}});
  if(!result.matchedCount)fail('OPENING_APPROVAL_REVISION_CONFLICT','نسخه Dataset تغییر کرده است.',409);
  await db.collection(APPROVALS).insertOne(event);
  return {ok:true,datasetId:dataset.datasetId,approvalStatus:dataset.approvalStatus,lifecycleStatus:newState,revision:nextRevision,successorDatasetId:successor?.datasetId||'',active:false,financialApprovalSummary:snapshot.summary,fifoWrites:0,purchaseWrites:0,evidenceWrites:0};
}
async function refreshEligibilityPreview(db,datasetId,input={},requestedBy={}){
  const dataset=await db.collection(DATASETS).findOne({datasetId:clean(datasetId,100)});if(!dataset)fail('OPENING_CANDIDATE_NOT_FOUND','Opening Candidate یافت نشد.',404);
  if(dataset.status!=='completed'||dataset.approvalStatus!=='validated')fail('OPENING_PREVIEW_REFRESH_FORBIDDEN','فقط Candidate کامل و هنوز ارسال‌نشده قابل بازسازی Preview است.',409);
  const current=actor(requestedBy);if(!['admin','accounting'].includes(current.role))fail('OPENING_PREVIEW_REFRESH_ROLE_FORBIDDEN','بازسازی Preview فقط برای Admin/Accounting مجاز است.',403);
  await db.collection(ELIGIBILITY).deleteMany({datasetId:dataset.datasetId});
  const eligibilityPreview=await buildEligibilityPreview(db,dataset,input),now=new Date();
  await db.collection(DATASETS).updateOne({datasetId:dataset.datasetId,status:'completed',approvalStatus:'validated'},{$set:{eligibilityPreview,previewRefreshedAt:now,previewRefreshedBy:current,updatedAt:now}});
  return {ok:true,datasetId:dataset.datasetId,eligibilityPreview,purchaseLayerWrites:0,fifoWrites:0,manualCostWrites:0};
}
async function approvalAction(db,datasetId,action,input={},requestedBy={}){
  const dataset=await db.collection(DATASETS).findOne({datasetId:clean(datasetId,100)});if(!dataset)fail('OPENING_CANDIDATE_NOT_FOUND','Opening Candidate یافت نشد.',404);
  const current=actor(requestedBy),now=new Date(),expectedRevision=Number(input.revision||dataset.revision||1);if(Number(dataset.revision||1)!==expectedRevision)fail('OPENING_APPROVAL_REVISION_CONFLICT','نسخه Dataset تغییر کرده است.',409);
  let from=clean(dataset.approvalStatus,50),to=from,humanValidation=null,selfApproval=false;
  if(action==='submit'){
    if(dataset.status!=='completed'||from!=='validated')fail('OPENING_CANDIDATE_NOT_SUBMITTABLE','فقط Candidate کامل و Validated قابل ارسال است.',409);
    if(!GOVERNANCE_ROLES.includes(current.role))fail('OPENING_SUBMIT_ROLE_FORBIDDEN','ارسال Opening فقط توسط Admin/Accounting/Purchase مجاز است.',403);
    if(!clean(input.reason,1000))fail('OPENING_SUBMIT_REASON_REQUIRED','دلیل ارسال الزامی است.');
    humanValidation=normalizeHumanValidation(input);to='pending';
  }else{
    if(from!=='pending')fail('OPENING_APPROVAL_NOT_PENDING','Candidate در انتظار تأیید نیست.',409);
    if(![...GOVERNANCE_ROLES,...INDEPENDENT_LEGACY_APPROVER_ROLES].includes(current.role))fail('OPENING_APPROVAL_ROLE_FORBIDDEN','نقش کاربر برای تصمیم Opening مجاز نیست.',403);
    selfApproval=clean(dataset.submittedBy?.username,100)===current.username;
    if(selfApproval&&(!GOVERNANCE_ROLES.includes(current.role)||input.managementAuthorizedSelfApproval!==true))fail('OPENING_APPROVAL_SELF_APPROVAL_AUTHORIZATION_REQUIRED','Self-approval فقط با مجوز صریح Management و نقش governed مجاز است.',403);
    if(!clean(input.reason,1000))fail('OPENING_APPROVAL_REASON_REQUIRED','دلیل تصمیم الزامی است.');to=action==='approve'?'approved':action==='reject'?'rejected':'deferred';
  }
  const snapshot=await immutableGovernanceSnapshot(db,dataset),expected=input.expectedFingerprints||{};
  if(clean(expected.dataset,64)&&clean(expected.dataset,64)!==snapshot.datasetFingerprint)fail('OPENING_GOVERNANCE_EXPECTED_FINGERPRINT_MISMATCH','Dataset fingerprint با مقدار مورد انتظار تطابق ندارد.',409);
  if(clean(expected.source,64)&&clean(expected.source,64)!==snapshot.sourceFingerprint)fail('OPENING_GOVERNANCE_EXPECTED_FINGERPRINT_MISMATCH','Source fingerprint با مقدار مورد انتظار تطابق ندارد.',409);
  if(clean(expected.eligibility,64)&&clean(expected.eligibility,64)!==snapshot.eligibilityFingerprint)fail('OPENING_GOVERNANCE_EXPECTED_FINGERPRINT_MISMATCH','Eligibility fingerprint با مقدار مورد انتظار تطابق ندارد.',409);
  const nextRevision=expectedRevision+1,event={action,fromStatus:from,toStatus:to,actor:current,reason:clean(input.reason,1000),at:now,revision:nextRevision,datasetFingerprint:snapshot.datasetFingerprint,sourceAggregateFingerprint:snapshot.sourceFingerprint,eligibilityFingerprint:snapshot.eligibilityFingerprint,baseDate:clean(dataset.openingDate,8),schemaVersion:Number(dataset.schemaVersion||SCHEMA_VERSION),algorithmVersion:clean(dataset.algorithmVersion||MODULE_VERSION,100),evidenceIds:snapshot.evidence.map(row=>clean(row.evidenceId,100)).sort(),sourceFingerprints:snapshot.evidence.map(row=>clean(row.sourceFingerprint,64)).filter(Boolean).sort(),financialApprovalSummary:snapshot.summary,selfApproval,managementAuthorizedSelfApproval:selfApproval&&input.managementAuthorizedSelfApproval===true,immutable:true};
  const auditEvents=[];
  if(humanValidation)auditEvents.push({approvalEventId:`OAPA-${Date.now()}-validation-${crypto.randomBytes(4).toString('hex')}`,datasetId:dataset.datasetId,action:'human-validation-checkpoint',fromStatus:from,toStatus:from,actor:current,reason:'Management-confirmed Production Human validation checkpoint',at:now,revision:nextRevision,datasetFingerprint:snapshot.datasetFingerprint,sourceAggregateFingerprint:snapshot.sourceFingerprint,eligibilityFingerprint:snapshot.eligibilityFingerprint,humanValidationCheckpoint:humanValidation,financialApprovalSummary:snapshot.summary,immutable:true});
  const persistedEvent={approvalEventId:`OAPA-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,datasetId:dataset.datasetId,...event};auditEvents.push(persistedEvent);
  const set={approvalStatus:to,revision:nextRevision,updatedAt:now,lastGovernanceEvent:persistedEvent,financialApprovalSummary:snapshot.summary};if(action==='submit'){set.submittedBy=current;set.submittedAt=now;set.submissionReason=event.reason;set.humanValidationCheckpoint=humanValidation;}else{set.decidedBy=current;set.decidedAt=now;set.decisionReason=event.reason;set.approvalAuthorization=selfApproval?'management-authorized-self-approval':'independent-approval';if(action==='approve')set.authorityLifecycleStatus=AUTHORITY_LIFECYCLE.APPROVED;}
  const result=await db.collection(DATASETS).updateOne({datasetId:dataset.datasetId,revision:expectedRevision},{$set:set,$push:{governanceAuditLog:{$each:auditEvents}}});if(!result.matchedCount)fail('OPENING_APPROVAL_REVISION_CONFLICT','نسخه Dataset تغییر کرده است.',409);
  await db.collection(APPROVALS).insertMany(auditEvents);
  return {ok:true,datasetId:dataset.datasetId,approvalStatus:to,revision:nextRevision,active:false,selfApproval,sourceAggregateFingerprint:snapshot.sourceFingerprint,financialApprovalSummary:snapshot.summary,fifoWrites:0,manualCostWrites:0};
}
async function listCandidates(db,input={}){const limit=Math.max(1,Math.min(Number(input.limit||20),100));const list=(await db.collection(DATASETS).find({}).sort({createdAt:-1}).limit(limit).toArray()).map(dataset=>({...dataset,authorityLifecycleStatus:authorityLifecycleStatus(dataset)}));return {ok:true,readOnly:true,list};}
async function candidateDetail(db,datasetId,input={}){const dataset=await db.collection(DATASETS).findOne({datasetId:clean(datasetId,100)});if(!dataset)return {ok:false,code:'OPENING_CANDIDATE_NOT_FOUND'};const item=clean(input.item,100),query={datasetId:dataset.datasetId};if(clean(input.status,50))query.status=clean(input.status,50);if(item)query.$or=[{itemCode:item},{itemGuid:item}];const [rows,progress,approvalHistory,eligibility]=await Promise.all([db.collection(COLLECTION).find(query).sort({saleExposure:-1,itemCode:1}).limit(5000).toArray(),db.collection(PROGRESS).find(item?{datasetId:dataset.datasetId,$or:[{'item.itemCode':item},{'item.itemGuid':item}]}:{datasetId:dataset.datasetId}).limit(5000).toArray(),db.collection(APPROVALS).find({datasetId:dataset.datasetId}).sort({at:1}).toArray(),db.collection(ELIGIBILITY).find(item?{datasetId:dataset.datasetId,$or:[{itemCode:item},{itemGuid:item}]}:{datasetId:dataset.datasetId}).sort({saleDate:1,saleInvoiceNo:1,saleRow:1}).limit(5000).toArray()]);let resolvableQuantity=0n,saleExposure=0n,remaining=0n;for(const row of eligibility){resolvableQuantity+=decimal.parse(row.openingEligibleQuantityExact||0,decimal.QUANTITY_SCALE);remaining+=decimal.parse(row.remainingUnknownQuantityExact||0,decimal.QUANTITY_SCALE);saleExposure+=decimal.parse(row.saleExposureExact||0,decimal.MONEY_SCALE);}const impactPreview={authorityClass:dataset.approvalStatus==='approved'?'APPROVED':dataset.status==='completed'?'VALIDATED_NOT_APPROVED':'INCOMPLETE',resolvableLines:eligibility.filter(row=>Number(row.openingEligibleQuantityExact)>0).length,resolvableQuantityExact:decimal.format(resolvableQuantity,decimal.QUANTITY_SCALE),remainingUnknownQuantityExact:decimal.format(remaining,decimal.QUANTITY_SCALE),saleExposureExact:decimal.format(saleExposure,decimal.MONEY_SCALE),fifoWrites:0};let financialApprovalSummary=dataset.financialApprovalSummary||null,governanceSnapshot=null;if(!item&&dataset.status==='completed'){try{governanceSnapshot=await immutableGovernanceSnapshot(db,dataset);if(!financialApprovalSummary)financialApprovalSummary=governanceSnapshot.summary;}catch(_){governanceSnapshot=null;}}const authorityPreview={precedence:APPROVAL_PRECEDENCE,openingDatasetId:dataset.datasetId,approvalStatus:dataset.approvalStatus,sourceAggregateFingerprint:governanceSnapshot?.sourceFingerprint||clean(dataset.lastGovernanceEvent?.sourceAggregateFingerprint,64),discoverableForFutureFifo:dataset.approvalStatus==='approved',activationPointerRequired:false,existingFifoMutated:false,sample:eligibility.filter(row=>Number(row.openingEligibleQuantityExact)>0).slice(0,10).map(row=>({saleLineIdentity:row.saleLineIdentity,itemCode:row.itemCode,sourceClass:dataset.approvalStatus==='approved'?'APPROVED_OPENING_ACCOUNTING_COST':'VALIDATED_OPENING_REVIEW_ONLY',evidenceId:row.openingEvidenceId,quantityCapacityExact:row.openingEligibleQuantityExact,chronology:row.classification}))};return {ok:true,readOnly:true,dataset,rows,progress,approvalHistory,eligibility,impactPreview,financialApprovalSummary,authorityPreview};}

async function candidateDetailGoverned(db,datasetId,input={}){
  const result=await candidateDetail(db,datasetId,input);
  if(!result.ok)return result;
  const authority=evaluateAuthorityDataset(result.dataset);
  result.dataset.authorityLifecycleStatus=authority.lifecycleStatus;
  result.authorityPreview.lifecycleStatus=authority.lifecycleStatus;
  result.authorityPreview.discoverableForFutureFifo=authority.eligible;
  result.impactPreview.authorityClass=authority.eligible?'APPROVED':authority.lifecycleStatus;
  return result;
}

module.exports={COLLECTION,DATASETS,STATE,PROGRESS,APPROVALS,ELIGIBILITY,MODULE_VERSION,SCHEMA_VERSION,SOURCE_CLASS,GOVERNANCE_ROLES,APPROVAL_PRECEDENCE,AUTHORITY_LIFECYCLE,fromKardex,aggregateWarehouseKardex,materialize,buildCandidate,resumeCandidate,refreshEligibilityPreview,submitCandidate:(db,id,input,user)=>approvalAction(db,id,'submit',input,user),approveCandidate:(db,id,input,user)=>approvalAction(db,id,'approve',input,user),rejectCandidate:(db,id,input,user)=>approvalAction(db,id,'reject',input,user),deferCandidate:(db,id,input,user)=>approvalAction(db,id,'defer',input,user),revokeAuthority:(db,id,input,user)=>lifecycleAction(db,id,'revoke',input,user),supersedeAuthority:(db,id,input,user)=>lifecycleAction(db,id,'supersede',input,user),resolveOpeningAuthority,listCandidates,candidateDetail:candidateDetailGoverned,buildEligibilityPreview,runtimeStatus:openingResourceGovernor.runtimeStatus,ensureResourceGovernorIndexes,_authorityLifecycleStatus:authorityLifecycleStatus,_evaluateAuthorityDataset:evaluateAuthorityDataset,_storedAuthoritySnapshot:storedAuthoritySnapshot,_extractItem:extractItem,_classifyFailure:classifyFailure,_compactKardexResult:compactKardexResult,_hash:hash,_sourceAggregateFingerprint:sourceAggregateFingerprint,_immutableGovernanceSnapshot:immutableGovernanceSnapshot,_legacyBuildCandidate:buildCandidateLegacy,_selectResumeProgress:selectResumeProgress,_markProgressInFlight:markProgressInFlight,_deterministicProgressSort:()=>({...DETERMINISTIC_PROGRESS_SORT})};
