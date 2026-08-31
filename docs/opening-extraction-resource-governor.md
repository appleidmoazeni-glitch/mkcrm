# Opening Extraction Resource Governor

Opening accounting extraction is P3 background traffic. It must always yield to invoice issuance (P0), interactive Search/Inventory/Kardex (P1), and Inventory AutoSync (P2).

## Ownership

`openingAccountingExtractionLeases` contains one unique `scopeKey=opening-accounting-extraction` lease. The lease records owner ID, process identity, dataset ID, acquisition/heartbeat/expiry timestamps, and release state. An unexpired owner makes every second worker fail closed. A crashed owner can be replaced only after lease expiry.

## Default budget

- Maximum concurrency: 1 (hard limit)
- Minimum delay: 3,000 ms per actual Shaygan HTTP page call
- Maximum rate: 20 calls/minute
- Batch: 1 item
- Batches per explicit run: 1
- Lease: 120 seconds, renewed before each source call and batch checkpoint
- Breaker cooldown: 5 minutes

Configuration is provided through `OPENING_EXTRACTION_*` environment variables, but code clamps unsafe values. Concurrency cannot be raised above one by configuration.

## Circuit breaker

Opening pauses when AutoSync is running/unhealthy, operational P0/P1 p95 exceeds 1,500 ms, operational errors exceed 10%, two consecutive source calls fail, rolling source error rate reaches 20% with at least five samples, or rolling Shaygan p95 reaches 2,500 ms with at least five samples. The worker issues no new Opening call while the breaker is open. After cooldown, an explicit resume enters a two-call half-open state; it does not immediately auto-resume.

## Checkpoints and repeat bound

Every completed warehouse attempt is persisted in `openingAccountingEvidenceProgress`; every actual Shaygan page call updates runtime telemetry. After each item batch, batch progress and health are persisted. A crash may repeat only the currently in-flight warehouse Kardex path. Completed warehouse paths and terminal items are skipped on resume.

## Telemetry

`openingAccountingExtractionRuntime`, `openingAccountingExtractionEvents`, and `GET /api/accounting/opening-accounting-evidence/runtime?datasetId=...` expose owner/lease state, running or paused state, pause reason, breaker state, next eligible resume, budget, batch progress, calls/success/failure, rolling error rate and p50/p95, last success/failure, and current operational health evidence.

The governor never activates Opening evidence and never writes Purchase Layers, FIFO, Manual Cost, Inventory, Invoice, or Shaygan business data.
