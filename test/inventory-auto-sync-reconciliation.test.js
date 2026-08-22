'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryDb } = require('./helpers/memory-mongo');
const catalog = require('../src/lib/canonical-item-catalog');
const policy = require('../src/lib/inventory-auto-sync-policy');

test('missing-row verification is oldest-first so a successful exact read rotates behind the backlog', () => {
  assert.deepEqual(policy.missingVerificationSort(), { nextLiveVerifyEligibleAt:1, lastLiveAttemptAt:1, firstMissingInStockAt:1, _id:1 });
  assert.deepEqual(policy.discoveryVerificationSort(), { nextEligibleAt:1, firstQueuedAt:1, lastAttemptAt:1, _id:1 });
});

test('reserved queue classes make new identity and stale-positive progress independently', () => {
  assert.deepEqual(policy.QUEUE_CLASSES, { NEW_IDENTITY:'NEW_IDENTITY', STALE_POSITIVE:'STALE_POSITIVE' });
  const newBudget = policy.boundedBudget({ maxItems:5, budgetMs:15000, startedAt:Date.now() });
  const staleBudget = policy.boundedBudget({ maxItems:30, budgetMs:90000, startedAt:Date.now() });
  assert.equal(policy.budgetAllowsAttempt(newBudget, 0), true);
  assert.equal(policy.budgetAllowsAttempt(staleBudget, 0), true);
  assert.equal(policy.budgetAllowsAttempt(newBudget, 5), false);
  assert.equal(policy.budgetAllowsAttempt(staleBudget, 30), false);
});

test('261 stale candidates all receive a turn under the 30-item rotating budget', () => {
  const rows = Array.from({ length:261 }, (_, index) => ({
    itemCode:`ITEM-${String(index).padStart(3, '0')}`,
    firstMissingInStockAt:new Date(1_000 + index),
    lastLiveAttemptAt:null
  }));
  const compare = (a, b) => {
    const attemptA = a.lastLiveAttemptAt ? new Date(a.lastLiveAttemptAt).getTime() : -1;
    const attemptB = b.lastLiveAttemptAt ? new Date(b.lastLiveAttemptAt).getTime() : -1;
    if (attemptA !== attemptB) return attemptA - attemptB;
    return new Date(a.firstMissingInStockAt).getTime() - new Date(b.firstMissingInStockAt).getTime();
  };
  const attempted = new Set();
  for (let cycle = 0; cycle < 9; cycle++) {
    const selected = [...rows].sort(compare).slice(0, 30);
    selected.forEach((row, offset) => {
      attempted.add(row.itemCode);
      row.lastLiveAttemptAt = new Date(10_000 + cycle * 100 + offset);
    });
  }
  assert.equal(attempted.size, 261);
  assert.equal(attempted.has('ITEM-260'), true);
});

test('weaker broad mismatch cannot overwrite an exact authoritative quantity', () => {
  assert.equal(policy.shouldProtectExactFromBroad({ inventoryAuthority:'exact-getremain', quantity:0 }, { quantity:1 }), true);
  assert.equal(policy.shouldProtectExactFromBroad({ lastAuthoritativeExactAt:new Date(), quantity:2 }, { quantity:1 }), true);
  assert.equal(policy.shouldProtectExactFromBroad({ quantity:0 }, { quantity:1 }), false);
  assert.equal(policy.shouldProtectExactFromBroad({ inventoryAuthority:'exact-getremain', quantity:1 }, { quantity:1 }), false);
});

test('bounded exact-verification budget stops on item count without draining backlog', () => {
  const budget = policy.boundedBudget({ maxItems:30, budgetMs:90000, startedAt:Date.now() });
  assert.equal(policy.budgetAllowsAttempt(budget, 29), true);
  assert.equal(policy.budgetAllowsAttempt(budget, 30), false);
});

test('bounded exact-verification budget stops on elapsed time', () => {
  const budget = policy.boundedBudget({ maxItems:30, budgetMs:1000, startedAt:Date.now()-1001 });
  assert.equal(policy.budgetAllowsAttempt(budget, 0), false);
});

test('cycle metrics report real exact verification, zero transitions and remaining queue', () => {
  const result = policy.summarizeStockResults([
    { liveMissingVerify:{ checked:100, zeroedCount:2, failed:1, remainingQueued:252 } },
    { liveMissingVerify:{ checked:4, zeroedCount:1, failed:0, remainingQueued:9 } }
  ]);
  assert.deepEqual(result, { checked:104, zeroed:3, failed:1, remainingQueued:261 });
});

test('new canonical purchase item queues bounded exact inventory verification without creating a private stock cache', async () => {
  const db = new MemoryDb({ itemCatalogAll:[], purchaseHistoryDiscoveryQueue:[], inventoryDiscoveryVerificationQueue:[], itemInventoryCatalog:[] });
  await catalog.ensureCatalogItem(db, { itemCode:'NEW-1', itemGuid:'GUID-NEW', itemDescription:'New inbound' }, { source:'canonical-purchase-engine' });
  const queue = db.collection('inventoryDiscoveryVerificationQueue').rows;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].itemCode, 'NEW-1');
  assert.equal(queue[0].status, 'pending');
  assert.equal(queue[0].queueClass, 'NEW_IDENTITY');
  assert.equal(queue[0].reason, 'first-authoritative-operational-discovery');
  assert.match(queue[0].queueId, /^IVQ-/);
  assert.equal(db.collection('itemInventoryCatalog').rows.length, 0);
});

test('first operational discovery queues an identity that was previously known only by bootstrap', async () => {
  const db = new MemoryDb({ itemCatalogAll:[], purchaseHistoryDiscoveryQueue:[], inventoryDiscoveryVerificationQueue:[] });
  await catalog.ensureCatalogItem(db, { itemCode:'OLD-1', itemGuid:'GUID-OLD' }, { source:'all-items-catalog-bootstrap' });
  await catalog.ensureCatalogItem(db, { itemCode:'OLD-1', itemGuid:'GUID-OLD' }, { source:'canonical-purchase-engine' });
  assert.equal(db.collection('inventoryDiscoveryVerificationQueue').rows.length, 1);
  assert.equal(db.collection('inventoryDiscoveryVerificationQueue').rows[0].queueClass, 'NEW_IDENTITY');
});

test('server keeps exact verification authoritative and does not perform a request-time full catalog scan', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const verify = source.slice(source.indexOf('async function verifyMissingStockRowsLive'), source.indexOf('async function ensureItemInventoryFresh'));
  assert.match(verify, /sort\(inventoryAutoSyncPolicy\.missingVerificationSort\(\)\)/);
  assert.match(verify, /authoritativeLiveReconcileItem/);
  assert.match(verify, /queueRowsCleared/);
  assert.match(verify, /needsLiveVerify:false/);
  assert.doesNotMatch(verify, /syncAllItemsCatalog|syncCatalog|deleteMany/);
  const discovery = source.slice(source.indexOf('async function verifyNewOperationalItemsLive'), source.indexOf('async function ensureItemInventoryFresh'));
  assert.match(discovery, /inventoryNewItemVerifyCycleLimit/);
  assert.match(discovery, /budgetAllowsAttempt/);
  assert.match(discovery, /authoritativeLiveReconcileItem/);
  assert.doesNotMatch(discovery, /Invoice\/Put|putSaleInvoice|syncAllItemsCatalog|deleteMany/);
  assert.match(source, /inventoryAuthority:'exact-getremain'/);
  assert.match(source, /zeroConfirmedBy:'authoritative-live-item-refresh'/);
  assert.match(source, /inventory_broad_exact_precedence_conflict/);
  const mongo = fs.readFileSync(path.join(__dirname, '../src/lib/mongo.js'), 'utf8');
  assert.match(mongo, /inventoryDiscoveryVerificationQueue/);
  assert.match(mongo, /needsLiveVerify:1, nextLiveVerifyEligibleAt:1, lastLiveAttemptAt:1, firstMissingInStockAt:1/);
});

test('automatic reconciliation completes positive stock reads before bounded exact verification', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const reconcile = source.slice(source.indexOf('async function syncInventoryReconciliation'), source.indexOf('async function runAutoInventorySyncTick'));
  assert.match(reconcile, /deferMissingVerification:true/);
  assert.match(reconcile, /stockSyncDurationMs/);
  assert.match(reconcile, /verifyQueuedMissingRowsLive/);
  assert.match(reconcile, /exactVerificationDurationMs/);
  assert.match(reconcile, /exactItemsAttempted/);
  assert.match(reconcile, /distinctExactItemsAttempted/);
  assert.match(reconcile, /exactTimeouts/);
  assert.match(reconcile, /newIdentityAttempted/);
  assert.match(reconcile, /stalePositiveAttempted/);
  assert.match(reconcile, /oldestQueueAge/);
});
