'use strict';

const crypto = require('crypto');
const purchaseLayerDataset = require('./purchase-layer-dataset');
const canonicalLayerContract = require('./canonical-purchase-layer-contract');
const manualCostResolution = require('./manual-cost-resolution');
const openingAccountingCostBasis = require('./opening-accounting-cost-basis');
const saleSnapshot = require('./sale-snapshot');
const accountingDecimal = require('./accounting-decimal');
const profitProvenance = require('./fifo-profit-provenance');
const canonicalItemCatalog = require('./canonical-item-catalog');
const { APP_VERSION } = require('./app-version');
const { normalizeJalaliRange } = require('./jalali-date');

const DATASETS = 'fifoDatasets';
const ALLOCATIONS = 'fifoAllocations';
const DIAGNOSTICS = 'fifoDiagnostics';
const EXCEPTIONS = 'fifoExceptions';
const STATE = 'fifoDatasetState';
const SCOPE_KEY = 'fifo-shadow-v2-precision-evidence';
const SCHEMA_VERSION = 4;
const ALGORITHM_VERSION = 'fifo-shadow-v5-approved-opening-chronology';
const QUANTITY_SCALE = 6;
const VALUE_SCALE = 2;
const EPSILON = 0.000001;
const LOCK_MS = 15 * 60 * 1000;

function clean(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}
function identity(value) {
  return clean(value, 250).toLocaleLowerCase('en-US');
}
function finite(value) {
  const number = Number(String(value ?? '').replace(/[,،\s]/g, ''));
  return Number.isFinite(number) ? number : null;
}
function round(value, scale = QUANTITY_SCALE) {
  const factor = 10 ** scale;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
function percentage(value, total) {
  return total > 0 ? round(Number(value) * 100 / Number(total), 2) : 0;
}
function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}
function newDatasetId() {
  const date = new Date();
  const pad = value => String(value).padStart(2, '0');
  return `FIFO-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${crypto.randomBytes(3).toString('hex')}`;
}
function fail(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}
function safeError(value) {
  return clean(value, 2000)
    .replace(/mongodb(?:\+srv)?:\/\/[^\s"'<>]+/gi, 'mongodb://[REDACTED]')
    .replace(/((?:authorization|password|passwd|token|api[-_ ]?key)\s*[:=]\s*)[^\s,;"'<>]+/gi, '$1[REDACTED]');
}
function actor(input = {}) {
  return { username:clean(input.username || input.user || 'system', 100), role:clean(input.role || 'system', 50) };
}
function accountingReviewContext(input = {}) {
  if (!input || typeof input !== 'object') return null;
  const approvedDecisionIds = Array.isArray(input.approvedDecisionIds)
    ? [...new Set(input.approvedDecisionIds.map(value => clean(value, 100)).filter(Boolean))].slice(0, 5000)
    : [];
  const sessionId = clean(input.sessionId, 100);
  if (!sessionId) return null;
  return {
    sessionId,
    priorFifoDatasetId:clean(input.priorFifoDatasetId, 100),
    approvedDecisionIds,
    sourceSaleSnapshotId:clean(input.sourceSaleSnapshotId, 100),
    sourcePurchaseDatasetId:clean(input.sourcePurchaseDatasetId, 100),
    algorithmVersion:clean(input.algorithmVersion, 100),
    expectedProjectedImpact:finite(input.expectedProjectedImpact) || 0,
    shadowOnly:true
  };
}
function sourceKey(row) {
  const guid = identity(row.itemGuid);
  return guid ? `guid:${guid}` : `code:${identity(row.itemCode)}`;
}
function saleIdentity(row) {
  return clean(row.saleLineId, 300) ||
    `SL-${Number(row.saleInvoiceType || 0)}-${Number(row.saleInvoiceNo || 0)}-${Number(row.row || 0)}-${clean(row.itemCode, 100)}`;
}
function purchaseIdentity(row) {
  return clean(row.purchaseLineIdentity, 500) ||
    `PL-${Number(row.purchaseInvoiceNo || 0)}-${Number(row.sourceRow || 0)}-${clean(row.itemCode, 100)}`;
}
function validDate(value) {
  return /^\d{8}$/.test(clean(value, 8));
}
function compareSales(a, b) {
  return clean(a.saleDate).localeCompare(clean(b.saleDate), 'en') ||
    Number(a.saleInvoiceNo || 0) - Number(b.saleInvoiceNo || 0) ||
    Number(a.row || 0) - Number(b.row || 0) ||
    saleIdentity(a).localeCompare(saleIdentity(b), 'en');
}
function eventTimestamp(row) {
  const value = Date.parse(clean(row.createdDate, 100));
  return Number.isFinite(value) ? value : null;
}
function compareSaleEvents(a, b) {
  const dateOrder = clean(a.saleDate).localeCompare(clean(b.saleDate), 'en');
  if (dateOrder) return dateOrder;
  const aTime = eventTimestamp(a);
  const bTime = eventTimestamp(b);
  if (aTime != null && bTime != null && aTime !== bTime) return aTime - bTime;
  const aType = Number(a.saleInvoiceType || 0);
  const bType = Number(b.saleInvoiceType || 0);
  const aRef = Number(clean(a.generalRef, 100));
  const bRef = Number(clean(b.generalRef, 100));
  if (aType === 6 && bType === 2 && aRef === Number(b.saleInvoiceNo || 0)) return 1;
  if (bType === 6 && aType === 2 && bRef === Number(a.saleInvoiceNo || 0)) return -1;
  if (aType !== bType) return aType === 2 ? -1 : (bType === 2 ? 1 : aType - bType);
  return Number(a.saleInvoiceNo || 0) - Number(b.saleInvoiceNo || 0) ||
    Number(a.row || 0) - Number(b.row || 0) ||
    saleIdentity(a).localeCompare(saleIdentity(b), 'en');
}
function compareLayers(a, b) {
  return clean(a.purchaseInvoiceDate).localeCompare(clean(b.purchaseInvoiceDate), 'en') ||
    Number(a.purchaseInvoiceNo || 0) - Number(b.purchaseInvoiceNo || 0) ||
    Number(a.sourceRow || 0) - Number(b.sourceRow || 0) ||
    purchaseIdentity(a).localeCompare(purchaseIdentity(b), 'en');
}
function openingIdentity(row) {
  return clean(row.evidenceId, 100) || `OPENING-${clean(row.datasetId, 100)}-${sourceKey(row)}`;
}
function manualEffective(row, saleDate) {
  return row.status === 'approved' && row.deleted !== true &&
    validDate(row.effectiveFrom) && row.effectiveFrom <= saleDate &&
    (!row.effectiveTo || row.effectiveTo >= saleDate) &&
    finite(row.manualCostExact ?? row.manualCost) > 0;
}
function precisionFields(quantity, unitCost) {
  const precise = accountingDecimal.allocation(quantity, unitCost);
  return {
    precisionModel:'fixed-scale-bigint',
    quantityScale:accountingDecimal.QUANTITY_SCALE,
    unitCostScale:accountingDecimal.UNIT_COST_SCALE,
    allocationValueScale:accountingDecimal.MONEY_SCALE,
    roundingMode:accountingDecimal.ROUNDING_MODE,
    quantityExact:precise.quantityExact,
    unitCostExact:precise.unitCostExact,
    allocatedCostAmountExact:precise.allocationValueExact
  };
}
function unknownPrecisionFields(quantity) {
  const quantityScaled = accountingDecimal.parse(quantity, accountingDecimal.QUANTITY_SCALE);
  return {
    precisionModel:'fixed-scale-bigint',
    quantityScale:accountingDecimal.QUANTITY_SCALE,
    unitCostScale:accountingDecimal.UNIT_COST_SCALE,
    allocationValueScale:accountingDecimal.MONEY_SCALE,
    roundingMode:accountingDecimal.ROUNDING_MODE,
    quantityExact:accountingDecimal.format(quantityScaled, accountingDecimal.QUANTITY_SCALE),
    unitCostExact:null,
    allocatedCostAmountExact:null
  };
}
function assignSaleValuePrecision(rows, totalQuantity, totalSaleValue) {
  if (!rows.length) return;
  const totalQuantityScaled = accountingDecimal.parse(Math.abs(Number(totalQuantity || 0)), accountingDecimal.QUANTITY_SCALE);
  const totalValueScaled = accountingDecimal.parse(totalSaleValue || 0, accountingDecimal.MONEY_SCALE);
  if (totalQuantityScaled === 0n) return;
  let assigned = 0n;
  rows.forEach((row, index) => {
    const quantityScaled = accountingDecimal.parse(
      Math.abs(Number(row.allocatedQty || row.unknownQty || 0)),
      accountingDecimal.QUANTITY_SCALE
    );
    const valueScaled = index === rows.length - 1
      ? totalValueScaled - assigned
      : accountingDecimal.divideRounded(totalValueScaled * quantityScaled, totalQuantityScaled);
    assigned += valueScaled;
    row.saleValueExact = accountingDecimal.format(totalValueScaled, accountingDecimal.MONEY_SCALE);
    row.allocatedSaleValueExact = accountingDecimal.format(valueScaled, accountingDecimal.MONEY_SCALE);
    row.allocatedSaleValue = accountingDecimal.toNumber(valueScaled, accountingDecimal.MONEY_SCALE);
  });
}
function eligibleOfficial(row) {
  const quantity = finite(row.netPurchasedQuantity ?? row.remainingQuantity ?? row.originalQuantity);
  const unitCost = finite(row.netUnitCost ?? row.grossUnitCost);
  return row.layerKind === 'purchase' &&
    row.validationStatus !== 'rejected' &&
    row.costStatus !== 'pending-purchase-price-correction' &&
    quantity != null && quantity > 0 &&
    unitCost != null && unitCost > 0 &&
    validDate(row.purchaseInvoiceDate);
}
function addIndex(map, key, value) {
  if (!key) return;
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}
function indexRows(rows) {
  const byGuid = new Map();
  const byCode = new Map();
  for (const row of rows) {
    addIndex(byGuid, identity(row.itemGuid), row);
    addIndex(byCode, identity(row.itemCode), row);
  }
  return { byGuid, byCode };
}
function matchingRows(index, sale) {
  const guid = identity(sale.itemGuid);
  if (guid) {
    const exact = index.byGuid.get(guid) || [];
    const missingGuidSameCode = (index.byCode.get(identity(sale.itemCode)) || []).filter(row => !identity(row.itemGuid));
    return [...new Set([...exact, ...missingGuidSameCode])];
  }
  return index.byCode.get(identity(sale.itemCode)) || [];
}
function classifyUnknownSource(sale, source, eligibleForSale, manuals) {
  if (manuals.length > 1) return 'ambiguous_manual_resolution';
  if (eligibleForSale.length) return 'negative_inventory_chronology';
  const allIndex = indexRows(source.purchaseLayers || []);
  const allMatches = matchingRows(allIndex, sale);
  const unresolvedReturn = allMatches.some(row => row.layerKind === 'purchase-return' && row.returnMatchStatus !== 'matched');
  if (unresolvedReturn) return 'purchase_return_affected';
  const futurePurchase = allMatches.some(row => row.layerKind === 'purchase' && validDate(row.purchaseInvoiceDate) && row.purchaseInvoiceDate > sale.saleDate);
  if (futurePurchase) return 'purchase_chronology_problem';
  const pendingPurchasePrice = allMatches.some(row => row.layerKind === 'purchase' && row.costStatus === 'pending-purchase-price-correction');
  if (pendingPurchasePrice) return 'purchase_price_pending_correction';
  const invalidPurchase = allMatches.some(row => row.layerKind === 'purchase');
  if (invalidPurchase) return 'purchase_exists_but_invalid_cost';
  const sameCodeDifferentGuid = (allIndex.byCode.get(identity(sale.itemCode)) || []).some(row => identity(row.itemGuid) && identity(row.itemGuid) !== identity(sale.itemGuid));
  if (sameCodeDifferentGuid && identity(sale.itemGuid)) return 'purchase_identity_mismatch';
  const sourceFrom = clean(source.purchaseActive?.dataset?.sourceDateFrom, 8);
  const positiveHistoryEvidence = [sale.openingQuantity,sale.inventoryQuantity,sale.currentInventory,sale.stockQuantity].some(value => (finite(value) || 0) > 0);
  if (sourceFrom && sale.saleDate < sourceFrom && positiveHistoryEvidence) return 'opening_inventory_candidate';
  if (sourceFrom && sale.saleDate < sourceFrom) return 'purchase_history_outside_dataset_range';
  return 'no_purchase_history_available';
}
function openingUnknownReason(sale, source, currentSaleAllocations = []) {
  const rows = matchingRows(indexRows(source.openingRows || []), sale);
  if (!rows.length) return '';
  const baseDate = rows.map(row => clean(row.effectiveOpeningDate || row.openingDate, 8)).filter(validDate).sort()[0];
  if (baseDate && clean(sale.saleDate, 8) < baseDate) return 'PRE_OPENING_PERIOD';
  if (currentSaleAllocations.some(row => row.sourceType === 'approved_opening_accounting_cost')) return 'OPENING_PARTIAL';
  return 'OPENING_CAPACITY_EXHAUSTED';
}
function immutableProjection(row) {
  return {
    saleLineId:row.saleLineId,
    saleInvoiceType:row.saleInvoiceType,
    saleInvoiceNo:row.saleInvoiceNo,
    saleDate:row.saleDate,
    itemGuid:row.itemGuid,
    itemCode:row.itemCode,
    qty:round(row.qty),
    saleValue:round(row.saleValue, VALUE_SCALE),
    sourceType:row.sourceType,
    costSourceType:row.costSourceType || profitProvenance.allocationSourceType(row),
    sourceReference:row.openingEvidenceId || row.purchaseLineIdentity || row.manualResolutionId || '',
    allocatedQty:round(row.allocatedQty),
    unknownQty:round(row.unknownQty),
    unitCost:row.unitCost == null ? null : round(row.unitCost, VALUE_SCALE),
    allocatedCostAmountExact:row.allocatedCostAmountExact ?? null,
    allocatedSaleValueExact:row.allocatedSaleValueExact ?? null,
    quantityExact:row.quantityExact ?? null,
    unitCostExact:row.unitCostExact ?? null,
    returnResolutionId:row.saleReturnResolutionId || row.purchaseReturnResolutionId || '',
    openingDatasetId:row.openingDatasetId || '',
    openingEvidenceId:row.openingEvidenceId || '',
    openingBaseDate:row.openingBaseDate || '',
    openingRecordFingerprint:row.openingRecordFingerprint || ''
  };
}

const indexReadyByDb = new WeakMap();
async function initializeIndexes(db) {
  const existing = new Set((await db.listCollections().toArray()).map(row => row.name));
  for (const name of [DATASETS, ALLOCATIONS, DIAGNOSTICS, EXCEPTIONS, STATE]) {
    if (!existing.has(name)) await db.createCollection(name).catch(() => {});
  }
  await db.collection(DATASETS).createIndex({ datasetId:1 }, { unique:true });
  await db.collection(DATASETS).createIndex({ status:1, completedAt:-1 });
  await db.collection(DATASETS).createIndex({ sourceSaleSnapshotId:1, sourcePurchaseDatasetId:1, algorithmVersion:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, allocationId:1 }, { unique:true });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, saleLineId:1, allocationSequence:1 }, { unique:true });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, itemCode:1, saleDate:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, itemGuid:1, saleDate:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, sellerAccountNumber:1, saleLineId:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, sellerIdentity:1, saleLineId:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, officialProductCategoryGuid:1, saleLineId:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, productCategoryGuid:1, saleLineId:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, officialProductCategoryName:1, saleLineId:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, productCategory:1, saleLineId:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, saleDate:1, saleInvoiceNo:1, saleLineId:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, sourceType:1, saleDate:1, saleLineId:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, purchaseLineIdentity:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, manualResolutionId:1 });
  await db.collection(DIAGNOSTICS).createIndex({ datasetId:1, at:1 });
  await db.collection(EXCEPTIONS).createIndex({ datasetId:1, exceptionKey:1 }, { unique:true });
  await db.collection(EXCEPTIONS).createIndex({ datasetId:1, status:1, code:1, itemCode:1 });
  await db.collection(STATE).createIndex({ scopeKey:1 }, { unique:true });
  return { ok:true, schemaVersion:SCHEMA_VERSION, algorithmVersion:ALGORITHM_VERSION };
}
async function ensureIndexes(db) {
  if(!indexReadyByDb.has(db))indexReadyByDb.set(db,initializeIndexes(db).catch(error=>{indexReadyByDb.delete(db);throw error;}));
  return indexReadyByDb.get(db);
}

async function count(collection, query = {}) {
  if (typeof collection.countDocuments === 'function') return Number(await collection.countDocuments(query));
  return (await collection.find(query).toArray()).length;
}
async function insertMany(collection, rows, batchSize = 500) {
  let inserted = 0;
  for (let start = 0; start < rows.length; start += batchSize) {
    const batch = rows.slice(start, start + batchSize);
    if (typeof collection.insertMany === 'function') {
      const result = await collection.insertMany(batch, { ordered:true });
      inserted += Number(result.insertedCount ?? batch.length);
    } else {
      for (const row of batch) {
        await collection.insertOne(row);
        inserted++;
      }
    }
  }
  return inserted;
}
async function diagnostic(db, datasetId, phase, details = {}) {
  await db.collection(DIAGNOSTICS).insertOne({
    datasetId,
    phase:clean(phase, 100),
    details,
    algorithmVersion:ALGORITHM_VERSION,
    at:new Date()
  });
}
async function ensureState(db) {
  await db.collection(STATE).updateOne(
    { scopeKey:SCOPE_KEY },
    { $setOnInsert:{ scopeKey:SCOPE_KEY, activeDatasetId:'', createdAt:new Date(), updatedAt:new Date() } },
    { upsert:true }
  );
}
async function acquireLock(db, ownerId) {
  await ensureState(db);
  const now = new Date();
  const result = await db.collection(STATE).updateOne(
    {
      scopeKey:SCOPE_KEY,
      $or:[
        { buildLockOwner:{ $exists:false } },
        { buildLockOwner:'' },
        { buildLockOwner:ownerId },
        { buildLockExpiresAt:{ $lte:now } }
      ]
    },
    { $set:{ buildLockOwner:ownerId, buildLockAcquiredAt:now, buildLockExpiresAt:new Date(now.getTime() + LOCK_MS), updatedAt:now } }
  );
  if (!result.matchedCount) fail('FIFO_BUILD_LOCKED', 'یک ساخت FIFO Shadow دیگر در حال اجرا است.', 409);
}
async function renewLock(db, ownerId) {
  const now = new Date();
  const result = await db.collection(STATE).updateOne(
    { scopeKey:SCOPE_KEY, buildLockOwner:ownerId },
    { $set:{ buildLockExpiresAt:new Date(now.getTime() + LOCK_MS), updatedAt:now } }
  );
  if (!result.matchedCount) fail('FIFO_BUILD_LOCK_LOST', 'قفل ساخت FIFO Shadow از دست رفته است.', 409);
}
async function releaseLock(db, ownerId) {
  await db.collection(STATE).updateOne(
    { scopeKey:SCOPE_KEY, buildLockOwner:ownerId },
    { $set:{ buildLockOwner:'', buildLockReleasedAt:new Date(), buildLockExpiresAt:new Date(0), updatedAt:new Date() } }
  ).catch(() => {});
}

async function activeDataset(db) {
  await ensureIndexes(db);
  const state = await db.collection(STATE).findOne({ scopeKey:SCOPE_KEY });
  if (!state?.activeDatasetId) return null;
  const dataset = await db.collection(DATASETS).findOne({ datasetId:state.activeDatasetId });
  if (!dataset || dataset.status !== 'completed' || !['validated-shadow','active-shadow'].includes(dataset.activationStatus)) return null;
  return { datasetId:dataset.datasetId, dataset, state };
}

async function loadSources(db, pinned = {}) {
  const saleActive = pinned.saleSnapshotId
    ? {
        snapshotId:pinned.saleSnapshotId,
        snapshot:await db.collection('saleSnapshots').findOne({ snapshotId:pinned.saleSnapshotId }),
        lineCollection:'saleSnapshotDatasetLines',
        headerCollection:'saleSnapshotDatasetHeaders',
        lineQuery:{ snapshotId:pinned.saleSnapshotId },
        headerQuery:{ snapshotId:pinned.saleSnapshotId }
      }
    : await saleSnapshot._activeDataset(db);
  const purchaseActive = pinned.purchaseDatasetId
    ? {
        datasetId:pinned.purchaseDatasetId,
        dataset:await db.collection(purchaseLayerDataset.DATASETS).findOne({ datasetId:pinned.purchaseDatasetId })
      }
    : await purchaseLayerDataset.activeDataset(db);
  if (!saleActive?.snapshotId || !saleActive.snapshot || saleActive.snapshot.status !== 'completed') {
    fail('FIFO_SOURCE_SALE_MISSING', 'Sale Snapshot کامل و قابل استفاده پیدا نشد.', 409);
  }
  if (!purchaseActive?.datasetId || !purchaseActive.dataset || purchaseActive.dataset.status !== 'completed') {
    fail('FIFO_SOURCE_PURCHASE_MISSING', 'Purchase Layer Dataset کامل و قابل استفاده پیدا نشد.', 409);
  }
  let openingActive = null;
  let openingRows = [];
  if (pinned.openingDatasetId) {
    const dataset = await db.collection(openingAccountingCostBasis.DATASETS).findOne({ datasetId:pinned.openingDatasetId });
    if (!dataset || dataset.status !== 'completed' || dataset.approvalStatus !== 'approved') {
      fail('FIFO_SOURCE_OPENING_NOT_APPROVED', 'Opening Accounting Evidence کامل و مصوب پیدا نشد.', 409);
    }
    const governance = await openingAccountingCostBasis._immutableGovernanceSnapshot(db, dataset);
    const expected = pinned.openingFingerprints || {};
    if (clean(expected.dataset, 64) && clean(expected.dataset, 64) !== governance.datasetFingerprint) {
      fail('FIFO_SOURCE_OPENING_FINGERPRINT_MISMATCH', 'Opening Dataset fingerprint mismatch.', 409);
    }
    if (clean(expected.source, 64) && clean(expected.source, 64) !== governance.sourceFingerprint) {
      fail('FIFO_SOURCE_OPENING_FINGERPRINT_MISMATCH', 'Opening source fingerprint mismatch.', 409);
    }
    if (clean(expected.eligibility, 64) && clean(expected.eligibility, 64) !== governance.eligibilityFingerprint) {
      fail('FIFO_SOURCE_OPENING_FINGERPRINT_MISMATCH', 'Opening eligibility fingerprint mismatch.', 409);
    }
    openingActive = { datasetId:dataset.datasetId, dataset, governance };
    openingRows = governance.evidence.filter(row => row.status === 'VALIDATED_CANDIDATE' && row.extractionComplete === true);
  }
  const [saleLines, saleHeaders, purchaseLayers, manuals, purchaseReturnResolutions, saleReturnResolutions] = await Promise.all([
    db.collection(saleActive.lineCollection).find(saleActive.lineQuery).toArray(),
    db.collection(saleActive.headerCollection).find(saleActive.headerQuery).toArray(),
    db.collection(purchaseLayerDataset.LAYERS).find(canonicalLayerContract.canonicalLayerQuery({ datasetId:purchaseActive.datasetId })).toArray(),
    db.collection(manualCostResolution.COLLECTION).find({ status:'approved', deleted:{ $ne:true } }).toArray(),
    db.collection('purchaseReturnResolutions').find({ status:'confirmed_linked' }).toArray(),
    db.collection('saleReturnResolutions').find({ status:'confirmed_linked' }).toArray()
  ]);
  return { saleActive, purchaseActive, openingActive, saleLines, saleHeaders, purchaseLayers, openingRows, manuals, purchaseReturnResolutions, saleReturnResolutions };
}
async function loadSourcesWithRetry(db, pinned, options, datasetId) {
  const maxAttempts = Math.max(1, Math.min(Number(options.maxAttempts || 3), 5));
  const retryDelayMs = Math.max(0, Math.min(Number(options.retryDelayMs ?? 50), 1000));
  const loader = options.sourceLoader || loadSources;
  const attempts = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      const bundle = await loader(db, pinned);
      attempts.push({ attempt, ok:true, durationMs:Date.now() - startedAt });
      return { bundle, retryCount:attempt - 1, attempts };
    } catch (error) {
      attempts.push({ attempt, ok:false, durationMs:Date.now() - startedAt, error:safeError(error?.message || error) });
      if (attempt >= maxAttempts) throw Object.assign(error instanceof Error ? error : new Error(String(error)), { attempts });
      await new Promise(resolve => setTimeout(resolve, retryDelayMs));
      await renewLock(db, datasetId);
    }
  }
  fail('FIFO_SOURCE_READ_FAILED', 'خواندن منابع FIFO Shadow ناموفق بود.', 500);
}

function exception(datasetId, code, status, details = {}) {
  const keyMaterial = [
    code,
    details.saleLineId,
    details.purchaseLineIdentity,
    details.saleReturnLineId,
    details.itemCode,
    details.reference
  ].map(value => clean(value, 500)).join('|');
  return {
    datasetId,
    exceptionKey:sha256(keyMaterial),
    code,
    status,
    severity:details.severity || (status === 'unresolved' ? 'warning' : 'info'),
    itemGuid:clean(details.itemGuid, 100),
    itemCode:clean(details.itemCode, 100),
    saleLineId:clean(details.saleLineId, 500),
    saleReturnLineId:clean(details.saleReturnLineId, 500),
    purchaseLineIdentity:clean(details.purchaseLineIdentity, 500),
    reference:clean(details.reference, 500),
    reason:clean(details.reason, 1000),
    algorithmVersion:ALGORITHM_VERSION,
    createdAt:new Date()
  };
}

function allocateSources(datasetId, source, filters = {}) {
  const dates = normalizeJalaliRange({ dateFrom:filters.dateFrom || '', dateTo:filters.dateTo || '' });
  const sales = source.saleLines
    .filter(row => Number(row.saleInvoiceType) === 2)
    // FIFO must consume every historical sale available in the immutable Snapshot.
    // dateFrom is retained as report metadata only; truncating earlier sales would
    // incorrectly leave historical purchase layers available for later sales.
    .filter(row => !dates.dateTo || clean(row.saleDate) <= dates.dateTo)
    .sort(compareSales);
  const saleReturns = source.saleLines.filter(row => Number(row.saleInvoiceType) === 6).sort(compareSales);
  const officialRows = source.purchaseLayers.filter(eligibleOfficial).sort(compareLayers).map(row => ({
    ...row,
    fifoRemainingQuantity:round(finite(row.netPurchasedQuantity ?? row.remainingQuantity ?? row.originalQuantity)),
    confirmedReturnAdjustmentQuantity:0,
    purchaseReturnResolutionIds:[]
  }));
  for(const manual of source.manuals.filter(row=>row.resolutionScope==='purchase_layer')){
    const target=source.purchaseLayers.find(row=>purchaseIdentity(row)===clean(manual.purchaseLineIdentity,500)&&clean(row.datasetId,100)===clean(manual.purchaseDatasetId,100));
    if(!target||target.layerKind!=='purchase'||eligibleOfficial(target))continue;
    const available=finite(target.netPurchasedQuantity??target.remainingQuantity??target.originalQuantity)||0;
    const scoped=finite(manual.targetQuantityExact)||0;
    if(available<=EPSILON||scoped<=EPSILON||!validDate(target.purchaseInvoiceDate))continue;
    officialRows.push({...target,validationStatus:'manual-cost-approved',netUnitCost:manual.manualCostExact??manual.manualCost,fifoRemainingQuantity:round(Math.min(available,scoped)),confirmedReturnAdjustmentQuantity:0,purchaseReturnResolutionIds:[],fifoSourceType:'approved_manual_purchase_layer',manualResolutionId:clean(manual.resolutionId,100),manualCostScope:'purchase_layer',manualRevision:Number(manual.revision||0),manualContentHash:clean(manual.contentHash,64),manualCreatedBy:actor(manual.createdBy||{}),manualApprovedBy:actor(manual.approvedBy||{}),manualApprovedAt:manual.approvedAt||null,manualCostExact:clean(manual.manualCostExact??manual.manualCost,100)});
  }
  for(const manual of source.manuals.filter(row=>['opening_quantity','evidence_quantity'].includes(row.resolutionScope))){
    const scoped=finite(manual.targetQuantityExact)||0;
    if(scoped<=EPSILON||!validDate(manual.effectiveFrom)||finite(manual.manualCostExact??manual.manualCost)<=0)continue;
    officialRows.push({
      datasetId:source.purchaseActive.datasetId,
      purchaseLineIdentity:`MANUAL-EVIDENCE-${clean(manual.resolutionId,100)}`,
      layerKind:'governed-manual-evidence-quantity',validationStatus:'manual-cost-approved',
      purchaseInvoiceDate:clean(manual.effectiveFrom,8),purchaseInvoiceNo:0,sourceRow:0,
      itemGuid:clean(manual.itemGuid,100),itemCode:clean(manual.itemCode,100),itemDescription:'',
      netPurchasedQuantity:scoped,netUnitCost:manual.manualCostExact??manual.manualCost,
      fifoRemainingQuantity:round(scoped),confirmedReturnAdjustmentQuantity:0,purchaseReturnResolutionIds:[],
      fifoSourceType:manual.resolutionScope==='opening_quantity'?'approved_manual_opening_quantity':'approved_manual_evidence_quantity',manualResolutionId:clean(manual.resolutionId,100),manualCostScope:clean(manual.resolutionScope,50),manualRevision:Number(manual.revision||0),manualContentHash:clean(manual.contentHash,64),manualCreatedBy:actor(manual.createdBy||{}),manualApprovedBy:actor(manual.approvedBy||{}),manualApprovedAt:manual.approvedAt||null,manualCostExact:clean(manual.manualCostExact??manual.manualCost,100)
    });
  }
  for (const opening of source.openingRows || []) {
    const quantity = finite(opening.openingQuantityExact);
    const unitCost = finite(opening.openingUnitCostExact);
    const openingDate = clean(opening.effectiveOpeningDate || opening.openingDate, 8);
    if (!(quantity > EPSILON) || !(unitCost > 0) || !validDate(openingDate)) continue;
    officialRows.push({
      datasetId:source.purchaseActive.datasetId,
      purchaseLineIdentity:`OPENING-${openingIdentity(opening)}`,
      layerKind:'governed-opening-accounting-cost',
      validationStatus:'approved-opening-accounting-cost',
      purchaseInvoiceDate:openingDate,
      purchaseInvoiceNo:0,
      sourceRow:0,
      itemGuid:clean(opening.itemGuid,100),
      itemCode:clean(opening.itemCode,100),
      itemDescription:clean(opening.itemDescription,500),
      netPurchasedQuantity:quantity,
      netUnitCost:opening.openingUnitCostExact,
      fifoRemainingQuantity:round(quantity),
      confirmedReturnAdjustmentQuantity:0,
      purchaseReturnResolutionIds:[],
      fifoSourceType:'approved_opening_accounting_cost',
      openingDatasetId:clean(source.openingActive?.datasetId,100),
      openingEvidenceId:openingIdentity(opening),
      openingBaseDate:openingDate,
      openingOriginalQuantityExact:clean(opening.openingQuantityExact,100),
      openingUnitCostExact:clean(opening.openingUnitCostExact,100),
      openingTotalValueExact:clean(opening.openingTotalValueExact,100),
      openingWarehouseEvidence:Array.isArray(opening.warehouseEvidence) ? opening.warehouseEvidence : [],
      openingWarehouseFingerprint:clean(opening.sourceFingerprint,64),
      openingRecordFingerprint:clean(opening.recordFingerprint,64),
      openingApprovalStatus:'approved',
      openingApprovalRevision:Number(source.openingActive?.dataset?.revision || 0),
      openingApprovedBy:source.openingActive?.dataset?.decidedBy || null,
      openingApprovedAt:source.openingActive?.dataset?.decidedAt || null
    });
  }
  officialRows.sort(compareLayers);
  const purchaseReturns = source.purchaseLayers.filter(row => row.layerKind === 'purchase-return');
  const purchaseReturnByIdentity = new Map(purchaseReturns.map(row => [purchaseIdentity(row), row]));
  const officialByIdentity = new Map(officialRows.map(row => [purchaseIdentity(row), row]));
  for (const resolution of source.purchaseReturnResolutions || []) {
    const returnRow = purchaseReturnByIdentity.get(clean(resolution.returnLineIdentity, 500));
    const target = officialByIdentity.get(clean(resolution.selectedPurchaseLayer, 500));
    if (!returnRow || !target || returnRow.returnMatchStatus === 'matched') continue;
    const returnQuantity = Math.abs(finite(resolution.returnQuantity) || finite(returnRow.originalQuantity || returnRow.returnedQuantity) || 0);
    if (returnQuantity <= EPSILON) continue;
    target.fifoRemainingQuantity = round(Math.max(0, target.fifoRemainingQuantity - returnQuantity));
    target.confirmedReturnAdjustmentQuantity = round(target.confirmedReturnAdjustmentQuantity + returnQuantity);
    target.purchaseReturnResolutionIds.push(clean(resolution.resolutionId, 100));
  }
  const officialIndex = indexRows(officialRows);
  const manualIndex = indexRows(source.manuals.filter(row=>!row.resolutionScope||row.resolutionScope==='item'));
  const allocations = [];
  const exceptions = [];
  const consumedByLayer = new Map();
  const sourceSaleLineIds = new Set();
  const sourceReturnLineIds = new Set();
  let allocationSequenceGlobal = 0;

  const saleHeadersByGuid = new Map();
  for (const header of source.saleHeaders.filter(row => Number(row.invTyp) === 2)) {
    const key = identity(header.guId);
    if (key) addIndex(saleHeadersByGuid, key, header);
  }
  const salesByInvoice = new Map();
  for (const sale of sales) addIndex(salesByInvoice, String(Number(sale.saleInvoiceNo || 0)), sale);
  const confirmedSaleReturns = new Map((source.saleReturnResolutions || []).map(row => [clean(row.returnLineIdentity, 500), row]));
  const originalAllocations = new Map();
  const reversedByAllocation = new Map();
  const sameItem = (a, b) => {
    const aGuid = identity(a.itemGuid);
    const bGuid = identity(b.itemGuid);
    return aGuid && bGuid ? aGuid === bGuid : identity(a.itemCode) === identity(b.itemCode);
  };
  const resolveReturn = row => {
    const returnLineId = saleIdentity(row);
    const resolution = confirmedSaleReturns.get(returnLineId);
    if (resolution?.selectedOriginalSaleLineId) {
      return {
        originalSaleLineId:clean(resolution.selectedOriginalSaleLineId, 500),
        resolution,
        linkageSource:'CONFIRMED_RESOLUTION',
        linkageReference:clean(resolution.resolutionId, 100)
      };
    }
    const referenceGuid = identity(row.relatedInvHeaderId || row.invHeaderIdRoot);
    const headers = referenceGuid ? saleHeadersByGuid.get(referenceGuid) || [] : [];
    const headerInvoices = new Set(headers.map(header => Number(header.invNo || header.saleInvoiceNo || 0)).filter(Boolean));
    const generalRef = Number(clean(row.generalRef, 100));
    const invoiceNumbers = new Set([...headerInvoices, ...(Number.isFinite(generalRef) && generalRef > 0 ? [generalRef] : [])]);
    const candidates = [...invoiceNumbers]
      .flatMap(invoiceNo => salesByInvoice.get(String(invoiceNo)) || [])
      .filter(sale => sameItem(sale, row) && clean(sale.saleDate) <= clean(row.saleDate));
    const unique = [...new Map(candidates.map(sale => [saleIdentity(sale), sale])).values()];
    if (unique.length !== 1) {
      return {
        originalSaleLineId:'',
        resolution:null,
        linkageSource:unique.length ? 'AMBIGUOUS_SOURCE_REFERENCE' : 'UNLINKED',
        linkageReference:clean(row.generalRef || row.relatedInvHeaderId || row.invHeaderIdRoot, 200),
        candidateCount:unique.length
      };
    }
    return {
      originalSaleLineId:saleIdentity(unique[0]),
      resolution:null,
      linkageSource:headerInvoices.has(Number(unique[0].saleInvoiceNo || 0)) ? 'SOURCE_HEADER_GUID' : 'SOURCE_GENERAL_REF',
      linkageReference:clean(row.generalRef || row.relatedInvHeaderId || row.invHeaderIdRoot, 200),
      candidateCount:1
    };
  };

  for (const sale of [...sales, ...saleReturns].sort(compareSaleEvents)) {
    if (Number(sale.saleInvoiceType) === 6) {
      const returnLineId = saleIdentity(sale);
      if (sourceReturnLineIds.has(returnLineId)) {
        exceptions.push(exception(datasetId, 'DUPLICATE_SALE_RETURN_LINE', 'unresolved', {
          saleReturnLineId:returnLineId,itemGuid:sale.itemGuid,itemCode:sale.itemCode,
          reason:'Sale Snapshot contains a duplicate sale-return line identity; the duplicate was not applied.'
        }));
        continue;
      }
      sourceReturnLineIds.add(returnLineId);
      const link = resolveReturn(sale);
      const originals = link.originalSaleLineId
        ? (originalAllocations.get(link.originalSaleLineId) || []).slice().sort((a,b)=>Number(b.allocationSequence||0)-Number(a.allocationSequence||0))
        : [];
      if (!link.originalSaleLineId || !originals.length) {
        exceptions.push(exception(datasetId, 'SALE_RETURN_NOT_ALLOCATED', link.originalSaleLineId ? 'return-without-original-allocation' : 'unresolved', {
          saleReturnLineId:returnLineId,
          itemGuid:sale.itemGuid,
          itemCode:sale.itemCode,
          reference:link.linkageReference,
          reason:link.originalSaleLineId
            ? `Sale return has deterministic ${link.linkageSource} linkage, but the original sale has no allocation to reverse.`
            : `Sale return linkage is ${link.linkageSource.toLowerCase().replace(/_/g, '-')}; no FIFO allocation was generated.`
        }));
        continue;
      }
      let returnNeed = round(Math.abs(finite(sale.qty) || finite(link.resolution?.returnQuantity) || 0));
      const returnQuantity = returnNeed;
      const originalQuantityTotal = round(originals.reduce((sum, row) => sum + Math.abs(finite(row.allocatedQty || row.unknownQty) || 0), 0));
      if (originals.length > 1 && returnNeed + EPSILON < originalQuantityTotal) {
        exceptions.push(exception(datasetId, 'SALE_RETURN_ALLOCATION_AMBIGUOUS', 'unresolved', {
          saleReturnLineId:returnLineId,
          itemGuid:sale.itemGuid,
          itemCode:sale.itemCode,
          reference:link.linkageReference,
          reason:`Partial return quantity ${returnNeed} maps to ${originals.length} distinct original allocations; no line/serial evidence selects which cost basis to restore.`
        }));
        continue;
      }
      const returnSaleValue = Math.abs(finite(sale.saleValue) || 0);
      const returnUnitSaleValue = returnNeed > EPSILON ? returnSaleValue / returnNeed : 0;
      let returnSequence = 0;
      for (const original of originals) {
        if (returnNeed <= EPSILON) break;
        const originalQuantity = round(Math.abs(finite(original.allocatedQty || original.unknownQty) || 0));
        const alreadyReversed = round(reversedByAllocation.get(original.allocationId) || 0);
        const reversible = round(Math.max(0, originalQuantity - alreadyReversed));
        const reversedQuantity = round(Math.min(returnNeed, reversible));
        if (reversedQuantity <= EPSILON) continue;
        returnNeed = round(returnNeed - reversedQuantity);
        reversedByAllocation.set(original.allocationId, round(alreadyReversed + reversedQuantity));
        returnSequence++;
        allocationSequenceGlobal++;
        const isUnknown = original.sourceType === 'unknown_cost';
        const unitCostSource = original.unitCostExact ?? original.unitCost;
        const exact = isUnknown ? unknownPrecisionFields(-reversedQuantity) : precisionFields(-reversedQuantity, unitCostSource);
        allocations.push({
          ...original,
          allocationId:`FA-${sha256(`${datasetId}|${returnLineId}|${returnSequence}|${original.allocationId}|reversal`).slice(0, 32)}`,
          allocationSequence:returnSequence,
          globalSequence:allocationSequenceGlobal,
          sourceType:'sale_return_reversal',
          reversedSourceType:original.sourceType,
          sourceConfidence:'authoritative-source-return-linkage',
          saleLineId:returnLineId,
          originalSaleLineId:link.originalSaleLineId,
          originalAllocationId:original.allocationId,
          originSaleInvoiceNo:Number(original.saleInvoiceNo || 0),
          originSaleInvoiceGuid:clean(original.saleGuid, 100),
          saleInvoiceType:6,
          saleInvoiceNo:Number(sale.saleInvoiceNo || 0),
          saleGuid:clean(sale.saleGuid, 100),
          saleDate:clean(sale.saleDate, 8),
          saleRow:Number(sale.row || 0),
          returnOperatorAccountNumber:clean(sale.sellerAccountNumber, 100),
          returnOperatorName:clean(sale.sellerName, 200),
          returnStoreName:clean(sale.sellerStoreName || sale.stockName, 200),
          soldQuantity:-returnQuantity,
          saleValue:-returnSaleValue,
          allocatedSaleValue:round(-reversedQuantity * returnUnitSaleValue, VALUE_SCALE),
          allocatedQty:isUnknown ? 0 : -reversedQuantity,
          unknownQty:isUnknown ? -reversedQuantity : 0,
          saleRemainingQuantity:returnNeed,
          unitCost:isUnknown ? null : round(finite(unitCostSource), VALUE_SCALE),
          allocatedCostAmount:isUnknown ? null : accountingDecimal.toNumber(accountingDecimal.parse(exact.allocatedCostAmountExact, accountingDecimal.MONEY_SCALE), accountingDecimal.MONEY_SCALE),
          saleReturnResolutionId:clean(link.resolution?.resolutionId, 100),
          returnSource:'SALE_SNAPSHOT_INVTYPE_6',
          returnInvoiceNo:Number(sale.saleInvoiceNo || 0),
          returnInvoiceGuid:clean(sale.saleGuid, 100),
          returnDate:clean(sale.saleDate, 8),
          returnLinkageSource:link.linkageSource,
          returnLinkageQuality:'EXACT_ORIGIN_LINK',
          returnLinkageReference:link.linkageReference,
          returnEffect:isUnknown ? 'unknown-cost-reversal-no-restoration' : 'reverse-original-allocation-and-restore-cost-capacity',
          restoredQuantity:isUnknown ? 0 : reversedQuantity,
          restoredCostAmountExact:isUnknown ? null : accountingDecimal.format(-accountingDecimal.parse(exact.allocatedCostAmountExact, accountingDecimal.MONEY_SCALE), accountingDecimal.MONEY_SCALE),
          layerAvailableBefore:null,
          layerRemainingQuantity:null,
          ...exact,
          createdAt:new Date()
        });
        if (!isUnknown) {
          const sourceLayer = officialRows.find(layer => purchaseIdentity(layer) === clean(original.purchaseLineIdentity, 500));
          if (sourceLayer) {
            sourceLayer.fifoRemainingQuantity = round(Number(sourceLayer.fifoRemainingQuantity || 0) + reversedQuantity);
            sourceLayer.saleReturnRestoredQuantity = round(Number(sourceLayer.saleReturnRestoredQuantity || 0) + reversedQuantity);
            sourceLayer.saleReturnLineIds = [...new Set([...(sourceLayer.saleReturnLineIds || []), returnLineId])];
            consumedByLayer.set(purchaseIdentity(sourceLayer), round(Math.max(0, Number(consumedByLayer.get(purchaseIdentity(sourceLayer)) || 0) - reversedQuantity)));
          }
        }
      }
      assignSaleValuePrecision(
        allocations.filter(item => item.saleLineId === returnLineId && item.sourceType === 'sale_return_reversal'),
        returnQuantity,
        -returnSaleValue
      );
      exceptions.push(exception(datasetId, 'SALE_RETURN_RESOLUTION', returnNeed <= EPSILON ? 'source-linked-reversed-restored' : 'source-link-insufficient-original-quantity', {
        saleReturnLineId:returnLineId,
        itemGuid:sale.itemGuid,
        itemCode:sale.itemCode,
        reference:link.linkageReference,
        reason:returnNeed <= EPSILON
          ? `${link.linkageSource} reversed the original allocation and restored its known cost capacity chronologically.`
          : `Original allocation was insufficient by ${returnNeed}; excess return did not create cost capacity.`
      }));
      continue;
    }
    const saleLineId = saleIdentity(sale);
    if (sourceSaleLineIds.has(saleLineId)) {
      exceptions.push(exception(datasetId, 'DUPLICATE_SALE_LINE', 'unresolved', {
        saleLineId, itemGuid:sale.itemGuid, itemCode:sale.itemCode, reason:'Sale Snapshot contains duplicate sale identity.'
      }));
      continue;
    }
    sourceSaleLineIds.add(saleLineId);
    const soldQuantity = round(finite(sale.qty) || 0);
    if (soldQuantity <= 0 || !validDate(sale.saleDate)) {
      exceptions.push(exception(datasetId, 'INVALID_SALE_LINE', 'unresolved', {
        saleLineId, itemGuid:sale.itemGuid, itemCode:sale.itemCode, reason:'Sale line has invalid quantity or canonical Jalali date.'
      }));
      continue;
    }
    const saleValue = round(finite(sale.saleValue) || 0, VALUE_SCALE);
    const unitSaleValue = soldQuantity ? saleValue / soldQuantity : 0;
    let need = soldQuantity;
    let sequence = 0;
    const eligibleForSale = matchingRows(officialIndex, sale)
      .filter(layer => layer.purchaseInvoiceDate <= sale.saleDate)
      .sort(compareLayers);

    for (const layer of eligibleForSale) {
      if (need <= EPSILON) break;
      const available = round(layer.fifoRemainingQuantity);
      if (available <= EPSILON) continue;
      const quantity = round(Math.min(need, available));
      if (quantity <= EPSILON) continue;
      sequence++;
      allocationSequenceGlobal++;
      layer.fifoRemainingQuantity = round(available - quantity);
      need = round(need - quantity);
      const unitCost = round(finite(layer.netUnitCost ?? layer.grossUnitCost), VALUE_SCALE);
      const allocatedCostAmount = round(quantity * unitCost, VALUE_SCALE);
      const allocatedSaleValue = round(quantity * unitSaleValue, VALUE_SCALE);
      const sourceRemaining = layer.fifoRemainingQuantity;
      const consumed = round((consumedByLayer.get(purchaseIdentity(layer)) || 0) + quantity);
      consumedByLayer.set(purchaseIdentity(layer), consumed);
      allocations.push({
        datasetId,
        allocationId:`FA-${sha256(`${datasetId}|${saleLineId}|${sequence}|${purchaseIdentity(layer)}`).slice(0, 32)}`,
        allocationSequence:sequence,
        globalSequence:allocationSequenceGlobal,
        schemaVersion:SCHEMA_VERSION,
        algorithmVersion:ALGORITHM_VERSION,
        sourceType:layer.fifoSourceType||'official_purchase_layer',
        costSourceType:layer.fifoSourceType==='approved_opening_accounting_cost'?'APPROVED_OPENING_ACCOUNTING_COST':(layer.fifoSourceType==='approved_manual_opening_quantity'?'MANUAL_COST_OPENING_BASIS':(layer.fifoSourceType==='approved_manual_evidence_quantity'?'MANUAL_COST_HISTORICAL_EVIDENCE':(layer.fifoSourceType?'MANUAL_COST_PURCHASE_LAYER':'OFFICIAL_PURCHASE_LAYER'))),
        sourceConfidence:layer.fifoSourceType==='approved_opening_accounting_cost'?'governed-approved-opening-accounting-cost':(layer.fifoSourceType==='approved_manual_opening_quantity'?'manual-approved-opening-basis':(layer.fifoSourceType==='approved_manual_evidence_quantity'?'manual-approved-bounded-historical-evidence':(layer.fifoSourceType?'manual-approved-purchase-line':'official'))),
        saleSnapshotId:source.saleActive.snapshotId,
        saleLineId,
        saleInvoiceType:Number(sale.saleInvoiceType),
        saleInvoiceNo:Number(sale.saleInvoiceNo),
        saleGuid:clean(sale.saleGuid, 100),
        saleDate:clean(sale.saleDate, 8),
        saleRow:Number(sale.row || 0),
        sellerAccountNumber:clean(sale.sellerAccountNumber, 100),
        sellerName:clean(sale.sellerName, 200),
        storeName:clean(sale.sellerStoreName || sale.stockName, 200),
        itemGuid:clean(sale.itemGuid, 100),
        itemCode:clean(sale.itemCode, 100),
        itemDescription:clean(sale.itemName, 500),
        officialProductCategoryName:clean(sale.officialProductCategoryName || sale.mainGroupName || sale.mainGroup, 300),
        officialProductCategoryGuid:clean(sale.officialProductCategoryGuid || sale.mainGroupGuid, 100),
        soldQuantity,
        saleValue,
        allocatedSaleValue,
        allocatedQty:quantity,
        unknownQty:0,
        saleRemainingQuantity:need,
        purchaseDatasetId:source.purchaseActive.datasetId,
        purchaseLineIdentity:purchaseIdentity(layer),
        purchaseInvoiceNo:Number(layer.purchaseInvoiceNo || 0),
        purchaseInvoiceGuid:clean(layer.purchaseInvoiceGuid, 100),
        purchaseInvoiceDate:clean(layer.purchaseInvoiceDate, 8),
        purchaseRow:Number(layer.sourceRow || 0),
        supplierAccountNumber:clean(layer.supplierAccountNumber, 100),
        supplierName:clean(layer.supplierName, 200),
        manualResolutionId:clean(layer.manualResolutionId,100),
        manualCostScope:clean(layer.manualCostScope,50),
        manualRevision:layer.manualResolutionId?Number(layer.manualRevision||0):null,
        manualContentHash:clean(layer.manualContentHash,64),
        manualCreatedBy:layer.manualResolutionId?layer.manualCreatedBy:null,
        manualApprovedBy:layer.manualResolutionId?layer.manualApprovedBy:null,
        manualApprovedAt:layer.manualResolutionId?layer.manualApprovedAt:null,
        manualCostExact:clean(layer.manualCostExact,100),
        unitCost,
        allocatedCostAmount,
        layerAvailableBefore:available,
        layerRemainingQuantity:sourceRemaining,
        purchaseReturnResolutionIds:[...(layer.purchaseReturnResolutionIds || [])],
        confirmedReturnAdjustmentQuantity:round(layer.confirmedReturnAdjustmentQuantity || 0),
        openingDatasetId:clean(layer.openingDatasetId,100),
        openingEvidenceId:clean(layer.openingEvidenceId,100),
        openingBaseDate:clean(layer.openingBaseDate,8),
        openingOriginalQuantityExact:clean(layer.openingOriginalQuantityExact,100),
        openingAllocatedQuantityExact:layer.openingEvidenceId?accountingDecimal.format(accountingDecimal.parse(quantity,accountingDecimal.QUANTITY_SCALE),accountingDecimal.QUANTITY_SCALE):'',
        openingRemainingQuantityExact:layer.openingEvidenceId?accountingDecimal.format(accountingDecimal.parse(sourceRemaining,accountingDecimal.QUANTITY_SCALE),accountingDecimal.QUANTITY_SCALE):'',
        openingUnitCostExact:clean(layer.openingUnitCostExact,100),
        openingTotalValueExact:clean(layer.openingTotalValueExact,100),
        openingWarehouseEvidence:layer.openingEvidenceId?layer.openingWarehouseEvidence:undefined,
        openingWarehouseFingerprint:clean(layer.openingWarehouseFingerprint,64),
        openingRecordFingerprint:clean(layer.openingRecordFingerprint,64),
        openingApprovalStatus:clean(layer.openingApprovalStatus,50),
        openingApprovalRevision:layer.openingEvidenceId?Number(layer.openingApprovalRevision||0):null,
        openingApprovedBy:layer.openingEvidenceId?layer.openingApprovedBy:null,
        openingApprovedAt:layer.openingEvidenceId?layer.openingApprovedAt:null,
        openingChronologyStatus:layer.openingEvidenceId?'OPENING_ELIGIBLE':'',
        unknownReason:'',
        ...precisionFields(quantity, layer.netUnitCost ?? layer.grossUnitCost),
        createdAt:new Date()
      });
    }

    if (need > EPSILON) {
      const manuals = manualCostResolution._effectiveRowsAt(matchingRows(manualIndex, sale), sale.saleDate)
        .filter(row => manualEffective(row, sale.saleDate))
        .sort((a, b) => clean(b.effectiveFrom).localeCompare(clean(a.effectiveFrom), 'en') || clean(a.resolutionId).localeCompare(clean(b.resolutionId), 'en'));
      if (manuals.length === 1) {
        const manual = manuals[0];
        sequence++;
        allocationSequenceGlobal++;
        const quantity = need;
        need = 0;
        const manualUnitCost = manual.manualCostExact ?? manual.manualCost;
        const unitCost = round(finite(manualUnitCost), VALUE_SCALE);
        allocations.push({
          datasetId,
          allocationId:`FA-${sha256(`${datasetId}|${saleLineId}|${sequence}|${manual.resolutionId}`).slice(0, 32)}`,
          allocationSequence:sequence,
          globalSequence:allocationSequenceGlobal,
          schemaVersion:SCHEMA_VERSION,
          algorithmVersion:ALGORITHM_VERSION,
          sourceType:'approved_manual_cost',
          costSourceType:'MANUAL_COST_ITEM_LEGACY',
          sourceConfidence:'manual-approved',
          saleSnapshotId:source.saleActive.snapshotId,
          saleLineId,
          saleInvoiceType:Number(sale.saleInvoiceType),
          saleInvoiceNo:Number(sale.saleInvoiceNo),
          saleGuid:clean(sale.saleGuid, 100),
          saleDate:clean(sale.saleDate, 8),
          saleRow:Number(sale.row || 0),
          sellerAccountNumber:clean(sale.sellerAccountNumber, 100),
          sellerName:clean(sale.sellerName, 200),
          storeName:clean(sale.sellerStoreName || sale.stockName, 200),
          itemGuid:clean(sale.itemGuid, 100),
          itemCode:clean(sale.itemCode, 100),
          itemDescription:clean(sale.itemName, 500),
          officialProductCategoryName:clean(sale.officialProductCategoryName || sale.mainGroupName || sale.mainGroup, 300),
          soldQuantity,
          saleValue,
          allocatedSaleValue:round(quantity * unitSaleValue, VALUE_SCALE),
          allocatedQty:quantity,
          unknownQty:0,
          saleRemainingQuantity:0,
          purchaseDatasetId:source.purchaseActive.datasetId,
          purchaseLineIdentity:'',
          purchaseInvoiceNo:0,
          purchaseInvoiceGuid:'',
          purchaseInvoiceDate:'',
          purchaseRow:0,
          supplierAccountNumber:'',
          supplierName:'',
          manualResolutionId:clean(manual.resolutionId, 100),
          manualCostScope:clean(manual.resolutionScope||'item',50),
          manualRevision:Number(manual.revision||0),
          manualContentHash:clean(manual.contentHash,64),
          manualCreatedBy:actor(manual.createdBy||{}),
          manualApprovedBy:actor(manual.approvedBy||{}),
          manualApprovedAt:manual.approvedAt||null,
          manualCostExact:clean(manual.manualCostExact??manual.manualCost,100),
          unitCost,
          allocatedCostAmount:round(quantity * unitCost, VALUE_SCALE),
          layerAvailableBefore:null,
          layerRemainingQuantity:null,
          unknownReason:'',
          ...precisionFields(quantity, manualUnitCost),
          createdAt:new Date()
        });
      } else {
        if (manuals.length > 1) {
          exceptions.push(exception(datasetId, 'AMBIGUOUS_MANUAL_COST', 'unresolved', {
            saleLineId, itemGuid:sale.itemGuid, itemCode:sale.itemCode,
            reason:`${manuals.length} approved manual resolutions overlap this sale date.`
          }));
        }
        sequence++;
        allocationSequenceGlobal++;
        const unknownReason = openingUnknownReason(
          sale,
          source,
          allocations.filter(row => row.saleLineId === saleLineId)
        ) || classifyUnknownSource(sale, source, eligibleForSale, manuals);
        allocations.push({
          datasetId,
          allocationId:`FA-${sha256(`${datasetId}|${saleLineId}|${sequence}|unknown`).slice(0, 32)}`,
          allocationSequence:sequence,
          globalSequence:allocationSequenceGlobal,
          schemaVersion:SCHEMA_VERSION,
          algorithmVersion:ALGORITHM_VERSION,
          sourceType:'unknown_cost',
          costSourceType:'UNKNOWN',
          sourceConfidence:'unknown',
          saleSnapshotId:source.saleActive.snapshotId,
          saleLineId,
          saleInvoiceType:Number(sale.saleInvoiceType),
          saleInvoiceNo:Number(sale.saleInvoiceNo),
          saleGuid:clean(sale.saleGuid, 100),
          saleDate:clean(sale.saleDate, 8),
          saleRow:Number(sale.row || 0),
          sellerAccountNumber:clean(sale.sellerAccountNumber, 100),
          sellerName:clean(sale.sellerName, 200),
          storeName:clean(sale.sellerStoreName || sale.stockName, 200),
          itemGuid:clean(sale.itemGuid, 100),
          itemCode:clean(sale.itemCode, 100),
          itemDescription:clean(sale.itemName, 500),
          officialProductCategoryName:clean(sale.officialProductCategoryName || sale.mainGroupName || sale.mainGroup, 300),
          soldQuantity,
          saleValue,
          allocatedSaleValue:round(need * unitSaleValue, VALUE_SCALE),
          allocatedQty:0,
          unknownQty:need,
          saleRemainingQuantity:0,
          purchaseDatasetId:source.purchaseActive.datasetId,
          purchaseLineIdentity:'',
          purchaseInvoiceNo:0,
          purchaseInvoiceGuid:'',
          purchaseInvoiceDate:'',
          purchaseRow:0,
          supplierAccountNumber:'',
          supplierName:'',
          manualResolutionId:'',
          openingChronologyStatus:unknownReason,
          unitCost:null,
          allocatedCostAmount:null,
          layerAvailableBefore:null,
          layerRemainingQuantity:null,
          unknownReason,
          ...unknownPrecisionFields(need),
          createdAt:new Date()
        });
        exceptions.push(exception(datasetId, 'UNKNOWN_COST', 'unresolved', {
          saleLineId, itemGuid:sale.itemGuid, itemCode:sale.itemCode, reason:unknownReason
        }));
      }
    }
    assignSaleValuePrecision(
      allocations.filter(row => row.saleLineId === saleLineId && Number(row.saleInvoiceType) === 2),
      soldQuantity,
      saleValue
    );
    originalAllocations.set(saleLineId, allocations.filter(row => row.saleLineId === saleLineId && Number(row.saleInvoiceType) === 2));
  }
  for (const row of purchaseReturns) {
    const confirmedResolution = (source.purchaseReturnResolutions || []).find(resolution =>
      clean(resolution.returnLineIdentity, 500) === purchaseIdentity(row) &&
      clean(resolution.selectedPurchaseLayer, 500)
    );
    const resolved = row.returnMatchStatus === 'matched' || Boolean(confirmedResolution);
    exceptions.push(exception(datasetId, 'PURCHASE_RETURN_STATUS', resolved ? 'linked-netted-in-source' : 'unresolved', {
      purchaseLineIdentity:purchaseIdentity(row),
      itemGuid:row.itemGuid,
      itemCode:row.itemCode,
      reference:confirmedResolution?.resolutionId || row.returnInvHeaderReference,
      reason:resolved
        ? (row.returnMatchStatus === 'matched'
          ? 'Matched purchase return is already reflected in source netPurchasedQuantity; no allocation row was generated.'
          : 'Confirmed purchase return resolution adjusted the selected source layer before allocation.')
        : `Purchase return remains ${clean(row.returnMatchStatus || 'unmatched')}; no fake allocation was generated.`
    }));
  }

  return { dates, sales, officialRows, purchaseReturns, saleReturns, allocations, exceptions, consumedByLayer };
}

function reconcile(result) {
  const allocationsBySale = new Map();
  const allocationIds = new Set();
  const duplicateAllocationIds = new Set();
  for (const row of result.allocations) {
    if (allocationIds.has(row.allocationId)) duplicateAllocationIds.add(row.allocationId);
    allocationIds.add(row.allocationId);
    addIndex(allocationsBySale, row.saleLineId, row);
  }
  let soldQuantity = 0;
  let allocatedQuantity = 0;
  let unknownQuantity = 0;
  let soldQuantityScaled = 0n;
  let allocatedQuantityScaled = 0n;
  let unknownQuantityScaled = 0n;
  let saleQuantityMismatchCount = 0;
  let saleValueMismatchCount = 0;
  for (const sale of result.sales) {
    const id = saleIdentity(sale);
    const quantity = round(finite(sale.qty) || 0);
    if (quantity <= 0) continue;
    const rows = allocationsBySale.get(id) || [];
    const allocated = round(rows.reduce((sum, row) => sum + Number(row.allocatedQty || 0), 0));
    const unknown = round(rows.reduce((sum, row) => sum + Number(row.unknownQty || 0), 0));
    soldQuantity = round(soldQuantity + quantity);
    allocatedQuantity = round(allocatedQuantity + allocated);
    unknownQuantity = round(unknownQuantity + unknown);
    const soldExact = accountingDecimal.parse(quantity, accountingDecimal.QUANTITY_SCALE);
    const allocatedExact = rows.reduce((sum,row)=>sum+accountingDecimal.parse(row.allocatedQty || 0,accountingDecimal.QUANTITY_SCALE),0n);
    const unknownExact = rows.reduce((sum,row)=>sum+accountingDecimal.parse(row.unknownQty || 0,accountingDecimal.QUANTITY_SCALE),0n);
    soldQuantityScaled += soldExact;
    allocatedQuantityScaled += allocatedExact;
    unknownQuantityScaled += unknownExact;
    if (soldExact !== allocatedExact + unknownExact) saleQuantityMismatchCount++;
    const expectedSaleValue = accountingDecimal.parse(sale.saleValue || 0, accountingDecimal.MONEY_SCALE);
    const allocatedSaleValue = rows.reduce((sum,row)=>sum+accountingDecimal.parse(row.allocatedSaleValueExact || row.allocatedSaleValue || 0,accountingDecimal.MONEY_SCALE),0n);
    if (expectedSaleValue !== allocatedSaleValue) saleValueMismatchCount++;
  }
  let layerOverConsumptionCount = 0;
  let negativeRemainingCount = 0;
  let orphanLayerCount = 0;
  const officialByIdentity = new Map(result.officialRows.map(row => [purchaseIdentity(row), row]));
  for (const row of result.allocations.filter(item => ['official_purchase_layer','approved_opening_accounting_cost','approved_manual_purchase_layer','approved_manual_opening_quantity','approved_manual_evidence_quantity'].includes(item.sourceType))) {
    const source = officialByIdentity.get(row.purchaseLineIdentity);
    if (!source) orphanLayerCount++;
    if (Number(row.layerRemainingQuantity) < -EPSILON) negativeRemainingCount++;
  }
  for (const [key, consumed] of result.consumedByLayer) {
    const source = officialByIdentity.get(key);
    if (!source || consumed - Number(source.netPurchasedQuantity ?? source.remainingQuantity ?? source.originalQuantity) > EPSILON) {
      layerOverConsumptionCount++;
    }
  }
  const openingEvidenceIds = new Set();
  let duplicateOpeningLayerCount = 0;
  let openingOverConsumptionCount = 0;
  for (const layer of result.officialRows.filter(row => row.fifoSourceType === 'approved_opening_accounting_cost')) {
    if (!layer.openingEvidenceId || openingEvidenceIds.has(layer.openingEvidenceId)) duplicateOpeningLayerCount++;
    openingEvidenceIds.add(layer.openingEvidenceId);
    const consumed = Number(result.consumedByLayer.get(purchaseIdentity(layer)) || 0);
    const original = Number(layer.netPurchasedQuantity || 0);
    if (consumed - original > EPSILON) openingOverConsumptionCount++;
  }
  const inactiveSourceCount = result.allocations.filter(row =>
    !['official_purchase_layer', 'approved_opening_accounting_cost', 'approved_manual_purchase_layer', 'approved_manual_opening_quantity', 'approved_manual_evidence_quantity', 'approved_manual_cost', 'unknown_cost', 'sale_return_reversal'].includes(row.sourceType)
  ).length;
  let monetaryReconciliationDifference = 0n;
  let monetaryPrecisionMismatchCount = 0;
  for (const row of result.allocations) {
    if (row.allocatedCostAmountExact == null) continue;
    try {
      const quantity = row.quantityExact ?? row.allocatedQty;
      const unitCost = row.unitCostExact ?? row.unitCost;
      const expected = accountingDecimal.allocation(quantity, unitCost).valueScaled;
      const actual = accountingDecimal.parse(row.allocatedCostAmountExact, accountingDecimal.MONEY_SCALE);
      const difference = actual - expected;
      monetaryReconciliationDifference += difference;
      if (difference !== 0n) monetaryPrecisionMismatchCount++;
    } catch (_) {
      monetaryPrecisionMismatchCount++;
    }
  }
  const validation = {
    soldQuantity,
    allocatedQuantity,
    unknownQuantity,
    soldQuantityExact:accountingDecimal.format(soldQuantityScaled,accountingDecimal.QUANTITY_SCALE),
    allocatedQuantityExact:accountingDecimal.format(allocatedQuantityScaled,accountingDecimal.QUANTITY_SCALE),
    unknownQuantityExact:accountingDecimal.format(unknownQuantityScaled,accountingDecimal.QUANTITY_SCALE),
    allocatedPlusUnknownEqualsSold:soldQuantityScaled === allocatedQuantityScaled + unknownQuantityScaled,
    saleQuantityMismatchCount,
    saleValueMismatchCount,
    duplicateAllocationCount:duplicateAllocationIds.size,
    layerOverConsumptionCount,
    orphanLayerCount,
    negativeRemainingCount,
    duplicateOpeningLayerCount,
    openingOverConsumptionCount,
    inactiveSourceCount,
    monetaryPrecisionMismatchCount,
    monetaryReconciliationDifferenceExact:accountingDecimal.format(monetaryReconciliationDifference, accountingDecimal.MONEY_SCALE),
    monetaryModel:'fixed-scale-bigint',
    roundingMode:accountingDecimal.ROUNDING_MODE,
    checkedAt:new Date()
  };
  validation.valid = validation.allocatedPlusUnknownEqualsSold &&
    validation.saleQuantityMismatchCount === 0 &&
    validation.saleValueMismatchCount === 0 &&
    validation.duplicateAllocationCount === 0 &&
    validation.layerOverConsumptionCount === 0 &&
    validation.orphanLayerCount === 0 &&
    validation.negativeRemainingCount === 0 &&
    validation.duplicateOpeningLayerCount === 0 &&
    validation.openingOverConsumptionCount === 0 &&
    validation.inactiveSourceCount === 0 &&
    validation.monetaryPrecisionMismatchCount === 0 &&
    monetaryReconciliationDifference === 0n;
  return validation;
}

function summarize(result, validation) {
  const totals = { quantity:0, saleValue:0 };
  let totalQuantityScaled = 0n;
  let totalSaleValueScaled = 0n;
  const returnReversals = { rows:0, quantity:0, saleValue:0, costValue:0 };
  const bySource = {
    official_purchase_layer:{ quantity:0, saleValue:0, costValue:0, rows:0, items:new Set() },
    approved_opening_accounting_cost:{ quantity:0, saleValue:0, costValue:0, rows:0, items:new Set() },
    approved_manual_purchase_layer:{ quantity:0, saleValue:0, costValue:0, rows:0, items:new Set() },
    approved_manual_opening_quantity:{ quantity:0, saleValue:0, costValue:0, rows:0, items:new Set() },
    approved_manual_evidence_quantity:{ quantity:0, saleValue:0, costValue:0, rows:0, items:new Set() },
    approved_manual_cost:{ quantity:0, saleValue:0, costValue:0, rows:0, items:new Set() },
    unknown_cost:{ quantity:0, saleValue:0, costValue:null, rows:0, items:new Set() }
  };
  const saleSeen = new Set();
  for (const sale of result.sales) {
    const id = saleIdentity(sale);
    if (saleSeen.has(id) || Number(sale.qty || 0) <= 0) continue;
    saleSeen.add(id);
    totals.quantity += Number(sale.qty || 0);
    totals.saleValue += Number(sale.saleValue || 0);
    totalQuantityScaled += accountingDecimal.parse(sale.qty || 0, accountingDecimal.QUANTITY_SCALE);
    totalSaleValueScaled += accountingDecimal.parse(sale.saleValue || 0, accountingDecimal.MONEY_SCALE);
  }
  for (const row of result.allocations) {
    if (row.sourceType === 'sale_return_reversal') {
      returnReversals.rows++;
      returnReversals.quantity += Math.abs(Number(row.allocatedQty || row.unknownQty || 0));
      returnReversals.saleValue += Math.abs(Number(row.allocatedSaleValue || 0));
      returnReversals.costValue += Math.abs(Number(row.allocatedCostAmount || 0));
      continue;
    }
    const group = bySource[row.sourceType];
    group.rows++;
    group.quantity += Number(row.allocatedQty || row.unknownQty || 0);
    group.saleValue += Number(row.allocatedSaleValue || 0);
    if (group.costValue != null) group.costValue += Number(row.allocatedCostAmount || 0);
    group.items.add(sourceKey(row));
  }
  const shaped = {};
  for (const [sourceType, group] of Object.entries(bySource)) {
    shaped[sourceType] = {
      rows:group.rows,
      itemCount:group.items.size,
      quantity:round(group.quantity),
      quantityPercent:percentage(group.quantity, totals.quantity),
      saleValue:round(group.saleValue, VALUE_SCALE),
      saleValuePercent:percentage(group.saleValue, totals.saleValue),
      allocatedCostAmount:group.costValue == null ? null : round(group.costValue, VALUE_SCALE)
    };
    const sourceRows = result.allocations.filter(row => row.sourceType === sourceType);
    shaped[sourceType].quantityExact = accountingDecimal.format(
      sourceRows.reduce((sum,row)=>sum+accountingDecimal.parse(row.quantityExact || row.allocatedQty || row.unknownQty || 0,accountingDecimal.QUANTITY_SCALE),0n),
      accountingDecimal.QUANTITY_SCALE
    );
    shaped[sourceType].saleValueExact = accountingDecimal.format(
      sourceRows.reduce((sum,row)=>sum+accountingDecimal.parse(row.allocatedSaleValueExact || row.allocatedSaleValue || 0,accountingDecimal.MONEY_SCALE),0n),
      accountingDecimal.MONEY_SCALE
    );
    shaped[sourceType].allocatedCostAmountExact = group.costValue == null ? null : accountingDecimal.format(
      sourceRows.reduce((sum,row)=>sum+accountingDecimal.parse(row.allocatedCostAmountExact || 0,accountingDecimal.MONEY_SCALE),0n),
      accountingDecimal.MONEY_SCALE
    );
  }
  const confidenceScore = round(
    shaped.official_purchase_layer.quantityPercent +
    shaped.approved_opening_accounting_cost.quantityPercent +
    (shaped.approved_manual_cost.quantityPercent + shaped.approved_manual_purchase_layer.quantityPercent + shaped.approved_manual_opening_quantity.quantityPercent + shaped.approved_manual_evidence_quantity.quantityPercent) * 0.6,
    2
  );
  let confidence = 'Unknown';
  if (shaped.unknown_cost.quantity <= EPSILON) {
    if (shaped.approved_opening_accounting_cost.quantity + shaped.approved_manual_cost.quantity + shaped.approved_manual_purchase_layer.quantity + shaped.approved_manual_opening_quantity.quantity + shaped.approved_manual_evidence_quantity.quantity <= EPSILON) confidence = 'Official Complete';
    else if (shaped.official_purchase_layer.quantity <= EPSILON && shaped.approved_opening_accounting_cost.quantity <= EPSILON) confidence = 'Manual Complete';
    else confidence = 'Mixed';
  } else if (shaped.official_purchase_layer.quantity > EPSILON || shaped.approved_opening_accounting_cost.quantity > EPSILON || shaped.approved_manual_cost.quantity > EPSILON || shaped.approved_manual_purchase_layer.quantity > EPSILON || shaped.approved_manual_opening_quantity.quantity > EPSILON || shaped.approved_manual_evidence_quantity.quantity > EPSILON) {
    confidence = 'Official Partial';
  }
  return {
    soldLineCount:saleSeen.size,
    allocationCount:result.allocations.length,
    soldQuantity:round(totals.quantity),
    saleValue:round(totals.saleValue, VALUE_SCALE),
    soldQuantityExact:accountingDecimal.format(totalQuantityScaled,accountingDecimal.QUANTITY_SCALE),
    saleValueExact:accountingDecimal.format(totalSaleValueScaled,accountingDecimal.MONEY_SCALE),
    official:shaped.official_purchase_layer,
    opening:shaped.approved_opening_accounting_cost,
    manual:{...shaped.approved_manual_cost,rows:shaped.approved_manual_cost.rows+shaped.approved_manual_purchase_layer.rows+shaped.approved_manual_opening_quantity.rows+shaped.approved_manual_evidence_quantity.rows,quantity:round(shaped.approved_manual_cost.quantity+shaped.approved_manual_purchase_layer.quantity+shaped.approved_manual_opening_quantity.quantity+shaped.approved_manual_evidence_quantity.quantity),saleValue:round(shaped.approved_manual_cost.saleValue+shaped.approved_manual_purchase_layer.saleValue+shaped.approved_manual_opening_quantity.saleValue+shaped.approved_manual_evidence_quantity.saleValue,VALUE_SCALE),costValue:round(shaped.approved_manual_cost.costValue+shaped.approved_manual_purchase_layer.costValue+shaped.approved_manual_opening_quantity.costValue+shaped.approved_manual_evidence_quantity.costValue,VALUE_SCALE),purchaseLayerScoped:shaped.approved_manual_purchase_layer,openingQuantityScoped:shaped.approved_manual_opening_quantity,historicalEvidenceQuantityScoped:shaped.approved_manual_evidence_quantity},
    unknown:shaped.unknown_cost,
    confidenceScore,
    confidence,
    purchaseReturns:{
      total:result.purchaseReturns.length,
      unresolved:result.exceptions.filter(row => row.code === 'PURCHASE_RETURN_STATUS' && row.status === 'unresolved').length
    },
    saleReturns:{ total:result.saleReturns.length, unresolved:result.exceptions.filter(row => row.code === 'SALE_RETURN_NOT_ALLOCATED' && row.status === 'unresolved').length },
    saleReturnReversals:{
      rows:returnReversals.rows,
      quantity:round(returnReversals.quantity),
      saleValue:round(returnReversals.saleValue,VALUE_SCALE),
      costValue:round(returnReversals.costValue,VALUE_SCALE)
    },
    exceptionCount:result.exceptions.length,
    unresolvedExceptionCount:result.exceptions.filter(row => row.status === 'unresolved').length,
    reconciliation:validation,
    profitCalculated:false,
    roiCalculated:false,
    commissionCalculated:false,
    accountingApproved:false,
    shadowMode:true
  };
}

async function buildShadowDataset(db, options = {}, requestedBy = {}) {
  await ensureIndexes(db);
  const requestedResumeId = clean(options.resumeDatasetId, 100);
  const existing = requestedResumeId ? await db.collection(DATASETS).findOne({ datasetId:requestedResumeId }) : null;
  if (requestedResumeId && !existing) fail('FIFO_DATASET_NOT_FOUND', 'FIFO Shadow Dataset برای Resume پیدا نشد.', 404);
  if (existing?.status === 'completed' && existing.validation?.valid) {
    fail('FIFO_DATASET_IMMUTABLE', 'Candidate کامل immutable است؛ فعال‌سازی فقط از workflow مستقل و مجاز انجام می‌شود.', 409);
  }
  if (existing && !['failed', 'cancelled', 'completed_with_errors'].includes(existing.status)) {
    fail('FIFO_DATASET_IMMUTABLE', `Dataset با وضعیت ${existing.status} قابل Resume یا تغییر نیست.`, 409);
  }
  const datasetId = existing?.datasetId || newDatasetId();
  await acquireLock(db, datasetId);
  const startedAt = new Date();
  const startedMs = Date.now();
  const heapStart = process.memoryUsage().heapUsed;
  const dates = normalizeJalaliRange({
    dateFrom:existing?.dateFrom || options.dateFrom || '',
    dateTo:existing?.dateTo || options.dateTo || ''
  });
  const requestedByActor = actor(requestedBy);
  const pinned = {
    saleSnapshotId:existing?.sourceSaleSnapshotId || clean(options.saleSnapshotId, 100),
    purchaseDatasetId:existing?.sourcePurchaseDatasetId || clean(options.purchaseDatasetId, 100),
    openingDatasetId:existing?.sourceOpeningDatasetId || clean(options.openingDatasetId, 100),
    openingFingerprints:{
      dataset:clean(options.openingDatasetFingerprint,64),
      source:clean(options.openingSourceFingerprint,64),
      eligibility:clean(options.openingEligibilityFingerprint,64)
    }
  };
  let retryCount = Number(existing?.retryCount || 0);
  let sourceReadAttempts = [];
  try {
    if (existing) {
      await Promise.all([
        db.collection(ALLOCATIONS).deleteMany({ datasetId }),
        db.collection(DIAGNOSTICS).deleteMany({ datasetId }),
        db.collection(EXCEPTIONS).deleteMany({ datasetId })
      ]);
      await db.collection(DATASETS).updateOne({ datasetId, status:existing.status }, { $set:{
        status:'running',
        activationStatus:'candidate',
        resumedAt:startedAt,
        resumeCount:Number(existing.resumeCount || 0) + 1,
        updatedAt:startedAt
      } });
    } else {
      await db.collection(DATASETS).insertOne({
        datasetId,
        schemaVersion:SCHEMA_VERSION,
        algorithmVersion:ALGORITHM_VERSION,
        applicationVersion:APP_VERSION,
        mode:'shadow',
        status:'running',
        activationStatus:'candidate',
        dateFrom:dates.dateFrom,
        dateTo:dates.dateTo,
        sourceSaleSnapshotId:pinned.saleSnapshotId,
        sourcePurchaseDatasetId:pinned.purchaseDatasetId,
        sourceOpeningDatasetId:pinned.openingDatasetId,
        accountingReviewContext:accountingReviewContext(options.accountingReviewContext),
        requestedBy:requestedByActor,
        resumeCount:0,
        retryCount:0,
        immutableAfterCompletion:true,
        accountingApproved:false,
        profitActivationAllowed:false,
        finalFinancialActivationEligibility:'blocked',
        finalFinancialActivationBlockers:['OPENING_REVOCATION_SUPERSESSION_GOVERNANCE_NOT_IMPLEMENTED','HUMAN_FIFO_VALIDATION_REQUIRED'],
        createdAt:startedAt,
        startedAt,
        updatedAt:startedAt
      });
    }
    await diagnostic(db, datasetId, 'started', { dates, resumed:!!existing, requestedBy:requestedByActor });
    options.jobControl?.progress?.({ phase:'Reading Immutable Sources', current:0, total:1, message:`FIFO Shadow ${datasetId}` });
    options.jobControl?.heartbeat?.();
    options.jobControl?.checkCancellation?.();
    const readStartedMs = Date.now();
    const loaded = await loadSourcesWithRetry(db, pinned, options, datasetId);
    retryCount += loaded.retryCount;
    sourceReadAttempts = loaded.attempts;
    const source = loaded.bundle;
    source.purchaseReturnResolutions = Array.isArray(source.purchaseReturnResolutions) ? source.purchaseReturnResolutions : [];
    source.saleReturnResolutions = Array.isArray(source.saleReturnResolutions) ? source.saleReturnResolutions : [];
    pinned.saleSnapshotId = source.saleActive.snapshotId;
    pinned.purchaseDatasetId = source.purchaseActive.datasetId;
    pinned.openingDatasetId = source.openingActive?.datasetId || '';
    const mongoReadMs = Date.now() - readStartedMs;
    await db.collection(DATASETS).updateOne({ datasetId, status:'running' }, { $set:{
      sourceSaleSnapshotId:pinned.saleSnapshotId,
      sourcePurchaseDatasetId:pinned.purchaseDatasetId,
      sourceOpeningDatasetId:pinned.openingDatasetId,
      sourceSaleSnapshotStatus:source.saleActive.snapshot.status,
      sourcePurchaseDatasetStatus:source.purchaseActive.dataset.status,
      retryCount,
      sourceReadAttempts,
      updatedAt:new Date()
    } });
    await diagnostic(db, datasetId, 'sources-read', {
      saleSnapshotId:pinned.saleSnapshotId,
      purchaseDatasetId:pinned.purchaseDatasetId,
      saleLines:source.saleLines.length,
      purchaseLayers:source.purchaseLayers.length,
      approvedManualResolutions:source.manuals.length,
      approvedOpeningEvidenceRows:source.openingRows.length,
      openingDatasetFingerprint:source.openingActive?.governance?.datasetFingerprint || '',
      openingSourceFingerprint:source.openingActive?.governance?.sourceFingerprint || '',
      openingEligibilityFingerprint:source.openingActive?.governance?.eligibilityFingerprint || '',
      confirmedPurchaseReturnResolutions:source.purchaseReturnResolutions.length,
      confirmedSaleReturnResolutions:source.saleReturnResolutions.length,
      mongoReadMs,
      retryCount
    });
    await renewLock(db, datasetId);

    options.jobControl?.progress?.({ phase:'Allocating FIFO Shadow', current:0, total:source.saleLines.length, message:'Official → approved manual → unknown' });
    const allocationStartedMs = Date.now();
    const result = allocateSources(datasetId, source, dates);
    const allocationMs = Date.now() - allocationStartedMs;
    const validation = reconcile(result);
    const summary = summarize(result, validation);
    const sourceFingerprint = sha256(stableStringify({
      saleSnapshotId:pinned.saleSnapshotId,
      purchaseDatasetId:pinned.purchaseDatasetId,
      openingDatasetId:pinned.openingDatasetId,
      openingDatasetFingerprint:source.openingActive?.governance?.datasetFingerprint || '',
      openingSourceFingerprint:source.openingActive?.governance?.sourceFingerprint || '',
      openingEligibilityFingerprint:source.openingActive?.governance?.eligibilityFingerprint || '',
      sales:result.sales.map(row => [saleIdentity(row), row.saleDate, round(row.qty), round(row.saleValue, VALUE_SCALE)]),
      saleReturns:result.saleReturns.map(row => [saleIdentity(row), row.saleDate, clean(row.createdDate,100), round(row.qty), round(row.saleValue, VALUE_SCALE), clean(row.generalRef,100), clean(row.relatedInvHeaderId,100), clean(row.invHeaderIdRoot,100)]),
      purchases:result.officialRows.map(row => [purchaseIdentity(row), row.purchaseInvoiceDate, round(row.netPurchasedQuantity ?? row.remainingQuantity ?? row.originalQuantity), round(row.netUnitCost ?? row.grossUnitCost, VALUE_SCALE)]),
      manuals:[...source.manuals]
        .sort((a,b)=>clean(a.resolutionId).localeCompare(clean(b.resolutionId),'en'))
        .map(row => [row.resolutionId, row.revision, row.status, row.effectiveFrom, row.effectiveTo, clean(row.manualCostExact ?? row.manualCost), clean(row.contentHash)]),
      opening:[...(source.openingRows || [])]
        .sort((a,b)=>openingIdentity(a).localeCompare(openingIdentity(b),'en'))
        .map(row => [openingIdentity(row), clean(row.itemGuid,100), clean(row.itemCode,100), clean(row.effectiveOpeningDate||row.openingDate,8), clean(row.openingQuantityExact,100), clean(row.openingUnitCostExact,100), clean(row.openingTotalValueExact,100), clean(row.sourceFingerprint,64), clean(row.recordFingerprint,64)]),
      purchaseReturnResolutions:[...source.purchaseReturnResolutions]
        .sort((a,b)=>clean(a.resolutionId).localeCompare(clean(b.resolutionId),'en'))
        .map(row => [row.resolutionId,row.revision,row.status,row.returnLineIdentity,row.selectedPurchaseLayer,clean(row.returnQuantity)]),
      saleReturnResolutions:[...source.saleReturnResolutions]
        .sort((a,b)=>clean(a.resolutionId).localeCompare(clean(b.resolutionId),'en'))
        .map(row => [row.resolutionId,row.revision,row.status,row.returnLineIdentity,row.selectedOriginalSaleLineId,clean(row.returnQuantity)]),
      precision:{
        quantityScale:accountingDecimal.QUANTITY_SCALE,
        unitCostScale:accountingDecimal.UNIT_COST_SCALE,
        moneyScale:accountingDecimal.MONEY_SCALE,
        roundingMode:accountingDecimal.ROUNDING_MODE
      }
    }));
    const manualResolutionSet = manualCostResolution._approvedRowsFingerprint(source.manuals);
    const allocationFingerprint = sha256(stableStringify(result.allocations.map(immutableProjection)));
    const replayResult = allocateSources(datasetId, source, dates);
    const replayValidation = reconcile(replayResult);
    const replayAllocationFingerprint = sha256(stableStringify(replayResult.allocations.map(immutableProjection)));
    if (!replayValidation.valid || replayAllocationFingerprint !== allocationFingerprint) {
      fail('FIFO_DETERMINISTIC_REPLAY_MISMATCH', 'Deterministic in-memory FIFO replay did not reproduce the allocation fingerprint.', 500);
    }
    const candidateFingerprint = sha256(stableStringify({
      saleSnapshotId:pinned.saleSnapshotId,
      purchaseDatasetId:pinned.purchaseDatasetId,
      openingDatasetId:pinned.openingDatasetId,
      openingDatasetFingerprint:source.openingActive?.governance?.datasetFingerprint || '',
      openingSourceFingerprint:source.openingActive?.governance?.sourceFingerprint || '',
      openingEligibilityFingerprint:source.openingActive?.governance?.eligibilityFingerprint || '',
      manualResolutionSetFingerprint:manualResolutionSet.fingerprint,
      algorithmVersion:ALGORITHM_VERSION,
      canonicalSourceHash:sourceFingerprint,
      allocationFingerprint
    }));
    const deterministicPeer = await db.collection(DATASETS).findOne({
      datasetId:{ $ne:datasetId },
      status:'completed',
      algorithmVersion:ALGORITHM_VERSION,
      sourceFingerprint,
      openingDatasetFingerprint:source.openingActive?.governance?.datasetFingerprint || '',
      openingSourceFingerprint:source.openingActive?.governance?.sourceFingerprint || '',
      openingEligibilityFingerprint:source.openingActive?.governance?.eligibilityFingerprint || '',
      openingApprovalRevision:Number(source.openingActive?.dataset?.revision || 0),
      manualResolutionSetFingerprint:manualResolutionSet.fingerprint,
      manualResolutionCount:manualResolutionSet.count,
      allocationFingerprint
    });
    const deterministicReplayVerified = true;
    const heapBeforeWrite = process.memoryUsage().heapUsed;
    await renewLock(db, datasetId);
    options.jobControl?.progress?.({ phase:'Writing Isolated Shadow Ledger', current:0, total:result.allocations.length + result.exceptions.length, message:'Writing shadow collections only' });
    const writeStartedMs = Date.now();
    await insertMany(db.collection(ALLOCATIONS), result.allocations);
    await insertMany(db.collection(EXCEPTIONS), result.exceptions);
    const mongoWriteMs = Date.now() - writeStartedMs;
    const [persistedAllocationCount, persistedExceptionCount] = await Promise.all([
      count(db.collection(ALLOCATIONS), { datasetId }),
      count(db.collection(EXCEPTIONS), { datasetId })
    ]);
    if (persistedAllocationCount !== result.allocations.length || persistedExceptionCount !== result.exceptions.length) {
      fail('FIFO_PERSISTENCE_MISMATCH', 'تعداد رکوردهای Shadow ذخیره‌شده با محاسبه تطابق ندارد.', 500);
    }
    const completedAt = new Date();
    const durationMs = Date.now() - startedMs;
    const performance = {
      durationMs,
      mongoReadMs,
      allocationMs,
      mongoWriteMs,
      heapStartBytes:heapStart,
      heapBeforeWriteBytes:heapBeforeWrite,
      heapEndBytes:process.memoryUsage().heapUsed,
      peakObservedHeapBytes:Math.max(heapStart, heapBeforeWrite, process.memoryUsage().heapUsed)
    };
    const finalStatus = validation.valid ? 'completed' : 'completed_with_errors';
    const activationStatus = validation.valid ? 'validated-candidate' : 'rejected';
    const finalDoc = {
      status:finalStatus,
      activationStatus,
      completedAt,
      updatedAt:completedAt,
      sourceSaleSnapshotId:pinned.saleSnapshotId,
      sourcePurchaseDatasetId:pinned.purchaseDatasetId,
      sourceOpeningDatasetId:pinned.openingDatasetId,
      sourceFingerprint,
      openingDatasetFingerprint:source.openingActive?.governance?.datasetFingerprint || '',
      openingSourceFingerprint:source.openingActive?.governance?.sourceFingerprint || '',
      openingEligibilityFingerprint:source.openingActive?.governance?.eligibilityFingerprint || '',
      openingApprovalRevision:Number(source.openingActive?.dataset?.revision || 0),
      openingApprovalStatus:clean(source.openingActive?.dataset?.approvalStatus,50),
      manualResolutionSetFingerprint:manualResolutionSet.fingerprint,
      manualResolutionCount:manualResolutionSet.count,
      allocationFingerprint,
      candidateFingerprint,
      deterministicReplayVerified,
      deterministicPeerDatasetId:deterministicPeer?.datasetId || '',
      retryCount,
      sourceReadAttempts,
      summary,
      validation,
      performance,
      allocationCount:persistedAllocationCount,
      exceptionCount:persistedExceptionCount,
      immutable:true,
      accountingApproved:false,
      profitActivationAllowed:false,
      finalFinancialActivationEligibility:'blocked',
      finalFinancialActivationBlockers:['OPENING_REVOCATION_SUPERSESSION_GOVERNANCE_NOT_IMPLEMENTED','HUMAN_FIFO_VALIDATION_REQUIRED'],
      profitCalculated:false,
      roiCalculated:false,
      commissionCalculated:false
    };
    const completed = await db.collection(DATASETS).updateOne(
      { datasetId, status:'running', activationStatus:'candidate' },
      { $set:finalDoc }
    );
    if (!completed.matchedCount) fail('FIFO_ATOMIC_COMPLETION_FAILED', 'Candidate FIFO Shadow هم‌زمان تغییر کرده است.', 409);
    await diagnostic(db, datasetId, 'completed', {
      status:finalStatus,
      activationStatus,
      allocationCount:persistedAllocationCount,
      exceptionCount:persistedExceptionCount,
      sourceFingerprint,
      manualResolutionSetFingerprint:manualResolutionSet.fingerprint,
      manualResolutionCount:manualResolutionSet.count,
      allocationFingerprint,
      candidateFingerprint,
      deterministicReplayVerified,
      deterministicPeerDatasetId:deterministicPeer?.datasetId || '',
      summary,
      performance
    });
    options.jobControl?.progress?.({ phase:'Completed', current:1, total:1, percent:100, message:`FIFO Shadow ${finalStatus}` });
    return {
      ok:validation.valid,
      code:validation.valid ? 'FIFO_SHADOW_COMPLETED' : 'FIFO_SHADOW_RECONCILIATION_FAILED',
      datasetId,
      status:finalStatus,
      activationStatus,
      sourceSaleSnapshotId:pinned.saleSnapshotId,
      sourcePurchaseDatasetId:pinned.purchaseDatasetId,
      sourceOpeningDatasetId:pinned.openingDatasetId,
      allocationCount:persistedAllocationCount,
      exceptionCount:persistedExceptionCount,
      retryCount,
      resumeCount:Number(existing?.resumeCount || 0) + (existing ? 1 : 0),
      sourceFingerprint,
      openingDatasetFingerprint:source.openingActive?.governance?.datasetFingerprint || '',
      openingSourceFingerprint:source.openingActive?.governance?.sourceFingerprint || '',
      openingEligibilityFingerprint:source.openingActive?.governance?.eligibilityFingerprint || '',
      openingApprovalRevision:Number(source.openingActive?.dataset?.revision || 0),
      manualResolutionSetFingerprint:manualResolutionSet.fingerprint,
      manualResolutionCount:manualResolutionSet.count,
      allocationFingerprint,
      candidateFingerprint,
      deterministicReplayVerified,
      deterministicPeerDatasetId:deterministicPeer?.datasetId || '',
      summary,
      validation,
      performance,
      shadowMode:true,
      accountingApproved:false,
      profitActivationAllowed:false,
      finalFinancialActivationEligibility:'blocked',
      finalFinancialActivationBlockers:['OPENING_REVOCATION_SUPERSESSION_GOVERNANCE_NOT_IMPLEMENTED','HUMAN_FIFO_VALIDATION_REQUIRED']
    };
  } catch (error) {
    const status = error?.code === 'JOB_CANCELLED' ? 'cancelled' : 'failed';
    await db.collection(DATASETS).updateOne(
      { datasetId, status:'running' },
      { $set:{
        status,
        activationStatus:'rejected',
        retryCount,
        sourceReadAttempts:error?.attempts || sourceReadAttempts,
        errorCode:clean(error?.code || 'FIFO_SHADOW_BUILD_FAILED', 100),
        error:safeError(error?.message || error),
        failedAt:new Date(),
        updatedAt:new Date()
      } }
    ).catch(() => {});
    await diagnostic(db, datasetId, status, { code:error?.code || 'FIFO_SHADOW_BUILD_FAILED', error:safeError(error?.message || error) }).catch(() => {});
    throw error;
  } finally {
    await releaseLock(db, datasetId);
  }
}

async function listDatasets(db, limit = 20) {
  await ensureIndexes(db);
  const active = await activeDataset(db);
  const list = await db.collection(DATASETS).find({}).sort({ createdAt:-1 }).limit(Math.max(1, Math.min(Number(limit || 20), 100))).toArray();
  return {
    ok:true,
    activeDatasetId:active?.datasetId || '',
    list:list.map(row => ({ ...row, isActive:row.datasetId === active?.datasetId })),
    shadowMode:true,
    accountingApproved:false
  };
}
async function status(db, datasetId = '') {
  await ensureIndexes(db);
  const active = await activeDataset(db);
  const dataset = datasetId
    ? await db.collection(DATASETS).findOne({ datasetId:clean(datasetId, 100) })
    : active?.dataset || await db.collection(DATASETS).findOne({}, { sort:{ createdAt:-1 } });
  const state = await db.collection(STATE).findOne({ scopeKey:SCOPE_KEY });
  const manualResolutionSet = await manualCostResolution.approvedSetFingerprint(db);
  const staleReasons=[];
  if (dataset && !dataset.manualResolutionSetFingerprint) staleReasons.push('legacy-dataset-without-manual-resolution-fingerprint');
  else if (dataset && dataset.manualResolutionSetFingerprint !== manualResolutionSet.fingerprint) staleReasons.push('approved-manual-cost-set-changed');
  return {
    ok:true,
    activeDatasetId:active?.datasetId || '',
    state:{
      buildLocked:Boolean(state?.buildLockOwner && new Date(state.buildLockExpiresAt || 0) > new Date()),
      buildLockOwner:state?.buildLockOwner || '',
      buildLockExpiresAt:state?.buildLockExpiresAt || null
    },
    dataset:dataset ? { ...dataset, isActive:dataset.datasetId === active?.datasetId } : null,
    stale:staleReasons.length>0,
    staleReasons,
    currentManualResolutionSetFingerprint:manualResolutionSet.fingerprint,
    shadowMode:true,
    accountingApproved:false
  };
}
async function listAllocations(db, filters = {}) {
  await ensureIndexes(db);
  const active = filters.datasetId ? null : await activeDataset(db);
  const datasetId = clean(filters.datasetId || active?.datasetId, 100);
  if (!datasetId) return { ok:true, datasetId:'', total:0, page:1, pageSize:100, list:[], appliedFilters:{ datasetId:'', invoiceNo:'', itemCode:'', sourceType:'' } };
  const query = { datasetId };
  const saleLineId = clean(filters.saleLineId, 500);
  const invoiceNo = clean(filters.invoiceNo, 100);
  const itemCode = canonicalItemCatalog.normalizedItemCode(filters.itemCode);
  const sourceType = clean(filters.sourceType, 100);
  if (saleLineId) query.saleLineId = saleLineId;
  if (invoiceNo) query.saleInvoiceNo = Number(invoiceNo);
  if (itemCode) query.itemCode = itemCode;
  if (sourceType) query.sourceType = sourceType;
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 100), 1000));
  const total = await count(db.collection(ALLOCATIONS), query);
  const list = await db.collection(ALLOCATIONS).find(query)
    .sort({ saleDate:1, saleInvoiceNo:1, saleRow:1, allocationSequence:1 })
    .skip((page - 1) * pageSize).limit(pageSize).toArray();
  return {
    ok:true,datasetId,total,page,pageSize,list,
    appliedFilters:{ datasetId, invoiceNo, itemCode, sourceType, saleLineId },
    shadowMode:true,accountingApproved:false
  };
}

function escapedRegex(value) {
  return clean(value, 300).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function auditSellerId(row) {
  return clean(row.canonicalSellerId || row.sellerAccountNumber || row.sellerIdentity, 100);
}
function auditCategoryGuid(row) {
  return clean(row.canonicalCategoryGuid || row.officialProductCategoryGuid || row.productCategoryGuid, 100);
}
function decimalOrNull(value, scale = accountingDecimal.MONEY_SCALE) {
  if (value == null || clean(value, 100) === '') return null;
  try { return accountingDecimal.parse(value, scale); } catch { return null; }
}
function exactAmount(row, field) {
  if (field === 'sale') return decimalOrNull(row.allocatedSaleValueExact ?? row.allocatedSaleValue ?? 0);
  if (field === 'cost') return decimalOrNull(row.allocatedCostAmountExact ?? row.allocatedCostAmount);
  const sale = exactAmount(row, 'sale'), cost = exactAmount(row, 'cost');
  return sale == null || cost == null ? null : sale - cost;
}
function rangeValue(filters, key) {
  const raw = clean(filters[key], 100).replace(/[,،\s]/g, '');
  if (!raw) return null;
  const value = decimalOrNull(raw);
  if (value == null) fail('FIFO_AUDIT_FILTER_INVALID', `فیلتر ${key} معتبر نیست.`, 400);
  return value;
}
function inRange(value, min, max) {
  return value != null && (min == null || value >= min) && (max == null || value <= max);
}
function auditBaseQuery(datasetId, filters = {}) {
  const query = { datasetId };
  const saleLineId = clean(filters.saleLineId, 500);
  const invoiceNo = clean(filters.invoiceNo, 100);
  const itemCode = canonicalItemCatalog.normalizedItemCode(filters.itemCode);
  const sourceType = clean(filters.sourceType, 100);
  const canonicalSellerId = clean(filters.canonicalSellerId, 100);
  const sellerSearch = escapedRegex(filters.sellerSearch);
  const itemSearch = escapedRegex(filters.itemSearch);
  const dateFrom = clean(filters.dateFrom, 8);
  const dateTo = clean(filters.dateTo, 8);
  const and = [];
  if (saleLineId) query.saleLineId = saleLineId;
  if (invoiceNo) query.saleInvoiceNo = Number(invoiceNo);
  if (itemCode) query.itemCode = itemCode;
  if (sourceType) query.sourceType = sourceType;
  if (canonicalSellerId) and.push({ $or:[{canonicalSellerId},{sellerAccountNumber:canonicalSellerId},{sellerIdentity:canonicalSellerId}] });
  if (sellerSearch) and.push({ sellerName:{ $regex:sellerSearch, $options:'i' } });
  if (itemSearch) and.push({ itemDescription:{ $regex:itemSearch, $options:'i' } });
  if (dateFrom || dateTo) query.saleDate = { ...(dateFrom?{$gte:dateFrom}:{}), ...(dateTo?{$lte:dateTo}:{}) };
  if (and.length) query.$and = and;
  return query;
}
async function canonicalCategoryMap(db, rows) {
  const itemCodes=[...new Set(rows.map(row=>canonicalItemCatalog.normalizedItemCode(row.itemCode)).filter(Boolean))];
  if(!itemCodes.length)return new Map();
  const assignments=await db.collection('accountingOfficialItemGroupAssignments').find({active:true,itemCode:{$in:itemCodes}}).toArray();
  const grouped=new Map();
  for(const row of assignments){
    const code=canonicalItemCatalog.normalizedItemCode(row.itemCode),guid=clean(row.resolvedMainGroupGuid,100);
    if(!code||!guid)continue;
    const byGuid=grouped.get(code)||new Map();
    byGuid.set(guid,{guid,name:clean(row.resolvedMainGroupName,300),identity:clean(row.resolvedMainGroupIdentity,300),source:'accountingOfficialItemGroupAssignments'});
    grouped.set(code,byGuid);
  }
  return new Map([...grouped].map(([code,byGuid])=>[code,byGuid.size===1?[...byGuid.values()][0]:{guid:'',name:'',identity:'',source:'AMBIGUOUS_OFFICIAL_CATEGORY'}]));
}
function enrichAuditCategories(rows,categoryMap){
  return rows.map(row=>{
    const resolved=categoryMap.get(canonicalItemCatalog.normalizedItemCode(row.itemCode));
    const existingGuid=auditCategoryGuid(row);
    return {...row,canonicalCategoryGuid:existingGuid||resolved?.guid||'',canonicalCategoryName:existingGuid?clean(row.officialProductCategoryName||row.productCategory,300):(resolved?.name||''),canonicalCategorySource:existingGuid?'fifo-allocation':(resolved?.source||'UNRESOLVED')};
  });
}
function categoryFilter(rows,filters){
  const guid=clean(filters.canonicalCategoryGuid,100),needle=identity(filters.categorySearch);
  return rows.filter(row=>(!guid||auditCategoryGuid(row)===guid)&&(!needle||identity(row.canonicalCategoryName||row.officialProductCategoryName||row.productCategory).includes(needle)));
}
function categoryItemCodes(categoryMap,filters){
  const guid=clean(filters.canonicalCategoryGuid,100),needle=identity(filters.categorySearch);
  if(!guid&&!needle)return null;
  return [...categoryMap].filter(([,row])=>(!guid||row.guid===guid)&&(!needle||identity(row.name).includes(needle))).map(([itemCode])=>itemCode);
}
function auditAppliedFilters(datasetId, filters = {}) {
  return {
    datasetId,
    controlDatasetId:clean(filters.controlDatasetId,100),
    mode:clean(filters.mode,20)||'allocations',
    canonicalSellerId:clean(filters.canonicalSellerId,100),sellerSearch:clean(filters.sellerSearch,200),
    canonicalCategoryGuid:clean(filters.canonicalCategoryGuid,100),categorySearch:clean(filters.categorySearch,200),
    itemCode:canonicalItemCatalog.normalizedItemCode(filters.itemCode),itemSearch:clean(filters.itemSearch,200),
    invoiceNo:clean(filters.invoiceNo,100),dateFrom:clean(filters.dateFrom,8),dateTo:clean(filters.dateTo,8),
    sourceType:clean(filters.sourceType,100),provenanceStatus:clean(filters.provenanceStatus,100),deltaClass:clean(filters.deltaClass,100),
    saleMin:clean(filters.saleMin,100),saleMax:clean(filters.saleMax,100),costMin:clean(filters.costMin,100),costMax:clean(filters.costMax,100),profitMin:clean(filters.profitMin,100),profitMax:clean(filters.profitMax,100)
  };
}
function allocationAggregates(rows) {
  let quantity=0n,sale=0n,cost=0n,profit=0n,unknown=0n;
  const lineIds=new Set();
  for (const row of rows) {
    lineIds.add(clean(row.originalSaleLineId || row.saleLineId,500));
    quantity += accountingDecimal.parse(row.quantityExact ?? row.allocatedQty ?? row.unknownQty ?? 0, accountingDecimal.QUANTITY_SCALE);
    const saleValue=exactAmount(row,'sale')||0n, costValue=exactAmount(row,'cost');
    sale += saleValue;
    if (costValue == null) unknown += saleValue;
    else { cost += costValue; profit += saleValue-costValue; }
  }
  return {rows:rows.length,saleLines:lineIds.size,quantityExact:accountingDecimal.format(quantity,accountingDecimal.QUANTITY_SCALE),saleValueExact:accountingDecimal.format(sale,accountingDecimal.MONEY_SCALE),fifoCostExact:accountingDecimal.format(cost,accountingDecimal.MONEY_SCALE),fifoProfitExact:accountingDecimal.format(profit,accountingDecimal.MONEY_SCALE),unknownExposureExact:accountingDecimal.format(unknown,accountingDecimal.MONEY_SCALE)};
}
function provenanceByLine(rows, manuals = []) {
  return new Map(provenanceFacts(rows, manuals).map(row => [row.saleLineId,row]));
}
function rowMatchesFinancialFilters(row, ranges) {
  return (!hasRange(ranges.saleMin,ranges.saleMax)||inRange(exactAmount(row,'sale'),ranges.saleMin,ranges.saleMax))
    && (!hasRange(ranges.costMin,ranges.costMax)||inRange(exactAmount(row,'cost'),ranges.costMin,ranges.costMax))
    && (!hasRange(ranges.profitMin,ranges.profitMax)||inRange(exactAmount(row,'profit'),ranges.profitMin,ranges.profitMax));
}
function hasRange(min,max){return min!=null||max!=null;}
function auditRanges(filters){return {saleMin:rangeValue(filters,'saleMin'),saleMax:rangeValue(filters,'saleMax'),costMin:rangeValue(filters,'costMin'),costMax:rangeValue(filters,'costMax'),profitMin:rangeValue(filters,'profitMin'),profitMax:rangeValue(filters,'profitMax')};}
function allocationAuditStatus(row, byLine) {
  return byLine.get(clean(row.originalSaleLineId || row.saleLineId,500))?.profitProvenanceStatus || (row.sourceType==='unknown_cost'?'UNKNOWN':'PROVEN');
}
function deltaClass(control, candidate) {
  const before=control?.profitProvenanceStatus||'MISSING',after=candidate?.profitProvenanceStatus||'MISSING';
  if(before==='PROVEN'&&after==='PROVEN')return control.fifoCostExact===candidate.fifoCostExact?'PROVEN_TO_PROVEN_SAME_COST':'PROVEN_TO_PROVEN_CHANGED_COST';
  return `${before}_TO_${after}`;
}
const AUDIT_DELTA_CLASSES = new Set([
  'UNKNOWN_TO_PROVEN','PROVEN_TO_UNKNOWN','PROVEN_TO_PROVEN_SAME_COST','PROVEN_TO_PROVEN_CHANGED_COST','UNKNOWN_TO_UNKNOWN',
  'PARTIAL_TO_PROVEN','PROVEN_TO_PARTIAL','UNKNOWN_TO_PARTIAL','PARTIAL_TO_UNKNOWN','PARTIAL_TO_PARTIAL',
  'MISSING_TO_PROVEN','MISSING_TO_PARTIAL','MISSING_TO_UNKNOWN','PROVEN_TO_MISSING','PARTIAL_TO_MISSING','UNKNOWN_TO_MISSING'
]);
function deltaReason(control, candidate, classification) {
  const candidateReason=(candidate?.evidence||[]).map(row=>clean(row.reason,500)).find(Boolean);
  if(candidateReason)return candidateReason;
  if(classification==='PROVEN_TO_PROVEN_CHANGED_COST'){
    const before=(control?.evidence||[]).map(row=>clean(row.purchaseLineIdentity||row.openingEvidenceId||row.manualResolutionId,500)).filter(Boolean).sort().join('|');
    const after=(candidate?.evidence||[]).map(row=>clean(row.purchaseLineIdentity||row.openingEvidenceId||row.manualResolutionId,500)).filter(Boolean).sort().join('|');
    return before!==after?'OFFICIAL_PURCHASE_SOURCE_CHANGED':'SOURCE_COST_CHANGED';
  }
  if(classification==='UNKNOWN_TO_PROVEN')return 'COST_EVIDENCE_RESOLVED';
  if(classification==='PROVEN_TO_UNKNOWN')return 'VALID_COST_EVIDENCE_NO_LONGER_ELIGIBLE';
  return classification;
}
function factEvidence(row) {
  return (row?._rows||[]).map(allocation=>({sourceType:allocation.sourceType,costSourceType:allocation.costSourceType||'',purchaseInvoiceNo:Number(allocation.purchaseInvoiceNo||0),purchaseLineIdentity:clean(allocation.purchaseLineIdentity,500),openingEvidenceId:clean(allocation.openingEvidenceId,100),manualResolutionId:clean(allocation.manualResolutionId,100),quantityExact:clean(allocation.quantityExact??allocation.allocatedQty??allocation.unknownQty,100),costExact:clean(allocation.allocatedCostAmountExact??allocation.allocatedCostAmount,100),reason:clean(allocation.unknownReason||allocation.returnEffect,500)}));
}
function factMatchesRanges(fact,ranges){
  const sale=decimalOrNull(fact.saleValueExact),cost=decimalOrNull(fact.fifoCostExact),profit=decimalOrNull(fact.fifoProfitExact);
  return (!hasRange(ranges.saleMin,ranges.saleMax)||inRange(sale,ranges.saleMin,ranges.saleMax))&&(!hasRange(ranges.costMin,ranges.costMax)||inRange(cost,ranges.costMin,ranges.costMax))&&(!hasRange(ranges.profitMin,ranges.profitMax)||inRange(profit,ranges.profitMin,ranges.profitMax));
}
function deltaAggregates(rows) {
  let newlyProvenSale=0n,newlyProvenProfit=0n,lostProvenSale=0n,changedCostExposure=0n;
  for(const row of rows){
    const sale=decimalOrNull(row.candidate?.saleValueExact??row.control?.saleValueExact)||0n;
    if(row.deltaClass==='UNKNOWN_TO_PROVEN'||row.deltaClass==='PARTIAL_TO_PROVEN'||row.deltaClass==='MISSING_TO_PROVEN'){newlyProvenSale+=sale;newlyProvenProfit+=decimalOrNull(row.candidate?.fifoProfitExact)||0n;}
    if(row.deltaClass==='PROVEN_TO_UNKNOWN'||row.deltaClass==='PROVEN_TO_PARTIAL'||row.deltaClass==='PROVEN_TO_MISSING')lostProvenSale+=sale;
    if(row.deltaClass==='PROVEN_TO_PROVEN_CHANGED_COST')changedCostExposure+=sale;
  }
  return {rows:rows.length,newlyProvenSaleExact:accountingDecimal.format(newlyProvenSale,2),newlyProvenProfitExact:accountingDecimal.format(newlyProvenProfit,2),lostProvenSaleExact:accountingDecimal.format(lostProvenSale,2),changedCostExposureExact:accountingDecimal.format(changedCostExposure,2)};
}
const auditContextCache=new Map();
async function auditDatasetContext(db,dataset){
  const key=`${dataset.datasetId}|${dataset.allocationFingerprint||dataset.candidateFingerprint||''}`;
  if(auditContextCache.has(key))return auditContextCache.get(key);
  const promise=(async()=>{
    const rawRows=await db.collection(ALLOCATIONS).find({datasetId:dataset.datasetId}).toArray();
    const categoryMap=await canonicalCategoryMap(db,rawRows);
    const rows=enrichAuditCategories(rawRows,categoryMap);
    return {rows,categoryMap,facts:provenanceByLine(rows)};
  })().catch(error=>{auditContextCache.delete(key);throw error;});
  auditContextCache.set(key,promise);
  while(auditContextCache.size>3)auditContextCache.delete(auditContextCache.keys().next().value);
  return promise;
}
async function auditAllocations(db, filters = {}) {
  const startedAt=Date.now();
  await ensureIndexes(db);
  const datasetId=clean(filters.datasetId,100);
  if(!datasetId)fail('FIFO_DATASET_REQUIRED','Candidate Dataset الزامی است.',400);
  const dataset=await db.collection(DATASETS).findOne({datasetId});
  if(!dataset)fail('FIFO_DATASET_NOT_FOUND','FIFO Candidate پیدا نشد.',404);
  const appliedFilters=auditAppliedFilters(datasetId,filters),ranges=auditRanges(filters);
  if(appliedFilters.deltaClass&&!AUDIT_DELTA_CLASSES.has(appliedFilters.deltaClass))fail('FIFO_AUDIT_DELTA_INVALID','طبقه‌بندی Delta معتبر نیست.',400);
  const page=Math.max(1,Number(filters.page||1)),pageSize=Math.max(1,Math.min(Number(filters.pageSize||100),500));
  const candidateContext=await auditDatasetContext(db,dataset),allCandidateRows=candidateContext.rows;
  const baseQuery=auditBaseQuery(datasetId,filters),categoryCodes=categoryItemCodes(candidateContext.categoryMap,filters);
  if(categoryCodes){
    if(typeof baseQuery.itemCode==='string'&&!categoryCodes.includes(baseQuery.itemCode))baseQuery.itemCode={ $in:[] };
    else if(!baseQuery.itemCode)baseQuery.itemCode={ $in:categoryCodes };
  }
  let candidateRows=await db.collection(ALLOCATIONS).find(baseQuery).sort({saleDate:1,saleInvoiceNo:1,saleRow:1,allocationSequence:1}).toArray();
  if(candidateRows.length>100000)fail('FIFO_AUDIT_SCOPE_TOO_LARGE','دامنه ممیزی بیش از حد مجاز است؛ فیلتر محدودتری اعمال کنید.',413);
  candidateRows=categoryFilter(enrichAuditCategories(candidateRows,candidateContext.categoryMap),filters);
  const candidateFacts=candidateContext.facts;
  if(appliedFilters.mode!=='delta'){
    const rows=candidateRows.filter(row=>!appliedFilters.provenanceStatus||allocationAuditStatus(row,candidateFacts)===appliedFilters.provenanceStatus).filter(row=>{
      if(!hasRange(ranges.saleMin,ranges.saleMax)&&!hasRange(ranges.costMin,ranges.costMax)&&!hasRange(ranges.profitMin,ranges.profitMax))return true;
      return rowMatchesFinancialFilters(row,ranges);
    }).map(row=>({...row,canonicalSellerId:auditSellerId(row),canonicalCategoryGuid:auditCategoryGuid(row),profitProvenanceStatus:allocationAuditStatus(row,candidateFacts)}));
    return {ok:true,readOnly:true,mode:'allocations',datasetId,total:rows.length,page,pageSize,list:rows.slice((page-1)*pageSize,page*pageSize),aggregates:allocationAggregates(rows),appliedFilters,performance:{serverReadMs:Date.now()-startedAt,scannedCandidateRows:allCandidateRows.length,prefilteredRows:candidateRows.length,indexContract:'datasetId + canonical identity/date/source compounds; explicit-submit only'},shadowMode:true,accountingApproved:false};
  }
  const controlDatasetId=appliedFilters.controlDatasetId;
  if(!controlDatasetId)fail('FIFO_CONTROL_DATASET_REQUIRED','Control Dataset الزامی است.',400);
  const control=await db.collection(DATASETS).findOne({datasetId:controlDatasetId});
  if(!control)fail('FIFO_CONTROL_DATASET_NOT_FOUND','Control FIFO پیدا نشد.',404);
  const controlContext=await auditDatasetContext(db,control),allControlRows=controlContext.rows;
  const candidateBy=candidateContext.facts,controlBy=controlContext.facts;
  const eligibleLines=new Set(candidateRows.map(row=>clean(row.originalSaleLineId||row.saleLineId,500)));
  const keys=[...new Set([...candidateBy.keys(),...controlBy.keys()])].filter(key=>eligibleLines.has(key));
  const rows=keys.map(saleLineId=>{
    const candidateFact=candidateBy.get(saleLineId)||null,controlFact=controlBy.get(saleLineId)||null,classification=deltaClass(controlFact,candidateFact);
    const costDelta=(decimalOrNull(candidateFact?.fifoCostExact)||0n)-(decimalOrNull(controlFact?.fifoCostExact)||0n);
    const profitDelta=(decimalOrNull(candidateFact?.fifoProfitExact)||0n)-(decimalOrNull(controlFact?.fifoProfitExact)||0n);
    const shapedControl=controlFact?{...controlFact,evidence:factEvidence(controlFact),_rows:undefined}:null;
    const shapedCandidate=candidateFact?{...candidateFact,evidence:factEvidence(candidateFact),_rows:undefined}:null;
    return {saleLineId,deltaClass:classification,deltaReason:deltaReason(shapedControl,shapedCandidate,classification),identity:{saleInvoiceNo:candidateFact?.saleInvoiceNo??controlFact?.saleInvoiceNo,itemCode:candidateFact?.itemCode??controlFact?.itemCode,itemDescription:candidateFact?.itemDescription??controlFact?.itemDescription,saleDate:candidateFact?.saleDate??controlFact?.saleDate,canonicalSellerId:candidateFact?.canonicalSellerId??controlFact?.canonicalSellerId,sellerName:candidateFact?.sellerName??controlFact?.sellerName,canonicalCategoryGuid:candidateFact?.canonicalCategoryGuid??controlFact?.canonicalCategoryGuid,categoryName:candidateFact?.productCategory??controlFact?.productCategory},control:shapedControl,candidate:shapedCandidate,costDeltaExact:accountingDecimal.format(costDelta,2),profitDeltaExact:accountingDecimal.format(profitDelta,2)};
  }).filter(row=>(!appliedFilters.deltaClass||row.deltaClass===appliedFilters.deltaClass)&&(!appliedFilters.provenanceStatus||(row.candidate||row.control)?.profitProvenanceStatus===appliedFilters.provenanceStatus)&&factMatchesRanges(row.candidate||row.control,ranges));
  rows.sort((a,b)=>String(a.identity.saleDate||'').localeCompare(String(b.identity.saleDate||''),'en')||Number(a.identity.saleInvoiceNo||0)-Number(b.identity.saleInvoiceNo||0)||a.saleLineId.localeCompare(b.saleLineId,'en'));
  return {ok:true,readOnly:true,mode:'delta',datasetId,controlDatasetId,total:rows.length,page,pageSize,list:rows.slice((page-1)*pageSize,page*pageSize),aggregates:deltaAggregates(rows),appliedFilters,performance:{serverReadMs:Date.now()-startedAt,scannedCandidateRows:allCandidateRows.length,scannedControlRows:allControlRows.length,prefilteredRows:candidateRows.length,indexContract:'datasetId + canonical identity/date/source compounds; explicit-submit only'},shadowMode:true,accountingApproved:false};
}
async function auditDimensions(db, filters = {}) {
  const datasetId=clean(filters.datasetId,100);
  if(!datasetId)fail('FIFO_DATASET_REQUIRED','Candidate Dataset الزامی است.',400);
  const dataset=await db.collection(DATASETS).findOne({datasetId});
  if(!dataset)fail('FIFO_DATASET_NOT_FOUND','FIFO Candidate پیدا نشد.',404);
  const context=await auditDatasetContext(db,dataset),sellers=new Map(),categories=new Map();
  for(const fact of context.facts.values()){
    const sellerId=clean(fact.canonicalSellerId,100),sellerName=clean(fact.sellerName,200);
    if(sellerId&&sellerId!=='UNRESOLVED'){
      const current=sellers.get(sellerId)||{canonicalSellerId:sellerId,sellerName:'',rawNames:new Set(),saleLines:0};
      if(sellerName){current.rawNames.add(sellerName);if(!current.sellerName)current.sellerName=sellerName;}
      current.saleLines++;sellers.set(sellerId,current);
    }
    const categoryGuid=clean(fact.canonicalCategoryGuid,100),categoryName=clean(fact.productCategory,300);
    if(categoryGuid&&categoryGuid!=='UNRESOLVED'){
      const current=categories.get(categoryGuid)||{canonicalCategoryGuid:categoryGuid,categoryName:'',rawNames:new Set(),saleLines:0};
      if(categoryName){current.rawNames.add(categoryName);if(!current.categoryName)current.categoryName=categoryName;}
      current.saleLines++;categories.set(categoryGuid,current);
    }
  }
  const shape=row=>({...row,rawNames:[...row.rawNames].sort((a,b)=>a.localeCompare(b,'fa'))});
  return {ok:true,readOnly:true,datasetId,
    sellers:[...sellers.values()].map(shape).sort((a,b)=>(a.sellerName||a.canonicalSellerId).localeCompare(b.sellerName||b.canonicalSellerId,'fa')||a.canonicalSellerId.localeCompare(b.canonicalSellerId,'en')),
    categories:[...categories.values()].map(shape).sort((a,b)=>(a.categoryName||a.canonicalCategoryGuid).localeCompare(b.categoryName||b.canonicalCategoryGuid,'fa')||a.canonicalCategoryGuid.localeCompare(b.canonicalCategoryGuid,'en')),
    authority:{seller:'canonicalSellerId',category:'officialMainGroupGuid'},shadowMode:true,accountingApproved:false};
}
async function listExceptions(db, filters = {}) {
  await ensureIndexes(db);
  const active = filters.datasetId ? null : await activeDataset(db);
  const datasetId = clean(filters.datasetId || active?.datasetId, 100);
  if (!datasetId) return { ok:true, datasetId:'', total:0, page:1, pageSize:100, list:[] };
  const query = { datasetId };
  if (filters.status) query.status = clean(filters.status, 100);
  if (filters.code) query.code = clean(filters.code, 100);
  if (filters.itemCode) query.itemCode = clean(filters.itemCode, 100);
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 100), 1000));
  const total = await count(db.collection(EXCEPTIONS), query);
  const list = await db.collection(EXCEPTIONS).find(query)
    .sort({ severity:-1, code:1, itemCode:1 }).skip((page - 1) * pageSize).limit(pageSize).toArray();
  return { ok:true, datasetId, total, page, pageSize, list, shadowMode:true, accountingApproved:false };
}
function topValues(map, sortField, limit = 10) {
  return [...map.values()].sort((a, b) => Number(b[sortField] || 0) - Number(a[sortField] || 0)).slice(0, limit);
}
function provenanceFacts(allocations,manualRows=[]){
  const grouped=new Map(),manualById=new Map(manualRows.map(row=>[clean(row.resolutionId,100),row]));
  for(const row of allocations){
    if(Number(row.saleInvoiceType)===2)addIndex(grouped,clean(row.saleLineId,500),row);
    else if(row.sourceType==='sale_return_reversal'&&clean(row.originalSaleLineId,500))addIndex(grouped,clean(row.originalSaleLineId,500),row);
  }
  const facts=[];
  for(const [saleLineId,rows] of grouped){
    const first=rows.find(row=>Number(row.saleInvoiceType)===2)||rows[0];
    const netQuantityExact=accountingDecimal.format(rows.reduce((sum,row)=>sum+accountingDecimal.parse(row.quantityExact??row.allocatedQty??row.unknownQty??0,accountingDecimal.QUANTITY_SCALE),0n),accountingDecimal.QUANTITY_SCALE);
    const saleValueExact=accountingDecimal.format(rows.reduce((sum,row)=>sum+accountingDecimal.parse(row.allocatedSaleValueExact??row.allocatedSaleValue??0,accountingDecimal.MONEY_SCALE),0n),accountingDecimal.MONEY_SCALE);
    const provenance=profitProvenance.lineProvenance(rows,{saleQtyExact:netQuantityExact,saleValueExact,manualById});
    facts.push({saleLineId,saleInvoiceNo:Number(first.saleInvoiceNo||0),saleDate:clean(first.saleDate,8),sellerIdentity:auditSellerId(first)||'UNRESOLVED',canonicalSellerId:auditSellerId(first)||'UNRESOLVED',sellerName:clean(first.sellerName,200),productCategory:clean(first.canonicalCategoryName||first.officialProductCategoryName||first.productCategory,300)||'UNRESOLVED',canonicalCategoryGuid:auditCategoryGuid(first)||'UNRESOLVED',itemCode:clean(first.itemCode,100),itemDescription:clean(first.itemDescription,500),quantityExact:provenance.provenanceReconciliation.requiredQtyExact,saleValueExact,fifoCostExact:provenance.provenanceReconciliation.allocatedCostExact,fifoProfitExact:provenance.provenanceReconciliation.fifoProfitExact,profitProvenanceStatus:provenance.profitProvenanceStatus,costSourceType:provenance.costSourceType,provenanceSources:provenance.provenanceSources,provenanceFingerprint:provenance.provenanceFingerprint,returnAllocationCount:rows.filter(row=>row.sourceType==='sale_return_reversal').length,_rows:rows});
  }
  return facts;
}
function provenanceCoverage(facts){
  const totalValue=facts.reduce((sum,row)=>sum+accountingDecimal.parse(row.saleValueExact,accountingDecimal.MONEY_SCALE),0n);
  const proven=facts.filter(row=>row.profitProvenanceStatus==='PROVEN');
  const provenValue=proven.reduce((sum,row)=>sum+accountingDecimal.parse(row.saleValueExact,accountingDecimal.MONEY_SCALE),0n);
  const knownCost=proven.reduce((sum,row)=>sum+accountingDecimal.parse(row.fifoCostExact,accountingDecimal.MONEY_SCALE),0n);
  const knownProfit=proven.reduce((sum,row)=>sum+accountingDecimal.parse(row.fifoProfitExact,accountingDecimal.MONEY_SCALE),0n);
  return {sales:facts.length,provenLines:proven.length,partialLines:facts.filter(row=>row.profitProvenanceStatus==='PARTIAL').length,unknownLines:facts.filter(row=>row.profitProvenanceStatus==='UNKNOWN').length,totalSaleValueExact:accountingDecimal.format(totalValue,accountingDecimal.MONEY_SCALE),provenSaleValueExact:accountingDecimal.format(provenValue,accountingDecimal.MONEY_SCALE),unknownOrPartialSaleValueExact:accountingDecimal.format(totalValue-provenValue,accountingDecimal.MONEY_SCALE),provenProfitCoveragePercent:totalValue===0n?'0.0000':accountingDecimal.format(accountingDecimal.divideRounded(provenValue*1000000n,totalValue),4),provenFifoCostExact:accountingDecimal.format(knownCost,accountingDecimal.MONEY_SCALE),provenFifoProfitExact:accountingDecimal.format(knownProfit,accountingDecimal.MONEY_SCALE)};
}
function groupedProvenanceCoverage(facts,field){const grouped=new Map();for(const fact of facts)addIndex(grouped,fact[field]||'UNRESOLVED',fact);return [...grouped].map(([identity,rows])=>({identity,...provenanceCoverage(rows)})).sort((a,b)=>accountingDecimal.parse(b.totalSaleValueExact,2)>accountingDecimal.parse(a.totalSaleValueExact,2)?1:-1);}
async function candidateQualityReport(db,datasetId){
  const id=clean(datasetId,100);if(!id)fail('FIFO_DATASET_REQUIRED','Candidate Dataset الزامی است.',400);
  const candidate=await db.collection(DATASETS).findOne({datasetId:id});
  if(!candidate)fail('FIFO_DATASET_NOT_FOUND','FIFO Candidate پیدا نشد.',404);
  const state=await db.collection(STATE).findOne({scopeKey:SCOPE_KEY});
  const oldId=clean(state?.activeDatasetId,100);
  const [candidateAllocations,oldAllocations,manuals]=await Promise.all([
    db.collection(ALLOCATIONS).find({datasetId:id}).toArray(),
    oldId?db.collection(ALLOCATIONS).find({datasetId:oldId}).toArray():[],
    db.collection(manualCostResolution.COLLECTION).find({status:'approved',deleted:{$ne:true}}).toArray()
  ]);
  const nextFacts=provenanceFacts(candidateAllocations,manuals),oldFacts=provenanceFacts(oldAllocations,manuals),oldByLine=new Map(oldFacts.map(row=>[row.saleLineId,row]));
  const newlyResolved=[],newlyUnresolved=[],profitChanged=[];
  for(const row of nextFacts){const old=oldByLine.get(row.saleLineId);if(old?.profitProvenanceStatus!=='PROVEN'&&row.profitProvenanceStatus==='PROVEN')newlyResolved.push(row.saleLineId);if(old?.profitProvenanceStatus==='PROVEN'&&row.profitProvenanceStatus!=='PROVEN')newlyUnresolved.push(row.saleLineId);if(old?.profitProvenanceStatus==='PROVEN'&&row.profitProvenanceStatus==='PROVEN'&&old.fifoProfitExact!==row.fifoProfitExact)profitChanged.push({saleLineId:row.saleLineId,oldProfitExact:old.fifoProfitExact,newProfitExact:row.fifoProfitExact,deltaExact:accountingDecimal.format(accountingDecimal.parse(row.fifoProfitExact,2)-accountingDecimal.parse(old.fifoProfitExact,2),2)});}
  profitChanged.sort((a,b)=>{const av=accountingDecimal.parse(a.deltaExact,2);const bv=accountingDecimal.parse(b.deltaExact,2);return (bv<0n?-bv:bv)>(av<0n?-av:av)?1:-1;});
  return {ok:true,readOnly:true,candidate:{datasetId:id,status:candidate.status,activationStatus:candidate.activationStatus,candidateFingerprint:candidate.candidateFingerprint||'',sourceSaleSnapshotId:candidate.sourceSaleSnapshotId,sourcePurchaseDatasetId:candidate.sourcePurchaseDatasetId,manualResolutionSetFingerprint:candidate.manualResolutionSetFingerprint,active:false},activeOld:{datasetId:oldId,coverage:provenanceCoverage(oldFacts)},candidateCoverage:provenanceCoverage(nextFacts),coverageBySeller:groupedProvenanceCoverage(nextFacts,'sellerIdentity'),coverageByCategory:groupedProvenanceCoverage(nextFacts,'productCategory'),delta:{newlyResolvedLines:newlyResolved.length,newlyUnresolvedLines:newlyUnresolved.length,profitChangedLines:profitChanged.length,largestProfitDeltas:profitChanged.slice(0,20),manualCostAffectedLines:nextFacts.filter(row=>row.provenanceSources.some(source=>source.manualCostResolutionId)).map(row=>row.saleLineId)},facts:{old:oldFacts.length,candidate:nextFacts.length},allocations:{old:oldAllocations.length,candidate:candidateAllocations.length},exceptions:{candidate:await count(db.collection(EXCEPTIONS),{datasetId:id})},candidateNotActivated:oldId!==id};
}
async function validationReport(db, datasetId = '') {
  await ensureIndexes(db);
  const active = datasetId ? null : await activeDataset(db);
  const id = clean(datasetId || active?.datasetId, 100);
  if (!id) return { ok:true, available:false, shadowMode:true, accountingApproved:false };
  const dataset = await db.collection(DATASETS).findOne({ datasetId:id });
  if (!dataset) fail('FIFO_DATASET_NOT_FOUND', 'FIFO Shadow Dataset پیدا نشد.', 404);
  const startedMs = Date.now();
  const [allocations, exceptions, diagnostics] = await Promise.all([
    db.collection(ALLOCATIONS).find({ datasetId:id }).toArray(),
    db.collection(EXCEPTIONS).find({ datasetId:id }).toArray(),
    db.collection(DIAGNOSTICS).find({ datasetId:id }).sort({ at:1 }).toArray()
  ]);
  const invoices = new Map();
  const items = new Map();
  for (const row of allocations) {
    const invoiceKey = `${row.saleInvoiceType}-${row.saleInvoiceNo}`;
    const invoice = invoices.get(invoiceKey) || {
      saleInvoiceType:row.saleInvoiceType, saleInvoiceNo:row.saleInvoiceNo, saleDate:row.saleDate,
      saleValue:0, lineIds:new Set(), allocatedQuantity:0, unknownQuantity:0, allocatedCostAmount:0
    };
    invoice.saleValue += Number(row.allocatedSaleValue || 0);
    invoice.lineIds.add(row.saleLineId);
    invoice.allocatedQuantity += Number(row.allocatedQty || 0);
    invoice.unknownQuantity += Number(row.unknownQty || 0);
    invoice.allocatedCostAmount += Number(row.allocatedCostAmount || 0);
    invoices.set(invoiceKey, invoice);
    const itemKey = sourceKey(row);
    const item = items.get(itemKey) || {
      itemGuid:row.itemGuid, itemCode:row.itemCode, itemDescription:row.itemDescription,
      saleValue:0, soldQuantity:0, allocatedQuantity:0, unknownQuantity:0, allocatedCostAmount:0, invoices:new Set()
    };
    item.saleValue += Number(row.allocatedSaleValue || 0);
    item.soldQuantity += Number(row.allocatedQty || row.unknownQty || 0);
    item.allocatedQuantity += Number(row.allocatedQty || 0);
    item.unknownQuantity += Number(row.unknownQty || 0);
    item.allocatedCostAmount += Number(row.allocatedCostAmount || 0);
    item.invoices.add(invoiceKey);
    items.set(itemKey, item);
  }
  const shapeInvoice = row => ({ ...row, lineCount:row.lineIds.size, lineIds:undefined, saleValue:round(row.saleValue, VALUE_SCALE), allocatedCostAmount:round(row.allocatedCostAmount, VALUE_SCALE) });
  const shapeItem = row => ({ ...row, invoiceCount:row.invoices.size, invoices:undefined, saleValue:round(row.saleValue, VALUE_SCALE), allocatedCostAmount:round(row.allocatedCostAmount, VALUE_SCALE) });
  const invoiceRows = [...invoices.values()].map(shapeInvoice);
  const itemRows = [...items.values()].map(shapeItem);
  const unresolvedByItem = new Map();
  for (const row of itemRows.filter(item => item.unknownQuantity > EPSILON)) unresolvedByItem.set(sourceKey(row), row);
  return {
    ok:true,
    available:true,
    dataset,
    coverage:dataset.summary,
    confidence:{ score:dataset.summary?.confidenceScore || 0, classification:dataset.summary?.confidence || 'Unknown' },
    reconciliation:dataset.validation,
    businessValidation:{
      topInvoicesByValue:invoiceRows.sort((a, b) => b.saleValue - a.saleValue).slice(0, 10),
      topInvoicesByLineCount:[...invoiceRows].sort((a, b) => b.lineCount - a.lineCount || b.saleValue - a.saleValue).slice(0, 10),
      topHighestTurnoverItems:topValues(new Map(itemRows.map(row => [sourceKey(row), row])), 'soldQuantity'),
      topHighestAllocatedValue:topValues(new Map(itemRows.map(row => [sourceKey(row), row])), 'allocatedCostAmount'),
      topUnresolvedItems:topValues(unresolvedByItem, 'unknownQuantity'),
      purchaseReturns:exceptions.filter(row => row.code === 'PURCHASE_RETURN_STATUS'),
      manualSamples:allocations.filter(row => ['approved_manual_cost','approved_manual_purchase_layer','approved_manual_opening_quantity','approved_manual_evidence_quantity'].includes(row.sourceType)).slice(0, 20),
      unknownSamples:allocations.filter(row => row.sourceType === 'unknown_cost').slice(0, 20)
    },
    topExceptions:exceptions.filter(row => row.status === 'unresolved').slice(0, 50),
    diagnostics,
    reportPerformance:{ mongoReadAndAggregationMs:Date.now() - startedMs, allocationRowsRead:allocations.length, exceptionRowsRead:exceptions.length },
    shadowMode:true,
    accountingApproved:false,
    profitCalculated:false,
    roiCalculated:false,
    commissionCalculated:false
  };
}

module.exports = {
  DATASETS,
  ALLOCATIONS,
  DIAGNOSTICS,
  EXCEPTIONS,
  STATE,
  SCOPE_KEY,
  SCHEMA_VERSION,
  ALGORITHM_VERSION,
  ensureIndexes,
  activeDataset,
  buildShadowDataset,
  listDatasets,
  status,
  listAllocations,
  auditAllocations,
  auditDimensions,
  listExceptions,
  validationReport,
  candidateQualityReport,
  _allocateSources:allocateSources,
  _reconcile:reconcile,
  _summarize:summarize,
  _loadSources:loadSources,
  _eligibleOfficial:eligibleOfficial,
  _manualEffective:manualEffective,
  _immutableProjection:immutableProjection
  ,_provenanceFacts:provenanceFacts
  ,_provenanceCoverage:provenanceCoverage
};
