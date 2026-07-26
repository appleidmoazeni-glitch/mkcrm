const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'public/assets/app.js'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src/lib/config.js'), 'utf8');

test('backend telemetry covers both search routes without changing their payload fields', () => {
  assert.match(server, /createSearchPerfTrace\(pathname, searchQuery\)/);
  assert.match(server, /sendSearchPerfJson\(req, res, 200, r, searchTrace\)/);
  assert.match(server, /const payload = \{ ok:r\.ok, list:dd\.list, groups: inventoryGroups\(dd\.list\), source:/);
  assert.doesNotMatch(server, /searchTelemetry\s*:/);
  assert.doesNotMatch(server, /searchRequestId\s*:/);
});

test('telemetry logging is failure-isolated and excludes sensitive transport data', () => {
  const emit = server.slice(server.indexOf('function emitSearchPerf'), server.indexOf('async function executeInventorySyncJob'));
  assert.match(emit, /try \{ console\.info\(JSON\.stringify\(output\)\); \} catch \{\}/);
  assert.doesNotMatch(emit, /authorization|api[-_]?key|connectionString|rawResponse/i);
});

test('telemetry does not add a Shaygan or authoritative reconcile invocation', () => {
  assert.equal((server.match(/authoritativeLiveReconcileItem\(/g) || []).length, 7);
  assert.equal((server.match(/getInventoryByItemCode\(/g) || []).length, 3);
  assert.match(server, /shayganCallCount:0/);
  assert.match(server, /shayganCalls:\[\]/);
});

test('existing ItemCode detection is unchanged', () => {
  assert.match(server, /return \/\^\[0-9A-Za-z_-\]\{5,\}\$\/\.test\(x\) && !\/\\s\/\.test\(x\);/);
});

test('existing frontend debounce values and cancellation behavior are unchanged', () => {
  assert.match(frontend, /const deb=debounce\(\(\)=>fastSearch\(true\),250\);/);
  assert.match(frontend, /\},220\);\s*q\.addEventListener\('input'/);
  assert.match(frontend, /requestController\.abort\(\);requestController=new AbortController\(\);/);
  assert.doesNotMatch(
    frontend.slice(frontend.indexOf('function bindSaleSnapshotSearch'), frontend.indexOf('window.bindSaleSnapshotSearch')),
    /new AbortController/
  );
});

test('frontend telemetry remains console-only and adds no transport endpoint', () => {
  const logger = frontend.slice(frontend.indexOf('const searchPerfRuntime'), frontend.indexOf('const uiPageLifecycle'));
  assert.match(logger, /console\.info\('SEARCH_PERF_FRONTEND'/);
  assert.doesNotMatch(logger, /fetch\(|api\(|post\(/);
});

test('inventory sync configuration remains at its established defaults', () => {
  assert.match(config, /autoInventorySyncIntervalMs: Number\(process\.env\.AUTO_INVENTORY_SYNC_INTERVAL_MS \|\| 600000\)/);
  assert.match(config, /autoInventorySyncDelayBetweenStocksMs: Number\(process\.env\.AUTO_INVENTORY_SYNC_DELAY_BETWEEN_STOCKS_MS \|\| 1000\)/);
  assert.match(config, /shayganTimeoutMs: Number\(process\.env\.SHAYGAN_TIMEOUT_MS \|\| 15000\)/);
});

test('no telemetry field is persisted into inventory documents', () => {
  assert.doesNotMatch(server, /\$set\s*:\s*\{[^}]*SEARCH_PERF/is);
  assert.doesNotMatch(server, /collection\(['"]itemInventoryCatalog['"]\)[\s\S]{0,120}(SEARCH_PERF|searchRequestId)/);
  assert.doesNotMatch(server, /collection\(['"]itemCatalog(?:All)?['"]\)[\s\S]{0,120}(SEARCH_PERF|searchRequestId)/);
});
