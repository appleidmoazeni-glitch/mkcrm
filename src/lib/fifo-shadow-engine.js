'use strict';

const crypto = require('crypto');
const purchaseLayerDataset = require('./purchase-layer-dataset');
const manualCostResolution = require('./manual-cost-resolution');
const saleSnapshot = require('./sale-snapshot');
const { APP_VERSION } = require('./app-version');
const { normalizeJalaliRange } = require('./jalali-date');

const DATASETS = 'fifoDatasets';
const ALLOCATIONS = 'fifoAllocations';
const DIAGNOSTICS = 'fifoDiagnostics';
const EXCEPTIONS = 'fifoExceptions';
const STATE = 'fifoDatasetState';
const SCOPE_KEY = 'fifo-shadow-v1';
const SCHEMA_VERSION = 1;
const ALGORITHM_VERSION = 'fifo-shadow-1.0.0';
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
function compareLayers(a, b) {
  return clean(a.purchaseInvoiceDate).localeCompare(clean(b.purchaseInvoiceDate), 'en') ||
    Number(a.purchaseInvoiceNo || 0) - Number(b.purchaseInvoiceNo || 0) ||
    Number(a.sourceRow || 0) - Number(b.sourceRow || 0) ||
    purchaseIdentity(a).localeCompare(purchaseIdentity(b), 'en');
}
function manualEffective(row, saleDate) {
  return row.status === 'approved' && row.deleted !== true &&
    validDate(row.effectiveFrom) && row.effectiveFrom <= saleDate &&
    (!row.effectiveTo || row.effectiveTo >= saleDate) &&
    finite(row.manualCost) > 0;
}
function eligibleOfficial(row) {
  const quantity = finite(row.netPurchasedQuantity ?? row.remainingQuantity ?? row.originalQuantity);
  const unitCost = finite(row.netUnitCost ?? row.grossUnitCost);
  return row.layerKind === 'purchase' &&
    row.validationStatus !== 'rejected' &&
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
    sourceReference:row.purchaseLineIdentity || row.manualResolutionId || '',
    allocatedQty:round(row.allocatedQty),
    unknownQty:round(row.unknownQty),
    unitCost:row.unitCost == null ? null : round(row.unitCost, VALUE_SCALE),
    allocatedCostAmount:row.allocatedCostAmount == null ? null : round(row.allocatedCostAmount, VALUE_SCALE)
  };
}

async function ensureIndexes(db) {
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
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, purchaseLineIdentity:1 });
  await db.collection(ALLOCATIONS).createIndex({ datasetId:1, manualResolutionId:1 });
  await db.collection(DIAGNOSTICS).createIndex({ datasetId:1, at:1 });
  await db.collection(EXCEPTIONS).createIndex({ datasetId:1, exceptionKey:1 }, { unique:true });
  await db.collection(EXCEPTIONS).createIndex({ datasetId:1, status:1, code:1, itemCode:1 });
  await db.collection(STATE).createIndex({ scopeKey:1 }, { unique:true });
  return { ok:true, schemaVersion:SCHEMA_VERSION, algorithmVersion:ALGORITHM_VERSION };
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
  const [saleLines, saleHeaders, purchaseLayers, manuals] = await Promise.all([
    db.collection(saleActive.lineCollection).find(saleActive.lineQuery).toArray(),
    db.collection(saleActive.headerCollection).find(saleActive.headerQuery).toArray(),
    db.collection(purchaseLayerDataset.LAYERS).find({ datasetId:purchaseActive.datasetId }).toArray(),
    db.collection(manualCostResolution.COLLECTION).find({ status:'approved', deleted:{ $ne:true } }).toArray()
  ]);
  return { saleActive, purchaseActive, saleLines, saleHeaders, purchaseLayers, manuals };
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
    fifoRemainingQuantity:round(finite(row.netPurchasedQuantity ?? row.remainingQuantity ?? row.originalQuantity))
  }));
  const purchaseReturns = source.purchaseLayers.filter(row => row.layerKind === 'purchase-return');
  const officialIndex = indexRows(officialRows);
  const manualIndex = indexRows(source.manuals);
  const allocations = [];
  const exceptions = [];
  const consumedByLayer = new Map();
  const sourceSaleLineIds = new Set();
  let allocationSequenceGlobal = 0;

  for (const sale of sales) {
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
        sourceType:'official_purchase_layer',
        sourceConfidence:'official',
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
        manualResolutionId:'',
        unitCost,
        allocatedCostAmount,
        layerAvailableBefore:available,
        layerRemainingQuantity:sourceRemaining,
        unknownReason:'',
        createdAt:new Date()
      });
    }

    if (need > EPSILON) {
      const manuals = matchingRows(manualIndex, sale)
        .filter(row => manualEffective(row, sale.saleDate))
        .sort((a, b) => clean(b.effectiveFrom).localeCompare(clean(a.effectiveFrom), 'en') || clean(a.resolutionId).localeCompare(clean(b.resolutionId), 'en'));
      if (manuals.length === 1) {
        const manual = manuals[0];
        sequence++;
        allocationSequenceGlobal++;
        const quantity = need;
        need = 0;
        const unitCost = round(finite(manual.manualCost), VALUE_SCALE);
        allocations.push({
          datasetId,
          allocationId:`FA-${sha256(`${datasetId}|${saleLineId}|${sequence}|${manual.resolutionId}`).slice(0, 32)}`,
          allocationSequence:sequence,
          globalSequence:allocationSequenceGlobal,
          schemaVersion:SCHEMA_VERSION,
          algorithmVersion:ALGORITHM_VERSION,
          sourceType:'approved_manual_cost',
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
          unitCost,
          allocatedCostAmount:round(quantity * unitCost, VALUE_SCALE),
          layerAvailableBefore:null,
          layerRemainingQuantity:null,
          unknownReason:'',
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
        const unknownReason = eligibleForSale.length
          ? 'official_layer_quantity_exhausted'
          : (manuals.length > 1 ? 'ambiguous_manual_resolution' : 'no_valid_cost_source');
        allocations.push({
          datasetId,
          allocationId:`FA-${sha256(`${datasetId}|${saleLineId}|${sequence}|unknown`).slice(0, 32)}`,
          allocationSequence:sequence,
          globalSequence:allocationSequenceGlobal,
          schemaVersion:SCHEMA_VERSION,
          algorithmVersion:ALGORITHM_VERSION,
          sourceType:'unknown_cost',
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
          unitCost:null,
          allocatedCostAmount:null,
          layerAvailableBefore:null,
          layerRemainingQuantity:null,
          unknownReason,
          createdAt:new Date()
        });
        exceptions.push(exception(datasetId, 'UNKNOWN_COST', 'unresolved', {
          saleLineId, itemGuid:sale.itemGuid, itemCode:sale.itemCode, reason:unknownReason
        }));
      }
    }
  }

  const saleHeadersByGuid = new Map();
  for (const header of source.saleHeaders.filter(row => Number(row.invTyp) === 2)) {
    const key = identity(header.guId);
    if (key) addIndex(saleHeadersByGuid, key, header);
  }
  for (const row of saleReturns) {
    const reference = identity(row.relatedInvHeaderId || row.invHeaderIdRoot);
    const candidates = reference ? saleHeadersByGuid.get(reference) || [] : [];
    exceptions.push(exception(datasetId, 'SALE_RETURN_NOT_ALLOCATED', candidates.length === 1 ? 'linked-not-allocated' : 'unresolved', {
      saleReturnLineId:saleIdentity(row),
      itemGuid:row.itemGuid,
      itemCode:row.itemCode,
      reference,
      reason:candidates.length === 1
        ? 'Sale return is linked to one sale header and intentionally does not create a FIFO allocation.'
        : 'Sale return linkage is missing or ambiguous; no FIFO allocation was generated.'
    }));
  }
  for (const row of purchaseReturns) {
    const resolved = row.returnMatchStatus === 'matched';
    exceptions.push(exception(datasetId, 'PURCHASE_RETURN_STATUS', resolved ? 'linked-netted-in-source' : 'unresolved', {
      purchaseLineIdentity:purchaseIdentity(row),
      itemGuid:row.itemGuid,
      itemCode:row.itemCode,
      reference:row.returnInvHeaderReference,
      reason:resolved
        ? 'Matched purchase return is already reflected in source netPurchasedQuantity; no allocation row was generated.'
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
  let saleQuantityMismatchCount = 0;
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
    if (Math.abs(quantity - allocated - unknown) > EPSILON) saleQuantityMismatchCount++;
  }
  let layerOverConsumptionCount = 0;
  let negativeRemainingCount = 0;
  let orphanLayerCount = 0;
  const officialByIdentity = new Map(result.officialRows.map(row => [purchaseIdentity(row), row]));
  for (const row of result.allocations.filter(item => item.sourceType === 'official_purchase_layer')) {
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
  const inactiveSourceCount = result.allocations.filter(row =>
    !['official_purchase_layer', 'approved_manual_cost', 'unknown_cost'].includes(row.sourceType)
  ).length;
  const validation = {
    soldQuantity,
    allocatedQuantity,
    unknownQuantity,
    allocatedPlusUnknownEqualsSold:Math.abs(soldQuantity - allocatedQuantity - unknownQuantity) <= EPSILON,
    saleQuantityMismatchCount,
    duplicateAllocationCount:duplicateAllocationIds.size,
    layerOverConsumptionCount,
    orphanLayerCount,
    negativeRemainingCount,
    inactiveSourceCount,
    checkedAt:new Date()
  };
  validation.valid = validation.allocatedPlusUnknownEqualsSold &&
    validation.saleQuantityMismatchCount === 0 &&
    validation.duplicateAllocationCount === 0 &&
    validation.layerOverConsumptionCount === 0 &&
    validation.orphanLayerCount === 0 &&
    validation.negativeRemainingCount === 0 &&
    validation.inactiveSourceCount === 0;
  return validation;
}

function summarize(result, validation) {
  const totals = { quantity:0, saleValue:0 };
  const bySource = {
    official_purchase_layer:{ quantity:0, saleValue:0, costValue:0, rows:0, items:new Set() },
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
  }
  for (const row of result.allocations) {
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
  }
  const confidenceScore = round(
    shaped.official_purchase_layer.quantityPercent +
    shaped.approved_manual_cost.quantityPercent * 0.6,
    2
  );
  let confidence = 'Unknown';
  if (shaped.unknown_cost.quantity <= EPSILON) {
    if (shaped.approved_manual_cost.quantity <= EPSILON) confidence = 'Official Complete';
    else if (shaped.official_purchase_layer.quantity <= EPSILON) confidence = 'Manual Complete';
    else confidence = 'Mixed';
  } else if (shaped.official_purchase_layer.quantity > EPSILON || shaped.approved_manual_cost.quantity > EPSILON) {
    confidence = 'Official Partial';
  }
  return {
    soldLineCount:saleSeen.size,
    allocationCount:result.allocations.length,
    soldQuantity:round(totals.quantity),
    saleValue:round(totals.saleValue, VALUE_SCALE),
    official:shaped.official_purchase_layer,
    manual:shaped.approved_manual_cost,
    unknown:shaped.unknown_cost,
    confidenceScore,
    confidence,
    purchaseReturns:{ total:result.purchaseReturns.length, unresolved:result.purchaseReturns.filter(row => row.returnMatchStatus !== 'matched').length },
    saleReturns:{ total:result.saleReturns.length, unresolved:result.exceptions.filter(row => row.code === 'SALE_RETURN_NOT_ALLOCATED' && row.status === 'unresolved').length },
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
    const current = await activeDataset(db);
    if (current?.datasetId === existing.datasetId) {
      fail('FIFO_DATASET_IMMUTABLE', 'Dataset کامل و فعال immutable است و قابل Resume نیست.', 409);
    }
    await acquireLock(db, existing.datasetId);
    try {
      const state = await db.collection(STATE).findOne({ scopeKey:SCOPE_KEY });
      const activatedAt = new Date();
      const activated = await db.collection(STATE).updateOne(
        { scopeKey:SCOPE_KEY, buildLockOwner:existing.datasetId },
        { $set:{
          activeDatasetId:existing.datasetId,
          previousActiveDatasetId:state?.activeDatasetId || '',
          activatedAt,
          algorithmVersion:existing.algorithmVersion || ALGORITHM_VERSION,
          updatedAt:activatedAt
        } }
      );
      if (!activated.matchedCount) fail('FIFO_ATOMIC_ACTIVATION_FAILED', 'بازیابی فعال‌سازی FIFO Shadow ناموفق بود.', 409);
      await diagnostic(db, existing.datasetId, 'activation-recovered', {
        previousActiveDatasetId:state?.activeDatasetId || '',
        datasetImmutable:true
      });
      return {
        ok:true,
        code:'FIFO_SHADOW_ACTIVATION_RECOVERED',
        datasetId:existing.datasetId,
        status:existing.status,
        activationStatus:'active-shadow-state',
        allocationCount:existing.allocationCount,
        exceptionCount:existing.exceptionCount,
        retryCount:Number(existing.retryCount || 0),
        resumeCount:Number(existing.resumeCount || 0),
        sourceFingerprint:existing.sourceFingerprint,
        allocationFingerprint:existing.allocationFingerprint,
        summary:existing.summary,
        validation:existing.validation,
        performance:existing.performance,
        activationRecovered:true,
        datasetImmutable:true,
        shadowMode:true,
        accountingApproved:false,
        profitActivationAllowed:false
      };
    } finally {
      await releaseLock(db, existing.datasetId);
    }
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
    purchaseDatasetId:existing?.sourcePurchaseDatasetId || clean(options.purchaseDatasetId, 100)
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
        requestedBy:requestedByActor,
        resumeCount:0,
        retryCount:0,
        immutableAfterCompletion:true,
        accountingApproved:false,
        profitActivationAllowed:false,
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
    pinned.saleSnapshotId = source.saleActive.snapshotId;
    pinned.purchaseDatasetId = source.purchaseActive.datasetId;
    const mongoReadMs = Date.now() - readStartedMs;
    await db.collection(DATASETS).updateOne({ datasetId, status:'running' }, { $set:{
      sourceSaleSnapshotId:pinned.saleSnapshotId,
      sourcePurchaseDatasetId:pinned.purchaseDatasetId,
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
      sales:result.sales.map(row => [saleIdentity(row), row.saleDate, round(row.qty), round(row.saleValue, VALUE_SCALE)]),
      purchases:result.officialRows.map(row => [purchaseIdentity(row), row.purchaseInvoiceDate, round(row.netPurchasedQuantity ?? row.remainingQuantity ?? row.originalQuantity), round(row.netUnitCost ?? row.grossUnitCost, VALUE_SCALE)]),
      manuals:[...source.manuals]
        .sort((a,b)=>clean(a.resolutionId).localeCompare(clean(b.resolutionId),'en'))
        .map(row => [row.resolutionId, row.revision, row.status, row.effectiveFrom, row.effectiveTo, round(row.manualCost, VALUE_SCALE)])
    }));
    const allocationFingerprint = sha256(stableStringify(result.allocations.map(immutableProjection)));
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
    const activationStatus = validation.valid ? 'validated-shadow' : 'rejected';
    const finalDoc = {
      status:finalStatus,
      activationStatus,
      completedAt,
      updatedAt:completedAt,
      sourceSaleSnapshotId:pinned.saleSnapshotId,
      sourcePurchaseDatasetId:pinned.purchaseDatasetId,
      sourceFingerprint,
      allocationFingerprint,
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
      profitCalculated:false,
      roiCalculated:false,
      commissionCalculated:false
    };
    const completed = await db.collection(DATASETS).updateOne(
      { datasetId, status:'running', activationStatus:'candidate' },
      { $set:finalDoc }
    );
    if (!completed.matchedCount) fail('FIFO_ATOMIC_COMPLETION_FAILED', 'Candidate FIFO Shadow هم‌زمان تغییر کرده است.', 409);
    if (validation.valid) {
      const activated = await db.collection(STATE).updateOne(
        { scopeKey:SCOPE_KEY, buildLockOwner:datasetId },
        { $set:{
          activeDatasetId:datasetId,
          previousActiveDatasetId:existing?.previousActiveDatasetId || (await activeDataset(db))?.datasetId || '',
          activatedAt:completedAt,
          algorithmVersion:ALGORITHM_VERSION,
          updatedAt:completedAt
        } }
      );
      if (!activated.matchedCount) fail('FIFO_ATOMIC_ACTIVATION_FAILED', 'فعال‌سازی اتمیک FIFO Shadow ناموفق بود.', 409);
    }
    await diagnostic(db, datasetId, 'completed', {
      status:finalStatus,
      activationStatus,
      allocationCount:persistedAllocationCount,
      exceptionCount:persistedExceptionCount,
      sourceFingerprint,
      allocationFingerprint,
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
      allocationCount:persistedAllocationCount,
      exceptionCount:persistedExceptionCount,
      retryCount,
      resumeCount:Number(existing?.resumeCount || 0) + (existing ? 1 : 0),
      sourceFingerprint,
      allocationFingerprint,
      summary,
      validation,
      performance,
      shadowMode:true,
      accountingApproved:false,
      profitActivationAllowed:false
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
  return {
    ok:true,
    activeDatasetId:active?.datasetId || '',
    state:{
      buildLocked:Boolean(state?.buildLockOwner && new Date(state.buildLockExpiresAt || 0) > new Date()),
      buildLockOwner:state?.buildLockOwner || '',
      buildLockExpiresAt:state?.buildLockExpiresAt || null
    },
    dataset:dataset ? { ...dataset, isActive:dataset.datasetId === active?.datasetId } : null,
    shadowMode:true,
    accountingApproved:false
  };
}
async function listAllocations(db, filters = {}) {
  await ensureIndexes(db);
  const active = filters.datasetId ? null : await activeDataset(db);
  const datasetId = clean(filters.datasetId || active?.datasetId, 100);
  if (!datasetId) return { ok:true, datasetId:'', total:0, page:1, pageSize:100, list:[] };
  const query = { datasetId };
  if (filters.saleLineId) query.saleLineId = clean(filters.saleLineId, 500);
  if (filters.invoiceNo) query.saleInvoiceNo = Number(filters.invoiceNo);
  if (filters.itemCode) query.itemCode = clean(filters.itemCode, 100);
  if (filters.sourceType) query.sourceType = clean(filters.sourceType, 100);
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 100), 1000));
  const total = await count(db.collection(ALLOCATIONS), query);
  const list = await db.collection(ALLOCATIONS).find(query)
    .sort({ saleDate:1, saleInvoiceNo:1, saleRow:1, allocationSequence:1 })
    .skip((page - 1) * pageSize).limit(pageSize).toArray();
  return { ok:true, datasetId, total, page, pageSize, list, shadowMode:true, accountingApproved:false };
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
      manualSamples:allocations.filter(row => row.sourceType === 'approved_manual_cost').slice(0, 20),
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
  listExceptions,
  validationReport,
  _allocateSources:allocateSources,
  _reconcile:reconcile,
  _summarize:summarize,
  _loadSources:loadSources,
  _eligibleOfficial:eligibleOfficial,
  _manualEffective:manualEffective,
  _immutableProjection:immutableProjection
};
