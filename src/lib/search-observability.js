const EVENT_CONTRACTS = Object.freeze({
  SEARCH_QUERY_SUMMARY: Object.freeze({
    requestId:'string', timestamp:'string', route:'string', page:'string',
    normalizedQuery:'string', tokenCount:'number', resultCount:'number',
    backendTotalMs:'number', localDbMs:'number', rankingMs:'number',
    serializationMs:'number', liveRepairUsed:'boolean',
    shayganCallCount:'number', aborted:'boolean', searchSessionId:'string'
  }),
  SEARCH_ZERO_RESULT: Object.freeze({
    requestId:'string', timestamp:'string', route:'string', page:'string',
    normalizedQuery:'string', tokenCount:'number', resultCount:'number',
    searchSessionId:'string'
  }),
  SEARCH_ABORTED: Object.freeze({
    requestId:'string', timestamp:'string', route:'string', page:'string',
    normalizedQuery:'string', tokenCount:'number', reason:'string',
    inputToVisibleMs:'number', searchSessionId:'string', generation:'number'
  }),
  SEARCH_SLOW_QUERY: Object.freeze({
    requestId:'string', timestamp:'string', route:'string', page:'string',
    normalizedQuery:'string', tokenCount:'number', resultCount:'number',
    durationMs:'number', thresholdMs:'number', thresholdType:'string',
    searchSessionId:'string', generation:'number'
  }),
  SEARCH_VERIFY_DIFF: Object.freeze({
    searchSessionId:'string', itemCode:'string', stockNumber:'string',
    localQuantity:'number', liveQuantity:'number', difference:'number',
    verifiedAt:'string'
  }),
  ITEM_CODE_CLASSIFIER_V2_SHADOW: Object.freeze({
    timestamp:'string', endpoint:'string', normalizedQuery:'string',
    sameDecision:'boolean', differentDecision:'boolean',
    oldDecision:'boolean', newDecision:'boolean', classification:'string',
    confidence:'number', reason:'string'
  })
});

const FIELD_STRING_LIMITS = Object.freeze({
  requestId:96,
  timestamp:40,
  route:128,
  endpoint:128,
  page:48,
  normalizedQuery:160,
  searchSessionId:128,
  reason:64,
  thresholdType:48,
  classification:48,
  itemCode:96,
  stockNumber:48,
  verifiedAt:40
});
const DEFAULT_STRING_LIMIT = 160;
const DEFAULT_SUMMARY_RATE_LIMIT = 600;
const rateState = new Map();

function boundedString(value, maxLength = DEFAULT_STRING_LIMIT) {
  return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLength);
}

function boundedNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(-1e12, Math.min(1e12, number));
}

function sanitizeSearchEvent(eventName, fields = {}) {
  const contract = EVENT_CONTRACTS[eventName];
  if (!contract) throw new Error(`Unsupported search observability event: ${eventName}`);
  const event = { event:eventName };
  for (const [field, type] of Object.entries(contract)) {
    if (!Object.prototype.hasOwnProperty.call(fields, field)) continue;
    if (type === 'string') event[field] = boundedString(fields[field], FIELD_STRING_LIMITS[field] || DEFAULT_STRING_LIMIT);
    else if (type === 'number') event[field] = boundedNumber(fields[field]);
    else if (type === 'boolean') event[field] = Boolean(fields[field]);
  }
  return event;
}

function summaryRateAllowed(nowMs = Date.now(), limit = DEFAULT_SUMMARY_RATE_LIMIT) {
  const minute = Math.floor(nowMs / 60000);
  const key = `SEARCH_QUERY_SUMMARY:${minute}`;
  const current = rateState.get(key) || 0;
  for (const oldKey of rateState.keys()) if (oldKey !== key) rateState.delete(oldKey);
  if (current >= limit) return false;
  rateState.set(key, current + 1);
  return true;
}

function shouldEmitSearchEvent(eventName, options = {}) {
  if (options.force || eventName === 'SEARCH_ZERO_RESULT' || eventName === 'SEARCH_VERIFY_DIFF') return true;
  if (eventName !== 'SEARCH_QUERY_SUMMARY') return true;
  const sampleRate = Math.max(0, Math.min(1, Number(
    options.sampleRate ?? process.env.SEARCH_OBSERVABILITY_SAMPLE_RATE ?? 1
  )));
  if (sampleRate < 1 && (options.random || Math.random)() >= sampleRate) return false;
  const rateLimit = Math.max(1, Number(
    options.rateLimit ?? process.env.SEARCH_OBSERVABILITY_MAX_SUMMARIES_PER_MINUTE ?? DEFAULT_SUMMARY_RATE_LIMIT
  ));
  return summaryRateAllowed(options.nowMs ?? Date.now(), rateLimit);
}

function emitSearchEvent(eventName, fields = {}, options = {}) {
  let event;
  try {
    event = sanitizeSearchEvent(eventName, fields);
    if (!shouldEmitSearchEvent(eventName, options)) return { emitted:false, event };
    const sink = options.sink || ((label, json) => console.info(label, json));
    const schedule = options.schedule || setImmediate;
    const scheduled = schedule(() => {
      try { sink(eventName, JSON.stringify(event)); } catch {}
    });
    scheduled?.unref?.();
    return { emitted:true, event };
  } catch {
    return { emitted:false, event:null };
  }
}

module.exports = {
  EVENT_CONTRACTS,
  FIELD_STRING_LIMITS,
  boundedString,
  sanitizeSearchEvent,
  shouldEmitSearchEvent,
  emitSearchEvent
};
