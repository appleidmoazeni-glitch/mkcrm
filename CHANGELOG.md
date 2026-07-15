

## 0.9.19.49 - CORE_STABILITY_REFACTOR_PHASE_1

- Added server time helper (`src/lib/time.js`).
- Added `/api/server-time`; `/api/version` and `/health` now include serverTime.
- Board events now store/display Tehran time from server (`createdAtTehran`, `createdAtDisplay`).
- Supplier sleep jobs now include heartbeat updates and stale-running diagnostics.
- Global GetRemain inventory sync now blocks stale delete if the new completed total is under 70% of the previous completed total.
- Preserved v48 supplier sleep stability, global inventory sync, active warehouse filtering, fast sale, Sale Snapshot, and Seller Performance diagnostics.

## 0.9.19.24 - Fast Sale Issue on 0.9.19.23
- Fast sale issue: Invoice/Put with InvNo=0, resolve real InvNo from GuId/date-search.
- Removed getLastInvoiceNumber/getInvoice existence-check path from sale issue.
- Moved customer/lead/board/inventory post-processing to background after successful issue response.
- Added invoice timing fields in invoiceAuditLogs.


## 0.9.15.6 - Supplier Ledger Cleaner & Check Pressure Fix
- Supplier aging ledger summary now separates opening balances from period payments.
- Neutralized/cancelled checks are detected conservatively and excluded from real payment.
- Adjustments such as price differences, rebate, discount, shipping, fees and corrections are separated from actual payment.
- Supplier aging report shows payment_real, valid_checks, canceled_checks, adjustments, opening balance and ledger confidence.
- Financial pressure report is safer for accounts with opening transfers and cancelled checks.

## 0.9.13.1-cardex-modal-stock-selector-full
- Base: mkcrm_0_9_13_fast_search_unified_inventory_cardex_full.zip
- Added stock selector inside the inventory cardex popup.
- Default selection remains the clicked inventory row stock.
- User can switch to all stocks or any stock without changing kardex paging/normalization logic.
- No change to Shaygan kardex fetch logic or inventory live-verification logic.

# 0.9.8-sale-issue-idempotency-lock

- Base: 0.9.7-sales-readiness-print-discount
- Fix: جلوگیری از ثبت تکراری فاکتور فروش در اثر چندبار کلیک روی دکمه صدور.
- Frontend: دکمه صدور و رزرو هنگام عملیات disable می‌شود و پیام «در حال صدور» نمایش داده می‌شود.
- Backend: saleIssueLocks با کلید idempotency اضافه شد؛ درخواست تکراری در حالت issuing رد می‌شود و درخواست تکراری بعد از issued دوباره به شایگان ارسال نمی‌شود.
- Frozen: گردش حساب، خرید، پیش‌فاکتور، کاردکس، موجودی، بانک مشتریان.
- Network: PUBLIC_BASE_URL=http://172.31.31.217:1385 حفظ شد.

## 0.9.9-sales-ui-state-jalali-pricewords
- Kardex dates in UI converted to Jalali display.
- Added session-level page draft preservation when moving between CRM pages, especially sale/proforma/purchase forms.
- Added live Rial amount-to-words display for sale invoice unit price and line total.
- Kept frozen modules unchanged: turnover identity logic, purchase issue, sale idempotency, proforma conversion, print routes.


## 0.9.10-inventory-inline-cardex-modal
- Preserve inventory search behavior: Enter/search still shows all matching stock rows.
- Inventory row Kardex now opens in an inline modal instead of navigating away.
- Cardex page remains product-selection based, not inventory-wide search.
- Freeze preserved: sales issue lock, purchase issue, turnover, customer bank.

## 0.9.11-cardex-paging-safe-full
- Base: 0.9.10-inventory-inline-cardex-modal.
- Fixed Kardex paging for Shaygan GetKardex: WebService requires RowCount=1, so CRM now reads RowStart=0..N instead of assuming page 0 is complete.
- Seller Kardex is capped for speed: default 20 pages/rows.
- Admin quick Kardex default cap: 50 pages/rows; hard cap: 100 pages/rows.
- Kardex result now returns meta: fetchedPages, maxRows, reachedLimit, movementCount, stockNumber.
- Inventory inline Kardex modal now passes stockNumber from the selected inventory row.
- Non-movement Kardex balance rows without date/invoice/in/out quantity are excluded from display/analytics rows.
- Preserved 0.9.10 behavior: inventory search context remains on page; cardex opens inline modal; previous sale/purchase/proforma locks and UI features are not removed.


## 0.9.12-inventory-live-source-cardex-unified
- موجودی قابل فروش در سرچ فروشنده، منوی موجودی و صدور فاکتور از این نسخه live-authoritative از شایگان خوانده می‌شود و کش Mongo دیگر منبع موجودی قابل فروش نیست.
- اگر موجودی زنده صفر باشد، کالا در سرچ موجودی/فروش نمایش داده نمی‌شود و انتخاب برای فاکتور فروش ممنوع است.
- کاردکس از همه مسیرهای موجودی با stockNumber همان ردیف انبار باز می‌شود و از سرویس paging‌شده واحد استفاده می‌کند.
- در انتخاب ردیف فاکتور فروش، موجودی همان کالا/انبار مجدداً لحظه‌ای کنترل می‌شود تا فروشنده با داده قدیمی فاکتور نزند.


## 0.9.13-fast-search-unified-inventory-cardex
- اصلاح مسیر کاردکس در تمام جدول‌های موجودی: دکمه کاردکس دیگر نباید صفحه را به #cardex ببرد؛ باید modal واحد با سرویس paging شده را باز کند.
- اصلاح کندی سرچ کالا: سرچ‌های تایپی در موجودی انبار و فاکتور فروش دیگر live inventory scan انجام نمی‌دهند؛ ابتدا از کاتالوگ سریع کالا جستجو می‌کنند و فقط بعد از انتخاب کالا موجودی لحظه‌ای همان کالا از شایگان کنترل می‌شود.
- حفظ کنترل مهم فروش: انتخاب انبار/افزودن کالا به فاکتور همچنان با موجودی live شایگان verify می‌شود.
- کاهش ریسک داده ناسازگار: کاردکس همه مسیرهای موجودی به openInventoryCardexModal و renderKardex واحد وصل شد.

## 0.9.13.3 - Fast Sale Inventory Snapshot
- فاکتور فروش دیگر هنگام تایپ یا بررسی لیست، موجودی زنده شایگان را برای چندین کالا صدا نمی‌زند.
- سرچ فاکتور فروش فقط از `itemInventoryCatalog` داخلی و فقط ردیف‌های `quantity > 0` می‌خواند.
- بعد از انتخاب یک کالا/انبار مشخص، فقط همان مورد یک‌بار با شایگان live verify می‌شود.
- `syncCatalog` حالا snapshot مثبت موجودی را batch-based به‌روزرسانی می‌کند و در sync کامل، ردیف‌های قدیمی که دیگر در شایگان برنگشته‌اند حذف می‌شوند.
- endpoint جدید: `/api/sale/inventory-snapshot-search`.
- تنظیم جدید: `SALE_INVENTORY_SNAPSHOT_MAX_AGE_MINUTES`.

## 0.9.13.4 - snapshot search route + stocks positive snapshot
- Fixed missing `/api/sale/inventory-snapshot-search` route that caused `API not found` in sale search.
- Stocks menu now searches only positive-stock rows from local inventory snapshot; no live bulk check button/workflow.
- Sale search remains fast: snapshot search only, live Shaygan check only after choosing a specific item/stock.

## 0.9.14.1 - SQL fiscal database selector
- Added automatic fiscal database discovery from SQL Server master (`CY%` databases).
- SQL read layer now defaults to latest CY database instead of hard-coded CY000001.
- Added admin-only fiscal database selector in Settings.
- Added persisted settings: `shayganSqlFiscalMode`, `shayganSqlFiscalDatabase`.
- SQL health now reports active database, latest database, item count, positive stock row count, latest invoice date and latest accounting doc date.
- Existing WebService write paths are unchanged.


## 0.9.15.3 - Admin password reset for locked users
- کاربران دارای سابقه فاکتور همچنان از نظر هویت/نام کاربری/گروه قفل هستند.
- تغییر رمز عبور توسط ادمین برای همه کاربران، حتی کاربران قفل‌شده، همیشه مجاز شد.
- فعال/غیرفعال کردن کاربران قفل‌شده همچنان مجاز است.

## 0.9.15.5 - Supplier Aging Financial Pressure
- Separate physical inventory aging from supplier financial pressure.
- Add supplier payment method, check due days, goods delay days and settlement basis.
- Matrix default terms: check, 10-day due, 2-day goods delay, purchase commitment basis.
- Report now displays raw payment term, goods delay, financial grace after inventory arrival, approximate financial due date and financial overdue days.


## 0.9.15.9 - Seller Warehouse Stock View Access
- Explicitly allowed seller and seller_buyer roles to use `/api/inventory/by-stock`.
- Kept selected-warehouse full positive inventory view available for stocktaking/control.
- No change to sales invoice, SQL fiscal selector, supplier aging, or user mapping logic.


## 0.9.18.1
- نمایش فاکتور از گردش حساب برای تمام فاکتورهای فروش موجود در شایگان، نه فقط فاکتورهای صادرشده از MKCRM.
- حفظ محدودیت read-only برای فروشنده و لاگ مدیریتی برای ادمین/حسابداری.


## 0.9.19.45 - Supplier Sleep Stability / Safe Allocation
- Added background job endpoint for selected supplier sleep analysis: `/api/supplier-sleep/build-selected-job`.
- UI selected supplier build now uses background job polling through `/api/jobs/status`.
- Prevented concurrent supplier sleep jobs to reduce pressure on Shaygan WebService.
- Changed selected supplier global allocation from full profit scan to bounded current-stock coverage scan because supplier profit is still paused.
- Added detail hydration for header-only purchase invoices via `getInvoice(no, 3)`.
- Added coverage diagnostics and explicit unknown/opening/scan-limit inventory values instead of hiding unallocated current stock.
- Preserved Sale Snapshot Type 2, Seller Performance, Fast Sale, GeneralRef, invoice extras, and no-SQL path.

## 0.9.19.47 - SUPPLIER_SLEEP_UNIFIED_STABLE_UI
- Fixed supplier sleep UI regression after detached background jobs.
- Added distinct rendering for supplierSleepInvoiceSummary instead of reusing valid purchase invoice reconciliation table.
- Added layer fallback for selected supplier snapshots when supplierAccountNo filtering mismatches stored layer supplier code.
- Preserved 0.9.19.46 background job behavior and 0.9.19.45 allocation stability.

## 0.9.19.51 - Unified Inventory Core Refactor

- Refactored live item inventory refresh to safe authoritative mode.
- Removed blind destructive item cache delete from live refresh.
- Exact itemCode search now ensures live item refresh before reading snapshot.
- Operational by-stock inventory view now uses Mongo global snapshot, not stock-filtered WebService scan.
- Added server-side sale inventory validation before Shaygan PutInvoice.
- Added proforma conversion inventory validation and preserved warehouse fields on proforma edit.
- Added Kardex UI/backend safeguards and item context ensure before Kardex.
- Added `/api/inventory/debug-item` diagnostic endpoint.
- Added Tehran display fields to inventory auto-sync status.

## 0.9.19.52 - Inventory Reconciliation Sync

- Auto Sync موجودی از حالت تک‌منبعی/authoritative خارج شد و به مدل reconciliation تبدیل شد.
- هر sync کامل شامل دو منبع است: Global GetRemain و سپس GetRemain انبارهای فعال.
- قانون جدید: هر موجودی مثبت از هر منبع معتبر حفظ و upsert می‌شود؛ نبودن کالا در یک منبع به‌تنهایی باعث حذف/صفر شدن موجودی نمی‌شود.
- حذف stale در Global و Stock Sync حذف شد؛ ردیف‌های دیده‌نشده فقط با missingInGlobalSync / missingInStockSync و needsLiveVerify علامت‌گذاری می‌شوند.
- آمار diagnostic شامل protectedFromStale، queuedForLiveVerify، recoveredByStockSync، globalRows و stockRows اضافه شد.
- سرچ متنی/مدلی مانند m100a قبل از اعمال فیلتر انبار، candidate itemCodeها را پیدا و live refresh هدفمند اجرا می‌کند.
- فیلتر انبار بعد از refresh هدفمند اعمال می‌شود تا snapshot ناقص باعث مخفی شدن موجودی واقعی نشود.
- فاصله Auto Sync پیش‌فرض از ۵ دقیقه به ۱۰ دقیقه افزایش یافت.
- Sale Snapshot و Supplier Sleep در این نسخه تغییر داده نشدند.

## 0.9.19.53 - Active Stock Sync + Sale Deduct + Board Fix

- Auto Sync عملیاتی از Global+Active به Active Warehouses only برگشت.
- Global GetRemain از Auto Sync حذف شد تا duplicate و merge ناپایدار ایجاد نکند.
- بعد از صدور موفق فاکتور فروش، موجودی local CRM برای itemCode+stockNumber همان فاکتور کم می‌شود.
- تابلو اتمام کالا از snapshot محلی بعد از local deduct تصمیم می‌گیرد، نه live refresh بعد از فروش.
- Auto Sync تا مدت محافظت، ردیف صفرشده توسط local sale deduct را با پاسخ stale مثبت نمی‌کند.
- dedupe نمایش موجودی و گروه‌بندی فروش برای stockNumber+itemCode/itemCode مقاوم‌تر شد.


## 0.9.19.54 - Proforma Convert Local Deduct + Board Stock-out Fix

- Preserved fast sale invoice flow (`InvNo=0` / Shaygan auto-number) and background sale post-processing.
- Fixed proforma conversion path so successful conversion to sale invoice immediately deducts local inventory for `itemCode + stockNumber`.
- Stock-out board logic for proforma conversion now runs after local inventory deduction, so last remaining item sales are announced correctly.
- Added `proforma_convert_local_inventory_deduct` app log and returns `localInventoryDeduct` in conversion response for diagnostics.
- No changes to Sale Snapshot or Supplier Sleep.


## 0.9.19.55 - Sale Board Stockout Immediate Fix
- Fix stock_out board event creation immediately after local sale deduct.
- Add sale_issue_post_board_stock_out diagnostic logs.
- Use localInventoryDeduct.lines as authoritative post-sale stock-out candidates.

## 0.9.19.56 - Board v49 Live Reconcile Fix
- Restored the proven version 49 targeted live inventory refresh for stock-out board decisions.
- Preserved immediate local inventory deduction introduced in later versions.
- Reconciles the live response with sale-confirmed `afterQty` for the sold warehouse.
- Prevents a delayed Shaygan positive response from reviving the just-sold last unit.
- Re-applies sale-confirmed local quantity after the live verification refresh.
- Keeps board decision logs in `sale_issue_post_board_stock_out` with live refresh and reconciliation details.

## 0.9.19.57
- Fixed MongoDB update-path conflict in createBoardEventOnce.
- Restored event creation for both stock_out and stock_in.
- Preserved v56 inventory and board reconcile logic.


## 0.9.19.59
- Supplier sleep job auto-poll and UI refresh.
- Mongo-backed active job guard and stale recovery.
- Snapshot edit/archive/delete with cascade cleanup and audit log.
- Restore selected supplier/job state after navigation.
- Prevent build before purchase-read completion.
- Ignore archived/invalid snapshots as default latest report.
