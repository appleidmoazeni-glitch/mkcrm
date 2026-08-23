'use strict';

const crypto = require('crypto');

const INVENTORY_DISCOVERY_QUEUE = 'inventoryDiscoveryVerificationQueue';
const QUEUE_CLASSES = Object.freeze({
  NEW_IDENTITY:'NEW_IDENTITY',
  STALE_POSITIVE:'STALE_POSITIVE'
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

function shouldProtectExactFromBroad(existing = {}, incoming = {}) {
  const exact = existing.inventoryAuthority === 'exact-getremain' || Boolean(existing.lastAuthoritativeExactAt);
  if (!exact) return false;
  return Number(existing.quantity || 0) !== Number(incoming.quantity ?? incoming.Quantity1 ?? 0);
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
  const rawCount = rawRows.length;
  const positiveCount = positiveRows.length;
  const totalRecords = extractTotalRecords(response);
  const sourceOk = response.ok !== false;
  let terminal = false;
  let terminalCondition = 'continue-full-raw-page';

  if (!sourceOk) terminalCondition = 'source-error';
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
  OPERATIONAL_DISCOVERY_SOURCES,
  isOperationalDiscoverySource,
  discoveryQueueId,
  missingVerificationSort,
  discoveryVerificationSort,
  eligibleAtFilter,
  staleEligibleAtFilter,
  broadMissingEligibleFilter,
  shouldProtectExactFromBroad,
  classifyBroadQuantityDirection,
  extractTotalRecords,
  authoritativeInventoryPageEvidence,
  walkAuthoritativeInventoryPages,
  retryDelayMs,
  boundedBudget,
  budgetAllowsAttempt,
  summarizeStockResults
};
