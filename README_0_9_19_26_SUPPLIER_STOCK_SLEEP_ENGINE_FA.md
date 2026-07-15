# MKCRM 0.9.19.26 - Supplier Stock Sleep Engine

## Base
Built on:
`mkcrm_0_9_19_25_FAST_SALE_CLEAN_OUTPUT_FULL`

## Scope
This version adds the first executable backend for supplier stock sleep / inventory origin analysis.

It does **not** change:
- Sale Engine
- Fast sale `InvNo=0`
- Lead / Lead Chain
- Commission logic
- Unified inventory/sale search
- Live repair search
- Tablo
- GeneralRef / invoice audit behavior
- Active warehouse governance

## Architecture
Correct path:

```text
Active Inventory Snapshot
→ stockSleepQueue
→ single item GetKardex background processing
→ Reverse FIFO origin layers
→ supplier summary aggregation
→ Mongo snapshot reporting
```

Forbidden paths remain forbidden:

```text
SQL direct read
Realtime massive Kardex
Grouped GetKardex
Report-time heavy calculation
Invoice number reservation
Changing sale issue flow
```

## New Mongo Collections

- `stockSleepSnapshots`
- `stockSleepQueue`
- `stockSleepItemLayers`
- `stockSleepSupplierSummary`
- `stockSleepHistory`

## New API Endpoints

### Initialize indexes
`POST /api/stock-sleep/init`

Admin only.

### Start snapshot
`POST /api/stock-sleep/start`

Body example:

```json
{
  "fiscalYearStart": "14050101",
  "kardexMaxRows": 80,
  "maxItems": 0,
  "kickoffLimit": 3
}
```

Notes:
- `maxItems=0` means all positive inventory rows from active warehouses.
- Uses active warehouse settings from `inventory.activeWarehouseNumbers`.
- Creates queue and starts only a small kickoff batch.

### Process queue batch
`POST /api/stock-sleep/process`

Body example:

```json
{
  "snapshotId": "SS-...",
  "limit": 5
}
```

This is intentionally controlled. Do not run very high limits until WebService behavior is observed.

### Status
`GET /api/stock-sleep/status?snapshotId=SS-...`

If `snapshotId` is omitted, returns latest snapshot.

### List snapshots
`GET /api/stock-sleep/snapshots?limit=20`

### Supplier summary
`GET /api/stock-sleep/suppliers?snapshotId=SS-...&limit=200`

### Item origin layers
`GET /api/stock-sleep/layers?snapshotId=SS-...&supplierAccountNo=...&itemCode=...&warehouseNo=...&limit=500`

## Origin Logic

For each item/warehouse inventory row:

1. Current active inventory is read from `itemInventoryCatalog`.
2. Kardex is fetched per single item and warehouse.
3. Current-year incoming movements are treated as current-year purchase origins.
4. Reverse FIFO allocation links current stock to most recent purchases first.
5. Any unallocated quantity becomes:

```text
originType = OPENING_BALANCE
supplierName = منشأ مانده از قبل
```

## Layer ID
Each origin layer gets a stable `layerId` so future reports can attach to the same layer model.

## Known Controlled Limitation
FIFO profit is structurally prepared but remains `not_calculated` in this version unless later sale-layer matching is added. This is intentional: the system must not manufacture fake profit numbers from incomplete Kardex interpretation.

## Deployment

1. Backup current folder.
2. Replace files with this version.
3. Run:

```bat
npm install
pm start
```

or PM2 restart according to current production setup.

4. Login as admin.
5. Run init endpoint once.
6. Run a small snapshot first:

```json
{ "maxItems": 10, "kardexMaxRows": 50, "kickoffLimit": 2 }
```

7. Check status and supplier summary.
8. Increase batch size only after observing WebService stability.
