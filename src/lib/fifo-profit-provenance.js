'use strict';

/*
 * Canonical FIFO profit provenance projection.
 *
 * This module performs no I/O. It converts immutable allocation rows into a
 * bounded, auditable cost-source array and proves quantity/money conservation
 * before a line may expose full FIFO profit.
 */
const crypto = require('crypto');
const decimal = require('./accounting-decimal');

const STATUSES = Object.freeze({ PROVEN:'PROVEN', PARTIAL:'PARTIAL', UNKNOWN:'UNKNOWN' });
const COST_SOURCE_TYPES = Object.freeze({
  OFFICIAL_PURCHASE_LAYER:'OFFICIAL_PURCHASE_LAYER',
  MULTI_PURCHASE_LAYER:'MULTI_PURCHASE_LAYER',
  MANUAL_COST_PURCHASE_LAYER:'MANUAL_COST_PURCHASE_LAYER',
  MANUAL_COST_ITEM_LEGACY:'MANUAL_COST_ITEM_LEGACY',
  MANUAL_COST_OPENING_BASIS:'MANUAL_COST_OPENING_BASIS',
  MANUAL_COST_HISTORICAL_EVIDENCE:'MANUAL_COST_HISTORICAL_EVIDENCE',
  OPENING_INVENTORY_EVIDENCE:'OPENING_INVENTORY_EVIDENCE',
  UNKNOWN:'UNKNOWN'
});

function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}
function stable(value){if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function sha(value){return crypto.createHash('sha256').update(String(value)).digest('hex');}
function parse(value,scale){return decimal.parse(value==null||value===''?0:value,scale);}
function exact(value,scale){return decimal.format(value,scale);}

function allocationSourceType(row={}){
  const source=clean(row.sourceType,100);
  const reversed=source==='sale_return_reversal'?clean(row.reversedSourceType,100):source;
  if(reversed==='official_purchase_layer')return COST_SOURCE_TYPES.OFFICIAL_PURCHASE_LAYER;
  if(reversed==='approved_manual_purchase_layer')return COST_SOURCE_TYPES.MANUAL_COST_PURCHASE_LAYER;
  if(reversed==='approved_manual_opening_quantity')return COST_SOURCE_TYPES.MANUAL_COST_OPENING_BASIS;
  if(reversed==='approved_manual_evidence_quantity')return COST_SOURCE_TYPES.MANUAL_COST_HISTORICAL_EVIDENCE;
  if(reversed==='approved_manual_cost')return COST_SOURCE_TYPES.MANUAL_COST_ITEM_LEGACY;
  if(reversed==='opening_inventory_evidence')return COST_SOURCE_TYPES.OPENING_INVENTORY_EVIDENCE;
  return COST_SOURCE_TYPES.UNKNOWN;
}

function actor(value){return value&&typeof value==='object'?{username:clean(value.username||value.user,100),role:clean(value.role,50)}:null;}
function sourceProjection(row={},manual={}){
  const sourceType=allocationSourceType(row);
  const manualSource=[COST_SOURCE_TYPES.MANUAL_COST_PURCHASE_LAYER,COST_SOURCE_TYPES.MANUAL_COST_ITEM_LEGACY,COST_SOURCE_TYPES.MANUAL_COST_OPENING_BASIS,COST_SOURCE_TYPES.MANUAL_COST_HISTORICAL_EVIDENCE].includes(sourceType);
  const saleReturn=clean(row.sourceType,100)==='sale_return_reversal';
  return {
    allocationId:clean(row.allocationId,100),
    purchaseDatasetId:clean(row.purchaseDatasetId,100),
    purchaseLayerId:clean(row.purchaseLineIdentity,500),
    purchaseLineIdentity:clean(row.purchaseLineIdentity,500),
    purchaseInvoiceNumber:Number(row.purchaseInvoiceNo||0)||null,
    purchaseInvoiceDate:clean(row.purchaseInvoiceDate,8),
    supplierIdentity:clean(row.supplierAccountNumber,100),
    supplierName:clean(row.supplierName,200),
    allocatedQty:clean(row.quantityExact??row.allocatedQty??row.unknownQty,100),
    unitCostExact:row.unitCostExact==null?null:clean(row.unitCostExact,100),
    allocatedCostExact:row.allocatedCostAmountExact==null?null:clean(row.allocatedCostAmountExact,100),
    sourceType,
    manualCostResolutionId:manualSource?clean(row.manualResolutionId||manual.resolutionId,100):'',
    manualCostScope:manualSource?clean(row.manualCostScope||manual.resolutionScope||'item',50):'',
    revision:manualSource?Number(row.manualRevision||manual.revision||0):null,
    contentHash:manualSource?clean(row.manualContentHash||manual.contentHash,64):'',
    createdBy:manualSource?actor(row.manualCreatedBy||manual.createdBy):null,
    approvedBy:manualSource?actor(row.manualApprovedBy||manual.approvedBy):null,
    approvedAt:manualSource?(row.manualApprovedAt||manual.approvedAt||null):null,
    manualCostExact:manualSource?clean(row.manualCostExact||manual.manualCostExact||manual.manualCost,100):'',
    evidenceQuality:sourceType===COST_SOURCE_TYPES.MANUAL_COST_PURCHASE_LAYER?'GOVERNED_EXACT_LAYER':sourceType===COST_SOURCE_TYPES.MANUAL_COST_OPENING_BASIS?'GOVERNED_OPENING_ACCOUNTING_BASIS':sourceType===COST_SOURCE_TYPES.MANUAL_COST_HISTORICAL_EVIDENCE?'GOVERNED_BOUNDED_HISTORICAL_AVERAGE':sourceType===COST_SOURCE_TYPES.MANUAL_COST_ITEM_LEGACY?'GOVERNED_LEGACY_ITEM':sourceType===COST_SOURCE_TYPES.OFFICIAL_PURCHASE_LAYER?'OFFICIAL_PURCHASE_DOCUMENT':'UNPROVEN',
    warning:sourceType===COST_SOURCE_TYPES.MANUAL_COST_ITEM_LEGACY?'این هزینه به فاکتور خرید مشخص متصل نیست.':'',
    unknownReason:sourceType===COST_SOURCE_TYPES.UNKNOWN?clean(row.unknownReason,200):'',
    returnProvenance:saleReturn?{
      returnSource:clean(row.returnSource,100),
      returnInvoiceNumber:Number(row.returnInvoiceNo||row.saleInvoiceNo||0)||null,
      returnInvoiceGuid:clean(row.returnInvoiceGuid||row.saleGuid,100),
      returnDate:clean(row.returnDate||row.saleDate,8),
      originSaleInvoiceNumber:Number(row.originSaleInvoiceNo||0)||null,
      originSaleInvoiceGuid:clean(row.originSaleInvoiceGuid,100),
      originSaleLineId:clean(row.originalSaleLineId,500),
      reversedAllocationId:clean(row.originalAllocationId,100),
      linkageQuality:clean(row.returnLinkageQuality,100),
      linkageSource:clean(row.returnLinkageSource,100),
      linkageReference:clean(row.returnLinkageReference,200),
      restoredQuantityExact:clean(row.quantityExact?String(row.quantityExact).replace(/^-/,''):row.restoredQuantity,100),
      restoredCostAmountExact:row.restoredCostAmountExact==null?null:clean(row.restoredCostAmountExact,100),
      returnOperatorAccountNumber:clean(row.returnOperatorAccountNumber,100),
      returnOperatorName:clean(row.returnOperatorName,200)
    }:null
  };
}

function lineProvenance(rows=[],input={}){
  const manualById=input.manualById instanceof Map?input.manualById:new Map();
  const sources=rows.map(row=>sourceProjection(row,manualById.get(clean(row.manualResolutionId,100))||{}));
  const requiredQty=parse(input.saleQtyExact??input.saleQty??rows[0]?.soldQuantity??0,decimal.QUANTITY_SCALE);
  const saleValue=parse(input.saleValueExact??input.saleValue??0,decimal.MONEY_SCALE);
  let knownQty=0n,unknownQty=0n,cost=0n;
  for(let i=0;i<rows.length;i++){
    const row=rows[i],source=sources[i];
    const quantity=parse(row.quantityExact??row.allocatedQty??row.unknownQty,decimal.QUANTITY_SCALE);
    if(source.sourceType===COST_SOURCE_TYPES.UNKNOWN||row.allocatedCostAmountExact==null){unknownQty+=quantity;continue;}
    knownQty+=quantity;
    cost+=parse(row.allocatedCostAmountExact,decimal.MONEY_SCALE);
  }
  const quantityConserved=knownQty+unknownQty===requiredQty;
  const costSources=sources.filter(row=>row.sourceType!==COST_SOURCE_TYPES.UNKNOWN);
  const costComplete=rows.length>0&&unknownQty===0n&&costSources.length===rows.length;
  const status=costComplete&&quantityConserved?STATUSES.PROVEN:(knownQty!==0n?STATUSES.PARTIAL:STATUSES.UNKNOWN);
  const officialCount=new Set(costSources.filter(row=>row.sourceType===COST_SOURCE_TYPES.OFFICIAL_PURCHASE_LAYER).map(row=>row.purchaseLineIdentity||row.purchaseLayerId||row.allocationId)).size;
  const distinctTypes=[...new Set(costSources.map(row=>row.sourceType))];
  const lineCostSourceType=status!==STATUSES.PROVEN?COST_SOURCE_TYPES.UNKNOWN:
    (officialCount>1&&distinctTypes.length===1?COST_SOURCE_TYPES.MULTI_PURCHASE_LAYER:(distinctTypes.length===1?distinctTypes[0]:COST_SOURCE_TYPES.MULTI_PURCHASE_LAYER));
  const fifoCostExact=status===STATUSES.PROVEN?exact(cost,decimal.MONEY_SCALE):null;
  const fifoProfitExact=status===STATUSES.PROVEN?exact(saleValue-cost,decimal.MONEY_SCALE):null;
  const reconciliation={
    quantityConserved,
    requiredQtyExact:exact(requiredQty,decimal.QUANTITY_SCALE),
    provenQtyExact:exact(knownQty,decimal.QUANTITY_SCALE),
    unknownQtyExact:exact(unknownQty,decimal.QUANTITY_SCALE),
    allocatedCostExact:fifoCostExact,
    saleValueExact:exact(saleValue,decimal.MONEY_SCALE),
    fifoProfitExact,
    moneyConserved:status===STATUSES.PROVEN&&saleValue-cost===parse(fifoProfitExact,decimal.MONEY_SCALE)
  };
  const canonicalSources=sources.map(source=>({...source,approvedAt:source.approvedAt instanceof Date?source.approvedAt.toISOString():source.approvedAt}));
  return {profitProvenanceStatus:status,costSourceType:lineCostSourceType,provenanceSources:sources,provenanceReconciliation:reconciliation,provenanceFingerprint:sha(stable(canonicalSources))};
}

module.exports={STATUSES,COST_SOURCE_TYPES,allocationSourceType,sourceProjection,lineProvenance,_stable:stable};
