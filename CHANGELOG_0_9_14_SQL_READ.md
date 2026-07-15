# CHANGELOG 0.9.14.0

## Added
- `src/lib/shaygan-sql-read.js`
- SQL read-only service using `mssql`
- `/api/shaygan/sql-health`
- SQL-based sale inventory search
- SQL-based stocks search
- SQL-based item search
- SQL-based item inventory verification
- SQL-based kardex
- SQL-based account search
- SQL-based account turnover

## Changed
- `src/server.js` now attempts SQL read first and falls back to WebService/cache if SQL fails or is disabled.
- `src/lib/config.js` now supports SHAYGAN_SQL_* env values.
- `public/assets/app.js` labels changed from snapshot wording to SQL inventory wording.
- `package.json` dependency added: `mssql`.

## Preserved
- Sale invoice write path remains WebService.
- Purchase invoice write path remains WebService.
- User roles and permissions preserved.
- Proforma and sale issue locking preserved.
- Existing WebService fallback preserved.

## Do not do
- Do not write directly to Shaygan SQL.
- Do not deploy with `sa` long-term; create SQL read-only user.
