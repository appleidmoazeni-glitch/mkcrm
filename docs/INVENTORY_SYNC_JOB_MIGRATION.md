# Inventory Sync Job Migration

## Execution path

Old: the automatic worker, `POST /api/inventory/auto-sync/run`, and `POST /api/catalog/sync` invoked `syncInventoryReconciliation()` directly, guarded by the local `inventorySyncRunning` flag.

New: each caller starts the registered `{ name: "inventory-sync", version: 1 }` definition through `JobManager`; `InventorySyncJob` then delegates to the unchanged `syncInventoryReconciliation()` and `syncInventoryStock()` implementation. Successful route payloads remain the original service result.

## Operational controls

- Lock: one process-local `inventory-sync` execution. Concurrent starts return `JOB_LOCKED` and cannot overlap.
- Progress: weighted real phases are `Preparing`, `Reading warehouses`, `Reading Shaygan pages`, `Merge inventory`, `Live repair queue`, `Persist inventory`, and `Finalize`.
- Heartbeat: emitted at warehouse, page, merge, live-repair and persistence boundaries; it stops at the terminal state.
- Cancellation: cooperative checks occur before and between warehouses/pages, after an HTTP request but before persistence, after atomic persistence, and before live repair/finalization. Active HTTP calls and atomic Mongo writes are not interrupted.
- Metrics: warehouse/page/inventory/merged/updated/inserted/protected/live-repair counts plus standard processed items, errors, retries and duration. Updated/inserted counters remain zero unless the existing service result supplies them; no extra database reads were introduced to manufacture these values.

## Preserved rules

Active warehouse selection, positive-only updates, no-delete policy, live missing-row repair, merge behavior, `GeneralRef`, warehouse priority, paging, ALL-versus-active behavior, `protectedFromStale`, `queuedForLiveVerify`, schemas, collections and UI rendering are unchanged. Auto Sync timing and configuration are unchanged.

## Rollback

Revert this migration commit and rebuild `dist`; no data or schema rollback is required.

## Staging checklist

1. Confirm build, typecheck, lint and all isolated job tests pass.
2. Confirm `/api/inventory/auto-sync/status` reports the running state during a job.
3. Start `/api/inventory/auto-sync/run`; compare its successful response to the pre-migration shape.
4. Start a concurrent run and verify `JOB_LOCKED` without a second Shaygan scan.
5. Run `/api/catalog/sync` and verify it shares the same lock.
6. Confirm active warehouses, positive quantities, protected rows and live-repair queue match baseline diagnostics.
7. Confirm PM2 logs show no overlapping inventory runs and the scheduled interval is unchanged.
