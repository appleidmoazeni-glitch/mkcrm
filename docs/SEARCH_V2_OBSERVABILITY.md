# MKCRM Search v2 observability contract

This contract is observational only. It does not change search candidates, ranking, response payloads,
background verification, final verification, inventory synchronization, or invoice behavior.

## Transport and retention

- Server events are bounded JSON lines written asynchronously to the application logger.
- Browser events are bounded JSON lines written to the browser console.
- No telemetry event is written to MongoDB and no telemetry endpoint exists.
- `SEARCH_QUERY_SUMMARY` defaults to full sampling and is capped at 600 events per minute per process.
- `SEARCH_OBSERVABILITY_SAMPLE_RATE` may reduce summary sampling from `0` to `1`.
- `SEARCH_OBSERVABILITY_MAX_SUMMARIES_PER_MINUTE` may change the summary rate cap.
- `SEARCH_ZERO_RESULT` and `SEARCH_VERIFY_DIFF` are never sampled or rate-limited.
- Log-file rotation and retention remain the responsibility of the existing application logging runtime.

## Event contracts

All strings are control-character stripped and length bounded. Unknown fields are dropped by the server emitter.

### `SEARCH_QUERY_SUMMARY`

Emitted after the local search response has been serialized and handed to the HTTP response.

Fields: `requestId`, `timestamp`, `route`, `page`, `normalizedQuery`, `tokenCount`,
`resultCount`, `backendTotalMs`, `localDbMs`, `rankingMs`, `serializationMs`,
`liveRepairUsed`, `shayganCallCount`, `aborted`, and optional `searchSessionId`.

### `SEARCH_ZERO_RESULT`

Emitted only when the final local result count returned by the route is zero. It is never sampled.

Fields: `requestId`, `timestamp`, `route`, `page`, `normalizedQuery`, `tokenCount`,
`resultCount`, and optional `searchSessionId`.

### `SEARCH_ABORTED`

Emitted for an aborted HTTP request, an `AbortController` cancellation, or a response superseded by
a newer frontend generation. Abort handling remains silent in the UI.

Fields: `requestId`, `timestamp`, `route`, `page`, `normalizedQuery`, `tokenCount`,
`reason`, `inputToVisibleMs`, optional `searchSessionId`, and `generation`.

### `SEARCH_SLOW_QUERY`

The browser threshold is exactly 700 ms from input to visible results and uses
`thresholdType=frontend-input-to-visible`. The separately reported server threshold is 500 ms
from backend request start through serialization and uses `thresholdType=backend-total`.
The two timing populations remain distinguishable and are never combined into one duration.

Fields: `requestId`, `timestamp`, `route`, `page`, `normalizedQuery`, `tokenCount`,
`resultCount`, `durationMs`, `thresholdMs`, `thresholdType`, optional `searchSessionId`,
and `generation`.

### `SEARCH_VERIFY_DIFF`

Emitted by the existing read-only background verification after a visible local stock row has a
matching live row. A zero difference is emitted too, allowing the difference rate denominator to
remain auditable. It is never sampled.

Fields: `searchSessionId`, `itemCode`, `stockNumber`, `localQuantity`, `liveQuantity`,
`difference`, and `verifiedAt`.

### `ITEM_CODE_CLASSIFIER_V2_SHADOW`

The existing Phase 2 comparison and decision behavior remain unchanged. Its output now uses the same
bounded emitter with `timestamp`, `endpoint`, `normalizedQuery`, `sameDecision`, `differentDecision`,
`oldDecision`, `newDecision`, `classification`, `confidence`, and `reason`. The V1 classifier still
controls runtime decisions.

## Privacy

The allowlists explicitly exclude request objects, customer data, invoice bodies, passwords, tokens,
cookies, authorization headers, connection strings, and Shaygan payloads. Item search text is normalized
and limited to 160 characters. Identifiers and item/stock codes have smaller explicit bounds.

## Read-only aggregation

From an application log file:

```sh
node scripts/report-search-observability.js --file /path/to/application.log
```

From stdin:

```sh
some-read-only-log-command | node scripts/report-search-observability.js -
```

Or set `SEARCH_OBSERVABILITY_LOG_SOURCE` to an existing readable log file and run the script without
arguments. The script only streams the source and writes a JSON report to stdout. It never connects to
MongoDB, Shaygan, PM2, or an HTTP endpoint.

The report contains the top 20 queries, top 20 zero-result queries, up to 200 slow queries, abort rate,
median/max backend time, verify-difference rate, top differing item codes, and ItemCode V2 disagreement
statistics. In-memory cardinality and timing samples are bounded and declared in the report.
