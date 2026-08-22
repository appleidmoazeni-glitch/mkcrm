'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { MemoryDb } = require('./helpers/memory-mongo');
const catalog = require('../src/lib/canonical-item-catalog');
const policy = require('../src/lib/inventory-auto-sync-policy');

test('missing-row verification is oldest-first so a successful exact read rotates behind the backlog', () => {
  assert.deepEqual(policy.missingVerificationSort(), { lastLiveAttemptAt:1, lastLiveVerifiedAt:1, firstMissingInStockAt:1, _id:1 });
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
  assert.match(queue[0].queueId, /^IVQ-/);
  assert.equal(db.collection('itemInventoryCatalog').rows.length, 0);
});

test('bootstrap and existing identities do not create an unbounded new-item verification backlog', async () => {
  const db = new MemoryDb({ itemCatalogAll:[], purchaseHistoryDiscoveryQueue:[], inventoryDiscoveryVerificationQueue:[] });
  await catalog.ensureCatalogItem(db, { itemCode:'OLD-1', itemGuid:'GUID-OLD' }, { source:'all-items-catalog-bootstrap' });
  await catalog.ensureCatalogItem(db, { itemCode:'OLD-1', itemGuid:'GUID-OLD' }, { source:'canonical-purchase-engine' });
  assert.equal(db.collection('inventoryDiscoveryVerificationQueue').rows.length, 0);
});

test('server keeps exact verification authoritative and does not perform a request-time full catalog scan', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const verify = source.slice(source.indexOf('async function verifyMissingStockRowsLive'), source.indexOf('async function ensureItemInventoryFresh'));
  assert.match(verify, /sort\(inventoryAutoSyncPolicy\.missingVerificationSort\(\)\)/);
  assert.match(verify, /authoritativeLiveReconcileItem/);
  assert.doesNotMatch(verify, /syncAllItemsCatalog|syncCatalog|deleteMany/);
  const discovery = source.slice(source.indexOf('async function verifyNewOperationalItemsLive'), source.indexOf('async function ensureItemInventoryFresh'));
  assert.match(discovery, /inventoryNewItemVerifyCycleLimit/);
  assert.match(discovery, /budgetAllowsAttempt/);
  assert.match(discovery, /authoritativeLiveReconcileItem/);
  assert.doesNotMatch(discovery, /Invoice\/Put|putSaleInvoice|syncAllItemsCatalog|deleteMany/);
  const mongo = fs.readFileSync(path.join(__dirname, '../src/lib/mongo.js'), 'utf8');
  assert.match(mongo, /inventoryDiscoveryVerificationQueue/);
  assert.match(mongo, /needsLiveVerify:1, quantity:1, lastLiveAttemptAt:1, lastLiveVerifiedAt:1, firstMissingInStockAt:1/);
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
});
