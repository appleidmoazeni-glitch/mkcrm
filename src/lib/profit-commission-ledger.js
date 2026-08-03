'use strict';

/*
 * Phase 5.3.0 — Profit Adjustment & Commission Ledger
 *
 * This module owns accounting review facts and workflow records only. It never
 * mutates Sale Snapshot, FIFO allocations/datasets, Purchase Layers, inventory,
 * invoices or Shaygan. Actual FIFO profit is copied once from a validated
 * Shadow FIFO dataset into immutable facts; all human changes are separate,
 * versioned and approval-gated.
 */
const crypto = require('crypto');
const decimal = require('./accounting-decimal');
const fifoShadow = require('./fifo-shadow-engine');
const { canonicalSaleDate } = require('./jalali-date');

const FIFO_FACTS = 'fifoProfitFacts';
const ADJUSTMENTS = 'profitAdjustments';
const SAVED_LEDGER = 'savedProfitLedgerEntries';
const SUPPLIER_LEDGER = 'supplierIncentiveLedgerEntries';
const CATEGORY_MAPPINGS = 'commissionCategoryMappings';
const CATEGORY_APPROVAL_LOCKS = 'commissionCategoryApprovalLocks';
const RATE_VERSIONS = 'commissionRateVersions';
const RATE_APPROVAL_LOCKS = 'commissionRateApprovalLocks';
const DISCOUNT_FACTS = 'invoiceDiscountFacts';
const COMMISSION_RUNS = 'commissionDraftRuns';
const COMMISSION_LINES = 'commissionDraftLines';
const EXPORT_BATCHES = 'accountingExcelExportBatches';
const IMPORT_BATCHES = 'accountingExcelImportBatches';
const IMPORT_ROWS = 'accountingExcelImportRows';
const TIR_RECONSTRUCTION = 'tir1405ReconstructionIssues';

const OWNED_COLLECTIONS = Object.freeze([
  FIFO_FACTS, ADJUSTMENTS, SAVED_LEDGER, SUPPLIER_LEDGER,
  CATEGORY_MAPPINGS, CATEGORY_APPROVAL_LOCKS, RATE_VERSIONS, RATE_APPROVAL_LOCKS, DISCOUNT_FACTS,
  COMMISSION_RUNS, COMMISSION_LINES, EXPORT_BATCHES, IMPORT_BATCHES,
  IMPORT_ROWS, TIR_RECONSTRUCTION
]);
const SCHEMA_VERSION = 1;
const GOVERNANCE_SCHEMA_VERSION = 2;
const MODULE_VERSION = 'profit-commission-ledger-1.1.0';
const ALLOWED_ROLES = Object.freeze(['admin', 'accounting', 'manager']);
const EDIT_ROLES = Object.freeze(['admin', 'accounting']);
const APPROVE_ROLES = Object.freeze(['admin', 'manager']);
const POOLS = Object.freeze(['NOTEBOOK', 'COMPONENT']);
// Reporting Product Categories are the dynamic, official Shaygan Main Groups.
// Rate pools are a separate and deliberately small accounting dimension.
const RATE_POOLS = Object.freeze(['NOTEBOOK', 'COMPONENT', 'CUSTOM', 'NON_COMMISSIONABLE', 'UNRESOLVED']);
const RATE_SCOPES = Object.freeze(['product_category', 'rate_pool']);
// Kept only for historical API/read compatibility. New writes never validate
// official Product Categories against this retired fixed list.
const CATEGORIES = Object.freeze(['NOTEBOOK', 'COMPONENT', 'OTHER', 'SERVICE', 'NON_COMMISSIONABLE', 'UNKNOWN']);
const ADJUSTMENT_TYPES = Object.freeze([
  'saved_profit_credit', 'saved_profit_subsidy', 'invoice_discount',
  'accounting_correction', 'category_correction',
  'seller_mapping_correction', 'management_adjustment'
]);
const ADJUSTMENT_STATUSES = Object.freeze(['draft', 'pending', 'approved', 'rejected', 'expired', 'reversed']);
const SAVED_ENTRY_TYPES = Object.freeze([
  'CREDIT_FROM_REDUCED_COMMISSIONABLE_PROFIT',
  'DEBIT_FOR_LOW_PROFIT_SUBSIDY', 'REVERSAL', 'OPENING_BALANCE',
  'APPROVED_MANAGEMENT_ADJUSTMENT'
]);
const SUPPLIER_INCENTIVE_TYPES = Object.freeze(['DROP', 'REBATE', 'BONUS_PAYMENT']);
const FORMULA_ERRORS = /#(?:VALUE!|NAME\?|REF!|DIV\/0!|N\/A|NUM!|NULL!)/i;
const MAX_IMPORT_ROWS = 5000;

function clean(value, max = 1000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}
function actor(value = {}) {
  return { username:clean(value.username || value.user || 'system', 100), role:clean(value.role || 'system', 50) };
}
function fail(code, message, statusCode = 400, details = {}) {
  const error = new Error(message); error.code = code; error.statusCode = statusCode; Object.assign(error, details); throw error;
}
function requireRole(value, allowed = ALLOWED_ROLES) {
  const current = actor(value);
  if (!allowed.includes(current.role)) fail('PROFIT_LEDGER_FORBIDDEN', 'دسترسی به دفتر تعدیلات سود مجاز نیست.', 403);
  return current;
}
function sha256(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
function deterministicId(prefix, material) { return `${prefix}-${sha256(material).slice(0, 24)}`; }
function newId(prefix) { return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`; }
function exact(value, scale = decimal.MONEY_SCALE) { return decimal.format(decimal.parse(value == null || value === '' ? '0' : value, scale), scale); }
function exactOrNull(value, scale = decimal.MONEY_SCALE) { return value == null || value === '' ? null : exact(value, scale); }
function add(values, scale = decimal.MONEY_SCALE) { return decimal.format(values.reduce((sum, value) => sum + decimal.parse(value || 0, scale), 0n), scale); }
function subtract(left, right, scale = decimal.MONEY_SCALE) { return decimal.format(decimal.parse(left || 0, scale) - decimal.parse(right || 0, scale), scale); }
function compare(left, right, scale = decimal.MONEY_SCALE) {
  const result = decimal.parse(left || 0, scale) - decimal.parse(right || 0, scale);
  return result < 0n ? -1 : result > 0n ? 1 : 0;
}
function multiplyMoneyRate(money, rate) {
  const amount = decimal.parse(money || 0, decimal.MONEY_SCALE);
  const rateScaled = decimal.parse(rate || 0, 8);
  return decimal.format(decimal.multiply(amount, decimal.MONEY_SCALE, rateScaled, 8, decimal.MONEY_SCALE), decimal.MONEY_SCALE);
}
function date8(value, field, optional = false) {
  if (optional && !clean(value)) return '';
  return canonicalSaleDate(value, { field });
}
function audit(action, by, details = {}) {
  return { action:clean(action, 100), by:actor(by), at:new Date(), details:JSON.parse(JSON.stringify(details, (_, value) => typeof value === 'string' ? clean(value, 2000) : value)) };
}
async function count(collection, query = {}) {
  if (typeof collection.countDocuments === 'function') return Number(await collection.countDocuments(query));
  return (await collection.find(query).toArray()).length;
}
async function insertMany(collection, rows) {
  if (!rows.length) return 0;
  if (typeof collection.insertMany === 'function') return Number((await collection.insertMany(rows, { ordered:true })).insertedCount || rows.length);
  for (const row of rows) await collection.insertOne(row);
  return rows.length;
}
function pageRows(rows, filters = {}) {
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 100), 500));
  return { page, pageSize, total:rows.length, list:rows.slice((page - 1) * pageSize, page * pageSize) };
}

async function ensureIndexes(db) {
  const existing = new Set((await db.listCollections().toArray()).map(row => row.name));
  for (const name of OWNED_COLLECTIONS) if (!existing.has(name)) await db.createCollection(name).catch(() => {});
  await db.collection(FIFO_FACTS).createIndex({ factId:1 }, { unique:true });
  await db.collection(FIFO_FACTS).createIndex({ fifoDatasetId:1, saleLineIdentity:1 }, { unique:true });
  await db.collection(FIFO_FACTS).createIndex({ fifoDatasetId:1, sellerIdentity:1, saleDate:1 });
  await db.collection(ADJUSTMENTS).createIndex({ adjustmentId:1 }, { unique:true });
  await db.collection(ADJUSTMENTS).createIndex({ fifoDatasetId:1, saleLineIdentity:1, status:1 });
  await db.collection(SAVED_LEDGER).createIndex({ ledgerEntryId:1 }, { unique:true });
  await db.collection(SAVED_LEDGER).createIndex({ sourceAdjustmentId:1 }, { unique:true, sparse:true });
  await db.collection(SAVED_LEDGER).createIndex({ pool:1, accountingPeriod:1, postedAt:1 });
  await db.collection(SUPPLIER_LEDGER).createIndex({ ledgerEntryId:1 }, { unique:true });
  await db.collection(CATEGORY_MAPPINGS).createIndex({ mappingId:1 }, { unique:true });
  await db.collection(CATEGORY_MAPPINGS).createIndex({ identityType:1, identityValue:1, effectiveFrom:1, effectiveTo:1, status:1 });
  await db.collection(CATEGORY_MAPPINGS).createIndex({ officialProductCategoryIdentity:1, commissionRatePool:1, status:1 });
  await db.collection(CATEGORY_APPROVAL_LOCKS).createIndex({ lockKey:1 }, { unique:true });
  await db.collection(RATE_VERSIONS).createIndex({ rateVersionId:1 }, { unique:true });
  await db.collection(RATE_VERSIONS).createIndex({ sellerIdentity:1, commissionCategory:1, effectiveFrom:1, effectiveTo:1, status:1 });
  await db.collection(RATE_VERSIONS).createIndex({ sellerIdentity:1, rateScope:1, officialProductCategoryIdentity:1, commissionRatePool:1, effectiveFrom:1, effectiveTo:1, status:1 });
  await db.collection(RATE_APPROVAL_LOCKS).createIndex({ lockKey:1 }, { unique:true });
  await db.collection(DISCOUNT_FACTS).createIndex({ discountFactId:1 }, { unique:true });
  await db.collection(DISCOUNT_FACTS).createIndex({ saleSnapshotId:1, saleInvoiceIdentity:1 }, { unique:true });
  await db.collection(COMMISSION_RUNS).createIndex({ commissionRunId:1 }, { unique:true });
  await db.collection(COMMISSION_LINES).createIndex({ commissionRunId:1, saleLineIdentity:1 }, { unique:true });
  await db.collection(EXPORT_BATCHES).createIndex({ exportBatchId:1 }, { unique:true });
  await db.collection(IMPORT_BATCHES).createIndex({ importBatchId:1 }, { unique:true });
  await db.collection(IMPORT_BATCHES).createIndex({ exportBatchId:1, sourceWorkbookHash:1 }, { unique:true });
  await db.collection(IMPORT_ROWS).createIndex({ importBatchId:1, originalExcelRowNumber:1 }, { unique:true });
  await db.collection(TIR_RECONSTRUCTION).createIndex({ issueId:1 }, { unique:true });
  return { ok:true, moduleVersion:MODULE_VERSION, collections:OWNED_COLLECTIONS };
}

function categoryIdentity(row) {
  if (clean(row.itemGuid)) return { identityType:'itemGuid', identityValue:clean(row.itemGuid, 100) };
  if (clean(row.itemCode)) return { identityType:'itemCode', identityValue:clean(row.itemCode, 100) };
  if (clean(row.groupPathIdentity)) return { identityType:'groupPathIdentity', identityValue:clean(row.groupPathIdentity, 500) };
  if (clean(row.groupGuid)) return { identityType:'groupGuid', identityValue:clean(row.groupGuid, 100) };
  if (clean(row.mainGroupCode)) return { identityType:'groupCode', identityValue:clean(row.mainGroupCode, 100) };
  const storedType=clean(row.identityType,100);const storedValue=clean(row.identityValue,500);
  if(['itemGuid','itemCode','groupPathIdentity','groupGuid','groupCode'].includes(storedType)&&storedValue)return{identityType:storedType,identityValue:storedValue};
  fail('CATEGORY_IDENTITY_REQUIRED', 'شناسه کالا یا گروه برای دسته‌بندی الزامی است.');
}
function rangesOverlap(aFrom, aTo, bFrom, bTo) {
  return aFrom <= (bTo || '99999999') && bFrom <= (aTo || '99999999');
}

function compatibilityRatePool(value) {
  const legacy=clean(value,50).toUpperCase();
  if(RATE_POOLS.includes(legacy))return legacy;
  if(legacy==='OTHER'||legacy==='SERVICE')return 'CUSTOM';
  if(legacy==='UNKNOWN')return 'UNRESOLVED';
  return 'UNRESOLVED';
}
function mappingRatePool(row={}) {
  return RATE_POOLS.includes(clean(row.commissionRatePool,50).toUpperCase())
    ? clean(row.commissionRatePool,50).toUpperCase()
    : compatibilityRatePool(row.commissionCategory);
}
function officialProductCategoryFromLine(saleLine={}) {
  const identity=clean(saleLine.officialProductCategoryIdentity||saleLine.resolvedMainGroupIdentity||saleLine.groupPathIdentity,500);
  const guid=clean(saleLine.officialProductCategoryGuid||saleLine.resolvedMainGroupGuid||saleLine.groupGuid,100);
  const number=clean(saleLine.officialProductCategoryNumber||saleLine.resolvedMainGroupNumber||saleLine.mainGroupCode,100);
  const name=clean(saleLine.officialProductCategoryName||saleLine.resolvedMainGroupName,300);
  return {officialProductCategoryIdentity:identity,officialProductCategoryGuid:guid,officialProductCategoryNumber:number,officialProductCategoryName:name||'UNRESOLVED'};
}
function resolveCategoryFromMappings(candidates, saleLine, saleDate) {
  const productCategory=officialProductCategoryFromLine(saleLine);
  const ordered = [
    ['itemGuid', clean(saleLine?.itemGuid, 100)], ['itemCode', clean(saleLine?.itemCode, 100)],
    ['groupPathIdentity', clean(saleLine?.groupPathIdentity, 500)], ['groupGuid', clean(saleLine?.groupGuid, 100)],
    ['groupCode', clean(saleLine?.mainGroupCode, 100)]
  ];
  for (const [identityType, identityValue] of ordered) {
    if (!identityValue) continue;
    const rows = candidates.filter(row => row.identityType === identityType && row.identityValue === identityValue && row.effectiveFrom <= saleDate && (!row.effectiveTo || row.effectiveTo >= saleDate));
    if (rows.length === 1) return { ...productCategory, category:productCategory.officialProductCategoryName, commissionRatePool:mappingRatePool(rows[0]), mappingId:rows[0].mappingId, status:mappingRatePool(rows[0])==='UNRESOLVED'?'unresolved':'resolved', legacyRecord:!rows[0].commissionRatePool };
    if (rows.length > 1) return { ...productCategory, category:productCategory.officialProductCategoryName, commissionRatePool:'UNRESOLVED', mappingId:'', status:'ambiguous' };
  }
  return { ...productCategory, category:productCategory.officialProductCategoryName, commissionRatePool:'UNRESOLVED', mappingId:'', status:'missing' };
}
async function resolveCategory(db, saleLine, saleDate) {
  const candidates = await db.collection(CATEGORY_MAPPINGS).find({ status:'approved' }).toArray();
  return resolveCategoryFromMappings(candidates, saleLine, saleDate);
}

async function materializeFifoProfitFacts(db, input = {}, requestedBy = {}) {
  const current = requireRole(requestedBy, EDIT_ROLES);
  await ensureIndexes(db);
  const active = input.fifoDatasetId
    ? { datasetId:clean(input.fifoDatasetId, 100), dataset:await db.collection(fifoShadow.DATASETS).findOne({ datasetId:clean(input.fifoDatasetId, 100) }) }
    : await fifoShadow.activeDataset(db);
  const dataset = active?.dataset;
  if (!dataset || dataset.status !== 'completed' || dataset.activationStatus !== 'validated-shadow' || dataset.validation?.valid === false) {
    fail('FIFO_FACT_SOURCE_NOT_APPROVED', 'فقط FIFO Shadow کامل و validated-shadow می‌تواند منبع Fact باشد.', 409);
  }
  const existing = await count(db.collection(FIFO_FACTS), { fifoDatasetId:dataset.datasetId });
  if (existing) {
    const facts = await db.collection(FIFO_FACTS).find({ fifoDatasetId:dataset.datasetId }).toArray();
    const fingerprint = sha256(stable(facts.map(factImmutableProjection).sort((a,b)=>a.saleLineIdentity.localeCompare(b.saleLineIdentity))));
    return { ok:true, fifoDatasetId:dataset.datasetId, factCount:facts.length, factsFingerprint:fingerprint, duplicate:true, immutable:true };
  }
  const allocations = await db.collection(fifoShadow.ALLOCATIONS).find({ datasetId:dataset.datasetId }).sort({ globalSequence:1 }).toArray();
  const saleLines = await db.collection('saleSnapshotDatasetLines').find({ snapshotId:dataset.sourceSaleSnapshotId }).toArray();
  const saleHeaders = await db.collection('saleSnapshotDatasetHeaders').find({ snapshotId:dataset.sourceSaleSnapshotId }).toArray();
  const approvedCategoryMappings = await db.collection(CATEGORY_MAPPINGS).find({ status:'approved' }).toArray();
  const governance = require('./accounting-governance');
  const assignmentMaps = await governance._assignmentMaps(db);
  const lineById = new Map(saleLines.map(row => [clean(row.saleLineId, 500), row]));
  const headerByIdentity = new Map(saleHeaders.map(row => [`${Number(row.invTyp)}:${Number(row.invNo)}`, row]));
  const grouped = new Map();
  for (const row of allocations) {
    const key = clean(row.saleLineId, 500);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const now = new Date();
  const facts = [];
  for (const [saleLineIdentity, rows] of grouped) {
    const first = rows[0];
    const saleLine = lineById.get(saleLineIdentity) || {};
    const invoiceIdentity = `${Number(first.saleInvoiceType)}:${Number(first.saleInvoiceNo)}`;
    const header = headerByIdentity.get(invoiceIdentity) || {};
    const sourceLine = { ...saleLine, ...first };
    const enrichedLine = governance.enrichFact(sourceLine, assignmentMaps.byGuid.get(sourceLine.itemGuid)||assignmentMaps.byCode.get(sourceLine.itemCode));
    const category = resolveCategoryFromMappings(approvedCategoryMappings, enrichedLine, clean(first.saleDate, 8));
    const quantityExact = add(rows.map(row => row.quantityExact || row.allocatedQty || row.unknownQty || 0), decimal.QUANTITY_SCALE);
    const saleAmountExact = add(rows.map(row => row.allocatedSaleValueExact || row.allocatedSaleValue || 0));
    const unknown = rows.some(row => row.sourceType === 'unknown_cost' || row.allocatedCostAmountExact == null);
    const knownQuantity = rows.filter(row => row.sourceType !== 'unknown_cost').map(row => row.quantityExact || row.allocatedQty || 0);
    const knownQtyExact = add(knownQuantity, decimal.QUANTITY_SCALE);
    const fifoCostExact = unknown ? null : add(rows.map(row => row.allocatedCostAmountExact || 0));
    const actualFifoProfitExact = fifoCostExact == null ? null : subtract(saleAmountExact, fifoCostExact);
    const originalQuantity = exact(first.soldQuantity || saleLine.qty || quantityExact, decimal.QUANTITY_SCALE);
    const coverage = unknown
      ? (compare(knownQtyExact, '0', decimal.QUANTITY_SCALE) > 0 ? 'partial' : 'unknown')
      : (compare(quantityExact, originalQuantity, decimal.QUANTITY_SCALE) === 0 ? 'complete' : 'partial');
    const officialLineDiscount = saleLine.lineDiscountAmount;
    const invoiceDiscountExact = officialLineDiscount == null ? null : exact(officialLineDiscount);
    const immutable = {
      fifoDatasetId:dataset.datasetId,
      fifoAlgorithmVersion:dataset.algorithmVersion || first.algorithmVersion || '',
      saleSnapshotId:dataset.sourceSaleSnapshotId,
      saleInvoiceIdentity:invoiceIdentity,
      saleInvoiceType:Number(first.saleInvoiceType), saleInvoiceNumber:Number(first.saleInvoiceNo), saleDate:clean(first.saleDate, 8),
      saleLineIdentity,
      sellerIdentity:clean(first.sellerAccountNumber || saleLine.sellerAccountNumber, 100),
      sellerName:clean(first.sellerName || saleLine.sellerName, 200),
      itemGuid:clean(first.itemGuid || saleLine.itemGuid, 100), itemCode:clean(first.itemCode || saleLine.itemCode, 100),
      itemDescription:clean(first.itemDescription || saleLine.itemName, 500),
      officialProductCategoryIdentity:category.officialProductCategoryIdentity,
      officialProductCategoryGuid:category.officialProductCategoryGuid,
      officialProductCategoryNumber:category.officialProductCategoryNumber,
      officialProductCategoryName:category.officialProductCategoryName,
      commissionRatePool:category.commissionRatePool,
      // Historical compatibility alias. Reporting must use the explicit field.
      commissionCategory:category.officialProductCategoryName,
      categoryMappingId:category.mappingId, categoryResolutionStatus:category.status,
      quantityExact, saleAmountExact, invoiceDiscountExact,
      invoiceDiscountAttributionStatus:officialLineDiscount == null && Number(header.discountAmount || 0) > 0 ? 'unresolved-invoice-level' : 'official-line-or-zero',
      fifoCostExact, actualFifoProfitExact, costCoverageStatus:coverage,
      sourceFingerprint:dataset.sourceFingerprint || '', allocationFingerprint:dataset.allocationFingerprint || ''
    };
    facts.push({ factId:deterministicId('PF', `${dataset.datasetId}|${saleLineIdentity}`), schemaVersion:SCHEMA_VERSION, ...immutable, factContentHash:sha256(stable(immutable)), immutable:true, createdBy:current, createdAt:now });
  }
  await insertMany(db.collection(FIFO_FACTS), facts);
  const factsFingerprint = sha256(stable(facts.map(factImmutableProjection).sort((a,b)=>a.saleLineIdentity.localeCompare(b.saleLineIdentity))));
  return { ok:true, fifoDatasetId:dataset.datasetId, factCount:facts.length, factsFingerprint, duplicate:false, immutable:true, unknownCostCount:facts.filter(row=>row.costCoverageStatus!=='complete').length };
}
function factImmutableProjection(row) {
  const copy = { ...row }; delete copy._id; delete copy.createdAt; delete copy.createdBy; return copy;
}
async function listFacts(db, filters = {}) {
  await ensureIndexes(db);
  let rows = await db.collection(FIFO_FACTS).find({}).toArray();
  if (filters.fifoDatasetId) rows = rows.filter(row => row.fifoDatasetId === clean(filters.fifoDatasetId, 100));
  if (filters.sellerIdentity) rows = rows.filter(row => row.sellerIdentity === clean(filters.sellerIdentity, 100));
  // Historical FIFO facts remain byte-for-byte immutable.  The reporting view
  // resolves the official Shaygan hierarchy and the currently approved rate
  // pool at read time so old facts gain the separated dimensions without a
  // FIFO replay or a data migration.
  const governance = require('./accounting-governance');
  const assignmentMaps = await governance._assignmentMaps(db);
  const approvedMappings = await db.collection(CATEGORY_MAPPINGS).find({ status:'approved' }).toArray();
  rows = rows.map(row => {
    const enriched = governance.enrichFact(row, assignmentMaps.byGuid.get(row.itemGuid) || assignmentMaps.byCode.get(row.itemCode));
    const classification = resolveCategoryFromMappings(approvedMappings, enriched, clean(row.saleDate, 8));
    return {
      ...row,
      officialProductCategoryIdentity:classification.officialProductCategoryIdentity,
      officialProductCategoryGuid:classification.officialProductCategoryGuid,
      officialProductCategoryNumber:classification.officialProductCategoryNumber,
      officialProductCategoryName:classification.officialProductCategoryName,
      commissionRatePool:classification.commissionRatePool,
      commissionCategory:classification.officialProductCategoryName,
      categoryMappingId:classification.mappingId || '',
      categoryResolutionStatus:classification.status
    };
  });
  if (filters.category) rows = rows.filter(row => (row.officialProductCategoryName||row.commissionCategory) === clean(filters.category, 300));
  if (filters.ratePool) rows = rows.filter(row => (row.commissionRatePool||compatibilityRatePool(row.commissionCategory)) === clean(filters.ratePool, 50).toUpperCase());
  if (filters.coverage) rows = rows.filter(row => row.costCoverageStatus === clean(filters.coverage, 50));
  if (filters.search) { const q=clean(filters.search).toLowerCase(); rows=rows.filter(row=>[row.saleLineIdentity,row.saleInvoiceIdentity,row.itemCode,row.itemDescription,row.sellerIdentity,row.sellerName].some(value=>clean(value).toLowerCase().includes(q))); }
  rows.sort((a,b)=>clean(a.saleDate).localeCompare(clean(b.saleDate)) || clean(a.saleLineIdentity).localeCompare(clean(b.saleLineIdentity)));
  return { ok:true, ...pageRows(rows, filters), immutable:true, readProjectionOnly:true, underlyingFactsMutated:false, actualFifoProfitEditable:false, unknownCostIsZero:false };
}

function normalizeAdjustment(input = {}) {
  const adjustmentType = clean(input.adjustmentType, 80);
  if (!ADJUSTMENT_TYPES.includes(adjustmentType)) fail('ADJUSTMENT_TYPE_INVALID', 'نوع تعدیل معتبر نیست.');
  const categoryPool = clean(input.categoryPool, 30).toUpperCase();
  if (['saved_profit_credit','saved_profit_subsidy'].includes(adjustmentType) && !POOLS.includes(categoryPool)) fail('ADJUSTMENT_POOL_REQUIRED', 'Pool نوت‌بوک یا کامپوننت الزامی است.');
  const proposedAmountExact = exact(input.proposedAmountExact);
  if (compare(proposedAmountExact, '0') <= 0) fail('ADJUSTMENT_AMOUNT_INVALID', 'مبلغ تعدیل باید مثبت باشد.');
  const effectivePeriod = clean(input.effectivePeriod, 8);
  if (!/^\d{6,8}$/.test(effectivePeriod)) fail('ADJUSTMENT_PERIOD_INVALID', 'دوره مؤثر شمسی معتبر الزامی است.');
  return {
    fifoDatasetId:clean(input.fifoDatasetId, 100), saleInvoiceIdentity:clean(input.saleInvoiceIdentity, 200),
    saleLineIdentity:clean(input.saleLineIdentity, 500), sellerIdentity:clean(input.sellerIdentity, 100),
    categoryPool, adjustmentType, proposedAmountExact,
    reasonCode:clean(input.reasonCode, 100), reasonText:clean(input.reasonText, 2000),
    sourceType:clean(input.sourceType || 'manual_accounting', 100), sourceReference:clean(input.sourceReference, 500),
    evidenceMetadata:input.evidenceMetadata && typeof input.evidenceMetadata === 'object' ? JSON.parse(JSON.stringify(input.evidenceMetadata)) : {},
    effectivePeriod
  };
}
async function createAdjustment(db, input, requestedBy) {
  const current = requireRole(requestedBy, EDIT_ROLES); await ensureIndexes(db);
  const normalized = normalizeAdjustment(input);
  const openingBalance = normalized.adjustmentType === 'management_adjustment' && normalized.sourceType === 'opening_balance';
  if (openingBalance) fail('OPENING_BALANCE_DEDICATED_WORKFLOW_REQUIRED', 'Opening balance فقط از workflow مستقل Saved-Profit Opening Balance قابل ثبت است.', 409);
  const fact = openingBalance ? null : await db.collection(FIFO_FACTS).findOne({ fifoDatasetId:normalized.fifoDatasetId, saleLineIdentity:normalized.saleLineIdentity });
  if (!fact && !openingBalance) fail('ADJUSTMENT_FIFO_FACT_NOT_FOUND', 'Fact غیرقابل‌تغییر FIFO پیدا نشد.', 404);
  if (openingBalance && !POOLS.includes(normalized.categoryPool)) fail('ADJUSTMENT_POOL_REQUIRED', 'Opening balance باید Pool مشخص داشته باشد.');
  if (!normalized.sellerIdentity && fact) normalized.sellerIdentity = fact.sellerIdentity;
  if (!normalized.saleInvoiceIdentity && fact) normalized.saleInvoiceIdentity = fact.saleInvoiceIdentity;
  const now = new Date();
  const row = {
    adjustmentId:newId('PADJ'), schemaVersion:SCHEMA_VERSION, ...normalized,
    approvedAmountExact:null, status:'draft', revision:1,
    createdBy:current, submittedBy:null, approvedBy:null, rejectedBy:null, reversedBy:null,
    auditLog:[audit('draft-created', current, { proposedAmountExact:normalized.proposedAmountExact, adjustmentType:normalized.adjustmentType })],
    deleted:false, createdAt:now, updatedAt:now
  };
  await db.collection(ADJUSTMENTS).insertOne(row);
  return { ok:true, adjustment:row, actualFifoProfitChanged:false, ledgerPosted:false };
}
async function getAdjustment(db, adjustmentId) {
  const row = await db.collection(ADJUSTMENTS).findOne({ adjustmentId:clean(adjustmentId, 100) });
  if (!row) fail('ADJUSTMENT_NOT_FOUND', 'تعدیل پیدا نشد.', 404); return row;
}
async function listAdjustments(db, filters = {}) {
  await ensureIndexes(db); let rows=await db.collection(ADJUSTMENTS).find({}).toArray();
  if(filters.status)rows=rows.filter(row=>row.status===clean(filters.status));
  if(filters.type)rows=rows.filter(row=>row.adjustmentType===clean(filters.type));
  if(filters.pool)rows=rows.filter(row=>row.categoryPool===clean(filters.pool).toUpperCase());
  if(filters.saleLineIdentity)rows=rows.filter(row=>row.saleLineIdentity===clean(filters.saleLineIdentity,500));
  rows.sort((a,b)=>new Date(b.updatedAt||0)-new Date(a.updatedAt||0));
  return {ok:true,...pageRows(rows,filters),physicalDeleteAllowed:false};
}
async function updateAdjustmentDraft(db, adjustmentId, input, requestedBy) {
  const current=requireRole(requestedBy,EDIT_ROLES); const row=await getAdjustment(db,adjustmentId);
  if(!['draft','rejected'].includes(row.status))fail('ADJUSTMENT_IMMUTABLE','فقط draft یا rejected قابل ویرایش است.',409);
  const revision=Number(input.revision); if(revision!==Number(row.revision))fail('ADJUSTMENT_CONFLICT','Revision تغییر کرده است.',409);
  const normalized=normalizeAdjustment({...row,...input});
  const patch={...normalized,status:'draft',revision:revision+1,updatedAt:new Date(),auditLog:[...(row.auditLog||[]),audit('draft-updated',current,{revision})].slice(-300)};
  const result=await db.collection(ADJUSTMENTS).updateOne({adjustmentId:row.adjustmentId,status:row.status,revision},{$set:patch});
  if(!result.matchedCount)fail('ADJUSTMENT_CONFLICT','Revision هم‌زمان تغییر کرده است.',409);
  return {ok:true,adjustment:{...row,...patch},actualFifoProfitChanged:false};
}
async function savedBalance(db, pool, periodTo = '') {
  if(!POOLS.includes(pool))fail('SAVED_POOL_INVALID','Pool معتبر نیست.');
  let rows=await db.collection(SAVED_LEDGER).find({pool}).toArray();
  if(periodTo)rows=rows.filter(row=>row.accountingPeriod<=periodTo);
  const debit=add(rows.map(row=>row.debitAmountExact||'0'));
  const credit=add(rows.map(row=>row.creditAmountExact||'0'));
  return {pool,debitAmountExact:debit,creditAmountExact:credit,balanceExact:subtract(credit,debit),entryCount:rows.length,derived:true};
}
function ledgerEffect(adjustment) {
  if(adjustment.adjustmentType==='saved_profit_credit')return {entryType:'CREDIT_FROM_REDUCED_COMMISSIONABLE_PROFIT',debitAmountExact:'0.00',creditAmountExact:adjustment.approvedAmountExact,sourceSaleLineIdentity:adjustment.saleLineIdentity,beneficiarySaleLineIdentity:''};
  if(adjustment.adjustmentType==='saved_profit_subsidy')return {entryType:'DEBIT_FOR_LOW_PROFIT_SUBSIDY',debitAmountExact:adjustment.approvedAmountExact,creditAmountExact:'0.00',sourceSaleLineIdentity:'',beneficiarySaleLineIdentity:adjustment.saleLineIdentity};
  if(adjustment.adjustmentType==='management_adjustment'&&adjustment.sourceType==='opening_balance')return {entryType:'OPENING_BALANCE',debitAmountExact:'0.00',creditAmountExact:adjustment.approvedAmountExact,sourceSaleLineIdentity:'',beneficiarySaleLineIdentity:''};
  if(adjustment.adjustmentType==='management_adjustment'&&POOLS.includes(adjustment.categoryPool)){
    const direction=clean(adjustment.evidenceMetadata?.ledgerDirection,20).toLowerCase();
    if(direction==='credit')return {entryType:'APPROVED_MANAGEMENT_ADJUSTMENT',debitAmountExact:'0.00',creditAmountExact:adjustment.approvedAmountExact,sourceSaleLineIdentity:adjustment.saleLineIdentity,beneficiarySaleLineIdentity:''};
    if(direction==='debit')return {entryType:'APPROVED_MANAGEMENT_ADJUSTMENT',debitAmountExact:adjustment.approvedAmountExact,creditAmountExact:'0.00',sourceSaleLineIdentity:'',beneficiarySaleLineIdentity:adjustment.saleLineIdentity};
  }
  return null;
}
async function postSavedLedger(db, adjustment, current) {
  const effect=ledgerEffect(adjustment); if(!effect)return null;
  if(!POOLS.includes(adjustment.categoryPool))fail('SAVED_POOL_INVALID','Pool تعدیل معتبر نیست.');
  if(effect.entryType==='DEBIT_FOR_LOW_PROFIT_SUBSIDY'){
    const balance=await savedBalance(db,adjustment.categoryPool,adjustment.effectivePeriod);
    if(compare(balance.balanceExact,effect.debitAmountExact)<0)fail('SAVED_POOL_INSUFFICIENT','مانده ذخیره برای یارانه کافی نیست.',409);
  }
  const row={ledgerEntryId:deterministicId('SPL',adjustment.adjustmentId),schemaVersion:SCHEMA_VERSION,pool:adjustment.categoryPool,...effect,sourceAdjustmentId:adjustment.adjustmentId,accountingPeriod:adjustment.effectivePeriod,description:clean(adjustment.reasonText,1000),createdBy:adjustment.createdBy,approvedBy:current,postedAt:new Date(),reversalOf:'',auditMetadata:{reasonCode:adjustment.reasonCode,sourceReference:adjustment.sourceReference},appendOnly:true};
  row.contentHash=sha256(stable({...row,postedAt:row.postedAt.toISOString()}));
  await db.collection(SAVED_LEDGER).insertOne(row); return row;
}
async function transitionAdjustment(db, adjustmentId, action, input, requestedBy) {
  const current=requireRole(requestedBy,action==='submit'?EDIT_ROLES:APPROVE_ROLES); const row=await getAdjustment(db,adjustmentId);
  const revision=Number(input?.revision); if(revision!==Number(row.revision))fail('ADJUSTMENT_CONFLICT','Revision تغییر کرده است.',409);
  const rules={submit:{from:['draft'],to:'pending'},approve:{from:['pending'],to:'approved'},reject:{from:['pending'],to:'rejected'},expire:{from:['approved'],to:'expired'}};
  const rule=rules[action]; if(!rule||!rule.from.includes(row.status))fail('ADJUSTMENT_TRANSITION_INVALID','انتقال وضعیت مجاز نیست.',409);
  if(action==='approve'&&clean(row.createdBy?.username)===current.username)fail('ADJUSTMENT_SELF_APPROVAL','ایجادکننده نمی‌تواند تعدیل خود را تأیید کند.',403);
  const now=new Date(); const patch={status:rule.to,revision:revision+1,updatedAt:now,auditLog:[...(row.auditLog||[]),audit(action,current,{from:row.status,to:rule.to,reason:clean(input?.reason,1000)})].slice(-300)};
  if(action==='submit')patch.submittedBy=current;
  if(action==='approve'){patch.approvedBy=current;patch.approvedAt=now;patch.approvedAmountExact=exact(input?.approvedAmountExact||row.proposedAmountExact);}
  if(action==='reject'){patch.rejectedBy=current;patch.rejectedAt=now;patch.rejectionReason=clean(input?.reason,1000);}
  if(action==='expire'){patch.expiredBy=current;patch.expiredAt=now;}
  let ledgerEntry=null;
  if(action==='approve')ledgerEntry=await postSavedLedger(db,{...row,...patch},current);
  const result=await db.collection(ADJUSTMENTS).updateOne({adjustmentId:row.adjustmentId,status:row.status,revision},{$set:patch});
  if(!result.matchedCount)fail('ADJUSTMENT_CONFLICT','Revision هم‌زمان تغییر کرده است.',409);
  return {ok:true,adjustment:{...row,...patch},ledgerEntry,actualFifoProfitChanged:false,companyProfitChanged:false,commissionableProfitChanged:action==='approve'};
}
async function reverseAdjustment(db, adjustmentId, input, requestedBy) {
  const current=requireRole(requestedBy,APPROVE_ROLES); const row=await getAdjustment(db,adjustmentId);
  const revision=Number(input?.revision); if(row.status!=='approved')fail('ADJUSTMENT_REVERSAL_INVALID','فقط تعدیل approved قابل reversal است.',409);
  if(revision!==Number(row.revision))fail('ADJUSTMENT_CONFLICT','Revision تغییر کرده است.',409);
  const original=await db.collection(SAVED_LEDGER).findOne({sourceAdjustmentId:row.adjustmentId});
  let reversal=null;
  if(original){
    reversal={...original,_id:undefined,ledgerEntryId:deterministicId('SPLREV',row.adjustmentId),entryType:'REVERSAL',debitAmountExact:original.creditAmountExact,creditAmountExact:original.debitAmountExact,sourceAdjustmentId:`REVERSAL:${row.adjustmentId}`,reversalOf:original.ledgerEntryId,description:clean(input?.reason||`Reversal ${row.adjustmentId}`,1000),createdBy:current,approvedBy:current,postedAt:new Date(),appendOnly:true};
    delete reversal._id; reversal.contentHash=sha256(stable({...reversal,postedAt:reversal.postedAt.toISOString()}));
    if(compare(reversal.debitAmountExact,'0')>0){const balance=await savedBalance(db,row.categoryPool,row.effectivePeriod);if(compare(balance.balanceExact,reversal.debitAmountExact)<0)fail('SAVED_POOL_REVERSAL_INSUFFICIENT','Reversal باعث مانده منفی می‌شود.',409);}
    await db.collection(SAVED_LEDGER).insertOne(reversal);
  }
  const patch={status:'reversed',revision:revision+1,reversedBy:current,reversedAt:new Date(),reversalReason:clean(input?.reason,1000),updatedAt:new Date(),auditLog:[...(row.auditLog||[]),audit('reversed',current,{reason:input?.reason})].slice(-300)};
  await db.collection(ADJUSTMENTS).updateOne({adjustmentId:row.adjustmentId,status:'approved',revision},{$set:patch});
  return {ok:true,adjustment:{...row,...patch},reversalEntry:reversal,actualFifoProfitChanged:false};
}
async function listSavedLedger(db, filters={}){
  await ensureIndexes(db);let rows=await db.collection(SAVED_LEDGER).find({}).toArray();if(filters.pool)rows=rows.filter(row=>row.pool===clean(filters.pool).toUpperCase());rows.sort((a,b)=>new Date(a.postedAt)-new Date(b.postedAt));
  const balances=await Promise.all(POOLS.map(pool=>savedBalance(db,pool,filters.periodTo||'')));return {ok:true,...pageRows(rows,filters),balances,appendOnly:true,crossPoolTransferAllowed:false};
}
async function listSupplierIncentives(db,filters={}){await ensureIndexes(db);let rows=await db.collection(SUPPLIER_LEDGER).find({}).toArray();if(filters.type)rows=rows.filter(row=>row.incentiveType===clean(filters.type));return {ok:true,...pageRows(rows,filters),types:SUPPLIER_INCENTIVE_TYPES,separateFromSavedProfit:true,automaticCommissionApplication:false,appendOnly:true};}

async function acquireApprovalLock(db,collectionName,lockKey,ownerPrefix){
  const owner=`${ownerPrefix}:${crypto.randomBytes(4).toString('hex')}`;const now=new Date();const expiresAt=new Date(now.getTime()+15000);const collection=db.collection(collectionName);const existing=await collection.findOne({lockKey});if(existing?.owner&&new Date(existing.expiresAt||0)>now)fail('APPROVAL_LOCKED','تأیید هم‌زمان دیگری در جریان است.',409);try{const result=await collection.updateOne({lockKey,$or:[{owner:''},{expiresAt:{$lte:now}},{owner}]},{$set:{lockKey,owner,expiresAt,updatedAt:now},$setOnInsert:{createdAt:now}},{upsert:true});if(!(result.matchedCount||result.upsertedCount))fail('APPROVAL_LOCKED','تأیید هم‌زمان دیگری در جریان است.',409);return{collection,lockKey,owner};}catch(error){if(error?.code===11000)fail('APPROVAL_LOCKED','تأیید هم‌زمان دیگری در جریان است.',409);throw error;}
}
async function releaseApprovalLock(lock){if(lock)await lock.collection.updateOne({lockKey:lock.lockKey,owner:lock.owner},{$set:{owner:'',expiresAt:new Date(0),updatedAt:new Date()}}).catch(()=>{});}

async function officialCategoryForMapping(db,input,identity,existing={}){
  const newContract=input.commissionRatePool!=null||input.officialProductCategoryIdentity||input.officialProductCategoryGuid||existing.schemaVersion>=GOVERNANCE_SCHEMA_VERSION;
  if(!newContract)return null;
  const pool=clean(input.commissionRatePool??existing.commissionRatePool,50).toUpperCase();
  if(!RATE_POOLS.includes(pool))fail('RATE_POOL_INVALID','Commission Rate Pool معتبر نیست.');
  const latest=await db.collection('accountingOfficialGroupCatalogRuns').findOne({}, {sort:{fetchedAt:-1}});
  const groups=await db.collection('accountingOfficialItemGroups').find(latest?.catalogRunId?{catalogRunId:latest.catalogRunId}:{}).toArray();
  const assignments=await db.collection('accountingOfficialItemGroupAssignments').find(latest?.catalogRunId?{catalogRunId:latest.catalogRunId}:{}).toArray();
  let official=null;
  if(identity.identityType==='groupPathIdentity'||identity.identityType==='groupGuid'){
    official=groups.find(row=>row.groupIdentity===identity.identityValue||row.resolvedMainGroupIdentity===identity.identityValue||row.sourceGroupGuid===identity.identityValue||row.resolvedMainGroupGuid===identity.identityValue);
  }else if(identity.identityType==='itemGuid'||identity.identityType==='itemCode'){
    official=assignments.find(row=>(identity.identityType==='itemGuid'?row.itemGuid:row.itemCode)===identity.identityValue&&row.isOfficialEvidence);
  }
  if(!official||(!official.resolvedMainGroupIdentity&&!official.groupIdentity))fail('OFFICIAL_PRODUCT_CATEGORY_REQUIRED','Product Category رسمی Main Group شایگان برای Mapping الزامی است.',409);
  const category={
    officialProductCategoryIdentity:clean(official.resolvedMainGroupIdentity||official.groupIdentity,500),
    officialProductCategoryGuid:clean(official.resolvedMainGroupGuid||official.sourceGroupGuid||official.groupGuid,100),
    officialProductCategoryNumber:clean(official.resolvedMainGroupNumber||official.groupNumber,100),
    officialProductCategoryName:clean(official.resolvedMainGroupName||official.groupName,300)
  };
  const supplied={identity:clean(input.officialProductCategoryIdentity||existing.officialProductCategoryIdentity,500),guid:clean(input.officialProductCategoryGuid||existing.officialProductCategoryGuid,100),number:clean(input.officialProductCategoryNumber||existing.officialProductCategoryNumber,100),name:clean(input.officialProductCategoryName||existing.officialProductCategoryName,300)};
  if((supplied.identity&&supplied.identity!==category.officialProductCategoryIdentity)||(supplied.guid&&supplied.guid!==category.officialProductCategoryGuid)||(supplied.number&&supplied.number!==category.officialProductCategoryNumber)||(supplied.name&&supplied.name!==category.officialProductCategoryName))fail('OFFICIAL_PRODUCT_CATEGORY_MISMATCH','Product Category ارسالی با Main Group رسمی شایگان تطابق ندارد.',409);
  return{...category,commissionRatePool:pool,classificationSource:'official-shaygan-main-group'};
}

async function createCategoryMapping(db,input,requestedBy){
  const current=requireRole(requestedBy,EDIT_ROLES);await ensureIndexes(db);const identity=categoryIdentity(input);const classification=await officialCategoryForMapping(db,input,identity);
  const legacyCommissionCategory=classification?classification.commissionRatePool:clean(input.commissionCategory).toUpperCase();if(!classification&&!CATEGORIES.includes(legacyCommissionCategory))fail('CATEGORY_INVALID','دسته کمیسیون legacy معتبر نیست.');
  const effectiveFrom=date8(input.effectiveFrom,'effectiveFrom');const effectiveTo=date8(input.effectiveTo,'effectiveTo',true);if(effectiveTo&&effectiveTo<effectiveFrom)fail('CATEGORY_RANGE_INVALID','بازه دسته‌بندی معتبر نیست.');
  const now=new Date();const row={mappingId:newId('CMAP'),schemaVersion:classification?GOVERNANCE_SCHEMA_VERSION:SCHEMA_VERSION,...identity,...(classification||{}),commissionCategory:legacyCommissionCategory,effectiveFrom,effectiveTo,source:clean(input.source||'accounting-review',200),sourceReference:clean(input.sourceReference,500),reason:clean(input.reason,2000),evidenceMetadata:input.evidenceMetadata&&typeof input.evidenceMetadata==='object'?JSON.parse(JSON.stringify(input.evidenceMetadata)):null,status:'draft',revision:1,createdBy:current,approvedBy:null,auditLog:[audit('mapping-created',current,{officialProductCategoryIdentity:classification?.officialProductCategoryIdentity||'',officialProductCategoryName:classification?.officialProductCategoryName||'',commissionRatePool:classification?.commissionRatePool||compatibilityRatePool(legacyCommissionCategory),legacyCommissionCategory,...identity})],createdAt:now,updatedAt:now,softDeleteOnly:true};await db.collection(CATEGORY_MAPPINGS).insertOne(row);return{ok:true,mapping:row,automaticApproval:false};
}
async function updateCategoryMapping(db,mappingId,input,requestedBy){
  const current=requireRole(requestedBy,EDIT_ROLES);const row=await db.collection(CATEGORY_MAPPINGS).findOne({mappingId:clean(mappingId,100)});if(!row)fail('CATEGORY_MAPPING_NOT_FOUND','Mapping پیدا نشد.',404);if(!['draft','returned'].includes(row.status))fail('CATEGORY_MAPPING_EDIT_INVALID','فقط draft یا returned قابل ویرایش است.',409);if(Number(input.revision)!==Number(row.revision))fail('CATEGORY_MAPPING_CONFLICT','Revision تغییر کرده است.',409);const identity=categoryIdentity(row.schemaVersion>=GOVERNANCE_SCHEMA_VERSION?row:{...row,...input});const classification=await officialCategoryForMapping(db,{...row,...input},identity,row);const commissionCategory=classification?classification.commissionRatePool:clean(input.commissionCategory||row.commissionCategory).toUpperCase();if(!classification&&!CATEGORIES.includes(commissionCategory))fail('CATEGORY_INVALID','دسته کمیسیون legacy معتبر نیست.');const effectiveFrom=date8(input.effectiveFrom||row.effectiveFrom,'effectiveFrom');const effectiveTo=date8(input.effectiveTo??row.effectiveTo,'effectiveTo',true);if(effectiveTo&&effectiveTo<effectiveFrom)fail('CATEGORY_RANGE_INVALID','بازه دسته‌بندی معتبر نیست.');const patch={...identity,...(classification||{}),commissionCategory,effectiveFrom,effectiveTo,source:clean(input.source??row.source,200),sourceReference:clean(input.sourceReference??row.sourceReference,500),reason:clean(input.reason??row.reason,2000),evidenceMetadata:input.evidenceMetadata??row.evidenceMetadata??null,status:'draft',revision:Number(row.revision)+1,updatedAt:new Date(),auditLog:[...(row.auditLog||[]),audit('mapping-updated',current,{reason:input.reason,officialProductCategoryIdentity:classification?.officialProductCategoryIdentity||row.officialProductCategoryIdentity||'',commissionRatePool:classification?.commissionRatePool||compatibilityRatePool(commissionCategory)})].slice(-300)};const result=await db.collection(CATEGORY_MAPPINGS).updateOne({mappingId:row.mappingId,status:row.status,revision:row.revision},{$set:patch});if(!result.matchedCount)fail('CATEGORY_MAPPING_CONFLICT','Revision هم‌زمان تغییر کرده است.',409);return{ok:true,mapping:{...row,...patch}};
}
function mappingEvidence(row,input={}){const reason=clean(input.reason||row.reason,2000);const sourceReference=clean(input.sourceReference||row.sourceReference,500);const evidenceMetadata=input.evidenceMetadata||row.evidenceMetadata;const evidenceUnavailableReason=clean(input.evidenceUnavailableReason||evidenceMetadata?.evidenceUnavailableReason,1000);if(!reason||!sourceReference||(!evidenceMetadata&&!evidenceUnavailableReason))fail('CATEGORY_MAPPING_EVIDENCE_REQUIRED','دلیل، مرجع منبع و evidence یا دلیل نبود آن الزامی است.');return{reason,sourceReference,evidenceMetadata:evidenceMetadata||null,evidenceUnavailableReason};}
async function transitionCategoryMapping(db,mappingId,action,input={},requestedBy={}){
  const current=requireRole(requestedBy,['approve','reject','return'].includes(action)?APPROVE_ROLES:EDIT_ROLES);const row=await db.collection(CATEGORY_MAPPINGS).findOne({mappingId:clean(mappingId,100)});if(!row)fail('CATEGORY_MAPPING_NOT_FOUND','Mapping پیدا نشد.',404);if(Number(input.revision)!==Number(row.revision))fail('CATEGORY_MAPPING_CONFLICT','Revision تغییر کرده است.',409);const rules={submit:{from:['draft','returned'],to:'pending'},cancel:{from:['draft','returned'],to:'cancelled'},approve:{from:['pending'],to:'approved'},reject:{from:['pending'],to:'rejected'},return:{from:['pending'],to:'returned'}};const rule=rules[action];if(!rule||!rule.from.includes(row.status))fail('CATEGORY_MAPPING_STATUS_INVALID','انتقال وضعیت Mapping مجاز نیست.',409);if(action==='approve'&&row.createdBy?.username===current.username)fail('CATEGORY_MAPPING_SELF_APPROVAL','تفکیک نقش نقض شده است.',403);const ev=['submit','approve','reject','return'].includes(action)?mappingEvidence(row,input):null;let lock=null;try{if(action==='approve'){lock=await acquireApprovalLock(db,CATEGORY_APPROVAL_LOCKS,`${row.identityType}|${row.identityValue}`,row.mappingId);const overlaps=(await db.collection(CATEGORY_MAPPINGS).find({status:'approved',identityType:row.identityType,identityValue:row.identityValue}).toArray()).some(other=>other.mappingId!==row.mappingId&&rangesOverlap(row.effectiveFrom,row.effectiveTo,other.effectiveFrom,other.effectiveTo));if(overlaps)fail('CATEGORY_MAPPING_OVERLAP','Mapping approved هم‌پوشان وجود دارد.',409);}const now=new Date();const patch={status:rule.to,revision:Number(row.revision)+1,updatedAt:now,auditLog:[...(row.auditLog||[]),audit(`mapping-${action}`,current,{reason:ev?.reason,sourceReference:ev?.sourceReference})].slice(-300)};if(action==='approve')Object.assign(patch,{approvedBy:current,approvedAt:now,approvalReason:ev.reason,approvalEvidenceReference:ev.sourceReference});if(action==='submit')patch.submittedBy=current;if(action==='reject')patch.rejectedBy=current;if(action==='return')patch.returnedBy=current;const result=await db.collection(CATEGORY_MAPPINGS).updateOne({mappingId:row.mappingId,status:row.status,revision:row.revision},{$set:patch});if(!result.matchedCount)fail('CATEGORY_MAPPING_CONFLICT','Revision هم‌زمان تغییر کرده است.',409);return{ok:true,mapping:{...row,...patch},automaticApproval:false,approvalSerialized:action==='approve'};}finally{await releaseApprovalLock(lock);}
}
async function approveCategoryMapping(db,mappingId,input,requestedBy){return transitionCategoryMapping(db,mappingId,'approve',input,requestedBy);}
async function listCategoryMappings(db,filters={}){await ensureIndexes(db);let rows=await db.collection(CATEGORY_MAPPINGS).find({}).toArray();if(filters.status)rows=rows.filter(row=>row.status===clean(filters.status));rows=rows.map(row=>({...row,commissionRatePool:mappingRatePool(row),legacyCompatibility:!row.officialProductCategoryIdentity,legacyCommissionCategory:row.commissionCategory||''}));return{ok:true,...pageRows(rows,filters),ratePools:RATE_POOLS,productCategoriesDynamic:true,historicalRecordsPreserved:true,legacyCategories:CATEGORIES};}

function storedRateScope(row={}){
  if(RATE_SCOPES.includes(row.rateScope))return row.rateScope;
  const legacy=clean(row.commissionCategory,300).toUpperCase();
  return RATE_POOLS.includes(legacy)||CATEGORIES.includes(legacy)?'rate_pool':'product_category';
}
function normalizedStoredRate(row={}){
  const rateScope=storedRateScope(row);
  return{...row,rateScope,commissionRatePool:rateScope==='rate_pool'?(RATE_POOLS.includes(clean(row.commissionRatePool,50).toUpperCase())?clean(row.commissionRatePool,50).toUpperCase():compatibilityRatePool(row.commissionCategory)):'',officialProductCategoryIdentity:clean(row.officialProductCategoryIdentity,500),officialProductCategoryName:clean(row.officialProductCategoryName||(rateScope==='product_category'?row.commissionCategory:''),300),legacyCompatibility:!row.rateScope};
}
async function rateScopeForInput(db,input={},existing={}){
  const requested=clean(input.rateScope||existing.rateScope,50).toLowerCase();
  let rateScope=RATE_SCOPES.includes(requested)?requested:'';
  if(!rateScope&&clean(input.officialProductCategoryIdentity||existing.officialProductCategoryIdentity))rateScope='product_category';
  if(!rateScope&&clean(input.commissionRatePool||existing.commissionRatePool))rateScope='rate_pool';
  if(!rateScope){const legacy=clean(input.commissionCategory||existing.commissionCategory,300).toUpperCase();rateScope=RATE_POOLS.includes(legacy)||CATEGORIES.includes(legacy)?'rate_pool':'product_category';}
  if(rateScope==='rate_pool'){
    const pool=clean(input.commissionRatePool||existing.commissionRatePool||input.commissionCategory||existing.commissionCategory,50).toUpperCase();
    const normalized=RATE_POOLS.includes(pool)?pool:compatibilityRatePool(pool);
    if(!RATE_POOLS.includes(normalized)||normalized==='UNRESOLVED')fail('RATE_POOL_INVALID','Rate Pool نرخ باید مقدار resolved معتبر داشته باشد.');
    return{rateScope,commissionRatePool:normalized,officialProductCategoryIdentity:'',officialProductCategoryGuid:'',officialProductCategoryNumber:'',officialProductCategoryName:'',commissionCategory:normalized};
  }
  const identity=clean(input.officialProductCategoryIdentity||existing.officialProductCategoryIdentity,500),name=clean(input.officialProductCategoryName||existing.officialProductCategoryName||input.commissionCategory||existing.commissionCategory,300);
  if(!identity||!name)fail('RATE_PRODUCT_CATEGORY_REQUIRED','هویت و نام Product Category رسمی برای نرخ category الزامی است.');
  const latest=await db.collection('accountingOfficialGroupCatalogRuns').findOne({}, {sort:{fetchedAt:-1}});const groups=await db.collection('accountingOfficialItemGroups').find(latest?.catalogRunId?{catalogRunId:latest.catalogRunId}:{}).toArray();const official=groups.find(row=>(row.resolvedMainGroupIdentity||row.groupIdentity)===identity);
  if(!official)fail('RATE_PRODUCT_CATEGORY_NOT_OFFICIAL','Product Category نرخ در Main Groupهای رسمی شایگان پیدا نشد.',409);
  const category={officialProductCategoryIdentity:clean(official.resolvedMainGroupIdentity||official.groupIdentity,500),officialProductCategoryGuid:clean(official.resolvedMainGroupGuid||official.sourceGroupGuid,100),officialProductCategoryNumber:clean(official.resolvedMainGroupNumber||official.groupNumber,100),officialProductCategoryName:clean(official.resolvedMainGroupName||official.groupName,300)};
  if(category.officialProductCategoryName!==name)fail('RATE_PRODUCT_CATEGORY_MISMATCH','نام Product Category نرخ با شایگان تطابق ندارد.',409);
  return{rateScope,commissionRatePool:'',...category,commissionCategory:category.officialProductCategoryName};
}
async function createRateVersion(db,input,requestedBy){
  const current=requireRole(requestedBy,EDIT_ROLES);await ensureIndexes(db);const scope=await rateScopeForInput(db,input);if(input.rate==null||clean(input.rate)==='')fail('RATE_REQUIRED','نرخ خالی با صفر یکسان نیست.');const rate=exact(input.rate,8);if(compare(rate,'0',8)<0||compare(rate,'1',8)>0)fail('RATE_INVALID','نرخ باید بین صفر و یک باشد.');const effectiveFrom=date8(input.effectiveFrom,'effectiveFrom');const effectiveTo=date8(input.effectiveTo,'effectiveTo',true);if(effectiveTo&&effectiveTo<effectiveFrom)fail('RATE_RANGE_INVALID','بازه نرخ معتبر نیست.');
  const now=new Date();const row={rateVersionId:newId('CRATE'),schemaVersion:GOVERNANCE_SCHEMA_VERSION,sellerIdentity:clean(input.sellerIdentity,100)||'*',...scope,effectiveFrom,effectiveTo,rate,contractType:clean(input.contractType||'candidate',100),sourceDocumentType:clean(input.sourceDocumentType,100),sourceReference:clean(input.sourceReference,500),reason:clean(input.reason,2000),evidenceMetadata:input.evidenceMetadata&&typeof input.evidenceMetadata==='object'?JSON.parse(JSON.stringify(input.evidenceMetadata)):null,status:'draft',revision:1,createdBy:current,approvedBy:null,auditLog:[audit('rate-created',current,{rate,rateScope:scope.rateScope,officialProductCategoryIdentity:scope.officialProductCategoryIdentity,commissionRatePool:scope.commissionRatePool,effectiveFrom,effectiveTo})],createdAt:now,updatedAt:now,softDeleteOnly:true};await db.collection(RATE_VERSIONS).insertOne(row);return{ok:true,rateVersion:row,automaticApproval:false};
}
async function updateRateVersion(db,rateVersionId,input,requestedBy){const current=requireRole(requestedBy,EDIT_ROLES);const row=await db.collection(RATE_VERSIONS).findOne({rateVersionId:clean(rateVersionId,100)});if(!row)fail('RATE_NOT_FOUND','Rate version پیدا نشد.',404);if(!['draft','returned'].includes(row.status))fail('RATE_EDIT_INVALID','فقط draft یا returned قابل ویرایش است.',409);if(Number(input.revision)!==Number(row.revision))fail('RATE_CONFLICT','Revision تغییر کرده است.',409);const scope=await rateScopeForInput(db,{...row,...input},row),rate=input.rate==null?row.rate:exact(input.rate,8);if(compare(rate,'0',8)<0||compare(rate,'1',8)>0)fail('RATE_INVALID','نرخ باید بین صفر و یک باشد.');const effectiveFrom=date8(input.effectiveFrom||row.effectiveFrom,'effectiveFrom');const effectiveTo=date8(input.effectiveTo??row.effectiveTo,'effectiveTo',true);if(effectiveTo&&effectiveTo<effectiveFrom)fail('RATE_RANGE_INVALID','بازه نرخ معتبر نیست.');const patch={sellerIdentity:clean(input.sellerIdentity??row.sellerIdentity,100)||'*',...scope,rate,effectiveFrom,effectiveTo,contractType:clean(input.contractType??row.contractType,100),sourceDocumentType:clean(input.sourceDocumentType??row.sourceDocumentType,100),sourceReference:clean(input.sourceReference??row.sourceReference,500),reason:clean(input.reason??row.reason,2000),evidenceMetadata:input.evidenceMetadata??row.evidenceMetadata??null,status:'draft',revision:Number(row.revision)+1,updatedAt:new Date(),auditLog:[...(row.auditLog||[]),audit('rate-updated',current,{reason:input.reason,rateScope:scope.rateScope,officialProductCategoryIdentity:scope.officialProductCategoryIdentity,commissionRatePool:scope.commissionRatePool})].slice(-300)};const result=await db.collection(RATE_VERSIONS).updateOne({rateVersionId:row.rateVersionId,status:row.status,revision:row.revision},{$set:patch});if(!result.matchedCount)fail('RATE_CONFLICT','Revision هم‌زمان تغییر کرده است.',409);return{ok:true,rateVersion:{...row,...patch}};}
function rateEvidence(row,input={}){const reason=clean(input.reason||row.reason,2000);const sourceReference=clean(input.sourceReference||row.sourceReference,500);const evidenceMetadata=input.evidenceMetadata||row.evidenceMetadata;const evidenceUnavailableReason=clean(input.evidenceUnavailableReason||evidenceMetadata?.evidenceUnavailableReason,1000);if(!reason||!sourceReference||(!evidenceMetadata&&!evidenceUnavailableReason))fail('RATE_EVIDENCE_REQUIRED','دلیل، مرجع منبع و evidence یا دلیل نبود آن الزامی است.');return{reason,sourceReference,evidenceMetadata:evidenceMetadata||null,evidenceUnavailableReason};}
async function transitionRateVersion(db,rateVersionId,action,input={},requestedBy={}){
  const current=requireRole(requestedBy,['approve','reject','return'].includes(action)?APPROVE_ROLES:EDIT_ROLES);await ensureIndexes(db);const row=await db.collection(RATE_VERSIONS).findOne({rateVersionId:clean(rateVersionId,100)});if(!row)fail('RATE_NOT_FOUND','Rate version پیدا نشد.',404);if(Number(input.revision)!==Number(row.revision))fail('RATE_CONFLICT','Revision تغییر کرده است.',409);const rules={submit:{from:['draft','returned'],to:'pending'},cancel:{from:['draft','returned'],to:'cancelled'},approve:{from:['pending'],to:'approved'},reject:{from:['pending'],to:'rejected'},return:{from:['pending'],to:'returned'}};const rule=rules[action];if(!rule||!rule.from.includes(row.status))fail('RATE_STATUS_INVALID','انتقال وضعیت Rate مجاز نیست.',409);if(action==='approve'&&row.createdBy?.username===current.username)fail('RATE_SELF_APPROVAL','تفکیک نقش نقض شده است.',403);const ev=['submit','approve','reject','return'].includes(action)?rateEvidence(row,input):null;if(action!=='approve'){const patch={status:rule.to,revision:Number(row.revision)+1,updatedAt:new Date(),auditLog:[...(row.auditLog||[]),audit(`rate-${action}`,current,{reason:ev?.reason,sourceReference:ev?.sourceReference})].slice(-300)};if(action==='submit')patch.submittedBy=current;if(action==='reject')patch.rejectedBy=current;if(action==='return')patch.returnedBy=current;const result=await db.collection(RATE_VERSIONS).updateOne({rateVersionId:row.rateVersionId,status:row.status,revision:row.revision},{$set:patch});if(!result.matchedCount)fail('RATE_CONFLICT','Revision هم‌زمان تغییر کرده است.',409);return{ok:true,rateVersion:{...row,...patch},automaticApproval:false};}
  const normalized=normalizedStoredRate(row);const scopeIdentity=normalized.rateScope==='product_category'?normalized.officialProductCategoryIdentity:normalized.commissionRatePool;const lockKey=`${row.sellerIdentity}|${normalized.rateScope}|${scopeIdentity}`;const lockOwner=`${row.rateVersionId}:${crypto.randomBytes(4).toString('hex')}`;const now=new Date();const expiresAt=new Date(now.getTime()+15000);let acquired=false;
  try{
    const currentLock=await db.collection(RATE_APPROVAL_LOCKS).findOne({lockKey});if(currentLock?.owner&&new Date(currentLock.expiresAt||0)>now)fail('RATE_APPROVAL_LOCKED','تأیید نرخ دیگری هم‌زمان در جریان است.',409);
    const lockResult=await db.collection(RATE_APPROVAL_LOCKS).updateOne({lockKey,$or:[{owner:''},{expiresAt:{$lte:now}},{owner:lockOwner}]},{$set:{lockKey,owner:lockOwner,expiresAt,updatedAt:now},$setOnInsert:{createdAt:now}},{upsert:true});acquired=Boolean(lockResult.matchedCount||lockResult.upsertedCount);if(!acquired)fail('RATE_APPROVAL_LOCKED','تأیید نرخ دیگری هم‌زمان در جریان است.',409);
    const rows=await db.collection(RATE_VERSIONS).find({status:'approved',sellerIdentity:row.sellerIdentity}).toArray();if(rows.map(normalizedStoredRate).some(other=>other.rateVersionId!==row.rateVersionId&&other.rateScope===normalized.rateScope&&(normalized.rateScope==='product_category'?other.officialProductCategoryIdentity===normalized.officialProductCategoryIdentity:other.commissionRatePool===normalized.commissionRatePool)&&rangesOverlap(row.effectiveFrom,row.effectiveTo,other.effectiveFrom,other.effectiveTo)))fail('RATE_APPROVED_OVERLAP','نرخ approved هم‌پوشان در همان scope وجود دارد.',409);
    const patch={status:'approved',revision:Number(row.revision)+1,approvedBy:current,approvedAt:new Date(),approvalReason:ev.reason,approvalEvidenceReference:ev.sourceReference,updatedAt:new Date(),auditLog:[...(row.auditLog||[]),audit('rate-approved',current,{reason:ev.reason,sourceReference:ev.sourceReference})]};const updated=await db.collection(RATE_VERSIONS).updateOne({rateVersionId:row.rateVersionId,status:row.status,revision:row.revision},{$set:patch});if(!updated.matchedCount)fail('RATE_APPROVAL_CONFLICT','Rate version هم‌زمان تغییر کرده است.',409);return{ok:true,rateVersion:{...row,...patch},approvalSerialized:true};
  }catch(error){if(error?.code===11000)fail('RATE_APPROVAL_LOCKED','تأیید نرخ دیگری هم‌زمان در جریان است.',409);throw error;}
  finally{if(acquired)await db.collection(RATE_APPROVAL_LOCKS).updateOne({lockKey,owner:lockOwner},{$set:{owner:'',expiresAt:new Date(0),updatedAt:new Date()}}).catch(()=>{});}
}
async function approveRateVersion(db,rateVersionId,input,requestedBy){return transitionRateVersion(db,rateVersionId,'approve',input,requestedBy);}
function resolveRateFromRows(rows,sellerIdentity,classification,saleDate){
  const value=typeof classification==='string'?{officialProductCategoryName:classification,officialProductCategoryIdentity:'',commissionRatePool:RATE_POOLS.includes(classification)?classification:compatibilityRatePool(classification)}:classification||{};
  const categoryIdentity=clean(value.officialProductCategoryIdentity,500),categoryName=clean(value.officialProductCategoryName||value.category,300),pool=clean(value.commissionRatePool,50).toUpperCase();
  const eligible=rows.map(normalizedStoredRate).filter(row=>row.effectiveFrom<=saleDate&&(!row.effectiveTo||row.effectiveTo>=saleDate));
  const categoryMatch=row=>row.rateScope==='product_category'&&((categoryIdentity&&row.officialProductCategoryIdentity===categoryIdentity)||(!categoryIdentity&&categoryName&&row.officialProductCategoryName===categoryName));
  const poolMatch=row=>row.rateScope==='rate_pool'&&pool&&row.commissionRatePool===pool;
  const levels=[
    {precedence:'seller/category',test:row=>row.sellerIdentity===sellerIdentity&&categoryMatch(row)},
    {precedence:'seller/rate-pool',test:row=>row.sellerIdentity===sellerIdentity&&poolMatch(row)},
    {precedence:'category-default',test:row=>row.sellerIdentity==='*'&&categoryMatch(row)},
    {precedence:'rate-pool-default',test:row=>row.sellerIdentity==='*'&&poolMatch(row)}
  ];
  for(const level of levels){const matches=eligible.filter(level.test);if(matches.length===1)return{status:'resolved',rateVersion:matches[0],appliedRateVersionId:matches[0].rateVersionId,appliedRateScope:matches[0].rateScope,precedence:level.precedence};if(matches.length>1)return{status:'ambiguous',rateVersion:null,appliedRateVersionId:'',appliedRateScope:'',precedence:level.precedence};}
  return{status:'missing',rateVersion:null,appliedRateVersionId:'',appliedRateScope:'',precedence:''};
}
async function resolveRate(db,sellerIdentity,classification,saleDate){const rows=await db.collection(RATE_VERSIONS).find({status:'approved'}).toArray();return resolveRateFromRows(rows,sellerIdentity,classification,saleDate);}
async function listRateVersions(db,filters={}){await ensureIndexes(db);let rows=await db.collection(RATE_VERSIONS).find({}).toArray();if(filters.status)rows=rows.filter(row=>row.status===clean(filters.status));if(filters.sellerIdentity)rows=rows.filter(row=>row.sellerIdentity===clean(filters.sellerIdentity));rows=rows.map(normalizedStoredRate);return{ok:true,...pageRows(rows,filters),rateScopes:RATE_SCOPES,ratePools:RATE_POOLS,precedence:['seller/category','seller/rate-pool','category-default','rate-pool-default'],historicalVersionPinned:true,historicalRecordsPreserved:true,missingRateIsZero:false};}
async function seedTirRateCandidates(db,requestedBy){const current=requireRole(requestedBy,EDIT_ROLES);const seeds=[{sellerIdentity:'*',rateScope:'rate_pool',commissionRatePool:'NOTEBOOK',rate:'0.14000000'},{sellerIdentity:'*',rateScope:'rate_pool',commissionRatePool:'COMPONENT',rate:'0.20000000'}];const created=[];for(const seed of seeds){const existing=(await db.collection(RATE_VERSIONS).find({sellerIdentity:seed.sellerIdentity,effectiveFrom:'14050401',effectiveTo:'14050431',sourceReference:'TIR-1405-WORKBOOK-EVIDENCE'}).toArray()).map(normalizedStoredRate).find(row=>row.rateScope==='rate_pool'&&row.commissionRatePool===seed.commissionRatePool);if(existing){created.push(existing);continue;}const draft=(await createRateVersion(db,{...seed,effectiveFrom:'14050401',effectiveTo:'14050431',contractType:'tir-workbook-candidate',sourceDocumentType:'Tir 1405 analyzed workbook',sourceReference:'TIR-1405-WORKBOOK-EVIDENCE',reason:'Workbook-derived Rate Pool candidate; human approval required.',evidenceMetadata:{candidateOnly:true}},current)).rateVersion;const pending=(await transitionRateVersion(db,draft.rateVersionId,'submit',{revision:draft.revision,reason:draft.reason,sourceReference:draft.sourceReference,evidenceMetadata:draft.evidenceMetadata},current)).rateVersion;created.push(pending);}return{ok:true,list:created,approved:0,evidenceOnly:true};}

async function extractInvoiceDiscountFacts(db,input={},requestedBy={}){
  const current=requireRole(requestedBy,EDIT_ROLES);await ensureIndexes(db);const snapshotId=clean(input.saleSnapshotId,100)||(await fifoShadow.activeDataset(db))?.dataset?.sourceSaleSnapshotId;if(!snapshotId)fail('DISCOUNT_SNAPSHOT_REQUIRED','Sale Snapshot معتبر لازم است.',409);
  const headers=await db.collection('saleSnapshotDatasetHeaders').find({snapshotId}).toArray();const lines=await db.collection('saleSnapshotDatasetLines').find({snapshotId}).toArray();const approvedCategoryMappings=await db.collection(CATEGORY_MAPPINGS).find({status:'approved'}).toArray();const governance=require('./accounting-governance');const assignmentMaps=await governance._assignmentMaps(db);const existingIds=new Set((await db.collection(DISCOUNT_FACTS).find({saleSnapshotId:snapshotId}).toArray()).map(row=>row.discountFactId));const linesByInvoice=new Map();for(const line of lines){const key=`${Number(line.saleInvoiceType)}:${Number(line.saleInvoiceNo)}`;if(!linesByInvoice.has(key))linesByInvoice.set(key,[]);linesByInvoice.get(key).push(line);}const pending=[];
  for(const header of headers.filter(row=>Number(row.invTyp)===2)){
    const invoiceIdentity=`${Number(header.invTyp)}:${Number(header.invNo)}`;const invoiceLines=linesByInvoice.get(invoiceIdentity)||[];const categories=new Set();for(const line of invoiceLines){const enriched=governance.enrichFact(line,assignmentMaps.byGuid.get(line.itemGuid)||assignmentMaps.byCode.get(line.itemCode));categories.add(resolveCategoryFromMappings(approvedCategoryMappings,enriched,clean(line.saleDate,8)).officialProductCategoryName);}const unresolved=Number(header.discountAmount||0)>0&&(categories.size!==1||categories.has('UNRESOLVED'));const immutable={saleSnapshotId:snapshotId,saleInvoiceIdentity:invoiceIdentity,sellerIdentity:clean(header.sellerAccountNumber,100),invoiceDiscountExact:header.discountAmount==null?null:exact(header.discountAmount),sourceField:header.discountAmount==null?'missing':'DiscAmount/DiscountAmount',officialProductCategories:[...categories].sort(),commissionCategories:[...categories].sort(),categoryAttributionStatus:Number(header.discountAmount||0)===0?'not-applicable':(unresolved?'unresolved-multi-category':'resolved-single-category')};const row={discountFactId:deterministicId('IDF',`${snapshotId}|${invoiceIdentity}`),schemaVersion:SCHEMA_VERSION,...immutable,contentHash:sha256(stable(immutable)),immutable:true,createdBy:current,createdAt:new Date()};if(!existingIds.has(row.discountFactId)){existingIds.add(row.discountFactId);pending.push(row);}}
  const created=await insertMany(db.collection(DISCOUNT_FACTS),pending);return{ok:true,saleSnapshotId:snapshotId,total:await count(db.collection(DISCOUNT_FACTS),{saleSnapshotId:snapshotId}),created,source:'official-sale-snapshot-header-discount',shayganWriteCount:0};
}
async function listDiscountFacts(db,filters={}){await ensureIndexes(db);let rows=await db.collection(DISCOUNT_FACTS).find({}).toArray();if(filters.saleSnapshotId)rows=rows.filter(row=>row.saleSnapshotId===clean(filters.saleSnapshotId));if(filters.status)rows=rows.filter(row=>row.categoryAttributionStatus===clean(filters.status));return{ok:true,...pageRows(rows,filters),manualWorkbookAggregateAuthoritative:false};}

function adjustmentEffect(row){const amount=row.approvedAmountExact||'0.00';if(row.adjustmentType==='saved_profit_credit'||row.adjustmentType==='invoice_discount')return decimal.parse(amount,decimal.MONEY_SCALE)*-1n;if(['saved_profit_subsidy','accounting_correction','management_adjustment'].includes(row.adjustmentType))return decimal.parse(amount,decimal.MONEY_SCALE);return 0n;}
async function calculateDraftCommission(db,input={},requestedBy={}){
  const current=requireRole(requestedBy,EDIT_ROLES);await ensureIndexes(db);const fifoDatasetId=clean(input.fifoDatasetId,100)||(await fifoShadow.activeDataset(db))?.datasetId;if(!fifoDatasetId)fail('COMMISSION_FIFO_REQUIRED','FIFO dataset لازم است.',409);const periodFrom=date8(input.periodFrom,'periodFrom');const periodTo=date8(input.periodTo,'periodTo');if(periodTo<periodFrom)fail('COMMISSION_PERIOD_INVALID','بازه کمیسیون معتبر نیست.');
  const facts=(await db.collection(FIFO_FACTS).find({fifoDatasetId}).toArray()).filter(row=>row.saleDate>=periodFrom&&row.saleDate<=periodTo);const approved=await db.collection(ADJUSTMENTS).find({fifoDatasetId,status:'approved'}).toArray();const approvedByLine=new Map();for(const row of approved){if(!approvedByLine.has(row.saleLineIdentity))approvedByLine.set(row.saleLineIdentity,[]);approvedByLine.get(row.saleLineIdentity).push(row);}const approvedCategoryMappings=await db.collection(CATEGORY_MAPPINGS).find({status:'approved'}).toArray();const approvedRates=await db.collection(RATE_VERSIONS).find({status:'approved'}).toArray();const governance=require('./accounting-governance');const assignmentMaps=await governance._assignmentMaps(db);const runId=newId('CDRAFT');const lines=[];
  for(const fact of facts){const enriched=governance.enrichFact(fact,assignmentMaps.byGuid.get(fact.itemGuid)||assignmentMaps.byCode.get(fact.itemCode));const applicable=approvedByLine.get(fact.saleLineIdentity)||[];const classification=resolveCategoryFromMappings(approvedCategoryMappings,enriched,fact.saleDate);let unavailableReason='';if(fact.costCoverageStatus!=='complete'||fact.actualFifoProfitExact==null)unavailableReason='unknown-or-partial-cost';if(!classification.officialProductCategoryIdentity)unavailableReason=unavailableReason||'unresolved-product-category';if(classification.status!=='resolved'||classification.commissionRatePool==='UNRESOLVED')unavailableReason=unavailableReason||'unresolved-rate-pool';if(fact.invoiceDiscountAttributionStatus==='unresolved-invoice-level')unavailableReason=unavailableReason||'unresolved-invoice-discount';const rate=resolveRateFromRows(approvedRates,fact.sellerIdentity,classification,fact.saleDate);if(rate.status!=='resolved')unavailableReason=unavailableReason||`rate-${rate.status}`;const effect=applicable.reduce((sum,row)=>sum+adjustmentEffect(row),0n);const commissionable=fact.actualFifoProfitExact==null?null:decimal.format(decimal.parse(fact.actualFifoProfitExact,decimal.MONEY_SCALE)+effect,decimal.MONEY_SCALE);const draft=unavailableReason||commissionable==null?null:multiplyMoneyRate(commissionable,rate.rateVersion.rate);lines.push({commissionLineId:deterministicId('CDL',`${runId}|${fact.saleLineIdentity}`),commissionRunId:runId,fifoDatasetId,saleLineIdentity:fact.saleLineIdentity,saleInvoiceIdentity:fact.saleInvoiceIdentity,sellerIdentity:fact.sellerIdentity,officialProductCategoryIdentity:classification.officialProductCategoryIdentity,officialProductCategoryGuid:classification.officialProductCategoryGuid,officialProductCategoryNumber:classification.officialProductCategoryNumber,officialProductCategoryName:classification.officialProductCategoryName,commissionRatePool:classification.commissionRatePool,commissionCategory:classification.officialProductCategoryName,categoryMappingId:classification.mappingId||fact.categoryMappingId||'',actualFifoProfitExact:fact.actualFifoProfitExact,approvedAdjustmentEffectExact:decimal.format(effect,decimal.MONEY_SCALE),commissionableProfitExact:commissionable,rateVersionId:rate.rateVersion?.rateVersionId||'',appliedRateScope:rate.appliedRateScope||'',rateResolutionPrecedence:rate.precedence||'',rateExact:rate.rateVersion?.rate||null,draftCommissionExact:draft,status:unavailableReason?'unavailable':'preliminary',unavailableReason,nonPayable:true,sellerFacing:false,createdAt:new Date()});}
  const run={commissionRunId:runId,schemaVersion:SCHEMA_VERSION,fifoDatasetId,periodFrom,periodTo,status:'PRELIMINARY_ACCOUNTING_REVIEW_REQUIRED',lineCount:lines.length,availableLineCount:lines.filter(row=>row.status==='preliminary').length,unavailableLineCount:lines.filter(row=>row.status==='unavailable').length,sourceFingerprint:sha256(stable(lines.map(row=>({...row,createdAt:undefined})))),createdBy:current,createdAt:new Date(),nonPayable:true,sellerFacing:false,payrollApproved:false};await db.collection(COMMISSION_RUNS).insertOne(run);await insertMany(db.collection(COMMISSION_LINES),lines);const commissionableValues=lines.filter(row=>row.commissionableProfitExact!=null).map(row=>row.commissionableProfitExact);const draftValues=lines.filter(row=>row.draftCommissionExact!=null).map(row=>row.draftCommissionExact);return{ok:true,run,totals:{actualFifoProfitExact:add(lines.map(row=>row.actualFifoProfitExact||0)),commissionableProfitExact:commissionableValues.length?add(commissionableValues):null,draftCommissionExact:draftValues.length?add(draftValues):null},preliminary:true,payable:false};
}
async function commissionReport(db,filters={}){await ensureIndexes(db);const runId=clean(filters.commissionRunId,100);const run=runId?await db.collection(COMMISSION_RUNS).findOne({commissionRunId:runId}):null;let lines=runId?await db.collection(COMMISSION_LINES).find({commissionRunId:runId}).toArray():[];return{ok:true,run,...pageRows(lines,filters),preliminary:true,payable:false,sellerFacing:false};}

const LEGACY_IMMUTABLE_EXPORT_FIELDS=Object.freeze(['exportBatchId','rowId','fifoDatasetId','fifoAlgorithmVersion','saleInvoiceIdentity','saleLineIdentity','itemGuid','itemCode','sellerIdentity','commissionCategory','quantityExact','saleAmountExact','invoiceDiscountExact','fifoCostExact','actualFifoProfitExact','costCoverageStatus','currentApprovedAdjustmentsExact','savedProfitPool','commissionRateVersionId']);
const IMMUTABLE_EXPORT_FIELDS=Object.freeze(['exportBatchId','rowId','fifoDatasetId','fifoAlgorithmVersion','saleInvoiceIdentity','saleLineIdentity','itemGuid','itemCode','sellerIdentity','officialProductCategoryIdentity','officialProductCategoryGuid','officialProductCategoryNumber','officialProductCategoryName','commissionRatePool','commissionCategory','quantityExact','saleAmountExact','invoiceDiscountExact','fifoCostExact','actualFifoProfitExact','costCoverageStatus','currentApprovedAdjustmentsExact','savedProfitPool','commissionRateVersionId','appliedRateScope','rateResolutionPrecedence']);
const EDITABLE_EXPORT_FIELDS=Object.freeze(['proposedAdjustmentAmountExact','adjustmentType','proposedSavedProfitPool','reasonCode','reasonText','evidenceReference','reviewerNotes']);
function immutableExportProjection(row,fields=IMMUTABLE_EXPORT_FIELDS){return Object.fromEntries(fields.filter(field=>field!=='exportBatchId'&&field!=='rowId').map(field=>[field,row[field]??null]));}
function csvCell(value){let text=String(value??'').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,10000);if(/^[=+\-@]/.test(text))text=`'${text}`;return `"${text.replace(/"/g,'""')}"`;}
function xmlEscape(value){return String(value??'').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g,' ').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));}
function spreadsheetMl(headers,rows){
  const immutable=new Set([...IMMUTABLE_EXPORT_FIELDS,'integrityHash']);
  const headerCells=headers.map(field=>`<Cell ss:StyleID="${immutable.has(field)?'ImmutableHeader':'EditableHeader'}"><Data ss:Type="String">${xmlEscape(field)}</Data></Cell>`).join('');
  const dataRows=rows.map(row=>`<Row>${headers.map(field=>`<Cell ss:StyleID="${immutable.has(field)?'Immutable':'Editable'}"><Data ss:Type="String">${xmlEscape(row[field]??'')}</Data></Cell>`).join('')}</Row>`).join('');
  const instructions=[
    ['Contract','Actual FIFO Profit is immutable. Only editable columns may be changed.'],
    ['Workflow','Imported edits become pending adjustments and require independent approval.'],
    ['Safety','Unknown cost is not zero. Draft commission is not payable or seller-facing.'],
    ['Pools','NOTEBOOK and COMPONENT reserves are isolated; cross-pool transfer is forbidden.'],
    ['Formula policy','Workbook formulas are presentation-only and never authoritative.']
  ].map(row=>`<Row>${row.map(value=>`<Cell><Data ss:Type="String">${xmlEscape(value)}</Data></Cell>`).join('')}</Row>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?><?mso-application progid="Excel.Sheet"?>\n<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet" xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"><Styles><Style ss:ID="Default"><Alignment ss:Vertical="Top"/></Style><Style ss:ID="ImmutableHeader"><Font ss:Bold="1"/><Interior ss:Color="#D9EAF7" ss:Pattern="Solid"/></Style><Style ss:ID="EditableHeader"><Font ss:Bold="1"/><Interior ss:Color="#FFF2CC" ss:Pattern="Solid"/></Style><Style ss:ID="Immutable"><Interior ss:Color="#EEF5FA" ss:Pattern="Solid"/></Style><Style ss:ID="Editable"><Interior ss:Color="#FFFBE6" ss:Pattern="Solid"/></Style></Styles><Worksheet ss:Name="Accounting Review"><Table><Row>${headerCells}</Row>${dataRows}</Table><WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel"><FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane><ProtectObjects>False</ProtectObjects><ProtectScenarios>False</ProtectScenarios></WorksheetOptions></Worksheet><Worksheet ss:Name="Instructions"><Table>${instructions}</Table></Worksheet></Workbook>`;
}
async function createExcelExport(db,input={},requestedBy={}){
  const current=requireRole(requestedBy,EDIT_ROLES);await ensureIndexes(db);const governance=require('./accounting-governance');const readiness=await governance.readiness(db,{fifoDatasetId:input.fifoDatasetId,periodFrom:input.periodFrom||'14050401',periodTo:input.periodTo||'14050431'},current);const diagnostic=clean(input.exportMode).toLowerCase()==='diagnostic';let diagnosticOverride=null;if(!readiness.normalExportReady){if(!diagnostic)fail('COMMISSION_EXPORT_NOT_READY','پیش‌نیازهای خروجی عادی کمیسیون کامل نیست.',409,{blockers:readiness.blockers,readiness});diagnosticOverride=await governance.authorizeDiagnosticExport(db,input,current);}
  const fifoDatasetId=readiness.fifoDatasetId||clean(input.fifoDatasetId,100)||(await fifoShadow.activeDataset(db))?.datasetId;let facts=await db.collection(FIFO_FACTS).find({fifoDatasetId}).toArray();facts=facts.filter(row=>row.saleDate>=readiness.periodFrom&&row.saleDate<=readiness.periodTo);facts.sort((a,b)=>a.saleLineIdentity.localeCompare(b.saleLineIdentity));const exportBatchId=newId('XEXP');const adjustments=await db.collection(ADJUSTMENTS).find({fifoDatasetId,status:'approved'}).toArray();const adjustmentsByLine=new Map();for(const row of adjustments){if(!adjustmentsByLine.has(row.saleLineIdentity))adjustmentsByLine.set(row.saleLineIdentity,[]);adjustmentsByLine.get(row.saleLineIdentity).push(row);}const approvedCategoryMappings=await db.collection(CATEGORY_MAPPINGS).find({status:'approved'}).toArray();const approvedRates=await db.collection(RATE_VERSIONS).find({status:'approved'}).toArray();const assignmentMaps=await governance._assignmentMaps(db);const rows=[];
  for(const fact of facts){const enriched=governance.enrichFact(fact,assignmentMaps.byGuid.get(fact.itemGuid)||assignmentMaps.byCode.get(fact.itemCode));const currentApprovedAdjustmentsExact=add((adjustmentsByLine.get(fact.saleLineIdentity)||[]).map(row=>row.approvedAmountExact||0));const classification=resolveCategoryFromMappings(approvedCategoryMappings,enriched,fact.saleDate);const rate=resolveRateFromRows(approvedRates,fact.sellerIdentity,classification,fact.saleDate);const base={exportBatchId,rowId:deterministicId('XROW',`${exportBatchId}|${fact.saleLineIdentity}`),fifoDatasetId,fifoAlgorithmVersion:fact.fifoAlgorithmVersion,saleInvoiceIdentity:fact.saleInvoiceIdentity,saleLineIdentity:fact.saleLineIdentity,itemGuid:fact.itemGuid,itemCode:fact.itemCode,sellerIdentity:fact.sellerIdentity,officialProductCategoryIdentity:classification.officialProductCategoryIdentity,officialProductCategoryGuid:classification.officialProductCategoryGuid,officialProductCategoryNumber:classification.officialProductCategoryNumber,officialProductCategoryName:classification.officialProductCategoryName,commissionRatePool:classification.commissionRatePool,commissionCategory:classification.officialProductCategoryName,quantityExact:fact.quantityExact,saleAmountExact:fact.saleAmountExact,invoiceDiscountExact:fact.invoiceDiscountExact,fifoCostExact:fact.fifoCostExact,actualFifoProfitExact:fact.actualFifoProfitExact,costCoverageStatus:fact.costCoverageStatus,currentApprovedAdjustmentsExact,savedProfitPool:POOLS.includes(classification.commissionRatePool)?classification.commissionRatePool:'',commissionRateVersionId:rate.rateVersion?.rateVersionId||'',appliedRateScope:rate.appliedRateScope||'',rateResolutionPrecedence:rate.precedence||''};const integrityHash=sha256(stable(immutableExportProjection(base)));rows.push({...base,integrityHash,...Object.fromEntries(EDITABLE_EXPORT_FIELDS.map(field=>[field,'']))});}
  const headers=[...IMMUTABLE_EXPORT_FIELDS,'integrityHash',...EDITABLE_EXPORT_FIELDS];let workbook=spreadsheetMl(headers,rows);if(diagnostic)workbook=workbook.replace('<Workbook ','<!-- INCOMPLETE DIAGNOSTIC ONLY — NO PAYABLE TOTAL -->\n<Workbook ');const workbookHash=sha256(workbook);const batch={exportBatchId,schemaVersion:SCHEMA_VERSION,fifoDatasetId,rowCount:rows.length,headers,immutableFields:IMMUTABLE_EXPORT_FIELDS,editableFields:EDITABLE_EXPORT_FIELDS,rows,sourceWorkbookHash:workbookHash,format:'excel-spreadsheetml-2003',exportMode:diagnostic?'diagnostic':'normal',diagnosticOverrideId:diagnosticOverride?.overrideId||'',readiness,createdBy:current,createdAt:new Date(),immutable:true,payable:false};await db.collection(EXPORT_BATCHES).insertOne(batch);return{ok:true,exportBatchId,rowCount:rows.length,sourceWorkbookHash:workbookHash,filename:`commission-review-${exportBatchId}.xml`,contentType:'application/vnd.ms-excel; charset=utf-8',content:workbook,immutableFields:IMMUTABLE_EXPORT_FIELDS,editableFields:EDITABLE_EXPORT_FIELDS,authoritativeEngine:'CRM-ledger-not-formulas',exportMode:batch.exportMode,payable:false,readiness};
}
async function importExcelEdits(db,input={},requestedBy={}){
  const current=requireRole(requestedBy,EDIT_ROLES);await ensureIndexes(db);const exportBatchId=clean(input.exportBatchId,100);const sourceWorkbookHash=clean(input.sourceWorkbookHash,64);const batch=await db.collection(EXPORT_BATCHES).findOne({exportBatchId});if(!batch)fail('EXCEL_EXPORT_BATCH_NOT_FOUND','Export batch پیدا نشد.',404);if(sourceWorkbookHash!==batch.sourceWorkbookHash)fail('EXCEL_SOURCE_HASH_MISMATCH','Hash workbook منبع تطابق ندارد.',409);const rows=Array.isArray(input.rows)?input.rows.slice(0,MAX_IMPORT_ROWS):[];if(!rows.length)fail('EXCEL_IMPORT_ROWS_REQUIRED','ردیف import لازم است.');if(await db.collection(IMPORT_BATCHES).findOne({exportBatchId,sourceWorkbookHash}))fail('EXCEL_IMPORT_DUPLICATE','این workbook قبلاً import شده است.',409);const exportById=new Map(batch.rows.map(row=>[row.rowId,row]));const seen=new Set();const auditRows=[];const pending=[];
  const batchImmutableFields=Array.isArray(batch.immutableFields)&&batch.immutableFields.length?batch.immutableFields:LEGACY_IMMUTABLE_EXPORT_FIELDS;
  for(let index=0;index<rows.length;index++){const edited=rows[index]||{};const originalExcelRowNumber=Number(edited.originalExcelRowNumber||index+2);let status='accepted';let code='';const original=exportById.get(clean(edited.rowId,100));if(!original){status='rejected';code='UNKNOWN_ROW';}else if(seen.has(original.rowId)){status='rejected';code='DUPLICATE_ROW';}else{seen.add(original.rowId);const expected=sha256(stable(immutableExportProjection(original,batchImmutableFields)));if(clean(edited.integrityHash,64)!==expected||original.integrityHash!==expected){status='rejected';code='IMMUTABLE_HASH_MISMATCH';}for(const field of batchImmutableFields){if(Object.prototype.hasOwnProperty.call(edited,field)&&String(edited[field]??'')!==String(original[field]??'')){status='rejected';code='IMMUTABLE_FIELD_CHANGED';break;}}if(EDITABLE_EXPORT_FIELDS.some(field=>FORMULA_ERRORS.test(clean(edited[field],500)))){status='rejected';code='FORMULA_ERROR';}}
    const proposed=clean(edited.proposedAdjustmentAmountExact,100);if(status==='accepted'&&!proposed){status='skipped';code='NO_EDIT';}if(status==='accepted'){try{const normalized=normalizeAdjustment({fifoDatasetId:original.fifoDatasetId,saleInvoiceIdentity:original.saleInvoiceIdentity,saleLineIdentity:original.saleLineIdentity,sellerIdentity:original.sellerIdentity,categoryPool:edited.proposedSavedProfitPool,adjustmentType:edited.adjustmentType,proposedAmountExact:proposed,reasonCode:edited.reasonCode,reasonText:edited.reasonText,sourceType:'excel_import',sourceReference:`${exportBatchId}:row:${originalExcelRowNumber}`,evidenceMetadata:{evidenceReference:clean(edited.evidenceReference,500),reviewerNotes:clean(edited.reviewerNotes,2000)},effectivePeriod:clean(input.effectivePeriod,8)});pending.push({normalized,originalExcelRowNumber,original,edited});}catch(error){status='rejected';code=error.code||'INVALID_EDIT';}}
    auditRows.push({originalExcelRowNumber,rowId:clean(edited.rowId,100),status,code,originalValue:original?Object.fromEntries(EDITABLE_EXPORT_FIELDS.map(field=>[field,original[field]])):null,editedValue:Object.fromEntries(EDITABLE_EXPORT_FIELDS.map(field=>[field,clean(edited[field],2000)]))});}
  const importBatchId=newId('XIMP');const importDoc={importBatchId,schemaVersion:SCHEMA_VERSION,exportBatchId,sourceWorkbookHash,status:auditRows.some(row=>row.status==='rejected')?'completed_with_rejections':'completed',rowCount:rows.length,acceptedCount:pending.length,rejectedCount:auditRows.filter(row=>row.status==='rejected').length,skippedCount:auditRows.filter(row=>row.status==='skipped').length,createdBy:current,createdAt:new Date(),automaticApproval:false,ledgerPosted:false};await db.collection(IMPORT_BATCHES).insertOne(importDoc);await insertMany(db.collection(IMPORT_ROWS),auditRows.map(row=>({...row,importBatchId,createdAt:new Date()})));
  for(const item of pending){
    const created=await createAdjustment(db,{...item.normalized,sourceReference:`${importBatchId}:${item.originalExcelRowNumber}`},current);
    await transitionAdjustment(db,created.adjustment.adjustmentId,'submit',{revision:created.adjustment.revision,reason:'Validated Excel import; independent approval required.'},current);
  }
  return{ok:true,import:importDoc,rows:auditRows,pendingAdjustmentsCreated:pending.length,approvedAdjustmentsCreated:0,ledgerEntriesCreated:0,fifoFactsChanged:0};
}
async function listExcelAudit(db,filters={}){await ensureIndexes(db);const exports=await db.collection(EXPORT_BATCHES).find({}).sort({createdAt:-1}).limit(50).toArray();const imports=await db.collection(IMPORT_BATCHES).find({}).sort({createdAt:-1}).limit(50).toArray();let rows=[];if(filters.importBatchId)rows=await db.collection(IMPORT_ROWS).find({importBatchId:clean(filters.importBatchId,100)}).toArray();return{ok:true,exports:exports.map(({rows:_,content:__,...row})=>row),imports,rows,formulaAuthority:false};}

const TIR_ISSUES=Object.freeze([
  ['TIR-ERR-4691-2357','confirmed_accounting_transfer_error','4691','2357','Confirmed workbook transfer error; excluded from rule inference.'],
  ['TIR-ERR-4031-483','confirmed_accounting_transfer_error','4031','483','Confirmed workbook transfer error; excluded from rule inference.'],
  ['TIR-ERR-4079-51','confirmed_accounting_transfer_error','4079','51','Confirmed workbook transfer error; excluded from rule inference.'],
  ['TIR-ERR-3917-1502','confirmed_accounting_transfer_error','3917','1502','Confirmed workbook transfer error; excluded from rule inference.'],
  ['TIR-COST-3801-1700','purchase_cost_conflict','3801','1700','Purchase-cost conflict requires evidence review.'],
  ['TIR-COST-4495-2068','corrupted_cost_candidate','4495','2068','Corrupted cost candidate; never auto-applied.'],
  ['TIR-RES-CONSOLE','unreconciled_residual','','','Console residual 99,500,000 IRR.'],
  ['TIR-RES-HESAM','unreconciled_residual','','','Hesam residual 360,000 IRR.'],
  ['TIR-RES-MASHHADKALA','unreconciled_residual','','','MashhadKala residual 22,000 IRR.'],
  ['TIR-ORPHAN-24','orphan_formula_row','','24','Orphan formula row 24.'],
  ['TIR-CACHED-VALUE','cached_formula_error','','','Cached #VALUE! cells.'],
  ['TIR-SELLER-ALIAS','seller_identity_issue','','','Seller aliases/spelling require explicit mapping.'],
  ['TIR-COMP-OPENING','missing_opening_balance','','','Component saved-profit opening balance is missing.']
]);
async function buildTirReconstruction(db,input={},requestedBy={}){const current=requireRole(requestedBy,ALLOWED_ROLES);await ensureIndexes(db);let created=0;for(const [issueId,classification,invoiceNumber,lineNumber,description] of TIR_ISSUES){const row={issueId,schemaVersion:SCHEMA_VERSION,period:'140504',classification,invoiceNumber,lineNumber,description,status:'unresolved_or_confirmed_as_noted',excludedFromRuleInference:classification==='confirmed_accounting_transfer_error'||classification==='corrupted_cost_candidate',immutable:true,createdBy:current,createdAt:new Date()};const result=await db.collection(TIR_RECONSTRUCTION).updateOne({issueId},{$setOnInsert:row},{upsert:true});if(result.upsertedCount)created++;}const issues=await db.collection(TIR_RECONSTRUCTION).find({period:'140504'}).toArray();const fifoDatasetId=clean(input.fifoDatasetId,100)||(await fifoShadow.activeDataset(db))?.datasetId;const facts=fifoDatasetId?await db.collection(FIFO_FACTS).find({fifoDatasetId}).toArray():[];const adjustments=fifoDatasetId?await db.collection(ADJUSTMENTS).find({fifoDatasetId}).toArray():[];return{ok:true,period:'140504',fifoDatasetId,created,issues,comparisonDimensions:['workbookArithmeticProfit','workbookAdjustedProfit','immutableCrmFifoProfit','approvedOrPendingCrmAdjustments','commissionableProfit','draftCommission'],crm:{factCount:facts.length,completeProfitFactCount:facts.filter(row=>row.costCoverageStatus==='complete').length,actualFifoProfitExact:add(facts.filter(row=>row.actualFifoProfitExact!=null).map(row=>row.actualFifoProfitExact)),approvedAdjustmentCount:adjustments.filter(row=>row.status==='approved').length,pendingAdjustmentCount:adjustments.filter(row=>row.status==='pending').length},drillable:true,accountingApproved:false};}
async function readTirReconstruction(db,input={},requestedBy={}){requireRole(requestedBy,ALLOWED_ROLES);const stored=await db.collection(TIR_RECONSTRUCTION).find({period:'140504'}).toArray();const issues=stored.length?stored:TIR_ISSUES.map(([issueId,classification,invoiceNumber,lineNumber,description])=>({issueId,schemaVersion:SCHEMA_VERSION,period:'140504',classification,invoiceNumber,lineNumber,description,status:'catalog-not-persisted',excludedFromRuleInference:classification==='confirmed_accounting_transfer_error'||classification==='corrupted_cost_candidate',immutable:true}));const fifoDatasetId=clean(input.fifoDatasetId,100)||(await fifoShadow.activeDataset(db))?.datasetId;const facts=fifoDatasetId?await db.collection(FIFO_FACTS).find({fifoDatasetId}).toArray():[];const adjustments=fifoDatasetId?await db.collection(ADJUSTMENTS).find({fifoDatasetId}).toArray():[];return{ok:true,period:'140504',fifoDatasetId,created:0,issues,comparisonDimensions:['workbookArithmeticProfit','workbookAdjustedProfit','immutableCrmFifoProfit','approvedOrPendingCrmAdjustments','commissionableProfit','draftCommission'],crm:{factCount:facts.length,completeProfitFactCount:facts.filter(row=>row.costCoverageStatus==='complete').length,actualFifoProfitExact:add(facts.filter(row=>row.actualFifoProfitExact!=null).map(row=>row.actualFifoProfitExact)),approvedAdjustmentCount:adjustments.filter(row=>row.status==='approved').length,pendingAdjustmentCount:adjustments.filter(row=>row.status==='pending').length},drillable:true,accountingApproved:false,readOnly:true};}

async function health(db){await ensureIndexes(db);const counts={};for(const name of OWNED_COLLECTIONS)counts[name]=await count(db.collection(name),{});return{ok:true,moduleVersion:MODULE_VERSION,counts,safety:{actualFifoImmutable:true,commissionPreliminary:true,payrollEnabled:false,sellerFacing:false,shayganWrites:0,inventoryWrites:0,sourceDatasetWrites:0,crossPoolTransfers:false}};}

module.exports={
  FIFO_FACTS,ADJUSTMENTS,SAVED_LEDGER,SUPPLIER_LEDGER,CATEGORY_MAPPINGS,CATEGORY_APPROVAL_LOCKS,RATE_VERSIONS,RATE_APPROVAL_LOCKS,DISCOUNT_FACTS,COMMISSION_RUNS,COMMISSION_LINES,EXPORT_BATCHES,IMPORT_BATCHES,IMPORT_ROWS,TIR_RECONSTRUCTION,OWNED_COLLECTIONS,
  SCHEMA_VERSION,GOVERNANCE_SCHEMA_VERSION,MODULE_VERSION,POOLS,RATE_POOLS,RATE_SCOPES,CATEGORIES,ADJUSTMENT_TYPES,ADJUSTMENT_STATUSES,SAVED_ENTRY_TYPES,SUPPLIER_INCENTIVE_TYPES,IMMUTABLE_EXPORT_FIELDS,LEGACY_IMMUTABLE_EXPORT_FIELDS,EDITABLE_EXPORT_FIELDS,TIR_ISSUES,
  ensureIndexes,materializeFifoProfitFacts,listFacts,createAdjustment,updateAdjustmentDraft,transitionAdjustment,reverseAdjustment,listAdjustments,listSavedLedger,savedBalance,listSupplierIncentives,createCategoryMapping,updateCategoryMapping,transitionCategoryMapping,approveCategoryMapping,listCategoryMappings,resolveCategory,createRateVersion,updateRateVersion,transitionRateVersion,approveRateVersion,listRateVersions,resolveRate,seedTirRateCandidates,extractInvoiceDiscountFacts,listDiscountFacts,calculateDraftCommission,commissionReport,createExcelExport,importExcelEdits,listExcelAudit,buildTirReconstruction,readTirReconstruction,health,
  _stable:stable,_sha256:sha256,_exact:exact,_add:add,_subtract:subtract,_multiplyMoneyRate:multiplyMoneyRate,_immutableExportProjection:immutableExportProjection,_normalizeAdjustment:normalizeAdjustment,_resolveCategoryFromMappings:resolveCategoryFromMappings,_resolveRateFromRows:resolveRateFromRows,_mappingRatePool:mappingRatePool,_normalizedStoredRate:normalizedStoredRate
};
