'use strict';

const crypto = require('crypto');
const shaygan = require('./shaygan');
const decimal = require('./accounting-decimal');
const { canonicalSaleDate } = require('./jalali-date');

const COLLECTION = 'openingAccountingCostBasis';
const DATASETS = 'openingAccountingEvidenceDatasets';
const STATE = 'openingAccountingEvidenceState';
const MODULE_VERSION = 'opening-accounting-cost-basis-1.2.0';
const SCHEMA_VERSION = 2;
const SOURCE_CLASS = 'OPENING_ACCOUNTING_COST';

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
async function buildCandidate(db,input={},options={}){
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
async function listCandidates(db,input={}){const limit=Math.max(1,Math.min(Number(input.limit||20),100));const list=await db.collection(DATASETS).find({}).sort({createdAt:-1}).limit(limit).toArray();return {ok:true,readOnly:true,list};}
async function candidateDetail(db,datasetId,input={}){const dataset=await db.collection(DATASETS).findOne({datasetId:clean(datasetId,100)});if(!dataset)return {ok:false,code:'OPENING_CANDIDATE_NOT_FOUND'};const query={datasetId:dataset.datasetId};if(clean(input.status,50))query.status=clean(input.status,50);if(clean(input.item,100))query.$or=[{itemCode:clean(input.item,100)},{itemGuid:clean(input.item,100)}];const rows=await db.collection(COLLECTION).find(query).sort({saleExposure:-1,itemCode:1}).limit(Math.max(1,Math.min(Number(input.limit||5000),5000))).toArray();return {ok:true,readOnly:true,dataset,rows};}

module.exports={COLLECTION,DATASETS,STATE,MODULE_VERSION,SCHEMA_VERSION,SOURCE_CLASS,fromKardex,aggregateWarehouseKardex,materialize,buildCandidate,listCandidates,candidateDetail,_extractItem:extractItem,_hash:hash};
