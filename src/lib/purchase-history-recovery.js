'use strict';

const crypto = require('crypto');
const defaultShaygan = require('./shaygan');
const purchaseLayerDataset = require('./purchase-layer-dataset');
const canonicalLayerContract = require('./canonical-purchase-layer-contract');
const accountingDecimal = require('./accounting-decimal');
const canonicalItemCatalog = require('./canonical-item-catalog');

const COLLECTION = 'purchaseLayerRecoveryCandidates';
const MODULE_VERSION = 'purchase-history-recovery-1.0.0';
const DEFAULT_MAX_ITEMS = 25;
const HARD_MAX_ITEMS = 100;
const DEFAULT_MAX_KARDEX_ROWS = 40;
const HARD_MAX_KARDEX_ROWS = 200;
const DEFAULT_TIMEOUT_MS = 5000;

function clean(value, max = 1000) { return String(value == null ? '' : value).trim().slice(0, max); }
function key(value) { return clean(value, 300).toLocaleLowerCase('en-US').replace(/[\s_-]+/g, ''); }
function finite(value) {
  const result = Number(String(value ?? '').replace(/[,،\s]/g, ''));
  return Number.isFinite(result) ? result : 0;
}
function bounded(value, fallback, hardMaximum) {
  const result = Math.trunc(Number(value));
  return Number.isSafeInteger(result) && result > 0 ? Math.min(result, hardMaximum) : fallback;
}
function safeError(value) {
  return clean(value, 2000)
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, 'mongodb://[REDACTED]')
    .replace(/((?:authorization|password|passwd|token|api[-_ ]?key|cookie)\s*[:=]\s*)[^\s,;"'<>]+/gi, '$1[REDACTED]');
}
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(name => `${JSON.stringify(name)}:${stable(value[name])}`).join(',')}}`;
  return JSON.stringify(value);
}
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function canonicalDate(value) {
  const digits = clean(value, 30).replace(/\D/g, '');
  return /^1[34]\d{6}$/.test(digits) ? digits : '';
}
function itemIdentity(row = {}) { return key(row.itemGuid) ? `guid:${key(row.itemGuid)}` : `code:${key(row.itemCode)}`; }
function isNotebook(row = {}) {
  return /notebook|laptop|نوت\s*بوک|لپ\s*تاپ/i.test([
    row.officialProductCategoryName, row.productCategory, row.mainGroup, row.itemDescription
  ].map(value => clean(value, 500)).join(' '));
}
function amountExact(value) {
  try { return accountingDecimal.format(accountingDecimal.parse(value || 0, accountingDecimal.MONEY_SCALE), accountingDecimal.MONEY_SCALE); }
  catch (_) { return '0.00'; }
}
function sourceRows(invoiceResponse = {}) {
  return Array.isArray(invoiceResponse.list) ? invoiceResponse.list :
    Array.isArray(invoiceResponse.result) ? invoiceResponse.result : [];
}
function invoiceBody(invoice = {}) {
  return Array.isArray(invoice.Body) ? invoice.Body : Array.isArray(invoice.Items) ? invoice.Items : [];
}
function chronology(purchaseDate, firstSaleDate, lastSaleDate) {
  if (!purchaseDate) return 'date_unverified';
  if (firstSaleDate && purchaseDate <= firstSaleDate) return 'eligible_before_first_sale';
  if (lastSaleDate && purchaseDate <= lastSaleDate) return 'eligible_for_later_sales_only';
  return 'after_all_observed_sales';
}

async function unresolvedPriority(db, fifoDatasetId, options = {}) {
  const maxItems = bounded(options.maxItems, DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS);
  const rows = await db.collection('fifoAllocations').find({ datasetId:fifoDatasetId, sourceType:'unknown_cost' }).toArray();
  const grouped = new Map();
  for (const row of rows) {
    const identity = itemIdentity(row);
    if (!identity || identity === 'code:') continue;
    const current = grouped.get(identity) || {
      itemGuid:clean(row.itemGuid, 100), itemCode:clean(row.itemCode, 100),
      itemDescription:clean(row.itemDescription, 500), officialProductCategoryName:clean(row.officialProductCategoryName || row.productCategory, 300),
      unknownLineCount:0, unknownQuantity:0, unknownSaleValue:0, firstSaleDate:'', lastSaleDate:''
    };
    current.unknownLineCount++;
    current.unknownQuantity += finite(row.quantityExact ?? row.unknownQty);
    current.unknownSaleValue += finite(row.allocatedSaleValueExact ?? row.allocatedSaleValue);
    const saleDate = canonicalDate(row.saleDate);
    if (saleDate && (!current.firstSaleDate || saleDate < current.firstSaleDate)) current.firstSaleDate = saleDate;
    if (saleDate && (!current.lastSaleDate || saleDate > current.lastSaleDate)) current.lastSaleDate = saleDate;
    grouped.set(identity, current);
  }
  const all = [...grouped.values()].sort((a,b) => b.unknownSaleValue-a.unknownSaleValue || a.itemCode.localeCompare(b.itemCode, 'en'));
  const notebookQuota = Math.min(all.filter(isNotebook).length, Math.max(1, Math.ceil(maxItems / 3)));
  const selected = all.filter(isNotebook).slice(0, notebookQuota);
  const selectedIds = new Set(selected.map(itemIdentity));
  for (const row of all) {
    if (selected.length >= maxItems) break;
    if (!selectedIds.has(itemIdentity(row))) { selected.push(row); selectedIds.add(itemIdentity(row)); }
  }
  return {
    totalUnresolvedItems:all.length,
    neverLiveCheckedItems:all.filter(row => !row.liveCheckedAt).length,
    selectedItems:selected.map((row, index) => ({ ...row, priorityRank:index + 1, notebookPriority:isNotebook(row), unknownSaleValueExact:amountExact(row.unknownSaleValue) }))
  };
}

async function recover(db, options = {}) {
  const api = options.shaygan || defaultShaygan;
  const fifoDatasetId = clean(options.fifoDatasetId, 100);
  const purchaseDatasetId = clean(options.purchaseDatasetId, 100);
  if (!fifoDatasetId || !purchaseDatasetId) throw Object.assign(new Error('fifoDatasetId and purchaseDatasetId are required'), { code:'PURCHASE_RECOVERY_SOURCE_REQUIRED' });
  const maxItems = bounded(options.maxItems, DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS);
  const maxKardexRows = bounded(options.maxKardexRows, DEFAULT_MAX_KARDEX_ROWS, HARD_MAX_KARDEX_ROWS);
  const timeoutMs = Math.min(bounded(options.timeoutMs, DEFAULT_TIMEOUT_MS, 15000), 15000);
  const priority = await unresolvedPriority(db, fifoDatasetId, { maxItems });
  await canonicalItemCatalog.ensureCatalogItems(db,priority.selectedItems,{source:'purchase-history-recovery-discovery'});
  const existing = await db.collection(purchaseLayerDataset.LAYERS).find(canonicalLayerContract.canonicalLayerQuery({ datasetId:purchaseDatasetId })).toArray();
  const existingIdentities = new Set(existing.map(row => clean(row.purchaseLineIdentity, 500)));
  const recovered = [];
  const failures = [];
  let kardexCallCount = 0;
  let invoiceCallCount = 0;
  for (const item of priority.selectedItems) {
    const kardex = await api.getKardexByItemCode(item.itemCode, '', { maxRows:maxKardexRows, hardMaxRows:maxKardexRows, timeoutMs })
      .catch(error => ({ ok:false, rows:[], error:error?.message || error }));
    kardexCallCount++;
    if (!kardex.ok) {
      failures.push({ itemCode:item.itemCode, stage:'kardex', error:safeError(kardex.error) });
      continue;
    }
    const purchaseMovements = (kardex.rows || []).filter(row => Number(row.invoiceType) === 3 && Number(row.invoiceNumber) > 0 && finite(row.inQty) > 0);
    const returnMovements = (kardex.rows || []).filter(row => Number(row.invoiceType) === 7 && Number(row.invoiceNumber) > 0);
    const invoiceNumbers = [...new Set(purchaseMovements.map(row => Number(row.invoiceNumber)))].sort((a,b)=>a-b);
    for (const invoiceNo of invoiceNumbers) {
      const response = await api.getInvoice(invoiceNo, 3, { timeoutMs }).catch(error => ({ ok:false, list:[], error:error?.message || error }));
      invoiceCallCount++;
      if (!response.ok) {
        failures.push({ itemCode:item.itemCode, invoiceNo, stage:'invoice-get', error:safeError(response.error) });
        continue;
      }
      for (const invoice of sourceRows(response).filter(row => Number(row.InvTyp || row.InvoiceType) === 3 && Number(row.InvNo || row.InvoiceNumber) === invoiceNo)) {
        for (const [index, line] of invoiceBody(invoice).entries()) {
          const code = clean(line.ItemNumber || line.ItemCode, 100);
          const guid = clean(line.ItemGuId || line.ItemGuid, 100);
          if ((item.itemGuid && guid && key(item.itemGuid) !== key(guid)) || (!guid && key(code) !== key(item.itemCode))) continue;
          const mapped = purchaseLayerDataset._mapSourceLine(invoice, line, index + 1, purchaseDatasetId);
          if (existingIdentities.has(mapped.purchaseLineIdentity)) continue;
          const purchaseDate = canonicalDate(mapped.purchaseInvoiceDate);
          const evidence = {
            candidateId:`PLREC-${sha256(`${fifoDatasetId}|${mapped.purchaseLineIdentity}`).slice(0,24)}`,
            schemaVersion:1, moduleVersion:MODULE_VERSION,
            sourceFifoDatasetId:fifoDatasetId, targetPurchaseDatasetId:purchaseDatasetId,
            itemGuid:mapped.itemGuid || item.itemGuid, itemCode:mapped.itemCode || item.itemCode,
            itemDescription:mapped.itemDescription || item.itemDescription,
            purchaseInvoiceIdentity:`3-${mapped.purchaseInvoiceNo}-${mapped.purchaseInvoiceGuid}`,
            purchaseInvoiceNo:mapped.purchaseInvoiceNo, purchaseInvoiceGuid:mapped.purchaseInvoiceGuid,
            purchaseLineIdentity:mapped.purchaseLineIdentity, purchaseLineItemId:mapped.sourceLineItemId,
            purchaseDate, supplierId:mapped.supplierAccountNumber || mapped.supplierGuid,
            supplierName:mapped.supplierName, quantity:mapped.originalQuantity,
            unitCost:mapped.netUnitCost, unitCostExact:amountExact(mapped.netUnitCost),
            sourceHash:mapped.sourceHash, eligibilityForFifoChronology:chronology(purchaseDate, item.firstSaleDate, item.lastSaleDate),
            firstSaleDate:item.firstSaleDate, lastSaleDate:item.lastSaleDate,
            affectedUnknownLineCount:item.unknownLineCount, affectedUnknownSaleValueExact:item.unknownSaleValueExact,
            purchaseReturnEvidence:returnMovements.slice(0,20).map(row => ({ invoiceNo:Number(row.invoiceNumber), date:canonicalDate(row.date), quantity:finite(row.outQty || row.inQty) })),
            canonicalLayer:{...mapped,datasetId:''},
            evidenceSource:'shaygan-kardex-plus-official-invoice-get', status:'detected',
            reviewRequired:true, approvedForDatasetRebuild:false
          };
          evidence.contentHash = sha256(stable({ ...evidence, candidateId:undefined, status:undefined }));
          recovered.push(evidence);
        }
      }
    }
  }
  if (options.persist === true) {
    for (const row of recovered) {
      const now = new Date();
      await db.collection(COLLECTION).updateOne(
        { sourceFifoDatasetId:fifoDatasetId, purchaseLineIdentity:row.purchaseLineIdentity },
        { $setOnInsert:{ ...row, createdBy:{ username:clean(options.actor?.username || 'fifo-r2-recovery', 100), role:clean(options.actor?.role || 'system', 50) }, revision:1, auditLog:[{ action:'official-evidence-detected', by:{ username:clean(options.actor?.username || 'fifo-r2-recovery', 100), role:clean(options.actor?.role || 'system', 50) }, at:now }], createdAt:now }, $set:{ lastVerifiedAt:now, updatedAt:now } },
        { upsert:true }
      );
    }
    for(const item of priority.selectedItems){
      const history=await canonicalItemCatalog.historyStatus(db,item);
      const identity=history.catalog?.canonicalIdentity||canonicalItemCatalog._identityOf(item);
      if(!identity)continue;
      const itemRecovered=recovered.filter(row=>row.itemCode===item.itemCode);
      const itemFailures=failures.filter(row=>row.itemCode===item.itemCode);
      await db.collection(canonicalItemCatalog.HISTORY_QUEUE).updateOne({canonicalIdentity:identity},{$set:{status:itemFailures.length?'failed':'pending_review',recoveredEvidenceCount:itemRecovered.length,lastAttemptAt:new Date(),lastError:itemFailures[0]?.error||'',updatedAt:new Date()},$inc:{attempts:1}},{upsert:true});
    }
  }
  return {
    ok:failures.length === 0,
    bounded:true, offlineReviewQueue:true, sourceReadOnly:true,
    sourceFifoDatasetId:fifoDatasetId, targetPurchaseDatasetId:purchaseDatasetId,
    maxItems, maxKardexRows, timeoutMs,
    totalUnresolvedItems:priority.totalUnresolvedItems,
    selectedItemCount:priority.selectedItems.length,
    notebookPriorityCount:priority.selectedItems.filter(row => row.notebookPriority).length,
    recoveredEvidenceCount:recovered.length,
    kardexCallCount, invoiceCallCount,
    persistedEvidenceCount:options.persist === true ? recovered.length : 0,
    layerWrites:0, activationPerformed:false,
    selectedItems:priority.selectedItems,
    recovered,
    failures
  };
}

module.exports = {
  COLLECTION, MODULE_VERSION, DEFAULT_MAX_ITEMS, HARD_MAX_ITEMS, DEFAULT_MAX_KARDEX_ROWS, HARD_MAX_KARDEX_ROWS,
  unresolvedPriority, recover,
  _chronology:chronology,
  _isNotebook:isNotebook
};
