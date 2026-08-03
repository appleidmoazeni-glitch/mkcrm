'use strict';

const crypto = require('crypto');
const purchaseLayerDataset = require('./purchase-layer-dataset');
const saleSnapshot = require('./sale-snapshot');
const decimal = require('./accounting-decimal');

const EVIDENCE = 'accountingCostEvidence';
const PURCHASE_RETURNS = 'purchaseReturnResolutions';
const SALE_RETURNS = 'saleReturnResolutions';
const SAMPLES = 'accountingValidationSamples';
const STATE = 'accountingReadinessState';
const SCHEMA_VERSION = 1;
const CONFIDENCE_VERSION = 'accounting-confidence-1.0.0';
const ALGORITHM_VERSION = 'fifo-shadow-v2-precision-evidence';
const EVIDENCE_STATUSES = Object.freeze([
  'unreviewed','accounting_investigation','evidence_requested','evidence_found',
  'manual_cost_draft','pending_approval','approved_manual','official_layer_resolved',
  'return_dependency','manager_decision','confirmed_unknown','deferred'
]);
const RETURN_STATUSES = Object.freeze([
  'unresolved','candidate_found','pending_review','confirmed_linked',
  'confirmed_unmatched','deferred','ignored_with_reason'
]);
const SAMPLE_STATUSES = Object.freeze([
  'not_reviewed','accounting_confirmed','accounting_disputed','needs_evidence'
]);
const WORKFLOW_ROLES = Object.freeze(['admin','accounting','manager']);
const APPROVAL_ROLES = Object.freeze(['admin','manager','accounting']);

function clean(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}
function key(value) {
  return clean(value, 250).toLocaleLowerCase('en-US');
}
function finite(value) {
  const number = Number(String(value ?? '').replace(/[,،\s]/g, ''));
  return Number.isFinite(number) ? number : 0;
}
function round(value, scale = 2) {
  const factor = 10 ** scale;
  return Math.round((Number(value) + Number.EPSILON) * factor) / factor;
}
function percentage(part, total) {
  return total > 0 ? round(Number(part) * 100 / Number(total), 2) : 0;
}
function exactPercentage(part, total) {
  if (total === 0n) return 0;
  return Number(decimal.divideRounded(part * 10000n, total)) / 100;
}
function exactEqual(left, right, scale) {
  try {
    return decimal.parse(left, scale) === decimal.parse(right, scale);
  } catch {
    return false;
  }
}
function actor(value = {}) {
  return {
    username:clean(value.username || value.user || 'system', 100),
    role:clean(value.role || 'system', 50)
  };
}
function fail(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}
function requireRole(value, allowed = WORKFLOW_ROLES) {
  const current = actor(value);
  if (!allowed.includes(current.role)) fail('ACCOUNTING_EVIDENCE_FORBIDDEN', 'دسترسی این نقش به آمادگی حسابداری مجاز نیست.', 403);
  return current;
}
function id(prefix, material = '') {
  const suffix = material
    ? crypto.createHash('sha256').update(String(material)).digest('hex').slice(0, 24)
    : `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  return `${prefix}-${suffix}`;
}
function boundedObject(value, maxKeys = 30) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, maxKeys).map(([name, item]) => [
    clean(name, 80),
    Array.isArray(item)
      ? item.slice(0, 50).map(entry => clean(typeof entry === 'object' ? JSON.stringify(entry) : entry, 500))
      : clean(typeof item === 'object' ? JSON.stringify(item) : item, 2000)
  ]));
}
function audit(action, by, details = {}) {
  return {
    action:clean(action, 80),
    by:actor(by),
    details:boundedObject(details),
    at:new Date()
  };
}
function sourceItemKey(row) {
  return key(row.itemGuid) ? `guid:${key(row.itemGuid)}` : `code:${key(row.itemCode)}`;
}
function count(collection, query = {}) {
  if (typeof collection.countDocuments === 'function') return collection.countDocuments(query);
  return collection.find(query).toArray().then(rows => rows.length);
}
async function ensureIndexes(db) {
  const existing = new Set((await db.listCollections().toArray()).map(row => row.name));
  for (const name of [EVIDENCE, PURCHASE_RETURNS, SALE_RETURNS, SAMPLES, STATE]) {
    if (!existing.has(name)) await db.createCollection(name).catch(() => {});
  }
  await db.collection(EVIDENCE).createIndex({ evidenceId:1 }, { unique:true });
  await db.collection(EVIDENCE).createIndex({ sourceDatasetId:1, itemKey:1 }, { unique:true });
  await db.collection(EVIDENCE).createIndex({ status:1, priority:1, affectedSaleValue:-1 });
  await db.collection(EVIDENCE).createIndex({ assignedTo:1, updatedAt:-1 });
  await db.collection(PURCHASE_RETURNS).createIndex({ resolutionId:1 }, { unique:true });
  await db.collection(PURCHASE_RETURNS).createIndex({ sourcePurchaseDatasetId:1, returnLineIdentity:1 }, { unique:true });
  await db.collection(PURCHASE_RETURNS).createIndex({ status:1, returnDate:1 });
  await db.collection(SALE_RETURNS).createIndex({ resolutionId:1 }, { unique:true });
  await db.collection(SALE_RETURNS).createIndex({ sourceSaleSnapshotId:1, returnLineIdentity:1 }, { unique:true });
  await db.collection(SALE_RETURNS).createIndex({ status:1, returnDate:1 });
  await db.collection(SAMPLES).createIndex({ sampleId:1 }, { unique:true });
  await db.collection(SAMPLES).createIndex({ datasetId:1, sampleKey:1 }, { unique:true });
  await db.collection(SAMPLES).createIndex({ datasetId:1, reviewStatus:1, category:1 });
  await db.collection(STATE).createIndex({ scopeKey:1 }, { unique:true });
  return {
    ok:true,
    schemaVersion:SCHEMA_VERSION,
    confidenceVersion:CONFIDENCE_VERSION,
    algorithmVersion:ALGORITHM_VERSION
  };
}

async function stateForScope(db, scopeKey) {
  return db.collection('fifoDatasetState').findOne({ scopeKey });
}
async function selectFifoDataset(db, datasetId = '') {
  if (datasetId) return db.collection('fifoDatasets').findOne({ datasetId:clean(datasetId, 100) });
  const v2 = await stateForScope(db, ALGORITHM_VERSION);
  const v1 = await stateForScope(db, 'fifo-shadow-v1');
  const selected = v2?.activeDatasetId || v1?.activeDatasetId;
  if (selected) return db.collection('fifoDatasets').findOne({ datasetId:selected });
  return db.collection('fifoDatasets').findOne({ status:'completed' }, { sort:{ completedAt:-1 } });
}
async function activeSources(db) {
  const [sale, purchase] = await Promise.all([
    saleSnapshot._activeDataset(db),
    purchaseLayerDataset.activeDataset(db)
  ]);
  if (!sale?.snapshotId || !purchase?.datasetId) fail('ACCOUNTING_SOURCE_MISSING', 'Dataset فعال فروش یا خرید موجود نیست.', 409);
  return { sale, purchase };
}

function priorityRows(groups, totalQuantity, totalValue) {
  const rows = [...groups.values()].sort((a, b) =>
    b.affectedSaleValue - a.affectedSaleValue ||
    b.affectedQuantity - a.affectedQuantity ||
    a.itemCode.localeCompare(b.itemCode, 'en')
  );
  let cumulativeValue = 0;
  for (const row of rows) {
    cumulativeValue += row.affectedSaleValue;
    const cumulativePercent = percentage(cumulativeValue, totalValue);
    if (row.returnDependency || row.affectedSaleValue >= totalValue * 0.1) row.priority = 'P0';
    else if (cumulativePercent <= 80 || row.affectedSaleValue >= totalValue * 0.01) row.priority = 'P1';
    else if (row.affectedQuantity >= Math.max(5, totalQuantity * 0.002) || row.saleFrequency >= 5) row.priority = 'P2';
    else row.priority = 'P3';
    row.priorityScore = round(
      percentage(row.affectedSaleValue, totalValue) * 0.55 +
      percentage(row.affectedQuantity, totalQuantity) * 0.2 +
      Math.min(row.saleFrequency, 100) * 0.15 +
      Math.min(row.affectedSaleCount, 100) * 0.05 +
      (row.returnDependency ? 5 : 0),
      4
    );
    row.cumulativeCoverageGainPercent = cumulativePercent;
    row.projectedConfidenceImprovement = round(percentage(row.affectedQuantity, totalQuantity) * 0.3, 4);
  }
  return rows;
}

async function syncEvidence(db, dataset, by) {
  const current = actor(by);
  const historical = await db.collection(EVIDENCE).find({
    sourceDatasetId:{ $ne:dataset.datasetId },
    sourceActive:{ $ne:false }
  }).toArray();
  for (const row of historical) {
    await db.collection(EVIDENCE).updateOne(
      { evidenceId:row.evidenceId, revision:row.revision },
      { $set:{
        sourceActive:false,
        updatedBy:current,
        revision:Number(row.revision || 0) + 1,
        auditLog:[...(row.auditLog || []),audit('superseded-by-new-fifo-dataset',current,{
          oldDatasetId:row.sourceDatasetId,
          newDatasetId:dataset.datasetId
        })].slice(-200),
        updatedAt:new Date()
      } }
    );
  }
  const [allocations, exceptions] = await Promise.all([
    db.collection('fifoAllocations').find({ datasetId:dataset.datasetId }).toArray(),
    db.collection('fifoExceptions').find({ datasetId:dataset.datasetId }).toArray()
  ]);
  const unknown = allocations.filter(row => row.sourceType === 'unknown_cost' && finite(row.unknownQty) > 0);
  const groups = new Map();
  let totalQuantity = 0;
  let totalValue = 0;
  for (const row of unknown) {
    const itemKey = sourceItemKey(row);
    const group = groups.get(itemKey) || {
      itemKey,
      itemGuid:clean(row.itemGuid, 100),
      itemCode:clean(row.itemCode, 100),
      itemDescription:clean(row.itemDescription, 500),
      affectedSaleCount:0,
      affectedLineCount:0,
      affectedQuantity:0,
      affectedSaleValue:0,
      saleInvoices:new Set(),
      firstSaleDate:'',
      lastSaleDate:'',
      saleFrequency:0,
      returnDependency:false,
      reasonCodes:new Set(),
      currentInventory:0
    };
    group.saleInvoices.add(`${row.saleInvoiceType}-${row.saleInvoiceNo}`);
    group.affectedLineCount++;
    group.affectedQuantity += finite(row.unknownQty);
    group.affectedSaleValue += finite(row.allocatedSaleValue);
    group.firstSaleDate = !group.firstSaleDate || row.saleDate < group.firstSaleDate ? row.saleDate : group.firstSaleDate;
    group.lastSaleDate = !group.lastSaleDate || row.saleDate > group.lastSaleDate ? row.saleDate : group.lastSaleDate;
    group.reasonCodes.add(clean(row.unknownReason || 'unknown_cost', 100));
    groups.set(itemKey, group);
    totalQuantity += finite(row.unknownQty);
    totalValue += finite(row.allocatedSaleValue);
  }
  const returnItems = new Set(exceptions
    .filter(row => row.status === 'unresolved' && ['PURCHASE_RETURN_STATUS','SALE_RETURN_NOT_ALLOCATED'].includes(row.code))
    .map(sourceItemKey));
  const inventoryRows = await db.collection('itemInventoryCatalog').find({}).toArray();
  const inventory = new Map();
  for (const row of inventoryRows) {
    inventory.set(key(row.itemCode), (inventory.get(key(row.itemCode)) || 0) + finite(row.quantity));
  }
  for (const group of groups.values()) {
    group.affectedSaleCount = group.saleInvoices.size;
    group.saleFrequency = group.affectedLineCount;
    group.returnDependency = returnItems.has(group.itemKey);
    group.currentInventory = inventory.get(key(group.itemCode)) || 0;
  }
  const prioritized = priorityRows(groups, totalQuantity, totalValue);
  const now = new Date();
  for (const row of prioritized) {
    const existing = await db.collection(EVIDENCE).findOne({
      sourceDatasetId:dataset.datasetId,
      itemKey:row.itemKey
    });
    const values = {
      sourceDatasetId:dataset.datasetId,
      saleSnapshotId:dataset.sourceSaleSnapshotId || '',
      purchaseDatasetId:dataset.sourcePurchaseDatasetId || '',
      itemKey:row.itemKey,
      itemGuid:row.itemGuid,
      itemCode:row.itemCode,
      itemDescription:row.itemDescription,
      affectedSaleCount:row.affectedSaleCount,
      affectedLineCount:row.affectedLineCount,
      affectedQuantity:round(row.affectedQuantity, 6),
      affectedSaleValue:round(row.affectedSaleValue, 2),
      saleFrequency:row.saleFrequency,
      currentInventory:round(row.currentInventory, 6),
      returnDependency:row.returnDependency,
      reasonCode:[...row.reasonCodes][0] || 'unknown_cost',
      reasonCodes:[...row.reasonCodes],
      priority:row.priority,
      priorityScore:row.priorityScore,
      cumulativeCoverageGainPercent:row.cumulativeCoverageGainPercent,
      projectedConfidenceImprovement:row.projectedConfidenceImprovement,
      firstSaleDate:row.firstSaleDate,
      lastSaleDate:row.lastSaleDate,
      sourceActive:true,
      updatedAt:now
    };
    if (existing) {
      const impactChanged = finite(existing.affectedQuantity) !== finite(values.affectedQuantity) ||
        finite(existing.affectedSaleValue) !== finite(values.affectedSaleValue) ||
        existing.priority !== values.priority ||
        existing.sourceActive === false;
      await db.collection(EVIDENCE).updateOne(
        { evidenceId:existing.evidenceId, revision:existing.revision },
        { $set:{
          ...values,
          updatedBy:current,
          revision:Number(existing.revision || 0) + 1,
          auditLog:impactChanged
            ? [...(existing.auditLog || []), audit('impact-resynchronized', current, {
                oldQuantity:existing.affectedQuantity,
                newQuantity:values.affectedQuantity,
                oldSaleValue:existing.affectedSaleValue,
                newSaleValue:values.affectedSaleValue,
                oldPriority:existing.priority,
                newPriority:values.priority
              })].slice(-200)
            : existing.auditLog || []
        } }
      );
    } else {
      await db.collection(EVIDENCE).insertOne({
        evidenceId:id('EVID', `${dataset.datasetId}|${row.itemKey}`),
        schemaVersion:SCHEMA_VERSION,
        ...values,
        status:row.returnDependency ? 'return_dependency' : 'unreviewed',
        assignedTo:'',
        evidenceType:'',
        evidenceReference:'',
        attachmentMetadata:null,
        accountingNotes:'',
        managerNotes:'',
        createdBy:current,
        updatedBy:current,
        reviewedBy:null,
        reviewedAt:null,
        revision:1,
        auditLog:[audit('created-from-fifo-exception', current, { datasetId:dataset.datasetId, priority:row.priority })],
        createdAt:now
      });
    }
  }
  const activeKeys = new Set(prioritized.map(row => row.itemKey));
  const oldRows = await db.collection(EVIDENCE).find({ sourceDatasetId:dataset.datasetId }).toArray();
  for (const row of oldRows.filter(item => !activeKeys.has(item.itemKey) && item.sourceActive !== false)) {
    await db.collection(EVIDENCE).updateOne(
      { evidenceId:row.evidenceId, revision:row.revision },
      { $set:{
        sourceActive:false,
        updatedBy:current,
        revision:Number(row.revision || 0) + 1,
        auditLog:[...(row.auditLog || []),audit('source-no-longer-unresolved',current,{datasetId:dataset.datasetId})].slice(-200),
        updatedAt:now
      } }
    );
  }
  return { total:prioritized.length, unknownQuantity:round(totalQuantity, 6), unknownSaleValue:round(totalValue, 2) };
}

function purchaseCandidateScore(returnRow, purchaseRow) {
  let score = 0;
  if (key(returnRow.itemGuid) && key(returnRow.itemGuid) === key(purchaseRow.itemGuid)) score += 45;
  else if (key(returnRow.itemCode) && key(returnRow.itemCode) === key(purchaseRow.itemCode)) score += 25;
  if (key(returnRow.supplierAccountNumber) && key(returnRow.supplierAccountNumber) === key(purchaseRow.supplierAccountNumber)) score += 25;
  if (clean(purchaseRow.purchaseInvoiceDate) <= clean(returnRow.purchaseInvoiceDate)) score += 15;
  if (finite(purchaseRow.originalQuantity) >= Math.abs(finite(returnRow.originalQuantity || returnRow.returnedQuantity))) score += 15;
  return score;
}
async function syncPurchaseReturns(db, sources, by) {
  const rows = await db.collection(purchaseLayerDataset.LAYERS).find({ datasetId:sources.purchase.datasetId }).toArray();
  const purchases = rows.filter(row => row.layerKind === 'purchase');
  const returns = rows.filter(row => row.layerKind === 'purchase-return');
  let created = 0;
  for (const row of returns) {
    const returnLineIdentity = clean(row.purchaseLineIdentity, 500);
    const existing = await db.collection(PURCHASE_RETURNS).findOne({
      sourcePurchaseDatasetId:sources.purchase.datasetId,
      returnLineIdentity
    });
    if (existing) continue;
    const candidates = purchases
      .map(candidate => ({ purchaseLineIdentity:clean(candidate.purchaseLineIdentity, 500), score:purchaseCandidateScore(row, candidate) }))
      .filter(candidate => candidate.score >= 40)
      .sort((a, b) => b.score - a.score)
      .slice(0, 20);
    const alreadyMatched = row.returnMatchStatus === 'matched' && clean(row.matchedPurchaseLineIdentity);
    await db.collection(PURCHASE_RETURNS).insertOne({
      resolutionId:id('PRET', `${sources.purchase.datasetId}|${returnLineIdentity}`),
      schemaVersion:SCHEMA_VERSION,
      sourcePurchaseDatasetId:sources.purchase.datasetId,
      returnInvoiceIdentity:`7-${Number(row.purchaseInvoiceNo || 0)}`,
      returnLineIdentity,
      itemGuid:clean(row.itemGuid, 100),
      itemCode:clean(row.itemCode, 100),
      supplierIdentity:clean(row.supplierAccountNumber || row.supplierName, 200),
      returnDate:clean(row.purchaseInvoiceDate, 8),
      returnQuantity:Math.abs(finite(row.originalQuantity || row.returnedQuantity)),
      candidatePurchaseLayers:candidates,
      selectedPurchaseLayer:alreadyMatched ? clean(row.matchedPurchaseLineIdentity, 500) : '',
      confidence:alreadyMatched ? 100 : (candidates[0]?.score || 0),
      status:alreadyMatched ? 'confirmed_linked' : (candidates.length ? 'candidate_found' : 'unresolved'),
      reason:alreadyMatched ? 'official-source-matched' : (candidates.length ? 'candidate-requires-accounting-review' : 'no-reliable-candidate'),
      evidence:alreadyMatched ? { source:'official-purchase-layer-dataset' } : {},
      createdBy:actor(by),
      approvedBy:alreadyMatched ? actor({ username:'official-source', role:'system' }) : null,
      revision:1,
      auditLog:[audit('created-from-purchase-return', by, { sourceStatus:row.returnMatchStatus })],
      createdAt:new Date(),
      updatedAt:new Date()
    });
    created++;
  }
  return { total:returns.length, created };
}

function saleLineIdentity(row) {
  return clean(row.saleLineId, 500) ||
    `SL-${Number(row.saleInvoiceType || 0)}-${Number(row.saleInvoiceNo || 0)}-${Number(row.row || 0)}-${clean(row.itemCode, 100)}`;
}
async function syncSaleReturns(db, sources, by) {
  const [lines, headers] = await Promise.all([
    db.collection(sources.sale.lineCollection).find(sources.sale.lineQuery).toArray(),
    db.collection(sources.sale.headerCollection).find(sources.sale.headerQuery).toArray()
  ]);
  const sales = lines.filter(row => Number(row.saleInvoiceType) === 2);
  const returns = lines.filter(row => Number(row.saleInvoiceType) === 6);
  const headerByGuid = new Map(headers
    .filter(row => Number(row.invTyp) === 2 && key(row.guId))
    .map(row => [key(row.guId), row]));
  let created = 0;
  for (const row of returns) {
    const returnLineIdentity = saleLineIdentity(row);
    const existing = await db.collection(SALE_RETURNS).findOne({
      sourceSaleSnapshotId:sources.sale.snapshotId,
      returnLineIdentity
    });
    if (existing) continue;
    const reference = key(row.relatedInvHeaderId || row.invHeaderIdRoot);
    const header = reference ? headerByGuid.get(reference) : null;
    const candidates = header
      ? sales.filter(sale =>
          key(sale.saleGuid) === key(header.guId) &&
          sourceItemKey(sale) === sourceItemKey(row) &&
          finite(sale.qty) >= Math.abs(finite(row.qty))
        ).map(sale => ({
          originalSaleLineId:saleLineIdentity(sale),
          saleInvoiceNo:Number(sale.saleInvoiceNo || 0),
          quantity:finite(sale.qty),
          score:100,
          evidence:'explicit-header-reference+item+quantity'
        }))
      : [];
    await db.collection(SALE_RETURNS).insertOne({
      resolutionId:id('SRET', `${sources.sale.snapshotId}|${returnLineIdentity}`),
      schemaVersion:SCHEMA_VERSION,
      sourceSaleSnapshotId:sources.sale.snapshotId,
      returnInvoiceIdentity:`6-${Number(row.saleInvoiceNo || 0)}`,
      returnLineIdentity,
      itemGuid:clean(row.itemGuid, 100),
      itemCode:clean(row.itemCode, 100),
      customerIdentity:clean(row.customerAccountNumber || row.customerGuid, 200),
      store:clean(row.sellerStoreName || row.stockName, 200),
      sellerIdentity:clean(row.sellerAccountNumber || row.sellerName, 200),
      returnDate:clean(row.saleDate, 8),
      returnQuantity:Math.abs(finite(row.qty)),
      explicitReference:clean(row.relatedInvHeaderId || row.invHeaderIdRoot, 200),
      candidateSaleLines:candidates.slice(0, 20),
      selectedOriginalSaleLineId:'',
      confidence:candidates.length === 1 ? 100 : 0,
      status:candidates.length === 1 ? 'candidate_found' : 'unresolved',
      reason:candidates.length === 1 ? 'deterministic-candidate-requires-accounting-review' : 'missing-or-ambiguous-reliable-linkage',
      evidence:{},
      createdBy:actor(by),
      approvedBy:null,
      revision:1,
      auditLog:[audit('created-from-sale-return', by, { explicitReference:Boolean(reference), candidateCount:candidates.length })],
      createdAt:new Date(),
      updatedAt:new Date()
    });
    created++;
  }
  return { total:returns.length, created };
}

function invoiceGroups(allocations) {
  const groups = new Map();
  for (const row of allocations.filter(item => Number(item.saleInvoiceType) === 2)) {
    const invoiceKey = `2-${Number(row.saleInvoiceNo || 0)}`;
    const invoice = groups.get(invoiceKey) || {
      invoiceKey,
      saleInvoiceNo:Number(row.saleInvoiceNo || 0),
      saleDate:row.saleDate,
      saleValue:0,
      allocatedCost:0,
      unknownValue:0,
      lineIds:new Set(),
      rows:[]
    };
    invoice.saleValue += finite(row.allocatedSaleValue);
    invoice.allocatedCost += finite(row.allocatedCostAmount);
    if (row.sourceType === 'unknown_cost') invoice.unknownValue += finite(row.allocatedSaleValue);
    invoice.lineIds.add(row.saleLineId);
    invoice.rows.push(row);
    groups.set(invoiceKey, invoice);
  }
  return [...groups.values()].map(row => ({ ...row, lineCount:row.lineIds.size, lineIds:undefined }));
}
async function syncSamples(db, dataset, by) {
  const [allocations, exceptions, purchaseReturns, saleReturns, manuals] = await Promise.all([
    db.collection('fifoAllocations').find({ datasetId:dataset.datasetId }).toArray(),
    db.collection('fifoExceptions').find({ datasetId:dataset.datasetId }).toArray(),
    db.collection(PURCHASE_RETURNS).find({ status:'confirmed_linked' }).toArray(),
    db.collection(SALE_RETURNS).find({ status:'confirmed_linked' }).toArray(),
    db.collection('manualCostResolutions').find({ status:'approved' }).toArray()
  ]);
  const invoices = invoiceGroups(allocations);
  const sampleInputs = [];
  for (const row of invoices.filter(item => item.unknownValue === 0).sort((a,b)=>b.saleValue-a.saleValue).slice(0,10)) {
    sampleInputs.push({ category:'highest_value_fully_allocated_invoice', key:row.invoiceKey, source:row });
  }
  for (const row of invoices.filter(item => item.unknownValue > 0 && item.unknownValue < item.saleValue).sort((a,b)=>b.saleValue-a.saleValue).slice(0,10)) {
    sampleInputs.push({ category:'highest_value_partially_allocated_invoice', key:row.invoiceKey, source:row });
  }
  const returnInvoices = new Set(exceptions.filter(row => row.code === 'SALE_RETURN_NOT_ALLOCATED').map(row => clean(row.reference || row.saleReturnLineId)));
  for (const value of [...returnInvoices].slice(0,10)) sampleInputs.push({ category:'unresolved_return_invoice', key:value, source:{ reference:value } });
  const officialItems = new Map();
  for (const row of allocations.filter(item => item.sourceType === 'official_purchase_layer')) {
    if (!officialItems.has(sourceItemKey(row))) officialItems.set(sourceItemKey(row), row);
  }
  for (const [itemKey, row] of [...officialItems].slice(0,10)) sampleInputs.push({ category:'official_purchase_item', key:itemKey, source:row });
  for (const row of manuals) sampleInputs.push({ category:'manual_cost', key:row.resolutionId, source:row });
  for (const row of purchaseReturns) sampleInputs.push({ category:'confirmed_purchase_return', key:row.resolutionId, source:row });
  for (const row of saleReturns) sampleInputs.push({ category:'confirmed_sale_return', key:row.resolutionId, source:row });
  const highUnknown = allocations.filter(row => row.sourceType === 'unknown_cost').sort((a,b)=>finite(b.allocatedSaleValue)-finite(a.allocatedSaleValue)).slice(0,10);
  for (const row of highUnknown) sampleInputs.push({ category:'high_value_unknown', key:row.saleLineId, source:row });
  for (const sample of sampleInputs) {
    const sampleKey = `${sample.category}|${sample.key}`;
    const existing = await db.collection(SAMPLES).findOne({ datasetId:dataset.datasetId, sampleKey });
    if (existing) continue;
    const source = sample.source || {};
    await db.collection(SAMPLES).insertOne({
      sampleId:id('ASAMPLE', `${dataset.datasetId}|${sampleKey}`),
      schemaVersion:SCHEMA_VERSION,
      datasetId:dataset.datasetId,
      sampleKey,
      category:sample.category,
      sourceSaleInvoice:Number(source.saleInvoiceNo || 0),
      saleLine:clean(source.saleLineId, 500),
      saleQuantity:finite(source.soldQuantity || source.allocatedQty || source.unknownQty),
      sourcePurchaseLayer:clean(source.purchaseLineIdentity, 500),
      purchaseInvoice:Number(source.purchaseInvoiceNo || 0),
      allocatedQuantity:finite(source.allocatedQty),
      unitCostExact:clean(source.unitCostExact || source.precision?.unitCostExact || source.unitCost, 100),
      allocationCostExact:clean(source.allocatedCostAmountExact || source.precision?.allocationValueExact || source.allocatedCostAmount, 100),
      returnEffect:clean(source.returnEffect || source.status, 500),
      manualEvidence:clean(source.evidenceReference || source.attachment?.reference, 500),
      confidenceClassification:clean(source.sourceConfidence || (sample.category.includes('unknown') ? 'unknown' : 'evidence-present'), 100),
      unresolvedReason:clean(source.unknownReason || source.reason, 1000),
      sourceSnapshot:boundedObject(source),
      reviewStatus:'not_reviewed',
      reviewNotes:'',
      revision:1,
      auditLog:[audit('sample-created', by, { category:sample.category })],
      createdAt:new Date(),
      updatedAt:new Date()
    });
  }
  return { total:await count(db.collection(SAMPLES), { datasetId:dataset.datasetId }) };
}

async function synchronize(db, by = {}) {
  const current = requireRole(by, ['admin','accounting']);
  await ensureIndexes(db);
  const dataset = await selectFifoDataset(db);
  if (!dataset?.datasetId || dataset.status !== 'completed') fail('FIFO_DATASET_MISSING', 'FIFO Shadow Dataset کامل برای Evidence Queue موجود نیست.', 409);
  const sources = await activeSources(db);
  const startedAt = Date.now();
  const [evidence, purchaseReturns, saleReturns] = await Promise.all([
    syncEvidence(db, dataset, current),
    syncPurchaseReturns(db, sources, current),
    syncSaleReturns(db, sources, current)
  ]);
  const samples = await syncSamples(db, dataset, current);
  await db.collection(STATE).updateOne(
    { scopeKey:'accounting-readiness-v1' },
    { $set:{
      scopeKey:'accounting-readiness-v1',
      sourceFifoDatasetId:dataset.datasetId,
      sourceSaleSnapshotId:sources.sale.snapshotId,
      sourcePurchaseDatasetId:sources.purchase.datasetId,
      lastSynchronizedAt:new Date(),
      synchronizedBy:current,
      durationMs:Date.now()-startedAt,
      updatedAt:new Date()
    }, $setOnInsert:{ createdAt:new Date() } },
    { upsert:true }
  );
  return {
    ok:true,
    sourceFifoDatasetId:dataset.datasetId,
    evidence,
    purchaseReturns,
    saleReturns,
    samples,
    durationMs:Date.now()-startedAt,
    shadowMode:true,
    accountingApproved:false,
    profitActivationAllowed:false
  };
}

const EVIDENCE_TRANSITIONS = Object.freeze({
  unreviewed:['accounting_investigation','evidence_requested','return_dependency','confirmed_unknown','deferred'],
  accounting_investigation:['evidence_requested','evidence_found','confirmed_unknown','return_dependency','deferred'],
  evidence_requested:['accounting_investigation','evidence_found','deferred'],
  evidence_found:['manual_cost_draft','official_layer_resolved','pending_approval','manager_decision'],
  manual_cost_draft:['pending_approval','evidence_found','deferred'],
  pending_approval:['approved_manual','manager_decision','evidence_found'],
  manager_decision:['approved_manual','confirmed_unknown','deferred','evidence_found'],
  return_dependency:['accounting_investigation','official_layer_resolved','confirmed_unknown','deferred'],
  approved_manual:['official_layer_resolved'],
  official_layer_resolved:[],
  confirmed_unknown:['accounting_investigation','deferred'],
  deferred:['accounting_investigation']
});
async function transitionEvidence(db, evidenceId, input, by) {
  const current = requireRole(by);
  const row = await db.collection(EVIDENCE).findOne({ evidenceId:clean(evidenceId, 100) });
  if (!row) fail('ACCOUNTING_EVIDENCE_NOT_FOUND', 'Evidence record پیدا نشد.', 404);
  if (Number(input.revision) !== Number(row.revision)) fail('ACCOUNTING_EVIDENCE_CONFLICT', 'رکورد هم‌زمان تغییر کرده است.', 409);
  const status = clean(input.status, 80);
  if (!EVIDENCE_STATUSES.includes(status) || !(EVIDENCE_TRANSITIONS[row.status] || []).includes(status)) {
    fail('ACCOUNTING_EVIDENCE_INVALID_TRANSITION', `انتقال ${row.status} به ${status} مجاز نیست.`);
  }
  if (['approved_manual','official_layer_resolved','confirmed_unknown'].includes(status) && !clean(input.reason || input.accountingNotes)) {
    fail('ACCOUNTING_EVIDENCE_REASON_REQUIRED', 'برای تصمیم حسابداری دلیل مستند الزامی است.');
  }
  const next = {
    status,
    assignedTo:clean(input.assignedTo ?? row.assignedTo, 100),
    evidenceType:clean(input.evidenceType ?? row.evidenceType, 100),
    evidenceReference:clean(input.evidenceReference ?? row.evidenceReference, 500),
    attachmentMetadata:input.attachmentMetadata && typeof input.attachmentMetadata === 'object'
      ? boundedObject(input.attachmentMetadata, 10)
      : row.attachmentMetadata || null,
    accountingNotes:clean(input.accountingNotes ?? row.accountingNotes, 3000),
    managerNotes:clean(input.managerNotes ?? row.managerNotes, 3000),
    updatedBy:current,
    reviewedBy:current,
    reviewedAt:new Date(),
    revision:Number(row.revision) + 1,
    auditLog:[...(row.auditLog || []), audit('status-transition', current, { fromStatus:row.status, toStatus:status, reason:input.reason })].slice(-200),
    updatedAt:new Date()
  };
  const result = await db.collection(EVIDENCE).updateOne(
    { evidenceId:row.evidenceId, revision:row.revision },
    { $set:next }
  );
  if (!result.matchedCount) fail('ACCOUNTING_EVIDENCE_CONFLICT', 'رکورد هم‌زمان تغییر کرده است.', 409);
  return { ok:true, evidence:{ ...row, ...next } };
}

async function listEvidence(db, filters = {}) {
  await ensureIndexes(db);
  const query = filters.includeHistory === true || String(filters.includeHistory) === 'true'
    ? {}
    : { sourceActive:{ $ne:false } };
  if (filters.status) query.status = clean(filters.status, 80);
  if (filters.priority) query.priority = clean(filters.priority, 10);
  if (filters.assignedTo) query.assignedTo = clean(filters.assignedTo, 100);
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 50), 500));
  let rows = await db.collection(EVIDENCE).find(query).sort({ priority:1, affectedSaleValue:-1, itemCode:1 }).toArray();
  const search = key(filters.search);
  if (search) rows = rows.filter(row => key(`${row.itemCode} ${row.itemDescription} ${row.itemGuid}`).includes(search));
  const total = rows.length;
  const active = rows.filter(row => row.sourceActive !== false);
  const totalValue = active.reduce((sum,row)=>sum+finite(row.affectedSaleValue),0);
  return {
    ok:true,
    total,
    page,
    pageSize,
    list:rows.slice((page-1)*pageSize,page*pageSize),
    impact:{
      affectedSaleValue:round(totalValue,2),
      affectedQuantity:round(active.reduce((sum,row)=>sum+finite(row.affectedQuantity),0),6),
      byPriority:Object.fromEntries(['P0','P1','P2','P3'].map(priority => [priority, active.filter(row=>row.priority===priority).length]))
    },
    shadowMode:true,
    accountingApproved:false
  };
}

async function listReturnResolutions(db, kind, filters = {}) {
  await ensureIndexes(db);
  const collectionName = kind === 'purchase' ? PURCHASE_RETURNS : SALE_RETURNS;
  const query = {};
  if (filters.status) query.status = clean(filters.status, 80);
  const page = Math.max(1, Number(filters.page || 1));
  const pageSize = Math.max(1, Math.min(Number(filters.pageSize || 50), 500));
  const total = await count(db.collection(collectionName), query);
  const list = await db.collection(collectionName).find(query).sort({ returnDate:-1, returnInvoiceIdentity:1 }).skip((page-1)*pageSize).limit(pageSize).toArray();
  return { ok:true, kind, total, page, pageSize, list, shadowMode:true, accountingApproved:false };
}
async function transitionReturn(db, kind, resolutionId, input, by) {
  const current = requireRole(by);
  const collectionName = kind === 'purchase' ? PURCHASE_RETURNS : SALE_RETURNS;
  const row = await db.collection(collectionName).findOne({ resolutionId:clean(resolutionId, 100) });
  if (!row) fail('RETURN_RESOLUTION_NOT_FOUND', 'Return resolution پیدا نشد.', 404);
  if (Number(input.revision) !== Number(row.revision)) fail('RETURN_RESOLUTION_CONFLICT', 'Return resolution هم‌زمان تغییر کرده است.', 409);
  const status = clean(input.status, 80);
  if (!RETURN_STATUSES.includes(status)) fail('RETURN_RESOLUTION_INVALID_STATUS', 'وضعیت Resolution معتبر نیست.');
  if (status === 'confirmed_linked') {
    requireRole(current, APPROVAL_ROLES);
    if (actor(row.createdBy).username === current.username) fail('RETURN_RESOLUTION_SELF_APPROVAL', 'ثبت‌کننده نمی‌تواند Resolution خود را تأیید کند.', 409);
    const selected = kind === 'purchase'
      ? clean(input.selectedPurchaseLayer || row.selectedPurchaseLayer, 500)
      : clean(input.selectedOriginalSaleLineId || row.selectedOriginalSaleLineId, 500);
    if (!selected) fail('RETURN_RESOLUTION_SELECTION_REQUIRED', 'انتخاب سند یا ردیف اصلی برای تأیید الزامی است.');
    if (kind === 'purchase') row.selectedPurchaseLayer = selected;
    else row.selectedOriginalSaleLineId = selected;
  }
  if (['confirmed_unmatched','deferred','ignored_with_reason'].includes(status) && !clean(input.reason)) {
    fail('RETURN_RESOLUTION_REASON_REQUIRED', 'ثبت دلیل برای این وضعیت الزامی است.');
  }
  const next = {
    status,
    selectedPurchaseLayer:kind === 'purchase' ? clean(input.selectedPurchaseLayer || row.selectedPurchaseLayer, 500) : undefined,
    selectedOriginalSaleLineId:kind === 'sale' ? clean(input.selectedOriginalSaleLineId || row.selectedOriginalSaleLineId, 500) : undefined,
    reason:clean(input.reason || row.reason, 1000),
    evidence:input.evidence && typeof input.evidence === 'object' ? boundedObject(input.evidence, 20) : row.evidence || {},
    confidence:Math.max(0, Math.min(100, finite(input.confidence ?? row.confidence))),
    approvedBy:status.startsWith('confirmed_') ? current : row.approvedBy || null,
    approvedAt:status.startsWith('confirmed_') ? new Date() : row.approvedAt || null,
    revision:Number(row.revision) + 1,
    auditLog:[...(row.auditLog || []), audit('return-transition', current, { fromStatus:row.status, toStatus:status, reason:input.reason })].slice(-200),
    updatedAt:new Date()
  };
  Object.keys(next).filter(name => next[name] === undefined).forEach(name => delete next[name]);
  const result = await db.collection(collectionName).updateOne({ resolutionId:row.resolutionId, revision:row.revision }, { $set:next });
  if (!result.matchedCount) fail('RETURN_RESOLUTION_CONFLICT', 'Return resolution هم‌زمان تغییر کرده است.', 409);
  return { ok:true, resolution:{ ...row, ...next } };
}

async function listSamples(db, filters = {}) {
  await ensureIndexes(db);
  const dataset = await selectFifoDataset(db, filters.datasetId);
  if (!dataset) return { ok:true, total:0, list:[] };
  const query = { datasetId:dataset.datasetId };
  if (filters.reviewStatus) query.reviewStatus = clean(filters.reviewStatus, 80);
  if (filters.category) query.category = clean(filters.category, 100);
  const list = await db.collection(SAMPLES).find(query).sort({ category:1, createdAt:1 }).toArray();
  return { ok:true, datasetId:dataset.datasetId, total:list.length, list, shadowMode:true, accountingApproved:false };
}
async function reviewSample(db, sampleId, input, by) {
  const current = requireRole(by);
  const row = await db.collection(SAMPLES).findOne({ sampleId:clean(sampleId, 100) });
  if (!row) fail('ACCOUNTING_SAMPLE_NOT_FOUND', 'نمونه حسابداری پیدا نشد.', 404);
  if (Number(input.revision) !== Number(row.revision)) fail('ACCOUNTING_SAMPLE_CONFLICT', 'نمونه هم‌زمان تغییر کرده است.', 409);
  const reviewStatus = clean(input.reviewStatus, 80);
  if (!SAMPLE_STATUSES.includes(reviewStatus) || reviewStatus === 'not_reviewed') fail('ACCOUNTING_SAMPLE_INVALID_STATUS', 'وضعیت بررسی معتبر نیست.');
  const next = {
    reviewStatus,
    reviewNotes:clean(input.reviewNotes, 3000),
    reviewedBy:current,
    reviewedAt:new Date(),
    revision:Number(row.revision) + 1,
    auditLog:[...(row.auditLog || []), audit('sample-reviewed', current, { fromStatus:row.reviewStatus, toStatus:reviewStatus })].slice(-100),
    updatedAt:new Date()
  };
  const result = await db.collection(SAMPLES).updateOne({ sampleId:row.sampleId, revision:row.revision }, { $set:next });
  if (!result.matchedCount) fail('ACCOUNTING_SAMPLE_CONFLICT', 'نمونه هم‌زمان تغییر کرده است.', 409);
  return { ok:true, sample:{ ...row, ...next } };
}

function confidenceFromRows(dataset, allocations, evidence, purchaseReturns, saleReturns, samples) {
  const saleRows = allocations.filter(row => Number(row.saleInvoiceType) === 2);
  const byLine = new Map();
  let totalQuantity = 0n, officialQuantity = 0n, manualQuantity = 0n;
  let totalSaleValue = 0n, coveredSaleValue = 0n;
  for (const row of saleRows) {
    const line = byLine.get(row.saleLineId) || { unknown:false };
    const quantity = decimal.parse(row.quantityExact || row.allocatedQty || row.unknownQty || 0, decimal.QUANTITY_SCALE);
    const saleValue = decimal.parse(row.allocatedSaleValueExact || row.allocatedSaleValue || 0, decimal.MONEY_SCALE);
    totalQuantity += quantity;
    totalSaleValue += saleValue;
    if (row.sourceType === 'official_purchase_layer') {
      officialQuantity += quantity;
      coveredSaleValue += saleValue;
    } else if (row.sourceType === 'approved_manual_cost') {
      manualQuantity += quantity;
      coveredSaleValue += saleValue;
    } else if (row.sourceType === 'unknown_cost') line.unknown = true;
    byLine.set(row.saleLineId, line);
  }
  const returnTotal = purchaseReturns.length + saleReturns.length;
  const returnLinked = [...purchaseReturns, ...saleReturns].filter(row => row.status === 'confirmed_linked' || row.status === 'confirmed_unmatched').length;
  const reviewedEvidence = evidence.filter(row => !['unreviewed','accounting_investigation','evidence_requested','return_dependency'].includes(row.status)).length;
  const reviewedSamples = samples.filter(row => row.reviewStatus !== 'not_reviewed').length;
  const reviewTotal = evidence.length + samples.length;
  const components = {
    quantityCostCoverage:exactPercentage(officialQuantity + manualQuantity, totalQuantity),
    saleValueCostCoverage:exactPercentage(coveredSaleValue, totalSaleValue),
    lineCoverage:percentage([...byLine.values()].filter(row => !row.unknown).length, byLine.size),
    officialEvidenceCoverage:exactPercentage(officialQuantity, totalQuantity),
    manualEvidenceCoverage:exactPercentage(manualQuantity, totalQuantity),
    returnLinkageCoverage:percentage(returnLinked, returnTotal),
    accountingReviewCoverage:percentage(reviewedEvidence + reviewedSamples, reviewTotal)
  };
  const weights = {
    quantityCostCoverage:0.30,
    saleValueCostCoverage:0.25,
    lineCoverage:0.15,
    officialEvidenceCoverage:0.10,
    manualEvidenceCoverage:0.05,
    returnLinkageCoverage:0.10,
    accountingReviewCoverage:0.05
  };
  const index = round(Object.entries(weights).reduce((sum,[name,weight])=>sum+components[name]*weight,0),2);
  return {
    version:CONFIDENCE_VERSION,
    index,
    components,
    weights,
    formula:'30% quantity + 25% sale value + 15% line + 10% official evidence + 5% manual evidence + 10% return linkage + 5% accounting review',
    interpretation:'Explainable readiness indicator; not proof of accounting correctness.',
    totals:{
      quantityExact:decimal.format(totalQuantity,decimal.QUANTITY_SCALE),
      saleValueExact:decimal.format(totalSaleValue,decimal.MONEY_SCALE),
      lineCount:byLine.size,
      purchaseReturns:purchaseReturns.length,
      saleReturns:saleReturns.length,
      reviewedEvidence,
      reviewedSamples
    },
    sourceDatasetId:dataset.datasetId
  };
}

function approvalGate(dataset, confidence, manualValidation, samples) {
  const validation = dataset.validation || {};
  const monetaryDifference = clean(validation.monetaryReconciliationDifferenceExact || '0.00', 100);
  const technicalChecks = {
    duplicateAllocations:Number(validation.duplicateAllocationCount || 0) === 0,
    overAllocation:Number(validation.layerOverConsumptionCount || 0) === 0,
    orphanAllocations:Number(validation.orphanLayerCount || 0) === 0,
    inactiveSources:Number(validation.inactiveSourceCount || 0) === 0,
    deterministicReplay:Boolean(dataset.deterministicReplayVerified),
    monetaryReconciliationDifference:decimal.parse(monetaryDifference, decimal.MONEY_SCALE) === 0n
  };
  const thresholds = {
    unknownSaleValueMaximumPercent:5,
    returnLinkageMinimumPercent:95,
    accountingSampleMinimumReviewed:30
  };
  const unknownSaleValuePercent = round(100 - confidence.components.saleValueCostCoverage, 2);
  const accountingChecks = {
    unknownSaleValueWithinThreshold:unknownSaleValuePercent <= thresholds.unknownSaleValueMaximumPercent,
    returnLinkageWithinThreshold:confidence.components.returnLinkageCoverage >= thresholds.returnLinkageMinimumPercent,
    manualWorkflowValidated:manualValidation.valid,
    accountingSamplesReviewed:samples.filter(row => row.reviewStatus !== 'not_reviewed').length >= thresholds.accountingSampleMinimumReviewed
  };
  const technicalReady = Object.values(technicalChecks).every(Boolean);
  const accountingReady = Object.values(accountingChecks).every(Boolean);
  const dataThresholdsReady = accountingChecks.unknownSaleValueWithinThreshold && accountingChecks.returnLinkageWithinThreshold;
  let status = 'blocked';
  if (technicalReady && accountingReady) status = 'approved_for_manager_shadow_profit';
  else if (technicalReady && dataThresholdsReady) status = 'accounting_review_required';
  else if (technicalReady) status = 'technically_ready';
  return {
    status,
    technicalChecks,
    accountingChecks,
    thresholds,
    unknownSaleValuePercent,
    automaticProfitApproval:false,
    humanApprovalRequired:true,
    profitActivationAllowed:false
  };
}

function manualWorkflowValidation(manuals) {
  const approved = manuals.filter(row => row.status === 'approved');
  const validRows = approved.filter(row =>
    actor(row.createdBy).username &&
    actor(row.approvedBy).username &&
    actor(row.createdBy).username !== actor(row.approvedBy).username &&
    row.effectiveFrom &&
    (row.attachment || row.evidenceReference || row.reason)
  );
  return {
    total:approved.length,
    validCount:validRows.length,
    invalidCount:approved.length-validRows.length,
    twoUserApproval:approved.length > 0 && approved.every(row => actor(row.createdBy).username !== actor(row.approvedBy).username),
    attachmentOrEvidencePreserved:approved.length > 0 && approved.every(row => row.attachment || row.evidenceReference || row.reason),
    valid:approved.length > 0 && validRows.length === approved.length
  };
}

async function comparison(db, newDatasetId = '', oldDatasetId = '') {
  await ensureIndexes(db);
  const newer = await selectFifoDataset(db, newDatasetId);
  if (!newer) return { ok:true, available:false };
  let older = null;
  if (oldDatasetId) older = await db.collection('fifoDatasets').findOne({ datasetId:clean(oldDatasetId,100) });
  if (!older) {
    const v1state = await stateForScope(db, 'fifo-shadow-v1');
    if (v1state?.activeDatasetId && v1state.activeDatasetId !== newer.datasetId) {
      older = await db.collection('fifoDatasets').findOne({ datasetId:v1state.activeDatasetId });
    }
  }
  if (!older) older = await db.collection('fifoDatasets').findOne({ datasetId:{ $ne:newer.datasetId }, status:'completed' }, { sort:{ completedAt:-1 } });
  if (!older) return { ok:true, available:false, newDatasetId:newer.datasetId };
  const [oldRows,newRows] = await Promise.all([
    db.collection('fifoAllocations').find({ datasetId:older.datasetId }).toArray(),
    db.collection('fifoAllocations').find({ datasetId:newer.datasetId }).toArray()
  ]);
  const allocationKey = row => `${row.saleLineId}|${row.saleReturnResolutionId || ''}|${row.allocationSequence}|${row.purchaseLineIdentity || row.manualResolutionId || row.sourceType}`;
  const oldMap = new Map(oldRows.map(row => [allocationKey(row),row]));
  const newMap = new Map(newRows.map(row => [allocationKey(row),row]));
  const differences = [];
  for (const keyValue of new Set([...oldMap.keys(),...newMap.keys()])) {
    const oldRow=oldMap.get(keyValue),newRow=newMap.get(keyValue);
    const kind = !oldRow ? 'new_allocation' : (!newRow ? 'removed_allocation' :
      (oldRow.sourceType !== newRow.sourceType || clean(oldRow.purchaseLineIdentity || oldRow.manualResolutionId) !== clean(newRow.purchaseLineIdentity || newRow.manualResolutionId)
        ? 'changed_source_selection'
        : (!exactEqual(
          oldRow.unitCostExact ?? oldRow.unitCost,
          newRow.unitCostExact ?? newRow.unitCost,
          decimal.UNIT_COST_SCALE
        )
          ? 'changed_unit_cost'
          : (!exactEqual(
            oldRow.allocatedCostAmountExact ?? oldRow.allocatedCostAmount,
            newRow.allocatedCostAmountExact ?? newRow.allocatedCostAmount,
            decimal.MONEY_SCALE
          )
            ? 'precision_only_or_changed_value'
            : 'unchanged'))));
    if(kind!=='unchanged')differences.push({key:keyValue,kind,old:oldRow||null,new:newRow||null});
  }
  const oldUnknown=oldRows.reduce((sum,row)=>sum+finite(row.unknownQty),0);
  const newUnknown=newRows.reduce((sum,row)=>sum+finite(row.unknownQty),0);
  return {
    ok:true,
    available:true,
    oldDatasetId:older.datasetId,
    newDatasetId:newer.datasetId,
    counts:{
      oldAllocations:oldRows.length,
      newAllocations:newRows.length,
      changedAllocations:differences.length,
      changedSourceSelections:differences.filter(row=>row.kind==='changed_source_selection').length,
      changedUnitCosts:differences.filter(row=>row.kind==='changed_unit_cost').length,
      precisionOnlyDifferences:differences.filter(row=>row.kind==='precision_only_or_changed_value').length,
      returnCorrections:newRows.filter(row=>row.sourceType==='sale_return_reversal').length
    },
    unknownQuantity:{ before:round(oldUnknown,6), after:round(newUnknown,6), reduction:round(oldUnknown-newUnknown,6) },
    differences:differences.slice(0,500),
    materialDifferenceCount:differences.length,
    shadowMode:true,
    accountingApproved:false
  };
}

async function readinessReport(db, datasetId = '') {
  await ensureIndexes(db);
  const dataset = await selectFifoDataset(db, datasetId);
  if (!dataset) return { ok:true, available:false, shadowMode:true, accountingApproved:false };
  const [allocations,evidence,purchaseReturns,saleReturns,samples,manuals,compare] = await Promise.all([
    db.collection('fifoAllocations').find({ datasetId:dataset.datasetId }).toArray(),
    db.collection(EVIDENCE).find({ sourceActive:{ $ne:false } }).toArray(),
    db.collection(PURCHASE_RETURNS).find({}).toArray(),
    db.collection(SALE_RETURNS).find({}).toArray(),
    db.collection(SAMPLES).find({ datasetId:dataset.datasetId }).toArray(),
    db.collection('manualCostResolutions').find({}).toArray(),
    comparison(db,dataset.datasetId)
  ]);
  const confidence = confidenceFromRows(dataset,allocations,evidence,purchaseReturns,saleReturns,samples);
  const manualValidation = manualWorkflowValidation(manuals);
  const gate = approvalGate(dataset,confidence,manualValidation,samples);
  return {
    ok:true,
    available:true,
    dataset,
    confidence,
    gate,
    manualWorkflowValidation:manualValidation,
    evidence:{
      total:evidence.length,
      byStatus:Object.fromEntries(EVIDENCE_STATUSES.map(status=>[status,evidence.filter(row=>row.status===status).length])),
      byPriority:Object.fromEntries(['P0','P1','P2','P3'].map(priority=>[priority,evidence.filter(row=>row.priority===priority).length])),
      affectedSaleValue:round(evidence.reduce((sum,row)=>sum+finite(row.affectedSaleValue),0),2),
      affectedQuantity:round(evidence.reduce((sum,row)=>sum+finite(row.affectedQuantity),0),6)
    },
    returns:{
      purchase:{total:purchaseReturns.length,confirmed:purchaseReturns.filter(row=>row.status==='confirmed_linked').length,unresolved:purchaseReturns.filter(row=>!row.status.startsWith('confirmed_')).length},
      sale:{total:saleReturns.length,confirmed:saleReturns.filter(row=>row.status==='confirmed_linked').length,unresolved:saleReturns.filter(row=>!row.status.startsWith('confirmed_')).length}
    },
    samples:{
      total:samples.length,
      reviewed:samples.filter(row=>row.reviewStatus!=='not_reviewed').length,
      byStatus:Object.fromEntries(SAMPLE_STATUSES.map(status=>[status,samples.filter(row=>row.reviewStatus===status).length]))
    },
    precision:{
      model:'fixed-scale-bigint',
      quantityScale:decimal.QUANTITY_SCALE,
      unitCostScale:decimal.UNIT_COST_SCALE,
      allocationValueScale:decimal.MONEY_SCALE,
      roundingMode:decimal.ROUNDING_MODE,
      authoritativeFields:['quantityExact','unitCostExact','allocatedCostAmountExact'],
      historicalDatasetsMutated:false
    },
    comparison:compare,
    shadowMode:true,
    accountingApproved:false,
    profitCalculated:false,
    roiCalculated:false,
    commissionCalculated:false,
    profitActivationAllowed:false
  };
}

module.exports = {
  EVIDENCE,
  PURCHASE_RETURNS,
  SALE_RETURNS,
  SAMPLES,
  STATE,
  SCHEMA_VERSION,
  CONFIDENCE_VERSION,
  ALGORITHM_VERSION,
  EVIDENCE_STATUSES,
  RETURN_STATUSES,
  SAMPLE_STATUSES,
  ensureIndexes,
  synchronize,
  listEvidence,
  transitionEvidence,
  listReturnResolutions,
  transitionReturn,
  listSamples,
  reviewSample,
  comparison,
  readinessReport,
  _priorityRows:priorityRows,
  _confidenceFromRows:confidenceFromRows,
  _approvalGate:approvalGate,
  _manualWorkflowValidation:manualWorkflowValidation,
  _purchaseCandidateScore:purchaseCandidateScore
};
