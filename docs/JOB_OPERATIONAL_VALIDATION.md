# Background Job Operational Validation Guide

## Purpose

This suite validates operational invariants of the in-memory Background Job Engine without MongoDB, Shaygan WebService, HTTP routes, UI, or production data. Supplier Sleep is exercised through mocked services; its calculations and output are not reproduced or altered by these tests.

Run the complete job suite:

```bash
pnpm run test:jobs
```

Run only the operational validation:

```bash
pnpm run test:jobs:operational
```

## Validated invariants

### Concurrency and recovery

- A job name owns at most one process-local lock.
- A concurrent second start fails immediately with `JOB_LOCKED`.
- Completion, cooperative cancellation, and failure always release the lock.
- A failed execution does not prevent the next execution.
- Recreating `JobRegistry` and `JobManager` simulates a clean process restart with no stale locks.

Definitions intentionally remain registered for the lifetime of a manager. “Registry cleanup” means the execution registry (`JobManager.listRunning()`) returns to zero; removing reusable job definitions after every execution would be incorrect.

### Cancellation safety

The suite requests cancellation immediately after start, during supplier and invoice boundaries, and immediately before snapshot saving. Mock writes are atomic, and cancellation checks occur only between them. Cancellation after a terminal state returns `false` and cannot change the result.

Every cancelled execution must have:

- final status `Cancelled`;
- exactly one `job.cancelled` event;
- finalized timestamps and duration;
- no running execution or held lock.

### Heartbeat and progress

Heartbeat timestamps are monotonic. Tests observe multiple beats during execution and verify that the final timestamp remains unchanged after completion, cancellation, or failure.

Progress must satisfy:

- monotonically non-decreasing `percent`;
- `0 <= percent <= 100`;
- `0 <= current <= total`;
- correct phase ordering;
- exactly `100%` on successful completion.

### Metrics and events

Metrics validate `startedAt`, `completedAt`, `updatedAt`, `duration`, `processedItems`, `errors`, `retries`, and named counters for `supplierCount`, `invoiceCount`, and `layerCount`.

Terminal event order is:

```text
job.started -> job.progress... -> job.completed | job.failed | job.cancelled
```

Each terminal event occurs once. Test subscriptions use the unsubscribe function returned by `on()`, and `listenerCount()` must return zero after cleanup.

### Repetition and bounded state

Fifty sequential mocked Supplier Sleep executions verify that:

- the definition registry remains consistent;
- the running execution registry returns to zero;
- only the latest snapshot is retained per job name;
- metrics do not carry across executions;
- scoped event listeners are removed;
- no lock or worker accumulates.

Heap-size assertions are intentionally avoided because garbage collection timing is nondeterministic. Bounded engine-owned collections and listener counts provide deterministic leak detection.

## Reusable test utilities

`scripts/job-test-utils.js` provides:

- `FakeHeartbeat`
- `FakeProgress`
- `FakeCancellationToken`
- `FakeMetrics`
- `MockJobContext`
- `MockJobFactory`
- `deferred()` and `delay()`
- `createSupplierManager()`

Future Sale Snapshot, Inventory Sync, and Seller Performance jobs should reuse these utilities rather than connect operational unit tests to external systems.

## Acceptance criteria for any future BackgroundJob

Before merge, every new job adapter must prove:

1. Name and version match its registered definition.
2. Concurrent duplicate execution returns `JOB_LOCKED`.
3. All terminal paths release locks and remove running state.
4. Cancellation is checked only at safe boundaries and never inside an atomic write.
5. Heartbeat is monotonic and stops at the terminal snapshot.
6. Progress remains bounded and monotonic and completes at 100%.
7. Metrics are finalized and do not leak between executions.
8. Started, progress, and exactly one terminal event are emitted in order.
9. Event subscriptions are explicitly released.
10. Controlled failure produces `JOB_FAILED`, preserves recovery, and permits a subsequent run.
11. Repeated execution keeps manager-owned collections bounded.
12. Build, typecheck, lint, job tests, `git diff --check`, and all environment-available regression tests pass.
