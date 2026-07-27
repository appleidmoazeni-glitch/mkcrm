const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');

const root = path.resolve(__dirname, '..');
const server = fs.readFileSync(path.join(root, 'src/server.js'), 'utf8');
const frontend = fs.readFileSync(path.join(root, 'public/assets/app.js'), 'utf8');
const observabilitySource = fs.readFileSync(path.join(root, 'src/lib/search-observability.js'), 'utf8');
const reportSource = fs.readFileSync(path.join(root, 'scripts/report-search-observability.js'), 'utf8');
const {
  EVENT_CONTRACTS,
  sanitizeSearchEvent,
  emitSearchEvent
} = require('../src/lib/search-observability');
const {
  aggregateStream,
  eventFromLine
} = require('../scripts/report-search-observability');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0, `missing section start: ${start}`);
  assert.ok(to > from, `missing section end: ${end}`);
  return source.slice(from, to);
}

test('required structured event contracts are explicit allowlists', () => {
  assert.deepEqual(Object.keys(EVENT_CONTRACTS).sort(), [
    'ITEM_CODE_CLASSIFIER_V2_SHADOW',
    'SEARCH_ABORTED',
    'SEARCH_QUERY_SUMMARY',
    'SEARCH_SLOW_QUERY',
    'SEARCH_VERIFY_DIFF',
    'SEARCH_ZERO_RESULT'
  ]);
  assert.deepEqual(Object.keys(EVENT_CONTRACTS.SEARCH_VERIFY_DIFF), [
    'searchSessionId',
    'itemCode',
    'stockNumber',
    'localQuantity',
    'liveQuantity',
    'difference',
    'verifiedAt'
  ]);
});

test('event sanitizer drops sensitive and unrestricted transport fields', () => {
  const event = sanitizeSearchEvent('SEARCH_QUERY_SUMMARY', {
    requestId:'request-1',
    timestamp:'2026-07-27T00:00:00.000Z',
    route:'/api/inventory/search',
    page:'inventory',
    normalizedQuery:'patriot 3200',
    tokenCount:2,
    resultCount:3,
    backendTotalMs:12,
    localDbMs:4,
    rankingMs:5,
    serializationMs:1,
    liveRepairUsed:false,
    shayganCallCount:0,
    aborted:false,
    authorization:'Bearer secret',
    password:'secret',
    token:'secret',
    cookie:'session=secret',
    request:{ headers:{ authorization:'secret' } },
    invoiceBody:{ customer:'secret' }
  });
  assert.equal(event.normalizedQuery, 'patriot 3200');
  assert.doesNotMatch(JSON.stringify(event), /Bearer|password|cookie|invoiceBody|authorization|secret/i);
});

test('event fields are control-character stripped and length bounded', () => {
  const event = sanitizeSearchEvent('SEARCH_VERIFY_DIFF', {
    searchSessionId:`session-${'x'.repeat(300)}`,
    itemCode:`ITEM\n${'1'.repeat(300)}`,
    stockNumber:'01\r\nInjected',
    localQuantity:Infinity,
    liveQuantity:1e30,
    difference:NaN,
    verifiedAt:'2026-07-27T00:00:00.000Z'
  });
  assert.equal(event.searchSessionId.length, 128);
  assert.equal(event.itemCode.length, 96);
  assert.equal(event.stockNumber.includes('\n'), false);
  assert.equal(event.localQuantity, 0);
  assert.equal(event.liveQuantity, 1e12);
  assert.equal(event.difference, 0);
});

test('telemetry sink and scheduler failures cannot fail search execution', () => {
  assert.doesNotThrow(() => emitSearchEvent('SEARCH_ZERO_RESULT', {
    requestId:'r',
    timestamp:'2026-07-27T00:00:00.000Z',
    route:'/api/inventory/search',
    page:'inventory',
    normalizedQuery:'none',
    tokenCount:1,
    resultCount:0
  }, {
    force:true,
    schedule:callback => callback(),
    sink:() => { throw new Error('logger unavailable'); }
  }));
  assert.doesNotThrow(() => emitSearchEvent('SEARCH_ZERO_RESULT', {}, {
    force:true,
    schedule:() => { throw new Error('scheduler unavailable'); }
  }));
});

test('summary rate control does not suppress zero-result or verify-difference events', () => {
  const sink = [];
  const options = { nowMs:123456, rateLimit:1, sampleRate:1, schedule:fn=>fn(), sink:(name,json)=>sink.push([name,json]) };
  const first = emitSearchEvent('SEARCH_QUERY_SUMMARY', {}, options);
  const second = emitSearchEvent('SEARCH_QUERY_SUMMARY', {}, options);
  const zero = emitSearchEvent('SEARCH_ZERO_RESULT', {}, { ...options, force:false });
  const diff = emitSearchEvent('SEARCH_VERIFY_DIFF', {}, { ...options, force:false });
  assert.equal(first.emitted, true);
  assert.equal(second.emitted, false);
  assert.equal(zero.emitted, true);
  assert.equal(diff.emitted, true);
  assert.deepEqual(sink.map(x=>x[0]), ['SEARCH_QUERY_SUMMARY','SEARCH_ZERO_RESULT','SEARCH_VERIFY_DIFF']);
});

test('search responses are sent before telemetry and payload contracts stay unchanged', () => {
  const sender = section(server, 'function sendSearchPerfJson', 'async function executeInventorySyncJob');
  assert.ok(sender.indexOf('res.end(body)') < sender.lastIndexOf('emitSearchPerf(trace)'));
  assert.match(server, /if \(trace\.responseCompleted && Number\(trace\.localResultCount \|\| 0\) === 0\)/);
  assert.match(server, /const payload = \{ ok:r\.ok, list:dd\.list, groups: inventoryGroups\(dd\.list\), source:/);
  assert.doesNotMatch(server, /searchTelemetry\s*:|observability\s*:|searchRequestId\s*:/);
});

test('observability adds no Mongo inventory write and no Shaygan call', () => {
  assert.doesNotMatch(observabilitySource, /mongodb|connectMongo|collection\(|updateOne|updateMany|bulkWrite|insertOne|deleteOne/i);
  assert.doesNotMatch(observabilitySource, /require\([^)]*shaygan|shaygan\.|getInventory\(|getRemain\(|fetch\(|http\./i);
  assert.doesNotMatch(reportSource, /mongodb|connectMongo|collection\(|updateOne|updateMany|bulkWrite|insertOne|require\([^)]*shaygan|shaygan\.|fetch\(|http\./i);
  const emitters = section(server, 'function createSearchPerfTrace', 'async function executeInventorySyncJob');
  assert.doesNotMatch(emitters, /collection\(|updateOne|updateMany|bulkWrite|insertOne|shaygan\./);
});

test('ranking and local-first ordering responsibilities remain unchanged', () => {
  const scoring = section(server, 'function scoreMatch', 'function rowSearchText');
  assert.match(scoring, /uniqueTokens\.every/);
  assert.match(scoring, /score \+= 10000/);
  assert.match(scoring, /score \+= 2500/);
  const sale = section(server, 'async function searchSaleInventorySnapshot', 'async function liveScanInventorySearch');
  assert.match(sale, /searchActiveInventorySnapshot/);
  assert.doesNotMatch(sale, /shaygan\.|targetedLiveInventoryRepair|authoritativeLiveReconcileItem/);
});

test('aborted and superseded requests stay silent while emitting bounded telemetry', () => {
  const sale = section(frontend, 'function bindSaleSnapshotSearch', 'window.bindSaleSnapshotSearch');
  assert.match(sale, /if\(e\.name==='AbortError'\)\{logSearchPerfFrontend/);
  assert.match(sale, /staleResponseIgnored:true/);
  assert.doesNotMatch(sale, /if\(e\.name==='AbortError'\)[^{]*\{[^}]*innerHTML=/);
  const logger = section(frontend, 'const searchPerfRuntime', 'const uiPageLifecycle');
  assert.match(logger, /SEARCH_ABORTED/);
  assert.match(logger, /reason:legacy\.requestAborted\?'abort-controller':'superseded'/);
});

test('frontend verify-difference telemetry reuses the existing background read', () => {
  const verify = section(frontend, 'async function verifyVisibleResult', '    const search=debounceLocal');
  assert.equal((verify.match(/\/api\/search\/inventory-verify/g) || []).length, 1);
  assert.match(verify, /logSearchVerifyDiff\(\{searchSessionId,itemCode,stockNumber:/);
  assert.doesNotMatch(verify, /post\(|method:'POST'|\/api\/items\/.*\/inventory/);
});

test('frontend slow threshold is exactly 700ms and threshold types are not mixed', () => {
  const logger = section(frontend, 'const searchPerfRuntime', 'const uiPageLifecycle');
  assert.match(logger, /SEARCH_FRONTEND_SLOW_THRESHOLD_MS=700/);
  assert.match(logger, /thresholdType:'frontend-input-to-visible'/);
  assert.doesNotMatch(logger, /backendTotalMs/);
  const backend = section(server, 'function searchPerfNow', 'function sendSearchPerfJson');
  assert.match(backend, /SEARCH_BACKEND_SLOW_THRESHOLD_MS = 500/);
  assert.match(backend, /thresholdType:'backend-total'/);
  assert.doesNotMatch(backend, /frontend-input-to-visible/);
});

test('frontend telemetry uses explicit fields and never spreads sensitive objects', () => {
  const logger = section(frontend, 'const searchPerfRuntime', 'const uiPageLifecycle');
  assert.match(logger, /\.slice\(0,160\)/);
  assert.doesNotMatch(logger, /\.\.\.fields|authorization|password|\btoken\b|cookie|headers|invoiceBody/i);
});

test('log parser accepts raw, prefixed, and wrapped JSON events', () => {
  assert.equal(eventFromLine('SEARCH_ZERO_RESULT {\"event\":\"SEARCH_ZERO_RESULT\",\"normalizedQuery\":\"none\"}').event, 'SEARCH_ZERO_RESULT');
  assert.equal(eventFromLine('{\"event\":\"SEARCH_QUERY_SUMMARY\",\"normalizedQuery\":\"cpu\"}').event, 'SEARCH_QUERY_SUMMARY');
  assert.equal(eventFromLine(JSON.stringify({ message:'SEARCH_ABORTED {\"event\":\"SEARCH_ABORTED\"}' })).event, 'SEARCH_ABORTED');
  assert.equal(eventFromLine('not telemetry'), null);
});

test('read-only aggregation produces all required report sections', async () => {
  const events = [
    {event:'SEARCH_QUERY_SUMMARY',requestId:'q1',normalizedQuery:'patriot',backendTotalMs:100},
    {event:'SEARCH_QUERY_SUMMARY',requestId:'q2',normalizedQuery:'patriot',backendTotalMs:800},
    {event:'SEARCH_QUERY_SUMMARY',requestId:'q3',normalizedQuery:'14400',backendTotalMs:400},
    {event:'SEARCH_ZERO_RESULT',requestId:'z1',normalizedQuery:'patriot 3200'},
    {event:'SEARCH_SLOW_QUERY',normalizedQuery:'patriot',route:'/api/inventory/search',page:'inventory',durationMs:900,thresholdMs:700,thresholdType:'frontend-input-to-visible'},
    {event:'SEARCH_ABORTED',requestId:'a1',normalizedQuery:'cpu intel',reason:'superseded'},
    {event:'SEARCH_VERIFY_DIFF',itemCode:'ITEM-1',stockNumber:'01',localQuantity:2,liveQuantity:2,difference:0},
    {event:'SEARCH_VERIFY_DIFF',itemCode:'ITEM-2',stockNumber:'01',localQuantity:2,liveQuantity:1,difference:-1},
    {event:'ITEM_CODE_CLASSIFIER_V2_SHADOW',sameDecision:true,differentDecision:false,oldDecision:true,newDecision:true,reason:'same'},
    {event:'ITEM_CODE_CLASSIFIER_V2_SHADOW',sameDecision:false,differentDecision:true,oldDecision:true,newDecision:false,reason:'brand'}
  ];
  const stream = Readable.from(events.map((event,index)=>`${index % 2 ? 'app | ' : ''}${JSON.stringify(event)}\n`));
  const report = await aggregateStream(stream, 'fixture.log');
  assert.deepEqual(report.topQueries[0], { query:'patriot', count:2 });
  assert.deepEqual(report.topZeroResultQueries[0], { query:'patriot 3200', count:1 });
  assert.equal(report.slowQueries[0].durationMs, 900);
  assert.equal(report.abortRate.abortedRequests, 1);
  assert.equal(report.backendTimings.medianMs, 400);
  assert.equal(report.backendTimings.maxMs, 800);
  assert.equal(report.verifyDifferences.rate, 0.5);
  assert.deepEqual(report.verifyDifferences.topItemCodes[0], { itemCode:'ITEM-2', count:1 });
  assert.equal(report.itemCodeV2Disagreements.observed, 2);
  assert.equal(report.itemCodeV2Disagreements.different, 1);
  assert.equal(report.itemCodeV2Disagreements.rate, 0.5);
});
