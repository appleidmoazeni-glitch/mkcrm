# MKCRM 0.9.19.52 - Inventory Reconciliation Sync

این نسخه بر پایه 0.9.19.51 ساخته شده و فقط مسیر موجودی، سرچ کالا، Auto Sync و live repair را اصلاح می‌کند. Sale Snapshot، Supplier Sleep و منطق فاکتور فروش اصلی تغییر داده نشده‌اند، جز اعتبارسنجی موجودی موجود از نسخه ۵۱.

## مسئله عملیاتی

در تست واقعی مشخص شد نه Global GetRemain همیشه کامل است و نه GetRemain با فیلتر انبار. نمونه قطعی: کالای `83626M100D` در Swagger برای انبار 11 موجود بود، اما Global/Auto Sync می‌توانست ردیف را از CRM حذف یا ناموجود کند. بنابراین یک منبع واحد نباید authority حذف موجودی باشد.

## طراحی جدید

Auto Sync تبدیل شد به reconciliation دو مرحله‌ای:

1. خواندن Global GetRemain بدون فیلتر انبار.
2. خواندن GetRemain برای همه انبارهای فعال.
3. upsert هر ردیف مثبت از هر منبع.
4. عدم حذف/صفر کردن ردیف‌هایی که در یک منبع دیده نشده‌اند.
5. علامت‌گذاری ردیف‌های مشکوک با `missingInGlobalSync`, `missingInStockSync`, `needsLiveVerify`, `protectedFromAutoSyncStale`.

## قانون اصلی

اگر هر منبع معتبر موجودی مثبت بدهد، CRM آن موجودی را حفظ می‌کند. اگر یک منبع کالا را ندید، به‌تنهایی اجازه حذف ندارد. حذف/صفر کردن باید فقط با تایید مستقیم همان کالا یا فرآیند live verify انجام شود.

## اصلاحات اصلی

- `syncInventoryGlobal` دیگر `deleteMany` انجام نمی‌دهد.
- `syncInventoryStock` دیگر `deleteMany` برای stock انجام نمی‌دهد.
- تابع جدید `syncInventoryReconciliation` اضافه شد.
- Auto Sync حالا Global + Active Stocks را پشت سر هم اجرا می‌کند.
- سرچ متنی مثل `m100a` قبل از فیلتر انبار، candidate itemCode پیدا و live refresh هدفمند می‌زند.
- `itemInventoryCatalog` فیلدهای کیفیت و تشخیص جدید می‌گیرد: `lastGlobalSeenAt`, `lastStockSeenAt`, `lastLiveVerifiedAt`, `sourceEvidence`, `missingInGlobalCount`, `missingInStockCount`, `needsLiveVerify`, `protectedFromAutoSyncStale`.
- interval پیش‌فرض Auto Sync از ۳۰۰۰۰۰ به ۶۰۰۰۰۰ میلی‌ثانیه تغییر کرد.

## تست پیشنهادی بعد از نصب

1. Auto Sync را دستی اجرا کن.
2. کالای `83626M100D` را با سرچ `m100a` و فیلتر انبار 11 تست کن.
3. بعد از Auto Sync دوباره همان کالا را تست کن. انبار 11 نباید حذف شود.
4. خروجی `/api/inventory/auto-sync/status` را ببین؛ باید mode شامل `inventory-reconciliation` باشد.
5. خروجی `/api/inventory/debug-item?itemCode=83626M100D` را برای بررسی source و وضعیت rows بگیر.

