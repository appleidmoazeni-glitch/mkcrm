const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'public/assets/app.js'), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing section start: ${start}`);
  assert.ok(to > from, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('sale search reads the local snapshot without live repair or reconciliation', () => {
  const body = section(server, 'async function searchSaleInventorySnapshot', 'async function liveScanInventorySearch');
  assert.match(body, /searchActiveInventorySnapshot/);
  assert.doesNotMatch(body, /targetedLiveInventoryRepair|authoritativeLiveReconcileItem|getInventoryByItemCode/);
  assert.match(body, /exactRefresh:null, preTextRefresh:null/);
});

test('inventory search reads only the local inventory catalog', () => {
  const body = section(server, 'async function searchInventoryRows', 'function deriveMainGroup');
  assert.match(body, /searchInventoryCatalog/);
  assert.doesNotMatch(body, /targetedLiveInventoryRepair|authoritativeLiveReconcileItem|getInventoryByItemCode/);
  assert.match(body, /exactRefresh:null, fallback:null/);
});

test('autocomplete catalog search no longer waits for Shaygan or writes catalog data', () => {
  const body = section(server, 'async function searchAllItems', 'async function syncAllItemsCatalog');
  assert.doesNotMatch(body, /shaygan\.|getItemsPage|upsertAllItemRows|bulkWrite|updateOne|updateMany/);
  assert.match(body, /all-items-cache-ranked/);
  assert.match(body, /scannedPages:scanned/);
});

test('background verification endpoint is read-only and echoes session context', () => {
  const body = section(server, "if (pathname === '/api/search/inventory-verify'", "if (pathname === '/api/items/search')");
  assert.match(body, /shaygan\.getInventoryByItemCode/);
  assert.match(body, /searchSessionId, generation, query:searchQuery/);
  assert.doesNotMatch(body, /connectMongo|collection\(|updateOne|updateMany|bulkWrite|insertOne|delete/);
});

test('frontend renders local results before starting background verification', () => {
  const body = section(frontend, 'function bindSaleSnapshotSearch', 'window.bindSaleSnapshotSearch');
  const renderAt = body.indexOf('renderSaleSnapshotGroups(list,lastGroups)');
  const verifyAt = body.indexOf('verifyVisibleResult(lastGroups[0]?.itemCode,my,val)');
  assert.ok(renderAt >= 0);
  assert.ok(verifyAt > renderAt);
});

test('search session discards stale, replaced, and disposed verification responses', () => {
  const body = section(frontend, 'function bindSaleSnapshotSearch', 'window.bindSaleSnapshotSearch');
  assert.match(body, /searchSessionId=`search-session-/);
  assert.match(body, /generation!==seq/);
  assert.match(body, /r\.searchSessionId!==searchSessionId/);
  assert.match(body, /Number\(r\.generation\)!==generation/);
  assert.match(body, /disposed=true;invalidateSearch\(\)/);
  assert.match(body, /verifyController\?\.abort\(\)/);
});

test('existing ranking algorithm remains present and unchanged in responsibility', () => {
  const body = section(server, 'function scoreMatch', 'function rowSearchText');
  assert.match(body, /uniqueTokens\.every/);
  assert.match(body, /score \+= 10000/);
  assert.match(body, /score \+= 2500/);
  assert.match(body, /return score/);
});

test('existing final verification and inventory synchronization remain separate', () => {
  assert.match(frontend, /async function verifyAndSelectSaleStock/);
  assert.match(frontend, /\/api\/items\/\$\{encodeURIComponent\(item\.itemCode\)\}\/inventory/);
  assert.match(server, /async function authoritativeLiveReconcileItem/);
  assert.match(server, /async function syncInventoryReconciliation/);
  assert.match(server, /executeInventorySyncJob/);
});
