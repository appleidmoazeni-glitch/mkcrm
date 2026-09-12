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
  const newBudget = policy.boundedBudget({ maxItems:20, budgetMs:45000, startedAt:Date.now() });
  const staleBudget = policy.boundedBudget({ maxItems:30, budgetMs:90000, startedAt:Date.now() });
  assert.equal(policy.budgetAllowsAttempt(newBudget, 0), true);
  assert.equal(policy.budgetAllowsAttempt(staleBudget, 0), true);
  assert.equal(policy.budgetAllowsAttempt(newBudget, 20), false);
  assert.equal(policy.budgetAllowsAttempt(staleBudget, 30), false);
});

test('new identity defaults remain bounded below the five-minute Staging cadence', () => {
  const configSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'config.js'), 'utf8');
  assert.match(configSource, /inventoryNewItemVerifyCycleLimit: Number\(process\.env\.INVENTORY_NEW_ITEM_VERIFY_CYCLE_LIMIT \|\| 20\)/);
  assert.match(configSource, /inventoryNewItemVerifyBudgetMs: Number\(process\.env\.INVENTORY_NEW_ITEM_VERIFY_BUDGET_MS \|\| 45000\)/);
  assert.ok(45000 < 300000);
});

test('recent exact-positive evidence is not immediately requeued by a weaker broad omission', () => {
  const cutoff = new Date('2026-08-23T10:00:00.000Z');
  assert.deepEqual(policy.broadMissingEligibleFilter(cutoff), { $or:[
    { lastAuthoritativeExactAt:{ $exists:false } },
    { lastAuthoritativeExactAt:null },
    { lastAuthoritativeExactAt:{ $lte:cutoff } }
  ] });
  const configSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'config.js'), 'utf8');
  assert.match(configSource, /inventoryExactPositiveRecheckMs: Number\(process\.env\.INVENTORY_EXACT_POSITIVE_RECHECK_MS \|\| 900000\)/);
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

test('broad positive source classifies every supported quantity direction', () => {
  assert.equal(policy.classifyBroadQuantityDirection(null, { quantity:1 }), 'newRows');
  assert.equal(policy.classifyBroadQuantityDirection({ quantity:0 }, { quantity:2 }), 'increases');
  assert.equal(policy.classifyBroadQuantityDirection({ quantity:1 }, { quantity:3 }), 'increases');
  assert.equal(policy.classifyBroadQuantityDirection({ quantity:5 }, { quantity:2 }), 'decreases');
  assert.equal(policy.classifyBroadQuantityDirection({ quantity:2 }, { quantity:2 }), 'unchanged');
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

test('INV-H03 full raw page continues after positive normalization filters one row', async () => {
  const target = { itemCode:'9799STV545', itemGuid:'GUID-9799', itemDescription:'ST VGA XFX RX580 8G', stockNumber:'01', quantity:2 };
  const fullRaw = prefix => Array.from({ length:100 }, (_, index) => ({ ItemCode:`${prefix}-${index}`, Quantity1:index === 0 ? 0 : 1 }));
  const pages = [
    { ok:true, result:fullRaw('P0'), list:fullRaw('P0').slice(1) },
    { ok:true, result:[target, ...fullRaw('P1').slice(1)], list:[target, ...fullRaw('P1').slice(1)] },
    { ok:true, result:[{ ItemCode:'FINAL', Quantity1:1 }], list:[{ itemCode:'FINAL', stockNumber:'01', quantity:1 }] }
  ];
  const requested = [];
  const db = new MemoryDb({ itemCatalogAll:[], purchaseHistoryDiscoveryQueue:[], inventoryDiscoveryVerificationQueue:[], itemInventoryCatalog:[] });
  await catalog.ensureCatalogItem(db, target, { source:'all-items-catalog-bootstrap' });
  const walked = await policy.walkAuthoritativeInventoryPages({
    pageSize:100,
    maxPages:10,
    fetchPage:async ({ pageIndex, rowStart }) => { requested.push(rowStart); return pages[pageIndex]; },
    onPage:async ({ response }) => {
      for (const row of response.list || []) {
        if (row.itemCode !== target.itemCode) continue;
        await db.collection('itemInventoryCatalog').insertOne(row);
        await catalog.ensureCatalogItem(db, row, { source:'auto-active-stock-filter-positive' });
      }
    }
  });
  assert.equal(walked.ok, true);
  assert.equal(walked.completed, true);
  assert.deepEqual(requested, [0, 100, 200]);
  assert.equal(walked.evidence[0].rawCount, 100);
  assert.equal(walked.evidence[0].positiveCount, 99);
  assert.equal(walked.evidence[0].terminal, false);
  assert.equal(db.collection('itemInventoryCatalog').rows.length, 1);
  const queue = db.collection('inventoryDiscoveryVerificationQueue').rows;
  assert.equal(queue.length, 1);
  assert.equal(queue[0].queueClass, 'NEW_IDENTITY');
  let exactCalls = 0;
  for (const candidate of queue.filter(row => row.status === 'pending')) {
    exactCalls++;
    assert.equal(candidate.itemCode, target.itemCode);
    candidate.status = 'verified';
    candidate.outcome = 'positive';
  }
  assert.equal(exactCalls, 1);
  assert.equal(queue[0].status, 'verified');
});

test('authoritative inventory pagination supports consecutive full pages and a partial final raw page', async () => {
  const full = Array.from({ length:100 }, (_, i) => ({ ItemCode:`I-${i}` }));
  const pages = [
    { ok:true, result:full, list:full },
    { ok:true, result:full, list:full },
    { ok:true, result:full.slice(0, 7), list:full.slice(0, 6) }
  ];
  let calls = 0;
  const result = await policy.walkAuthoritativeInventoryPages({ fetchPage:async () => pages[calls++], pageSize:100, maxPages:10 });
  assert.equal(result.completed, true);
  assert.equal(result.pagesRead, 3);
  assert.equal(result.rawRows, 207);
  assert.equal(result.positiveRows, 206);
  assert.equal(result.terminalCondition, 'partial-raw-page');
});

test('explicit empty raw page remains a valid terminal page', async () => {
  const full = Array.from({ length:100 }, (_, i) => ({ ItemCode:`I-${i}` }));
  const pages = [{ ok:true, result:full, list:full }, { ok:true, result:[], list:[] }];
  let calls = 0;
  const result = await policy.walkAuthoritativeInventoryPages({ fetchPage:async () => pages[calls++], pageSize:100, maxPages:10 });
  assert.equal(result.completed, true);
  assert.equal(result.pagesRead, 2);
  assert.equal(result.terminalCondition, 'empty-raw-page');
});

test('all-zero full raw page does not terminate on an empty normalized list', async () => {
  const zeroPage = Array.from({ length:100 }, (_, i) => ({ ItemCode:`ZERO-${i}`, Quantity1:0 }));
  const pages = [{ ok:true, result:zeroPage, list:[] }, { ok:true, result:[], list:[] }];
  const starts = [];
  const result = await policy.walkAuthoritativeInventoryPages({ fetchPage:async ({ rowStart }) => { starts.push(rowStart); return pages[starts.length-1]; }, pageSize:100, maxPages:10 });
  assert.deepEqual(starts, [0, 100]);
  assert.equal(result.completed, true);
  assert.equal(result.evidence[0].terminal, false);
  assert.equal(result.evidence[0].filteredCount, 100);
});

test('intermediate timeout is an error and never a terminal page', async () => {
  const full = Array.from({ length:100 }, (_, i) => ({ ItemCode:`I-${i}` }));
  const pages = [{ ok:true, result:full, list:full }, { ok:false, result:[], list:[], error:'Shaygan request timeout' }];
  let calls = 0;
  const result = await policy.walkAuthoritativeInventoryPages({ fetchPage:async () => pages[calls++], pageSize:100, maxPages:10 });
  assert.equal(result.ok, false);
  assert.equal(result.completed, false);
  assert.equal(result.pagesRead, 2);
  assert.equal(result.terminalCondition, 'source-error');
  assert.match(result.error, /timeout/i);
});

test('explicit TotalRecords metadata takes precedence over filtered counts', async () => {
  const raw = Array.from({ length:100 }, (_, i) => ({ ItemCode:`I-${i}` }));
  const evidence = policy.authoritativeInventoryPageEvidence({ ok:true, raw:{ TotalRecords:150 }, result:raw, list:raw.slice(0, 80) }, { rowStart:0, rowCount:100 });
  assert.equal(evidence.totalRecords, 150);
  assert.equal(evidence.terminal, false);
  const final = policy.authoritativeInventoryPageEvidence({ ok:true, raw:{ TotalRecords:150 }, result:raw.slice(0, 50), list:raw.slice(0, 45) }, { rowStart:100, rowCount:100 });
  assert.equal(final.terminal, true);
  assert.equal(final.terminalCondition, 'total-records-reached');
});

test('repeated full pages are bounded by maxPages instead of being mistaken for completion', async () => {
  const full = Array.from({ length:100 }, (_, i) => ({ ItemCode:`I-${i}` }));
  const result = await policy.walkAuthoritativeInventoryPages({ fetchPage:async () => ({ ok:true, result:full, list:full }), pageSize:100, maxPages:3 });
  assert.equal(result.ok, true);
  assert.equal(result.completed, false);
  assert.equal(result.pagesRead, 3);
  assert.equal(result.terminalCondition, 'max-pages-guard');
});

test('fail-closed warehouse gate preserves 800 positive rows on HTTP 200 empty Result', async () => {
  const previous = Array.from({ length:800 }, (_, index) => ({ itemCode:`I-${index}`, stockNumber:'01', quantity:1 }));
  const db = new MemoryDb({ itemInventoryCatalog:structuredClone(previous) });
  const pagination = await policy.walkAuthoritativeInventoryPages({ fetchPage:async () => ({ ok:true, status:200, result:[], list:[], resultIsArray:true }), pageSize:100, maxPages:10 });
  const health = policy.warehouseSnapshotHealth(pagination, { baselineRows:800, existingPositiveRows:800, minimumValidRatio:0.5, minimumBaselineRows:50 });
  let writes = 0;
  const guarded = await policy.guardedInventoryWrite(health, async () => { writes++; await db.collection('itemInventoryCatalog').updateMany({ stockNumber:'01' }, { $set:{ quantity:0 } }); }, 800);
  assert.equal(health.validity, policy.GETREMAIN_VALIDITY.UNAVAILABLE_OR_SUSPECT);
  assert.equal(health.reason, 'empty-first-page-against-positive-baseline');
  assert.equal(guarded.written, false);
  assert.equal(guarded.zeroProtected, 800);
  assert.equal(writes, 0);
  assert.equal(await db.collection('itemInventoryCatalog').countDocuments({ quantity:{ $gt:0 } }), 800);
});

test('abnormal five-row collapse against 800-row baseline is suspect and non-destructive', async () => {
  const five = Array.from({ length:5 }, (_, index) => ({ ItemCode:`I-${index}`, Quantity1:1 }));
  const previous = Array.from({ length:800 }, (_, index) => ({ itemCode:`I-${index}`, stockNumber:'01', quantity:1 }));
  const db = new MemoryDb({ itemInventoryCatalog:structuredClone(previous) });
  const pagination = await policy.walkAuthoritativeInventoryPages({ fetchPage:async () => ({ ok:true, status:200, result:five, list:five, resultIsArray:true }), pageSize:100, maxPages:10 });
  const health = policy.warehouseSnapshotHealth(pagination, { baselineRows:800, existingPositiveRows:800, minimumValidRatio:0.5, minimumBaselineRows:50 });
  const guarded = await policy.guardedInventoryWrite(health, async () => db.collection('itemInventoryCatalog').updateMany({}, { $set:{ quantity:0 } }), 800);
  assert.equal(health.reason, 'abnormal-row-count-collapse');
  assert.equal(health.observedRows, 5);
  assert.equal(guarded.written, false);
  assert.equal(await db.collection('itemInventoryCatalog').countDocuments({ quantity:{ $gt:0 } }), 800);
});

test('healthy multi-page warehouse snapshot remains writable and complete', async () => {
  const full = Array.from({ length:100 }, (_, index) => ({ ItemCode:`I-${index}`, Quantity1:1 }));
  const final = Array.from({ length:80 }, (_, index) => ({ ItemCode:`F-${index}`, Quantity1:1 }));
  let calls = 0;
  const pagination = await policy.walkAuthoritativeInventoryPages({ fetchPage:async () => [
    { ok:true, result:full, list:full, resultIsArray:true },
    { ok:true, result:final, list:final, resultIsArray:true }
  ][calls++], pageSize:100, maxPages:10 });
  const health = policy.warehouseSnapshotHealth(pagination, { baselineRows:200, existingPositiveRows:200, minimumValidRatio:0.5, minimumBaselineRows:50 });
  let persisted = 0;
  const guarded = await policy.guardedInventoryWrite(health, async () => { persisted = pagination.positiveRows; return persisted; }, 200);
  assert.equal(health.validity, policy.GETREMAIN_VALIDITY.VALID_DATA);
  assert.equal(pagination.completed, true);
  assert.equal(guarded.written, true);
  assert.equal(persisted, 180);
});

test('exact item HTTP 200 empty Result is suspect and cannot zero prior positive stock', async () => {
  const db = new MemoryDb({ itemInventoryCatalog:[{ itemCode:'KEEP', stockNumber:'01', quantity:3 }] });
  const health = policy.exactGetRemainHealth({ ok:true, status:200, result:[], list:[], resultIsArray:true }, 'KEEP');
  const guarded = await policy.guardedInventoryWrite(health, async () => db.collection('itemInventoryCatalog').updateMany({ itemCode:'KEEP' }, { $set:{ quantity:0 } }), 1);
  assert.equal(health.validity, policy.GETREMAIN_VALIDITY.UNAVAILABLE_OR_SUSPECT);
  assert.equal(health.reason, 'empty-exact-result-unconfirmed');
  assert.equal(guarded.written, false);
  assert.equal(db.collection('itemInventoryCatalog').rows[0].quantity, 3);
});

test('explicit exact zero row is the trusted criterion that permits zero reconciliation', async () => {
  const db = new MemoryDb({ itemInventoryCatalog:[{ itemCode:'ZERO', stockNumber:'01', quantity:2 }] });
  const health = policy.exactGetRemainHealth({ ok:true, status:200, result:[{ ItemCode:'ZERO', StoreNumber:'01', Quantity1:0 }], list:[], resultIsArray:true }, 'ZERO');
  const guarded = await policy.guardedInventoryWrite(health, async () => db.collection('itemInventoryCatalog').updateMany({ itemCode:'ZERO' }, { $set:{ quantity:0 } }), 1);
  assert.equal(health.validity, policy.GETREMAIN_VALIDITY.VALID_ZERO);
  assert.equal(health.reason, 'explicit-zero-row');
  assert.equal(guarded.written, true);
  assert.equal(db.collection('itemInventoryCatalog').rows[0].quantity, 0);
});

test('timeout preserves old inventory and a later healthy recovery becomes writable', async () => {
  const previous = [{ itemCode:'RECOVER', stockNumber:'01', quantity:4 }];
  const db = new MemoryDb({ itemInventoryCatalog:structuredClone(previous) });
  const failedPagination = await policy.walkAuthoritativeInventoryPages({ fetchPage:async () => ({ ok:false, result:[], list:[], resultIsArray:true, error:'Shaygan request timeout' }) });
  const failedHealth = policy.warehouseSnapshotHealth(failedPagination, { baselineRows:1, existingPositiveRows:1 });
  const failedWrite = await policy.guardedInventoryWrite(failedHealth, async () => db.collection('itemInventoryCatalog').updateMany({}, { $set:{ quantity:0 } }), 1);
  assert.equal(failedWrite.written, false);
  assert.equal(db.collection('itemInventoryCatalog').rows[0].quantity, 4);
  const healthyPagination = await policy.walkAuthoritativeInventoryPages({ fetchPage:async () => ({ ok:true, result:[{ ItemCode:'RECOVER', Quantity1:5 }], list:[{ ItemCode:'RECOVER', Quantity1:5 }], resultIsArray:true }) });
  const healthy = policy.warehouseSnapshotHealth(healthyPagination, { baselineRows:1, existingPositiveRows:1 });
  const recovered = await policy.guardedInventoryWrite(healthy, async () => db.collection('itemInventoryCatalog').updateMany({ itemCode:'RECOVER' }, { $set:{ quantity:5 } }), 1);
  assert.equal(recovered.written, true);
  assert.equal(db.collection('itemInventoryCatalog').rows[0].quantity, 5);
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
  assert.match(reconcile, /broadQuantityDirections/);
  assert.match(reconcile, /quantityDirections:r\.quantityDirections/);
  assert.match(reconcile, /quantityDirectionSamples:\(r\.quantityDirectionSamples\|\|\[\]\)\.slice\(0,50\)/);
  assert.match(reconcile, /pageEvidence:\(r\.pageEvidence\|\|\[\]\)\.slice\(0,300\)/);
  const stockSync = source.slice(source.indexOf('async function syncInventoryStock'), source.indexOf('async function syncInventoryGlobal'));
  assert.match(stockSync, /walkAuthoritativeInventoryPages/);
  assert.match(stockSync, /warehouseSnapshotHealth/);
  assert.match(stockSync, /bufferedPages/);
  assert.match(stockSync, /inventory_sync_fail_closed/);
  assert.doesNotMatch(stockSync, /res\.list\.length\s*<\s*100/);
  assert.doesNotMatch(stockSync, /!res\.list\.length/);
  assert.match(reconcile, /sourceHealthy/);
  assert.match(reconcile, /warehouse-getremain-suspect/);
});

test('GetRemain safety defaults and wrapper health metadata are wired', () => {
  const configSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'config.js'), 'utf8');
  const shayganSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'lib', 'shaygan.js'), 'utf8');
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');
  assert.match(configSource, /INVENTORY_SYNC_MIN_VALID_RATIO \|\| 0\.5/);
  assert.match(configSource, /INVENTORY_SYNC_MIN_BASELINE_ROWS \|\| 50/);
  assert.match(shayganSource, /resultIsArray/);
  assert.match(shayganSource, /exactGetRemainHealth\(res, itemCode\)/);
  assert.match(serverSource, /empty-exact-result-unconfirmed|GETREMAIN_VALIDITY\.UNAVAILABLE_OR_SUSPECT/);
  assert.match(serverSource, /پاسخ معتبر موجودی از WebService شایگان دریافت نشد؛ آخرین موجودی معتبر CRM حفظ شد\./);
});

test('direction evidence remains bounded and excludes unchanged rows', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  const upsert = source.slice(source.indexOf('async function upsertInventoryRows'), source.indexOf('async function readInventoryRowsForItem'));
  assert.match(upsert, /quantityDirectionSamples\.length < 25/);
  assert.match(upsert, /direction !== 'unchanged'/);
  assert.match(upsert, /beforeQuantity/);
  assert.match(upsert, /afterQuantity/);
  assert.match(upsert, /itemCode:String\(x\.itemCode\|\|''\), stockNumber:String\(x\.stockNumber\|\|''\)/);
  assert.doesNotMatch(upsert, /itemCode:String\(x\.itemCode\|\|''\)\.trim\(\), stockNumber:String\(x\.stockNumber\|\|''\)\.trim\(\)/);
});
