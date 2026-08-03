# Seller Financial Performance Read Model

Phase C materializes a rebuildable reporting projection from frozen and approved accounting sources. It does not calculate FIFO, call Shaygan, approve governance records, post saved profit, or make commission payable.

## Owned collections

- `sellerFinancialPerformanceRuns`: candidate/history metadata, source fingerprints, checkpoints, validation and activation state.
- `sellerFinancialPerformanceLines`: one immutable projection row per canonical sale line and run.
- `sellerFinancialPerformanceSummaries`: seller/month, seller/category/month, seller/rate-pool/month, seller/store/month, invoice and cost-status summaries.
- `sellerFinancialPerformanceState`: the single atomic active-run pointer.
- `sellerFinancialPerformanceLocks`: expiring single-builder lease.

Historical runs coexist. Only the completed run referenced by `sellerFinancialPerformanceState.activeRunId` is authoritative for the report. A failed candidate is never activated. A failed run can resume only while its source fingerprint is unchanged.

## Availability rules

Missing approved Policy, Product Category mapping, Rate, discount allocation or complete FIFO cost is represented by `null`, an `unavailable` status and a machine-readable blocker. There is no implicit 14%/20% rate and no missing financial value becomes zero.

All IRR values retain fixed-scale exact strings. Decimal128 shadows exist only for indexed server-side filters. UI conversion to toman is presentation-only.

## Feature flag and roles

`SELLER_FINANCIAL_READ_MODEL_ENABLED=true` enables the new API/UI. It is false by default. Admin, Accounting, Manager and Purchase may read; only Admin and Accounting may start or resume a projection build. Seller roles are denied.

The existing `/api/sale-snapshot/seller-performance` endpoint remains unchanged for parallel reconciliation.

## Operational API

- `GET /api/accounting/seller-financial-performance/status`
- `GET /api/accounting/seller-financial-performance/runs`
- `GET /api/accounting/seller-financial-performance/summaries`
- `GET /api/accounting/seller-financial-performance/totals`
- `GET /api/accounting/seller-financial-performance/lines`
- `GET /api/accounting/seller-financial-performance/invoices`
- `GET /api/accounting/seller-financial-performance/invoices/:identity/lines`
- `GET /api/accounting/seller-financial-performance/lines/:identity/drilldown`
- `GET /api/accounting/seller-financial-performance/lines/:identity/fifo`
- `GET /api/accounting/seller-financial-performance/lines/:identity/governance`
- `GET /api/accounting/seller-financial-performance/filters`
- `GET /api/accounting/seller-financial-performance/freshness`
- `GET /api/accounting/seller-financial-performance/build-status`
- `POST /api/accounting/seller-financial-performance/rebuild`
- `POST /api/accounting/seller-financial-performance/resume`

Builds run through the persistent application job record and publish progress. An incremental request reuses the active run when the source fingerprint is unchanged; otherwise it deliberately performs a safe full candidate rebuild because policy, mappings, discounts and adjustments can change historical lines.

## Rollback

Set the feature flag to false and reload only the application process. The legacy endpoint remains available, source datasets are untouched, and projection collections can remain for audit/history. No destructive rollback is required.
