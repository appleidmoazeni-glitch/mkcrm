'use strict';

const crypto = require('crypto');
const shaygan = require('./shaygan');
const decimal = require('./accounting-decimal');
const { canonicalSaleDate } = require('./jalali-date');

const COLLECTION = 'openingAccountingCostBasis';
const MODULE_VERSION = 'opening-accounting-cost-basis-1.1.0';
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
    const evidence=fromKardex(entry.result||entry,extractedAt);
    if(!evidence)continue;
    const row={...evidence,warehouseNumber,warehouseName:clean(entry.warehouseName,300),included:entry.included!==false,exclusionReason:entry.included===false?clean(entry.reason||'warehouse-not-operationally-relevant',300):''};
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
  if(!included.length)return null;
  const dates=[...new Set(included.map(row=>row.effectiveOpeningDate))];
  if(dates.length!==1)return {ok:false,sourceClass:SOURCE_CLASS,code:'OPENING_PERIOD_MISMATCH',openingDates:dates,warehouseEvidence,duplicates,extractionComplete:false};
  const roundedCosts=[...new Set(included.map(row=>roundedRial(row.openingUnitCostExact).toString()))];
  if(roundedCosts.length!==1)return {ok:false,sourceClass:SOURCE_CLASS,code:'OPENING_WAREHOUSE_COST_CONFLICT',warehouseEvidence,duplicates,extractionComplete:false,requiresSeparateEvidenceLayers:true};
  let quantity=0n,totalValue=0n;
  for(const row of included){quantity+=decimal.parse(row.openingQuantityExact,decimal.QUANTITY_SCALE);totalValue+=decimal.parse(row.openingTotalValueExact,decimal.MONEY_SCALE);}
  if(quantity<=0n||totalValue<=0n)return null;
  const quantityExact=decimal.format(quantity,decimal.QUANTITY_SCALE);
  const totalValueExact=decimal.format(totalValue,decimal.MONEY_SCALE);
  const unitCostScaleFactor=10n**BigInt(decimal.UNIT_COST_SCALE+decimal.QUANTITY_SCALE-decimal.MONEY_SCALE);
  const unitCostExact=decimal.format(decimal.divideRounded(totalValue*unitCostScaleFactor,quantity),decimal.UNIT_COST_SCALE);
  const first=included.map(row=>row.earliestMovement).filter(Boolean).sort((a,b)=>String(a.date).localeCompare(String(b.date)))[0]||null;
  const evidence={sourceClass:SOURCE_CLASS,sourceEndpoint:'Item/GetKardex',itemGuid:included.find(row=>row.itemGuid)?.itemGuid||'',itemCode:included.find(row=>row.itemCode)?.itemCode||'',itemDescription:included.find(row=>row.itemDescription)?.itemDescription||'',effectiveOpeningDate:dates[0],openingQuantityExact:quantityExact,openingUnitCostExact:unitCostExact,openingTotalValueExact:totalValueExact,sourceFields:{quantity:'BeginDurationRemainQuan1',totalValue:'BeginDurationRemainPrice1',aggregation:'sum-by-distinct-operational-warehouse'},earliestMovement:first,evidenceScope:'global-active-warehouses',warehouseEvidence,warehouseCount:included.length,excludedWarehouseCount:warehouseEvidence.length-included.length,duplicateWarehouseCount:duplicates.length,duplicates,evidenceQuality:'PROVEN_GLOBAL_WAREHOUSE_AGGREGATION',aggregationMethod:'SUM_QUANTITY_AND_VALUE_WEIGHTED_UNIT_COST',extractionComplete:true,extractedAt};
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
  if(!evidence) return {ok:false,itemCode,materialized:false,code:'OPENING_BASIS_NOT_DETERMINISTIC',readOnlySource:true};
  if(evidence.ok===false)return {ok:false,itemCode,materialized:false,code:evidence.code,details:evidence,readOnlySource:true};
  const now=new Date();
  await db.collection(COLLECTION).updateOne({itemCode:evidence.itemCode,sourceFingerprint:evidence.sourceFingerprint},{$setOnInsert:{...evidence,moduleVersion:MODULE_VERSION,status:'available',createdAt:now},$set:{lastVerifiedAt:now,updatedAt:now}},{upsert:true});
  return {ok:true,itemCode,evidenceId:evidence.evidenceId,sourceFingerprint:evidence.sourceFingerprint,warehouseCount:evidence.warehouseCount,openingQuantityExact:evidence.openingQuantityExact,materialized:true,readOnlySource:true,purchaseLayerWrites:0,fifoWrites:0};
}

module.exports={COLLECTION,MODULE_VERSION,SOURCE_CLASS,fromKardex,aggregateWarehouseKardex,materialize,_hash:hash};
