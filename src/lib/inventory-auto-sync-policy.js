'use strict';

const crypto = require('crypto');

const INVENTORY_DISCOVERY_QUEUE = 'inventoryDiscoveryVerificationQueue';
const QUEUE_CLASSES = Object.freeze({
  NEW_IDENTITY:'NEW_IDENTITY',
  STALE_POSITIVE:'STALE_POSITIVE'
});
const OPERATIONAL_DISCOVERY_SOURCES = new Set([
  'canonical-purchase-engine',
  'canonical-sale-snapshot'
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

function shouldProtectExactFromBroad(existing = {}, incoming = {}) {
  const exact = existing.inventoryAuthority === 'exact-getremain' || Boolean(existing.lastAuthoritativeExactAt);
  if (!exact) return false;
  return Number(existing.quantity || 0) !== Number(incoming.quantity ?? incoming.Quantity1 ?? 0);
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
  shouldProtectExactFromBroad,
  retryDelayMs,
  boundedBudget,
  budgetAllowsAttempt,
  summarizeStockResults
};
