'use strict';

/*
 * Read-only reconciliation over immutable FIFO allocations and profit facts.
 * This module owns no collection and performs no source or accounting writes.
 */
const decimal = require('./accounting-decimal');
const fifo = require('./fifo-shadow-engine');
const ledger = require('./profit-commission-ledger');
const manualCost = require('./manual-cost-resolution');
const canonicalLayerContract = require('./canonical-purchase-layer-contract');
const { canonicalSaleDate } = require('./jalali-date');
const crypto = require('crypto');

function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}
function scaled(value,scale){return decimal.parse(value==null||value===''?0:value,scale);}
function exact(value,scale){return decimal.format(value,scale);}
function percent(value,total){return total===0n?'0.0000':decimal.format(decimal.divideRounded(value*1000000n,total),4);}
function add(map,key,row){if(!map.has(key))map.set(key,[]);map.get(key).push(row);}
function canonicalSourceDate(value){try{return canonicalSaleDate(value,{field:'purchaseInvoiceDate'});}catch(_){return '';}}
function stable(value){if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;return JSON.stringify(value);}
function manualFingerprint(rows){const identities=rows.filter(row=>row.status==='approved'&&row.deleted!==true).map(row=>[clean(row.resolutionId,100),Number(row.revision||0),clean(row.contentHash,64)||manualCost._contentHash({...row,manualCostExact:row.manualCostExact||manualCost._exactUnitCost(row.manualCost)})]).sort((a,b)=>a[0].localeCompare(b[0],'en'));return {count:identities.length,fingerprint:crypto.createHash('sha256').update(stable(identities)).digest('hex')};}
function coverage(rows){
  const sales=rows.filter(row=>Number(row.saleInvoiceType)===2);
  const complete=sales.filter(row=>row.costCoverageStatus==='complete'&&row.actualFifoProfitExact!=null&&(!row.profitProvenanceStatus||row.profitProvenanceStatus==='PROVEN'));
  const totalQty=sales.reduce((sum,row)=>sum+(scaled(row.quantityExact,decimal.QUANTITY_SCALE)<0n?-scaled(row.quantityExact,decimal.QUANTITY_SCALE):scaled(row.quantityExact,decimal.QUANTITY_SCALE)),0n);
  const completeQty=complete.reduce((sum,row)=>sum+(scaled(row.quantityExact,decimal.QUANTITY_SCALE)<0n?-scaled(row.quantityExact,decimal.QUANTITY_SCALE):scaled(row.quantityExact,decimal.QUANTITY_SCALE)),0n);
  const totalValue=sales.reduce((sum,row)=>sum+(scaled(row.saleAmountExact,decimal.MONEY_SCALE)<0n?-scaled(row.saleAmountExact,decimal.MONEY_SCALE):scaled(row.saleAmountExact,decimal.MONEY_SCALE)),0n);
  const completeValue=complete.reduce((sum,row)=>sum+(scaled(row.saleAmountExact,decimal.MONEY_SCALE)<0n?-scaled(row.saleAmountExact,decimal.MONEY_SCALE):scaled(row.saleAmountExact,decimal.MONEY_SCALE)),0n);
  const knownProfit=complete.reduce((sum,row)=>sum+scaled(row.actualFifoProfitExact,decimal.MONEY_SCALE),0n);
  return {line:{complete:complete.length,total:sales.length,percent:percent(BigInt(complete.length),BigInt(sales.length))},quantity:{completeExact:exact(completeQty,decimal.QUANTITY_SCALE),totalExact:exact(totalQty,decimal.QUANTITY_SCALE),percent:percent(completeQty,totalQty)},saleValue:{completeExact:exact(completeValue,decimal.MONEY_SCALE),totalExact:exact(totalValue,decimal.MONEY_SCALE),percent:percent(completeValue,totalValue)},profitKnown:{exact:exact(knownProfit,decimal.MONEY_SCALE),lineCount:complete.length,percent:percent(BigInt(complete.length),BigInt(sales.length))}};
}
function groupCoverage(rows,field){const grouped=new Map();for(const row of rows)add(grouped,clean(row[field],300)||'UNRESOLVED',row);return [...grouped].map(([identity,list])=>({identity,...coverage(list)})).sort((a,b)=>scaled(b.saleValue.totalExact,decimal.MONEY_SCALE)>scaled(a.saleValue.totalExact,decimal.MONEY_SCALE)?1:-1);}
function classifyUnknown(row){
  const reason=clean(row.unknownReason,200);
  if(['official_layer_quantity_exhausted','negative_inventory_chronology','purchase_chronology_problem'].includes(reason))return 'negative_inventory_chronology';
  if(reason==='ambiguous_manual_resolution')return 'identity_or_manual_cost_ambiguity';
  if(/return/i.test(reason))return 'purchase_return_affected';
  if(reason==='opening_inventory_candidate')return 'opening_inventory_candidate';
  if(reason==='purchase_identity_mismatch')return 'purchase_identity_mismatch';
  if(reason==='purchase_exists_but_invalid_cost')return 'purchase_exists_but_invalid_cost';
  if(reason==='purchase_history_outside_dataset_range')return 'purchase_history_outside_dataset_range';
  if(['no_valid_cost_source','no_purchase_history_available'].includes(reason))return 'no_purchase_history_available';
  return reason||'unsupported_or_unclassified';
}
async function report(db,input={}){
  const state=input.datasetId?null:await db.collection(fifo.STATE).findOne({scopeKey:fifo.SCOPE_KEY});
  const datasetId=clean(input.datasetId||state?.activeDatasetId,100);
  const dataset=datasetId?await db.collection(fifo.DATASETS).findOne({datasetId}):null;
  const active=dataset?{datasetId,dataset}:null;
  if(!active?.datasetId)return {ok:false,code:'FIFO_ACTIVE_DATASET_MISSING',reliable:false,readOnly:true};
  const [allocations,facts,exceptions,manualRows,purchaseLayers,officialPurchaseCache,saleState]=await Promise.all([
    db.collection(fifo.ALLOCATIONS).find({datasetId:active.datasetId}).toArray(),
    db.collection(ledger.FIFO_FACTS).find({fifoDatasetId:active.datasetId}).toArray(),
    db.collection(fifo.EXCEPTIONS).find({datasetId:active.datasetId}).toArray(),
    db.collection(manualCost.COLLECTION).find({status:'approved'}).toArray(),
    db.collection('supplierPurchaseLayers').find(canonicalLayerContract.canonicalLayerQuery({datasetId:active.dataset.sourcePurchaseDatasetId})).toArray(),
    db.collection('supplierPurchaseInvoices').find({}).toArray(),
    db.collection('saleSnapshotState').findOne({activeSnapshotId:{$exists:true}},{sort:{activatedAt:-1}})
  ]);
  const currentManual=manualFingerprint(manualRows);const staleReasons=[];if(!active.dataset.manualResolutionSetFingerprint)staleReasons.push('legacy-dataset-without-manual-resolution-fingerprint');else if(active.dataset.manualResolutionSetFingerprint!==currentManual.fingerprint)staleReasons.push('approved-manual-cost-set-changed');
  const byLine=new Map();for(const row of allocations)add(byLine,clean(row.saleLineId,500),row);
  const factByLine=new Map(facts.map(row=>[clean(row.saleLineIdentity,500),row]));
  const quantityErrors=[],moneyErrors=[];
  for(const [lineId,rows] of byLine){
    const fact=factByLine.get(lineId);if(!fact){quantityErrors.push({lineId,code:'FACT_MISSING'});continue;}
    const allocatedQty=rows.reduce((sum,row)=>sum+scaled(row.quantityExact??row.allocatedQty??row.unknownQty,decimal.QUANTITY_SCALE),0n);
    const factQty=scaled(fact.quantityExact,decimal.QUANTITY_SCALE);
    if(allocatedQty!==factQty)quantityErrors.push({lineId,code:'SALE_QUANTITY_MISMATCH',allocatedQtyExact:exact(allocatedQty,decimal.QUANTITY_SCALE),factQtyExact:exact(factQty,decimal.QUANTITY_SCALE)});
    const allocatedSale=rows.reduce((sum,row)=>sum+scaled(row.allocatedSaleValueExact??row.allocatedSaleValue,decimal.MONEY_SCALE),0n);
    const factSale=scaled(fact.saleAmountExact,decimal.MONEY_SCALE);
    if(allocatedSale!==factSale)moneyErrors.push({lineId,code:'SALE_VALUE_MISMATCH',allocationExact:exact(allocatedSale,2),factExact:exact(factSale,2)});
    if(fact.costCoverageStatus==='complete'){
      const allocatedCost=rows.reduce((sum,row)=>sum+scaled(row.allocatedCostAmountExact,decimal.MONEY_SCALE),0n);
      const factCost=scaled(fact.fifoCostExact,decimal.MONEY_SCALE),factProfit=scaled(fact.actualFifoProfitExact,decimal.MONEY_SCALE);
      if(allocatedCost!==factCost)moneyErrors.push({lineId,code:'FIFO_COST_MISMATCH',allocationExact:exact(allocatedCost,2),factExact:exact(factCost,2)});
      if(factSale-factCost!==factProfit)moneyErrors.push({lineId,code:'FIFO_PROFIT_IDENTITY_MISMATCH'});
    }
  }
  for(const row of allocations){if(row.sourceType==='official_purchase_layer'&&row.layerAvailableBefore!=null&&scaled(row.quantityExact??row.allocatedQty,decimal.QUANTITY_SCALE)>scaled(row.layerAvailableBefore,decimal.QUANTITY_SCALE))quantityErrors.push({lineId:clean(row.saleLineId,500),allocationId:clean(row.allocationId,100),code:'PURCHASE_LAYER_OVER_ALLOCATION'});}
  const duplicateAllocationIds=allocations.length-new Set(allocations.map(row=>row.allocationId)).size;
  const unknownRows=allocations.filter(row=>row.sourceType==='unknown_cost');const rootMap=new Map();for(const row of unknownRows){const bucket=classifyUnknown(row),entry=rootMap.get(bucket)||{bucket,count:0,saleValueExact:'0.00',unresolvedQuantityExact:'0.000000',products:new Set(),sellers:new Set()};entry.count++;entry.saleValueExact=exact(scaled(entry.saleValueExact,2)+scaled(row.allocatedSaleValueExact??row.allocatedSaleValue,2),2);entry.unresolvedQuantityExact=exact(scaled(entry.unresolvedQuantityExact,6)+scaled(row.quantityExact??row.unknownQty,6),6);entry.products.add(clean(row.itemCode,100));entry.sellers.add(clean(row.sellerAccountNumber,100));rootMap.set(bucket,entry);}
  const roots=[...rootMap.values()].map(row=>({...row,products:[...row.products].filter(Boolean),sellers:[...row.sellers].filter(Boolean)})).sort((a,b)=>scaled(b.saleValueExact,2)>scaled(a.saleValueExact,2)?1:-1);
  const layerInvoiceNumbers=new Set(purchaseLayers.filter(row=>row.layerKind==='purchase').map(row=>Number(row.purchaseInvoiceNo||0)).filter(Boolean));
  const officialInvoices=officialPurchaseCache.filter(row=>Number(row.invTyp||row.invoiceType||3)===3);const missingInvoices=officialInvoices.filter(row=>!layerInvoiceNumbers.has(Number(row.invNo||row.invoiceNumber||0)));const missingItems=new Set(missingInvoices.flatMap(row=>(row.items||row.lines||row.body||[]).map(line=>clean(line.itemCode||line.ItemCode,100)).filter(Boolean)));const affectedUnknown=allocations.filter(row=>row.sourceType==='unknown_cost'&&missingItems.has(clean(row.itemCode,100)));
  const latestLayerDate=purchaseLayers.reduce((latest,row)=>canonicalSourceDate(row.purchaseInvoiceDate)>latest?canonicalSourceDate(row.purchaseInvoiceDate):latest,'');const latestOfficialDate=officialInvoices.reduce((latest,row)=>canonicalSourceDate(row.invDate||row.invoiceDate)>latest?canonicalSourceDate(row.invDate||row.invoiceDate):latest,'');
  const sourceCompleteness={purchaseDatasetId:active.dataset.sourcePurchaseDatasetId,latestPurchaseDateInDataset:latestLayerDate,latestAvailableOfficialPurchaseDate:latestOfficialDate,officialSource:'supplierPurchaseInvoices read model',officialSourceIsLiveVerified:false,missingPurchaseInvoices:missingInvoices.length,missingPurchaseLines:missingInvoices.reduce((sum,row)=>sum+(row.items||row.lines||row.body||[]).length,0),affectedUnresolvedSaleLines:new Set(affectedUnknown.map(row=>row.saleLineId)).size,affectedUnresolvedSaleValueExact:exact(affectedUnknown.reduce((sum,row)=>sum+scaled(row.allocatedSaleValueExact??row.allocatedSaleValue,2),0n),2)};
  if(saleState?.activeSnapshotId&&clean(saleState.activeSnapshotId,100)!==clean(active.dataset.sourceSaleSnapshotId,100))staleReasons.push('newer-active-sale-snapshot');
  const c=coverage(facts),reliable=!quantityErrors.length&&!moneyErrors.length&&!duplicateAllocationIds&&!staleReasons.length&&active.dataset.validation?.valid!==false;
  return {ok:true,readOnly:true,datasetId:active.datasetId,algorithmVersion:active.dataset.algorithmVersion,source:{saleSnapshotId:active.dataset.sourceSaleSnapshotId,latestActiveSaleSnapshotId:clean(saleState?.activeSnapshotId,100),purchaseDatasetId:active.dataset.sourcePurchaseDatasetId,sourceFingerprint:active.dataset.sourceFingerprint,allocationFingerprint:active.dataset.allocationFingerprint,manualResolutionSetFingerprint:active.dataset.manualResolutionSetFingerprint||'',currentManualResolutionSetFingerprint:currentManual.fingerprint,stale:staleReasons.length>0,staleReasons},sourceCompleteness,counts:{facts:facts.length,allocations:allocations.length,exceptions:exceptions.length,duplicateAllocationIds},quantityConservation:{pass:!quantityErrors.length,errors:quantityErrors.slice(0,100)},moneyConservation:{pass:!moneyErrors.length,errors:moneyErrors.slice(0,100),roundingMode:decimal.ROUNDING_MODE,quantityScale:decimal.QUANTITY_SCALE,unitCostScale:decimal.UNIT_COST_SCALE,moneyScale:decimal.MONEY_SCALE},coverage:c,provenProfitCoverage:c,coverageBySeller:groupCoverage(facts,'sellerIdentity'),coverageByCategory:groupCoverage(facts,'officialProductCategoryName'),unknownRootCauses:roots,exceptionCounts:Object.fromEntries([...new Set(exceptions.map(row=>row.code))].sort().map(code=>[code,exceptions.filter(row=>row.code===code).length])),reliable,reliabilityDecision:reliable?(Number(c.saleValue.percent)>=95?'FIFO PROFIT RELIABLE FOR MANAGEMENT ANALYTICS':'FIFO PROFIT RELIABLE WITH EXPLICIT COVERAGE LIMITATIONS'):'FIFO PROFIT NOT RELIABLE',profitLabel:'سود FIFO اثبات‌شده',profitBasis:'gross-trading-profit-on-current-authoritative-sale-line-value',commissionableProfitReady:false,payableCommission:false};
}

module.exports={report,_coverage:coverage,_classifyUnknown:classifyUnknown};
