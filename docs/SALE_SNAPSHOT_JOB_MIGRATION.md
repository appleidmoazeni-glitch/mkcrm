# Sale Snapshot Background Job Migration

## Scope

Only `POST /api/sale-snapshot/start` moved from synchronous execution to the in-memory Background Job Engine. Snapshot calculations, MongoDB collections, Shaygan calls, authentication, request fields, and read endpoints are unchanged. The existing `full` and `incremental` modes share the stable job definition `{ name: "sale-snapshot", version: 1 }` and therefore one process-local lock.

## Lifecycle and progress

The controller creates an `appJobs` polling record, starts `SaleSnapshotJob`, and returns its `jobId`. The UI polls the existing `/api/jobs/status` endpoint. The job delegates to `buildSaleSnapshot` and reports weighted phases: `Validating Input`, `Resolving Salespeople and Cashiers`, `Reading Sale Invoices`, `Calculating Snapshot`, `Saving Snapshot`, and `Completed`.

Heartbeat and cooperative cancellation checks occur before external page reads, after complete invoice writes, between pages, and before the final persistence group. Cancellation never interrupts an individual Shaygan request, invoice write sequence, or final snapshot replacement. A cancelled partial snapshot uses the service's existing failed terminal marker and is not presented as completed.

## Safety and compatibility

Only invoices whose returned `InvTyp`/`InvoiceType` is exactly `2` are accepted at the Shaygan response boundary. Types `6` and `7` remain excluded. The completed `appJobs.result` is the original `buildSaleSnapshot` result, preserving the existing result payload for polling clients. The engine remains in-memory; a process restart does not resume work.

Metrics include invoice, item, salesperson, cashier, page, snapshot, processed-item, error, retry, and standard duration timestamps. No persistence, scheduler, queue, schema, or other business module was introduced or migrated.
