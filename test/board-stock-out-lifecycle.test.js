const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lifecycle = require('../src/lib/board-stock-out-lifecycle');

const base = {
  itemCode:'8010A16503',
  itemGuid:'2f447e05-b5d5-4c50-853c-945be07ab645',
  invoiceNumber:6464,
  soldQty:1,
  totalQtyAfter:0
};

test('invoice 6464 produces one stable positive-to-zero transition identity', () => {
  const first = lifecycle.buildStockOutTransition(base);
  const retry = lifecycle.buildStockOutTransition({ ...base, saleIssueKey:'different-retry-state' });
  assert.equal(first.ok, true);
  assert.equal(first.eventKey, retry.eventKey);
  assert.equal(first.totalQtyBefore, 1);
  assert.equal(first.totalQtyAfter, 0);
  assert.match(first.eventKey, /^stock_out:v2:[a-f0-9]{64}$/);
});

test('a later restock then stock-out sale is a distinct transition even while the old event is open', () => {
  const oldCycle = lifecycle.buildStockOutTransition({ ...base, invoiceNumber:3461 });
  const newCycle = lifecycle.buildStockOutTransition(base);
  assert.notEqual(oldCycle.transitionId, newCycle.transitionId);
});

test('same invoice retries remain idempotent across status and browser recovery state', () => {
  const variants = ['new','seen','site_updated','closed'].map(status => lifecycle.buildStockOutTransition({ ...base, status }));
  assert.equal(new Set(variants.map(x => x.eventKey)).size, 1);
});

test('canonical GUID, not display code, is the preferred product identity', () => {
  const renamed = lifecycle.buildStockOutTransition({ ...base, itemCode:'RENAMED-CODE' });
  const original = lifecycle.buildStockOutTransition(base);
  assert.equal(renamed.eventKey, original.eventKey);
  assert.equal(original.canonicalItemIdentity, 'guid:2f447e05b5d54c50853c945be07ab645');
});

test('code fallback remains deterministic when an exact GUID is unavailable', () => {
  const a = lifecycle.buildStockOutTransition({ itemCode:' 8010a16503 ', invoiceNumber:6464, soldQty:1, totalQtyAfter:0 });
  const b = lifecycle.buildStockOutTransition({ itemCode:'8010A16503', invoiceNumber:6464, soldQty:1, totalQtyAfter:0 });
  assert.equal(a.eventKey, b.eventKey);
});

test('no event identity is produced without a proven positive-to-zero sale transition', () => {
  assert.equal(lifecycle.buildStockOutTransition({ ...base, totalQtyAfter:1 }).ok, false);
  assert.equal(lifecycle.buildStockOutTransition({ ...base, soldQty:0 }).ok, false);
  assert.equal(lifecycle.buildStockOutTransition({ ...base, invoiceNumber:'', invoiceGuid:'', saleIssueKey:'' }).ok, false);
});

test('multi-warehouse total must be zero before transition creation', () => {
  assert.equal(lifecycle.buildStockOutTransition({ ...base, totalQtyAfter:2 }).code, 'BOARD_STOCK_OUT_TRANSITION_INVALID');
  const zero = lifecycle.buildStockOutTransition({ ...base, soldQty:1, totalQtyAfter:0 });
  assert.equal(zero.totalQtyBefore, 1);
});

test('Board indexes are bootstrapped independently from unrelated init failures', async () => {
  const calls = [];
  const db = { collection(name) { assert.equal(name, 'boardEvents'); return { createIndex(keys, options = {}) { calls.push({ keys, options }); return Promise.resolve(Object.entries(keys).map(([key,value]) => `${key}_${value}`).join('_')); } }; } };
  const names = await lifecycle.ensureBoardLifecycleIndexes(db);
  assert.deepEqual(names, ['eventKey_1','status_1_createdAt_-1','itemCode_1_status_1','canonicalItemIdentity_1_type_1_createdAt_-1']);
  assert.equal(calls[0].options.unique, true);
  assert.equal(calls[0].options.sparse, true);
});

test('server no longer suppresses a transition because an older Board event remains open', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/server.js'), 'utf8');
  assert.doesNotMatch(source, /reason:'open-event-exists'/);
  assert.doesNotMatch(source, /status:\{ \$in:\['new','seen','site_updated'\] \}/);
  assert.match(source, /transitionId:transition\.transitionId/);
  assert.match(source, /idempotentReplay:Boolean\(ev\.ok && !ev\.inserted\)/);
});
