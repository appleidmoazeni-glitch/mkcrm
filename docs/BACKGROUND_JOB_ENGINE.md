# MKCRM Background Job Engine

## Scope

The engine is generic, process-local infrastructure. It does not contain a queue, scheduler, persistence, HTTP routes, or database access. Business adapters live outside `src/core/jobs`; restarting the Node.js process clears registrations and execution history.

## Architecture

- `BackgroundJob` defines the contract implemented by future jobs.
- `JobRegistry` stores versioned `JobDefinition` factories by name.
- `JobManager` owns execution lifecycle, hooks, events, cancellation and snapshots.
- `JobLock` permits one running execution for each job name while allowing different job types to run concurrently.
- `JobStatusMachine` validates all lifecycle transitions.
- `JobContext` is the immutable boundary supplied to job code.
- `JobProgress`, `JobMetrics` and `JobHeartbeat` hold per-execution telemetry.
- `JobCancellationSource` provides cooperative cancellation through a read-only token.
- `JobEventEmitter` publishes typed, in-process engine events.
- `JobLogger` isolates the engine from any future logging transport.

## Job definition and implementation

Every definition has a stable `name`, positive integer `version`, and factory. The factory result must expose the same name and version.

```ts
class ExampleJob extends BackgroundJob {
  readonly name = 'example';
  readonly version = 1;

  protected async run(context: JobContext): Promise<void> {
    for (let current = 1; current <= 10; current += 1) {
      context.cancellationToken.throwIfCancellationRequested();
      context.reportProgress({
        phase: 'processing',
        current,
        total: 10,
        message: `Processing ${current}`
      });
      context.metrics.addProcessedItems();
      context.heartbeatNow();
    }
  }
}

registry.register({
  name: 'example',
  version: 1,
  factory: () => new ExampleJob()
});
```

`JobManager.start(name, input)` may pass request-scoped dependencies to a registered factory. The core engine treats this input as opaque; a feature adapter validates it and keeps business services outside the manager.

## Supplier Sleep adapter

`src/jobs/SupplierSleepJob.ts` is the first execution adapter. It delegates unchanged calculations and writes to `src/lib/purchase-sleep.js`. Optional `jobControl` callbacks provide progress, heartbeat and cooperative cancellation checks at safe boundaries. The two existing background endpoints retain their request and response contracts while replacing their local boolean lock and `setImmediate` execution with `JobManager.start()`.

The CommonJS server loads compiled engine JavaScript from the narrowly tracked `dist/core/jobs` and `dist/jobs` directories. `npm run build` regenerates those runtime artifacts without requiring a TypeScript runtime dependency in production.

Jobs receive only `JobContext`; they do not access manager state or locking internals.

## Lifecycle and hooks

Normal execution follows:

1. Create execution in `Pending`.
2. Run optional `beforeStart`.
3. Transition to `Running`.
4. Run optional `afterStart` and emit `job.started`.
5. Execute `run(context)` and emit `job.progress` for reported progress.
6. Run optional `beforeComplete`.
7. Transition to `Completed`.
8. Run optional `afterComplete` and emit `job.completed`.
9. Finalize metrics, release the lock and retain the latest in-memory snapshot.

Cancellation is cooperative. A request runs `beforeCancel`, transitions to `Cancelling`, marks the token, and runs `afterCancel`. The job must inspect or throw from `cancellationToken`; acknowledgement transitions it to `Cancelled` and emits `job.cancelled`. A job that ignores the request may finish as `Completed`.

Unexpected execution errors transition to `Failed`, run optional `onError`, and emit `job.failed`. Hook failures are logged and isolated; they never change the job result or crash the engine.

## Status transitions

| From | Allowed next states |
| --- | --- |
| `Pending` | `Running`, `Cancelling`, `Failed`, `Cancelled` |
| `Running` | `Cancelling`, `Completed`, `Failed`, `Cancelled` |
| `Cancelling` | `Completed`, `Cancelled`, `Failed` |
| `Completed` | None |
| `Failed` | None |
| `Cancelled` | None |

An illegal transition raises `JobEngineError` with `JOB_INTERNAL`.

## Error codes

- `JOB_LOCKED`: another execution of the same job name owns the lock.
- `JOB_CANCELLED`: cooperative cancellation was acknowledged.
- `JOB_TIMEOUT`: reserved for generic timeout policies added by a future job or engine adapter.
- `JOB_FAILED`: unclassified execution failure.
- `JOB_INTERNAL`: invalid definitions, transitions, or other engine invariant failures.

`JobEngineError` exposes `code`, `message`, and optional `cause`.

## Event flow

Every valid transition emits `job.statusChanged`. Terminal events contain an execution snapshot with final telemetry.

- `job.started`
- `job.progress`
- `job.completed`
- `job.failed`
- `job.cancelled`
- `job.statusChanged`

Listeners are synchronous and process-local. Listener exceptions are isolated and cannot fail a job. `on()` returns an unsubscribe function; consumers should call it when their lifecycle ends.

## Operational boundaries

The registry, locks, events and latest snapshots exist only in memory. This foundation deliberately provides no retries, timeout enforcement, scheduling, persistence or distributed locking. Those policies must be introduced explicitly without placing business logic inside the engine.
