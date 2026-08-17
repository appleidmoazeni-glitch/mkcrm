'use strict';

const crypto = require('crypto');
const shaygan = require('./shaygan');
const decimal = require('./accounting-decimal');
const { canonicalSaleDate } = require('./jalali-date');

const COLLECTION = 'openingAccountingCostBasis';
const MODULE_VERSION = 'opening-accounting-cost-basis-1.0.0';
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
  if (!first?.date) return null;
  const openingDate=sourceDate(first.date);
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
    sourceFields:basis.sourceFields,
    earliestMovement:{date:openingDate,invoiceType:Number(first.invoiceType||0),invoiceNumber:Number(first.invoiceNumber||0),inQuantityExact:exact(first.inQty||0,decimal.QUANTITY_SCALE),outQuantityExact:exact(first.outQty||0,decimal.QUANTITY_SCALE),remainingQuantityExact:exact(first.remainQty||0,decimal.QUANTITY_SCALE),costPriceExact:exact(first.costPrice||0,decimal.UNIT_COST_SCALE)},
    evidenceQuality:'PROVEN_SOURCE_SUMMARY_AND_FIRST_MOVEMENT',
    extractionComplete:true,
    extractedAt
  };
  evidence.sourceFingerprint=hash({...evidence,extractedAt:undefined});
  evidence.evidenceId=`OACB-${evidence.sourceFingerprint.slice(0,24)}`;
  return evidence;
}

async function materialize(db,input={},options={}) {
  const itemCode=clean(input.itemCode,100);
  if(!itemCode) throw Object.assign(new Error('itemCode required'),{code:'OPENING_BASIS_ITEM_REQUIRED'});
  const api=options.shaygan||shaygan;
  const maxRows=Math.max(1,Math.min(Number(options.maxRows||100),200));
  const timeoutMs=Math.max(500,Math.min(Number(options.timeoutMs||5000),15000));
  const result=await api.getKardexByItemCode(itemCode,'',{maxRows,hardMaxRows:maxRows,timeoutMs});
  const evidence=fromKardex(result,new Date());
  if(!evidence) return {ok:false,itemCode,materialized:false,code:'OPENING_BASIS_NOT_DETERMINISTIC',readOnlySource:true};
  const now=new Date();
  await db.collection(COLLECTION).updateOne({itemCode:evidence.itemCode,sourceFingerprint:evidence.sourceFingerprint},{$setOnInsert:{...evidence,moduleVersion:MODULE_VERSION,status:'available',createdAt:now},$set:{lastVerifiedAt:now,updatedAt:now}},{upsert:true});
  return {ok:true,itemCode,evidenceId:evidence.evidenceId,sourceFingerprint:evidence.sourceFingerprint,materialized:true,readOnlySource:true,purchaseLayerWrites:0,fifoWrites:0};
}

module.exports={COLLECTION,MODULE_VERSION,SOURCE_CLASS,fromKardex,materialize,_hash:hash};
