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
function actor(value={}) { return {username:clean(value.username||value.user,100),role:clean(value.role,50)}; }
function fail(code,message,statusCode=400){throw Object.assign(new Error(message),{code,statusCode});}
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
    await db.collection(PROGRESS).insertOne({progressId:id,datasetId,canonicalIdentity:itemIdentity(item),item,openingDate,status:'pending',warehouseStates:warehouses.map(warehouseNumber=>({warehouseNumber,status:'pending',attemptCount:0,attempts:[]})),sourceCallCount:0,createdAt:now,updatedAt:now});
  }
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
  await db.collection(PROGRESS).updateOne({progressId:progress.progressId},{$set:{warehouseStates:progress.warehouseStates,status,completedWarehouseCount:progress.warehouseStates.filter(row=>terminalWarehouse(row.status)).length,incompleteWarehouseCount:progress.warehouseStates.filter(row=>!terminalWarehouse(row.status)).length,lastRunDurationMs:Date.now()-started,updatedAt:new Date()}});
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
    if(options.incrementResume===true){const resumedAt=new Date();await db.collection(DATASETS).updateOne({datasetId:dataset.datasetId},{$set:{status:'building',lastResumedBy:actor(options.resumeRequestedBy),lastResumedAt:resumedAt,updatedAt:resumedAt},$inc:{resumeCount:1}});}
    let batches=0,processed=0;
    while(batches<config.maxBatchesPerRun){
      const pending=await db.collection(PROGRESS).find({datasetId:dataset.datasetId,status:{$in:['pending','INCOMPLETE_SOURCE']}}).sort({updatedAt:1,createdAt:1}).limit(config.batchSize).toArray();
      if(!pending.length)break;
      for(const row of pending){await processProgress(db,row,{...options,concurrency:1,resourceGovernor});processed++;}
      batches++;const [pendingItems,incompleteItems,completedItems]=await Promise.all([db.collection(PROGRESS).countDocuments({datasetId:dataset.datasetId,status:'pending'}),db.collection(PROGRESS).countDocuments({datasetId:dataset.datasetId,status:'INCOMPLETE_SOURCE'}),db.collection(PROGRESS).countDocuments({datasetId:dataset.datasetId,status:{$in:['VALIDATED_CANDIDATE','NO_OPENING_STOCK']}})]);
      await resourceGovernor.batchCheckpoint({batchNumber:batches,batchSize:pending.length,processedItems:processed,pendingItems,incompleteItems,completedItems,worstCaseRepeatedWork:'one in-flight warehouse Kardex path; completed warehouse checkpoints are never repeated'});
      if(pendingItems===0)break;
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
  const dataset=await db.collection(DATASETS).findOne({datasetId:clean(datasetId,100)});if(!dataset)fail('OPENING_CANDIDATE_NOT_FOUND','Opening Candidate یافت نشد.',404);const current=actor(requestedBy),now=new Date(),expectedRevision=Number(input.revision||dataset.revision||1);if(Number(dataset.revision||1)!==expectedRevision)fail('OPENING_APPROVAL_REVISION_CONFLICT','نسخه Dataset تغییر کرده است.',409);
  let from=clean(dataset.approvalStatus,50),to=from;if(action==='submit'){if(dataset.status!=='completed'||from!=='validated')fail('OPENING_CANDIDATE_NOT_SUBMITTABLE','فقط Candidate کامل و Validated قابل ارسال است.',409);to='pending';}
  else{if(from!=='pending')fail('OPENING_APPROVAL_NOT_PENDING','Candidate در انتظار تأیید نیست.',409);if(clean(dataset.submittedBy?.username,100)===current.username)fail('OPENING_APPROVAL_SELF_APPROVAL_FORBIDDEN','ایجادکننده/ارسال‌کننده نمی‌تواند تصمیم مستقل را تأیید کند.',403);if(!['admin','manager'].includes(current.role))fail('OPENING_APPROVAL_ROLE_FORBIDDEN','تأیید مستقل فقط توسط Admin/Manager مجاز است.',403);if(!clean(input.reason,1000))fail('OPENING_APPROVAL_REASON_REQUIRED','دلیل تصمیم الزامی است.');to=action==='approve'?'approved':action==='reject'?'rejected':'deferred';}
  const evidence=await db.collection(COLLECTION).find({datasetId:dataset.datasetId}).toArray();let quantity=0n,value=0n;for(const row of evidence){quantity+=decimal.parse(row.openingQuantityExact||0,decimal.QUANTITY_SCALE);value+=decimal.parse(row.openingTotalValueExact||0,decimal.MONEY_SCALE);}
  const nextRevision=expectedRevision+1,event={action,fromStatus:from,toStatus:to,actor:current,reason:clean(input.reason,1000),at:now,revision:nextRevision,datasetFingerprint:clean(dataset.datasetFingerprint,64),eligibilityFingerprint:clean(dataset.eligibilityPreview?.fingerprint,64),baseDate:clean(dataset.openingDate,8),schemaVersion:Number(dataset.schemaVersion||SCHEMA_VERSION),algorithmVersion:clean(dataset.algorithmVersion||MODULE_VERSION,100),evidenceIds:evidence.map(row=>clean(row.evidenceId,100)).sort(),sourceFingerprints:evidence.map(row=>clean(row.sourceFingerprint,64)).filter(Boolean).sort(),totals:{itemCount:Number(dataset.itemCount||0),completedItemCount:Number(dataset.completedItemCount||0),openingQuantityExact:decimal.format(quantity,decimal.QUANTITY_SCALE),openingValueExact:decimal.format(value,decimal.MONEY_SCALE),statusCounts:dataset.statusCounts||{}}};
  const set={approvalStatus:to,revision:nextRevision,updatedAt:now};if(action==='submit'){set.submittedBy=current;set.submittedAt=now;}else{set.decidedBy=current;set.decidedAt=now;set.decisionReason=event.reason;}
  const result=await db.collection(DATASETS).updateOne({datasetId:dataset.datasetId,revision:expectedRevision},{$set:set});if(!result.matchedCount)fail('OPENING_APPROVAL_REVISION_CONFLICT','نسخه Dataset تغییر کرده است.',409);
  await db.collection(APPROVALS).insertOne({approvalEventId:`OAPA-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,datasetId:dataset.datasetId,...event,immutable:true});
  return {ok:true,datasetId:dataset.datasetId,approvalStatus:to,revision:nextRevision,active:false,fifoWrites:0,manualCostWrites:0};
}
async function listCandidates(db,input={}){const limit=Math.max(1,Math.min(Number(input.limit||20),100));const list=await db.collection(DATASETS).find({}).sort({createdAt:-1}).limit(limit).toArray();return {ok:true,readOnly:true,list};}
async function candidateDetail(db,datasetId,input={}){const dataset=await db.collection(DATASETS).findOne({datasetId:clean(datasetId,100)});if(!dataset)return {ok:false,code:'OPENING_CANDIDATE_NOT_FOUND'};const item=clean(input.item,100),query={datasetId:dataset.datasetId};if(clean(input.status,50))query.status=clean(input.status,50);if(item)query.$or=[{itemCode:item},{itemGuid:item}];const [rows,progress,approvalHistory,eligibility]=await Promise.all([db.collection(COLLECTION).find(query).sort({saleExposure:-1,itemCode:1}).limit(5000).toArray(),db.collection(PROGRESS).find(item?{datasetId:dataset.datasetId,$or:[{'item.itemCode':item},{'item.itemGuid':item}]}:{datasetId:dataset.datasetId}).limit(5000).toArray(),db.collection(APPROVALS).find({datasetId:dataset.datasetId}).sort({at:1}).toArray(),db.collection(ELIGIBILITY).find(item?{datasetId:dataset.datasetId,$or:[{itemCode:item},{itemGuid:item}]}:{datasetId:dataset.datasetId}).sort({saleDate:1,saleInvoiceNo:1,saleRow:1}).limit(5000).toArray()]);let resolvableQuantity=0n,saleExposure=0n,remaining=0n;for(const row of eligibility){resolvableQuantity+=decimal.parse(row.openingEligibleQuantityExact||0,decimal.QUANTITY_SCALE);remaining+=decimal.parse(row.remainingUnknownQuantityExact||0,decimal.QUANTITY_SCALE);saleExposure+=decimal.parse(row.saleExposureExact||0,decimal.MONEY_SCALE);}const impactPreview={authorityClass:dataset.approvalStatus==='approved'?'APPROVED':dataset.status==='completed'?'VALIDATED_NOT_APPROVED':'INCOMPLETE',resolvableLines:eligibility.filter(row=>Number(row.openingEligibleQuantityExact)>0).length,resolvableQuantityExact:decimal.format(resolvableQuantity,decimal.QUANTITY_SCALE),remainingUnknownQuantityExact:decimal.format(remaining,decimal.QUANTITY_SCALE),saleExposureExact:decimal.format(saleExposure,decimal.MONEY_SCALE),fifoWrites:0};return {ok:true,readOnly:true,dataset,rows,progress,approvalHistory,eligibility,impactPreview};}

module.exports={COLLECTION,DATASETS,STATE,PROGRESS,APPROVALS,ELIGIBILITY,MODULE_VERSION,SCHEMA_VERSION,SOURCE_CLASS,fromKardex,aggregateWarehouseKardex,materialize,buildCandidate,resumeCandidate,refreshEligibilityPreview,submitCandidate:(db,id,input,user)=>approvalAction(db,id,'submit',input,user),approveCandidate:(db,id,input,user)=>approvalAction(db,id,'approve',input,user),rejectCandidate:(db,id,input,user)=>approvalAction(db,id,'reject',input,user),deferCandidate:(db,id,input,user)=>approvalAction(db,id,'defer',input,user),listCandidates,candidateDetail,buildEligibilityPreview,runtimeStatus:openingResourceGovernor.runtimeStatus,ensureResourceGovernorIndexes:openingResourceGovernor.ensureIndexes,_extractItem:extractItem,_classifyFailure:classifyFailure,_compactKardexResult:compactKardexResult,_hash:hash,_legacyBuildCandidate:buildCandidateLegacy};
