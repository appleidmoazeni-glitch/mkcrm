const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'public/assets/app.js'), 'utf8');
const config = fs.readFileSync(path.join(root, 'src/lib/config.js'), 'utf8');
const observability = fs.readFileSync(path.join(root, 'src/lib/search-observability.js'), 'utf8');

test('backend telemetry covers both search routes without changing their payload fields', () => {
  assert.match(server, /createSearchPerfTrace\(pathname, searchQuery, \{ page:'sale'/);
  assert.match(server, /createSearchPerfTrace\(pathname, searchQuery, \{ page:'inventory'/);
  assert.match(server, /sendSearchPerfJson\(req, res, 200, r, searchTrace\)/);
  assert.match(server, /const payload = \{ ok:r\.ok, list:dd\.list, groups: inventoryGroups\(dd\.list\), source:/);
  assert.doesNotMatch(server, /searchTelemetry\s*:/);
  assert.doesNotMatch(server, /searchRequestId\s*:/);
});

test('telemetry logging is failure-isolated and excludes sensitive transport data', () => {
  const emit = server.slice(server.indexOf('function emitSearchPerf'), server.indexOf('async function executeInventorySyncJob'));
  assert.match(emit, /emitSearchEvent\('SEARCH_QUERY_SUMMARY'/);
  assert.match(observability, /try \{ sink\(eventName, JSON\.stringify\(event\)\); \} catch \{\}/);
  assert.match(observability, /catch \{\s*return \{ emitted:false, event:null \};/);
  assert.doesNotMatch(emit, /authorization|api[-_]?key|connectionString|rawResponse/i);
  assert.doesNotMatch(observability, /authorization|api[-_]?key|connectionString|rawResponse/i);
});

test('search telemetry remains observational in the cumulative local-first pipeline', () => {
  const saleSearch = server.slice(server.indexOf('async function searchSaleInventorySnapshot'), server.indexOf('async function liveScanInventorySearch'));
  const inventorySearch = server.slice(server.indexOf('async function searchInventoryRows'), server.indexOf('function deriveMainGroup'));
  assert.doesNotMatch(saleSearch, /authoritativeLiveReconcileItem|targetedLiveInventoryRepair|getInventoryByItemCode/);
  assert.doesNotMatch(inventorySearch, /authoritativeLiveReconcileItem|targetedLiveInventoryRepair|getInventoryByItemCode/);
  assert.match(server, /shayganCallCount:0/);
  assert.match(server, /shayganCalls:\[\]/);
});

test('existing ItemCode detection is unchanged', () => {
  assert.match(server, /return \/\^\[0-9A-Za-z_-\]\{5,\}\$\/\.test\(x\) && !\/\\s\/\.test\(x\);/);
});

test('frontend keeps debounce values and cumulative AbortController behavior', () => {
  assert.match(frontend, /const deb=debounce\(\(\)=>fastSearch\(true\),250\);/);
  assert.match(frontend, /\},220\);\s*q\.addEventListener\('input'/);
  assert.match(frontend, /requestController\.abort\(\);requestController=new AbortController\(\);/);
  const saleSearch = frontend.slice(frontend.indexOf('function bindSaleSnapshotSearch'), frontend.indexOf('window.bindSaleSnapshotSearch'));
  assert.match(saleSearch, /requestController=new AbortController\(\)/);
  assert.match(saleSearch, /verifyController=new AbortController\(\)/);
  assert.match(saleSearch, /requestController\?\.abort\(\)/);
  assert.match(saleSearch, /verifyController\?\.abort\(\)/);
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
  const telemetryNames = 'SEARCH_(?:PERF|QUERY_SUMMARY|ZERO_RESULT|ABORTED|SLOW_QUERY|VERIFY_DIFF)';
  assert.doesNotMatch(server, new RegExp(`\\$set\\s*:\\s*\\{[^}]*(?:${telemetryNames})`, 'is'));
  assert.doesNotMatch(server, new RegExp(`collection\\(['"]itemInventoryCatalog['"]\\)[\\s\\S]{0,120}(?:${telemetryNames}|searchRequestId)`));
  assert.doesNotMatch(server, new RegExp(`collection\\(['"]itemCatalog(?:All)?['"]\\)[\\s\\S]{0,120}(?:${telemetryNames}|searchRequestId)`));
});
