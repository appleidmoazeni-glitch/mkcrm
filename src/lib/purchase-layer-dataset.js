'use strict';

const crypto = require('crypto');
const defaultShaygan = require('./shaygan');
const saleSnapshot = require('./sale-snapshot');
const { APP_VERSION } = require('./app-version');
const { normalizeJalaliRange, canonicalSaleDate } = require('./jalali-date');
const canonicalItemCatalog = require('./canonical-item-catalog');
const canonicalLayerContract = require('./canonical-purchase-layer-contract');

const DATASETS = 'purchaseLayerDatasets';
const STATE = 'purchaseLayerDatasetState';
const LAYERS = 'supplierPurchaseLayers';
const DIAGNOSTICS = 'purchaseLayerDiagnostics';
const SCOPE_KEY = 'purchase-invoices-types-3-7';
const SCHEMA_VERSION = 1;
const SOURCE_TYPES = Object.freeze([3, 7]);

function clean(value) { return String(value == null ? '' : value).trim(); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(field => `${JSON.stringify(field)}:${stable(value[field])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function finite(value) {
  if (value == null || clean(value) === '') return null;
  const number = Number(String(value).replace(/[,،\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}
function nonNegative(value) {
  const number = finite(value);
  return number != null && number >= 0 ? number : null;
}
function safeError(value, maxLength = 1000) {
  return clean(value)
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, 'mongodb://[REDACTED]')
    .replace(/((?:authorization|password|passwd|token|api[-_ ]?key)\s*[:=]\s*)[^\s,;"'<>]+/gi, '$1[REDACTED]')
    .slice(0, Math.max(1, Math.min(Number(maxLength) || 1000, 4000)));
}
function newDatasetId() {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `PLAYER-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${Math.random().toString(16).slice(2, 8)}`;
}
function invoiceType(invoice) { return Number(invoice.InvTyp || invoice.InvoiceType || 0); }
function invoiceNo(invoice) { return Number(invoice.InvNo || invoice.InvoiceNumber || invoice.Number || 0); }
function invoiceGuid(invoice) { return clean(invoice.GuId || invoice.Guid || invoice.InvGuId || invoice.InvHeaderGuId); }
function invoiceDate(invoice) { return canonicalSaleDate(invoice.InvDate || invoice.InvoiceDate || invoice.Date || '', { field:'purchaseInvoiceDate' }); }
function invoiceBody(invoice) { return Array.isArray(invoice.Body) ? invoice.Body : (Array.isArray(invoice.Items) ? invoice.Items : []); }
function itemCode(line) { return clean(line.ItemNumber || line.ItemCode || line.Code || line.itemCode); }
function itemGuid(line) { return clean(line.ItemGuId || line.ItemGuid || line.itemGuid); }
function quantity(line) { return nonNegative(line.Quan ?? line.Quantity ?? line.Qty); }
function amount(line) { return nonNegative(line.Amount ?? line.TotalAmount ?? line.LineAmount); }
function price(line) { return nonNegative(line.Price ?? line.UnitPrice); }
function sourceHeaderId(invoice) { return clean(invoice.InvHeaderId || invoice.HeaderId || invoice.InvHeaderID); }
function returnHeaderReference(invoice) { return clean(invoice.RelatedInvHeaderId || invoice.InvHeaderIdRoot); }
function returnInvoiceNumberReference(invoice) { return clean(invoice.GeneralRef); }
function lineIdentity(invoice, line, row) {
  const guid = invoiceGuid(invoice);
  const lineId = clean(line.LineItemId || line.LineId);
  if (guid && lineId) return `${guid}:${lineId}`;
  return `T${invoiceType(invoice)}:N${invoiceNo(invoice)}:R${row}:I${itemCode(line) || itemGuid(line) || 'MISSING'}`;
}
function sourceProjection(row = {}) {
  return {
    layerKind:clean(row.layerKind), sourceInvoiceType:Number(row.sourceInvoiceType || 0),
    purchaseInvoiceGuid:clean(row.purchaseInvoiceGuid), purchaseInvoiceNo:Number(row.purchaseInvoiceNo || 0),
    purchaseInvoiceDate:clean(row.purchaseInvoiceDate), sourceLineItemId:clean(row.sourceLineItemId),
    sourceRow:Number(row.sourceRow || 0), itemGuid:clean(row.itemGuid), itemCode:clean(row.itemCode),
    supplierGuid:clean(row.supplierGuid), supplierAccountNumber:clean(row.supplierAccountNumber),
    originalQuantity:row.originalQuantity == null ? null : Number(row.originalQuantity),
    returnedQuantity:row.returnedQuantity == null ? null : Number(row.returnedQuantity),
    grossUnitCost:row.grossUnitCost == null ? null : Number(row.grossUnitCost),
    discountAmount:row.discountAmount == null ? null : Number(row.discountAmount),
    netUnitCost:row.netUnitCost == null ? null : Number(row.netUnitCost),
    returnInvHeaderReference:clean(row.returnInvHeaderReference),
    returnPurchaseInvoiceNoReference:clean(row.returnPurchaseInvoiceNoReference)
  };
}
function sourceHash(row = {}) { return sha256(stable(sourceProjection(row))); }
function datasetFingerprints(rows = []) {
  const ordered = rows.map(row => ({
    purchaseLineIdentity:clean(row.purchaseLineIdentity),
    sourceHash:clean(row.sourceHash) || sourceHash(row),
    netPurchasedQuantity:row.netPurchasedQuantity == null ? null : Number(row.netPurchasedQuantity),
    returnMatchStatus:clean(row.returnMatchStatus),
    returnLinkageClass:clean(row.returnLinkageClass),
    matchedPurchaseLineIdentity:clean(row.matchedPurchaseLineIdentity),
    linkedReturnIdentities:Array.isArray(row.linkedReturnIdentities) ? [...row.linkedReturnIdentities].map(clean).sort() : []
  })).sort((a,b)=>a.purchaseLineIdentity.localeCompare(b.purchaseLineIdentity, 'en'));
  const layerFingerprint = sha256(stable(ordered));
  const sourceFingerprint = sha256(stable(ordered.map(row => [row.purchaseLineIdentity, row.sourceHash])));
  return { layerFingerprint, sourceFingerprint };
}
function retryable(error) {
  return /timeout|timed out|econnreset|econnrefused|socket|network|fetch|transport|429|5\d\d|temporar/i.test(clean(error));
}
function responseTotalRecords(response) {
  const candidates = [
    response?.totalRecords,
    response?.TotalRecords,
    response?.raw?.TotalRecords,
    response?.raw?.totalRecords,
    response?.result?.[0]?.TotalRecords,
    response?.result?.[0]?.totalRecords,
    response?.raw?.Result?.[0]?.TotalRecords,
    response?.raw?.Result?.[0]?.totalRecords
  ];
  for (const candidate of candidates) {
    if (candidate == null || clean(candidate) === '') continue;
    const value = Number(candidate);
    if (Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}
function invoiceGapRanges(values=[]) {
  const numbers=[...new Set(values.map(Number).filter(value=>Number.isSafeInteger(value)&&value>0))].sort((a,b)=>a-b);
  const ranges=[];
  for(let index=1;index<numbers.length;index++){
    if(numbers[index]===numbers[index-1]+1)continue;
    ranges.push({from:numbers[index-1]+1,to:numbers[index]-1,count:numbers[index]-numbers[index-1]-1});
  }
  return ranges;
}
function wait(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function count(collection, query) {
  if (typeof collection.countDocuments === 'function') return Number(await collection.countDocuments(query));
  return (await collection.find(query).toArray()).length;
}
async function ensureIndexes(db) {
  const existing = new Set((await db.listCollections().toArray()).map(value => value.name));
  for (const name of [DATASETS, STATE, LAYERS, DIAGNOSTICS]) {
    if (!existing.has(name)) await db.createCollection(name).catch(() => {});
  }
  await db.collection(DATASETS).createIndex({ datasetId:1 }, { unique:true });
  await db.collection(DATASETS).createIndex({ status:1, completedAt:-1 });
  await db.collection(STATE).createIndex({ scopeKey:1 }, { unique:true });
  await db.collection(LAYERS).createIndex(
    { datasetId:1, purchaseLineIdentity:1 },
    { unique:true, partialFilterExpression:{ datasetId:{ $exists:true } } }
  );
  await db.collection(LAYERS).createIndex({ datasetId:1, itemCode:1, purchaseInvoiceDate:1 });
  await db.collection(LAYERS).createIndex({ datasetId:1, itemGuid:1, purchaseInvoiceDate:1 });
  await db.collection(LAYERS).createIndex({ datasetId:1, supplierAccountNumber:1, purchaseInvoiceDate:1 });
  await db.collection(LAYERS).createIndex({ datasetId:1, layerKind:1, purchaseInvoiceNo:1, purchaseInvoiceDate:-1 });
  await db.collection(LAYERS).createIndex({ datasetId:1, costStatus:1, itemCode:1, purchaseInvoiceDate:-1 });
  await db.collection(LAYERS).createIndex({ datasetId:1, returnLinkageClass:1, purchaseInvoiceNo:1 });
  await db.collection(LAYERS).createIndex({ datasetId:1, supplierName:1, purchaseInvoiceDate:-1 });
  await db.collection(DIAGNOSTICS).createIndex({ datasetId:1, at:-1 });
}

async function activeDataset(db) {
  const state = await db.collection(STATE).findOne({ scopeKey:SCOPE_KEY }).catch(() => null);
  if (!state?.activeDatasetId) return null;
  const dataset = await db.collection(DATASETS).findOne({ datasetId:state.activeDatasetId }).catch(() => null);
  if (!dataset || dataset.status !== 'completed') return null;
  return { datasetId:dataset.datasetId, state, dataset };
}

function mapSourceLine(invoice, line, row, datasetId) {
  const type = invoiceType(invoice);
  const qty = quantity(line);
  const lineAmount = amount(line);
  const grossUnitCost = price(line) ?? (qty && lineAmount != null ? lineAmount / qty : null);
  const discountAmount = nonNegative(line.LineDiscAmount ?? line.DiscountAmount);
  const sourceIsPurchase = type === 3;
  const rejectedReasons = [];
  const warnings = [];
  if (!invoiceNo(invoice)) rejectedReasons.push('invoice-number');
  if (!itemCode(line) && !itemGuid(line)) rejectedReasons.push('item-identifier');
  if (qty == null) rejectedReasons.push('quantity');
  const supplierAccountNumber = clean(invoice.AccountNumber || invoice.SupplierAccountNumber);
  if (!supplierAccountNumber) warnings.push('supplier');
  const costKnown = grossUnitCost != null && lineAmount != null;
  if (sourceIsPurchase && !costKnown) warnings.push('cost-unknown');
  // Shaygan may temporarily persist a newly received item at one rial until
  // Procurement completes the purchase invoice price. Preserve the official
  // value verbatim, but do not advertise it as an accounting-ready cost.
  const purchasePricePendingCorrection = sourceIsPurchase && costKnown && grossUnitCost === 1;
  if (purchasePricePendingCorrection) warnings.push('purchase-price-pending-correction');
  const now = new Date();
  const mapped = {
    datasetId,
    datasetSchemaVersion:SCHEMA_VERSION,
    purchaseLineIdentity:lineIdentity(invoice, line, row),
    layerKind:sourceIsPurchase ? 'purchase' : 'purchase-return',
    sourceInvoiceType:type,
    sourceInvoiceTypeLabel:sourceIsPurchase ? 'Purchase' : 'PurchaseReturn',
    itemGuid:itemGuid(line),
    itemCode:itemCode(line),
    itemDescription:clean(line.ItemDescription || line.ItemDesc || line.ItemName),
    purchaseInvoiceGuid:invoiceGuid(invoice),
    purchaseInvoiceNo:invoiceNo(invoice),
    purchaseInvoiceDate:invoiceDate(invoice),
    sourceInvHeaderId:sourceHeaderId(invoice),
    returnInvHeaderReference:returnHeaderReference(invoice),
    returnPurchaseInvoiceNoReference:returnInvoiceNumberReference(invoice),
    supplierGuid:clean(invoice.AccountGuId || invoice.SupplierGuid),
    supplierAccountNumber,
    supplierName:clean(invoice.AccountName || invoice.SupplierName),
    sourceRow:row,
    sourceLineItemId:clean(line.LineItemId || line.LineId),
    originalQuantity:sourceIsPurchase ? qty : 0,
    returnedQuantity:sourceIsPurchase ? 0 : qty,
    netPurchasedQuantity:sourceIsPurchase ? qty : null,
    allocatedQuantity:0,
    remainingQuantity:sourceIsPurchase ? qty : null,
    grossUnitCost:sourceIsPurchase ? grossUnitCost : null,
    discountAmount:discountAmount ?? null,
    discountPercent:nonNegative(line.LineDiscPer ?? line.DiscountPercent),
    netUnitCost:sourceIsPurchase && costKnown && qty ? lineAmount / qty : null,
    taxAmount:null,
    additionalCostAmount:null,
    currency:clean(invoice.CurrencyAbb1),
    currencyRate:nonNegative(invoice.Rate),
    sourceStatus:sourceIsPurchase ? 'purchase-source' : 'purchase-return-source',
    validationStatus:rejectedReasons.length ? 'rejected' : (warnings.length ? 'warning' : 'valid'),
    validationWarnings:[...rejectedReasons,...warnings],
    costStatus:sourceIsPurchase
      ? (purchasePricePendingCorrection ? 'pending-purchase-price-correction' : (costKnown ? 'known-from-shaygan-line' : 'unknown'))
      : 'not-applicable-return-row',
    returnMatchStatus:sourceIsPurchase ? 'not-applicable' : 'unmatched',
    returnLinkageClass:sourceIsPurchase ? 'NOT_APPLICABLE' : 'UNLINKED_RETURN',
    source:'shaygan-webservice-invoice-get',
    createdAt:now,
    updatedAt:now
  };
  mapped.sourceHash = sourceHash(mapped);
  return mapped;
}

function layerUpsertUpdate(mapped) {
  const { createdAt, ...current } = mapped;
  return {
    $set:{ ...current, updatedAt:new Date() },
    $setOnInsert:{ createdAt:createdAt || new Date() }
  };
}

async function cloneActiveLayers(db, active, datasetId) {
  if (!active?.datasetId) return 0;
  const rows = await db.collection(LAYERS).find(canonicalLayerContract.canonicalLayerQuery({ datasetId:active.datasetId })).toArray();
  for (const row of rows) {
    const { _id, ...copy } = row;
    copy.sourceHash = clean(copy.sourceHash) || sourceHash(copy);
    await db.collection(LAYERS).updateOne(
      { datasetId, purchaseLineIdentity:copy.purchaseLineIdentity },
      { $set:{ ...copy, datasetId, clonedFromDatasetId:active.datasetId, clonedAt:new Date(), updatedAt:new Date() } },
      { upsert:true }
    );
  }
  return rows.length;
}

async function reconcilePurchaseReturns(db, datasetId) {
  const collection = db.collection(LAYERS);
  const purchases = await collection.find(canonicalLayerContract.canonicalPurchaseQuery({ datasetId })).toArray();
  const returns = await collection.find(canonicalLayerContract.canonicalPurchaseReturnQuery({ datasetId })).toArray();
  const purchasesByHeaderItem = new Map();
  const purchasesByInvoiceSupplierItem = new Map();
  const normalizedReference = value => {
    const result=clean(value);
    return result && result !== '0' ? result : '';
  };
  const identityKey = row => clean(row.itemCode) ? `C:${clean(row.itemCode).toLowerCase()}` : `G:${clean(row.itemGuid).toLowerCase()}`;
  const supplierKey = row => clean(row.supplierAccountNumber) ? `A:${clean(row.supplierAccountNumber).toLowerCase()}` : `G:${clean(row.supplierGuid).toLowerCase()}`;
  const add = (map,key,row) => { if(!key)return;if(!map.has(key))map.set(key,[]);map.get(key).push(row); };
  for (const purchase of purchases) {
    const item=identityKey(purchase);
    for(const header of [purchase.sourceInvHeaderId,purchase.purchaseInvoiceGuid].map(normalizedReference).filter(Boolean))add(purchasesByHeaderItem,`${header}|${item}`,purchase);
    add(purchasesByInvoiceSupplierItem,`${Number(purchase.purchaseInvoiceNo||0)}|${supplierKey(purchase)}|${item}`,purchase);
    await collection.updateOne(
      { datasetId, purchaseLineIdentity:purchase.purchaseLineIdentity },
      { $set:{ returnedQuantity:0, netPurchasedQuantity:purchase.originalQuantity, remainingQuantity:purchase.originalQuantity, returnMatchStatus:'not-applicable', returnLinkageClass:'NOT_APPLICABLE', linkedReturnIdentities:[], updatedAt:new Date() } }
    );
  }
  let exactOriginLinkCount = 0;
  let deterministicLinkCount = 0;
  let unmatchedReturnCount = 0;
  let ambiguousReturnCount = 0;
  let overReturnCount = 0;
  let duplicateReturnCount = 0;
  let quantityInvariantErrors = 0;
  const assignments=new Map();
  for (const returnRow of returns) {
    const headerReference=normalizedReference(returnRow.returnInvHeaderReference);
    const invoiceReference=normalizedReference(returnRow.returnPurchaseInvoiceNoReference);
    const item=identityKey(returnRow);
    let candidates=headerReference ? (purchasesByHeaderItem.get(`${headerReference}|${item}`)||[]) : [];
    let linkageClass=candidates.length ? 'EXACT_ORIGIN_LINK' : '';
    if(!candidates.length&&invoiceReference){
      candidates=purchasesByInvoiceSupplierItem.get(`${Number(invoiceReference)}|${supplierKey(returnRow)}|${item}`)||[];
      linkageClass=candidates.length ? 'EXACT_ORIGIN_LINK' : '';
    }
    if (candidates.length !== 1) {
      const status = candidates.length > 1 ? 'ambiguous' : 'unmatched';
      const classification=candidates.length>1?'AMBIGUOUS_RETURN':'UNLINKED_RETURN';
      if (status === 'ambiguous') ambiguousReturnCount++; else unmatchedReturnCount++;
      await collection.updateOne(
        { datasetId, purchaseLineIdentity:returnRow.purchaseLineIdentity },
        { $set:{ returnMatchStatus:status, returnLinkageClass:classification, matchedPurchaseLineIdentity:'', validationStatus:'warning', validationWarnings:[...new Set([...(returnRow.validationWarnings || []), `purchase-return-${status}`])], updatedAt:new Date() } }
      );
      continue;
    }
    const purchase=candidates[0],id=clean(purchase.purchaseLineIdentity);
    if(!assignments.has(id))assignments.set(id,{purchase,returns:[]});
    assignments.get(id).returns.push({row:returnRow,linkageClass});
  }
  for(const {purchase,returns:linked} of assignments.values()){
    const identityCounts=new Map();
    for(const link of linked)identityCounts.set(clean(link.row.purchaseLineIdentity),(identityCounts.get(clean(link.row.purchaseLineIdentity))||0)+1);
    const duplicates=linked.filter(link=>identityCounts.get(clean(link.row.purchaseLineIdentity))>1);
    if(duplicates.length){
      duplicateReturnCount+=duplicates.length;
      for(const {row} of duplicates)await collection.updateOne({datasetId,purchaseLineIdentity:row.purchaseLineIdentity},{$set:{returnMatchStatus:'duplicate',returnLinkageClass:'DUPLICATE_RETURN',validationStatus:'rejected',validationWarnings:[...new Set([...(row.validationWarnings||[]),'purchase-return-duplicate'])],updatedAt:new Date()}});
      continue;
    }
    const returnedQuantity=linked.reduce((sum,link)=>sum+Number(link.row.returnedQuantity||0),0);
    const originalQuantity=Number(purchase.originalQuantity||0);
    const netPurchasedQuantity=originalQuantity-returnedQuantity;
    if(netPurchasedQuantity < -0.000001){
      overReturnCount+=linked.length;quantityInvariantErrors++;
      for(const {row} of linked)await collection.updateOne({datasetId,purchaseLineIdentity:row.purchaseLineIdentity},{$set:{returnMatchStatus:'over-return',returnLinkageClass:'OVER_RETURN',validationStatus:'rejected',validationWarnings:[...new Set([...(row.validationWarnings||[]),'purchase-return-exceeds-purchase'])],updatedAt:new Date()}});
      continue;
    }
    const linkedReturnIdentities=linked.map(link=>clean(link.row.purchaseLineIdentity)).sort();
    await collection.updateOne(
      { datasetId, purchaseLineIdentity:purchase.purchaseLineIdentity },
      { $set:{ returnedQuantity, netPurchasedQuantity, remainingQuantity:netPurchasedQuantity, returnMatchStatus:'matched', returnLinkageClass:'EXACT_ORIGIN_LINK', linkedReturnIdentities, updatedAt:new Date() } }
    );
    for(const {row,linkageClass} of linked){
      if(linkageClass==='EXACT_ORIGIN_LINK')exactOriginLinkCount++;else deterministicLinkCount++;
      await collection.updateOne({datasetId,purchaseLineIdentity:row.purchaseLineIdentity},{$set:{matchedPurchaseLineIdentity:purchase.purchaseLineIdentity,returnMatchStatus:'matched',returnLinkageClass:linkageClass,validationStatus:row.validationWarnings?.length?'warning':'valid',updatedAt:new Date()}});
    }
  }
  const matchedReturnCount=exactOriginLinkCount+deterministicLinkCount;
  const explicitQuarantineCount=unmatchedReturnCount+ambiguousReturnCount+overReturnCount+duplicateReturnCount;
  return {purchaseReturnCount:returns.length,matchedReturnCount,exactOriginLinkCount,deterministicLinkCount,unmatchedReturnCount,ambiguousReturnCount,overReturnCount,duplicateReturnCount,explicitQuarantineCount,quantityInvariantErrors,purchaseReturnsAccountedFor:returns.length===matchedReturnCount+explicitQuarantineCount};
}

async function validateDataset(db, datasetId, reachedEndByType, errors) {
  const rows = await db.collection(LAYERS).find(canonicalLayerContract.canonicalLayerQuery({ datasetId })).toArray();
  const identities = rows.map(row => row.purchaseLineIdentity);
  const duplicateCount = identities.length - new Set(identities).size;
  const purchases = rows.filter(row => row.layerKind === 'purchase');
  const returns = rows.filter(row => row.layerKind === 'purchase-return');
  const rejectedRowCount = rows.filter(row => row.validationStatus === 'rejected').length;
  const warningCount = rows.filter(row => row.validationStatus === 'warning').length;
  const quantityInvariantErrors = purchases.filter(row =>
    nonNegative(row.originalQuantity) == null ||
    nonNegative(row.returnedQuantity) == null ||
    nonNegative(row.netPurchasedQuantity) == null ||
    Math.abs(Number(row.originalQuantity) - Number(row.returnedQuantity) - Number(row.netPurchasedQuantity)) > 0.000001
  ).length;
  const validation = {
    reachedEndByType,
    allTypesReachedEnd:SOURCE_TYPES.every(type => reachedEndByType[String(type)] === true),
    duplicateCount,
    duplicatesAbsent:duplicateCount === 0,
    quantityInvariantErrors,
    quantitiesValid:quantityInvariantErrors === 0,
    purchaseRowsPresent:purchases.length > 0,
    errorCount:errors.length,
    noErrors:errors.length === 0,
    rejectedRowCount,
    noRejectedRows:rejectedRowCount === 0,
    warningCount,
    purchaseLineCount:purchases.length,
    purchaseReturnLineCount:returns.length,
    checkedAt:new Date()
  };
  validation.valid = validation.allTypesReachedEnd && validation.duplicatesAbsent &&
    validation.quantitiesValid && validation.purchaseRowsPresent && validation.noErrors && validation.noRejectedRows;
  return { rows, validation };
}

async function buildPurchaseLayerDataset(db, options = {}) {
  await ensureIndexes(db);
  const api = options.shaygan || defaultShaygan;
  const jobControl = options.jobControl;
  const report = (phase, current, total, message) => jobControl?.progress?.({ phase, current, total, message });
  const checkpoint = () => { jobControl?.heartbeat?.(); jobControl?.checkCancellation?.(); };
  const requestedResumeId = clean(options.resumeDatasetId);
  const resumed = requestedResumeId ? await db.collection(DATASETS).findOne({ datasetId:requestedResumeId }) : null;
  const replayFromStart = options.replayFromStart === true;
  if (requestedResumeId && !resumed) return { ok:false, code:'DATASET_NOT_FOUND', error:'Purchase Layer Candidate not found', datasetId:requestedResumeId };
  const resumableStatus = ['completed_with_errors', 'failed', 'cancelled'].includes(clean(resumed?.status)) ||
    (replayFromStart && clean(resumed?.status) === 'running');
  if (resumed && !resumableStatus) {
    return { ok:false, code:'DATASET_NOT_RESUMABLE', error:`Dataset status ${clean(resumed.status)} is not resumable`, datasetId:requestedResumeId };
  }
  const { dateFrom, dateTo } = normalizeJalaliRange({
    dateFrom:resumed?.sourceDateFrom || options.dateFrom || '12000101',
    dateTo:resumed?.sourceDateTo || options.dateTo || ''
  }, { requireFrom:true });
  const datasetId = resumed?.datasetId || newDatasetId();
  const pageSize = Math.max(1, Math.min(Number(resumed?.pageSize || options.pageSize || 20), 20));
  const maxPages = Math.max(1, Math.min(Number(options.maxPages || resumed?.maxPages || 1000), 10000));
  const maxPageAttempts = Math.max(1, Math.min(Number(options.maxPageAttempts || resumed?.maxPageAttempts || 3), 5));
  const full = resumed ? resumed.mode === 'full' : options.reset === true || options.mode === 'full';
  const mode = full ? 'full' : 'incremental';
  // Candidate materialization and authority selection are intentionally separate.
  // No build or resume operation may activate a Purchase Dataset.
  const activationRequested = false;
  const previousActive = await activeDataset(db);
  const now = new Date();
  const startedAtMs = Date.now();
  let clonedLayerCount = Number(resumed?.clonedLayerCount || 0);
  if (!resumed) {
    await db.collection(DATASETS).insertOne({
      datasetId, datasetSchemaVersion:SCHEMA_VERSION, scopeKey:SCOPE_KEY, status:'running',
      activationStatus:'candidate', mode, sourceDateFrom:dateFrom, sourceDateTo:dateTo,
      activationRequested,
      pageSize, maxPages, maxPageAttempts, sourceVersion:'shaygan-invoice-get-v1',
      applicationVersion:APP_VERSION, gitSha:clean(process.env.GIT_COMMIT || process.env.COMMIT_SHA),
      createdAt:now, startedAt:now, updatedAt:now, retryCount:0, resumeCount:0,
      checkpoint:{ typeIndex:0, nextRowStartByType:{ '3':0, '7':0 }, reachedEndByType:{ '3':false, '7':false } }
    });
    if (!full && previousActive) {
      report('Preparing Isolated Dataset', 0, 1, 'Cloning active purchase-layer dataset');
      clonedLayerCount = await cloneActiveLayers(db, previousActive, datasetId);
      await db.collection(DATASETS).updateOne({ datasetId }, { $set:{ clonedLayerCount, baseDatasetId:previousActive.datasetId, updatedAt:new Date() } });
    }
  } else {
    await db.collection(DATASETS).updateOne({ datasetId }, { $set:{
      status:'running', activationStatus:'candidate', resumedAt:now, recoveryMode:replayFromStart ? 'replay-from-start' : 'checkpoint-resume',
      resumeCount:Number(resumed.resumeCount || 0) + 1, maxPages, maxPageAttempts, updatedAt:now
    }, $unset:{ error:'' } });
  }

  const emptyCheckpoint = { typeIndex:0, nextRowStartByType:{ '3':0, '7':0 }, reachedEndByType:{ '3':false, '7':false } };
  const startCheckpoint = replayFromStart ? emptyCheckpoint : (resumed?.checkpoint || emptyCheckpoint);
  const nextRowStartByType = { '3':0, '7':0, ...(startCheckpoint.nextRowStartByType || {}) };
  const reachedEndByType = { '3':false, '7':false, ...(startCheckpoint.reachedEndByType || {}) };
  const lastInvoiceNoByType = { '3':0, '7':0, ...(resumed?.lastInvoiceNoByType || previousActive?.dataset?.lastInvoiceNoByType || {}) };
  const pagingByType = {
    '3':{ totalRecords:null, expectedPages:null, pagesRead:0, mode:'fallback' },
    '7':{ totalRecords:null, expectedPages:null, pagesRead:0, mode:'fallback' },
    ...(replayFromStart ? {} : (resumed?.pagingByType || {}))
  };
  let retryCount = Number(resumed?.retryCount || 0);
  let pageCount = Number(resumed?.pageCount || 0);
  const errors = [];
  const pageDiagnostics = Array.isArray(resumed?.pageDiagnostics) ? resumed.pageDiagnostics.slice(-200) : [];
  try {
    for (let typeIndex = Number(startCheckpoint.typeIndex || 0); typeIndex < SOURCE_TYPES.length; typeIndex++) {
      const type = SOURCE_TYPES[typeIndex];
      const key = String(type);
      if (reachedEndByType[key]) continue;
      const invNoFrom = !full && Number(lastInvoiceNoByType[key] || 0) > 0 ? String(Number(lastInvoiceNoByType[key]) + 1) : '';
      const firstPage = Math.floor(Number(nextRowStartByType[key] || 0) / pageSize);
      for (let page = firstPage, rowStart = Number(nextRowStartByType[key] || 0); page < maxPages; page++, rowStart += pageSize) {
        report('Reading Purchase Invoices', page, maxPages, `Dataset ${datasetId} | InvTyp ${type} | page ${page + 1}`);
        checkpoint();
        let response = { ok:false, error:'not attempted', result:[] };
        const attempts = [];
        for (let attempt = 1; attempt <= maxPageAttempts; attempt++) {
          const attemptStartedAt = Date.now();
          response = await api.getInvoicePageByTypeNumberRange(rowStart, type, invNoFrom, '', dateFrom, dateTo, pageSize)
            .catch(error => ({ ok:false, error:String(error.message || error), result:[] }));
          attempts.push({ attempt, ok:!!response.ok, status:Number(response.status || 0), durationMs:Date.now() - attemptStartedAt, error:response.ok ? '' : safeError(response.error), at:new Date() });
          if (response.ok) break;
          if (!retryable(response.error) || attempt === maxPageAttempts) break;
          retryCount++;
          await wait(Math.min(2000, 250 * (2 ** (attempt - 1))));
          checkpoint();
        }
        pageCount++;
        if (!response.ok) {
          errors.push({ type, page, rowStart, attempts, error:safeError(response.error), retryable:retryable(response.error), at:new Date() });
          nextRowStartByType[key] = rowStart;
          break;
        }
        const rawRows=Array.isArray(response.result)?response.result:[];
        const sourceRows=rawRows.filter(row => invoiceType(row) === type);
        const totalRecords=responseTotalRecords(response);
        if(totalRecords!=null){
          pagingByType[key]={
            ...pagingByType[key],
            totalRecords,
            expectedPages:Math.ceil(totalRecords/pageSize),
            mode:'total-records'
          };
        }
        pagingByType[key].pagesRead=Number(pagingByType[key].pagesRead||0)+1;
        pageDiagnostics.push({type,page,rowStart,rawRows:rawRows.length,sourceRows:sourceRows.length,attempts,terminalCondition:rawRows.length?'continue':'empty-raw-page',at:new Date()});
        if (!rawRows.length) {
          reachedEndByType[key] = true;
          break;
        }
        const pageCatalogItems=[];
        for (const invoice of sourceRows) {
          lastInvoiceNoByType[key] = Math.max(Number(lastInvoiceNoByType[key] || 0), invoiceNo(invoice));
          const body = invoiceBody(invoice);
          for (let index = 0; index < body.length; index++) {
            const mapped = mapSourceLine(invoice, body[index], index + 1, datasetId);
            pageCatalogItems.push({itemGuid:mapped.itemGuid,itemCode:mapped.itemCode,itemDescription:mapped.itemDescription});
            await db.collection(LAYERS).updateOne(
              { datasetId, purchaseLineIdentity:mapped.purchaseLineIdentity },
              layerUpsertUpdate(mapped),
              { upsert:true }
            );
          }
        }
        if(pageCatalogItems.length)await canonicalItemCatalog.ensureCatalogItems(db,pageCatalogItems,{source:'canonical-purchase-engine'});
        // Advance only after every row in the page is durable. A failed page is replayed on resume.
        nextRowStartByType[key] = rowStart + pageSize;
        if(pagingByType[key].mode==='total-records' &&
          Number(pagingByType[key].pagesRead)>=Number(pagingByType[key].expectedPages)){
          reachedEndByType[key]=true;
        }
        const checkpointValue = { typeIndex, nextRowStartByType, reachedEndByType };
        await db.collection(DATASETS).updateOne({ datasetId }, { $set:{
          checkpoint:checkpointValue, pageCount, retryCount, lastInvoiceNoByType,
          pagingByType, pageDiagnostics:pageDiagnostics.slice(-200), updatedAt:new Date()
        } });
        if(reachedEndByType[key])break;
        // A short page is not an end marker; only an empty official response ends a type.
      }
      if (!reachedEndByType[key] && !errors.length) {
        errors.push({ type, code:'MAX_PAGES_REACHED', nextRowStart:nextRowStartByType[key], maxPages, error:'maxPages reached before an empty page' });
      }
      await db.collection(DATASETS).updateOne({ datasetId }, { $set:{ checkpoint:{ typeIndex:reachedEndByType[key] ? typeIndex + 1 : typeIndex, nextRowStartByType, reachedEndByType }, updatedAt:new Date() } });
      if (errors.length) break;
    }
    const returnAudit = await reconcilePurchaseReturns(db, datasetId);
    const { rows, validation } = await validateDataset(db, datasetId, reachedEndByType, errors);
    validation.purchaseReturns = returnAudit;
    validation.returnQuantityInvariantErrors=returnAudit.quantityInvariantErrors;
    validation.valid=validation.valid&&returnAudit.quantityInvariantErrors===0;
    const purchaseRows = rows.filter(row => row.layerKind === 'purchase');
    const purchaseInvoiceKeys = new Set(purchaseRows.map(row => row.purchaseInvoiceNo));
    const purchaseReturnInvoiceKeys = new Set(rows.filter(row=>row.layerKind==='purchase-return').map(row=>row.purchaseInvoiceNo));
    const purchaseInvoiceNumbers=[...purchaseInvoiceKeys].map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    const purchaseReturnInvoiceNumbers=[...purchaseReturnInvoiceKeys].map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
    const itemKeys = new Set(purchaseRows.map(row => clean(row.itemCode || row.itemGuid)).filter(Boolean));
    const suppliers = new Set(purchaseRows.map(row => clean(row.supplierAccountNumber || row.supplierGuid)).filter(Boolean));
    const costUnknownCount = purchaseRows.filter(row => row.costStatus === 'unknown').length;
    const pendingPurchasePriceCount = purchaseRows.filter(row => row.costStatus === 'pending-purchase-price-correction').length;
    const successful = validation.valid;
    const fingerprints = datasetFingerprints(rows);
    const completedAt = new Date();
    const previousActiveDatasetId = previousActive?.datasetId || '';
    const finalTypeIndex=SOURCE_TYPES.findIndex(type=>reachedEndByType[String(type)]!==true);
    const summary = {
      status:successful ? 'completed' : 'completed_with_errors',
      activationStatus:successful ? 'validated-candidate' : 'rejected',
      completedAt, updatedAt:completedAt, durationMs:Date.now() - startedAtMs,
      pageCount, retryCount, resumeCount:Number(resumed?.resumeCount||0)+(resumed?1:0),
      replayFromStartCount:Number(resumed?.replayFromStartCount||0)+(replayFromStart?1:0),
      checkpoint:{ typeIndex:finalTypeIndex<0?SOURCE_TYPES.length:finalTypeIndex, nextRowStartByType, reachedEndByType },
      pagingByType, lastInvoiceNoByType, clonedLayerCount, purchaseInvoiceCount:purchaseInvoiceKeys.size,
      purchaseReturnInvoiceCount:purchaseReturnInvoiceKeys.size,
      firstInvoiceNoByType:{'3':purchaseInvoiceNumbers[0]||0,'7':purchaseReturnInvoiceNumbers[0]||0},
      sourceInvoiceGapRangesByType:{'3':invoiceGapRanges(purchaseInvoiceNumbers),'7':invoiceGapRanges(purchaseReturnInvoiceNumbers)},
      sourceCompleteness:successful?(returnAudit.explicitQuarantineCount?'PURCHASE_SOURCE_COMPLETE_WITH_EXPLICIT_QUARANTINE':'PURCHASE_SOURCE_COMPLETE'):'PURCHASE_SOURCE_INCOMPLETE',
      purchaseLineCount:purchaseRows.length, purchaseReturnLineCount:rows.length - purchaseRows.length,
      layerCount:rows.length, itemCount:itemKeys.size, supplierCount:suppliers.size,
      duplicateCount:validation.duplicateCount, rejectedRowCount:validation.rejectedRowCount,
      warningCount:validation.warningCount, errorCount:errors.length, costUnknownCount, pendingPurchasePriceCount,
      validation, returnAudit, errors:errors.slice(0, 100), previousActiveDatasetId,
      activationRequested, ...fingerprints,
      candidateFingerprint:sha256(stable({
        schemaVersion:SCHEMA_VERSION, mode, sourceDateFrom:dateFrom, sourceDateTo:dateTo,
        baseDatasetId:resumed?.baseDatasetId||(!full?previousActive?.datasetId||'':''),
        layerFingerprint:fingerprints.layerFingerprint, sourceFingerprint:fingerprints.sourceFingerprint
      })),
      baseDatasetId:resumed?.baseDatasetId||(!full?previousActive?.datasetId||'':'')
    };
    await db.collection(DATASETS).updateOne({ datasetId }, { $set:summary });
    const coverageMetrics=await coverage(db,datasetId);
    await db.collection(DATASETS).updateOne({datasetId},{$set:{coverage:coverageMetrics,updatedAt:new Date()}});
    const result = {
      ok:successful,
      code:successful?'PURCHASE_LAYER_DATASET_CANDIDATE_READY':'PURCHASE_LAYER_DATASET_INCOMPLETE',
      datasetId,
      activeDatasetId:previousActiveDatasetId,
      ...summary,
      coverage:coverageMetrics,
      activationStatus:successful?'validated-candidate':'rejected',activationPerformed:false
    };
    await db.collection(DIAGNOSTICS).insertOne({ ...result, at:new Date(), applicationVersion:APP_VERSION });
    return result;
  } catch (error) {
    const failure = {
      ok:false, code:'PURCHASE_LAYER_DATASET_BUILD_FAILED', datasetId,
      activeDatasetId:previousActive?.datasetId || '', status:'failed',
      activationStatus:'rejected', error:safeError(error?.message || error),
      pageCount, retryCount, checkpoint:{ nextRowStartByType, reachedEndByType },
      lastInvoiceNoByType, finishedAt:new Date(), updatedAt:new Date()
    };
    await db.collection(DATASETS).updateOne({ datasetId }, { $set:failure });
    if (error?.code === 'JOB_CANCELLED') throw error;
    return failure;
  }
}

async function coverage(db, datasetId = '') {
  await ensureIndexes(db);
  const active = datasetId
    ? { datasetId, dataset:await db.collection(DATASETS).findOne({ datasetId }) }
    : await activeDataset(db);
  if (!active?.datasetId) return { ok:true, available:false, profitActivationAllowed:false, reason:'NO_ACTIVE_PURCHASE_LAYER_DATASET' };
  const layers = await db.collection(LAYERS).find(canonicalLayerContract.canonicalPurchaseQuery({ datasetId:active.datasetId })).toArray();
  const accountingEligibleLayers=layers.filter(row => row.costStatus !== 'pending-purchase-price-correction' && Number(row.netUnitCost ?? row.grossUnitCost) > 0);
  const purchaseItems = new Set(accountingEligibleLayers.map(row => clean(row.itemCode)).filter(Boolean));
  const saleSource=await saleSnapshot._activeDataset(db);
  const saleRows=await db.collection(saleSource.lineCollection).find({...saleSource.lineQuery,saleInvoiceType:2}).toArray().catch(()=>[]);
  const saleItems = new Set(saleRows.map(row => clean(row.itemCode)).filter(Boolean));
  const coveredRows = saleRows.filter(row => purchaseItems.has(clean(row.itemCode)));
  const totalSaleQuantity = saleRows.reduce((sum, row) => sum + Number(row.qty || 0), 0);
  const coveredSaleQuantity = coveredRows.reduce((sum, row) => sum + Number(row.qty || 0), 0);
  const totalSaleAmount = saleRows.reduce((sum, row) => sum + Number(row.saleValue || 0), 0);
  const coveredSaleAmount = coveredRows.reduce((sum, row) => sum + Number(row.saleValue || 0), 0);
  const missingPurchaseLayerItems = [...saleItems].filter(code => !purchaseItems.has(code)).sort();
  const invalidRows = layers.filter(row => row.validationStatus === 'rejected').length;
  const returnRows = await count(db.collection(LAYERS), canonicalLayerContract.canonicalPurchaseReturnQuery({ datasetId:active.datasetId }));
  const returnAccountedRows = await count(db.collection(LAYERS), canonicalLayerContract.canonicalPurchaseReturnQuery({ datasetId:active.datasetId, returnMatchStatus:{ $in:['matched', 'unmatched', 'ambiguous', 'quantity-exceeds-purchase'] } }));
  return {
    ok:true, available:true, datasetId:active.datasetId, datasetStatus:active.dataset?.status || '',
    profitActivationAllowed:false, fifoCalculationActivated:false,
    purchaseInvoices:Number(active.dataset?.purchaseInvoiceCount || 0),
    purchaseLines:layers.length, uniqueItems:purchaseItems.size,
    uniqueSuppliers:new Set(layers.map(row => clean(row.supplierAccountNumber || row.supplierGuid)).filter(Boolean)).size,
    saleItems:saleItems.size, saleItemsWithPurchaseLayer:saleItems.size - missingPurchaseLayerItems.length,
    itemCoveragePercent:saleItems.size ? Math.round((saleItems.size - missingPurchaseLayerItems.length) * 10000 / saleItems.size) / 100 : 0,
    totalSaleQuantity, coveredSaleQuantity,
    quantityPotentialCoveragePercent:totalSaleQuantity ? Math.round(coveredSaleQuantity * 10000 / totalSaleQuantity) / 100 : 0,
    totalSaleAmount:Math.round(totalSaleAmount), coveredSaleAmount:Math.round(coveredSaleAmount),
    saleValueEligiblePercent:totalSaleAmount ? Math.round(coveredSaleAmount * 10000 / totalSaleAmount) / 100 : 0,
    missingPurchaseLayerItemCount:missingPurchaseLayerItems.length,
    missingPurchaseLayerItems:missingPurchaseLayerItems.slice(0, 1000),
    rejectedPurchaseRows:invalidRows,
    purchaseReturns:{ rows:returnRows, accountedRows:returnAccountedRows, fullyRepresented:returnRows === returnAccountedRows },
    fifoReadiness:{
      itemCoverageAvailable:purchaseItems.size > 0,
      quantityCoverageComplete:false,
      layerQuantitiesInternallyConsistent:Number(active.dataset?.validation?.quantityInvariantErrors || 0) === 0,
      purchaseReturnsAccountedFor:returnRows === returnAccountedRows,
      deterministicAllocationEligible:false,
      reason:'FIFO allocation and financial outputs are intentionally disabled in 0.9.19.64'
    }
  };
}

async function buildRecoveryCandidate(db, options = {}) {
  await ensureIndexes(db);
  const previousActive=await activeDataset(db);
  if(!previousActive?.datasetId)throw Object.assign(new Error('Active canonical Purchase Dataset required'),{code:'PURCHASE_DATASET_REQUIRED'});
  const candidateIds=[...new Set((options.candidateIds||[]).map(clean).filter(Boolean))];
  if(!candidateIds.length)throw Object.assign(new Error('Reviewed recovery candidates required'),{code:'PURCHASE_RECOVERY_CANDIDATES_REQUIRED'});
  const reviewed=await db.collection('purchaseLayerRecoveryCandidates').find({candidateId:{$in:candidateIds},approvedForDatasetRebuild:true}).toArray();
  if(reviewed.length!==candidateIds.length)throw Object.assign(new Error('Every recovery candidate must be independently reviewed'),{code:'PURCHASE_RECOVERY_REVIEW_REQUIRED'});
  const datasetId=newDatasetId(),now=new Date();
  await db.collection(DATASETS).insertOne({datasetId,datasetSchemaVersion:SCHEMA_VERSION,scopeKey:SCOPE_KEY,status:'running',activationStatus:'candidate',activationRequested:false,mode:'recovery-candidate',baseDatasetId:previousActive.datasetId,sourceDateFrom:previousActive.dataset?.sourceDateFrom||'',sourceDateTo:previousActive.dataset?.sourceDateTo||'',sourceVersion:'canonical-purchase-engine-reviewed-recovery-v1',applicationVersion:APP_VERSION,gitSha:clean(process.env.GIT_COMMIT||process.env.COMMIT_SHA),createdAt:now,startedAt:now,updatedAt:now});
  const clonedLayerCount=await cloneActiveLayers(db,previousActive,datasetId);
  for(const row of reviewed){
    const mapped={...(row.canonicalLayer||{}),datasetId,datasetSchemaVersion:SCHEMA_VERSION,source:'canonical-purchase-engine-reviewed-recovery',recoveryCandidateId:row.candidateId,reviewedBy:row.reviewedBy||null,reviewedAt:row.reviewedAt||null,updatedAt:new Date()};
    if(!mapped.purchaseLineIdentity||mapped.layerKind!=='purchase')throw Object.assign(new Error(`Invalid canonical recovery layer ${row.candidateId}`),{code:'PURCHASE_RECOVERY_LAYER_INVALID'});
    mapped.sourceHash=clean(mapped.sourceHash)||sourceHash(mapped);
    await db.collection(LAYERS).updateOne({datasetId,purchaseLineIdentity:mapped.purchaseLineIdentity},layerUpsertUpdate(mapped),{upsert:true});
  }
  const returnAudit=await reconcilePurchaseReturns(db,datasetId);
  const {rows,validation}=await validateDataset(db,datasetId,{'3':true,'7':true},[]);
  validation.purchaseReturns=returnAudit;
  validation.valid=validation.valid&&returnAudit.quantityInvariantErrors===0;
  const fingerprints=datasetFingerprints(rows),completedAt=new Date();
  await db.collection(DATASETS).updateOne({datasetId},{$set:{status:validation.valid?'completed':'completed_with_errors',activationStatus:validation.valid?'validated-candidate':'rejected',completedAt,updatedAt:completedAt,clonedLayerCount,recoveredLayerCount:reviewed.length,reviewedRecoveryCandidateIds:candidateIds,layerCount:rows.length,validation,returnAudit,...fingerprints}});
  return {ok:validation.valid,datasetId,status:validation.valid?'completed':'completed_with_errors',activationStatus:validation.valid?'validated-candidate':'rejected',activeDatasetId:previousActive.datasetId,clonedLayerCount,recoveredLayerCount:reviewed.length,validation,...fingerprints,activationPerformed:false};
}

async function activateDataset(db,input={},requestedBy={}){
  await ensureIndexes(db);
  const role=clean(requestedBy.role).toLowerCase();
  if(!['admin','manager'].includes(role))throw Object.assign(new Error('Independent Management authorization is required'),{code:'PURCHASE_DATASET_ACTIVATION_FORBIDDEN',statusCode:403});
  const datasetId=clean(input.datasetId),reason=clean(input.reason);
  if(!datasetId||!reason)throw Object.assign(new Error('datasetId and activation reason are required'),{code:'PURCHASE_DATASET_ACTIVATION_INPUT_REQUIRED',statusCode:400});
  const dataset=await db.collection(DATASETS).findOne({datasetId});
  if(!dataset||dataset.status!=='completed'||!['validated-candidate','active','superseded'].includes(clean(dataset.activationStatus)))throw Object.assign(new Error('Only a completed validated immutable Purchase Candidate may become authoritative'),{code:'PURCHASE_DATASET_NOT_ACTIVATABLE',statusCode:409});
  if(!['PURCHASE_SOURCE_COMPLETE','PURCHASE_SOURCE_COMPLETE_WITH_EXPLICIT_QUARANTINE'].includes(clean(dataset.sourceCompleteness)))throw Object.assign(new Error('Purchase source completeness is not proven'),{code:'PURCHASE_SOURCE_INCOMPLETE',statusCode:409});
  const rows=await db.collection(LAYERS).find(canonicalLayerContract.canonicalLayerQuery({datasetId})).toArray();
  const fingerprints=datasetFingerprints(rows);
  if(fingerprints.layerFingerprint!==clean(dataset.layerFingerprint)||fingerprints.sourceFingerprint!==clean(dataset.sourceFingerprint))throw Object.assign(new Error('Candidate fingerprint changed after validation'),{code:'PURCHASE_DATASET_FINGERPRINT_MISMATCH',statusCode:409});
  const expected=clean(input.candidateFingerprint);
  if(!expected||expected!==clean(dataset.candidateFingerprint))throw Object.assign(new Error('Expected candidate fingerprint is required and must match'),{code:'PURCHASE_DATASET_ACTIVATION_STALE',statusCode:409});
  const previousState=await db.collection(STATE).findOne({scopeKey:SCOPE_KEY});
  const previousActiveDatasetId=clean(previousState?.activeDatasetId),activatedAt=new Date();
  const actor={userId:clean(requestedBy.userId||requestedBy.id),username:clean(requestedBy.username),role};
  const event={eventId:`PACT-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,eventType:previousActiveDatasetId&&previousActiveDatasetId!==datasetId?'PURCHASE_DATASET_AUTHORITY_CHANGED':'PURCHASE_DATASET_ACTIVATED',datasetId,previousActiveDatasetId,actor,at:activatedAt,reason,candidateFingerprint:clean(dataset.candidateFingerprint),sourceFingerprint:fingerprints.sourceFingerprint,layerFingerprint:fingerprints.layerFingerprint};
  const authorityAuditLog=[...(Array.isArray(previousState?.authorityAuditLog)?previousState.authorityAuditLog:[]),event].slice(-100);
  await db.collection(STATE).updateOne({scopeKey:SCOPE_KEY},{$set:{scopeKey:SCOPE_KEY,activeDatasetId:datasetId,previousActiveDatasetId,activatedAt,updatedAt:activatedAt,activeDatasetStatus:'completed',authorityAuditLog,lastAuthorityEvent:event}},{upsert:true});
  await db.collection(DATASETS).updateOne({datasetId},{$set:{activationStatus:'active',activatedAt,activatedBy:actor,activationReason:reason,updatedAt:activatedAt}});
  if(previousActiveDatasetId&&previousActiveDatasetId!==datasetId)await db.collection(DATASETS).updateOne({datasetId:previousActiveDatasetId},{$set:{activationStatus:'superseded',supersededAt:activatedAt,supersededByDatasetId:datasetId,updatedAt:activatedAt}});
  await db.collection(DIAGNOSTICS).insertOne({...event,immutable:true,applicationVersion:APP_VERSION});
  return {ok:true,activationPerformed:true,datasetId,previousActiveDatasetId,activeDatasetId:datasetId,event};
}

async function listDatasets(db, limit = 20) {
  await ensureIndexes(db);
  const active = await activeDataset(db);
  const list = await db.collection(DATASETS).find({}).sort({ createdAt:-1 }).limit(Math.max(1, Math.min(Number(limit || 20), 100))).toArray();
  return { ok:true, activeDatasetId:active?.datasetId || '', list:list.map(row => ({ ...row, isActive:row.datasetId === active?.datasetId })) };
}

async function status(db, datasetId = '') {
  await ensureIndexes(db);
  const active = await activeDataset(db);
  const dataset = datasetId
    ? await db.collection(DATASETS).findOne({ datasetId })
    : await db.collection(DATASETS).findOne({}, { sort:{ createdAt:-1 } });
  return { ok:true, activeDatasetId:active?.datasetId || '', dataset:dataset ? { ...dataset, isActive:dataset.datasetId === active?.datasetId } : null };
}

async function listLayers(db, filters = {}) {
  await ensureIndexes(db);
  const active=filters.datasetId
    ? {datasetId:clean(filters.datasetId)}
    : await activeDataset(db);
  if(!active?.datasetId)return {ok:true,datasetId:'',list:[],dataState:'no-active-dataset'};
  const query={datasetId:active.datasetId};
  if(filters.itemCode)query.itemCode=clean(filters.itemCode);
  if(filters.supplierAccountNumber)query.supplierAccountNumber=clean(filters.supplierAccountNumber);
  if(filters.layerKind)query.layerKind=clean(filters.layerKind);
  if(filters.validationStatus)query.validationStatus=clean(filters.validationStatus);
  const limit=Math.max(1,Math.min(Number(filters.limit||500),5000));
  const list=await db.collection(LAYERS).find(canonicalLayerContract.canonicalLayerQuery(query)).sort({purchaseInvoiceDate:1,purchaseInvoiceNo:1,sourceRow:1}).limit(limit).toArray();
  return {ok:true,datasetId:active.datasetId,dataState:list.length?'ready':'no-data',list};
}

async function populationDiagnostics(db) {
  const [rows,datasets,state]=await Promise.all([
    db.collection(LAYERS).find({}).toArray(),
    db.collection(DATASETS).find({}).toArray(),
    db.collection(STATE).findOne({scopeKey:SCOPE_KEY})
  ]);
  const canonicalRows=rows.filter(canonicalLayerContract.isCanonicalPurchaseLayer);
  const legacyRows=rows.filter(row=>!canonicalLayerContract.isCanonicalPurchaseLayer(row));
  const datasetById=new Map(datasets.map(row=>[clean(row.datasetId),row]));
  const grouped=new Map();
  for(const row of canonicalRows){const id=clean(row.datasetId);if(!grouped.has(id))grouped.set(id,[]);grouped.get(id).push(row);}
  const canonicalDatasets=[...grouped.entries()].map(([datasetId,list])=>{
    const dataset=datasetById.get(datasetId),identityCounts=new Map();
    for(const row of list){const identity=clean(row.purchaseLineIdentity);identityCounts.set(identity,(identityCounts.get(identity)||0)+1);}
    return {datasetId,classification:datasetId===clean(state?.activeDatasetId)?'active':(['candidate','validated-candidate'].includes(clean(dataset?.activationStatus))?'candidate':'historical'),status:clean(dataset?.status)||'orphan',activationStatus:clean(dataset?.activationStatus),count:list.length,withinDatasetDuplicateCount:[...identityCounts.values()].filter(value=>value>1).reduce((sum,value)=>sum+value-1,0),orphan:!dataset};
  }).sort((a,b)=>a.datasetId.localeCompare(b.datasetId,'en'));
  return {ok:true,readOnly:true,collectionTotal:rows.length,canonicalCount:canonicalRows.length,canonicalDatasets,legacyNoncanonicalCount:legacyRows.length,legacyClassification:canonicalLayerContract.CLASSIFICATION.LEGACY,orphanCanonicalCount:canonicalDatasets.filter(row=>row.orphan).reduce((sum,row)=>sum+row.count,0),withinDatasetDuplicateCount:canonicalDatasets.reduce((sum,row)=>sum+row.withinDatasetDuplicateCount,0)};
}

module.exports = {
  DATASETS, STATE, LAYERS, DIAGNOSTICS, SCOPE_KEY, SCHEMA_VERSION, SOURCE_TYPES,
  ensureIndexes, activeDataset, buildPurchaseLayerDataset, buildRecoveryCandidate, activateDataset, coverage, listDatasets, status, listLayers, populationDiagnostics,
  _mapSourceLine:mapSourceLine, _lineIdentity:lineIdentity, _reconcilePurchaseReturns:reconcilePurchaseReturns,
  _validateDataset:validateDataset, _safeError:safeError, _layerUpsertUpdate:layerUpsertUpdate,
  _responseTotalRecords:responseTotalRecords, _sourceHash:sourceHash,
  _datasetFingerprints:datasetFingerprints
};
