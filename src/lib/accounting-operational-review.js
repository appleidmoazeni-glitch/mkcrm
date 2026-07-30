'use strict';

const crypto = require('crypto');
const purchaseLayerDataset = require('./purchase-layer-dataset');
const saleSnapshot = require('./sale-snapshot');
const decimal = require('./accounting-decimal');
const readiness = require('./accounting-evidence-confidence');

const INVESTIGATIONS = 'accountingEvidenceInvestigations';
const RECOVERY = 'purchaseLayerRecoveryCandidates';
const IDENTITIES = 'accountingItemIdentityResolutions';
const RETURN_CASES = 'accountingReturnReviewCases';
const MANUAL_PACKAGES = 'manualCostEvidencePackages';
const BATCHES = 'accountingReviewBatches';
const SCHEMA_VERSION = 1;
const MODULE_VERSION = 'accounting-operational-review-1.0.0';
const OWNED_COLLECTIONS = Object.freeze([
  INVESTIGATIONS, RECOVERY, IDENTITIES, RETURN_CASES, MANUAL_PACKAGES, BATCHES
]);
const CLASSIFICATIONS = Object.freeze([
  'official_evidence_found',
  'official_layer_rebuild_candidate',
  'item_identity_repair_candidate',
  'manual_cost_evidence_found',
  'purchase_return_dependency',
  'sale_return_dependency',
  'insufficient_evidence',
  'confirmed_unknown',
  'requires_accounting_decision'
]);
const REVIEW_STATUSES = Object.freeze(['prepared','in_review','needs_evidence','ready_for_human_decision','deferred']);
const RECOVERY_STATUSES = Object.freeze([
  'detected','evidence_verified','pending_accounting_review',
  'approved_for_dataset_rebuild','rejected','deferred'
]);
const IDENTITY_STATUSES = Object.freeze(['detected','pending_accounting_review','approved','rejected','deferred']);
const BATCH_STATUSES = Object.freeze(['prepared','in_review','waiting_evidence','completed','cancelled']);
const ALLOWED_ROLES = Object.freeze(['admin','accounting','manager']);

function clean(value, max = 1000) {
  return String(value == null ? '' : value).trim().slice(0, max);
}
function key(value) {
  return clean(value, 300).toLocaleLowerCase('en-US').replace(/[\s_-]+/g, '');
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
function actor(value = {}) {
  return {
    username:clean(value.username || value.user || 'system', 100),
    role:clean(value.role || 'system', 50)
  };
}
function requireRole(value, allowed = ALLOWED_ROLES) {
  const current = actor(value);
  if (!allowed.includes(current.role)) fail('ACCOUNTING_REVIEW_FORBIDDEN', 'دسترسی به میزکار بررسی حسابداری مجاز نیست.', 403);
  return current;
}
function fail(code, message, statusCode = 400) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  throw error;
}
function deterministicId(prefix, material) {
  return `${prefix}-${crypto.createHash('sha256').update(String(material)).digest('hex').slice(0, 24)}`;
}
function boundedObject(value, maxKeys = 40) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, maxKeys).map(([name, item]) => [
    clean(name, 100),
    Array.isArray(item)
      ? item.slice(0, 30).map(entry => clean(typeof entry === 'object' ? JSON.stringify(entry) : entry, 1000))
      : clean(typeof item === 'object' ? JSON.stringify(item) : item, 3000)
  ]));
}
function audit(action, by, details = {}) {
  return { action:clean(action, 100), by:actor(by), details:boundedObject(details), at:new Date() };
}
async function count(collection, query = {}) {
  if (typeof collection.countDocuments === 'function') return Number(await collection.countDocuments(query));
  return (await collection.find(query).toArray()).length;
}
function itemKey(row = {}) {
  return key(row.itemGuid) ? `guid:${key(row.itemGuid)}` : `code:${key(row.itemCode)}`;
}
function exactMoney(value) {
  return decimal.format(decimal.parse(value || 0, decimal.MONEY_SCALE), decimal.MONEY_SCALE);
}
function exactUnitCost(value) {
  return decimal.format(decimal.parse(value || 0, decimal.UNIT_COST_SCALE), decimal.UNIT_COST_SCALE);
}
function exactQuantity(value) {
  return decimal.format(decimal.parse(value || 0, decimal.QUANTITY_SCALE), decimal.QUANTITY_SCALE);
}
function canonicalDate(value) {
  const digits = clean(value, 30).replace(/\D/g, '');
  if (digits.length === 8 && /^1[34]\d{6}$/.test(digits)) return digits;
  return clean(value, 30);
}

async function ensureIndexes(db) {
  const existing = new Set((await db.listCollections().toArray()).map(row => row.name));
  for (const name of OWNED_COLLECTIONS) {
    if (!existing.has(name)) await db.createCollection(name).catch(() => {});
  }
  await db.collection(INVESTIGATIONS).createIndex({ investigationId:1 }, { unique:true });
  await db.collection(INVESTIGATIONS).createIndex({ sourceFifoDatasetId:1, evidenceId:1 }, { unique:true });
  await db.collection(INVESTIGATIONS).createIndex({ sourceFifoDatasetId:1, priority:1, affectedSaleValue:-1 });
  await db.collection(INVESTIGATIONS).createIndex({ systemClassification:1, reviewStatus:1, assignedTo:1 });
  await db.collection(RECOVERY).createIndex({ candidateId:1 }, { unique:true });
  await db.collection(RECOVERY).createIndex({ sourceFifoDatasetId:1, purchaseLineIdentity:1 }, { unique:true });
  await db.collection(RECOVERY).createIndex({ sourceFifoDatasetId:1, confidence:-1, purchaseDate:1 });
  await db.collection(RECOVERY).createIndex({ status:1, confidence:-1, purchaseDate:1 });
  await db.collection(IDENTITIES).createIndex({ resolutionId:1 }, { unique:true });
  await db.collection(IDENTITIES).createIndex(
    { sourceFifoDatasetId:1, sourceItemCode:1, targetItemCode:1, targetItemGuid:1 },
    { unique:true }
  );
  await db.collection(IDENTITIES).createIndex({ sourceFifoDatasetId:1, confidence:-1, sourceItemCode:1 });
  await db.collection(IDENTITIES).createIndex({ status:1, confidence:-1, sourceItemCode:1 });
  await db.collection(RETURN_CASES).createIndex({ caseId:1 }, { unique:true });
  await db.collection(RETURN_CASES).createIndex({ kind:1, resolutionId:1 }, { unique:true });
  await db.collection(RETURN_CASES).createIndex({ sourceFifoDatasetId:1, kind:1, financialImpact:-1, confidence:-1 });
  await db.collection(RETURN_CASES).createIndex({ kind:1, confidenceBand:1, financialImpact:-1 });
  await db.collection(MANUAL_PACKAGES).createIndex({ packageId:1 }, { unique:true });
  await db.collection(MANUAL_PACKAGES).createIndex({ sourceFifoDatasetId:1, evidenceId:1 }, { unique:true });
  await db.collection(MANUAL_PACKAGES).createIndex({ sourceFifoDatasetId:1, status:1, projectedCoverageImprovement:-1 });
  await db.collection(MANUAL_PACKAGES).createIndex({ status:1, projectedCoverageImprovement:-1 });
  await db.collection(BATCHES).createIndex({ batchId:1 }, { unique:true });
  await db.collection(BATCHES).createIndex({ sourceFifoDatasetId:1, batchKey:1 }, { unique:true });
  await db.collection(BATCHES).createIndex({ status:1, updatedAt:-1 });
  return { ok:true, moduleVersion:MODULE_VERSION, collections:OWNED_COLLECTIONS };
}

async function activeContext(db) {
  const [sale, purchase, fifoState] = await Promise.all([
    saleSnapshot._activeDataset(db),
    purchaseLayerDataset.activeDataset(db),
    db.collection('fifoDatasetState').findOne({ scopeKey:readiness.ALGORITHM_VERSION })
  ]);
  if (!sale?.snapshotId || !purchase?.datasetId || !fifoState?.activeDatasetId) {
    fail('ACCOUNTING_REVIEW_SOURCE_MISSING', 'Sale Snapshot، Purchase Dataset یا FIFO v2 فعال موجود نیست.', 409);
  }
  const fifo = await db.collection('fifoDatasets').findOne({ datasetId:fifoState.activeDatasetId });
  if (!fifo || fifo.status !== 'completed' || fifo.activationStatus !== 'validated-shadow') {
    fail('ACCOUNTING_REVIEW_FIFO_INVALID', 'FIFO v2 فعال و validated-shadow نیست.', 409);
  }
  return { sale, purchase, fifo };
}

function invoiceLines(invoices) {
  const output = [];
  for (const invoice of invoices) {
    for (const [index, item] of (invoice.items || []).entries()) {
      const raw = item.raw || {};
      output.push({
        purchaseInvoiceIdentity:`3-${Number(invoice.invNo || 0)}-${clean(invoice.guId, 100)}`,
        purchaseLineIdentity:clean(raw.LineItemId || item.lineItemId, 100)
          ? `${clean(invoice.guId, 100) || `T3-N${Number(invoice.invNo || 0)}`}:${clean(raw.LineItemId || item.lineItemId, 100)}`
          : `T3-N${Number(invoice.invNo || 0)}-R${Number(item.row || index + 1)}-${clean(item.itemCode, 100)}`,
        invoiceNo:Number(invoice.invNo || 0),
        invoiceGuid:clean(invoice.guId, 100),
        purchaseDate:canonicalDate(invoice.invDate),
        supplierIdentity:clean(invoice.supplierAccountNo || invoice.supplierName, 200),
        supplierName:clean(invoice.supplierName, 300),
        itemGuid:clean(raw.ItemGuId || raw.ItemGuid || item.itemGuid, 100),
        itemCode:clean(item.itemCode || raw.ItemNumber, 100),
        itemDescription:clean(item.itemName || raw.ItemDescription, 500),
        quantity:finite(item.qty ?? raw.Quan),
        unitCostExact:exactUnitCost(item.unitCost ?? raw.Price),
        amountExact:exactMoney(item.lineAmount ?? raw.Amount),
        evidenceSource:'supplierPurchaseInvoices'
      });
    }
  }
  return output;
}

function mapByItem(rows) {
  const map = new Map();
  for (const row of rows) {
    for (const identity of [key(row.itemCode), key(row.itemGuid)].filter(Boolean)) {
      const list = map.get(identity) || [];
      list.push(row);
      map.set(identity, list);
    }
  }
  return map;
}

function matchesFor(row, map) {
  const seen = new Set();
  const values = [];
  for (const identity of [key(row.itemCode), key(row.itemGuid)].filter(Boolean)) {
    for (const match of map.get(identity) || []) {
      const marker = match.purchaseLineIdentity || match.layerId || JSON.stringify(match);
      if (!seen.has(marker)) { seen.add(marker); values.push(match); }
    }
  }
  return values;
}

function classifyEvidence(evidence, context) {
  const purchaseReturns = matchesFor(evidence, context.purchaseReturnMap);
  const saleReturns = matchesFor(evidence, context.saleReturnMap);
  const officialLayers = matchesFor(evidence, context.layerMap);
  const invoiceEvidence = matchesFor(evidence, context.invoiceMap);
  const identityCandidates = context.identityCandidates || [];
  let classification = 'insufficient_evidence';
  if (purchaseReturns.length) classification = 'purchase_return_dependency';
  else if (saleReturns.length) classification = 'sale_return_dependency';
  else if (officialLayers.length) classification = 'official_evidence_found';
  else if (invoiceEvidence.length) classification = 'official_layer_rebuild_candidate';
  else if (identityCandidates.length) classification = 'item_identity_repair_candidate';
  const confidence = classification === 'official_evidence_found' ? 90
    : classification === 'official_layer_rebuild_candidate' ? 85
      : classification.endsWith('_return_dependency') ? 80
        : classification === 'item_identity_repair_candidate' ? 65 : 10;
  return {
    classification,
    confidence,
    purchaseReturns,
    saleReturns,
    officialLayers,
    invoiceEvidence,
    identityCandidates,
    unresolvedQuestions:classification === 'official_evidence_found'
      ? ['آیا لایه رسمی قبل از فروش مصرف یا تمام شده است؟','آیا opening balance قدیمی‌تر لازم است؟']
      : classification === 'official_layer_rebuild_candidate'
        ? ['چرا invoice واقعی در dataset فعال لایه نشده است؟','آیا rebuild رسمی مجاز است؟']
        : classification.endsWith('_return_dependency')
          ? ['کدام سند اصلی باید توسط حسابداری تأیید شود؟']
          : ['آیا سند رسمی تاریخی یا valuation مستند خارج از داده فعلی وجود دارد؟'],
    recommendedNextAction:classification === 'official_layer_rebuild_candidate'
      ? 'verify-official-recovery-candidate'
      : classification === 'item_identity_repair_candidate'
        ? 'review-item-identity-candidate'
        : classification.endsWith('_return_dependency')
          ? 'review-return-linkage'
          : classification === 'official_evidence_found'
            ? 'review-layer-exhaustion-and-opening-history'
            : 'request-accounting-evidence'
  };
}

async function identityCandidatesFor(db, evidence) {
  const candidates = [];
  if (clean(evidence.itemCode)) {
    const sameCode = await db.collection('itemCatalogAll').find({ itemCode:clean(evidence.itemCode) }).limit(20).toArray();
    for (const row of sameCode) {
      if (key(evidence.itemGuid) && key(row.itemGuid) && key(evidence.itemGuid) !== key(row.itemGuid)) {
        candidates.push({
          sourceItemGuid:clean(evidence.itemGuid, 100), sourceItemCode:clean(evidence.itemCode, 100),
          targetItemGuid:clean(row.itemGuid, 100), targetItemCode:clean(row.itemCode, 100),
          reason:'GUID_changed', confidence:70,
          evidence:{ source:'itemCatalogAll', itemDescription:clean(row.itemDescription, 500) }
        });
      }
    }
  }
  if (clean(evidence.itemGuid)) {
    const sameGuid = await db.collection('itemCatalogAll').find({ itemGuid:clean(evidence.itemGuid) }).limit(20).toArray();
    for (const row of sameGuid) {
      if (key(row.itemCode) && key(row.itemCode) !== key(evidence.itemCode)) {
        candidates.push({
          sourceItemGuid:clean(evidence.itemGuid, 100), sourceItemCode:clean(evidence.itemCode, 100),
          targetItemGuid:clean(row.itemGuid, 100), targetItemCode:clean(row.itemCode, 100),
          reason:'code_changed', confidence:75,
          evidence:{ source:'itemCatalogAll', itemDescription:clean(row.itemDescription, 500) }
        });
      }
    }
  }
  return candidates.slice(0, 20);
}

async function upsertAudited(db, collectionName, identityQuery, create, refresh, by, action) {
  const collection = db.collection(collectionName);
  const existing = await collection.findOne(identityQuery);
  if (!existing) {
    const document = {
      ...create,
      revision:1,
      auditLog:[audit(action, by, { created:true })],
      createdAt:new Date(),
      updatedAt:new Date()
    };
    await collection.insertOne(document);
    return { document, created:true };
  }
  const next = {
    ...refresh,
    auditLog:[...(existing.auditLog || []), audit(`${action}-refreshed`, by, { revision:existing.revision })].slice(-200),
    updatedAt:new Date()
  };
  await collection.updateOne(identityQuery, { $set:next });
  return { document:{ ...existing, ...next }, created:false };
}

async function syncInvestigations(db, context, by) {
  const evidence = await db.collection(readiness.EVIDENCE).find({
    sourceActive:{ $ne:false }, priority:'P0'
  }).sort({ affectedSaleValue:-1 }).toArray();
  const [layers, invoices, purchaseReturns, saleReturns] = await Promise.all([
    db.collection(purchaseLayerDataset.LAYERS).find({ datasetId:context.purchase.datasetId }).toArray(),
    db.collection('supplierPurchaseInvoices').find({ invTyp:3 }).toArray(),
    db.collection(readiness.PURCHASE_RETURNS).find({}).toArray(),
    db.collection(readiness.SALE_RETURNS).find({}).toArray()
  ]);
  const officialInvoiceLines = invoiceLines(invoices);
  const layerRows = layers.filter(row => row.layerKind === 'purchase' && row.validationStatus !== 'rejected');
  const analysisContext = {
    layerMap:mapByItem(layerRows),
    invoiceMap:mapByItem(officialInvoiceLines),
    purchaseReturnMap:mapByItem(purchaseReturns),
    saleReturnMap:mapByItem(saleReturns)
  };
  let created = 0;
  const classificationCounts = {};
  const recoveryIds = new Set();
  const identityIds = new Set();
  for (const evidenceRow of evidence) {
    const identities = await identityCandidatesFor(db, evidenceRow);
    const result = classifyEvidence(evidenceRow, { ...analysisContext, identityCandidates:identities });
    classificationCounts[result.classification] = (classificationCounts[result.classification] || 0) + 1;
    const investigationId = deterministicId('AINVEST', `${context.fifo.datasetId}|${evidenceRow.evidenceId}`);
    const sourceReferences = {
      evidenceId:evidenceRow.evidenceId,
      fifoDatasetId:context.fifo.datasetId,
      saleSnapshotId:context.sale.snapshotId,
      purchaseDatasetId:context.purchase.datasetId
    };
    const diagnostic = {
      sourceReferences,
      invoiceReferences:result.invoiceEvidence.slice(0, 10).map(row => row.purchaseInvoiceIdentity),
      dates:{ firstSaleDate:evidenceRow.firstSaleDate, lastSaleDate:evidenceRow.lastSaleDate },
      itemIdentityEvidence:{
        itemGuid:evidenceRow.itemGuid, itemCode:evidenceRow.itemCode,
        officialLayerCount:result.officialLayers.length,
        invoiceEvidenceCount:result.invoiceEvidence.length,
        identityCandidateCount:identities.length
      },
      supplierEvidence:[...new Set(result.invoiceEvidence.map(row => row.supplierIdentity).filter(Boolean))].slice(0, 20),
      candidateCostSources:result.invoiceEvidence.slice(0, 10).map(row => ({
        purchaseLineIdentity:row.purchaseLineIdentity,
        unitCostExact:row.unitCostExact,
        purchaseDate:row.purchaseDate,
        supplierIdentity:row.supplierIdentity
      })),
      confidence:result.confidence,
      unresolvedQuestions:result.unresolvedQuestions,
      recommendedNextAction:result.recommendedNextAction
    };
    const saved = await upsertAudited(db, INVESTIGATIONS,
      { sourceFifoDatasetId:context.fifo.datasetId, evidenceId:evidenceRow.evidenceId },
      {
        investigationId, schemaVersion:SCHEMA_VERSION, moduleVersion:MODULE_VERSION,
        sourceFifoDatasetId:context.fifo.datasetId, evidenceId:evidenceRow.evidenceId,
        itemGuid:clean(evidenceRow.itemGuid, 100), itemCode:clean(evidenceRow.itemCode, 100),
        itemDescription:clean(evidenceRow.itemDescription, 500),
        priority:'P0', affectedSaleValue:finite(evidenceRow.affectedSaleValue),
        affectedQuantity:finite(evidenceRow.affectedQuantity), affectedSaleCount:finite(evidenceRow.affectedSaleCount),
        systemClassification:result.classification, reviewClassification:'',
        confidence:result.confidence, reviewStatus:'prepared', assignedTo:'',
        accountingNotes:'', createdBy:actor(by), diagnostic
      },
      { systemClassification:result.classification, confidence:result.confidence, diagnostic },
      by, 'p0-investigation'
    );
    if (saved.created) created++;
    for (const source of result.invoiceEvidence.slice(0, 5)) {
      if (result.officialLayers.some(layer =>
        clean(layer.purchaseLineIdentity) === clean(source.purchaseLineIdentity) ||
        (Number(layer.purchaseInvoiceNo) === source.invoiceNo && key(layer.itemCode) === key(source.itemCode))
      )) continue;
      const candidateId = deterministicId('PLREC', `${context.fifo.datasetId}|${source.purchaseLineIdentity}`);
      recoveryIds.add(candidateId);
      await upsertAudited(db, RECOVERY,
        { sourceFifoDatasetId:context.fifo.datasetId, purchaseLineIdentity:source.purchaseLineIdentity },
        {
          candidateId, schemaVersion:SCHEMA_VERSION, sourceFifoDatasetId:context.fifo.datasetId,
          sourceEvidenceId:evidenceRow.evidenceId, itemGuid:source.itemGuid || evidenceRow.itemGuid,
          itemCode:source.itemCode || evidenceRow.itemCode,
          purchaseInvoiceIdentity:source.purchaseInvoiceIdentity,
          purchaseLineIdentity:source.purchaseLineIdentity,
          supplierIdentity:source.supplierIdentity, purchaseDate:source.purchaseDate,
          purchaseQuantity:source.quantity, unitCostExact:source.unitCostExact,
          evidenceSource:source.evidenceSource, missingReason:'official-invoice-not-present-as-active-valid-layer',
          confidence:result.confidence, status:'detected', createdBy:actor(by),
          reviewedBy:null, approvedBy:null
        },
        {
          sourceEvidenceId:evidenceRow.evidenceId, itemGuid:source.itemGuid || evidenceRow.itemGuid,
          itemCode:source.itemCode || evidenceRow.itemCode, supplierIdentity:source.supplierIdentity,
          purchaseDate:source.purchaseDate, purchaseQuantity:source.quantity,
          unitCostExact:source.unitCostExact, confidence:result.confidence
        },
        by, 'official-recovery-candidate'
      );
    }
    for (const identity of identities) {
      const resolutionId = deterministicId('AIDENT', [
        context.fifo.datasetId, identity.sourceItemGuid, identity.sourceItemCode,
        identity.targetItemGuid, identity.targetItemCode
      ].join('|'));
      identityIds.add(resolutionId);
      await upsertAudited(db, IDENTITIES,
        {
          sourceFifoDatasetId:context.fifo.datasetId,
          sourceItemCode:identity.sourceItemCode,
          targetItemCode:identity.targetItemCode,
          targetItemGuid:identity.targetItemGuid
        },
        {
          resolutionId, schemaVersion:SCHEMA_VERSION, sourceFifoDatasetId:context.fifo.datasetId,
          sourceEvidenceId:evidenceRow.evidenceId, ...identity,
          effectiveFrom:'', effectiveTo:'', status:'detected',
          createdBy:actor(by), approvedBy:null
        },
        { confidence:identity.confidence, reason:identity.reason, evidence:identity.evidence },
        by, 'item-identity-candidate'
      );
    }
  }
  return {
    total:evidence.length,
    created,
    classificationCounts,
    recoveryCandidateCount:recoveryIds.size,
    identityCandidateCount:identityIds.size
  };
}

function purchaseCandidateDetails(resolution, layerByIdentity) {
  return (resolution.candidatePurchaseLayers || []).map(candidate => {
    const layer = layerByIdentity.get(clean(candidate.purchaseLineIdentity));
    if (!layer) return { ...candidate, evidenceAvailable:false };
    const quantityConsistent = finite(layer.originalQuantity || layer.quantity) >= finite(resolution.returnQuantity);
    const supplierConsistent = !key(resolution.supplierIdentity) ||
      [layer.supplierAccountNumber, layer.supplierName].some(value => key(value) === key(resolution.supplierIdentity));
    const itemConsistent = key(layer.itemCode) === key(resolution.itemCode) ||
      (key(layer.itemGuid) && key(layer.itemGuid) === key(resolution.itemGuid));
    const dateConsistent = !canonicalDate(layer.purchaseInvoiceDate) ||
      canonicalDate(layer.purchaseInvoiceDate) <= canonicalDate(resolution.returnDate);
    return {
      purchaseLineIdentity:clean(candidate.purchaseLineIdentity, 500),
      score:Number(candidate.score || 0),
      evidenceAvailable:true,
      purchaseInvoiceNo:Number(layer.purchaseInvoiceNo || 0),
      purchaseDate:canonicalDate(layer.purchaseInvoiceDate),
      supplierIdentity:clean(layer.supplierAccountNumber || layer.supplierName, 200),
      originalQuantity:finite(layer.originalQuantity || layer.quantity),
      remainingQuantity:finite(layer.remainingQuantity),
      unitCostExact:clean(layer.unitCostExact || layer.unitCost, 100),
      quantityConsistent, supplierConsistent, itemConsistent, dateConsistent,
      remainingLayerImpact:exactMoney(finite(layer.remainingQuantity) * finite(layer.unitCostExact || layer.unitCost))
    };
  }).sort((a,b) =>
    Number(b.itemConsistent)-Number(a.itemConsistent) ||
    Number(b.supplierConsistent)-Number(a.supplierConsistent) ||
    Number(b.quantityConsistent)-Number(a.quantityConsistent) ||
    b.score-a.score
  ).slice(0, 20);
}

function saleCandidateScore(resolution, returnLine, sale) {
  const reasons = [];
  let score = 0;
  const explicit = key(resolution.explicitReference || returnLine?.generalRef);
  if (explicit && [sale.saleGuid, sale.saleInvoiceNo, sale.generalRef].some(value => key(value) === explicit)) {
    score += 50; reasons.push('explicit-document-reference');
  }
  const guidMatch = key(resolution.itemGuid || returnLine?.itemGuid) &&
    key(resolution.itemGuid || returnLine?.itemGuid) === key(sale.itemGuid);
  const codeMatch = key(resolution.itemCode || returnLine?.itemCode) === key(sale.itemCode);
  if (guidMatch) { score += 20; reasons.push('item-guid'); }
  else if (codeMatch) { score += 15; reasons.push('item-code'); }
  const customer = key(resolution.customerIdentity || returnLine?.accountNumber);
  if (customer && [sale.accountNumber, sale.customerAccountNumber].some(value => key(value) === customer)) {
    score += 15; reasons.push('customer');
  }
  const compatibleQuantity = finite(sale.qty) >= finite(resolution.returnQuantity);
  if (compatibleQuantity) { score += 10; reasons.push('compatible-quantity'); }
  if (key(resolution.store || returnLine?.sellerStoreName) &&
      key(resolution.store || returnLine?.sellerStoreName) === key(sale.sellerStoreName)) {
    score += 5; reasons.push('store');
  }
  if (key(resolution.sellerIdentity || returnLine?.sellerAccountNumber) &&
      key(resolution.sellerIdentity || returnLine?.sellerAccountNumber) === key(sale.sellerAccountNumber)) {
    score += 5; reasons.push('seller');
  }
  const returnDate = canonicalDate(resolution.returnDate || returnLine?.saleDate);
  const saleDate = canonicalDate(sale.saleDate);
  const dateConsistent = !returnDate || !saleDate || saleDate <= returnDate;
  if (dateConsistent) { score += 5; reasons.push('sale-before-return'); }
  return {
    score:Math.min(100,score),
    reasons,
    compatibleQuantity,
    dateConsistent,
    deterministic:reasons.includes('explicit-document-reference') && (guidMatch || codeMatch) && compatibleQuantity
  };
}

function confidenceBand(candidate) {
  if (!candidate) return 'no_candidate';
  if (candidate.deterministic) return 'deterministic';
  if (candidate.score >= 60) return 'high_confidence';
  if (candidate.score >= 40) return 'medium_confidence';
  if (candidate.score > 0) return 'low_confidence';
  return 'no_candidate';
}

async function syncReturnCases(db, context, by) {
  const [purchaseResolutions, saleResolutions, layers, saleLines, allocations] = await Promise.all([
    db.collection(readiness.PURCHASE_RETURNS).find({}).toArray(),
    db.collection(readiness.SALE_RETURNS).find({}).toArray(),
    db.collection(purchaseLayerDataset.LAYERS).find({ datasetId:context.purchase.datasetId }).toArray(),
    db.collection(context.sale.lineCollection).find(context.sale.lineQuery).toArray(),
    db.collection('fifoAllocations').find({ datasetId:context.fifo.datasetId }).toArray()
  ]);
  const layerByIdentity = new Map(layers.map(row => [clean(row.purchaseLineIdentity, 500), row]));
  const lineByIdentity = new Map(saleLines.map(row => [clean(row.saleLineId, 500), row]));
  const salesByItem = mapByItem(saleLines.filter(row => Number(row.saleInvoiceType) === 2));
  const allocationsBySaleLine = new Map();
  for (const row of allocations.filter(item => Number(item.saleInvoiceType) === 2 && item.sourceType !== 'unknown_cost')) {
    const current = allocationsBySaleLine.get(row.saleLineId) || { quantity:0n, cost:0n };
    current.quantity += decimal.parse(row.quantityExact || row.allocatedQty || 0, decimal.QUANTITY_SCALE);
    current.cost += decimal.parse(row.allocatedCostAmountExact || row.allocatedCostAmount || 0, decimal.MONEY_SCALE);
    allocationsBySaleLine.set(row.saleLineId, current);
  }
  const result = { purchase:{total:purchaseResolutions.length,bands:{}}, sale:{total:saleResolutions.length,bands:{}} };
  for (const resolution of purchaseResolutions) {
    const candidates = purchaseCandidateDetails(resolution, layerByIdentity);
    const best = candidates[0] || null;
    const band = best && best.itemConsistent && best.supplierConsistent && best.quantityConsistent
      ? (best.score >= 85 ? 'high_confidence' : 'medium_confidence')
      : best ? 'low_confidence' : 'no_candidate';
    result.purchase.bands[band] = (result.purchase.bands[band] || 0) + 1;
    const caseId = deterministicId('ARETURN', `purchase|${resolution.resolutionId}`);
    await upsertAudited(db, RETURN_CASES, { kind:'purchase', resolutionId:resolution.resolutionId },
      {
        caseId, schemaVersion:SCHEMA_VERSION, kind:'purchase', resolutionId:resolution.resolutionId,
        sourceFifoDatasetId:context.fifo.datasetId, returnInvoiceIdentity:resolution.returnInvoiceIdentity,
        returnLineIdentity:resolution.returnLineIdentity, itemGuid:resolution.itemGuid,
        itemCode:resolution.itemCode, returnQuantity:resolution.returnQuantity,
        returnDate:resolution.returnDate, confidenceBand:band,
        confidence:best?.score || 0, confidenceReasons:best ? [
          best.itemConsistent && 'item', best.supplierConsistent && 'supplier',
          best.quantityConsistent && 'quantity', best.dateConsistent && 'date'
        ].filter(Boolean) : [],
        candidates, proposedLink:best?.purchaseLineIdentity || '',
        reversalProposal:null, financialImpact:finite(best?.remainingLayerImpact),
        reviewStatus:'prepared', assignedTo:'', accountingNotes:'', createdBy:actor(by)
      },
      { candidates, proposedLink:best?.purchaseLineIdentity || '', confidenceBand:band,
        confidence:best?.score || 0, financialImpact:finite(best?.remainingLayerImpact) },
      by, 'purchase-return-review-case'
    );
  }
  for (const resolution of saleResolutions) {
    const returnLine = lineByIdentity.get(resolution.returnLineIdentity);
    const source = {
      itemGuid:resolution.itemGuid || returnLine?.itemGuid,
      itemCode:resolution.itemCode || returnLine?.itemCode
    };
    const candidates = [];
    for (const sale of matchesFor(source, salesByItem)) {
      const scored = saleCandidateScore(resolution, returnLine, sale);
      if (!scored.score || !scored.dateConsistent) continue;
      const allocated = allocationsBySaleLine.get(sale.saleLineId) || { quantity:0n, cost:0n };
      const returned = decimal.parse(resolution.returnQuantity || 0, decimal.QUANTITY_SCALE);
      const reversible = returned < allocated.quantity ? returned : allocated.quantity;
      const proposedCost = allocated.quantity > 0n
        ? decimal.divideRounded(allocated.cost * reversible, allocated.quantity)
        : 0n;
      candidates.push({
        originalSaleLineId:sale.saleLineId,
        saleInvoiceNo:Number(sale.saleInvoiceNo || 0),
        saleDate:canonicalDate(sale.saleDate),
        customerIdentity:clean(sale.accountNumber || sale.customerAccountNumber, 200),
        itemGuid:clean(sale.itemGuid, 100), itemCode:clean(sale.itemCode, 100),
        originalSaleQuantityExact:exactQuantity(sale.qty),
        allocatedQuantityExact:decimal.format(allocated.quantity, decimal.QUANTITY_SCALE),
        allocatedCostExact:decimal.format(allocated.cost, decimal.MONEY_SCALE),
        proposedReversedQuantityExact:decimal.format(reversible, decimal.QUANTITY_SCALE),
        proposedReversedCostExact:decimal.format(proposedCost, decimal.MONEY_SCALE),
        remainingOriginalQuantityExact:decimal.format(allocated.quantity - reversible, decimal.QUANTITY_SCALE),
        score:scored.score, reasons:scored.reasons, deterministic:scored.deterministic,
        overAllocationPrevented:returned > allocated.quantity
      });
    }
    candidates.sort((a,b)=>b.score-a.score || Number(b.allocatedCostExact)-Number(a.allocatedCostExact));
    const best = candidates[0] || null;
    const deterministicCandidateCount = candidates.filter(candidate=>candidate.deterministic).length;
    const band = best?.deterministic && deterministicCandidateCount === 1
      ? 'deterministic'
      : best?.deterministic
        ? 'high_confidence'
        : confidenceBand(best);
    result.sale.bands[band] = (result.sale.bands[band] || 0) + 1;
    const caseId = deterministicId('ARETURN', `sale|${resolution.resolutionId}`);
    const proposal = best ? {
      originalSaleLineId:best.originalSaleLineId,
      originalSaleQuantityExact:best.originalSaleQuantityExact,
      returnedQuantityExact:exactQuantity(resolution.returnQuantity),
      originalAllocatedCostExact:best.allocatedCostExact,
      proposedReversedQuantityExact:best.proposedReversedQuantityExact,
      proposedReversedCostExact:best.proposedReversedCostExact,
      remainingOriginalQuantityExact:best.remainingOriginalQuantityExact,
      overAllocationPrevented:best.overAllocationPrevented
    } : null;
    await upsertAudited(db, RETURN_CASES, { kind:'sale', resolutionId:resolution.resolutionId },
      {
        caseId, schemaVersion:SCHEMA_VERSION, kind:'sale', resolutionId:resolution.resolutionId,
        sourceFifoDatasetId:context.fifo.datasetId, returnInvoiceIdentity:resolution.returnInvoiceIdentity,
        returnLineIdentity:resolution.returnLineIdentity, itemGuid:resolution.itemGuid,
        itemCode:resolution.itemCode, returnQuantity:resolution.returnQuantity,
        returnDate:resolution.returnDate, confidenceBand:band, confidence:best?.score || 0,
        confidenceReasons:best?.reasons || [], deterministicCandidateCount,
        candidates:candidates.slice(0, 20),
        proposedLink:best?.originalSaleLineId || '', reversalProposal:proposal,
        financialImpact:finite(best?.proposedReversedCostExact),
        reviewStatus:'prepared', assignedTo:'', accountingNotes:'', createdBy:actor(by)
      },
      { candidates:candidates.slice(0,20), proposedLink:best?.originalSaleLineId || '',
        reversalProposal:proposal, confidenceBand:band, confidence:best?.score || 0,
        confidenceReasons:best?.reasons || [], deterministicCandidateCount,
        financialImpact:finite(best?.proposedReversedCostExact) },
      by, 'sale-return-review-case'
    );
  }
  return result;
}

async function syncOperationalSamples(db, context, by) {
  const [allocations, returnCases] = await Promise.all([
    db.collection('fifoAllocations').find({ datasetId:context.fifo.datasetId }).toArray(),
    db.collection(RETURN_CASES).find({ sourceFifoDatasetId:context.fifo.datasetId }).toArray()
  ]);
  const invoiceMap = new Map();
  for (const row of allocations.filter(item => Number(item.saleInvoiceType) === 2)) {
    const invoice = invoiceMap.get(row.saleInvoiceNo) || { invoiceNo:row.saleInvoiceNo, saleValue:0, allocated:0, unknown:0, rows:[] };
    invoice.saleValue += finite(row.allocatedSaleValueExact || row.allocatedSaleValue);
    if (row.sourceType === 'unknown_cost') invoice.unknown += finite(row.allocatedSaleValueExact || row.allocatedSaleValue);
    else invoice.allocated += finite(row.allocatedCostAmountExact || row.allocatedCostAmount);
    invoice.rows.push(row);
    invoiceMap.set(row.saleInvoiceNo, invoice);
  }
  const invoices = [...invoiceMap.values()];
  const inputs = [
    ...invoices.filter(row=>row.unknown===0).sort((a,b)=>b.saleValue-a.saleValue).slice(0,10)
      .map(row=>({category:'operational_highest_value_fully_allocated',key:`2-${row.invoiceNo}`,source:row})),
    ...invoices.filter(row=>row.unknown>0&&row.unknown<row.saleValue).sort((a,b)=>b.saleValue-a.saleValue).slice(0,10)
      .map(row=>({category:'operational_highest_value_partially_allocated',key:`2-${row.invoiceNo}`,source:row})),
    ...returnCases.filter(row=>row.kind==='sale').sort((a,b)=>b.financialImpact-a.financialImpact).slice(0,5)
      .map(row=>({category:'operational_sale_return',key:row.caseId,source:row})),
    ...returnCases.filter(row=>row.kind==='purchase').sort((a,b)=>b.financialImpact-a.financialImpact).slice(0,5)
      .map(row=>({category:'operational_purchase_return',key:row.caseId,source:row}))
  ];
  let created = 0;
  for (const input of inputs) {
    const sampleKey = `${input.category}|${input.key}`;
    if (await db.collection(readiness.SAMPLES).findOne({ datasetId:context.fifo.datasetId, sampleKey })) continue;
    const source = input.source || {};
    const first = source.rows?.[0] || {};
    await db.collection(readiness.SAMPLES).insertOne({
      sampleId:deterministicId('ASAMPLE', `${context.fifo.datasetId}|${sampleKey}`),
      schemaVersion:SCHEMA_VERSION, datasetId:context.fifo.datasetId, sampleKey,
      category:input.category, sourceSaleInvoice:Number(source.invoiceNo || first.saleInvoiceNo || 0),
      saleLine:clean(source.returnLineIdentity || first.saleLineId, 500),
      itemGuid:clean(source.itemGuid || first.itemGuid, 100),
      itemCode:clean(source.itemCode || first.itemCode, 100),
      saleQuantity:finite(first.soldQuantity || first.allocatedQty || first.unknownQty),
      saleValueExact:exactMoney(source.saleValue || first.allocatedSaleValueExact || first.allocatedSaleValue),
      sourcePurchaseLayer:clean(first.purchaseLineIdentity, 500),
      purchaseInvoice:Number(first.purchaseInvoiceNo || 0),
      allocatedQuantity:finite(first.allocatedQty),
      unknownQuantity:finite(first.unknownQty),
      unitCostExact:clean(first.unitCostExact || first.unitCost, 100),
      allocationCostExact:clean(first.allocatedCostAmountExact || source.allocated || first.allocatedCostAmount, 100),
      returnEffect:boundedObject(source.reversalProposal || {}),
      manualEvidence:'', confidenceClassification:clean(source.confidenceBand || first.sourceConfidence || 'evidence-present', 100),
      unresolvedReason:clean(first.unknownReason || source.accountingNotes, 1000),
      sourceSnapshot:boundedObject({
        invoiceNo:source.invoiceNo, saleValue:source.saleValue, unknownValue:source.unknown,
        caseId:source.caseId, resolutionId:source.resolutionId, proposedLink:source.proposedLink
      }),
      reviewStatus:'not_reviewed', reviewNotes:'', revision:1,
      auditLog:[audit('operational-sample-created', by, { category:input.category })],
      createdAt:new Date(), updatedAt:new Date()
    });
    created++;
  }
  return { prepared:inputs.length, created, total:await count(db.collection(readiness.SAMPLES), { datasetId:context.fifo.datasetId }) };
}

async function prepareBatch(db, context, by) {
  const batchKey = 'phase5-2-8-p0-operational-review';
  const existing = await db.collection(BATCHES).findOne({ sourceFifoDatasetId:context.fifo.datasetId, batchKey });
  const [investigations, returnCases, packages, samples] = await Promise.all([
    db.collection(INVESTIGATIONS).find({ sourceFifoDatasetId:context.fifo.datasetId, priority:'P0' }).toArray(),
    db.collection(RETURN_CASES).find({ sourceFifoDatasetId:context.fifo.datasetId }).toArray(),
    db.collection(MANUAL_PACKAGES).find({ sourceFifoDatasetId:context.fifo.datasetId }).toArray(),
    db.collection(readiness.SAMPLES).find({ datasetId:context.fifo.datasetId }).toArray()
  ]);
  const references = {
    evidenceIds:investigations.map(row=>row.investigationId),
    purchaseReturnCaseIds:returnCases.filter(row=>row.kind==='purchase').map(row=>row.caseId),
    saleReturnCaseIds:returnCases.filter(row=>row.kind==='sale').map(row=>row.caseId),
    manualPackageIds:packages.map(row=>row.packageId),
    validationSampleIds:samples.map(row=>row.sampleId)
  };
  const itemCounts = Object.fromEntries(Object.entries(references).map(([name, list])=>[name,list.length]));
  const financialImpact = round(investigations.reduce((sum,row)=>sum+finite(row.affectedSaleValue),0),2);
  if (existing) {
    const next = {
      references, itemCounts, financialImpact,
      auditLog:[...(existing.auditLog || []),audit('review-batch-refreshed',by,{itemCounts})].slice(-200),
      updatedAt:new Date()
    };
    await db.collection(BATCHES).updateOne({ batchId:existing.batchId }, { $set:next });
    return { ...existing, ...next };
  }
  const batch = {
    batchId:deterministicId('ARBATCH', `${context.fifo.datasetId}|${batchKey}`),
    schemaVersion:SCHEMA_VERSION, batchKey, sourceFifoDatasetId:context.fifo.datasetId,
    title:'Phase 5.2.8 — P0 Operational Accounting Review',
    createdBy:actor(by), assignedAccountingUser:'', assignedManagerUser:'',
    itemCounts, financialImpact, references, status:'prepared',
    startedAt:null, completedAt:null, revision:1,
    auditLog:[audit('review-batch-prepared',by,{itemCounts})],
    createdAt:new Date(), updatedAt:new Date()
  };
  await db.collection(BATCHES).insertOne(batch);
  return batch;
}

async function synchronize(db, by = {}) {
  const current = requireRole(by, ['admin','accounting']);
  await ensureIndexes(db);
  const context = await activeContext(db);
  const startedAt = Date.now();
  const startHeap = process.memoryUsage().heapUsed;
  const investigations = await syncInvestigations(db, context, current);
  const returns = await syncReturnCases(db, context, current);
  const samples = await syncOperationalSamples(db, context, current);
  const batch = await prepareBatch(db, context, current);
  return {
    ok:true, moduleVersion:MODULE_VERSION,
    sourceFifoDatasetId:context.fifo.datasetId,
    sourceSaleSnapshotId:context.sale.snapshotId,
    sourcePurchaseDatasetId:context.purchase.datasetId,
    investigations, returns, samples,
    batch:{ batchId:batch.batchId, status:batch.status, itemCounts:batch.itemCounts },
    durationMs:Date.now()-startedAt,
    heapDeltaBytes:Math.max(0,process.memoryUsage().heapUsed-startHeap),
    businessDocumentWrites:0, sourceCollectionWrites:0,
    automaticApprovals:0, shadowMode:true, accountingApproved:false,
    profitActivationAllowed:false
  };
}

const TYPE_TO_COLLECTION = Object.freeze({
  investigations:INVESTIGATIONS,
  recovery:RECOVERY,
  identities:IDENTITIES,
  returns:RETURN_CASES,
  manualPackages:MANUAL_PACKAGES,
  batches:BATCHES,
  samples:readiness.SAMPLES
});

async function list(db, type, filters = {}) {
  await ensureIndexes(db);
  const collectionName = TYPE_TO_COLLECTION[type];
  if (!collectionName) fail('ACCOUNTING_REVIEW_LIST_INVALID', 'نوع لیست معتبر نیست.');
  const context = await activeContext(db);
  const query = type === 'samples'
    ? { datasetId:context.fifo.datasetId }
    : { sourceFifoDatasetId:context.fifo.datasetId };
  if (filters.status) query[type === 'returns' || type === 'investigations' ? 'reviewStatus' : 'status'] = clean(filters.status, 80);
  if (filters.classification && type === 'investigations') query.systemClassification = clean(filters.classification, 100);
  if (filters.priority && type === 'investigations') query.priority = clean(filters.priority, 10);
  if (filters.kind && type === 'returns') query.kind = clean(filters.kind, 20);
  if (filters.confidenceBand && type === 'returns') query.confidenceBand = clean(filters.confidenceBand, 40);
  const page = Math.max(1,Number(filters.page||1));
  const pageSize = Math.max(1,Math.min(Number(filters.pageSize||50),500));
  const sort = type === 'investigations' ? { priority:1, affectedSaleValue:-1 }
    : type === 'returns' ? { financialImpact:-1, confidence:-1 }
      : type === 'recovery' ? { confidence:-1, purchaseDate:1 }
        : { updatedAt:-1 };
  const total = await count(db.collection(collectionName), query);
  const rows = await db.collection(collectionName).find(query).sort(sort).skip((page-1)*pageSize).limit(pageSize).toArray();
  const search = key(filters.search);
  const filtered = search
    ? rows.filter(row=>key(`${row.itemCode} ${row.itemDescription} ${row.evidenceId} ${row.resolutionId} ${row.caseId}`).includes(search))
    : rows;
  return { ok:true,type,total,page,pageSize,list:filtered,sourceFifoDatasetId:context.fifo.datasetId,shadowMode:true,accountingApproved:false };
}

async function transitionReview(db, type, recordId, input, by) {
  const current = requireRole(by);
  const mapping = {
    investigations:{collection:INVESTIGATIONS,id:'investigationId',statuses:REVIEW_STATUSES},
    returns:{collection:RETURN_CASES,id:'caseId',statuses:REVIEW_STATUSES},
    recovery:{collection:RECOVERY,id:'candidateId',statuses:RECOVERY_STATUSES},
    identities:{collection:IDENTITIES,id:'resolutionId',statuses:IDENTITY_STATUSES}
  }[type];
  if (!mapping) fail('ACCOUNTING_REVIEW_TRANSITION_INVALID', 'نوع workflow معتبر نیست.');
  const row = await db.collection(mapping.collection).findOne({ [mapping.id]:clean(recordId,100) });
  if (!row) fail('ACCOUNTING_REVIEW_RECORD_NOT_FOUND', 'رکورد بررسی پیدا نشد.', 404);
  if (Number(input.revision) !== Number(row.revision)) fail('ACCOUNTING_REVIEW_CONFLICT', 'Revision رکورد منقضی شده است.', 409);
  const status = clean(input.status,80);
  if (!mapping.statuses.includes(status)) fail('ACCOUNTING_REVIEW_STATUS_INVALID', 'وضعیت workflow معتبر نیست.');
  const isApproval = status === 'approved_for_dataset_rebuild' || status === 'approved';
  if (isApproval) {
    if (!['accounting','manager'].includes(current.role)) fail('ACCOUNTING_REVIEW_APPROVAL_FORBIDDEN','فقط کاربر انسانی Accounting یا Manager می‌تواند تأیید کند.',403);
    if (actor(row.createdBy).username === current.username) fail('ACCOUNTING_REVIEW_SELF_APPROVAL','Creator نمی‌تواند تصمیم خود را تأیید کند.',409);
    if (!clean(input.reason) || !clean(input.evidenceReference)) fail('ACCOUNTING_REVIEW_APPROVAL_EVIDENCE_REQUIRED','دلیل و مرجع Evidence برای تأیید الزامی است.');
  }
  const next = {
    [type === 'investigations' || type === 'returns' ? 'reviewStatus' : 'status']:status,
    assignedTo:clean(input.assignedTo ?? row.assignedTo,100),
    accountingNotes:clean(input.accountingNotes ?? input.reason ?? row.accountingNotes,3000),
    evidenceReference:clean(input.evidenceReference ?? row.evidenceReference,500),
    reviewedBy:current, reviewedAt:new Date(),
    approvedBy:isApproval ? current : row.approvedBy || null,
    revision:Number(row.revision)+1,
    auditLog:[...(row.auditLog||[]),audit('human-workflow-transition',current,{
      fromStatus:row.reviewStatus||row.status,toStatus:status,reason:input.reason
    })].slice(-200),
    updatedAt:new Date()
  };
  const result = await db.collection(mapping.collection).updateOne(
    { [mapping.id]:row[mapping.id], revision:row.revision }, { $set:next }
  );
  if (!result.matchedCount) fail('ACCOUNTING_REVIEW_CONFLICT','Revision رکورد هم‌زمان تغییر کرده است.',409);
  return { ok:true,record:{...row,...next},accountingApproved:false,profitActivationAllowed:false };
}

async function createManualPackage(db, input, by) {
  const current = requireRole(by, ['admin','accounting']);
  await ensureIndexes(db);
  const context = await activeContext(db);
  const evidenceId = clean(input.evidenceId,100);
  const evidence = await db.collection(readiness.EVIDENCE).findOne({ evidenceId, sourceActive:{ $ne:false } });
  if (!evidence) fail('MANUAL_PACKAGE_EVIDENCE_NOT_FOUND','Evidence فعال پیدا نشد.',404);
  if (input.sourceAmount == null || clean(input.sourceAmount) === '' || finite(input.sourceAmount) <= 0) {
    fail('MANUAL_PACKAGE_AMOUNT_REQUIRED','Draft فقط با مبلغ منبع صریح و مستند قابل ایجاد است.');
  }
  if (!clean(input.documentedSource) || !clean(input.evidenceReference)) {
    fail('MANUAL_PACKAGE_DOCUMENT_REQUIRED','منبع مستند و مرجع Evidence الزامی است.');
  }
  const packageId=deterministicId('MCEPKG',`${context.fifo.datasetId}|${evidenceId}`);
  if (await db.collection(MANUAL_PACKAGES).findOne({ packageId })) fail('MANUAL_PACKAGE_DUPLICATE','برای این Evidence قبلاً package ایجاد شده است.',409);
  const totalSaleValue=finite(context.fifo.summary?.saleValue);
  const packageRow={
    packageId,schemaVersion:SCHEMA_VERSION,sourceFifoDatasetId:context.fifo.datasetId,evidenceId,
    itemGuid:evidence.itemGuid,itemCode:evidence.itemCode,itemDescription:evidence.itemDescription,
    affectedInvoices:Number(evidence.affectedSaleCount||0),affectedSaleQuantity:finite(evidence.affectedQuantity),
    affectedSaleValue:finite(evidence.affectedSaleValue),
    proposedEffectiveFrom:canonicalDate(input.effectiveFrom||evidence.firstSaleDate),
    proposedEffectiveTo:canonicalDate(input.effectiveTo||evidence.lastSaleDate),
    documentedSource:clean(input.documentedSource,200),
    sourceAmountExact:exactMoney(input.sourceAmount),sourcePrecision:decimal.MONEY_SCALE,
    sourceCurrency:clean(input.currency||'IRR',20),
    officialEvidenceUnavailableReason:clean(input.officialEvidenceUnavailableReason,1000),
    evidenceReference:clean(input.evidenceReference,500),
    attachmentMetadata:boundedObject(input.attachmentMetadata||{}),
    accountingQuestions:Array.isArray(input.accountingQuestions)?input.accountingQuestions.slice(0,20).map(x=>clean(x,500)):[],
    projectedCoverageImprovement:percentage(evidence.affectedSaleValue,totalSaleValue),
    projectedConfidenceImprovement:finite(evidence.projectedConfidenceImprovement),
    status:'draft',createdBy:current,submittedBy:null,approvedBy:null,revision:1,
    auditLog:[audit('manual-cost-evidence-package-draft',current,{evidenceId,documentedSource:input.documentedSource})],
    createdAt:new Date(),updatedAt:new Date()
  };
  await db.collection(MANUAL_PACKAGES).insertOne(packageRow);
  return {ok:true,package:packageRow,automaticApproval:false,manualCostResolutionCreated:false};
}

async function createBatch(db, input, by) {
  const current=requireRole(by,['admin','accounting']);
  await ensureIndexes(db);
  const context=await activeContext(db);
  const title=clean(input.title,300);
  if(!title)fail('ACCOUNTING_BATCH_TITLE_REQUIRED','عنوان batch الزامی است.');
  const accountingUser=clean(input.assignedAccountingUser,100);
  const managerUser=clean(input.assignedManagerUser,100);
  if(accountingUser){
    const user=await db.collection('users').findOne({username:accountingUser,role:'accounting',isActive:true});
    if(!user)fail('ACCOUNTING_BATCH_ASSIGNEE_INVALID','کاربر Accounting معتبر نیست.');
  }
  if(managerUser){
    const user=await db.collection('users').findOne({username:managerUser,role:'manager',isActive:true});
    if(!user)fail('ACCOUNTING_BATCH_MANAGER_INVALID','کاربر Manager معتبر نیست.');
  }
  const ids=Array.isArray(input.recordIds)?[...new Set(input.recordIds.map(x=>clean(x,100)).filter(Boolean))].slice(0,2000):[];
  if(!ids.length)fail('ACCOUNTING_BATCH_ITEMS_REQUIRED','حداقل یک شناسه immutable برای batch لازم است.');
  const batchKey=clean(input.batchKey,100)||crypto.randomBytes(8).toString('hex');
  const batchId=deterministicId('ARBATCH',`${context.fifo.datasetId}|${batchKey}`);
  if(await db.collection(BATCHES).findOne({batchId}))fail('ACCOUNTING_BATCH_DUPLICATE','Batch تکراری است.',409);
  const batch={batchId,schemaVersion:SCHEMA_VERSION,batchKey,sourceFifoDatasetId:context.fifo.datasetId,
    title,createdBy:current,assignedAccountingUser:accountingUser,assignedManagerUser:managerUser,
    itemCounts:{records:ids.length},financialImpact:finite(input.financialImpact),references:{recordIds:ids},
    status:'prepared',startedAt:null,completedAt:null,revision:1,
    auditLog:[audit('review-batch-created',current,{records:ids.length})],createdAt:new Date(),updatedAt:new Date()};
  await db.collection(BATCHES).insertOne(batch);
  return {ok:true,batch};
}

async function transitionBatch(db,batchId,input,by){
  const current=requireRole(by);
  const row=await db.collection(BATCHES).findOne({batchId:clean(batchId,100)});
  if(!row)fail('ACCOUNTING_BATCH_NOT_FOUND','Batch پیدا نشد.',404);
  if(Number(input.revision)!==Number(row.revision))fail('ACCOUNTING_BATCH_CONFLICT','Revision batch منقضی است.',409);
  const status=clean(input.status,50);
  if(!BATCH_STATUSES.includes(status))fail('ACCOUNTING_BATCH_STATUS_INVALID','وضعیت batch معتبر نیست.');
  const next={status,startedAt:status==='in_review'?(row.startedAt||new Date()):row.startedAt,
    completedAt:status==='completed'?new Date():null,revision:Number(row.revision)+1,
    auditLog:[...(row.auditLog||[]),audit('batch-transition',current,{fromStatus:row.status,toStatus:status,note:input.note})].slice(-200),
    updatedAt:new Date()};
  const result=await db.collection(BATCHES).updateOne({batchId:row.batchId,revision:row.revision},{$set:next});
  if(!result.matchedCount)fail('ACCOUNTING_BATCH_CONFLICT','Batch هم‌زمان تغییر کرده است.',409);
  return {ok:true,batch:{...row,...next},itemApprovalsImplied:false,accountingApproved:false};
}

async function impactReport(db) {
  await ensureIndexes(db);
  const context=await activeContext(db);
  const [base,investigations,recovery,identities,returns,packages,samples,batches] = await Promise.all([
    readiness.readinessReport(db,context.fifo.datasetId),
    db.collection(INVESTIGATIONS).find({sourceFifoDatasetId:context.fifo.datasetId}).toArray(),
    db.collection(RECOVERY).find({sourceFifoDatasetId:context.fifo.datasetId}).toArray(),
    db.collection(IDENTITIES).find({sourceFifoDatasetId:context.fifo.datasetId}).toArray(),
    db.collection(RETURN_CASES).find({sourceFifoDatasetId:context.fifo.datasetId}).toArray(),
    db.collection(MANUAL_PACKAGES).find({sourceFifoDatasetId:context.fifo.datasetId}).toArray(),
    db.collection(readiness.SAMPLES).find({datasetId:context.fifo.datasetId}).toArray(),
    db.collection(BATCHES).find({sourceFifoDatasetId:context.fifo.datasetId}).toArray()
  ]);
  const projectedClassifications=new Set([
    'official_evidence_found','official_layer_rebuild_candidate',
    'item_identity_repair_candidate','manual_cost_evidence_found'
  ]);
  const projectedRows=investigations.filter(row=>projectedClassifications.has(row.systemClassification));
  const projectedRecoverableValue=round(projectedRows.reduce((sum,row)=>sum+finite(row.affectedSaleValue),0),2);
  const p0ValueUnderReview=round(investigations.reduce((sum,row)=>sum+finite(row.affectedSaleValue),0),2);
  const totalSaleValue=finite(base.confidence?.totals?.saleValueExact);
  const currentCoveredValue=totalSaleValue-finite(base.evidence?.affectedSaleValue);
  const linkedPotential=returns.filter(row=>['deterministic','high_confidence'].includes(row.confidenceBand)).length;
  const actualApproved={
    recoveryCandidates:recovery.filter(row=>row.status==='approved_for_dataset_rebuild').length,
    identityResolutions:identities.filter(row=>row.status==='approved').length,
    manualPackages:packages.filter(row=>row.status==='approved').length,
    returnLinks:base.returns.purchase.confirmed+base.returns.sale.confirmed,
    accountingReviewedSamples:samples.filter(row=>['accounting_confirmed','accounting_disputed'].includes(row.reviewStatus)).length
  };
  return {
    ok:true,moduleVersion:MODULE_VERSION,sourceFifoDatasetId:context.fifo.datasetId,
    sourceSaleSnapshotId:context.sale.snapshotId,sourcePurchaseDatasetId:context.purchase.datasetId,
    baseline:{
      confidenceIndex:base.confidence.index,gateStatus:base.gate.status,
      officialQuantityCoverage:base.confidence.components.officialEvidenceCoverage,
      saleValueCostCoverage:base.confidence.components.saleValueCostCoverage,
      approvedManualCoverage:base.confidence.components.manualEvidenceCoverage,
      returnLinkageCoverage:base.confidence.components.returnLinkageCoverage,
      accountingReviewCoverage:base.confidence.components.accountingReviewCoverage,
      actualUnknownSaleValue:base.evidence.affectedSaleValue
    },
    actualApproved,
    projected:{
      p0ValueUnderReview,
      recoverableUnknownValue:projectedRecoverableValue,
      saleValueCoverageAfterApprovedCandidateRecovery:percentage(currentCoveredValue+projectedRecoverableValue,totalSaleValue),
      returnLinkageCandidateCount:linkedPotential,
      returnLinkagePotentialPercent:percentage(linkedPotential,returns.length),
      recoveryCandidates:recovery.length,identityCandidates:identities.length,
      manualEvidencePackages:packages.length
    },
    counts:{
      investigations:investigations.length,recovery:recovery.length,identities:identities.length,
      purchaseReturnCases:returns.filter(row=>row.kind==='purchase').length,
      saleReturnCases:returns.filter(row=>row.kind==='sale').length,
      validationSamples:samples.length,reviewBatches:batches.length
    },
    classifications:Object.fromEntries(CLASSIFICATIONS.map(name=>[
      name,investigations.filter(row=>row.systemClassification===name).length
    ])),
    returnConfidenceBands:Object.fromEntries(
      ['deterministic','high_confidence','medium_confidence','low_confidence','no_candidate'].map(name=>[
        name,returns.filter(row=>row.confidenceBand===name).length
      ])
    ),
    gate:base.gate,
    safeguards:{
      businessDocumentWrites:0,shayganBusinessWrites:0,sourceCollectionWrites:0,
      automaticManualCostApprovals:0,automaticReturnConfirmations:0,
      profitCalculated:false,roiCalculated:false,commissionCalculated:false,
      importImplemented:false,importReason:'Offline decision import is disabled because it cannot prove an interactive authorized human session.'
    },
    accountingApproved:false,profitActivationAllowed:false,shadowMode:true
  };
}

async function exportReview(db, filters = {}) {
  const context=await activeContext(db);
  const rows=await db.collection(INVESTIGATIONS).find({
    sourceFifoDatasetId:context.fifo.datasetId,
    ...(filters.priority?{priority:clean(filters.priority,10)}:{})
  }).sort({priority:1,affectedSaleValue:-1}).limit(5000).toArray();
  return {
    ok:true,formatVersion:'accounting-review-export-1.0.0',
    exportedAt:new Date().toISOString(),sourceFifoDatasetId:context.fifo.datasetId,
    immutableColumns:['investigationId','evidenceId','sourceFifoDatasetId','revision'],
    decisionImportAllowed:false,
    rows:rows.map(row=>({
      investigationId:row.investigationId,evidenceId:row.evidenceId,
      sourceFifoDatasetId:row.sourceFifoDatasetId,revision:row.revision,
      priority:row.priority,itemCode:row.itemCode,itemDescription:row.itemDescription,
      affectedSaleValue:row.affectedSaleValue,affectedQuantity:row.affectedQuantity,
      systemClassification:row.systemClassification,confidence:row.confidence,
      reviewStatus:row.reviewStatus,recommendedNextAction:row.diagnostic?.recommendedNextAction,
      unresolvedQuestions:(row.diagnostic?.unresolvedQuestions||[]).join(' | ')
    }))
  };
}

module.exports={
  INVESTIGATIONS,RECOVERY,IDENTITIES,RETURN_CASES,MANUAL_PACKAGES,BATCHES,
  SCHEMA_VERSION,MODULE_VERSION,OWNED_COLLECTIONS,CLASSIFICATIONS,
  ensureIndexes,synchronize,list,transitionReview,createManualPackage,
  createBatch,transitionBatch,impactReport,exportReview,
  _classifyEvidence:classifyEvidence,
  _saleCandidateScore:saleCandidateScore,
  _confidenceBand:confidenceBand,
  _purchaseCandidateDetails:purchaseCandidateDetails
};
