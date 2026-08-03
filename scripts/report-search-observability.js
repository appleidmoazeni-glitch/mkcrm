#!/usr/bin/env node
const fs = require('fs');
const readline = require('readline');

const MAX_DISTINCT_KEYS = 50000;
const MAX_TIMING_SAMPLES = 50000;
const MAX_SLOW_ROWS = 200;

function eventFromLine(line) {
  const text = String(line || '').trim().slice(0, 32768);
  if (!text) return null;
  const starts = [];
  for (let index = text.indexOf('{'); index >= 0 && starts.length < 32; index = text.indexOf('{', index + 1)) starts.push(index);
  for (const start of starts) {
    for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
      try {
        const parsed = JSON.parse(text.slice(start, end + 1));
        if (parsed && typeof parsed === 'object' && parsed.event) return parsed;
        if (parsed && typeof parsed.message === 'string') {
          const nested = eventFromLine(parsed.message);
          if (nested) return nested;
        }
      } catch {}
    }
  }
  return null;
}

function addCount(map, key, amount = 1) {
  const boundedKey = String(key || '').slice(0, 160);
  if (!boundedKey) return;
  if (!map.has(boundedKey) && map.size >= MAX_DISTINCT_KEYS) return;
  map.set(boundedKey, (map.get(boundedKey) || 0) + amount);
}

function topEntries(map, limit = 20, field = 'query') {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([value, count]) => ({ [field]:value, count }));
}

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function createAccumulator(source = '') {
  return {
    source,
    parsedLines:0,
    ignoredLines:0,
    eventCounts:new Map(),
    queries:new Map(),
    zeroQueries:new Map(),
    differingItemCodes:new Map(),
    backendTimings:[],
    backendTimingCount:0,
    backendTimingMax:0,
    slowQueries:[],
    summaryCount:0,
    abortedCount:0,
    observedRequestIds:new Set(),
    abortedRequestIds:new Set(),
    verifyCount:0,
    verifyDifferenceCount:0,
    classifierTotal:0,
    classifierDisagreements:0,
    classifierReasons:new Map(),
    classifierTransitions:new Map()
  };
}

function observeEvent(accumulator, event) {
  if (!event || !event.event) return;
  accumulator.parsedLines++;
  addCount(accumulator.eventCounts, event.event);
  const query = String(event.normalizedQuery || '').slice(0, 160);
  const requestId = String(event.requestId || '').slice(0, 96);

  if (event.event === 'SEARCH_QUERY_SUMMARY') {
    accumulator.summaryCount++;
    addCount(accumulator.queries, query);
    if (requestId && accumulator.observedRequestIds.size < MAX_DISTINCT_KEYS) accumulator.observedRequestIds.add(requestId);
    const timing = Number(event.backendTotalMs);
    if (Number.isFinite(timing)) {
      accumulator.backendTimingCount++;
      accumulator.backendTimingMax = Math.max(accumulator.backendTimingMax, timing);
      if (accumulator.backendTimings.length < MAX_TIMING_SAMPLES) accumulator.backendTimings.push(timing);
    }
  } else if (event.event === 'SEARCH_ZERO_RESULT') {
    addCount(accumulator.zeroQueries, query);
  } else if (event.event === 'SEARCH_ABORTED') {
    accumulator.abortedCount++;
    if (requestId && accumulator.abortedRequestIds.size < MAX_DISTINCT_KEYS) accumulator.abortedRequestIds.add(requestId);
  } else if (event.event === 'SEARCH_SLOW_QUERY') {
    accumulator.slowQueries.push({
      query,
      route:String(event.route || '').slice(0, 128),
      page:String(event.page || '').slice(0, 48),
      durationMs:Number(event.durationMs || 0),
      thresholdMs:Number(event.thresholdMs || 0),
      thresholdType:String(event.thresholdType || '').slice(0, 48),
      timestamp:String(event.timestamp || '').slice(0, 40)
    });
    accumulator.slowQueries.sort((a, b) => b.durationMs - a.durationMs);
    if (accumulator.slowQueries.length > MAX_SLOW_ROWS) accumulator.slowQueries.length = MAX_SLOW_ROWS;
  } else if (event.event === 'SEARCH_VERIFY_DIFF') {
    accumulator.verifyCount++;
    if (Math.abs(Number(event.difference || 0)) > 1e-9) {
      accumulator.verifyDifferenceCount++;
      addCount(accumulator.differingItemCodes, event.itemCode);
    }
  } else if (event.event === 'ITEM_CODE_CLASSIFIER_V2_SHADOW') {
    accumulator.classifierTotal++;
    if (event.differentDecision === true || event.sameDecision === false) accumulator.classifierDisagreements++;
    addCount(accumulator.classifierReasons, event.reason || 'unknown');
    addCount(accumulator.classifierTransitions, `${Boolean(event.oldDecision)}→${Boolean(event.newDecision)}`);
  }
}

function buildReport(accumulator) {
  const observedById = new Set([...accumulator.observedRequestIds, ...accumulator.abortedRequestIds]).size;
  const observedRequests = observedById || (accumulator.summaryCount + accumulator.abortedCount);
  return {
    report:'MKCRM_SEARCH_OBSERVABILITY',
    contractVersion:1,
    generatedAt:new Date().toISOString(),
    source:accumulator.source,
    parsedEvents:accumulator.parsedLines,
    ignoredLines:accumulator.ignoredLines,
    eventCounts:Object.fromEntries([...accumulator.eventCounts.entries()].sort()),
    topQueries:topEntries(accumulator.queries, 20),
    topZeroResultQueries:topEntries(accumulator.zeroQueries, 20),
    slowQueries:accumulator.slowQueries,
    abortRate:{
      abortedRequests:accumulator.abortedRequestIds.size || accumulator.abortedCount,
      observedRequests,
      rate:observedRequests ? Number(((accumulator.abortedRequestIds.size || accumulator.abortedCount) / observedRequests).toFixed(6)) : 0
    },
    backendTimings:{
      count:accumulator.backendTimingCount,
      sampledCount:accumulator.backendTimings.length,
      medianMs:Number(median(accumulator.backendTimings).toFixed(3)),
      maxMs:Number(accumulator.backendTimingMax.toFixed(3))
    },
    verifyDifferences:{
      verifiedCount:accumulator.verifyCount,
      differentCount:accumulator.verifyDifferenceCount,
      rate:accumulator.verifyCount ? Number((accumulator.verifyDifferenceCount / accumulator.verifyCount).toFixed(6)) : 0,
      topItemCodes:topEntries(accumulator.differingItemCodes, 20, 'itemCode')
    },
    itemCodeV2Disagreements:{
      observed:accumulator.classifierTotal,
      different:accumulator.classifierDisagreements,
      rate:accumulator.classifierTotal ? Number((accumulator.classifierDisagreements / accumulator.classifierTotal).toFixed(6)) : 0,
      reasons:topEntries(accumulator.classifierReasons, 20, 'reason'),
      transitions:topEntries(accumulator.classifierTransitions, 10, 'transition')
    },
    bounds:{
      maxDistinctKeys:MAX_DISTINCT_KEYS,
      maxTimingSamples:MAX_TIMING_SAMPLES,
      maxSlowQueries:MAX_SLOW_ROWS,
      topQueryLimit:20
    }
  };
}

async function aggregateStream(stream, source = '') {
  const accumulator = createAccumulator(source);
  const lines = readline.createInterface({ input:stream, crlfDelay:Infinity });
  for await (const line of lines) {
    const event = eventFromLine(line);
    if (event) observeEvent(accumulator, event);
    else accumulator.ignoredLines++;
  }
  return buildReport(accumulator);
}

function resolveInput(argv = process.argv.slice(2), env = process.env) {
  const fileIndex = argv.indexOf('--file');
  const configured = fileIndex >= 0 ? argv[fileIndex + 1] : argv.find(x => !x.startsWith('-'));
  return configured || env.SEARCH_OBSERVABILITY_LOG_SOURCE || '-';
}

async function main() {
  const source = resolveInput();
  if (source === '-') {
    if (process.stdin.isTTY) throw new Error('Provide --file <application.log>, a positional log path, or pipe logs on stdin.');
    const report = await aggregateStream(process.stdin, 'stdin');
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const report = await aggregateStream(fs.createReadStream(source, { encoding:'utf8' }), source);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`Search observability report failed: ${String(error.message || error)}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_DISTINCT_KEYS,
  MAX_TIMING_SAMPLES,
  MAX_SLOW_ROWS,
  eventFromLine,
  createAccumulator,
  observeEvent,
  buildReport,
  aggregateStream,
  resolveInput
};
