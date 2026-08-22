'use strict';

const crypto = require('crypto');

const INVENTORY_DISCOVERY_QUEUE = 'inventoryDiscoveryVerificationQueue';
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

function discoveryQueueId(identity) {
  return `IVQ-${crypto.createHash('sha256').update(clean(identity, 300)).digest('hex').slice(0, 24)}`;
}

function missingVerificationSort() {
  // Every attempt, including a timeout, advances lastLiveAttemptAt. This keeps
  // one slow Shaygan item from monopolizing every reconciliation cycle.
  return { lastLiveAttemptAt:1, lastLiveVerifiedAt:1, firstMissingInStockAt:1, _id:1 };
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
  OPERATIONAL_DISCOVERY_SOURCES,
  isOperationalDiscoverySource,
  discoveryQueueId,
  missingVerificationSort,
  boundedBudget,
  budgetAllowsAttempt,
  summarizeStockResults
};
