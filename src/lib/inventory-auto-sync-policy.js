'use strict';

const crypto = require('crypto');

const INVENTORY_DISCOVERY_QUEUE = 'inventoryDiscoveryVerificationQueue';
const QUEUE_CLASSES = Object.freeze({
  NEW_IDENTITY:'NEW_IDENTITY',
  STALE_POSITIVE:'STALE_POSITIVE'
});
const GETREMAIN_VALIDITY = Object.freeze({
  VALID_DATA:'VALID_DATA',
  VALID_ZERO:'VALID_ZERO',
  UNAVAILABLE_OR_SUSPECT:'UNAVAILABLE_OR_SUSPECT'
});
const OPERATIONAL_DISCOVERY_SOURCES = new Set([
  'canonical-purchase-engine',
  'canonical-sale-snapshot',
  'auto-active-stock-filter-positive'
]);

function clean(value, max = 300) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

function isOperationalDiscoverySource(source) {
  return OPERATIONAL_DISCOVERY_SOURCES.has(clean(source, 100));
}

function discoveryQueueId(identity, queueClass = QUEUE_CLASSES.NEW_IDENTITY) {
  const key = `${clean(queueClass, 50)}|${clean(identity, 300)}`;
  return `IVQ-${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`;
}

function missingVerificationSort() {
  // Every attempt, including a timeout, advances lastLiveAttemptAt. This keeps
  // one slow Shaygan item from monopolizing every reconciliation cycle.
  return { nextLiveVerifyEligibleAt:1, lastLiveAttemptAt:1, firstMissingInStockAt:1, _id:1 };
}

function discoveryVerificationSort() {
  return { nextEligibleAt:1, firstQueuedAt:1, lastAttemptAt:1, _id:1 };
}

function eligibleAtFilter(now = new Date()) {
  return { $or:[{ nextEligibleAt:{ $exists:false } }, { nextEligibleAt:null }, { nextEligibleAt:{ $lte:now } }] };
}

function staleEligibleAtFilter(now = new Date()) {
  return { $or:[{ nextLiveVerifyEligibleAt:{ $exists:false } }, { nextLiveVerifyEligibleAt:null }, { nextLiveVerifyEligibleAt:{ $lte:now } }] };
}

function broadMissingEligibleFilter(recheckBefore = new Date()) {
  return { $or:[
    { lastAuthoritativeExactAt:{ $exists:false } },
    { lastAuthoritativeExactAt:null },
    { lastAuthoritativeExactAt:{ $lte:recheckBefore } }
  ] };
}

function timestamp(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function newestLocalEvidenceAt(existing = {}) {
  return Math.max(
    timestamp(existing.lastLocalSaleDeductAt),
    timestamp(existing.lastLocalInventoryMutationAt),
    timestamp(existing.lastInvoiceInventoryMutationAt),
    timestamp(existing.localEvidenceAt)
  );
}

function hasNewerLocalEvidence(existing = {}, observationStartedAt) {
  const boundary = timestamp(observationStartedAt);
  return boundary > 0 && newestLocalEvidenceAt(existing) > boundary;
}

function hasNewerExactEvidence(existing = {}, observationCompletedAt) {
  const boundary = timestamp(observationCompletedAt);
  return boundary > 0 && timestamp(existing.lastAuthoritativeExactAt) > boundary;
}

function shouldProtectExactFromBroad(existing = {}, incoming = {}, context = {}) {
  // Exact evidence has no timeless precedence. A complete, healthy warehouse
  // snapshot supersedes exact evidence observed before the snapshot began.
  if (context.acceptedCompleteWarehouseSnapshot === true) {
    return hasNewerLocalEvidence(existing, context.observationStartedAt)
      || hasNewerExactEvidence(existing, context.observationCompletedAt);
  }
  const exact = existing.inventoryAuthority === 'exact-getremain' || Boolean(existing.lastAuthoritativeExactAt);
  if (!exact) return false;
  return Number(existing.quantity || 0) !== Number(incoming.quantity ?? incoming.Quantity1 ?? 0);
}

function inventoryIdentity(row = {}, warehouse = '') {
  return `${clean(row.itemCode ?? row.ItemCode, 200)}::${clean(row.stockNumber ?? row.STNumber ?? warehouse, 100)}`;
}

function planAcceptedWarehouseSnapshot({ existingRows = [], snapshotRows = [], warehouse = '', observationStartedAt, observationCompletedAt } = {}) {
  const stockNumber = clean(warehouse, 100);
  if (!stockNumber) throw new TypeError('warehouse required');
  if (!timestamp(observationStartedAt)) throw new TypeError('observationStartedAt required');

  const existingByKey = new Map();
  for (const row of existingRows || []) {
    const key = inventoryIdentity(row, stockNumber);
    if (key !== `::${stockNumber}`) existingByKey.set(key, row);
  }
  const snapshotByKey = new Map();
  for (const row of snapshotRows || []) {
    const quantity = Number(row?.quantity ?? row?.Quantity1 ?? 0);
    const key = inventoryIdentity(row, stockNumber);
    if (key === `::${stockNumber}` || !Number.isFinite(quantity) || quantity <= 0) continue;
    snapshotByKey.set(key, { ...row, stockNumber:clean(row.stockNumber ?? row.STNumber ?? stockNumber, 100), quantity });
  }

  const positives = [];
  const absences = [];
  const protectedLocal = [];
  const quantityDirections = { newRows:0, increases:0, decreases:0, unchanged:0, precedenceConflicts:0, localSaleProtected:0 };
  for (const [key, row] of snapshotByKey) {
    const existing = existingByKey.get(key) || null;
    if (existing && (hasNewerLocalEvidence(existing, observationStartedAt) || hasNewerExactEvidence(existing, observationCompletedAt))) {
      const reason = hasNewerLocalEvidence(existing, observationStartedAt) ? 'local-evidence-newer-than-snapshot-observation' : 'exact-evidence-newer-than-snapshot-completion';
      protectedLocal.push({ key, existing, incoming:row, reason });
      quantityDirections.localSaleProtected++;
      continue;
    }
    quantityDirections[classifyBroadQuantityDirection(existing, row)]++;
    positives.push({ key, existing, incoming:row });
  }
  for (const [key, existing] of existingByKey) {
    if (snapshotByKey.has(key)) continue;
    const requiresReconciliation = Number(existing.quantity || 0) > 0
      || existing.needsLiveVerify === true
      || existing.protectedFromAutoSyncStale === true
      || existing.missingInStockSync === true;
    if (!requiresReconciliation) continue;
    if (hasNewerLocalEvidence(existing, observationStartedAt) || hasNewerExactEvidence(existing, observationCompletedAt)) {
      const reason = hasNewerLocalEvidence(existing, observationStartedAt) ? 'local-evidence-newer-than-snapshot-observation' : 'exact-evidence-newer-than-snapshot-completion';
      protectedLocal.push({ key, existing, incoming:null, reason });
      quantityDirections.localSaleProtected++;
      continue;
    }
    absences.push({ key, existing });
  }
  return {
    stockNumber,
    positives,
    absences,
    protectedLocal,
    previousPositiveRows:(existingRows || []).filter(row => Number(row.quantity || 0) > 0).length,
    newPositiveRows:positives.filter(entry => !entry.existing || Number(entry.existing.quantity || 0) <= 0).length,
    missingToZero:absences.filter(entry => Number(entry.existing.quantity || 0) > 0).length,
    clearedLegacyPending:[...positives, ...absences].filter(entry => entry.existing?.needsLiveVerify === true || entry.existing?.protectedFromAutoSyncStale === true || entry.existing?.missingInStockSync === true).length,
    quantityDirections
  };
}

function classifyBroadQuantityDirection(existing, incoming = {}) {
  if (!existing) return 'newRows';
  const current = Number(existing.quantity || 0);
  const next = Number(incoming.quantity ?? incoming.Quantity1 ?? 0);
  if (next > current) return 'increases';
  if (next < current) return 'decreases';
  return 'unchanged';
}

function finiteNonNegative(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function quantity1(row = {}) {
  const value = row.Quantity1 ?? row.quantity ?? row.RemainQ ?? row.Quantity ?? null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizedCode(value) {
  return clean(value, 200).toUpperCase();
}

function exactGetRemainHealth(response = {}, expectedItemCode = '') {
  const rawRows = Array.isArray(response.result) ? response.result : [];
  const resultShapeValid = response.resultIsArray !== false && Array.isArray(response.result);
  if (response.ok === false || !resultShapeValid) {
    return { validity:GETREMAIN_VALIDITY.UNAVAILABLE_OR_SUSPECT, trustworthy:false, reason:response.error || (!resultShapeValid ? 'getremain-result-not-array' : 'getremain-source-error'), rawRows:rawRows.length, positiveRows:0, explicitZeroRows:0 };
  }
  const expected = normalizedCode(expectedItemCode);
  const matching = expected ? rawRows.filter(row => normalizedCode(row.ItemCode ?? row.itemCode ?? row.ProductCode) === expected) : rawRows;
  if (rawRows.length && expected && !matching.length) {
    return { validity:GETREMAIN_VALIDITY.UNAVAILABLE_OR_SUSPECT, trustworthy:false, reason:'exact-item-identity-mismatch', rawRows:rawRows.length, positiveRows:0, explicitZeroRows:0 };
  }
  const quantities = matching.map(quantity1);
  if (quantities.some(value => value === null)) {
    return { validity:GETREMAIN_VALIDITY.UNAVAILABLE_OR_SUSPECT, trustworthy:false, reason:'exact-item-invalid-quantity', rawRows:rawRows.length, positiveRows:0, explicitZeroRows:0 };
  }
  const positiveRows = quantities.filter(value => value > 0).length;
  const explicitZeroRows = quantities.filter(value => value === 0).length;
  if (positiveRows) return { validity:GETREMAIN_VALIDITY.VALID_DATA, trustworthy:true, reason:'exact-positive-data', rawRows:rawRows.length, positiveRows, explicitZeroRows };
  if (matching.length && explicitZeroRows === matching.length) return { validity:GETREMAIN_VALIDITY.VALID_ZERO, trustworthy:true, reason:'explicit-zero-row', rawRows:rawRows.length, positiveRows:0, explicitZeroRows };
  return { validity:GETREMAIN_VALIDITY.UNAVAILABLE_OR_SUSPECT, trustworthy:false, reason:'empty-exact-result-unconfirmed', rawRows:0, positiveRows:0, explicitZeroRows:0 };
}

function warehouseSnapshotHealth(pagination = {}, options = {}) {
  const baselineRows = Math.max(0, Number(options.baselineRows || 0));
  const existingPositiveRows = Math.max(0, Number(options.existingPositiveRows || 0));
  const observedRows = Math.max(0, Number(pagination.positiveRows || 0));
  const rawRows = Math.max(0, Number(pagination.rawRows || 0));
  const minimumBaselineRows = Math.max(1, Number(options.minimumBaselineRows || 50));
  const minimumValidRatio = Math.min(1, Math.max(0.01, Number(options.minimumValidRatio || 0.5)));
  const effectiveBaselineRows = Math.max(baselineRows, existingPositiveRows);
  const observedRatio = effectiveBaselineRows > 0 ? observedRows / effectiveBaselineRows : null;
  const common = { baselineRows:effectiveBaselineRows, lastKnownGoodRowCount:baselineRows, existingPositiveRows, observedRows, rawRows, observedRatio, minimumBaselineRows, minimumValidRatio };
  if (pagination.ok === false || pagination.completed !== true) {
    return { ...common, validity:GETREMAIN_VALIDITY.UNAVAILABLE_OR_SUSPECT, trustworthy:false, reason:pagination.error || pagination.terminalCondition || 'incomplete-pagination' };
  }
  if (rawRows === 0) {
    if (effectiveBaselineRows > 0) return { ...common, validity:GETREMAIN_VALIDITY.UNAVAILABLE_OR_SUSPECT, trustworthy:false, reason:'empty-first-page-against-positive-baseline' };
    return { ...common, validity:GETREMAIN_VALIDITY.VALID_ZERO, trustworthy:true, reason:'empty-warehouse-with-zero-baseline' };
  }
  if (effectiveBaselineRows >= minimumBaselineRows && observedRatio < minimumValidRatio) {
    return { ...common, validity:GETREMAIN_VALIDITY.UNAVAILABLE_OR_SUSPECT, trustworthy:false, reason:'abnormal-row-count-collapse' };
  }
  return { ...common, validity:GETREMAIN_VALIDITY.VALID_DATA, trustworthy:true, reason:'healthy-complete-snapshot' };
}

async function guardedInventoryWrite(health, write, protectedCount = 0) {
  if (!health || health.trustworthy !== true || health.validity === GETREMAIN_VALIDITY.UNAVAILABLE_OR_SUSPECT) {
    return { written:false, zeroProtected:Math.max(0, Number(protectedCount || 0)), validity:health?.validity || GETREMAIN_VALIDITY.UNAVAILABLE_OR_SUSPECT, reason:health?.reason || 'missing-getremain-health' };
  }
  const result = typeof write === 'function' ? await write() : null;
  return { written:true, zeroProtected:0, validity:health.validity, reason:health.reason, result };
}

function extractTotalRecords(response = {}) {
  const result = Array.isArray(response.result) ? response.result : [];
  const candidates = [
    response.totalRecords,
    response.TotalRecords,
    response.raw?.TotalRecords,
    response.raw?.totalRecords,
    result[0]?.TotalRecords,
    result[0]?.totalRecords
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const parsed = finiteNonNegative(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
}

function authoritativeInventoryPageEvidence(response = {}, { rowStart = 0, rowCount = 100 } = {}) {
  const pageSize = Math.max(1, Number(rowCount || 100));
  const rawRows = Array.isArray(response.result) ? response.result : [];
  const positiveRows = Array.isArray(response.list) ? response.list : [];
  const resultShapeValid = response.resultIsArray !== false && Array.isArray(response.result);
  const rawCount = rawRows.length;
  const positiveCount = positiveRows.length;
  const totalRecords = extractTotalRecords(response);
  const sourceOk = response.ok !== false && resultShapeValid;
  let terminal = false;
  let terminalCondition = 'continue-full-raw-page';

  if (!sourceOk) terminalCondition = resultShapeValid ? 'source-error' : 'invalid-result-shape';
  else if (rawCount === 0) {
    terminal = true;
    terminalCondition = 'empty-raw-page';
  } else if (totalRecords !== null && Number(rowStart || 0) + rawCount >= totalRecords) {
    terminal = true;
    terminalCondition = 'total-records-reached';
  } else if (totalRecords === null && rawCount < pageSize) {
    terminal = true;
    terminalCondition = 'partial-raw-page';
  }

  return {
    sourceOk,
    resultShapeValid,
    rowStart:Number(rowStart || 0),
    rowCount:pageSize,
    rawCount,
    positiveCount,
    filteredCount:Math.max(0, rawCount-positiveCount),
    totalRecords,
    terminal,
    terminalCondition
  };
}

async function walkAuthoritativeInventoryPages({ fetchPage, onPage, pageSize = 100, maxPages = 300 } = {}) {
  if (typeof fetchPage !== 'function') throw new TypeError('fetchPage required');
  const safePageSize = Math.max(1, Number(pageSize || 100));
  const safeMaxPages = Math.max(1, Number(maxPages || 300));
  const evidence = [];
  let rawRows = 0;
  let positiveRows = 0;

  for (let pageIndex = 0; pageIndex < safeMaxPages; pageIndex++) {
    const rowStart = pageIndex * safePageSize;
    const response = await fetchPage({ pageIndex, rowStart, rowCount:safePageSize });
    const page = authoritativeInventoryPageEvidence(response, { rowStart, rowCount:safePageSize });
    evidence.push({ pageIndex, ...page });
    rawRows += page.rawCount;
    positiveRows += page.positiveCount;

    if (!page.sourceOk) return {
      ok:false, completed:false, pagesRead:evidence.length, rawRows, positiveRows,
      terminalCondition:'source-error', evidence, response,
      error:String(response?.error || 'inventory source page failed')
    };
    if (typeof onPage === 'function') await onPage({ pageIndex, rowStart, response, evidence:page });
    if (page.terminal) return {
      ok:true, completed:true, pagesRead:evidence.length, rawRows, positiveRows,
      terminalCondition:page.terminalCondition, totalRecords:page.totalRecords, evidence
    };
  }

  return {
    ok:true, completed:false, pagesRead:evidence.length, rawRows, positiveRows,
    terminalCondition:'max-pages-guard', totalRecords:evidence[0]?.totalRecords ?? null, evidence
  };
}

function retryDelayMs(attemptCount = 1, baseMs = 60000, maxMs = 15 * 60 * 1000) {
  const exponent = Math.max(0, Math.min(6, Number(attemptCount || 1) - 1));
  return Math.min(Math.max(1000, Number(maxMs || 0)), Math.max(1000, Number(baseMs || 0)) * (2 ** exponent));
}

function boundedBudget({ maxItems, budgetMs, startedAt = Date.now() } = {}) {
  return {
    maxItems:Math.max(1, Number(maxItems || 1)),
    budgetMs:Math.max(1000, Number(budgetMs || 1000)),
    startedAt:Number(startedAt || Date.now())
  };
}

function budgetAllowsAttempt(budget, attempted) {
  if (!budget) return true;
  return Number(attempted || 0) < budget.maxItems
    && (Date.now() - budget.startedAt) < budget.budgetMs;
}

function summarizeStockResults(results = []) {
  return (results || []).reduce((summary, row) => {
    summary.checked += Number(row?.liveMissingVerify?.checked || 0);
    summary.zeroed += Number(row?.liveMissingVerify?.zeroedCount || row?.removedStale || 0);
    summary.failed += Number(row?.liveMissingVerify?.failed || 0);
    summary.remainingQueued += Number(row?.liveMissingVerify?.remainingQueued || row?.queuedForLiveVerify || 0);
    return summary;
  }, { checked:0, zeroed:0, failed:0, remainingQueued:0 });
}

module.exports = {
  INVENTORY_DISCOVERY_QUEUE,
  QUEUE_CLASSES,
  GETREMAIN_VALIDITY,
  OPERATIONAL_DISCOVERY_SOURCES,
  isOperationalDiscoverySource,
  discoveryQueueId,
  missingVerificationSort,
  discoveryVerificationSort,
  eligibleAtFilter,
  staleEligibleAtFilter,
  broadMissingEligibleFilter,
  shouldProtectExactFromBroad,
  newestLocalEvidenceAt,
  hasNewerLocalEvidence,
  hasNewerExactEvidence,
  inventoryIdentity,
  planAcceptedWarehouseSnapshot,
  classifyBroadQuantityDirection,
  exactGetRemainHealth,
  warehouseSnapshotHealth,
  guardedInventoryWrite,
  extractTotalRecords,
  authoritativeInventoryPageEvidence,
  walkAuthoritativeInventoryPages,
  retryDelayMs,
  boundedBudget,
  budgetAllowsAttempt,
  summarizeStockResults
};
