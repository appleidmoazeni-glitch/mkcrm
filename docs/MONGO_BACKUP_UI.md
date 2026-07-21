# MongoDB Backup Management

Admin-only APIs expose configuration/status, allowed destinations and job start. Authorization is enforced with `requireRole(...,['admin'])`; menu hiding is secondary. `MONGO_URI` is never returned or logged.

`MONGO_BACKUP_ALLOWED_ROOTS` is a comma-separated allowlist (or `MONGO_BACKUP_ROOT` for one root). The client submits a destination ID and optional safe relative subfolder. Absolute paths, `..`, UNC-style input, NUL and non-whitelisted characters are rejected; the resolved child must remain beneath its configured root.

`MongoBackupJob` version 1 uses the existing in-memory Job Engine lock. The service invokes `MONGODUMP_BINARY` (default `mongodump`) with `spawn`, `shell:false`, and an argument array. The database name is derived from the active `MONGO_URI`. Output is timestamped and non-overwriting. Status metadata is held in memory and terminal metadata is appended to existing `appLogs`; secrets and command arguments are excluded.

Missing configuration, missing `mongodump`, invalid destinations and concurrent starts produce explicit errors. Restore and distributed/resumable backup are out of scope. Rollback: remove the job/service/routes/menu and rebuild `dist`; generated backup folders remain untouched.
